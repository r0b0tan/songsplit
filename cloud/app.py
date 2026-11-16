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

import pathlib

import modal

# Kein `from __future__ import annotations` in dieser Datei, und das ist
# Absicht: fastapi wird erst *innerhalb* von `api()` importiert, weil das
# GPU-Image es nicht enthaelt. Waeren die Annotationen Strings, suchte
# pydantic `UploadFile` bei den Modul-Globals, faende es dort nicht und
# brauchte bis zur ersten Anfrage nicht aufzufallen — der Fehler kaeme
# dann als 500 beim Hochladen, nicht beim Deployen.

# --------------------------------------------------------------- Stellwerk

#: Welche Karte — als Reihenfolge, nicht als einzelner Wunsch.
#:
#: L4 (Ada, 24 GB) steht vorn: htdemucs braucht wenig Speicher, und L4 liegt
#: beim Preis nah an T4, rechnet aber deutlich schneller. Dass eine Liste
#: dasteht und kein einzelner Name, hat einen gemessenen Grund — der erste
#: Lauf blieb in der Warteschlange haengen:
#:
#:     Function 'Separator.*' is waiting to be scheduled on a GPU_L4 worker.
#:
#: Eine serverlose GPU ist eben nicht immer sofort da. Mit einer Liste
#: nimmt Modal die naechste freie Karte, statt zu warten: A10G ist teurer
#: und schneller, T4 guenstiger und langsamer — beides besser als ein
#: Handy, das fuenf Minuten auf einen Balken schaut.
#:
#: Was in der Warteschlange steht, kostet nichts. Bezahlt wird erst, wenn
#: der Container laeuft.
GPU = ["L4", "A10G", "T4"]

#: Sekunden je Block, bevor etwas gemessen wurde.
#:
#: Ein Block sind feste 7,8 Sekunden Ton durch denselben Graphen — die
#: Arbeit ist also fuer jeden Block dieselbe, und genau deshalb laesst sich
#: ueberhaupt etwas hochrechnen. Was schwankt, ist die Karte: gemessen
#: 0,75 s je Block auf einer A10, rund 1,0 s auf einer T4. Der Wert hier
#: ist nur der Anfang fuer eine unbekannte Karte; danach steht in `tempo`,
#: was dieselbe Karte zuletzt gebraucht hat.
JE_BLOCK_VORGABE = 1.0

#: Was das Kodieren im Verhaeltnis zum Trennen kostet.
#:
#: Gemessen am zweiten Lauf: 9,1 s kodieren zu 42,6 s trennen. Der Anteil
#: haengt nicht an der Karte, sondern an den Kernen daneben — und der
#: Container bekommt davon reichlich (17 gezaehlt). Er steht hier, damit
#: die Restzeit nicht bei 100 % noch zehn Sekunden weiterlaeuft.
ANTEIL_KODIEREN = 0.21

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

