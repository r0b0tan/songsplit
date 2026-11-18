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

#: Wie viele Minuten Ton der Endpunkt an einem Tag trennt.
#:
#: Der eigentliche Deckel gegen die Rechnung — und er musste sein, weil es
#: keinen anderen gibt: Budgets dokumentiert Modal erst ab dem Team-Plan,
#: nach dem Aufbrauchen des Freikontingents laeuft die Abrechnung weiter,
#: und eine eingebaute Ratenbegrenzung fuer Web-Endpunkte gibt es nicht.
#:
#: `MAX_CONTAINERS` begrenzt nur die Gleichzeitigkeit, nicht die Summe:
#: zwei Container durchgehend auf einer A10G sind rund 2,20 $/h, also gut
#: 50 $ am Tag — das Monatsguthaben waere in vierzehn Stunden fort.
#:
#: Gezaehlt werden **Tonminuten und nicht Auftraege**, weil die Kosten
#: daran haengen und nicht an der Zahl der Dateien. Ein erster Versuch mit
#: vierzig Auftraegen taeglich sah vernuenftig aus und war es nicht:
#: vierzig mal zwoelf Minuten sind acht Stunden Ton, rund 3 $ am Tag und
#: damit fast das Dreifache des Freikontingents.
#:
#: 150 Minuten sind bei gemessenen 11 s Rechenzeit je Tonminute rund eine
#: halbe Stunde GPU, also etwa ein Dollar — und damit ungefaehr die 30 $
#: im Monat. Wer mehr braucht, hebt die Zahl bewusst und mit Blick auf die
#: Rechnung.
MAX_AUDIO_MINUTES_PER_DAY = 150

#: Obergrenze fuer gleichzeitige Container. Begrenzt die Wartezeit, nicht
#: die Summe — siehe `MAX_AUDIO_MINUTES_PER_DAY`.
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

#: Megabyte je Tonminute, zum **Vorbuchen** beim Annehmen.
#:
#: Der Deckel hat bis hierher erst gezaehlt, wenn der GPU-Container die
#: echte Laenge kannte — also nach dem Dekodieren. Bis dahin sah jede
#: gleichzeitig eintreffende Anfrage denselben Zaehlstand, und bei
#: `@modal.concurrent(max_inputs=20)` heisst das: zwanzig Zwoelfminueter
#: kommen an einem 150-Minuten-Deckel vorbei, bevor er das erste Mal
#: steigt. Nachgerechnet sind das 240 Minuten statt 150.
#:
#: Also wird beim Annehmen eine Schaetzung gebucht und im Container durch
#: den echten Wert ersetzt. Geschaetzt wird aus der Dateigroesse, und
#: zwar bewusst **nach oben**: wer zu wenig bucht, hat den Deckel wieder
#: nicht. Die Zahlen sind die uebliche Untergrenze je Format — 128 kbit/s
#: fuer verlustbehaftetes, 16 bit/44,1 kHz Stereo fuer WAV.
#:
#: Die Schaetzung kann grob danebenliegen; gedeckelt ist sie durch
#: `MAX_SECONDS`, denn laenger nimmt der Container ohnehin nichts an. Mehr
#: als die Hoechstdauer eines Auftrags kann also nie vorgebucht werden.
MB_JE_MINUTE = {
    ".wav": 10.1,
    ".flac": 5.0,
    ".mp3": 0.96,
    ".m4a": 0.96,
    ".ogg": 0.96,
    ".opus": 0.96,
}
MB_JE_MINUTE_VORGABE = 0.96

#: Wie viele Auftraege eine Herkunft je Stunde aufgeben darf.
#:
#: Das ist eine Bremse und keine Zusage, und der Unterschied gehoert
#: hierhin: die Herkunft kommt aus `X-Forwarded-For`, und diese Kopfzeile
#: kann ein Aufrufer selbst setzen. Wer das weiss, umgeht die Bremse mit
#: einer Zeile. Was sie wirklich leistet, ist das Haeufigere: eine
#: Oberflaeche, die sich in einer Schleife verrennt, und einen Neugierigen
#: mit dem Token aus dem Quelltext. Was den Deckel **traegt**, ist das
#: Vorbuchen oben.
MAX_AUFTRAEGE_JE_IP_STUNDE = 6

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

