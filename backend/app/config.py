"""Zentrale Konfiguration. Alles ueber Umgebungsvariablen steuerbar."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser().resolve() if raw else default


@dataclass(frozen=True)
class Settings:
    # Alle Job-Ordner liegen unter data/jobs/<job-id>/
    data_dir: Path = _env_path("SONGSPLIT_DATA_DIR", PROJECT_DIR / "data")
    # Cache fuer die heruntergeladenen Trennmodelle
    model_dir: Path = _env_path("SONGSPLIT_MODEL_DIR", PROJECT_DIR / "models")
    # auto | cuda | cpu
    device: str = os.environ.get("SONGSPLIT_DEVICE", "auto").strip().lower()
    host: str = os.environ.get("SONGSPLIT_HOST", "127.0.0.1")
    port: int = int(os.environ.get("SONGSPLIT_PORT", "8000"))
    # Erlaubte Herkunft des Angular-Dev-Servers
    cors_origins: tuple[str, ...] = tuple(
        o.strip()
        for o in os.environ.get(
            "SONGSPLIT_CORS_ORIGINS",
            "http://127.0.0.1:4200,http://localhost:4200",
        ).split(",")
        if o.strip()
    )
    max_upload_bytes: int = int(os.environ.get("SONGSPLIT_MAX_UPLOAD_MB", "200")) * 1024 * 1024

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"


settings = Settings()

if settings.device not in {"auto", "cuda", "cpu"}:
    raise SystemExit(
        f"SONGSPLIT_DEVICE={settings.device!r} ist unbekannt. Erlaubt: auto, cuda, cpu."
    )

settings.jobs_dir.mkdir(parents=True, exist_ok=True)
settings.model_dir.mkdir(parents=True, exist_ok=True)

# audio-separator 0.48 hat keinen Geraete-Parameter: es nimmt die GPU, sobald
# torch.cuda.is_available() wahr ist. Der CPU-Modus muss daher die GPU
# ausblenden, und zwar bevor torch importiert wird. Dieses Modul wird als
# erstes geladen, deshalb steht es hier.
if settings.device == "cpu":
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
