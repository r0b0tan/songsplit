"""Synthetische Testsignale.

Zwei Zwecke:

1. ``make_test_stems`` erzeugt die Spuren fuer den **Testpfad** der API. Dieser Pfad
   trennt nichts, er stellt nur fertige WAVs bereit, damit der Player auch ohne
   Modell-Download geprueft werden kann. Jobs aus diesem Pfad sind in der API und
   in der Oberflaeche als Testpfad markiert.
2. ``make_test_input`` erzeugt ein kurzes, kuenstliches Musikstueck als Eingabe
   fuer einen echten Separations-Durchlauf.

Die Klickspuren haben ihre Klicks exakt zu denselben Zeitpunkten. Laufen zwei
Spuren synchron, hoert man einen einzigen Klick; driften sie, hoert man ein
Flattern oder zwei getrennte Klicks.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 44_100
CLICK_INTERVAL_S = 1.0
TEST_DURATION_S = 30.0


def _click_train(duration_s: float, freq_hz: float, interval_s: float = CLICK_INTERVAL_S,
                 decay_s: float = 0.004) -> np.ndarray:
    """Klickfolge: kurze, scharf abfallende Bursts in festem Raster."""
    n = int(duration_s * SAMPLE_RATE)
    out = np.zeros(n, dtype=np.float32)
    burst_n = int(decay_s * 4 * SAMPLE_RATE)
    t = np.arange(burst_n) / SAMPLE_RATE
    burst = (np.sin(2 * np.pi * freq_hz * t) * np.exp(-t / decay_s)).astype(np.float32)
    for k in range(int(duration_s / interval_s) + 1):
        start = int(round(k * interval_s * SAMPLE_RATE))
        end = min(start + burst_n, n)
        if start >= n:
            break
        out[start:end] += burst[: end - start]
    return np.clip(out * 0.8, -1.0, 1.0)


def _sine(duration_s: float, freq_hz: float, amp: float = 0.25) -> np.ndarray:
    t = np.arange(int(duration_s * SAMPLE_RATE)) / SAMPLE_RATE
    return (np.sin(2 * np.pi * freq_hz * t) * amp).astype(np.float32)


def _stereo(mono: np.ndarray) -> np.ndarray:
    return np.stack([mono, mono], axis=1)


def make_test_stems(target_dir: Path, duration_s: float = TEST_DURATION_S) -> list[tuple[str, Path]]:
    """Schreibt die Testspuren und gibt (Spurname, Pfad) zurueck."""
    target_dir.mkdir(parents=True, exist_ok=True)
    specs: list[tuple[str, str, np.ndarray]] = [
        # Zwei Klickspuren mit identischem Raster -> Synchronitaetstest
        ("Click A (1000 Hz)", "click-a", _click_train(duration_s, 1000.0)),
        ("Click B (2500 Hz)", "click-b", _click_train(duration_s, 2500.0)),
        # Dauerton -> Test, ob Tempo und Tonhoehe unabhaengig sind
        ("Sine 440 Hz", "sine-440", _sine(duration_s, 440.0)),
    ]
    written: list[tuple[str, Path]] = []
    for label, slug, mono in specs:
        path = target_dir / f"{slug}.wav"
        sf.write(path, _stereo(mono), SAMPLE_RATE, subtype="PCM_16")
        written.append((label, path))
    return written


def make_test_input(path: Path, duration_s: float = 12.0,
                    parts_dir: Path | None = None) -> Path:
    """Kurzes kuenstliches Stueck: Bassline, Kick/Snare-Raster und eine Melodie.

    Reicht als Rauchtest fuer die echte Separation. Musikalisch ist es nichts,
    aber htdemucs liefert dafuer vier plausible Spuren.

    Mit ``parts_dir`` werden zusaetzlich die drei Bestandteile einzeln
    geschrieben. Die sind die **Referenz**: damit laesst sich nachmessen, wie
    gut ein Verfahren wirklich trennt, statt es nur zu vermuten.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(duration_s * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE

    # Bass: Viertelnoten auf einer Tonleiter
    bass = np.zeros(n, dtype=np.float32)
    bass_notes = [55.0, 55.0, 73.42, 65.41]
    for k in range(int(duration_s * 2)):
        f = bass_notes[k % len(bass_notes)]
        s, e = int(k * 0.5 * SAMPLE_RATE), min(int((k * 0.5 + 0.45) * SAMPLE_RATE), n)
        if s >= n:
            break
        lt = np.arange(e - s) / SAMPLE_RATE
        env = np.exp(-lt / 0.25).astype(np.float32)
        bass[s:e] += (np.sin(2 * np.pi * f * lt) * env * 0.5).astype(np.float32)

    # Drums: Kick auf 1 und 3, Snare-Rauschen auf 2 und 4
    drums = np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(7)
    for k in range(int(duration_s * 4)):
        s = int(k * 0.25 * SAMPLE_RATE)
        if s >= n:
            break
        if k % 2 == 0:
            e = min(s + int(0.18 * SAMPLE_RATE), n)
            lt = np.arange(e - s) / SAMPLE_RATE
            sweep = np.sin(2 * np.pi * (110 * np.exp(-lt / 0.04)) * lt)
            drums[s:e] += (sweep * np.exp(-lt / 0.07) * 0.7).astype(np.float32)
        else:
            e = min(s + int(0.09 * SAMPLE_RATE), n)
            lt = np.arange(e - s) / SAMPLE_RATE
            noise = rng.standard_normal(e - s).astype(np.float32)
            drums[s:e] += (noise * np.exp(-lt / 0.025) * 0.35).astype(np.float32)

    # Melodie: Dreiklang-Arpeggio mit leichtem Vibrato
    lead = np.zeros(n, dtype=np.float32)
    lead_notes = [440.0, 554.37, 659.25, 554.37]
    for k in range(int(duration_s * 2)):
        f = lead_notes[k % len(lead_notes)]
        s, e = int(k * 0.5 * SAMPLE_RATE), min(int((k * 0.5 + 0.48) * SAMPLE_RATE), n)
        if s >= n:
            break
        lt = np.arange(e - s) / SAMPLE_RATE
        vib = 1.0 + 0.012 * np.sin(2 * np.pi * 5.5 * lt)
        env = np.minimum(lt / 0.02, 1.0) * np.exp(-lt / 0.35)
        lead[s:e] += (np.sin(2 * np.pi * f * vib * lt) * env * 0.3).astype(np.float32)

    mix = np.clip(bass + drums + lead, -1.0, 1.0)
    # Leichtes Stereobild, damit die Eingabe nicht rein mono ist
    left = np.clip(mix - 0.08 * lead, -1.0, 1.0)
    right = np.clip(mix + 0.08 * lead, -1.0, 1.0)
    sf.write(path, np.stack([left, right], axis=1), SAMPLE_RATE, subtype="PCM_16")

    if parts_dir is not None:
        parts_dir.mkdir(parents=True, exist_ok=True)
        # Dieselbe Stereoverteilung wie im Mix, damit die Summe der
        # Referenzspuren exakt den Mix ergibt.
        for name, mono, spread in (
            ("bass", bass, 0.0),
            ("drums", drums, 0.0),
            ("other", lead, 0.08),
        ):
            stereo = np.stack([mono - spread * lead, mono + spread * lead], axis=1)
            sf.write(parts_dir / f"ref_({name}).wav", stereo, SAMPLE_RATE, subtype="PCM_16")

    return path