#: Wie viele Minuten Ton heute getrennt wurden — `{"2026-11-17": 42.5}`.
#:
#: Ein Dict und keine Datenbank: gezaehlt wird grob, nicht buchhalterisch.
#: Zwei Anfragen in derselben Millisekunde koennen sich einen Zaehlstand
#: teilen, und das ist in Ordnung — es geht um die Groessenordnung.
#:
#: Fortgeschrieben wird im GPU-Container, wo die echte Laenge bekannt ist;
#: geprueft wird beim Annehmen. Die Pruefung hinkt damit um den gerade
#: laufenden Auftrag hinterher. Bei einem Deckel, der eine Groessenordnung
#: halten soll, ist das kein Fehler, sondern der Preis dafuer, nicht raten
#: zu muessen.
budget = modal.Dict.from_name("mixapart-budget", create_if_missing=True)

#: Was eine Karte zuletzt je Block gebraucht hat — `{"NVIDIA A10": 0.75}`.
#:
#: Ueberlebt den Container, und das ist der Zweck: beim naechsten Lauf
#: steht die Restzeit schon beim ersten Block halbwegs richtig da, statt
#: erst ab dem dritten. Faellt der Eintrag weg, greift `JE_BLOCK_VORGABE` —
#: dann ist die Anzeige die ersten zwei Sekunden ungenau, mehr nicht.
tempo = modal.Dict.from_name("mixapart-tempo", create_if_missing=True)

#: Wie viele Auftraege eine Herkunft in dieser Stunde aufgegeben hat —
#: `{"203.0.113.9:2026-11-18T14": 3}`. Der Aufraeumlauf wirft die alten weg.
ip_zaehler = modal.Dict.from_name("mixapart-ip", create_if_missing=True)

#: Der eigene Token. `modal secret create mixapart-token MIXAPART_TOKEN=...`
token = modal.Secret.from_name("mixapart-token")

#: Welche Fassung dieser Datei laeuft — die ersten zwoelf Stellen ihrer
#: Pruefsumme, von `/health` genannt.
#:
#: Der Grund steht im Audit vom 17.11.2026: der Endpunkt lief wochenlang
#: mit einer aelteren Fassung als dem Repo, und gemerkt hat es niemand,
#: weil nichts danach fragte. Die nginx-Kopfzeilen und die CSP gegen
#: `cloud.json` prueft `deploy.sh` seither von aussen; hier fehlte das
#: Gegenstueck.
#:
#: Gehasht wird die Quelldatei selbst, und zwar beim Import — also lokal
#: beim `modal deploy` **und** im Container beim Start. Beide lesen
#: dieselbe hochgeladene Datei, die Werte muessen also uebereinstimmen.
#: `./deploy.sh check-cloud` vergleicht den lokalen mit dem gemeldeten.
#:
#: Faellt das Lesen aus, steht `unbekannt` da und sonst nichts: eine
#: Auskunft ueber die Fassung darf den Dienst nicht am Starten hindern.
def _fassung() -> str:
    import hashlib

    try:
        return hashlib.sha256(
            pathlib.Path(__file__).resolve().read_bytes()
        ).hexdigest()[:12]
    except Exception:
        return "unbekannt"


FASSUNG = _fassung()


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
    def trennen(
        self,
        job: str,
        audio: bytes,
        suffix: str,
        geschaetzt: float = 0.0,
        gebucht_am: str = "",
    ) -> dict:
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

        # Das Tageskontingent berichtigen, sobald die echte Laenge
        # feststeht — vor dem Trennen und nicht danach, damit ein Abbruch
        # mittendrin nicht umsonst gerechnete Minuten verschenkt.
        #
        # Berichtigen und nicht addieren: die Web-Seite hat beim Annehmen
        # bereits `geschaetzt` gebucht (siehe `separate`). Hier wird die
        # Differenz nachgetragen — meist nach unten, denn geschaetzt wird
        # absichtlich zu hoch. Faellt `geschaetzt` weg, etwa bei einem
        # Auftrag, der noch von der vorigen Fassung in der Schlange lag,
        # ist die Differenz die volle Laenge und es stimmt trotzdem.
        #
        # Berichtigt wird der Tag, auf den **gebucht** wurde, nicht der
        # heutige. Ein Auftrag kurz vor Mitternacht laeuft sonst auf dem
        # einen Tag auf und wird vom anderen abgezogen; stehen bliebe
        # eine Schaetzung, die niemand mehr einholt.
        tag = gebucht_am or time.strftime("%Y-%m-%d")
        budget[tag] = max(
            float(budget.get(tag) or 0.0) + seconds / 60 - geschaetzt, 0.0
        )

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


