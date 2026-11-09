"""Erzeugt die Testsignale als Dateien. Aufruf:

    python -m tools.make_test_wavs <zielordner>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.synthetic import make_test_input, make_test_stems  # noqa: E402


def main() -> None:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "testsignale").resolve()
    target.mkdir(parents=True, exist_ok=True)
    for label, path in make_test_stems(target):
        print(f"Spur  {label:22s} -> {path}")
    mix = make_test_input(target / "testmix.wav")
    print(f"Mix   {'kuenstliches Stueck':22s} -> {mix}")


if __name__ == "__main__":
    main()
