"""mixapart auf Modal — der Serverweg fuer Geraete, die ihre GPU nicht hergeben.

Warum es diesen Weg gibt, steht in `frontend/src/app/separate/runtime.ts`:
Chrome gibt WebGPU auf Android nur fuer einen Teil der verbauten
Grafikeinheiten frei. Ist der Adapter nicht zu haben — `GPU-01` oder
`GPU-03` —, kann das Geraet nicht trennen, und daran laesst sich dort nichts
aendern. Der WASM-Rueckfallweg ist auf einem Handy keine Antwort: 174 MB
Gewichte, knapp ein Gigabyte Arbeitsspeicher und einfaedig auf langsamen
Kernen.

Gerechnet wird hier **dieselbe Kette wie im Browser**, nicht eine zweite:

  * derselbe Graph — `frontend/public/models/htdemucs-op17-fp32/`, die
    Datei, die der Browser laedt, hier beim Image-Bau aus ihren neun
    Stuecken zusammengesetzt;
  * dieselbe Laufzeit — onnxruntime 1.31.1, im Browser als `onnxruntime-web`,
    hier als `onnxruntime-gpu`;
  * dieselben Schritte um den Graphen herum — `demucs_reference.py` aus
    `backend/tools/`, die numpy-Fassung von Blockbildung, STFT, CAC,
    Normierung, Maskierung, iSTFT, Ueberlappung und Trimmen, die ohnehin
    schon der Pruefstein fuer die TypeScript-Fassung ist.

Das ist der eigentliche Grund fuer diesen Zuschnitt. Ein zweiter Separator —
etwa `audio-separator` mit Torch — waere schneller hingeschrieben, haette
aber einen eigenen Klang, ein eigenes Verhalten an den Blockgrenzen und ein
Image um den ganzen Torch-Stack groesser. Wer hier und im Browser trennt,
soll dasselbe hoeren.

Einrichten
----------

    pip install modal
    modal setup                       # Token in ~/.modal.toml, einmalig
    modal secret create mixapart-token MIXAPART_TOKEN="$(openssl rand -hex 32)"

    modal serve cloud/app.py          # Probelauf, URL lebt solange das laeuft
    modal deploy cloud/app.py         # fest

`modal serve` ist der Weg zum Ausprobieren: die URL steht sofort, laedt bei
jeder Dateiaenderung neu, und das Handy kann direkt dagegen laufen.

Kosten
------

Bezahlt wird die Laufzeit des Containers, auch die Leerlaufzeit bis zum
Herunterfahren. Deshalb steht `SCALEDOWN_WINDOW` niedrig: ein grosszuegiges
Fenster ist bequem und kostet GPU-Minuten fuer nichts. `MAX_CONTAINERS`
deckelt, was gleichzeitig laufen kann — ein offener Endpunkt ohne Deckel ist
ein offener Geldhahn.
"""

from __future__ import annotations

import pathlib

import modal

# --------------------------------------------------------------- Stellwerk

#: Welche Karte. L4 (Ada, 24 GB) ist hier der Standard: htdemucs braucht
#: wenig Speicher, und L4 liegt beim Preis nah an T4, rechnet aber deutlich
#: schneller. `"T4"` ist die Sparvariante, `"A10G"` die schnellere.
GPU = "L4"

#: Obergrenze fuer gleichzeitige Container. Der Deckel gegen die Rechnung.
MAX_CONTAINERS = 2

#: Wie lange ein Container nach dem letzten Auftrag noch wartet. Kurz, weil
#: Leerlauf bezahlt wird — aber nicht null, sonst zahlt jeder zweite Song
#: den Cold Start.
SCALEDOWN_WINDOW = 60

#: Reisszeile fuer einen einzelnen Auftrag.
TIMEOUT = 900

#: Was angenommen wird. Die 200 MB aus `backend/app/config.py` sind fuer den
#: Serverweg zu viel: 25 MB reichen fuer gut zehn Minuten MP3, und was
#: darueber liegt, ist auf einem Handy ohnehin kein Upload mehr.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_SECONDS = 12 * 60

#: Von wo aus gefragt werden darf.
ORIGINS = [
    "https://mixapart.de",
    "https://www.mixapart.de",
    "http://localhost:4200",
    "http://127.0.0.1:4200",
]