def ohne_pfade(text: str) -> str:
    """Absolute Pfade aus einer Meldung nehmen, die nach draussen geht.

    ffmpeg nennt die Datei, an der es gescheitert ist, und das ist hier
    `/tmp/tmpab12cd34.mp3` — der Pfad im Container. Nach aussen gehoert er
    nicht: er sagt dem Aufrufer nichts ueber seine Datei und dem
    Neugierigen etwas ueber den Aufbau dahinter. Was bleibt, ist der Grund,
    und der ist das Einzige, was jemand brauchen kann.

    Im Protokoll des Containers steht die vollstaendige Meldung weiter —
    siehe die Aufrufer. Weggenommen wird sie nur dem, der sie nicht
    gebraucht haette.
    """
    import re

    return re.sub(r"/(?:[\w.+-]+/)*[\w.+-]+", "<datei>", text)


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
        meldung = fertig.stderr.decode("utf-8", "replace").strip()
        # Vollstaendig ins Protokoll, gekuerzt und ohne Pfade nach aussen.
        print(f"ffmpeg scheiterte an der Eingabe: {meldung}")
        raise ValueError(
            "Die Datei liess sich nicht lesen: "
            + ohne_pfade(meldung.splitlines()[-1] if meldung else "kein Grund genannt")[:200]
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
    from fastapi.responses import FileResponse, JSONResponse
    from modal.exception import OutputExpiredError

    ERLAUBTE_SUFFIXE = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"}
    JOB_MUSTER = re.compile(r"^[0-9a-f]{16}$")
    SLUG_MUSTER = re.compile(r"^[a-z]{3,10}$")

    web = FastAPI(title="mixapart", docs_url=None, redoc_url=None)

    class Torwaechter:
        """Ausweis und Groesse pruefen, bevor der Body gelesen wird.

        Dass `pruefe()` als erste Zeile im Handler steht, reicht nicht.
        FastAPI liest den Body in `get_request_handler`, **bevor** es die
        Abhaengigkeiten aufloest — also bevor eine Zeile des Handlers
        laeuft. Gemessen an genau diesem Endpunkt: 2 MB ohne Token gingen
        vollstaendig durch, erst danach kam die 401.

        Dasselbe gilt fuer `MAX_UPLOAD_BYTES`. Die Leseschleife in
        `separate` begrenzt, was in `teile` landet, nicht, was ankommt:
        python-multipart hat die Datei da schon entgegengenommen und ab
        einem Megabyte auf die Platte gespoolt.

        Ohne diese Schicht ist der Endpunkt fuer jeden ohne Token ein
        offener Eimer — Bandbreite, Spool-Platz und Multipart-CPU im
        Web-Container, ohne Grenze und ohne Ausweis. Der Token schuetzt
        die GPU-Minuten, aber nicht den Container davor.

        Reines ASGI und keine `BaseHTTPMiddleware`: die fasst den Body an,
        und genau das soll hier unterbleiben. `receive` wird nie
        aufgerufen, der Upload bricht ab. Dasselbe Muster steht als
        `LocalGuard` in `backend/app/main.py`.
        """

        #: Was ohne Ausweis beantwortet wird. `/health` sagt der
        #: Oberflaeche, ob es den Weg gibt und wie lange er dauert — das
        #: muss sie wissen koennen, bevor jemand eine Datei auswaehlt.
        OHNE_TOKEN = frozenset({"/health"})

        #: Der Umschlag um die Datei: Grenzzeilen, Feldname, Dateiname,
        #: Content-Type. Ein paar hundert Byte, grosszuegig gerechnet.
        UMSCHLAG = 64 * 1024

        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            pfad = scope.get("path", "").rstrip("/") or "/"
            kopf = dict(scope.get("headers") or ())

            if pfad not in self.OHNE_TOKEN:
                gegeben = kopf.get(b"x-mixapart-token", b"").decode("latin-1")
                erwartet = os.environ["MIXAPART_TOKEN"]
                if not gegeben or not pysecrets.compare_digest(gegeben, erwartet):
                    await self._absage(
                        401, "Token fehlt oder stimmt nicht.", scope, receive, send
                    )
                    return

            if scope.get("method") in {"POST", "PUT", "PATCH"}:
                roh = kopf.get(b"content-length")
                if roh is None:
                    # Ohne angekuendigte Laenge laesst sich vorher nichts
                    # pruefen, und hinterher ist die Datei schon da. Jeder
                    # Browser und jedes curl setzen die Kopfzeile bei einem
                    # Datei-Upload; wer sie weglaesst, bekommt eine Ansage
                    # statt einer offenen Leitung.
                    await self._absage(
                        411, "Content-Length fehlt.", scope, receive, send
                    )
                    return
                try:
                    laenge = int(roh)
                except ValueError:
                    await self._absage(
                        400, "Content-Length ist keine Zahl.", scope, receive, send
                    )
                    return
                if laenge > MAX_UPLOAD_BYTES + self.UMSCHLAG:
                    await self._absage(
                        413,
                        f"Hoechstens {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
                        scope, receive, send,
                    )
                    return

                # Die Bremse gilt nur fuer neue Auftraege. `/status` wird
                # waehrend einer Trennung im Sekundentakt gefragt — eine
                # Zaehlung darauf wuerde den eigenen Fortschrittsbalken
                # abwuergen.
                if pfad == "/separate" and not self._darf_noch(kopf, scope):
                    await self._absage(
                        429,
                        "Zu viele Trennungen in kurzer Zeit. Bitte später "
                        "noch einmal — oder auf einem Rechner mit "
                        "Grafikkarte sofort.",
                        scope, receive, send,
                    )
                    return

            await self.app(scope, receive, send)

        @staticmethod
        def _darf_noch(kopf, scope) -> bool:
            """Zaehlt die Auftraege einer Herkunft in dieser Stunde.

            Die Herkunft steht in `X-Forwarded-For`, erster Eintrag; ohne
            die Kopfzeile nimmt es die Gegenstelle aus dem Scope. Dass ein
            Aufrufer sich die Kopfzeile selbst ausdenken kann, ist bekannt
            und steht bei `MAX_AUFTRAEGE_JE_IP_STUNDE` — das hier ist eine
            Bremse gegen Schleifen und Neugier, kein Schutzwall.

            Faellt das Zaehlwerk aus, wird durchgelassen. Eine Bremse, die
            bei einer Stoerung im Dict den ganzen Dienst anhaelt, waere
            schlimmer als die Last, vor der sie schuetzt.
            """
            roh = kopf.get(b"x-forwarded-for", b"").decode("latin-1")
            herkunft = roh.split(",")[0].strip() or (
                (scope.get("client") or ("unbekannt",))[0]
            )
            schluessel = f"{herkunft}:{time.strftime('%Y-%m-%dT%H')}"
            try:
                bisher = int(ip_zaehler.get(schluessel) or 0)
                if bisher >= MAX_AUFTRAEGE_JE_IP_STUNDE:
                    return False
                ip_zaehler[schluessel] = bisher + 1
            except Exception:
                return True
            return True

        @staticmethod
        async def _absage(status, detail, scope, receive, send):
            await JSONResponse({"detail": detail}, status_code=status)(
                scope, receive, send
            )

    # Zuletzt eingetragen heisst aeusserste Schicht. CORS steht deshalb
    # **nach** dem Torwaechter und laeuft damit vor ihm: so legt es seine
    # Kopfzeilen noch um eine Absage, und die Oberflaeche liest den Grund,
    # statt einen undurchsichtigen Netzwerkfehler zu sehen. Preflights
    # beantwortet CORS selbst; sie erreichen den Torwaechter nie.
    web.add_middleware(Torwaechter)
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

        Der `Torwaechter` prueft dasselbe schon vor dem Body, hier kommt
        also im Regelfall nichts mehr an. Stehen bleibt es trotzdem: eine
        Route, die ihren Ausweis selbst verlangt, bleibt richtig, auch
        wenn jemand die Schicht darueber einmal umbaut.
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

        # Vor dem Lesen der Datei: ein abgewiesener Auftrag soll keine
        # 25 MB durch die Leitung gezogen haben.
        heute = time.strftime("%Y-%m-%d")
        bisher = float(budget.get(heute) or 0.0)
        if bisher >= MAX_AUDIO_MINUTES_PER_DAY:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Für heute ist das Kontingent aufgebraucht — der Serverweg "
                    "ist kostenlos und deshalb gedeckelt. Morgen geht es weiter; "
                    "auf einem Rechner mit Grafikkarte sofort."
                ),
            )

        suffix = pathlib.PurePath(datei.filename or "").suffix.lower()
        if suffix not in ERLAUBTE_SUFFIXE:
            raise HTTPException(
                status_code=415,
                detail=f"{suffix or 'Ohne Endung'} wird nicht angenommen.",
            )

        # Stueckweise, aber ohne Illusion darueber, was das noch leistet:
        # die Datei ist an dieser Stelle laengst vollstaendig angenommen
        # (FastAPI liest den Body vor dem Handler). Begrenzt wird hier
        # also nur noch, was in `teile` und damit in den Aufruf wandert —
        # die Leitung schuetzt der `Torwaechter` ueber Content-Length,
        # bevor das erste Byte gelesen wird.
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

        # Vorbuchen, bevor gespawnt wird.
        #
        # Der Deckel oben hat den Zaehlstand gelesen, als dieser Auftrag
        # noch nichts darin stehen hatte — und so ging es jeder anderen
        # Anfrage derselben Sekunde auch. Erst mit dieser Buchung sieht
        # die naechste, dass hier schon etwas laeuft.
        #
        # Gebucht wird die Schaetzung aus der Dateigroesse, gedeckelt auf
        # die Hoechstdauer eines Auftrags. Im Container wird sie durch die
        # echte Laenge ersetzt (siehe `trennen`), die Schaetzung ist also
        # nur fuer die Dauer der Trennung im Weg — und in genau dieser
        # Zeit soll sie es auch sein.
        #
        # Bleibt die Korrektur aus, weil der Auftrag nie laeuft, bleibt
        # die Schaetzung bis Mitternacht stehen. Das ist die richtige
        # Richtung zum Irren: es wird zu wenig getrennt, nicht zu viel
        # bezahlt.
        geschaetzt = min(
            gelesen / (1024 * 1024) / MB_JE_MINUTE.get(suffix, MB_JE_MINUTE_VORGABE),
            MAX_SECONDS / 60,
        )
        budget[heute] = float(budget.get(heute) or 0.0) + geschaetzt

        job = pysecrets.token_hex(8)
        ruf = Separator().trennen.spawn(
            job, b"".join(teile), suffix, geschaetzt, heute
        )
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
            # Was Modal hier durchreicht, traegt gern den Rueckverfolgungspfad
            # des Containers mit — Dateinamen, Verzeichnisse, Zeilennummern.
            # Der Grund gehoert zum Aufrufer, der Pfad dorthin nicht.
            print(f"Auftrag {job} gescheitert: {fehler!r}")
            return {"zustand": "fehler", "grund": ohne_pfade(str(fehler))[:400]}
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
        heute = time.strftime("%Y-%m-%d")
        return {
            "ok": True,
            # Welche Fassung hier laeuft. Siehe `FASSUNG`: damit faellt
            # auf, wenn das Repo weitergegangen ist und der Endpunkt nicht
            # — `./deploy.sh check-cloud` vergleicht beides.
            "fassung": FASSUNG,
            "format": STEM_FORMAT,
            "gpu": GPU,
            "sekunden_je_minute": round(
                bloecke_je_minute * je_block * (1 + ANTEIL_KODIEREN), 1
            ),
            "gemessen": bool(gemessen),
            # Wie viele Trennungen heute noch gehen. Damit kann die
            # Oberflaeche absagen, bevor jemand 25 MB hochlaedt und erst
            # danach erfaehrt, dass nichts mehr frei ist.
            "frei_minuten_heute": round(
                max(MAX_AUDIO_MINUTES_PER_DAY - float(budget.get(heute) or 0.0), 0), 1
            ),
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
    # Tageszaehler aelter als eine Woche: der heutige und der gestrige
    # reichen, alles davor ist Ballast.
    behalten = {
        time.strftime("%Y-%m-%d", time.gmtime(time.time() - tage * 86400))
        for tage in range(2)
    }
    for tag in list(budget.keys()):
        if tag not in behalten:
            budget.pop(tag, None)
    # Die Stundenzaehler je Herkunft ebenso. Ihr Schluessel traegt die
    # Stunde im Klartext (`203.0.113.9:2026-11-18T14`), es genuegt also,
    # den Tagesteil gegen dieselbe Liste zu halten. Ohne das waechst das
    # Dict mit jedem Besucher und jeder Stunde weiter, und niemand sieht
    # jemals hinein.
    for schluessel in list(ip_zaehler.keys()):
        tag = str(schluessel).rsplit(":", 1)[-1].split("T")[0]
        if tag not in behalten:
            ip_zaehler.pop(schluessel, None)
    results.commit()
    print(f"{weg} Auftraege geloescht")
