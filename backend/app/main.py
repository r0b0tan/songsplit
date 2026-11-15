"""Lokale API fuer MixApart.

Bindet absichtlich nur an 127.0.0.1 (siehe run.py / README): die Musik bleibt
auf dem Rechner, es gibt keine Authentifizierung und keinen Upload nach aussen.

Die Bindung allein traegt aber weniger, als sie aussieht: 127.0.0.1 ist von
**jeder** Webseite aus erreichbar, die im Browser des Nutzers laeuft. Zwei
Dinge folgen daraus, und dagegen steht ``LocalGuard`` weiter unten:

* Eine fremde Seite, deren Domain auf 127.0.0.1 zeigt (DNS-Rebinding), waere
  fuer den Browser gleicher Herkunft wie diese API. CORS greift dann nicht
  mehr, und die Seite koennte den Verlauf lesen und die Spuren herunterladen.
  Gegenprobe: ``curl -H "Host: evil.example.com" .../api/jobs``.
* Ein ``POST /api/jobs`` mit ``multipart/form-data`` ist ein "simple request"
  und braucht keinen Preflight. CORS haelt ihn nicht auf, die Antwort bleibt
  fuer die fremde Seite nur unlesbar — der Job entstuende trotzdem, mit
  fremder Datei auf der Platte und Last auf der GPU.
"""
from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# config zuerst: setzt ggf. CUDA_VISIBLE_DEVICES, bevor torch geladen wird.
from .config import settings
from .devices import probe_device
from .jobs import INPUT_SUBDIR, Job, JobStore, Stem
from .schemas import DeviceOut, HealthOut, JobOut, ModelOut
from .separation import (
    DEFAULT_MODEL,
    MODEL_PRESETS,
    SUPPORTED_INPUT_SUFFIXES,
    check_available,
    preset_missing_files,
    separate_job,
    stem_label,
)
from .synthetic import TEST_DURATION_S, make_test_stems

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mixapart")

