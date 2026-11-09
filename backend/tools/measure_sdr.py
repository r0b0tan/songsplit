"""Misst die Trennqualitaet gegen bekannte Referenzspuren.

Nur sinnvoll fuer den synthetischen Testmix: dort ist bekannt, woraus er
besteht. Bei echter Musik gibt es keine Referenz, da hilft nur
``measure_bleed.py`` und das eigene Ohr.

    SDR = 10 * log10( ||ref||^2 / ||schaetzung - ref||^2 )

Mehr dB ist besser. Die Zahl gilt fuer dieses kuenstliche Material und
laesst sich nicht auf echte Musik uebertragen; verglichen werden duerfen
nur Verfahren untereinander.

    python tools/measure_sdr.py <referenzordner> <ordner1> [ordner2 ...]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

KEY = re.compile(r"\(([^)]+)\)")


def load(folder: Path) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for path in sorted(folder.glob("*.wav")):
        m = KEY.search(path.stem)
        name = (m.group(1) if m else path.stem).lower()
        data, _ = sf.read(path, dtype="float32", always_2d=True)
        out[name] = data.mean(axis=1)
    return out


def sdr(ref: np.ndarray, est: np.ndarray) -> float:
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    # Beste Skalierung erlauben: ein konstanter Pegelunterschied ist kein
    # Trennfehler.
    denom = float(ref @ ref)
    scale = float(ref @ est) / denom if denom > 0 else 0.0
    err = est - scale * ref
    e = float(err @ err)
    if e <= 0:
        return float("inf")
    return 10.0 * np.log10(max(denom * scale * scale, 1e-20) / e)


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    refs = load(Path(sys.argv[1]))
    if not refs:
        raise SystemExit(f"Keine Referenzspuren in {sys.argv[1]}")
    print(f"Referenz: {sys.argv[1]}  ({', '.join(refs)})\n")
    print(f"{'Verfahren':26}" + "".join(f"{k:>10}" for k in refs) + f"{'Mittel':>10}")
    for folder in sys.argv[2:]:
        est = load(Path(folder))
        values = []
        cells = ""
        for key, ref in refs.items():
            if key in est:
                v = sdr(ref, est[key])
                values.append(v)
                cells += f"{v:10.2f}"
            else:
                cells += f"{'-':>10}"
        mean = sum(values) / len(values) if values else float("nan")
        print(f"{Path(folder).parent.name[:26]:26}{cells}{mean:10.2f}")
    print("\nAngaben in dB, mehr ist besser.")


if __name__ == "__main__":
    main()
