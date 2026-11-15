"""Job-Verwaltung mit genau einem Worker-Thread.

Die Warteschlange ist absichtlich seriell: ``htdemucs`` belegt mehrere GB VRAM,
zwei gleichzeitige Trennungen wuerden auf einer 8-GB-Karte zuverlaessig an
'CUDA out of memory' scheitern.
"""
from __future__ import annotations

import json
import logging
import queue
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .config import settings

log = logging.getLogger(__name__)

STEM_FILES_SUBDIR = "stems"
INPUT_SUBDIR = "input"
JOB_FILE = "job.json"


@dataclass
class Stem:
    name: str
    slug: str
    path: Path

    def size(self) -> int:
        try:
            return self.path.stat().st_size
        except OSError:
            return 0


@dataclass
class Job:
    id: str
    source_name: str
    model: str
    model_label: str
    input_path: Path
    job_dir: Path
    status: str = "queued"
    stage: str | None = "Wartet in der Warteschlange"
    error: str | None = None
    is_test_path: bool = False
    device: str | None = None
    duration_seconds: float | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    stems: list[Stem] = field(default_factory=list)

    @property
    def stems_dir(self) -> Path:
        return self.job_dir / STEM_FILES_SUBDIR

    def to_state(self) -> dict:
        """Vollstaendiger Zustand fuer job.json, inklusive Pfaden.

        Die API-Sicht (``to_dict``) nennt keine Pfade. Zum Wiedereinlesen
        nach einem Neustart werden sie aber gebraucht.
        """
        state = self.to_dict()
        state["input_path"] = str(self.input_path)
        state["stem_paths"] = {s.slug: str(s.path) for s in self.stems}
        return state

    @classmethod
    def from_state(cls, state: dict, job_dir: Path) -> "Job":
        stem_paths = state.get("stem_paths") or {}
        job = cls(
            id=state["id"],
            source_name=state.get("source_name", "unbekannt"),
            model=state.get("model", "unbekannt"),
            model_label=state.get("model_label", state.get("model", "unbekannt")),
            input_path=Path(state.get("input_path") or (job_dir / INPUT_SUBDIR)),
            job_dir=job_dir,
            status=state.get("status", "failed"),
            stage=state.get("stage"),
            error=state.get("error"),
            is_test_path=bool(state.get("is_test_path")),
            device=state.get("device"),
            duration_seconds=state.get("duration_seconds"),
            created_at=state.get("created_at", 0.0),
            started_at=state.get("started_at"),
            finished_at=state.get("finished_at"),
        )
        job.stems = []
        for entry in state.get("stems", []):
            slug = entry.get("slug")
            if not slug:
                continue
            path = _resolve_stem(job.job_dir, slug, stem_paths.get(slug))
            if path is not None:
                job.stems.append(Stem(name=entry.get("name", slug), slug=slug, path=path))
        # Ein Job, der beim Beenden noch lief, kann nicht fortgesetzt werden.
        if job.status in {"queued", "processing"}:
            job.status = "failed"
            job.stage = None
            job.error = (
                "Die API wurde waehrend der Verarbeitung beendet. "
                "Bitte erneut trennen."
            )
        return job

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source_name": self.source_name,
            "model": self.model,
            "model_label": self.model_label,
            "status": self.status,
            "progress": None,
            "stage": self.stage,
            "error": self.error,
            "is_test_path": self.is_test_path,
            "device": self.device,
            "duration_seconds": self.duration_seconds,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "stems": [
                {
                    "name": s.name,
                    "slug": s.slug,
                    "url": f"/api/jobs/{self.id}/stems/{s.slug}",
                    "download_url": f"/api/jobs/{self.id}/stems/{s.slug}?download=1",
                    "bytes": s.size(),
                }
                for s in self.stems
            ],
        }


# Signatur des eigentlichen Trenners: (job, Statusmeldung-Callback) -> Spurliste
SeparateFn = Callable[[Job, Callable[[str], None]], list[Stem]]


