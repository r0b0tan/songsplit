"""Prueft das grosse Aufraeumen: DELETE /api/jobs loescht nur Abgeschlossenes.

Laeuft ohne Zusatzpakete:

    python tests/test_cleanup.py

Hintergrund: der Worker schreibt waehrend einer Trennung minutenlang in
den Job-Ordner. Ein ``rmtree`` darunter liesse ihn auf Pfade stossen, die
es nicht mehr gibt — mitten im Lauf, mit einer Fehlermeldung, die nach
einem Programmfehler aussieht. Deshalb bleibt stehen, was laeuft oder
wartet, und das muss gelten, auch wenn jemand die Reihenfolge im Store
spaeter umbaut.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Muss vor dem ersten Import von app.config stehen: die Einstellungen
# werden beim Laden des Moduls eingefroren.
TEMP = tempfile.mkdtemp(prefix="mixapart-test-")
os.environ["MIXAPART_DATA_DIR"] = TEMP
os.environ["MIXAPART_DEVICE"] = "cpu"

from app.jobs import Job, JobStore  # noqa: E402

running = threading.Event()
held = threading.Event()


def never_finishes(job, stage):  # noqa: ANN001, ARG001 - Signatur des Workers
    """Haelt den Worker fest, damit ein Job wirklich 'processing' ist."""
    running.set()
    held.wait(timeout=30)
    return []


def make(store: JobStore, name: str, status: str) -> Job:
    job_id, job_dir = store.new_job_dir()
    return Job(
        id=job_id,
        source_name=name,
        model="htdemucs",
        model_label="htdemucs",
        input_path=job_dir / "input" / name,
        job_dir=job_dir,
        status=status,
    )


def main() -> int:
    store = JobStore(separate_fn=never_finishes)

    fertig = store.add_finished(make(store, "fertig.mp3", "done"))
    kaputt = store.add_finished(make(store, "kaputt.mp3", "failed"))
    laeuft = store.enqueue(make(store, "laeuft.mp3", "queued"))
    wartet = store.enqueue(make(store, "wartet.mp3", "queued"))

    if not running.wait(timeout=10):
        print("FEHL  der Worker hat den Job nicht aufgenommen")
        return 1
    # Kurz warten, bis der Status wirklich gesetzt ist.
    for _ in range(50):
        if store.get(laeuft.id) and store.get(laeuft.id).status == "processing":
            break
        time.sleep(0.05)

    deleted, kept = store.delete_finished()

    checks = [
        ("zwei abgeschlossene Jobs geloescht", sorted(deleted) == sorted([fertig.id, kaputt.id])),
        ("zwei unfertige Jobs behalten", kept == 2),
        ("laufender Job steht noch im Store", store.get(laeuft.id) is not None),
        ("wartender Job steht noch im Store", store.get(wartet.id) is not None),
        ("Ordner des fertigen Jobs ist weg", not fertig.job_dir.exists()),
        ("Ordner des fehlgeschlagenen Jobs ist weg", not kaputt.job_dir.exists()),
        ("Ordner des laufenden Jobs ist unberuehrt", laeuft.job_dir.exists()),
        ("zweiter Lauf loescht nichts mehr", store.delete_finished() == ([], 2)),
    ]

    # Der Worker haengt absichtlich weiter in `never_finishes`; er ist ein
    # Daemon-Thread und endet mit dem Prozess. Ihn hier freizugeben hiesse,
    # ihn den Job ohne Spuren abschliessen zu lassen — eine Fehlermeldung
    # im Protokoll, die mit dieser Pruefung nichts zu tun hat.
    shutil.rmtree(TEMP, ignore_errors=True)

    bad = 0
    for name, ok in checks:
        print(f"  [{'OK  ' if ok else 'FEHL'}] {name}")
        bad += 0 if ok else 1
    print(f"\n  {len(checks) - bad} von {len(checks)} Pruefungen bestanden.")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