#: Wie die Spuren zurueckkommen. MP3 statt WAV, und das ist keine
#: Bequemlichkeit: vier Spuren eines Viereinhalbminuetters sind als WAV rund
#: 170 MB. Ueber Mobilfunk ist das der langsamste Teil des ganzen Vorgangs.
#: Mit 192 kbit/s sind es gut 20 MB, und der Browser dekodiert MP3 ueberall.
STEM_FORMAT = "mp3"
STEM_BITRATE = "192k"
STEM_MEDIA_TYPE = "audio/mpeg"

REPO = pathlib.Path(__file__).resolve().parent.parent
EXPORT = REPO / "frontend" / "public" / "models" / "htdemucs-op17-fp32"
PIPELINE = REPO / "backend" / "tools" / "demucs_reference.py"

MODEL_DIR = "/model"
CODE_DIR = "/opt/mixapart"
RESULT_DIR = "/results"

#: Anzeigenamen wie in `backend/app/separation.py`.
STEM_LABELS = {
    "vocals": "Gesang",
    "drums": "Drums",
    "bass": "Bass",
    "other": "Rest",
}

# ------------------------------------------------------------------ Images

# Die CUDA-Fassung muss zu onnxruntime passen, sonst faellt die Laufzeit
# still auf die CPU zurueck — siehe `Separator.start`, wo genau das
# abgefangen wird. 13.2 ist die Fassung, gegen die hier gebaut wurde
# (`nvidia-cuda-runtime 13.2`, `nvidia-cudnn-cu13 9.26` im lokalen venv).
gpu_image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.2.1-cudnn-runtime-ubuntu24.04", add_python="3.12"
    )
    .apt_install("ffmpeg")
    .pip_install(
        "onnxruntime-gpu==1.31.1",
        "numpy==2.5.4",
    )
    # Das Modell liegt zerlegt im Repo: GitHub blockt Pushes ueber 100 MB,
    # Cloudflare Pages nimmt hoechstens 25 MiB je Datei. Hier wird es einmal
    # beim Image-Bau zusammengesetzt und liegt danach fertig im Container —
    # kein Nachladen beim Cold Start.
    .add_local_dir(EXPORT, f"{MODEL_DIR}/parts", copy=True)
    .add_local_file(PIPELINE, f"{CODE_DIR}/demucs_reference.py", copy=True)
    .run_commands(
        f"cat {MODEL_DIR}/parts/htdemucs.onnx.0* > {MODEL_DIR}/htdemucs.onnx",
        f"mv {MODEL_DIR}/parts/manifest.json {MODEL_DIR}/manifest.json",
        f"rm -rf {MODEL_DIR}/parts",
        # Gegen den stillen Fehlschlag: stimmt die Pruefsumme nicht, ist das
        # Modell beim Zusammensetzen kaputtgegangen, und das soll beim Bau
        # auffallen und nicht beim ersten Song.
        f"cd {MODEL_DIR} && python -c \""
        "import hashlib,json,pathlib;"
        "m=json.loads(pathlib.Path('manifest.json').read_text());"
        "d=hashlib.sha256(pathlib.Path('htdemucs.onnx').read_bytes()).hexdigest();"
        "assert d==m['weights']['sha256'], 'ONNX-Pruefsumme stimmt nicht: '+d\"",
    )
    .env({"PYTHONPATH": CODE_DIR})
)

# Die Web-Seite braucht weder CUDA noch das Modell. Ein eigenes, schlankes
# Image heisst: der Container, der die Anfragen annimmt, startet in
# Sekunden statt in einer halben Minute — und er laeuft ohne GPU, kostet
# also fast nichts, waehrend er wartet.
web_image = modal.Image.debian_slim(python_version="3.12").pip_install(
    "fastapi[standard]==0.122.0",
    "python-multipart==0.0.22",
)

# ------------------------------------------------------------------- Stand

app = modal.App("mixapart")

#: Fertige Spuren, bis sie abgeholt sind. Ein Volume und kein Rueckgabewert,
#: damit das Handy die Spuren einzeln und mit Fortschritt laden kann.
results = modal.Volume.from_name("mixapart-results", create_if_missing=True)

#: Wie weit ein laufender Auftrag ist. Klein, kurzlebig, nur zum Anzeigen.
progress = modal.Dict.from_name("mixapart-progress", create_if_missing=True)

#: Der eigene Token. `modal secret create mixapart-token MIXAPART_TOKEN=...`
token = modal.Secret.from_name("mixapart-token")


