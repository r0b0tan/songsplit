"""API-Schemas."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

JobStatus = Literal["queued", "processing", "done", "failed"]


class StemOut(BaseModel):
    name: str = Field(description="Anzeigename der Spur, z. B. 'Vocals'")
    slug: str = Field(description="Technischer Name, Teil der URLs")
    url: str = Field(description="WAV zum Abspielen")
    download_url: str = Field(description="Dasselbe WAV als Download")
    bytes: int


class JobOut(BaseModel):
    id: str
    source_name: str
    model: str
    model_label: str
    status: JobStatus
    # Keine echte Prozentzahl: der Worker liefert nur Phasen, daher zeigt die
    # Oberflaeche eine Aktivitaetsanzeige. Bleibt None.
    progress: float | None = None
    stage: str | None = Field(default=None, description="Aktuelle Phase im Klartext")
    error: str | None = None
    is_test_path: bool = Field(
        default=False,
        description="True = synthetische Spuren ohne echte Separation",
    )
    device: str | None = None
    duration_seconds: float | None = None
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    stems: list[StemOut] = []


class ModelOut(BaseModel):
    name: str
    #: Kurzname fuer die Auswahl ("Schnell", "Detailliert", ...).
    mode: str
    label: str
    description: str
    stems: list[str]
    is_default: bool = False
    available: bool = True
    detail: str | None = None
    #: True = alle Modelldateien liegen schon lokal, der Job startet sofort.
    downloaded: bool = True
    #: Dateien, die beim ersten Lauf noch geholt werden muessen.
    missing_files: list[str] = []


class DeviceOut(BaseModel):
    requested: str
    effective: str
    cuda_available: bool
    gpu_name: str | None = None
    vram_total_gib: float | None = None
    vram_free_gib: float | None = None
    torch_version: str | None = None
    cuda_runtime: str | None = None
    notes: list[str] = []


class HealthOut(BaseModel):
    ok: bool
    separator_available: bool
    separator_detail: str | None = None
    device: DeviceOut
    queued: int
    processing: int