app = FastAPI(
    title="MixApart",
    version="0.1.0",
    description="Lokale Stem-Trennung mit audio-separator. Nur fuer 127.0.0.1.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Unter welchen Namen diese API sich ansprechen laesst. run.py laesst nur
# diese drei als Bindeadresse zu, also gibt es auch keinen vierten gueltigen
# Host-Header. Alles andere ist eine fremde Domain, die auf 127.0.0.1 zeigt.
ALLOWED_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _hostname(raw: str) -> str:
    """Host-Header ohne Port. Beruecksichtigt die Klammerform von IPv6.

    ``starlette.middleware.TrustedHostMiddleware`` tut dasselbe, aber mit
    ``split(":")[0]`` — aus ``[::1]:8000`` wird dort ``[``, und der Vergleich
    kann nie passen. Deshalb steht es hier selbst.
    """
    host = raw.strip()
    if host.startswith("["):          # [::1]:8000
        return host[1:].partition("]")[0]
    return host.rsplit(":", 1)[0] if ":" in host else host


class LocalGuard:
    """Weist ab, was nicht von diesem Rechner und dieser Oberflaeche kommt.

    Zwei Pruefungen, beide billig und beide vor allem anderen:

    ``Host`` muss einer der lokalen Namen sein. Das nimmt dem DNS-Rebinding
    den Boden: die fremde Domain steht im Host-Header, und mit ihr faellt die
    Anfrage auf, bevor sie einen Handler erreicht.

    ``Origin`` muss, **wenn** er mitkommt, zu den erlaubten Herkuenften
    passen. Browser setzen ihn bei jedem herkunftsfremden POST, auch bei dem
    aus einem ``<form>``; damit faellt die CSRF-Luecke von oben zu. Ohne
    Origin bleibt es durchgelassen: curl, Skripte und die Tests schicken
    keinen, und die sollen weiter funktionieren.

    Reines ASGI, keine ``BaseHTTPMiddleware``: die fasst den Body an, und
    durch diese Schicht gehen 200-MB-Uploads.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.origins = frozenset(settings.cors_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k: v for k, v in scope.get("headers") or ()}
        host = _hostname(headers.get(b"host", b"").decode("latin-1"))
        if host not in ALLOWED_HOSTS:
            log.warning("Anfrage mit fremdem Host-Header abgewiesen: %r", host)
            await self._deny(
                400,
                f"Host {host!r} ist nicht erlaubt. Diese API antwortet nur auf "
                "127.0.0.1, localhost und ::1.",
                scope, receive, send,
            )
            return

        origin = headers.get(b"origin", b"").decode("latin-1")
        if origin and origin not in self.origins:
            log.warning("Anfrage mit fremder Herkunft abgewiesen: %r", origin)
            await self._deny(
                403,
                f"Herkunft {origin!r} ist nicht erlaubt.",
                scope, receive, send,
            )
            return

        await self.app(scope, receive, send)

    @staticmethod
    async def _deny(status: int, detail: str, scope: Scope, receive: Receive,
                    send: Send) -> None:
        await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)


# Nach CORS eingetragen heisst: laeuft davor. Eine abgewiesene Anfrage soll
# gar nicht erst bis zu den CORS-Kopfzeilen kommen.
app.add_middleware(LocalGuard)

store = JobStore(separate_fn=separate_job)


@app.on_event("startup")
def _log_startup() -> None:
    available, detail = check_available()
    device = probe_device()
    log.info("Datenordner: %s", settings.data_dir)
    log.info("Modellordner: %s", settings.model_dir)
    log.info("audio-separator: %s", detail if available else f"NICHT verfuegbar ({detail})")
    log.info("Geraet: angefordert=%s, genutzt=%s", device.requested, device.effective)
    for note in device.notes:
        log.warning("Hinweis: %s", note)


# ------------------------------------------------------------------ Metadaten
@app.get("/api/health", response_model=HealthOut)
def health() -> HealthOut:
    available, detail = check_available()
    queued, processing = store.counts()
    return HealthOut(
        ok=True,
        separator_available=available,
        separator_detail=detail,
        device=DeviceOut(**probe_device().to_dict()),
        queued=queued,
        processing=processing,
    )


@app.get("/api/models", response_model=list[ModelOut])
def models() -> list[ModelOut]:
    available, detail = check_available()
    out: list[ModelOut] = []
    for p in MODEL_PRESETS.values():
        missing = preset_missing_files(p) if available else []
        out.append(
            ModelOut(
                name=p.name,
                mode=p.mode,
                label=p.label,
                description=p.description,
                stems=[stem_label(p, s) for s in p.stems],
                is_default=p.is_default,
                available=available,
                detail=None if available else detail,
                downloaded=not missing,
                missing_files=missing,
            )
        )
    return out


# ----------------------------------------------------------------------- Jobs
@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs() -> list[JobOut]:
    return [JobOut(**j.to_dict()) for j in store.list()]


@app.get("/api/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: str) -> JobOut:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nicht gefunden")
    return JobOut(**job.to_dict())


@app.delete("/api/jobs")
def delete_finished_jobs() -> dict:
    """Alles Abgeschlossene auf einmal. Laufendes bleibt, siehe JobStore."""
    deleted, kept = store.delete_finished()
    log.info("%d Jobs geloescht, %d laufende behalten", len(deleted), kept)
    return {"deleted": deleted, "kept": kept}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    if not store.delete(job_id):
        raise HTTPException(status_code=404, detail="Job nicht gefunden")
    return {"deleted": job_id}


@app.post("/api/jobs", response_model=JobOut, status_code=202)
async def create_job(
    file: UploadFile = File(..., description="MP3 oder WAV"),
    model: str = Form(DEFAULT_MODEL),
) -> JobOut:
    preset = MODEL_PRESETS.get(model)
    if preset is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unbekanntes Modell {model!r}. Erlaubt: {', '.join(MODEL_PRESETS)}",
        )

    original = Path(file.filename or "upload")
    suffix = original.suffix.lower()
    if suffix not in SUPPORTED_INPUT_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"Nur {' und '.join(sorted(SUPPORTED_INPUT_SUFFIXES))} werden unterstuetzt, "
            f"nicht {suffix or 'ohne Endung'}.",
        )

    available, detail = check_available()
    if not available:
        raise HTTPException(
            status_code=503,
            detail=f"audio-separator ist nicht verfuegbar: {detail}. "
            "Nutze den Testpfad (POST /api/jobs/test-signals), um den Player zu pruefen.",
        )

    job_id, job_dir = store.new_job_dir()
    # Dateiname normalisieren: nur der Basisname, keine Pfadanteile aus dem Upload.
    safe_name = original.name.replace("\\", "_").replace("/", "_")
    input_path = job_dir / INPUT_SUBDIR / safe_name

    written = 0
    try:
        with input_path.open("wb") as fh:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Datei ist groesser als {settings.max_upload_bytes // 1024 // 1024} MB.",
                    )
                fh.write(chunk)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    finally:
        await file.close()

    if written == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Die Datei war leer.")

    job = Job(
        id=job_id,
        source_name=safe_name,
        model=preset.name,
        model_label=preset.label,
        input_path=input_path,
        job_dir=job_dir,
    )
    store.enqueue(job)
    log.info("Job %s angelegt: %s (%s, %.1f MB)", job_id, safe_name, preset.name, written / 1e6)
    return JobOut(**job.to_dict())


@app.post("/api/jobs/test-signals", response_model=JobOut, status_code=201)
def create_test_job() -> JobOut:
    """TESTPFAD. Trennt nichts.

    Legt drei synthetische WAVs an: zwei Klickspuren mit identischem Raster und
    einen 440-Hz-Dauerton. Damit laesst sich der Player pruefen, ohne dass ein
    Trennmodell vorhanden sein muss. Der Job ist ueber ``is_test_path`` als
    Testpfad markiert und wird in der Oberflaeche entsprechend gekennzeichnet.
    """
    job_id, job_dir = store.new_job_dir()
    job = Job(
        id=job_id,
        source_name="Testsignale (synthetisch)",
        model="test-signals",
        model_label="Testpfad: synthetische Spuren",
        input_path=job_dir / INPUT_SUBDIR / "keine-eingabe",
        job_dir=job_dir,
        status="done",
        stage="Fertig",
        is_test_path=True,
        device="keins",
        duration_seconds=TEST_DURATION_S,
        started_at=time.time(),
        finished_at=time.time(),
    )
    job.stems = [
        Stem(name=label, slug=path.stem, path=path)
        for label, path in make_test_stems(job.stems_dir)
    ]
    store.add_finished(job)
    log.info("Testpfad-Job %s angelegt (keine echte Separation)", job_id)
    return JobOut(**job.to_dict())


@app.get("/api/jobs/{job_id}/stems/{slug}")
def get_stem(job_id: str, slug: str, download: int = 0) -> FileResponse:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nicht gefunden")
    stem = next((s for s in job.stems if s.slug == slug), None)
    if stem is None or not stem.path.exists():
        raise HTTPException(status_code=404, detail="Spur nicht gefunden")

    # Pfad gegen den Job-Ordner pruefen, damit kein Ausbruch moeglich ist.
    try:
        stem.path.resolve().relative_to(job.job_dir.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Pfad liegt ausserhalb des Jobs") from None

    filename = f"{job.source_name.rsplit('.', 1)[0]} - {stem.name}.wav"
    return FileResponse(
        stem.path,
        media_type="audio/wav",
        filename=filename if download else None,
        content_disposition_type="attachment" if download else "inline",
    )