class JobStore:
    """Thread-sicherer Speicher plus serieller Worker."""

    def __init__(self, separate_fn: SeparateFn) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._queue: queue.Queue[str] = queue.Queue()
        self._separate_fn = separate_fn
        self._worker = threading.Thread(target=self._run, name="mixapart-worker", daemon=True)
        self._processing: str | None = None
        self._restore()
        self._worker.start()

    def _restore(self) -> None:
        """Liest vorhandene Jobs aus data/jobs/*/job.json wieder ein.

        Ohne das waeren die Ordner nach einem Neustart verwaist: die
        Oberflaeche zeigte sie nicht mehr an, und loeschen liess sich ihr
        Platz auf der Platte nur noch von Hand.
        """
        for folder in sorted(settings.jobs_dir.glob("*")):
            state_file = folder / JOB_FILE
            if not state_file.is_file():
                continue
            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
                job = Job.from_state(state, folder)
            except Exception as exc:  # noqa: BLE001 - ein kaputter Job kippt nicht den Start
                log.warning("Job in %s nicht lesbar: %s", folder, exc)
                continue
            self._jobs[job.id] = job
        if self._jobs:
            log.info("%d vorhandene Jobs eingelesen", len(self._jobs))

    # ---------------------------------------------------------------- lesen
    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def counts(self) -> tuple[int, int]:
        with self._lock:
            queued = sum(1 for j in self._jobs.values() if j.status == "queued")
            processing = sum(1 for j in self._jobs.values() if j.status == "processing")
        return queued, processing

    # -------------------------------------------------------------- anlegen
    def new_job_dir(self) -> tuple[str, Path]:
        job_id = uuid.uuid4().hex[:12]
        job_dir = settings.jobs_dir / job_id
        (job_dir / INPUT_SUBDIR).mkdir(parents=True, exist_ok=True)
        (job_dir / STEM_FILES_SUBDIR).mkdir(parents=True, exist_ok=True)
        return job_id, job_dir

    def enqueue(self, job: Job) -> Job:
        with self._lock:
            self._jobs[job.id] = job
        self._persist(job)
        self._queue.put(job.id)
        return job

    def add_finished(self, job: Job) -> Job:
        """Fuer den Testpfad: Job ist sofort fertig, kommt nicht in die Warteschlange."""
        with self._lock:
            self._jobs[job.id] = job
        self._persist(job)
        return job

    def delete(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job is None:
            return False
        shutil.rmtree(job.job_dir, ignore_errors=True)
        return True

    def delete_finished(self) -> tuple[list[str], int]:
        """Raeumt alles Abgeschlossene weg und meldet (geloescht, behalten).

        Was in der Warteschlange steht oder gerade getrennt wird, bleibt
        stehen: der Worker schreibt in genau dieses Verzeichnis, und ein
        ``rmtree`` darunter liesse ihn mitten im Lauf auf einen Pfad
        stossen, den es nicht mehr gibt. Wer einen laufenden Job loswerden
        will, loescht ihn einzeln.
        """
        with self._lock:
            doomed = [j for j in self._jobs.values() if j.status in ("done", "failed")]
            kept = len(self._jobs) - len(doomed)
            for job in doomed:
                del self._jobs[job.id]
        # Ausserhalb des Locks: Loeschen auf der Platte kann dauern, und
        # solange darf die API nicht stehen.
        for job in doomed:
            shutil.rmtree(job.job_dir, ignore_errors=True)
        return [job.id for job in doomed], kept

    # ---------------------------------------------------------------- worker
    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.get(job_id)
            if job is None:
                self._queue.task_done()
                continue
            self._process(job)
            self._queue.task_done()

    def _process(self, job: Job) -> None:
        def stage(text: str) -> None:
            with self._lock:
                job.stage = text
            self._persist(job)
            log.info("[%s] %s", job.id, text)

        with self._lock:
            job.status = "processing"
            job.started_at = time.time()
            self._processing = job.id
        stage("Wird vorbereitet")

        try:
            stems = self._separate_fn(job, stage)
            if not stems:
                raise RuntimeError("Die Trennung hat keine Spuren erzeugt.")
            with self._lock:
                job.stems = stems
                job.status = "done"
                job.stage = "Fertig"
                job.error = None
        except Exception as exc:  # noqa: BLE001 - Fehler landet sichtbar im Job
            log.exception("Job %s fehlgeschlagen", job.id)
            with self._lock:
                job.status = "failed"
                job.stage = None
                job.error = _friendly_error(exc)
        finally:
            with self._lock:
                job.finished_at = time.time()
                self._processing = None
            self._persist(job)

    # --------------------------------------------------------------- persist
    def _persist(self, job: Job) -> None:
        """Schreibt job.json, damit der Ordner fuer sich sprechend bleibt."""
        try:
            job.job_dir.mkdir(parents=True, exist_ok=True)
            tmp = job.job_dir / (JOB_FILE + ".tmp")
            tmp.write_text(json.dumps(job.to_state(), indent=2), encoding="utf-8")
            tmp.replace(job.job_dir / JOB_FILE)
        except OSError as exc:
            log.warning("job.json fuer %s nicht schreibbar: %s", job.id, exc)


_STEM_IN_NAME = re.compile(r"\(([^)]+)\)")


def _resolve_stem(job_dir: Path, slug: str, recorded: str | None) -> Path | None:
    """Findet die Datei einer Spur wieder.

    Bevorzugt den in job.json vermerkten Pfad. Aeltere Dateien aus der Zeit
    vor diesem Feld haben keinen; dann wird im Spurenordner gesucht, erst
    nach dem Spurnamen in Klammern wie "(Vocals)", dann nach "<slug>.wav".
    """
    if recorded:
        path = Path(recorded)
        if path.exists():
            return path
    folder = job_dir / STEM_FILES_SUBDIR
    direct = folder / f"{slug}.wav"
    if direct.exists():
        return direct
    candidates = sorted(folder.glob("*.wav"))
    for candidate in candidates:
        groups = [g.strip().lower() for g in _STEM_IN_NAME.findall(candidate.stem)]
        if slug in groups:
            return candidate
    # Jobs aus der Zeit vor der Pfadangabe konnten einen aus dem Dateinamen
    # abgeleiteten Namen bekommen. Denselben Weg nochmal gehen.
    for candidate in candidates:
        derived = re.sub(r"[^a-z0-9]+", "-", candidate.stem.lower()).strip("-")
        if derived == slug:
            return candidate
    return None


def _friendly_error(exc: BaseException) -> str:
    from .devices import is_out_of_memory

    if is_out_of_memory(exc):
        return (
            "Der GPU-Speicher war nicht ausreichend (CUDA out of memory). "
            "Schliesse andere Programme, die die GPU nutzen, und starte den Job neu. "
            "Alternativ das Backend mit MIXAPART_DEVICE=cpu starten."
        )
    text = str(exc).strip() or type(exc).__name__
    return f"{type(exc).__name__}: {text}"
