"""Anbindung an audio-separator (PyPI-Paket des Projekts python-audio-separator).

Geprueft gegen audio-separator 0.48.0. Die Modellnamen stammen aus
``Separator.list_supported_model_files()["Demucs"]``, nicht aus der Doku:

    htdemucs.yaml     -> vocals, drums, bass, other
    htdemucs_6s.yaml  -> vocals, drums, bass, guitar, piano, other

Die Klasse ``Separator`` kennt in dieser Version **keinen** Geraete-Parameter.
Sie nimmt die GPU, sobald ``torch.cuda.is_available()`` wahr ist. Der CPU-Modus
wird deshalb in ``config.py`` ueber ``CUDA_VISIBLE_DEVICES=""`` erzwungen.
"""
from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import settings
from .devices import probe_device
from .jobs import Job, Stem

log = logging.getLogger(__name__)

SUPPORTED_INPUT_SUFFIXES = {".mp3", ".wav"}

# Anzeigenamen fuer die Spuren, die das Modell liefert
STEM_LABELS = {
    "vocals": "Gesang",
    "drums": "Drums",
    "bass": "Bass",
    "other": "Rest",
    "guitar": "Gitarre",
    "piano": "Klavier",
    "instrumental": "Begleitung",
}


@dataclass(frozen=True)
class ModelPreset:
    """Ein waehlbares Modell."""

    name: str
    #: Kurzname fuer die Auswahl: was das Modell *leistet*, in einem Wort.
    #: Die Oberflaeche zeigt ihn auf der Karte, der technische Name steht
    #: daneben im Tooltip und spaeter am Job.
    mode: str
    label: str
    description: str
    stems: tuple[str, ...]
    filename: str
    #: Abweichende Anzeigenamen fuer einzelne Spuren dieses Modells.
    #: Bei einem Zweispurmodell heisst "other" eben Begleitung, nicht Rest.
    stem_labels: tuple[tuple[str, str], ...] = ()
    # Demucs mittelt ueber zufaellig verschobene Durchlaeufe. Gemessen bringt
    # das fast nichts (+0,2 dB bei fuenffacher Laufzeit), deshalb bleibt es
    # ueberall bei 1. Siehe README, Abschnitt "Welches Modell".
    shifts: int = 1
    is_default: bool = False


MODEL_PRESETS: dict[str, ModelPreset] = {
    "htdemucs": ModelPreset(
        name="htdemucs",
        mode="Schnell",
        filename="htdemucs.yaml",
        label="htdemucs — 4 Spuren, schnell",
        description="Gesang, Drums, Bass und Rest. Der schnellste Weg.",
        stems=("vocals", "drums", "bass", "other"),
        is_default=True,
    ),
    "htdemucs_ft": ModelPreset(
        name="htdemucs_ft",
        mode="Detailliert",
        filename="htdemucs_ft.yaml",
        label="htdemucs_ft — 4 Spuren, sauberer",
        description=(
            "Dasselbe Modell, nachtrainiert und vierfach gebuendelt. "
            "Am synthetischen Testmix 4,2 dB besser getrennt, dafuer rund "
            "zweieinhalbmal so lange. Die erste Wahl, wenn Spuren ineinander "
            "durchschlagen und vier Spuren gebraucht werden."
        ),
        stems=("vocals", "drums", "bass", "other"),
    ),
    "htdemucs_6s": ModelPreset(
        name="htdemucs_6s",
        mode="Instrumente",
        filename="htdemucs_6s.yaml",
        label="htdemucs_6s — 6 Spuren",
        description="Zusaetzlich Gitarre und Klavier. Langsamer, mehr VRAM.",
        stems=("vocals", "drums", "bass", "guitar", "piano", "other"),
    ),
    "roformer_vocals": ModelPreset(
        name="roformer_vocals",
        mode="Nur Gesang",
        label="Roformer — nur Gesang und Begleitung",
        description=(
            "MelBand Roformer, das beste Gesangsmodell der Sammlung. Nur "
            "zwei Spuren, dafuer am wenigsten Uebersprechen zwischen Gesang "
            "und Begleitung. Braucht 913 MB Download und bis zu 3,6 GB VRAM."
        ),
        # Das Modell schreibt "(Vocals)" und "(Other)"; der zweite Teil ist
        # hier die ganze Begleitung, nicht ein Rest neben Drums und Bass.
        stems=("vocals", "other"),
        stem_labels=(("other", "Begleitung"),),
        filename="vocals_mel_band_roformer.ckpt",
    ),
}

DEFAULT_MODEL = "htdemucs"

def stem_label(preset: ModelPreset, key: str) -> str:
    """Anzeigename einer Spur, mit Vorrang fuer die Angabe am Modell."""
    return dict(preset.stem_labels).get(key) or STEM_LABELS.get(key, key.title())


# Spurname aus Dateinamen wie "input_(Vocals)_htdemucs.wav".
# Achtung: der Eingabename kann selbst Klammern enthalten, etwa
# "Song (Official Music Video)_(Bass)_htdemucs_6s.wav". Deshalb wird nicht
# die erste Klammer genommen, sondern die letzte, die zu einer bekannten
# Spur passt.
_STEM_IN_NAME = re.compile(r"\(([^)]+)\)")


def stem_key_from_filename(stem_name: str, known: tuple[str, ...] = ()) -> str | None:
    groups = [g.strip().lower() for g in _STEM_IN_NAME.findall(stem_name)]
    if not groups:
        return None
    for group in reversed(groups):
        if group in known:
            return group
    return groups[-1]