#: Was eine Karte zuletzt je Block gebraucht hat — `{"NVIDIA A10": 0.75}`.
#:
#: Ueberlebt den Container, und das ist der Zweck: beim naechsten Lauf
#: steht die Restzeit schon beim ersten Block halbwegs richtig da, statt
#: erst ab dem dritten. Faellt der Eintrag weg, greift `JE_BLOCK_VORGABE` —
#: dann ist die Anzeige die ersten zwei Sekunden ungenau, mehr nicht.
tempo = modal.Dict.from_name("mixapart-tempo", create_if_missing=True)

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
        # Welche Karte es geworden ist, steht nicht fest: `GPU` ist eine
        # Liste, und Modal nimmt die naechste freie. Fuer die Messung macht
        # das einen Unterschied von Faktor zwei, also wird sie benannt.
        self.karte = karte_lesen()
        # Die Zahl der Kerne steht hier, weil das Kodieren darauf laeuft
        # und beim ersten Lauf zwei Drittel so lange brauchte wie das
        # Trennen selbst. Sind es zu wenige, hilft `cpu=` an `@app.cls`.
        import os

        print(
            f"Sitzung steht auf {got[0]} ({self.karte}), "
            f"{os.cpu_count()} Kerne, Spuren: {self.meta.sources}"
        )

    @modal.method()
    def trennen(self, job: str, audio: bytes, suffix: str) -> dict:
        """Ein Song. Schreibt die Spuren ins Volume, gibt die Liste zurueck."""
        import time

        import numpy as np

        def setze(**felder) -> None:
            """Fortschritt fortschreiben — zusammenfuehren, nicht ersetzen.

            In demselben Eintrag stehen die Kennung des Rufs und der
            Zeitpunkt, und die hat die Web-Seite beim Annehmen
            hineingelegt.
            """
            stand = progress.get(job) or {}
            stand.update(felder)
            progress[job] = stand

        # Der Abschnitt sagt, worauf gerade gewartet wird, und das ist keine
        # Zierde. Bis hierher stand `angenommen` — und das heisst eben nicht
        # nur „gleich geht es los", sondern kann auch heissen, dass Modal
        # noch keine freie Karte hat. Ohne diese Unterscheidung sieht das
        # Geraet einen Balken bei null und kann nicht wissen, ob etwas haengt.
        setze(phase="dekodieren")
        started = time.monotonic()
        mix = decode(audio, suffix, self.meta.sample_rate)
        seconds = mix.shape[1] / self.meta.sample_rate
        if seconds > MAX_SECONDS:
            raise ValueError(
                f"{seconds / 60:.1f} Minuten sind mehr als die erlaubten "
                f"{MAX_SECONDS // 60}."
            )
        decoded = time.monotonic()

        # Wie lange ein Block auf *dieser* Karte braucht. Der Wert aus
        # frueheren Laeufen ist nur der Anfangswert — ab dem dritten Block
        # steht die Messung an seiner Stelle. Siehe `JE_BLOCK_VORGABE`.
        je_block = float(tempo.get(self.karte) or JE_BLOCK_VORGABE)
        bloecke_gesamt = 0
        setze(phase="trennen", karte=self.karte, prozent=2)

        def auf_block(block: int, bloecke: int) -> None:
            """Nach jedem Block: Prozent und Restzeit neu rechnen.

            Beides laesst sich hier ehrlich sagen, weil jeder Block
            dieselbe Arbeit ist — feste 7,8 Sekunden Ton durch denselben
            Graphen. Die Restzeit ist deshalb keine Schaetzung ins Blaue,
            sondern eine Hochrechnung aus gemessenen Bloecken.
            """
            nonlocal je_block, bloecke_gesamt
            bloecke_gesamt = bloecke
            gelaufen = time.monotonic() - decoded
            # Der erste Block ist der langsamste: darin uebersetzt CUDA
            # noch Kernel. Ihn als Massstab zu nehmen, hiesse die Restzeit
            # zu hoch anzusetzen und sie dann die ganze Zeit zu
            # unterbieten — ein Balken, der immer schneller wird, ist
            # genauso unehrlich wie einer, der haengt.
            if block >= 3:
                je_block = gelaufen / block
            rest_trennen = max(bloecke - block, 0) * je_block
            rest_kodieren = bloecke * je_block * ANTEIL_KODIEREN
            ganz = (decoded - started) + bloecke * je_block * (1 + ANTEIL_KODIEREN)
            fertig_anteil = ((decoded - started) + gelaufen) / max(ganz, 1e-6)
            setze(
                block=block,
                blocks=bloecke,
                prozent=min(round(fertig_anteil * 100), 99),
                rest=round(rest_trennen + rest_kodieren),
            )

        out = self.ref.separate(self.session, mix, self.meta, on_block=auf_block)
        separated = time.monotonic()
        setze(phase="kodieren", prozent=max(100 - round(ANTEIL_KODIEREN * 100), 85))

        # Was dieser Lauf ueber die Karte gelernt hat, bleibt fuer den
        # naechsten liegen — gleitend, damit ein einzelner Ausreisser die
        # Schaetzung nicht verreisst. Davon lebt die Restzeit *vor* dem
        # dritten Block: ohne diesen Wert stuende dort die Vorgabe, und die
        # stimmt je nach Karte um Faktor zwei nicht.
        if bloecke_gesamt:
            gemessen = (separated - decoded) / bloecke_gesamt
            vorher = float(tempo.get(self.karte) or gemessen)
            tempo[self.karte] = 0.7 * vorher + 0.3 * gemessen

        ziel = pathlib.Path(RESULT_DIR) / job
        ziel.mkdir(parents=True, exist_ok=True)

        # Die vier Spuren nebeneinander kodieren, nicht nacheinander.
        #
        # Gemessen am ersten echten Lauf: trennen 47,2 s, kodieren 32,2 s.
        # Zwei Drittel der Kodierzeit lagen also auf einer Karte, die
        # dabei nichts tat — und bezahlt wird die Laufzeit des Containers,
        # nicht die Auslastung der GPU. Vier ffmpeg-Prozesse warten
        # ausserhalb des Interpreters, der GIL steht dem also nicht im Weg.
        from concurrent.futures import ThreadPoolExecutor

        def eine(index_und_slug):
            index, slug = index_und_slug
            data = encode(np.asarray(out[index]), self.meta.sample_rate)
            (ziel / f"{slug}.{STEM_FORMAT}").write_bytes(data)
            return {
                "slug": slug,
                "label": STEM_LABELS.get(slug, slug),
                "bytes": len(data),
                "url": f"/stem/{job}/{slug}",
            }

        with ThreadPoolExecutor(max_workers=len(self.meta.sources)) as gleichzeitig:
            stems = list(gleichzeitig.map(eine, enumerate(self.meta.sources)))
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


