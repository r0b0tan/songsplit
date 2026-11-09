#!/usr/bin/env python3
"""Exportiert htdemucs als ONNX fuer den Browserpfad — und prueft den Export.

Was exportiert wird, ist **nicht** das ganze Modell: STFT und iSTFT bleiben
draussen. Zwei Gruende, beide gemessen beziehungsweise nachgelesen:

1. `torch.onnx.export` bekommt die komplexen Tensoren von `torch.stft` und
   `torch.istft` nicht durch den Graphen. Das ist der Grund, aus dem jeder
   oeffentliche htdemucs-Export dieselbe Grenze zieht.
2. Die Normalisierung (Mittelwert und Streuung ueber den ganzen
   Spektrogrammblock) liegt ebenfalls draussen. Als Knoten im Graphen
   liefert sie auf der WebGPU-Laufzeit NaN, solange man sie nicht einzeln
   auf die CPU zwingt; davor steht man nicht, wenn sie gar nicht im Graphen
   ist.

Die Grenze liegt damit genau dort, wo auch der Code sie zieht:

    Eingaben   x  [1, 4, 2048, 336]   normiertes CAC-Spektrogramm
               xt [1, 2, 343980]      normierte Wellenform (7,8 s)
    Ausgaben   x_out  [1, 4*S, 2048, 336]
               xt_out [1, 2*S, 343980]

Alles davor und danach — Dekodieren, Blockbildung, STFT, Normierung,
Maskierung, iSTFT, Ueberlappung, Trimmen — macht der Browser in
`frontend/src/app/separate/`. Dieselben Schritte stehen zum Vergleichen
in `backend/tools/demucs_reference.py`.

Aufruf:

    ../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs
    ../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs_6s --precision fp16

Geschrieben wird nach `frontend/public/models/<name>-<opset>-<precision>/`:
die ONNX-Datei **in Stuecken zu 20 MB** und ein `manifest.json` mit allem,
was der Browser und ein spaeterer Leser wissen muessen — Pruefsummen,
Formen, Spurreihenfolge, Lizenz.

Warum in Stuecken: die ganze Datei ist 174 MB, und daran scheitert das
Ausliefern. GitHub blockt Pushes ueber 100 MB, Cloudflare Pages nimmt
hoechstens 25 MiB je Datei. Eine Zerlegung auf Byte-Ebene kommt ohne jedes
ONNX-Werkzeug aus: der Browser holt die Stuecke, setzt sie im
Arbeitsspeicher wieder zusammen und gibt der Laufzeit dieselben Bytes wie
zuvor. Mit `--no-split` bleibt es bei einer Datei, etwa zum Nachsehen mit
anderen Werkzeugen.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import pathlib
import shutil
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[2]


def _install_demucs_alias() -> None:
    """Macht die in `audio-separator` mitgelieferte Demucs-Kopie importierbar.

    Die `.th`-Dateien von Meta sind Pickles, die die Modellklasse selbst
    mitbringen und sie unter `demucs.htdemucs` suchen. Ein eigenes
    `demucs`-Paket ist hier nicht installiert — die Kopie in
    `audio_separator/separator/uvr_lib_v5/demucs` ist dieselbe und wird
    deshalb unter dem erwarteten Namen eingehaengt.
    """
    base = "audio_separator.separator.uvr_lib_v5.demucs"
    vendored = importlib.import_module(base)
    sys.modules.setdefault("demucs", vendored)
    for sub in ("demucs", "hdemucs", "htdemucs", "spec", "states", "transformer"):
        sys.modules.setdefault(
            f"demucs.{sub}", importlib.import_module(f"{base}.{sub}")
        )


_install_demucs_alias()

import torch  # noqa: E402
from torch import nn  # noqa: E402

from audio_separator.separator.uvr_lib_v5.demucs.states import (  # noqa: E402
    load_model,
)


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def checkpoint_for(name: str, model_dir: pathlib.Path) -> pathlib.Path:
    """Findet die Gewichtsdatei zu einem Modellnamen ueber die YAML daneben.

    `htdemucs.yaml` enthaelt `models: ['955717e8']`, und daneben liegt
    `955717e8-8726e21a.th`. Gebuendelte Modelle (`htdemucs_ft`) haben mehrere
    Eintraege und werden hier abgelehnt: ein Buendel aus vier Modellen ist
    vier Mal der Download und vier Mal die Rechenzeit, das ist eine eigene
    Entscheidung und kein Nebenprodukt dieses Skripts.
    """
    yaml = model_dir / f"{name}.yaml"
    if not yaml.exists():
        raise SystemExit(f"Keine Modellbeschreibung: {yaml}")
    text = yaml.read_text(encoding="utf-8")
    # Die Datei ist winzig und hat genau eine Liste; dafuer braucht es kein
    # YAML-Paket.
    start = text.index("[")
    end = text.index("]", start) + 1
    signatures = ast.literal_eval(text[start:end])
    if len(signatures) != 1:
        raise SystemExit(
            f"{name} ist ein Buendel aus {len(signatures)} Modellen. "
            "Dieses Skript exportiert ein einzelnes Modell."
        )
    matches = sorted(model_dir.glob(f"{signatures[0]}-*.th"))
    if not matches:
        raise SystemExit(
            f"Gewichte zu {name} ({signatures[0]}) fehlen in {model_dir}. "
            "Erst `python tools/fetch_model_configs.py` laufen lassen."
        )
    return matches[0]


class HTDemucsForward(nn.Module):
    """Der Teil von `HTDemucs.forward`, der sich nach ONNX uebersetzen laesst.

    Der Rumpf ist aus `htdemucs.py` uebernommen, ohne die Stellen, die
    draussen bleiben: `_spec`, die Normierung, `_mask`, `_ispec` und das
    Zuruecknehmen der Normierung. Was hier passiert, ist genau das, was
    zwischen den beiden normierten Eingaben und den beiden rohen Ausgaben
    liegt — Encoder, Cross-Transformer, Decoder.
    """

    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.m = model

    def forward(
        self, x: torch.Tensor, xt: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        m = self.m
        saved: list[torch.Tensor] = []
        saved_t: list[torch.Tensor] = []
        lengths: list[int] = []
        lengths_t: list[int] = []

        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)

        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)

            x, xt = m.crosstransformer(x, xt)

            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)

        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip_t = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip_t, length_t)

        return x, xt


def build(name: str, model_dir: pathlib.Path):
    ckpt = checkpoint_for(name, model_dir)
    model = load_model(ckpt)
    model.eval()
    if not model.cac:
        raise SystemExit(
            f"{name} rechnet nicht im CAC-Modus. Dieser Export setzt CAC voraus."
        )
    if model.wiener_iters != 0:
        raise SystemExit(f"{name} verlangt Wiener-Filterung — hier nicht abgedeckt.")
    return model, ckpt


def spec_shapes(model) -> dict[str, int]:
    """Die festen Formen, die aus `segment`, `nfft` und `hop_length` folgen."""
    import math

    length = int(model.segment * model.samplerate)
    hop = model.hop_length
    frames = int(math.ceil(length / hop))
    freqs = model.nfft // 2
    sources = len(model.sources)
    return {
        "segment_samples": length,
        "frames": frames,
        "freq_bins": freqs,
        "sources": sources,
        "hop_length": hop,
        "nfft": model.nfft,
        "sample_rate": model.samplerate,
        "channels": model.audio_channels,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("name", nargs="?", default="htdemucs")
    ap.add_argument("--model-dir", default=str(REPO / "models"))
    ap.add_argument("--out-dir", default=str(REPO / "frontend" / "public" / "models"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--precision", choices=("fp32", "fp16"), default="fp32")
    ap.add_argument(
        "--part-bytes",
        type=int,
        default=20 * 1024 * 1024,
        help="Groesse der Stuecke. Vorgabe 20 MiB — unter dem Limit von 25 MiB.",
    )
    ap.add_argument(
        "--no-split",
        dest="split",
        action="store_false",
        help="Eine einzelne Datei schreiben. Laesst sich dann nicht ueberall ausliefern.",
    )
    ap.add_argument(
        "--tolerance",
        type=float,
        default=None,
        help=(
            "Erlaubter groesster Einzelfehler gegen die Torch-Referenz, "
            "bezogen auf den groessten Betrag der Referenz."
        ),
    )
    args = ap.parse_args()

    model_dir = pathlib.Path(args.model_dir)
    model, ckpt = build(args.name, model_dir)
    shapes = spec_shapes(model)
    S = shapes["sources"]
    C = shapes["channels"]
    Fq = shapes["freq_bins"]
    T = shapes["frames"]
    L = shapes["segment_samples"]

    print(f"Modell          {args.name}  ({', '.join(model.sources)})")
    print(f"Gewichte        {ckpt.name}")
    params = sum(p.numel() for p in model.parameters())
    print(f"Parameter       {params:,} ({params * 4 / 1e6:.1f} MB in fp32)")
    print(f"Abtastrate      {shapes['sample_rate']} Hz")
    print(f"Blocklaenge     {L} Abtastwerte ({L / shapes['sample_rate']:.2f} s)")
    print(f"STFT            nfft={shapes['nfft']}  hop={shapes['hop_length']}")
    print(f"Eingaben        x [1, {2 * C}, {Fq}, {T}]   xt [1, {C}, {L}]")
    print(f"Ausgaben        x_out [1, {2 * C * S}, {Fq}, {T}]   xt_out [1, {C * S}, {L}]")

    wrapper = HTDemucsForward(model).eval()

    # Feste Beispieleingaben in derselben Groessenordnung wie echte, normierte
    # Daten: der Vergleich unten misst sonst Fehler an Werten, die so nie
    # auftreten.
    gen = torch.Generator().manual_seed(20261109)
    x = torch.randn(1, 2 * C, Fq, T, generator=gen)
    xt = torch.randn(1, C, L, generator=gen)

    with torch.no_grad():
        t0 = time.perf_counter()
        ref_x, ref_xt = wrapper(x, xt)
        print(f"Torch-Referenz  {time.perf_counter() - t0:.2f} s auf der CPU")
    if tuple(ref_x.shape) != (1, 2 * C * S, Fq, T):
        raise SystemExit(f"Unerwartete Form x_out: {tuple(ref_x.shape)}")
    if tuple(ref_xt.shape) != (1, C * S, L):
        raise SystemExit(f"Unerwartete Form xt_out: {tuple(ref_xt.shape)}")

    out_dir = pathlib.Path(args.out_dir) / f"{args.name}-op{args.opset}-{args.precision}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    onnx_path = out_dir / f"{args.name}.onnx"

    print(f"\nExport          {onnx_path}")
    t0 = time.perf_counter()
    torch.onnx.export(
        wrapper,
        (x, xt),
        str(onnx_path),
        input_names=["x", "xt"],
        output_names=["x_out", "xt_out"],
        opset_version=args.opset,
        dynamo=False,
    )
    print(f"                {time.perf_counter() - t0:.1f} s")

    if args.precision == "fp16":
        convert_fp16(onnx_path)

    weights_bytes = onnx_path.stat().st_size
    weights_hash = sha256(onnx_path)
    print(f"                {onnx_path.name}  {weights_bytes / 1e6:.1f} MB")

    # Erst pruefen, dann zerlegen: der Vergleich laedt die Datei, und nach
    # dem Zerlegen gibt es sie nicht mehr.
    tol = args.tolerance if args.tolerance is not None else (
        2e-2 if args.precision == "fp16" else 1e-3
    )
    report = compare(onnx_path, x, xt, ref_x, ref_xt, tol)

    if args.split:
        parts = split_file(onnx_path, args.part_bytes)
        print(f"\nZerlegt        {len(parts)} Stuecke zu hoechstens "
              f"{args.part_bytes / 1e6:.0f} MB — unter dem Limit von 25 MiB,")
        print("                das Cloudflare Pages je Datei zulaesst.")
    else:
        parts = [{"name": onnx_path.name, "bytes": weights_bytes,
                  "sha256": weights_hash}]

    manifest = {
        "name": args.name,
        "description": "htdemucs, Vorwaertsteil ohne STFT/iSTFT/Normierung",
        "sources": list(model.sources),
        "sample_rate": shapes["sample_rate"],
        "channels": C,
        "segment_samples": L,
        "nfft": shapes["nfft"],
        "hop_length": shapes["hop_length"],
        "freq_bins": Fq,
        "frames": T,
        "cac": True,
        "opset": args.opset,
        "precision": args.precision,
        "inputs": {
            "x": [1, 2 * C, Fq, T],
            "xt": [1, C, L],
        },
        "outputs": {
            "x_out": [1, 2 * C * S, Fq, T],
            "xt_out": [1, C * S, L],
        },
        "weights": {
            # Die Stuecke in genau dieser Reihenfolge aneinandergehaengt
            # ergeben wieder die ONNX-Datei. Die Pruefsumme gilt fuer das
            # zusammengesetzte Ganze: ein halb geladenes Modell soll als
            # Ladefehler auffallen und nicht als kaputte Trennung.
            "file": onnx_path.name,
            "total_bytes": weights_bytes,
            "sha256": weights_hash,
            "parts": parts,
        },
        "checkpoint": {
            "file": ckpt.name,
            "bytes": ckpt.stat().st_size,
            "sha256": sha256(ckpt),
        },
        "parameters": params,
        "license": "MIT (facebookresearch/demucs, Meta Platforms)",
        "exported_with": {
            "torch": torch.__version__,
            "exporter": "torch.onnx.export (TorchScript)",
        },
        "validation": report,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"\nmanifest.json   {out_dir / 'manifest.json'}")
    return 0 if report["passed"] else 1


def split_file(path: pathlib.Path, part_bytes: int) -> list[dict]:
    """Zerlegt die Datei in Stuecke und loescht das Original.

    Stumpf auf Byte-Ebene, ohne Kenntnis des Inhalts — die Stuecke
    aneinandergehaengt sind wieder dieselbe Datei. Das Original wird
    entfernt, damit unter `public/` nichts liegenbleibt, was sich nicht
    ausliefern laesst.
    """
    parts: list[dict] = []
    with path.open("rb") as fh:
        index = 0
        while True:
            chunk = fh.read(part_bytes)
            if not chunk:
                break
            name = f"{path.name}.{index:03d}"
            target = path.with_name(name)
            target.write_bytes(chunk)
            parts.append(
                {"name": name, "bytes": len(chunk), "sha256": sha256(target)}
            )
            index += 1
    path.unlink()
    return parts


def convert_fp16(onnx_path: pathlib.Path) -> None:
    """Rechnet den Graphen nach fp16 um, Conv und ConvTranspose ausgenommen.

    Vollstaendig in fp16 verliert htdemucs hoerbar an Drums und Bass — das
    ist an anderen Exporten dokumentiert und hier nicht nachgemessen. Die
    Faltungen bleiben deshalb in fp32; sie tragen den Grossteil der
    Gewichte, der Gewinn ist entsprechend geringer als die Haelfte.
    """
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(onnx_path))
    converted = float16.convert_float_to_float16(
        model,
        keep_io_types=True,
        op_block_list=["Conv", "ConvTranspose"],
        disable_shape_infer=True,
    )
    onnx.save(
        converted,
        str(onnx_path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=onnx_path.name + ".data",
        size_threshold=1024,
    )


def compare(
    onnx_path: pathlib.Path,
    x: "torch.Tensor",
    xt: "torch.Tensor",
    ref_x: "torch.Tensor",
    ref_xt: "torch.Tensor",
    tol: float,
) -> dict:
    """Laesst den Export einmal auf der CPU laufen und vergleicht Wert fuer Wert.

    Gemessen wird gegen den groessten Betrag der Referenz, nicht absolut: die
    Ausgaben des Frequenzzweigs liegen je nach Eingabe zwischen 1 und 10, ein
    fester Grenzwert waere also an einer Stelle streng und an der anderen
    bedeutungslos. Dieser Vergleich sagt nur, dass der Export dasselbe Modell
    ist. Was am Ende zaehlt, ist der Abstand in dB auf echtem Material —
    `tools/demucs_reference.py`.
    """
    import numpy as np
    import onnxruntime as ort

    print("\nVergleich gegen die Torch-Referenz (onnxruntime, CPU)")
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    t0 = time.perf_counter()
    sess = ort.InferenceSession(
        str(onnx_path), opts, providers=["CPUExecutionProvider"]
    )
    init = time.perf_counter() - t0
    t0 = time.perf_counter()
    got_x, got_xt = sess.run(
        ["x_out", "xt_out"], {"x": x.numpy(), "xt": xt.numpy()}
    )
    run = time.perf_counter() - t0
    print(f"  Sitzung       {init:.2f} s")
    print(f"  Inferenz      {run:.2f} s (CPU, ein Block)")

    report: dict = {"tolerance": tol, "session_seconds": round(init, 3),
                    "cpu_run_seconds": round(run, 3)}
    passed = True
    for label, got, ref in (("x_out", got_x, ref_x), ("xt_out", got_xt, ref_xt)):
        ref_np = ref.numpy()
        if got.shape != ref_np.shape:
            raise SystemExit(f"{label}: Form {got.shape} statt {ref_np.shape}")
        diff = np.abs(got.astype(np.float64) - ref_np.astype(np.float64))
        scale = float(np.abs(ref_np).max())
        worst = float(diff.max())
        mean = float(diff.mean())
        ok = worst <= tol * scale
        passed = passed and ok
        print(
            f"  {label:7s}     groesster Fehler {worst:.3e} bei Betraegen bis "
            f"{scale:.2f} ({worst / scale:.1e} relativ), Mittel {mean:.3e}  "
            f"{'bestanden' if ok else 'DURCHGEFALLEN'}"
        )
        report[label] = {
            "max_abs_error": worst,
            "max_relative_error": worst / scale,
            "mean_abs_error": mean,
            "reference_max_abs": scale,
            "passed": ok,
        }
    report["passed"] = passed
    return report


if __name__ == "__main__":
    raise SystemExit(main())