# Der Separator wird einmal gebaut und wiederverwendet: das Laden der
# Modellgewichte kostet mehrere Sekunden. Der Lock ist die zweite Sicherung
# gegen parallele Nutzung (die erste ist der einzelne Worker-Thread).
_separator_lock = threading.Lock()
_separator_cache: dict[str, object] = {}


_model_index: dict | None = None


def _model_index_cached() -> dict:
    """Modellverzeichnis von audio-separator, einmal geholt und gemerkt."""
    global _model_index
    if _model_index is None:
        try:
            from audio_separator.separator import Separator

            _model_index = Separator(
                info_only=True, log_level=logging.ERROR
            ).list_supported_model_files()
        except Exception as exc:  # noqa: BLE001 - ohne Netz bleibt es leer
            log.warning("Modellverzeichnis nicht abrufbar: %s", exc)
            _model_index = {}
    return _model_index


def required_files(model_filename: str) -> list[str]:
    """Welche Dateien dieses Modell braucht (Gewichte plus Konfiguration)."""
    for group in _model_index_cached().values():
        for info in group.values():
            if info.get("filename") == model_filename:
                return [f.split("/")[-1] for f in info.get("download_files", [])]
    return [model_filename]


def preset_files(preset: ModelPreset) -> list[str]:
    return sorted(set(required_files(preset.filename)))


def preset_missing_files(preset: ModelPreset) -> list[str]:
    """Dateien, die noch fehlen. Leer heisst: laeuft ohne Download los."""
    return [f for f in preset_files(preset) if not (settings.model_dir / f).exists()]


def check_available() -> tuple[bool, str | None]:
    """Ist audio-separator importierbar? Gibt (ok, Detailtext) zurueck."""
    try:
        from audio_separator.separator import Separator  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"
    # Das Paket hat kein __version__, die Version steht in den Metadaten.
    try:
        from importlib.metadata import version

        return True, f"audio-separator {version('audio-separator')}"
    except Exception:  # noqa: BLE001
        return True, "audio-separator (Version unbekannt)"


def _get_separator(output_dir: Path, shifts: int = 1):
    """Baut einen Separator fuer dieses Ausgabeverzeichnis."""
    from audio_separator.separator import Separator

    return Separator(
        log_level=logging.WARNING,
        model_file_dir=str(settings.model_dir),
        output_dir=str(output_dir),
        output_format="WAV",
        sample_rate=44_100,
        # shifts mittelt ueber zufaellig verschobene Durchlaeufe. Mehr heisst
        # weniger Artefakte bei linear steigender Laufzeit.
        demucs_params={
            "segment_size": "Default",
            "shifts": shifts,
            "overlap": 0.25,
            "segments_enabled": True,
        },
    )


def _release(separator) -> None:
    """Gibt den GPU-Speicher des Modells frei, bevor das naechste kommt."""
    del separator
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001 - Aufraeumen darf nie den Job kippen
        pass


def separate_job(job: Job, stage: Callable[[str], None]) -> list[Stem]:
    """Trennt die Eingabedatei des Jobs und gibt die Spuren zurueck."""
    preset = MODEL_PRESETS.get(job.model)
    if preset is None:
        raise ValueError(f"Unbekanntes Modell {job.model!r}")

    device = probe_device()
    job.device = device.effective
    for note in device.notes:
        log.info("[%s] Geraetehinweis: %s", job.id, note)

    out_dir = job.stems_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    with _separator_lock:
        stems = _run_single(job, preset, stage, device.effective)

    stage("Spuren werden bereitgestellt")
    job.duration_seconds = _probe_duration(job.input_path)
    return stems


def _run_single(job: Job, preset: ModelPreset, stage: Callable[[str], None],
                device: str) -> list[Stem]:
    stage(f"Modell {preset.filename} wird geladen ({device.upper()})")
    separator = _get_separator(job.stems_dir, preset.shifts)
    separator.load_model(model_filename=preset.filename)

    stage(f"Audio wird in {len(preset.stems)} Spuren getrennt ({device.upper()})")
    produced = separator.separate(str(job.input_path))
    _release(separator)
    return _collect_stems(job.stems_dir, produced, preset)


def _collect_stems(out_dir: Path, produced: list[str] | None, preset: ModelPreset) -> list[Stem]:
    """Sortiert die erzeugten WAVs in die Reihenfolge des Modells."""
    paths: list[Path] = []
    for name in produced or []:
        p = Path(name)
        paths.append(p if p.is_absolute() else out_dir / p.name)
    if not paths:
        paths = sorted(out_dir.glob("*.wav"))

    by_stem: dict[str, Path] = {}
    leftovers: list[Path] = []
    for path in paths:
        if not path.exists():
            log.warning("Erwartete Ausgabedatei fehlt: %s", path)
            continue
        key = stem_key_from_filename(path.stem, preset.stems)
        if key in preset.stems and key not in by_stem:
            by_stem[key] = path
        else:
            leftovers.append(path)

    stems: list[Stem] = []
    for key in preset.stems:
        path = by_stem.get(key)
        if path is None:
            continue
        stems.append(Stem(name=stem_label(preset, key), slug=key, path=path))

    # Falls die Namenskonvention der Bibliothek sich aendert, gehen die
    # Dateien nicht verloren, sondern kommen unter ihrem Dateinamen durch.
    for path in leftovers:
        slug = re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-") or "spur"
        stems.append(Stem(name=path.stem, slug=slug, path=path))

    return stems


def _probe_duration(path: Path) -> float | None:
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return round(info.frames / info.samplerate, 3)
    except Exception:  # noqa: BLE001 - Dauer ist nur Zusatzinfo
        return None
