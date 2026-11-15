"""CUDA-Erkennung und VRAM-Warnungen in verstaendlichem Klartext."""
from __future__ import annotations

import logging
from dataclasses import dataclass, asdict, field

from .config import settings

log = logging.getLogger(__name__)

# Auf einer RTX 4070 Laptop (8 GB) gemessen, 4:33 Stereo, shifts=1,
# als belegte Spitze / reservierte Spitze:
#   htdemucs          0,53 / 0,71 GiB
#   htdemucs_6s       0,57 / 0,73 GiB
#   htdemucs_ft       1,01 / 1,18 GiB
#   roformer_vocals   1,96 / 3,57 GiB   <- das schwerste Modell
# Die Schwelle richtet sich nach dem schwersten Modell plus Reserve.
VRAM_WARN_GIB = 4.5


@dataclass
class DeviceInfo:
    requested: str           # was konfiguriert wurde: auto | cuda | cpu
    effective: str           # was wirklich genutzt wird: cuda | cpu
    cuda_available: bool
    gpu_name: str | None = None
    vram_total_gib: float | None = None
    vram_free_gib: float | None = None
    torch_version: str | None = None
    cuda_runtime: str | None = None
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def probe_device(requested: str | None = None) -> DeviceInfo:
    """Fragt torch nach der GPU und entscheidet, worauf getrennt wird."""
    requested = (requested or settings.device).lower()

    try:
        import torch
    except Exception as exc:  # pragma: no cover - nur wenn torch fehlt
        return DeviceInfo(
            requested=requested,
            effective="cpu",
            cuda_available=False,
            notes=[f"PyTorch konnte nicht geladen werden ({exc}). Es wird die CPU genutzt."],
        )

    info = DeviceInfo(
        requested=requested,
        effective="cpu",
        cuda_available=bool(torch.cuda.is_available()),
        torch_version=torch.__version__,
        cuda_runtime=getattr(torch.version, "cuda", None),
    )

    if info.cuda_available:
        try:
            info.gpu_name = torch.cuda.get_device_name(0)
            free_b, total_b = torch.cuda.mem_get_info(0)
            info.vram_free_gib = round(free_b / 1024**3, 2)
            info.vram_total_gib = round(total_b / 1024**3, 2)
        except Exception as exc:
            info.notes.append(f"GPU-Details nicht lesbar: {exc}")

    if requested == "cpu":
        info.effective = "cpu"
        info.notes.append("CPU-Modus ist fest eingestellt (MIXAPART_DEVICE=cpu).")
    elif info.cuda_available:
        info.effective = "cuda"
    elif requested == "cuda":
        info.effective = "cpu"
        info.notes.append(
            "CUDA wurde angefordert, ist aber nicht verfuegbar. "
            "Es wird auf der CPU getrennt (deutlich langsamer). "
            "Pruefe NVIDIA-Treiber und die CUDA-Variante von PyTorch."
        )
    else:
        info.effective = "cpu"
        info.notes.append(
            "Keine CUDA-GPU gefunden. Es wird auf der CPU getrennt (deutlich langsamer)."
        )

    if info.effective == "cuda" and info.vram_free_gib is not None:
        if info.vram_free_gib < VRAM_WARN_GIB:
            info.notes.append(
                f"Nur {info.vram_free_gib} GB von {info.vram_total_gib} GB VRAM sind frei. "
                "Die Demucs-Modelle brauchen rund 1,2 GB, das Roformer-Modell "
                f"bis zu 3,6 GB. Unter {VRAM_WARN_GIB:g} GB kann die Trennung mit "
                "'CUDA out of memory' abbrechen. Schliesse andere GPU-Programme, "
                "waehle ein Demucs-Modell, oder starte mit MIXAPART_DEVICE=cpu."
            )

    return info


def is_out_of_memory(exc: BaseException) -> bool:
    """Erkennt GPU-Speicherfehler, damit die Oberflaeche einen klaren Hinweis zeigen kann."""
    text = f"{type(exc).__name__}: {exc}".lower()
    needles = ("out of memory", "cuda_error_out_of_memory", "cublas_status_alloc_failed")
    return any(n in text for n in needles)