# ------------------------------------------------------------------ Trennen


@app.cls(
    image=gpu_image,
    gpu=GPU,
    volumes={RESULT_DIR: results},
    timeout=TIMEOUT,
    max_containers=MAX_CONTAINERS,
    scaledown_window=SCALEDOWN_WINDOW,
)
class Separator:
    """Haelt Modell und Sitzung, solange der Container lebt."""

    @modal.enter()
    def start(self) -> None:
        """Einmal je Container: Sitzung anlegen und nachweisen, dass sie
        wirklich auf der Karte rechnet.

        Der Nachweis steht hier aus demselben Grund wie im Browser.
        onnxruntime faellt bei jedem Problem still auf die CPU zurueck —
        fehlt eine CUDA-Bibliothek, passt die cuDNN-Fassung nicht, ist die
        Karte belegt: die Sitzung entsteht trotzdem, und der Unterschied ist
        nur die Laufzeit. Auf einer bezahlten GPU heisst das: die Karte
        wird bezahlt und die CPU rechnet. Also wird gefragt und notfalls
        laut abgebrochen, bevor der erste Song kommt.
        """
        import onnxruntime as ort

        import demucs_reference as ref

        self.ref = ref
        self.meta = ref.load_manifest(pathlib.Path(MODEL_DIR))
        self.session = ort.InferenceSession(
            f"{MODEL_DIR}/htdemucs.onnx",
            ort.SessionOptions(),
            providers=["CUDAExecutionProvider"],
        )
        got = self.session.get_providers()
        if "CUDAExecutionProvider" not in got:
            raise RuntimeError(
                "onnxruntime rechnet nicht auf der Karte, sondern auf "
                f"{got}. Meist passt die CUDA-Fassung des Basis-Images "
                "nicht zu onnxruntime-gpu."
            )
        print(f"Sitzung steht auf {got[0]}, Spuren: {self.meta.sources}")

    @modal.method()
    def trennen(self, job: str, audio: bytes, suffix: str) -> dict:
        """Ein Song. Schreibt die Spuren ins Volume, gibt die Liste zurueck."""
        import time

        import numpy as np

        started = time.monotonic()
        mix = decode(audio, suffix, self.meta.sample_rate)
        seconds = mix.shape[1] / self.meta.sample_rate
        if seconds > MAX_SECONDS:
            raise ValueError(
                f"{seconds / 60:.1f} Minuten sind mehr als die erlaubten "
                f"{MAX_SECONDS // 60}."
            )
        decoded = time.monotonic()

        def melden(block: int, blocks: int) -> None:
            # Zusammenfuehren statt ueberschreiben: in demselben Eintrag
            # stehen die Kennung des Rufs und der Zeitpunkt, und die hat
            # die Web-Seite beim Annehmen hineingelegt.
            stand = progress.get(job) or {}
            stand.update({"block": block, "blocks": blocks})
            progress[job] = stand

        out = self.ref.separate(self.session, mix, self.meta, on_block=melden)
        separated = time.monotonic()

        ziel = pathlib.Path(RESULT_DIR) / job
        ziel.mkdir(parents=True, exist_ok=True)
        stems = []
        for index, slug in enumerate(self.meta.sources):
            data = encode(np.asarray(out[index]), self.meta.sample_rate)
            datei = ziel / f"{slug}.{STEM_FORMAT}"
            datei.write_bytes(data)
            stems.append(
                {
                    "slug": slug,
                    "label": STEM_LABELS.get(slug, slug),
                    "bytes": len(data),
                    "url": f"/stem/{job}/{slug}",
                }
            )
        (ziel / "fertig").write_text("1", encoding="utf-8")
        results.commit()

        fertig = time.monotonic()
        return {
            "stems": stems,
            "seconds": round(seconds, 1),
            "zeiten": {
                "dekodieren": round(decoded - started, 1),
                "trennen": round(separated - decoded, 1),
                "kodieren": round(fertig - separated, 1),
            },
        }


# ------------------------------------------------------------------- Audio


