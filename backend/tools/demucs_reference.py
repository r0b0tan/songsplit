#!/usr/bin/env python3
"""Die Browser-Trennung in numpy — als Referenz und als Pruefstein.

Der Browser macht alles selbst, was nicht im ONNX-Graphen steht: Blockbildung,
STFT, CAC, Normierung, Maskierung, iSTFT, Ueberlappung, Trimmen. Das ist genau
die Stelle, an der ein Nachbau still falsch sein kann — ein halber Block
Versatz, ein vergessener Faktor, eine Fensterfunktion in der falschen
Variante. Hoeren wuerde man es als Dumpfheit oder Flattern an den
Blockgrenzen, nicht als Fehler.

Dieses Skript ist dieselbe Kette, in numpy, Schritt fuer Schritt neben der
Torch-Fassung:

    --self-check   prueft STFT und iSTFT gegen `torch.stft` / `torch.istft`
    --compare      trennt eine Datei zweimal — numpy+ONNX gegen Torch — und
                   nennt den Abstand je Spur in dB
    --fixtures DIR schreibt die Zwischenergebnisse als `.bin`/`.json`, gegen
                   die sich die TypeScript-Fassung im Browser messen laesst

Aufruf:

    ../.venv/bin/python tools/demucs_reference.py --self-check
    ../.venv/bin/python tools/demucs_reference.py --compare ../testmusik/song.mp3
    ../.venv/bin/python tools/demucs_reference.py --fixtures ../frontend/tests/separate/fixtures

`--compare` braucht den Export aus `tools/export_htdemucs_onnx.py`.
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import pathlib
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[2]


def _install_demucs_alias() -> None:
    base = "audio_separator.separator.uvr_lib_v5.demucs"
    vendored = importlib.import_module(base)
    sys.modules.setdefault("demucs", vendored)
    for sub in ("demucs", "hdemucs", "htdemucs", "spec", "states", "transformer"):
        sys.modules.setdefault(
            f"demucs.{sub}", importlib.import_module(f"{base}.{sub}")
        )


_install_demucs_alias()

import numpy as np  # noqa: E402

# --------------------------------------------------------------------- STFT


def hann_periodic(n: int) -> np.ndarray:
    """Dasselbe Fenster wie `torch.hann_window(n)` — periodisch, nicht symmetrisch.

    `torch.hann_window` ist in der Vorgabe periodisch (`periodic=True`), teilt
    also durch `n` und nicht durch `n-1`. Die symmetrische Variante, die etwa
    `scipy.signal.hann` liefert, waere um einen Abtastwert verschoben und
    verletzte die Rekonstruktionsbedingung.
    """
    k = np.arange(n, dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * math.pi * k / n)


def stft(x: np.ndarray, nfft: int = 4096, hop: int = 1024) -> np.ndarray:
    """`torch.stft(..., normalized=True, center=True, pad_mode="reflect")`.

    `normalized=True` teilt durch die Wurzel aus `nfft`; `center=True`
    spiegelt vorher `nfft/2` Abtastwerte an beide Enden.
    """
    w = hann_periodic(nfft)
    pad = nfft // 2
    xp = np.pad(np.atleast_2d(x), ((0, 0), (pad, pad)), mode="reflect")
    channels, total = xp.shape
    frames = 1 + (total - nfft) // hop
    out = np.empty((channels, nfft // 2 + 1, frames), dtype=np.complex128)
    for i in range(frames):
        block = xp[:, i * hop : i * hop + nfft] * w
        out[:, :, i] = np.fft.rfft(block, axis=-1)
    return out / math.sqrt(nfft)


def istft(
    z: np.ndarray, nfft: int = 4096, hop: int = 1024, length: int | None = None
) -> np.ndarray:
    """`torch.istft(..., normalized=True, center=True, length=length)`.

    Jeder Block wird zurueckgerechnet, mit demselben Fenster gewichtet und
    ueberlagert; geteilt wird am Ende durch die Summe der Fensterquadrate.
    Ohne diese Teilung waere das Ergebnis an den Raendern lauter als in der
    Mitte, und genau das hoerte man an jeder Blockgrenze.
    """
    w = hann_periodic(nfft)
    channels, _, frames = z.shape
    blocks = np.fft.irfft(z * math.sqrt(nfft), n=nfft, axis=1)
    total = (frames - 1) * hop + nfft
    acc = np.zeros((channels, total), dtype=np.float64)
    env = np.zeros(total, dtype=np.float64)
    for i in range(frames):
        at = i * hop
        acc[:, at : at + nfft] += blocks[:, :, i] * w
        env[at : at + nfft] += w * w
    # Die Huellkurve ist in der Mitte stets deutlich ueber Null; nur die
    # aeussersten Abtastwerte, die ohnehin weggeschnitten werden, koennen
    # Null sein.
    safe = env > 1e-11
    acc[:, safe] /= env[safe]
    pad = nfft // 2
    end = total - pad if length is None else pad + length
    return acc[:, pad:end]


# ------------------------------------------------------- Modellbeschreibung


class Meta:
    """Die festen Groessen des Exports, aus `manifest.json`."""

    def __init__(self, manifest: dict) -> None:
        self.sources: list[str] = manifest["sources"]
        self.sample_rate: int = manifest["sample_rate"]
        self.channels: int = manifest["channels"]
        self.segment: int = manifest["segment_samples"]
        self.nfft: int = manifest["nfft"]
        self.hop: int = manifest["hop_length"]
        self.freqs: int = manifest["freq_bins"]
        self.frames: int = manifest["frames"]
        # `_spec` polstert um 3/8 der Fensterlaenge, damit die Zahl der
        # Zeitschritte genau der Eingabelaenge geteilt durch den Vorschub
        # entspricht.
        self.spec_pad = self.hop // 2 * 3

    @property
    def spec_pad_right(self) -> int:
        return self.spec_pad + self.frames * self.hop - self.segment


def load_manifest(path: pathlib.Path) -> Meta:
    return Meta(json.loads((path / "manifest.json").read_text(encoding="utf-8")))


# ------------------------------------------------- die Kette um den Graphen


def spec(x: np.ndarray, meta: Meta) -> np.ndarray:
    """`HTDemucs._spec`: polstern, STFT, oberste Frequenz und Rand wegschneiden."""
    xp = np.pad(x, ((0, 0), (meta.spec_pad, meta.spec_pad_right)), mode="reflect")
    z = stft(xp, meta.nfft, meta.hop)[:, :-1, :]
    return z[:, :, 2 : 2 + meta.frames]


def ispec(z: np.ndarray, meta: Meta, length: int) -> np.ndarray:
    """`HTDemucs._ispec`: die weggeschnittenen Raender als Nullen zurueckgeben."""
    channels = z.shape[0]
    full = np.zeros((channels, meta.freqs + 1, meta.frames + 4), dtype=np.complex128)
    full[:, : meta.freqs, 2 : 2 + meta.frames] = z
    le = meta.hop * math.ceil(length / meta.hop) + 2 * meta.spec_pad
    x = istft(full, meta.nfft, meta.hop, length=le)
    return x[:, meta.spec_pad : meta.spec_pad + length]


def to_cac(z: np.ndarray) -> np.ndarray:
    """`HTDemucs._magnitude` im CAC-Modus: Real- und Imaginaerteil als Kanaele.

    Die Reihenfolge ist `[K0 real, K0 imaginaer, K1 real, K1 imaginaer]` —
    nicht erst alle Realteile. Vertauscht man das, laeuft das Modell ohne
    Fehlermeldung und trennt nichts.
    """
    channels, freqs, frames = z.shape
    out = np.empty((channels * 2, freqs, frames), dtype=np.float32)
    out[0::2] = z.real
    out[1::2] = z.imag
    return out


def from_cac(x: np.ndarray, sources: int, channels: int) -> np.ndarray:
    """Gegenstueck zu `HTDemucs._mask`: aus `S*C*2` Kanaelen wieder komplex."""
    _, freqs, frames = x.shape
    v = x.reshape(sources, channels, 2, freqs, frames)
    return v[:, :, 0] + 1j * v[:, :, 1]


def std_unbiased(a: np.ndarray) -> float:
    """Streuung wie `torch.std`: mit Korrektur um einen Freiheitsgrad."""
    return float(np.std(a, ddof=1))


def run_segment(session, mix: np.ndarray, meta: Meta) -> np.ndarray:
    """Ein Block von genau `segment` Abtastwerten durch die ganze Kette.

    Rueckgabe: `(Spuren, Kanaele, segment)`.
    """
    z = spec(mix, meta)
    mag = to_cac(z)
    mean = float(mag.mean())
    std = std_unbiased(mag)
    x = ((mag - mean) / (1e-5 + std)).astype(np.float32)[None]

    meant = float(mix.mean())
    stdt = std_unbiased(mix)
    xt = ((mix - meant) / (1e-5 + stdt)).astype(np.float32)[None]

    x_out, xt_out = session.run(["x_out", "xt_out"], {"x": x, "xt": xt})

    s = len(meta.sources)
    c = meta.channels
    freq = x_out[0].astype(np.float64) * std + mean
    wav_freq = ispec(from_cac(freq, s, c).reshape(s * c, meta.freqs, meta.frames), meta, meta.segment)
    wav_freq = wav_freq.reshape(s, c, meta.segment)

    wav_time = xt_out[0].astype(np.float64).reshape(s, c, meta.segment) * stdt + meant
    return wav_freq + wav_time


def segment_weight(segment: int) -> np.ndarray:
    """Dreiecksgewicht wie in `apply.py`: in der Blockmitte am schwersten."""
    half = segment // 2
    rising = np.arange(1, half + 1, dtype=np.float64)
    falling = np.arange(segment - half, 0, -1, dtype=np.float64)
    weight = np.concatenate([rising, falling])
    assert len(weight) == segment
    return weight / weight.max()


def padded_chunk(mix: np.ndarray, offset: int, want: int) -> np.ndarray:
    """`TensorChunk.padded`: den Block in der Mitte halten, Rest mit Null.

    Der letzte Block eines Songs ist kuerzer als `segment`. Demucs legt ihn
    nicht an den Anfang des Fensters, sondern in die Mitte — die fehlende
    Haelfte der Differenz vorne, der Rest hinten.
    """
    total = mix.shape[-1]
    have = min(total - offset, want)
    delta = want - have
    start = offset - delta // 2
    end = start + want
    left = max(0, start)
    right = min(total, end)
    out = np.zeros((mix.shape[0], want), dtype=mix.dtype)
    out[:, left - start : left - start + (right - left)] = mix[:, left:right]
    return out


def center_trim(x: np.ndarray, length: int) -> np.ndarray:
    delta = x.shape[-1] - length
    if delta == 0:
        return x
    return x[..., delta // 2 : x.shape[-1] - (delta - delta // 2)]


def separate(session, mix: np.ndarray, meta: Meta, overlap: float = 0.25,
             on_block=None) -> np.ndarray:
    """Ein ganzer Song: Bloecke mit Ueberlappung, gewichtet aufsummiert."""
    s = len(meta.sources)
    c, n = mix.shape
    out = np.zeros((s, c, n), dtype=np.float64)
    sum_weight = np.zeros(n, dtype=np.float64)
    weight = segment_weight(meta.segment)
    stride = int((1 - overlap) * meta.segment)
    offsets = list(range(0, n, stride))
    for index, offset in enumerate(offsets):
        have = min(n - offset, meta.segment)
        block = padded_chunk(mix, offset, meta.segment)
        result = center_trim(run_segment(session, block, meta), have)
        out[..., offset : offset + have] += weight[:have] * result
        sum_weight[offset : offset + have] += weight[:have]
        if on_block:
            on_block(index + 1, len(offsets))
    assert sum_weight.min() > 0
    return out / sum_weight


# ----------------------------------------------------------- Torch-Referenz


def torch_reference(name: str, mix: np.ndarray, device: str) -> tuple[np.ndarray, list[str]]:
    import torch
    from audio_separator.separator.uvr_lib_v5.demucs.apply import apply_model

    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    from export_htdemucs_onnx import build  # noqa: PLC0415

    model, _ = build(name, REPO / "models")
    tensor = torch.from_numpy(mix.astype(np.float32))[None]
    with torch.no_grad():
        out = apply_model(
            model, tensor, shifts=0, split=True, overlap=0.25, device=device
        )
    return out[0].cpu().numpy().astype(np.float64), list(model.sources)


# ------------------------------------------------------------- Pruefstuecke


def self_check() -> bool:
    """STFT und iSTFT gegen Torch, und beide hintereinander gegen das Original."""
    import torch

    print("STFT und iSTFT gegen Torch\n")
    rng = np.random.default_rng(20261109)
    nfft, hop = 4096, 1024
    x = rng.standard_normal((2, 60000))

    mine = stft(x, nfft, hop)
    theirs = torch.stft(
        torch.from_numpy(x),
        nfft,
        hop,
        window=torch.hann_window(nfft, dtype=torch.float64),
        win_length=nfft,
        normalized=True,
        center=True,
        return_complex=True,
        pad_mode="reflect",
    ).numpy()
    ok = True
    err = np.abs(mine - theirs).max() / np.abs(theirs).max()
    ok &= err < 1e-12
    print(f"  [{'OK  ' if err < 1e-12 else 'FEHL'}] stft, groesster relativer Fehler {err:.2e}")

    back_mine = istft(mine, nfft, hop, length=x.shape[-1])
    back_theirs = torch.istft(
        torch.from_numpy(mine),
        nfft,
        hop,
        window=torch.hann_window(nfft, dtype=torch.float64),
        win_length=nfft,
        normalized=True,
        center=True,
        length=x.shape[-1],
    ).numpy()
    err = np.abs(back_mine - back_theirs).max() / np.abs(back_theirs).max()
    ok &= err < 1e-12
    print(f"  [{'OK  ' if err < 1e-12 else 'FEHL'}] istft, groesster relativer Fehler {err:.2e}")

    # Hin und zurueck muss das Original ergeben — sonst stimmt die
    # Fensterfunktion oder die Normierung nicht.
    err = np.abs(back_mine - x).max()
    ok &= err < 1e-9
    print(f"  [{'OK  ' if err < 1e-9 else 'FEHL'}] stft+istft ergibt das Original, Fehler {err:.2e}")

    # Und dasselbe fuer `_spec` / `_ispec`. Gemessen wird gegen die Methoden
    # des Modells, nicht gegen das Original: die beiden sind absichtlich
    # nicht invers. `_spec` wirft die oberste Frequenz und je zwei
    # Zeitschritte am Rand weg, `_ispec` setzt dort Nullen ein. Der Rest ist
    # ein Randfehler von ein bis zwei Prozent am Blockanfang, den die
    # Ueberlappung zwischen den Bloecken wieder zudeckt — und den die
    # Torch-Fassung genauso hat.
    meta = Meta(
        {
            "sources": ["drums", "bass", "other", "vocals"],
            "sample_rate": 44100,
            "channels": 2,
            "segment_samples": 343980,
            "nfft": 4096,
            "hop_length": 1024,
            "freq_bins": 2048,
            "frames": 336,
        }
    )
    t = np.arange(meta.segment) / 44100.0
    tone = np.vstack([np.sin(2 * math.pi * 220 * t), np.sin(2 * math.pi * 440 * t)]) * 0.4
    tone += 0.05 * np.random.default_rng(7).standard_normal(tone.shape)

    from export_htdemucs_onnx import build  # noqa: PLC0415

    model, _ = build("htdemucs", REPO / "models")
    with torch.no_grad():
        ref_z = model._spec(torch.from_numpy(tone)[None].float())[0].numpy()
        ref_back = model._ispec(
            torch.from_numpy(ref_z)[None], meta.segment
        )[0].numpy()

    z = spec(tone, meta)
    ok &= z.shape == (2, meta.freqs, meta.frames)
    err = np.abs(z - ref_z).max() / np.abs(ref_z).max()
    good = err < 1e-5
    ok &= good
    print(f"  [{'OK  ' if good else 'FEHL'}] _spec gegen das Modell, relativer Fehler {err:.2e}")

    back = ispec(z, meta, meta.segment)
    err = np.abs(back - ref_back).max() / np.abs(ref_back).max()
    good = err < 1e-5
    ok &= good
    print(f"  [{'OK  ' if good else 'FEHL'}] _ispec gegen das Modell, relativer Fehler {err:.2e}")
    print(f"  Formen: spec {z.shape}, erwartet (2, {meta.freqs}, {meta.frames})")

    # Der Randfehler, den die Ueberlappung zudecken muss: nur zur Kenntnis,
    # nicht als Pruefung.
    rel = np.sqrt(((back - tone) ** 2).mean() / (tone**2).mean())
    edge = np.sqrt(
        ((back[:, 8192:-8192] - tone[:, 8192:-8192]) ** 2).mean() / (tone**2).mean()
    )
    print(f"  Zur Kenntnis: _spec+_ispec weicht im ganzen Block um {rel:.1e} ab, "
          f"ohne die aeussersten 8192 Abtastwerte um {edge:.1e}")
    return bool(ok)


def db(ref: np.ndarray, got: np.ndarray) -> float:
    """Abstand in dB: Signal der Referenz gegen die Abweichung."""
    noise = float(((ref - got) ** 2).sum())
    signal = float((ref**2).sum())
    if noise == 0:
        return math.inf
    return 10.0 * math.log10(signal / noise)


def read_audio(path: pathlib.Path, sample_rate: int, seconds: float | None) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=sample_rate, mono=False,
                        duration=seconds)
    if y.ndim == 1:
        y = np.vstack([y, y])
    return y.astype(np.float64)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--compare", metavar="AUDIO")
    ap.add_argument("--fixtures", metavar="DIR")
    ap.add_argument("--name", default="htdemucs")
    ap.add_argument(
        "--export",
        default=None,
        help="Ordner des ONNX-Exports; sonst der zum Namen passende fp32-Ordner.",
    )
    ap.add_argument("--seconds", type=float, default=None)
    ap.add_argument("--device", default="cuda")
    ap.add_argument(
        "--no-floor",
        dest="floor",
        action="store_false",
        help="Den Vergleichsboden (Torch auf der CPU) weglassen; dann gilt 60 dB.",
    )
    args = ap.parse_args()

    export = (
        pathlib.Path(args.export)
        if args.export
        else REPO / "frontend" / "public" / "models" / f"{args.name}-op17-fp32"
    )

    ok = True
    if args.self_check:
        ok &= self_check()

    if args.fixtures:
        ok &= write_fixtures(pathlib.Path(args.fixtures), export, args)

    if args.compare:
        ok &= compare_file(pathlib.Path(args.compare), export, args)

    if not (args.self_check or args.compare or args.fixtures):
        ap.print_help()
        return 2
    return 0 if ok else 1


def open_session(export: pathlib.Path, provider: str = "CPUExecutionProvider"):
    import onnxruntime as ort

    meta = load_manifest(export)
    onnx = next(export.glob("*.onnx"))
    opts = ort.SessionOptions()
    sess = ort.InferenceSession(str(onnx), opts, providers=[provider])
    return sess, meta


def compare_file(audio: pathlib.Path, export: pathlib.Path, args) -> bool:
    """numpy+ONNX gegen Torch — gemessen an Torchs eigener Streuung.

    Ein fester Grenzwert in dB waere hier irrefuehrend. htdemucs legt auf
    manches Material fast nichts auf Drums und Bass (das steht so in der
    README), und auf einer Spur, die praktisch leer ist, verschlingt schon
    das Gleitkomma-Rauschen das ganze Signal: dieselbe Rechnung einmal auf
    der CPU und einmal auf der GPU liegt dort ebenfalls nur 0,5 dB
    auseinander.

    Verglichen wird deshalb mit genau dieser Streuung. Torch gegen Torch,
    CPU gegen GPU, ist der Boden, den keine Umsetzung unterbieten kann.
    Bestanden heisst: der Browserpfad liegt nicht weiter von Torch entfernt
    als Torch von sich selbst.
    """
    print(f"\nVergleich auf {audio.name}")
    sess, meta = open_session(export)
    mix = read_audio(audio, meta.sample_rate, args.seconds)
    n = mix.shape[-1]
    print(f"  {n} Abtastwerte, {n / meta.sample_rate:.1f} s, {mix.shape[0]} Kanaele")
    print(f"  Mix: Spitze {np.abs(mix).max():.4f}, Effektivwert "
          f"{np.sqrt((mix ** 2).mean()):.4f}")

    t0 = time.perf_counter()

    def tick(i, total):
        print(f"    Block {i}/{total}", end="\r", flush=True)

    mine = separate(sess, mix, meta, on_block=tick)
    web = time.perf_counter() - t0
    print(f"  numpy + onnxruntime (CPU): {web:.1f} s      ")

    t0 = time.perf_counter()
    theirs, sources = torch_reference(args.name, mix, args.device)
    print(f"  Torch ({args.device}): {time.perf_counter() - t0:.1f} s")

    floor = None
    if args.floor and args.device != "cpu":
        t0 = time.perf_counter()
        floor, _ = torch_reference(args.name, mix, "cpu")
        print(f"  Torch (cpu, als Vergleichsboden): {time.perf_counter() - t0:.1f} s")

    print()
    head = f"  {'Spur':9s} {'Ref RMS':>10s} {'ONNX/GPU':>9s}"
    if floor is not None:
        head += f" {'ONNX/CPU':>9s} {'Boden':>9s} {'Abstand':>8s}"
    print(head)

    passed = True
    for i, name in enumerate(sources):
        value = db(theirs[i], mine[i])
        line = (f"  {name:9s} {np.sqrt((theirs[i] ** 2).mean()):10.6f} "
                f"{value:8.1f} dB")
        if floor is not None:
            # Drei Vergleiche, die zusammen eine Aussage machen:
            #   ONNX/GPU  der Browserpfad gegen Torch auf der Grafikkarte
            #   ONNX/CPU  dasselbe gegen Torch auf der CPU — hier ist nur
            #             die Laufzeitumgebung anders, nicht das Geraet
            #   Boden     Torch gegen sich selbst, CPU gegen GPU
            same_device = db(floor[i], mine[i])
            base = db(theirs[i], floor[i])
            # Drei dB Spielraum. Der Boden ist keine Konstante: jede der
            # drei Rechnungen sitzt in fp32 ein Stueck neben dem wahren
            # Wert, und wie weit zwei davon auseinanderliegen, haengt an
            # den Kernen, die der jeweilige Rechenweg waehlt. Was die
            # Pruefung ausschliessen soll, ist ein Fehler in der Kette —
            # ein halber Block Versatz, eine falsche Fensterfunktion —, und
            # der liegt nicht drei dB daneben, sondern dreissig.
            ok = value >= base - 3.0
            passed = passed and ok
            line += (f" {same_device:8.1f} dB {base:8.1f} dB "
                     f"{value - base:+7.1f}  {'OK' if ok else 'FEHL'}")
        else:
            ok = value > 60
            passed = passed and ok
        print(line)

    if floor is None:
        print("\n  Ohne Vergleichsboden gilt 60 dB als Grenze.")
    print(f"\n  {'bestanden' if passed else 'DURCHGEFALLEN'}")
    return passed


def xorshift32(seed: int, count: int) -> np.ndarray:
    """Rauschen, das sich in TypeScript Bit fuer Bit nachrechnen laesst.

    `numpy.random` waere hier eine Falle: der Zufallsgenerator von numpy
    laesst sich in Javascript nicht nachbilden, also muesste das Eingangs-
    signal als Datei mitgeliefert werden — drei Megabyte, nur um einen
    Vergleich anstossen zu koennen. Xorshift32 besteht dagegen aus drei
    Schiebeoperationen auf 32 Bit, und die sind in beiden Sprachen genau
    gleich definiert.
    """
    x = seed & 0xFFFFFFFF
    out = np.empty(count, dtype=np.float64)
    for i in range(count):
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        x &= 0xFFFFFFFF
        out[i] = x / 4294967296.0 * 2.0 - 1.0
    return out


def test_signal(samples: int, sample_rate: int) -> np.ndarray:
    """Dasselbe Signal wie `makeTestSignal` in `tests/separate/dsp-check.ts`.

    Zwei Toene auf verschiedenen Frequenzen, Rauschen darunter und ein
    harter Einsatz: der Ton zeigt eine falsche Normierung, das Rauschen
    deckt das ganze Spektrum ab, und der Einsatz macht einen Versatz um
    einzelne Abtastwerte sichtbar.
    """
    t = np.arange(samples) / sample_rate
    left = 0.3 * np.sin(2 * math.pi * 220 * t) + 0.05 * xorshift32(12345, samples)
    right = 0.3 * np.sin(2 * math.pi * 330 * t + 0.7) + 0.05 * xorshift32(67890, samples)
    at = samples // 3
    left[at : at + 64] += 0.9
    right[at : at + 64] -= 0.9
    return np.vstack([left, right])


def digest(a: np.ndarray, probes: int = 97) -> dict:
    """Kennzahlen und Stichproben statt der ganzen Matrix.

    Die vollen Zwischenergebnisse waeren 32 MB — fuer ein Repo zu viel, in
    dem das groesste Stueck Quelltext 1300 Zeilen hat. Summe, Quadratsumme
    und Betrag fangen jede Verschiebung der Groessenordnung; die Stichproben
    an teilerfremd verteilten Stellen fangen vertauschte Achsen und einen
    Versatz, der die Kennzahlen unberuehrt liesse.
    """
    flat = np.ascontiguousarray(a, dtype=np.float64).reshape(-1)
    step = max(1, flat.size // probes)
    # Ein ungerader Schritt trifft bei geraden Achsenlaengen nicht immer
    # dieselbe Spalte.
    if step % 2 == 0:
        step += 1
    picks = list(range(0, flat.size, step))[:probes]
    return {
        "shape": list(a.shape),
        "sum": float(flat.sum()),
        "sum_squares": float((flat**2).sum()),
        "abs_max": float(np.abs(flat).max()),
        "probe_step": step,
        "probes": [float(flat[i]) for i in picks],
    }


def write_fixtures(out: pathlib.Path, export: pathlib.Path, args) -> bool:
    """Vergleichswerte zum Nachmessen in TypeScript.

    Keine Audiodaten, nur Zahlen: das Eingangssignal rechnet die
    TypeScript-Seite selbst nach, und von jedem Zwischenschritt stehen hier
    Kennzahlen und Stichproben. Die Datei ist damit wenige Kilobyte gross
    und im Repo lesbar.
    """
    out.mkdir(parents=True, exist_ok=True)
    meta = load_manifest(export)

    n = meta.segment + meta.hop * 37
    mix = test_signal(n, meta.sample_rate)
    block = mix[:, : meta.segment]
    z = spec(block, meta)
    cac = to_cac(z)

    index: dict = {
        "note": (
            "Erzeugt von backend/tools/demucs_reference.py --fixtures. "
            "Gegenstueck: frontend/tests/separate/dsp-check.ts"
        ),
        "sources": meta.sources,
        "sample_rate": meta.sample_rate,
        "segment": meta.segment,
        "hop": meta.hop,
        "nfft": meta.nfft,
        "freqs": meta.freqs,
        "frames": meta.frames,
        "samples": n,
        "stages": {
            "signal": digest(mix),
            "window": digest(hann_periodic(meta.nfft)),
            "spec_real": digest(z.real),
            "spec_imag": digest(z.imag),
            "cac": digest(cac),
            "ispec": digest(ispec(z, meta, meta.segment)),
            "weight": digest(segment_weight(meta.segment)),
            "padded_last_chunk": digest(
                padded_chunk(mix, int((1 - 0.25) * meta.segment), meta.segment)
            ),
        },
        "normalisation": {
            "spec_mean": float(cac.mean()),
            "spec_std": std_unbiased(cac),
            "wave_mean": float(block.mean()),
            "wave_std": std_unbiased(block),
        },
    }

    # ------------------------------------------------- die ganze Kette
    # Ein Block durch alles durch, einschliesslich des Modells. Damit kann
    # die Browser-Fassung nicht nur ihre Signalverarbeitung vergleichen,
    # sondern ihr Ergebnis — gegen dasselbe ONNX, das sie selbst laedt.
    # Das ist der einzige Vergleich, der die ganze Kette auf einmal trifft.
    session, _ = open_session(export)
    stems = separate(session, mix, meta)
    index["separated"] = {
        source: digest(stems[i]) for i, source in enumerate(meta.sources)
    }
    # Die Summe aller Spuren ergibt wieder nahezu den Mix. Das ist eine
    # Eigenschaft des Modells, keine der Umsetzung — aber eine, die jede
    # kaputte iSTFT und jede falsche Ueberlappung sofort verletzt.
    rebuilt = stems.sum(axis=0)
    index["sum_of_stems"] = {
        "max_abs_error": float(np.abs(rebuilt - mix).max()),
        "rms_error": float(np.sqrt(((rebuilt - mix) ** 2).mean())),
        "mix_rms": float(np.sqrt((mix**2).mean())),
        "db": db(mix, rebuilt),
    }

    path = out / "index.json"
    path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"\nVergleichswerte in {path} ({path.stat().st_size / 1024:.1f} kB)")
    for name, stage in index["stages"].items():
        print(f"  {name:18s} {str(stage['shape']):22s} Betrag bis {stage['abs_max']:.4f}")
    return True


if __name__ == "__main__":
    raise SystemExit(main())
