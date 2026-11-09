"""Misst, wie stark sich die Spuren eines Jobs gegenseitig durchschlagen.

Es gibt keine Referenzspuren, also laesst sich "Bluten" nicht absolut
beziffern. Vergleichen laesst es sich aber: fuer jedes geordnete Paar (A, B)
wird bestimmt, welcher Anteil der Energie von B sich durch eine skalierte
Kopie von A erklaeren laesst. Das ist das Quadrat des Korrelationskoeffizienten

    r = <A, B> / (||A|| * ||B||)        Anteil = r^2

Ein Teil davon ist echt: Kick und Bass treffen denselben Schlag, die Spuren
sind also auch bei perfekter Trennung nicht unkorreliert. Aussagekraeftig ist
deshalb nur der Vergleich **desselben Paares zwischen zwei Verfahren**:
weniger ist sauberer.

    python tools/measure_bleed.py <ordner-mit-wavs> [weiterer-ordner ...]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

STEM_IN_NAME = re.compile(r"\(([^)]+)\)")


def load_stems(folder: Path) -> dict[str, np.ndarray]:
    stems: dict[str, np.ndarray] = {}
    for path in sorted(folder.glob("*.wav")):
        match = STEM_IN_NAME.search(path.stem)
        name = (match.group(1) if match else path.stem).lower()
        data, _ = sf.read(path, dtype="float32", always_2d=True)
        stems[name] = data.mean(axis=1)  # Mono, das reicht fuer den Vergleich
    return stems


def leakage_matrix(stems: dict[str, np.ndarray]) -> tuple[list[str], np.ndarray]:
    names = list(stems)
    n = len(names)
    length = min(len(s) for s in stems.values())
    data = np.stack([stems[k][:length] for k in names])
    # Mittelwert abziehen, damit ein Gleichanteil nichts vortaeuscht
    data = data - data.mean(axis=1, keepdims=True)
    norms = np.sqrt((data**2).sum(axis=1))
    norms[norms == 0] = 1e-12
    matrix = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            r = float(data[i] @ data[j]) / (norms[i] * norms[j])
            matrix[i, j] = r * r
    return names, matrix


def report(folder: Path) -> tuple[list[str], np.ndarray]:
    stems = load_stems(folder)
    if len(stems) < 2:
        raise SystemExit(f"{folder}: weniger als zwei WAVs gefunden")
    names, matrix = leakage_matrix(stems)

    print(f"\n{folder}")
    print("  Pegel je Spur:")
    for name, data in stems.items():
        print(
            f"    {name:12s} Spitze {np.max(np.abs(data)):.4f}  "
            f"Effektivwert {np.sqrt(np.mean(data**2)):.4f}"
        )
    print("  Gemeinsamer Anteil r^2 in Prozent (Zeile erklaert Spalte):")
    print("    " + " " * 12 + "".join(f"{n[:10]:>11}" for n in names))
    for i, name in enumerate(names):
        cells = "".join(
            "          ." if i == j else f"{matrix[i, j] * 100:10.2f} "
            for j in range(len(names))
        )
        print(f"    {name:12s}{cells}")
    off = matrix[~np.eye(len(names), dtype=bool)]
    print(f"  Mittel ueber alle Paare: {off.mean() * 100:.2f} %"
          f"   groesstes Paar: {off.max() * 100:.2f} %")
    return names, matrix


def main() -> None:
    folders = [Path(a) for a in sys.argv[1:]]
    if not folders:
        raise SystemExit(__doc__)
    results = [(f, *report(f)) for f in folders]
    if len(results) > 1:
        base_folder, base_names, base = results[0]
        print(f"\nVergleich gegen {base_folder.name}:")
        for folder, names, matrix in results[1:]:
            shared = [n for n in names if n in base_names]
            pairs = [
                (a, b,
                 base[base_names.index(a), base_names.index(b)],
                 matrix[names.index(a), names.index(b)])
                for a in shared for b in shared if a != b
            ]
            if not pairs:
                continue
            better = sum(1 for *_, x, y in pairs if y < x)
            print(f"  {folder.name}: bei {better} von {len(pairs)} Paaren weniger "
                  f"gemeinsamer Anteil")
            for a, b, x, y in sorted(pairs, key=lambda p: p[3] - p[2])[:6]:
                arrow = "besser" if y < x else "schlechter"
                print(f"    {a:10s} in {b:10s} {x * 100:6.2f} % -> "
                      f"{y * 100:6.2f} %  {arrow}")


if __name__ == "__main__":
    main()