def decode(raw: bytes, suffix: str, rate: int):
    """Beliebiges Eingangsformat zu `(2, n)` float64 bei `rate`.

    Ueber eine Datei und nicht ueber eine Pipe: bei MP4/M4A steht die
    Inhaltsbeschreibung am Dateiende, und ffmpeg kann aus einer Pipe nicht
    zurueckspringen. Mit einer Datei ist das kein Sonderfall mehr.
    """
    import subprocess
    import tempfile

    import numpy as np

    with tempfile.NamedTemporaryFile(suffix=suffix) as fh:
        fh.write(raw)
        fh.flush()
        fertig = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-v", "error",
                "-i", fh.name,
                "-f", "f32le", "-acodec", "pcm_f32le",
                "-ac", "2", "-ar", str(rate),
                "pipe:1",
            ],
            capture_output=True,
            check=False,
        )
    if fertig.returncode != 0:
        raise ValueError(
            "Die Datei liess sich nicht lesen: "
            + fertig.stderr.decode("utf-8", "replace").strip()[:200]
        )
    flat = np.frombuffer(fertig.stdout, dtype=np.float32)
    if flat.size < rate:  # weniger als eine Sekunde
        raise ValueError("Die Datei enthaelt kaum Ton.")
    return flat.reshape(-1, 2).T.astype(np.float64)


def encode(wave, rate: int) -> bytes:
    """Eine Spur `(2, n)` nach MP3.

    Begrenzt wird vorher: die Summe der getrennten Spuren ergibt wieder das
    Original, die einzelne Spur kann dabei ueber 1.0 hinausgehen. Ohne
    Begrenzung klappt das beim Kodieren um und knackt hoerbar.
    """
    import subprocess

    import numpy as np

    pcm = np.clip(wave.T, -1.0, 1.0).astype(np.float32).tobytes()
    fertig = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error",
            "-f", "f32le", "-ar", str(rate), "-ac", "2",
            "-i", "pipe:0",
            "-f", STEM_FORMAT, "-b:a", STEM_BITRATE,
            "pipe:1",
        ],
        input=pcm,
        capture_output=True,
        check=True,
    )
    return fertig.stdout


# --------------------------------------------------------------------- API


