"""Regressionstests fuer die Zuordnung von Dateinamen zu Spuren.

Laeuft ohne Zusatzpakete:

    python tests/test_naming.py

Hintergrund: audio-separator schreibt "<eingabe>_(Vocals)_<modell>.wav".
Enthaelt schon der Eingabename eine Klammer, etwa
"Song (Official Music Video)", dann ist die erste Klammer im Dateinamen
**nicht** die Spur. Ein echter Job ist daran gescheitert und bekam statt
"Gesang", "Drums", "Bass" lange Notnamen aus dem Dateinamen.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.separation import MODEL_PRESETS, stem_key_from_filename  # noqa: E402

FOUR = MODEL_PRESETS["htdemucs"].stems
SIX = MODEL_PRESETS["htdemucs_6s"].stems

CASES: list[tuple[str, tuple[str, ...], str | None]] = [
    # Der Normalfall
    ("lied_(Vocals)_htdemucs", FOUR, "vocals"),
    ("lied_(Other)_htdemucs", FOUR, "other"),
    # Klammern im Eingabenamen: die Spur steht hinten
    (
        "Yeah Yeah Yeahs - Heads Will Roll (Official Music Video) "
        "[auzfTPp4moA]_(Bass)_htdemucs_6s",
        SIX,
        "bass",
    ),
    ("Mix (Live) (Remaster)_(Drums)_htdemucs", FOUR, "drums"),
    # Mehrere Klammern, aber nur eine passt zu einer bekannten Spur
    ("Track (Piano Version)_(Vocals)_htdemucs", FOUR, "vocals"),
    # Bei htdemucs_6s ist "piano" eine echte Spur. Die hintere gewinnt.
    ("Track (Piano Version)_(Guitar)_htdemucs_6s", SIX, "guitar"),
    # Umlaute und Sonderzeichen stoeren nicht
    ("Minenwerfer - Tiroler Edelweiss_(Vocals)_htdemucs", FOUR, "vocals"),
    # Gar keine Klammer
    ("ohne_klammern", FOUR, None),
]


def main() -> int:
    failed = 0
    for name, known, expected in CASES:
        actual = stem_key_from_filename(name, known)
        ok = actual == expected
        if not ok:
            failed += 1
        print(f"  [{'OK  ' if ok else 'FEHL'}] {expected!r:10s} aus {name[:62]}")
        if not ok:
            print(f"         bekommen: {actual!r}")
    print(f"\n  {len(CASES) - failed} von {len(CASES)} Faellen richtig.\n")
    return 1 if failed else 0


if __name__ == "__main__":
    print("\nSPURNAMEN AUS DATEINAMEN\n")
    raise SystemExit(main())