def karte_lesen() -> str:
    """Welche Grafikkarte der Container bekommen hat.

    Ueber `nvidia-smi`, weil onnxruntime den Namen nicht hergibt. Schlaegt
    es fehl, ist das kein Grund abzubrechen — der Name ist eine Auskunft,
    kein Rechenweg. Dass ueberhaupt auf einer Karte gerechnet wird, hat
    `start` da schon anders geprueft.
    """
    import subprocess

    try:
        fertig = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        return fertig.stdout.strip().splitlines()[0].strip() or "unbekannt"
    except Exception:
        return "unbekannt"


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
        progress[job] = {
            "ruf": ruf.object_id,
            "start": time.time(),
            # `angenommen` heisst: der Auftrag liegt bei Modal und wartet
            # auf einen Container — moeglicherweise auf eine freie Karte.
            # Der GPU-Container schreibt den Abschnitt weiter, sobald er
            # laeuft.
            "phase": "angenommen",
            "block": 0,
            "blocks": 0,
        }
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
                "phase": stand.get("phase", "angenommen"),
                "karte": stand.get("karte", ""),
                "wartet": round(time.time() - stand.get("start", time.time())),
                "block": stand.get("block", 0),
                "blocks": stand.get("blocks", 0),
                # Beide fehlen absichtlich, solange nichts gemessen ist:
                # `null` heisst „unbekannt" und laesst sich in der
                # Oberflaeche als unbestimmter Balken zeigen. Eine
                # erfundene Null waere das Gegenteil davon — sie saehe aus
                # wie eine Aussage.
                "prozent": stand.get("prozent"),
                "rest": stand.get("rest"),
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
        """Lebenszeichen — und das, was die Oberflaeche vorher wissen will.

        `sekunden_je_minute` ist der Grund fuer diese Route. Das Geraet
        kennt die Laenge des Liedes, bevor es irgendetwas hochlaedt: es hat
        die Datei ja vorliegen. Damit laesst sich schon beim Auswaehlen
        sagen „das dauert etwa eine Minute", statt den Menschen erst nach
        dem Upload vor einen Balken bei null zu setzen.

        Die Zahl ist gemessen, nicht geraten — sie kommt aus `tempo`, also
        aus den Laeufen, die wirklich stattgefunden haben. Ist dort noch
        nichts, steht die Vorgabe da; dann ist sie eben grob.

        Was sie **nicht** enthaelt, ist die Wartezeit auf eine freie Karte.
        Die ist nicht vorhersagbar, und sie in eine Schaetzung zu mischen
        hiesse, eine Zahl auszugeben, die regelmaessig falsch ist.
        """
        gemessen = [float(w) for w in tempo.values() if isinstance(w, (int, float))]
        je_block = sum(gemessen) / len(gemessen) if gemessen else JE_BLOCK_VORGABE
        # Ein Block deckt `segment` Abtastwerte ab, die Bloecke ueberlappen
        # sich um ein Viertel — auf eine Minute Musik kommen also gut zehn.
        bloecke_je_minute = 60 * 44100 / (0.75 * 343980)
        return {
            "ok": True,
            "format": STEM_FORMAT,
            "gpu": GPU,
            "sekunden_je_minute": round(
                bloecke_je_minute * je_block * (1 + ANTEIL_KODIEREN), 1
            ),
            "gemessen": bool(gemessen),
        }

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
