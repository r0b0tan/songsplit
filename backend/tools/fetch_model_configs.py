"""Holt die Modelldateien vorab in den Modellordner.

Warum es dieses Skript gibt: ``audio-separator`` laedt pro Demucs-Modell zwei
Dateien. Die Gewichte (~84 MB) kommen von ``dl.fbaipublicfiles.com``, die
winzige YAML-Konfiguration dagegen von einem GitHub-Release-Asset. Genau dieser
Abruf schlaegt in manchen Netzen mit HTTP 504 fehl, waehrend alles andere laeuft.
Die Datei ist aber nur eine Liste der Gewichts-Hashes und steht im Demucs-Repo
ebenfalls bereit.

Das Skript probiert der Reihe nach:
  1. die Originalquelle laut Modellverzeichnis (bei Demucs: fbaipublicfiles)
  2. den audio-separator-Spiegel   (GitHub Release)
  3. den TRvlvr-Spiegel            (GitHub Release)
  4. das Demucs-Repo               (raw.githubusercontent.com)

Vorhandene Dateien bleiben unberuehrt. ``audio-separator`` ueberspringt beim
Laden jede Datei, die schon im Modellordner liegt.

    python tools/fetch_model_configs.py              # alle Modelle
    python tools/fetch_model_configs.py htdemucs_ft  # nur dieses
"""
from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.separation import MODEL_PRESETS, preset_files  # noqa: E402

MIRRORS = (
    "https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/{name}",
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/{name}",
    "https://raw.githubusercontent.com/adefossez/demucs/main/demucs/remote/{name}",
)

# Die Demucs-Gewichte liegen bei Meta und nicht auf GitHub. Sie heissen nach
# ihrer Pruefsumme und werden direkt von dort geholt.
UPSTREAM = "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/{name}"


def sources(name: str) -> tuple[str, ...]:
    if name.endswith(".th"):
        return (UPSTREAM,) + MIRRORS
    return MIRRORS


def fetch(name: str, target: Path) -> bool:
    if target.exists() and target.stat().st_size > 0:
        print(f"  {name}: liegt schon vor ({target.stat().st_size / 1e6:.1f} MB)")
        return True
    for template in sources(name):
        url = template.format(name=name)
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310 - feste Quellen
                data = resp.read()
            if not data.strip() or (name.endswith(".yaml") and data.lstrip().startswith(b"<")):
                print(f"  {name}: {url} -> keine brauchbare Antwort")
                continue
            target.write_bytes(data)
            print(f"  {name}: geladen von {url} ({len(data)} Bytes)")
            return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            print(f"  {name}: {url} -> {exc}")
    print(f"  {name}: FEHLGESCHLAGEN aus allen Quellen")
    return False


def main() -> int:
    import sys

    wanted = set(sys.argv[1:])
    print(f"Modellordner: {settings.model_dir}")
    ok = True
    for preset in MODEL_PRESETS.values():
        if wanted and preset.name not in wanted:
            continue
        print(f"\n{preset.name}:")
        for filename in preset_files(preset):
            ok &= fetch(filename, settings.model_dir / filename)
    if not ok:
        print(
            "\nMindestens eine Datei fehlt. Diese Modelle lassen sich nicht nutzen.\n"
            "Die Oberflaeche zeigt pro Modell an, ob es bereitliegt. Zum Pruefen\n"
            "des Players reicht der Testpfad (POST /api/jobs/test-signals)."
        )
        return 1
    print("\nAlle Modelldateien liegen vor.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