@app.function(
    image=web_image,
    volumes={RESULT_DIR: results},
    secrets=[token],
    max_containers=1,
    scaledown_window=300,
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def api():
    """Annehmen, nachfragen, ausliefern — drei Wege, kein GPU-Container.

    Getrennt wird mit `.spawn()`: die Trennung dauert je nach Laenge
    zwanzig Sekunden bis ein paar Minuten, und eine HTTP-Verbindung so
    lange offenzuhalten ist auf einem Handy im Mobilfunk der unsicherste
    Teil der Kette. Stattdessen kommt sofort eine Kennung zurueck, und das
    Geraet fragt nach — dasselbe Muster, das
    `frontend/src/app/core/api.service.ts` fuer das lokale Backend schon
    spricht.
    """
    import os
    import re
    import secrets as pysecrets
    import time

    from fastapi import FastAPI, File, Header, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse
    from modal.exception import OutputExpiredError

    ERLAUBTE_SUFFIXE = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"}
    JOB_MUSTER = re.compile(r"^[0-9a-f]{16}$")
    SLUG_MUSTER = re.compile(r"^[a-z]{3,10}$")

    web = FastAPI(title="mixapart", docs_url=None, redoc_url=None)
    web.add_middleware(
        CORSMiddleware,
        allow_origins=ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["X-Mixapart-Token", "Content-Type"],
    )

    def pruefe(gegeben: str | None) -> None:
        """Der Token haelt Gelegenheitsmissbrauch ab, keinen gezielten.

        Er steht im ausgelieferten JavaScript und ist damit einsehbar —
        das ist bekannt und in Kauf genommen. Was er leistet: niemand
        findet diesen Endpunkt zufaellig und laesst Guthaben darauf
        verschwinden. Was ihn traegt, ist `MAX_CONTAINERS`.
        """
        erwartet = os.environ["MIXAPART_TOKEN"]
        if not gegeben or not pysecrets.compare_digest(gegeben, erwartet):
            raise HTTPException(status_code=401, detail="Token fehlt oder stimmt nicht.")

    @web.post("/separate")
    async def separate(
        datei: UploadFile = File(...),
        x_mixapart_token: str | None = Header(default=None),
    ) -> dict:
        pruefe(x_mixapart_token)

        suffix = pathlib.PurePath(datei.filename or "").suffix.lower()
        if suffix not in ERLAUBTE_SUFFIXE:
            raise HTTPException(
                status_code=415,
                detail=f"{suffix or 'Ohne Endung'} wird nicht angenommen.",
            )

        # Stueckweise, damit eine zu grosse Datei abbricht statt erst
        # vollstaendig im Speicher zu landen.
        teile: list[bytes] = []
        gelesen = 0
        while stueck := await datei.read(1 << 20):
            gelesen += len(stueck)
            if gelesen > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"Hoechstens {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
                )
            teile.append(stueck)

        job = pysecrets.token_hex(8)
        ruf = Separator().trennen.spawn(job, b"".join(teile), suffix)
        # Die Kennung des Rufs steht im selben Eintrag wie der Fortschritt.
        # So kennt das Geraet nur **eine** Kennung — den Auftrag — und
        # fragt alles darueber nach.
        progress[job] = {"ruf": ruf.object_id, "start": time.time(), "block": 0, "blocks": 0}
        return {"job": job}

    @web.get("/status/{job}")
    def status(job: str, x_mixapart_token: str | None = Header(default=None)) -> dict:
        pruefe(x_mixapart_token)
        if not JOB_MUSTER.match(job):
            raise HTTPException(status_code=400, detail="Unzulaessige Kennung.")
        stand = progress.get(job)
        if not stand:
            raise HTTPException(status_code=404, detail="Kein solcher Auftrag.")

        try:
            ergebnis = modal.FunctionCall.from_id(stand["ruf"]).get(timeout=0)
        except TimeoutError:
            # Laeuft noch. Die Blockzahl schreibt der GPU-Container fort.
            return {
                "zustand": "laeuft",
                "block": stand.get("block", 0),
                "blocks": stand.get("blocks", 0),
            }
        except OutputExpiredError:
            raise HTTPException(status_code=410, detail="Das Ergebnis ist abgelaufen.")
        except Exception as fehler:  # die Trennung selbst ist gescheitert
            return {"zustand": "fehler", "grund": str(fehler)[:400]}
        return {"zustand": "fertig", **ergebnis}

    @web.get("/stem/{job}/{slug}")
    def stem(job: str, slug: str, x_mixapart_token: str | None = Header(default=None)):
        pruefe(x_mixapart_token)
        # Beides gegen ein Muster und nicht nur gegen `..`: der Pfad kommt
        # aus der Anfrage, und ein Volume enthaelt fremde Auftraege.
        if not JOB_MUSTER.match(job) or not SLUG_MUSTER.match(slug):
            raise HTTPException(status_code=400, detail="Unzulaessige Kennung.")
        results.reload()
        datei = pathlib.Path(RESULT_DIR) / job / f"{slug}.{STEM_FORMAT}"
        if not datei.is_file():
            raise HTTPException(status_code=404, detail="Nicht (mehr) da.")
        return FileResponse(
            datei,
            media_type=STEM_MEDIA_TYPE,
            headers={"Cache-Control": "private, max-age=3600"},
        )

    @web.get("/health")
    def health() -> dict:
        return {"ok": True, "format": STEM_FORMAT, "gpu": GPU}

    return web


# ----------------------------------------------------------------- Aufraeumen


@app.function(image=web_image, volumes={RESULT_DIR: results}, schedule=modal.Period(hours=6))
def aufraeumen() -> None:
    """Spuren aelter als sechs Stunden loeschen.

    Nicht nur wegen des Platzes. Die Zusage auf der Seite ist, dass die
    hochgeladene Musik nicht bleibt — und eine Zusage, die niemand
    durchsetzt, ist keine. Deshalb steht das Loeschen als eigener,
    regelmaessiger Lauf hier und nicht als Nebensache am Ende der Trennung,
    wo ein Abbruch es verschlucken wuerde.
    """
    import shutil
    import time

    results.reload()
    grenze = time.time() - 6 * 3600
    wurzel = pathlib.Path(RESULT_DIR)
    weg = 0
    for ordner in wurzel.iterdir():
        if ordner.is_dir() and ordner.stat().st_mtime < grenze:
            shutil.rmtree(ordner, ignore_errors=True)
            weg += 1
    # Nur die alten Eintraege, und zwar nach ihrem eigenen Zeitstempel: ein
    # Auftrag, der gerade laeuft, verliert sonst mitten im Lauf seinen
    # Fortschritt, und das Geraet zeigt einen Balken, der zurueckspringt.
    for job, stand in list(progress.items()):
        if not isinstance(stand, dict) or stand.get("start", 0) < grenze:
            progress.pop(job, None)
    results.commit()
    print(f"{weg} Auftraege geloescht")
