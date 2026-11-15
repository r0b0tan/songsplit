# MixApart

Zerlegt eine Musikdatei in Stems und spielt die Spuren in einem Mix-Player
ab, mit Lautstärke, Mute, Solo und Pitch pro Spur, mit Mix-Tempo, A/B-Loop
und einem eigenen Tempo für die Spur, die man gerade übt.

Die Musik verlässt den Rechner nicht — in beiden Varianten, aus
verschiedenen Gründen.

```
backend/    FastAPI + audio-separator (Trennung auf CUDA, Jobs, Dateiausgabe)
frontend/   Angular + Signalsmith Stretch (Import, Jobs, Deck)
            und src/app/separate/: dieselbe Trennung im Browser, auf WebGPU
data/       pro Job ein Ordner: input/, stems/, job.json
models/     heruntergeladene Modellgewichte (ca. 84 MB je Demucs-Modell)
```

---

> **Zum Aufsetzen und Loslegen: [ANLEITUNG.md](ANLEITUNG.md).** Diese Datei
> hier ist ein Arbeitsjournal — sie begründet die Entscheidungen, nennt die
> Messwerte und die Fallstricke. Wer das Projekt nur zum Laufen bringen
> will, ist dort schneller.

## Zwei Varianten

| | **lokal** | **öffentlich** |
|---|---|---|
| Trennung | Python, `audio-separator`, CUDA | Browser, `onnxruntime-web`, WebGPU |
| Trennorte in der Oberfläche | Auswahlfeld mit „Browser“ **und** „Lokal“ | nur „Alles auf diesem Gerät“, ohne Wahl |
| Braucht | Python, FFmpeg, NVIDIA-Treiber | einen Browser mit WebGPU |
| Verlauf | überlebt den Neustart (`data/*/job.json`) | gilt für die Sitzung |
| Bauen | `npm run build` | `npm run build:public` |
| Ausliefern | zwei Prozesse auf `127.0.0.1` | statische Dateien über HTTPS |

Beide benutzen **dasselbe Deck**, denselben Verlauf und dieselbe
Importkarte. Der Unterschied steckt in einer Datei
([`variant.ts`](frontend/src/app/core/variant.ts)), die der öffentliche Bau
gegen [`variant.public.ts`](frontend/src/app/core/variant.public.ts)
austauscht.

Der lokale Weg bleibt, und zwar nicht aus Nachsicht: er ist der
**Vergleichswert**. Dieselbe Datei einmal über CUDA und einmal über WebGPU
zu trennen ist die einzige Art, eine Behauptung über Geschwindigkeit oder
Klang zu prüfen, statt sie zu glauben. Wie nah die beiden Wege beieinander
liegen, steht unter [Gemessen](#gemessen).

Es gibt **keine Datenbank**, in keiner Variante. Jobs des Backends stehen
als `job.json` im jeweiligen Jobordner; Jobs des Browsers stehen im
Arbeitsspeicher des Tabs. PostgreSQL kommt im Projekt nicht vor.

Nicht gebaut und bewusst offen: Cloud mit eigenem API-Key und
fortschreitende Wiedergabe, also Hören, bevor die Trennung fertig ist.
Siehe [Offene Punkte](#offene-punkte).

---

## Voraussetzungen

| Werkzeug | Version | Hinweis |
|---|---|---|
| Python | 3.10 oder neuer, nicht 3.14.1 | `audio-separator` verlangt `>=3.10,!=3.14.1`. Geprüft mit 3.12.3. |
| Node.js | 20 oder neuer | Angular 22 verlangt eine aktuelle LTS. Geprüft mit 24.20.0. |
| FFmpeg | beliebig aktuell | Muss im `PATH` liegen. `audio-separator` liest MP3 darüber. |
| NVIDIA-Treiber | aktuell | Nur für den GPU-Modus. Geprüft mit Treiber 596.21 / CUDA 13.2. |

FFmpeg prüfen:

```powershell
ffmpeg -version
```

Fehlt es unter Windows: `winget install Gyan.FFmpeg`, danach ein neues
Terminal öffnen, damit der `PATH` greift.

---

## Installation

### In einem Rutsch

```bash
./install.sh            # Backend, Frontend, Runtime und Gewichte
./install.sh --cpu      # Torch ohne CUDA, spart rund 3 GB Download
./install.sh --check    # nur nachsehen, was fehlt — ändert nichts
./install.sh --force    # auch das neu machen, was schon da ist
```

Das Skript prüft die Werkzeuge, legt `.venv` an, installiert die
Abhängigkeiten, holt die Demucs-Gewichte, installiert die npm-Pakete,
vendoriert die ONNX-Runtime und exportiert beide Modelle nach ONNX. Es
läuft mehrfach ohne Schaden: was schon da ist, wird übersprungen — und
gefragt wird dabei die Umgebung selbst, nicht ein Merkzettel daneben. Eine
Datei, die „installiert" behauptet, kann richtig liegen und trotzdem falsch
sein; ein `import torch` kann das nicht.

**Zwei Dinge liegen nicht im Repo** und entstehen erst hier: die
exportierten Modellgewichte (289 MB) und die vendorierte ONNX-Runtime
(29 MB). Beides ist erzeugtes Beiwerk, und Git legt jede Fassung einer
Binärdatei ganz ab, ohne je eine zu vergessen — ein Satz Gewichte kostet
gepackt rund 172 MB, und jeder neue Export kostet dieselbe Summe noch
einmal, dauerhaft. So wiegt der Klon **1,2 MB** statt 320 MB. Die
Begründung steht auch in `.gitignore`, damit niemand die Zeilen für ein
Versehen hält.

Was dabei herauskommt, ist dasselbe wie zuvor und nicht nur ungefähr: die
Runtime wird aus `node_modules` kopiert, deren Version in `package.json`
exakt festgelegt ist, und der Export vergleicht sich Wert für Wert gegen
Torch, bevor er ein `manifest.json` schreibt.

Die folgenden Abschnitte beschreiben dieselben Schritte von Hand — für
den Fall, dass einer davon klemmt.

### Backend

**Windows (PowerShell), GPU-Variante:**

```powershell
cd backend
py -3.12 -m venv ..\.venv
..\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
```

**CPU-Variante** (spart rund 3 GB Download, kein CUDA-Torch):

```powershell
pip install -r requirements-cpu.txt
```

**Linux / WSL2:**

```bash
cd backend
python3 -m venv ../.venv
../.venv/bin/pip install --upgrade pip
../.venv/bin/pip install -r requirements.txt     # oder requirements-cpu.txt
```

Der GPU-Download ist groß: PyTorch mit CUDA plus die NVIDIA-Bibliotheken
sind zusammen etwa 3 GB.

> **Zu `requirements.txt`:** `audio-separator` 0.48.0 importiert `audioread`,
> deklariert es aber nicht als Abhängigkeit. Ohne die ausdrückliche Zeile
> scheitert schon der Import mit
> `ModuleNotFoundError: No module named 'audioread'`. Die Zeile steht deshalb
> fest in beiden Anforderungsdateien.

### Modellkonfigurationen holen

Pro Demucs-Modell lädt `audio-separator` zwei Dateien: die Gewichte (rund
84 MB, von `dl.fbaipublicfiles.com`) und eine winzige YAML-Konfiguration
(von einem GitHub-Release-Asset). Der YAML-Abruf schlägt in manchen Netzen
mit HTTP 504 fehl, während alles andere läuft. Dieses Skript probiert
nacheinander beide GitHub-Spiegel und zuletzt das Demucs-Repo selbst:

```powershell
python tools\fetch_model_configs.py              # alle Modelle
python tools\fetch_model_configs.py htdemucs_ft  # nur dieses
```

Es holt auch die Gewichte, nicht nur die Konfigurationen, und sagt zu jeder
Datei, aus welcher Quelle sie kam oder woran es scheiterte. Die Oberfläche
zeigt pro Modell an, ob alle Dateien bereitliegen.

Es ist optional. Läuft der Download ohnehin durch, holt `audio-separator`
die Dateien beim ersten Job selbst. Vorhandene Dateien werden nie
überschrieben.

### Frontend

```powershell
cd frontend
npm install
```

**Zwei Schritte fehlen danach noch**, weil ihr Ergebnis nicht im Repo
liegt (siehe [In einem Rutsch](#in-einem-rutsch)): die ONNX-Runtime
vendorieren und die Modelle exportieren.

```bash
npm run vendor:ort                                        # im frontend/
cd ../backend
../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs
../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs_6s
```

Ohne den Export hat ein frischer Klon `frontend/public/models/` gar nicht,
und die Importkarte sagt „Kein Trennmodus" — samt dem Befehl, der fehlt.

Signalsmith Stretch 1.3.2 liegt bereits unverändert unter
`frontend/public/vendor/` und wird nicht über npm bezogen (siehe
[Warum die Bibliothek vendoriert ist](#warum-die-bibliothek-vendoriert-ist)).

Die Zeichen der Oberfläche stammen aus [Lucide](https://lucide.dev) (ISC).
Nicht als Abhängigkeit zur Laufzeit: `node tools/icons.mjs` holt die gut
zwei Dutzend gebrauchten Zeichen aus `lucide-static` und schreibt sie nach
`src/app/core/icons.ts`. Wer ein weiteres braucht, trägt den Namen im
Skript ein und lässt es laufen; das Paket selbst bleibt eine reine
Entwicklungsabhängigkeit.

Das Zeichen der App steht als `frontend/public/mixapart.svg` und ist die
einzige Quelle. `favicon.ico` (16, 32, 48) und `apple-touch-icon.png` (180)
sind daraus gerechnet und liegen fertig daneben; wer das Zeichen ändert,
ändert die SVG und lässt `node tools/favicon.mjs` noch einmal laufen. Das
Skript zeichnet mit demselben Chromium, der auch die Tests fährt.

Beim Teilen zeigt die Seite `frontend/public/mixapart-share.webp` (1734 ×
907) — eingetragen als `og:image` und `twitter:image` in
`frontend/src/index.html`. Die Pfade stehen dort relativ, weil die Seite
örtlich läuft; unter einer Domain gehört die vollständige URL hinein.

---

## Starten

### Kurzfassung

```bash
# einmalig nach dem Klonen (siehe Installation)
./install.sh

# lokale Variante — Backend und Oberfläche
./start.sh                      # dann http://127.0.0.1:4200

# öffentliche Variante — nur die Oberfläche, kein Backend
./start.sh --public                       # dann http://127.0.0.1:4200
cd frontend && npm run start:public       # dasselbe von Hand

# öffentliche Variante bauen (statische Dateien)
cd frontend && npm run build:public       # dist/mixapart-public/browser/

# lokale Variante bauen
cd frontend && npm run build              # dist/mixapart/browser/
```

Der öffentliche Bau ist eine Sammlung gewöhnlicher Dateien ohne jede
Serverlogik: hochladen, über HTTPS ausliefern, fertig. Er braucht **keine**
besonderen Kopfzeilen. `SharedArrayBuffer` und damit mehrfädiges WASM wären
mit `Cross-Origin-Opener-Policy` und `Cross-Origin-Embedder-Policy` zu
haben; eingebaut ist das nicht, weil es nur den Rückfallweg beschleunigt
und jede eingebettete Fremdressource aussperrt.

Zu bedenken beim Ausliefern: der Bau ist **groß**. `dist/` wiegt 304 MiB,
davon sind 277 MiB die beiden ONNX-Exporte und 28 MiB die Runtime; der
Angular-Teil ist mit 296 kB nicht der Rede wert. Keine **einzelne** Datei
ist größer als 20 MiB — das ist Absicht, siehe
[Was ausgeliefert wird](#was-ausgeliefert-wird). Ein Besucher lädt davon
beim ersten Trennvorgang das Modell seiner Wahl (174 bzw. 115 MB) und die
Runtime (29 MB), danach nichts mehr — die Gewichte liegen in der Cache-API,
die Runtime im HTTP-Cache. Wer nur einen Modus anbieten will, löscht den
anderen Ordner unter `public/models/`; die Oberfläche zeigt dann nur noch
den vorhandenen.

### Die lokale Variante von Hand

Unter Linux und macOS reicht ein Terminal:

```bash
./start.sh            # Geraet automatisch, GPU wenn vorhanden
./start.sh --cpu      # CPU erzwingen
./start.sh --open     # danach den Browser oeffnen
```

Das Skript startet Backend und Frontend, wartet, bis beide antworten, und
nennt dann die Adresse. Die Ausgaben laufen mit den Kürzeln `api` und `web`
durch dasselbe Fenster und stehen vollständig in `.run/api.log` und
`.run/web.log`. Strg-C beendet beide. Läuft eines von beiden schon, wird es
mitbenutzt statt ein zweites Mal gestartet — und beim Beenden auch nicht
abgeschossen.

Von Hand, oder unter Windows, sind es zwei Terminals.

**Terminal 1, Backend** (GPU, sofern vorhanden):

```powershell
cd backend
..\.venv\Scripts\Activate.ps1
python run.py
```

**Terminal 2, Frontend:**

```powershell
cd frontend
npm start
```

Dann http://127.0.0.1:4200 öffnen. Der Angular-Dev-Server reicht `/api`
an `127.0.0.1:8000` weiter (`frontend/proxy.conf.json`), deshalb sind Seite
und Audiodateien gleicher Herkunft.

### GPU- und CPU-Start

| Start | Befehl |
|---|---|
| Automatisch (GPU, wenn verfügbar) | `python run.py` |
| CPU erzwingen | `$env:MIXAPART_DEVICE="cpu"; python run.py` |
| GPU verlangen | `$env:MIXAPART_DEVICE="cuda"; python run.py` |

Unter Linux entsprechend `MIXAPART_DEVICE=cpu python run.py`.

`audio-separator` 0.48.0 hat **keinen** Geräte-Parameter: es nimmt die GPU,
sobald `torch.cuda.is_available()` wahr ist. `MIXAPART_DEVICE=cpu` setzt
deshalb `CUDA_VISIBLE_DEVICES=""`, und zwar in `app/config.py`, bevor
irgendetwas `torch` importiert.

Wie es ausgegangen ist, steht in der Kopfleiste der Importkarte, als
Hinweis darunter und unter `GET /api/health`:

- **CUDA fehlt, war aber verlangt** → die Oberfläche meldet im Klartext, dass
  auf der CPU gerechnet wird und dass das deutlich langsamer ist.
- **Wenig freier VRAM** → unterhalb von 4,5 GB freiem Speicher erscheint eine
  Warnung. Die Demucs-Modelle belegen gemessen bis zu 1,2 GB, das
  Roformer-Modell bis zu 3,6 GB (siehe [Welches Modell](#welches-modell));
  die Schwelle richtet sich nach dem schwersten plus Reserve.
- **`CUDA out of memory` während eines Jobs** → der Job wird „Fehlgeschlagen"
  mit dem Hinweis, andere GPU-Programme zu schließen oder mit
  `MIXAPART_DEVICE=cpu` zu starten.

### Einstellungen

Alles über Umgebungsvariablen:

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `MIXAPART_DEVICE` | `auto` | `auto`, `cuda` oder `cpu` |
| `MIXAPART_DATA_DIR` | `./data` | Job-Ordner |
| `MIXAPART_MODEL_DIR` | `./models` | Modell-Cache |
| `MIXAPART_PORT` | `8000` | Port der API |
| `MIXAPART_HOST` | `127.0.0.1` | `run.py` verweigert jede andere Adresse |
| `MIXAPART_MAX_UPLOAD_MB` | `200` | Obergrenze je Datei |

---

## Bedienung

Die Seite ist eine Spalte von 780 px, keine Fläche über den ganzen Schirm:
die Importkarte, darunter der Verlauf. Oben in der Karte eine Leiste mit
Marke und rechts **„Modus" als Auswahlfeld** — „Browser" oder „Lokal" —
mit einem ⓘ daneben. Das Wort steht in der
Schriftfarbe, Feld und ⓘ in der Akzentfarbe: so ist auf einen Blick zu
sehen, was nur beschriftet und was anzufassen ist.
**Aufgeklappt steht in der Liste beides nebeneinander**, je Ort in zwei
leisen Zeilen: womit gerechnet wird und worauf — „WebGPU / nvidia ·
lovelace" gegen „CUDA / NVIDIA GeForce RTX 4070 Laptop GPU". Mehr nicht.
In einer Liste, in der man sich entscheidet, zählt der Unterschied, nicht
die Vollständigkeit; wer sich zwischen zwei Wegen entscheidet, braucht die
Fassungsnummer von PyTorch dafür nicht.

Das war früher eine Sprechblase hinter einem ⓘ, und die zeigte nur den
**gerade gewählten** Ort — wer vergleichen wollte, musste erst umschalten,
also genau das tun, worüber er sich noch nicht entschieden hatte. Jetzt
ist das ⓘ in der Liste aufgegangen.

**Die ausführlichen Angaben stehen im Trennfenster:** Rechenweg, Gerät,
freier Grafikspeicher, PyTorch und CUDA beim Backend; Grafikadapter,
Fassung der ONNX-Runtime und Modelle im Cache im Browser. Dort wartet man
ohnehin, und Wartezeit ist der einzige Moment, in dem fünf Zeilen Technik
niemanden aufhalten. Beide Fassungen — die kurze in der Liste und die
lange im Fenster — kommen aus `DeviceFacts` in
[`core/device-facts.ts`](frontend/src/app/core/device-facts.ts). Stünden
sie an zwei Stellen im Code, wäre die eine irgendwann aktuell und die
andere nicht, und es gäbe keinen Weg, das zu bemerken.

In der öffentlichen Variante gibt es keine Wahl und deshalb auch keine
Liste; dort steht der Satz „Alles auf diesem Gerät" und daneben das ⓘ mit
derselben Sprechblase wie zuvor — die Angaben müssen ja trotzdem irgendwo
stehen. Dass auf der CPU getrennt wird, geht damit nicht verloren: das
meldet das Backend als Hinweis, und Hinweise stehen unter der Karte, nicht
in einem Tooltip. Ebenso alles andere, was im Weg ist: keine Verbindung,
kein `audio-separator`, knapper VRAM, fehlende Grafikbeschleunigung.

**Import.** Aufbau und Maße folgen der Vorlage
`exampledata/mixapart-uploadmaske.zip` (die Vorlagen liegen nicht im Repo,
sie sind Entwurfsmaterial dieser Werkstatt): „01 / Import", eine große
Überschrift, darunter die Ablegefläche über die ganze Breite — 153 px hoch,
gestrichelt in gedämpfter Akzentfarbe, mit einem Schein in Pflaume und
einer Wellenform, die zur Mitte hin lauter wird. Datei darauf ziehen oder
hineinklicken; darunter ist sie ein gewöhnliches Dateifeld, Klick, Tastatur
und Ablegen funktionieren deshalb ohne eigenen Code. Liegt eine Datei
bereit, steht ihr Name darin. Was keine MP3 oder WAV ist, wird gar nicht
erst angenommen: `accept` filtert nur den Dateidialog, hineinziehen kann
man alles, und eine Zeile unter der Fußzeile sagt es sofort statt erst der
Server beim Hochladen.

**Der Trennort** steht oben in der Leiste, nicht als zwei große Karten
über dem Trennmodus. Er heißt dort „Modus"; das Wort kommt unten im
„Trennmodus" ein zweites Mal vor, meint dort aber das Modell und nicht den
Ort. Zwei Flächen zu gleichen Teilen waren zu viel Gewicht für eine Wahl,
die die meisten einmal treffen und dann nie wieder. Die Einträge der Liste
sind echte Optionsfelder in einer `radiogroup` — Pfeiltasten, Auswahl und
Vorlesesoftware kommen damit ohne eigenen Code zurecht. Escape klappt zu
und gibt den Fokus an den Knopf zurück, ein Zeigen daneben ebenfalls; ein
Fokuswechsel allein genügt dafür nicht, weil ein Tippen auf leere Fläche
den Fokus auf manchen Geräten gar nicht bewegt. Die Pfeiltasten auf dem
Knopf klappen auf und springen in die Liste — wer ein Auswahlfeld vor sich
sieht, probiert sie. Die
Vorgabe ist **auf diesem Gerät** — der Weg, der ohne Backend auskommt. Der
Wechsel zieht den Trennmodus mit: stünde er danach auf etwas, das es am
neuen Ort nicht gibt, wäre keine Karte markiert und der Knopf meldete einen
Fehler, den niemand verursacht hat.

Darunter der **Trennmodus** als Karte je Möglichkeit: im Browser
„Minimum", „Schnell" und „Instrumente", beim Backend dazu „Detailliert"
und „Nur Gesang". Jede Karte trägt ihren Namen und die Spurzahl, mehr
nicht. Angeboten wird nur, was am gewählten Ort wirklich da ist — nicht
ausgegraut, sondern gar nicht vorhanden. Gewählt wird damit ein Ergebnis,
kein Modellname: wer trennt, entscheidet zwischen Güte und Wartezeit,
nicht zwischen `htdemucs` und `htdemucs_ft`. Welches Modell dahinter
steckt, steht am fertigen Job.

Unter den Karten die Spuren des gewählten Modus, jede mit dem Farbstrich,
den sie später im Deck trägt. Die Karten sind echte Optionsfelder,
Pfeiltasten und Vorlesesoftware kommen damit ohne Zutun zurecht.

Eine Sprechblase an der Karte gab es zwischendurch, mit Modell, Spuren und
Downloadgröße. Sie ist wieder weg, weil jede ihrer drei Angaben woanders
besser steht: die **Spuren** farbig unter den Karten, die **Downloadgröße**
in der Rückfrage beim Start — also dann, wenn sie etwas ändert —, und das
**Modell** am Job. Ein Hinweis, der vorher nie gelesen wird, ist keiner.

**„Minimum" ist kein eigenes Modell.** Es ist derselbe Lauf wie „Schnell",
nur fallen Drums, Bass und Rest hinterher zu einer Spur „Begleitung"
zusammen — die Ausgaben von Demucs addieren sich zum Mix, die Summe ist
also genau „Mix ohne Gesang". Kein zweiter Download (derselbe Eintrag im
Cache), keine zusätzliche Rechenzeit außer dem Addieren, und halb so viel
im Arbeitsspeicher, **nachdem** der Lauf durch ist: 184 MB statt 368 bei
einem Lied von 4:33. Die Spitze *während* des Laufs ist dieselbe wie bei
„Schnell" — zusammengefasst wird erst, wenn alle vier Spuren da sind, und
addiert wird in den Puffer der ersten statt in einen neuen. „Minimum" ist
deshalb kein Ausweg bei knappem Speicher, sondern einer danach. Schneller
ist es ebenfalls **nicht** — gemessen liegt es im Rauschen, und die
Trennung selbst ist dieselbe. Es ist der Modus zum Mitspielen: zwei Regler
statt vier.

**Vor dem Start wird gerechnet, ob der Speicher reicht.** Getrennt wird im
Arbeitsspeicher der Sitzung, und damit ist die Länge des Liedes eine
Systemgrenze: eine Spur belegt 21 MB je Minute (44 100 Hz, Stereo,
Float32), und während des Laufs liegen die Spuren des Modells und die
dekodierte Eingabe gleichzeitig da. Vier Spuren eines Liedes von 4:33 sind
367 MB, mit Eingabe 459, mit Modell rund 859. Ein Zehnminüter mit sechs
Spuren wäre bei 2,3 GB.

Bis hierher lief jeder Start ungeprüft los. Ging er schief, starb der Tab
ohne Meldung — auf dem Rechner des Entwicklers fiel das nie auf, weil dort
genug da war. Jetzt liest [`decode.ts`](frontend/src/app/separate/decode.ts)
vor dem Start nur die Kopfdaten der Datei (ein `<audio>`-Element, ein paar
Kilobyte, kein Dekodieren), und
[`memory-budget.ts`](frontend/src/app/separate/memory-budget.ts) hält das
Ergebnis gegen `navigator.deviceMemory`. Drei Ausgänge:

| | |
|---|---|
| passt | nichts passiert, der Start läuft wie bisher |
| knapp | dieselbe Rückfrage wie beim Download — Zahl, Grund, Ja/Nein |
| aussichtslos | abgelehnt, mit der Länge, die hier noch ginge |

Dass die Größenordnung stimmt, steht schon weiter oben in der Tabelle des
lokalen Prüfstands: bei 368 MB Spuren wuchs der Browser-Prozess um 721 MB.
Die Abschätzung sagt für denselben Fall 859 MB — etwas zu viel, und das
ist die richtige Richtung. Wer knapp rechnet, verspricht einen Lauf, den
das Gerät nicht hält.

Zugetraut werden einem Tab 60 % dessen, was das Gerät meldet, abzüglich
400 MB für Gewichte und Runtime; gewarnt wird schon bei 60 % davon. Die
Zahlen sind eine Abschätzung, keine Messung — **kein Browser nennt die
Grenze eines Tabs.** Was sie leisten, ist die Unterscheidung zwischen
„geht", „kann knapp werden" und „wird nichts". Ein Lied von 4:33 läuft auf
8 GB ohne Frage durch, wird auf einem 2-GB-Telefon zur Rückfrage; zehn
Minuten werden dort abgelehnt, mit dem Hinweis, dass es bis 8:12 ginge.

Zwei Entwurfsentscheidungen dabei. **Gefragt wird vor dem Download**, nicht
danach: wer wegen der Länge abbricht, soll das tun können, bevor 174 MB
über seine Leitung gegangen sind. Und **wer nichts weiß, verbietet
nichts** — Firefox und Safari kennen `navigator.deviceMemory` nicht, dort
werden 4 GB angenommen statt das Schlimmste; lässt sich die Länge nicht
lesen, hält der Wächter sich ganz heraus. Ein Wächter, der seine Zahlen
nicht kennt, soll keinen Start verbieten, den er nicht beurteilen kann.

Geprüft wird das ohne Browser:
[`tests/memory/run.mjs`](frontend/tests/memory/run.mjs) bündelt das Modul
mit esbuild und täuscht Geräte vor — zwölf Prüfungen, darunter die, dass
die genannte Länge auch wirklich durchgeht.

**Die 174 MB werden erfragt, nicht angekündigt.** Dass der Browserpfad
beim ersten Lauf Modellgewichte lädt, stand früher als „Download nötig" an
der Karte und als gelber Kasten darunter — ein Dauerzustand für etwas, das
eine Folge des Startens ist. Jetzt fragt der Start: oben die Frage
(„174 MB Modellgewichte laden?"), darunter klein und grau, was sie nach
sich zieht — einmalig, bleibt im Cache, über Mobilfunk zählt es auf das
Datenvolumen —, dann „Nein" als stiller Text und „Ja" als Knopf. Escape und
ein Klick daneben zählen wie „Nein": das Teuerste darf nicht das sein, was
aus Versehen passiert. Gefragt wird einmal je Modus und Sitzung; ein
Abbruch mit zweitem Versuch fragt nicht noch einmal, denn da hat der Mensch
gerade bewiesen, dass er die Frage kennt. Der Backendpfad fragt nicht — er
lädt auf dem Server, nicht über die Leitung des Menschen.

Unten links „Testspuren anlegen" (was der Testpfad tut, steht im Tooltip und
unter [Testpfad](#testpfad)), unten rechts die Hauptaktion, die sagt, was
gleich passiert: „4 Spuren trennen".

**Vom Klick bis zum Üben ohne Zwischenstation.** „Trennen" legt den Job an
und öffnet das Fortschrittsfenster: Dateiname, Modell, Gerät, die laufende
Phase im Klartext und die verstrichene Zeit.

Einen **Prozentwert** gibt es nur dort, wo etwas gezählt wird. Beim Backend
also nicht: `audio-separator` liefert keinen, den man ehrlich umrechnen
könnte, und eine erfundene Zahl ist schlechter als eine Phase, die stimmt —
dort läuft ein Lauflicht. Auf dem Gerät schon: der Modelldownload kennt
seine Bytes, die Trennung ihre Blöcke, und beides sind **getrennte
Zustände**, weil man beim ersten Lauf auf 174 MB wartet und bei jedem
weiteren nicht mehr. Dort steht ein Balken, und darunter, woraus er kommt.
Abbrechen gibt es ebenfalls nur auf dem Gerät: der Python-Worker rechnet in
einem eigenen Prozess ohne Abbruchweg, und ein Knopf, der nichts tut, wäre
schlechter als keiner.

Ist die Trennung fertig, schließt sich
das Fenster von selbst und das Deck geht auf, mit den frisch getrennten
Spuren. Wer nicht zusehen will, schließt das Fenster: der Job läuft auf dem
Rechner weiter und steht danach im Verlauf. Schlägt die Trennung fehl,
bleibt das Fenster mit dem Grund stehen.

**Verlauf.** Eine Zeile je Job, nur durch eine Linie getrennt — keine
Karten in der Karte. Links ein Wellenzeichen, dann das Stück und darunter
Interpret, Trennmodus, Länge und Spurzahl; rechts der Knopf „Im Deck
öffnen" in der Akzentfarbe, mit Rahmen und dem Zeichen für „geht auf" —
die eine Handlung, um die es im Verlauf geht, und deshalb als Knopf
erkennbar und nicht als Haken neben einem Stück Text. Der Titel kommt aus dem Dateinamen, aber ohne das, was nicht
zum Stück gehört: „Yeah Yeah Yeahs - Heads Will Roll (Official Music Video)
[auzfTPp4moA].mp3" steht als **Heads Will Roll** da, mit „Yeah Yeah Yeahs"
in der Zeile darunter. Entfernt werden eckige Klammern und Klammerinhalte
aus einer festen Liste von Beiwerk („Official", „Lyrics", „4K", Jahreszahlen
…); „(Remix)" oder „(Live in Tokyo)" bleiben stehen, die gehören zum Stück.
Der vollständige Name steht im Tooltip der Zeile und überall sonst.

Läuft ein Job, steht statt des Hakens eine Uhr mit „läuft" oder „wartet",
und in der Zeile darunter die Phase im Klartext. Fehlgeschlagene Jobs
tragen den Grund an derselben Stelle, in Rot.

Der Verlauf zeigt **beide Trennorte in einer Liste**. Es ist derselbe Song
mit denselben Spuren; wer gestern lokal getrennt hat und heute auf dem
Gerät, will eine Liste sehen und nicht zwei. Sortiert wird nach der Zeit,
nicht nach dem Ort.

Ein Unterschied bleibt: Spuren vom Backend liegen auf der Platte und sind
morgen noch da, Spuren vom Gerät nur im Arbeitsspeicher dieser Sitzung.
Ist ein solches Ergebnis dem Budget gewichen, steht an der Stelle des
Knopfes **„Ergebnis nicht mehr im Speicher"** — der Job bleibt stehen,
damit man sieht, dass er lief, und im Tooltip steht, dass derselbe Song
erneut getrennt werden kann. Siehe
[Was im Speicher liegt](#was-im-speicher-liegt-und-wie-lange).

Die Reiter oben rechts trennen, was sich nicht vergleichen lässt: **Alle**,
**Songs** und **Testläufe**, jeweils mit Anzahl. Testläufe sammeln sich beim
Ausprobieren an und wären sonst die Mehrheit der Liste. Gezeigt werden sechs
Jobs je Seite, darunter blättert eine Leiste weiter; ein neuer Job holt die
Liste von selbst auf die erste Seite zurück, sonst schiene der Import nichts
getan zu haben.

Alles, was selten gebraucht wird, liegt hinter dem „…" am Zeilenende: jede
Spur einzeln als WAV speichern und den Job löschen. Löschen fragt erst nach
und löscht beim zweiten Klick — eine Trennung kostet Minuten und kommt nicht
zurück. Das „…" neben den Reitern räumt auf, und zwar genau das, was die
gewählte Sicht zeigt: „Alle Testläufe löschen", wenn man auf den Testläufen
steht. Was läuft oder wartet, bleibt dabei stehen: der Worker schreibt
minutenlang in genau dieses Verzeichnis, und ein `rmtree` darunter ließe ihn
mitten im Lauf auf Pfade stoßen, die es nicht mehr gibt. Einen laufenden Job
wird man einzeln los.

**Deck.** „Im Deck öffnen" legt das Deck als Modal über die Seite: Üben ist
ein eigener Arbeitsmodus und kein weiterer Abschnitt unter der Liste. Der
Hintergrund liegt so lange still, Escape, ein Klick auf den Schleier und
„Deck schließen" führen zurück (ein Zug an einem Regler, der neben dem Deck
endet, nicht — sonst verlöre man das Deck beim Schieben). Beim Schließen
gibt der Player den Speicher der Spuren wieder frei.

Bis alle Spuren geladen und dekodiert sind, steht dort nur der Songname,
ein Spinner und „n von m Spuren". Das Deck selbst kommt erst, wenn es
spielen kann: ein halb gefülltes Deck nimmt Klicks an und antwortet nicht,
und die Wellenformen wären leer. „Abbrechen" während des Ladens bricht auch
die Downloads ab — bei einem echten Song sind das mehrere Dutzend Megabyte
je Spur, die sonst weiterliefen, obwohl sie niemand mehr hören will.

Beschriftet ist, was nicht eindeutig zu zeichnen ist. Alles andere trägt
ein Zeichen und erklärt sich im Tooltip und für Vorlesesoftware: Lautsprecher
und Kopfhörer für Mute und Solo, ein Pfeil auf die Linie für „Loop-Marke
hierher", ein × für Schließen, Aufheben und Löschen. Die Technikangaben
unter dem Deck stehen hinter „Technik" und sind einen Klick entfernt.

Im Deck: gemeinsames Play/Pause, Seek, Mix-Tempo (50–125 %) und A/B-Loop.
Pro Spur eine Wellenform, Lautstärke, Mute, Solo und Pitch in Halbtönen.
Die Spuren liegen untereinander auf einer gemeinsamen Zeitachse, jede in
ihrer eigenen Farbe; dieselbe Songsekunde liegt in jeder Spur an derselben
Stelle.

Die Reglerspalte zeigt nicht alles auf einmal. Immer zu sehen ist der
Pegel — ein gemessener Ausschlag neben dem Regler, kein aus dem Reglerwert
gerechneter Balken: er zeigt, was von dieser Spur wirklich im Mix ankommt,
bei Stummschaltung also nichts. Die Tonhöhe klappt am Spurnamen auf (das
♯ hinter dem Namen), und sie bleibt sichtbar, solange sie nicht auf Null
steht. Das Solo-Tempo erscheint in der Zeile der Spur, die gerade allein zu
hören ist.

Über den Spuren liegt dieselbe Zeitachse noch einmal als Lineal, und darin
die Loop-Schiene: A und B sind Marken, die sich einzeln ziehen lassen — mit
Maus, Finger oder Tastatur (Pfeile um eine Sekunde, mit Umschalt um 0,1 s,
Bild auf/ab um zehn, Pos1/Ende an die Grenze). Der Balken zwischen ihnen
füllt sich mit dem laufenden Durchgang. Beim Ziehen folgt die Marke dem
Zeiger sofort; der Wiedergabe gemeldet wird höchstens zehnmal je Sekunde,
denn jede Meldung plant alle Spuren neu.

Was nicht gezogen, sondern gewusst wird, lässt sich eintippen: unten stehen
A und B als Zahl in **Millisekunden**, daneben je ein Knopf, der die Marke
auf die aktuelle Stelle setzt. Übernommen wird beim Verlassen des Feldes
oder mit der Eingabetaste — nicht bei jedem Tastendruck, sonst wären „1",
„12", „123" drei Sprünge an drei falsche Stellen. Danach steht im Feld, was
wirklich gilt: eine Zahl außerhalb des Songs oder näher als 0,25 s an der
anderen Marke rückt an die Grenze. Solange kein Loop gesetzt ist, zeigen die
beiden Felder gestrichelt, was gälte — null bis Songende; tippt man hinein,
wird daraus der Loop.

Zeigt die Maus auf eine Wellenform, steht die Zeit darunter oben im Lineal
und wandert mit: Minute, Sekunde und die Millisekunde als Zahl, in derselben
Einheit wie die beiden Felder. Sie steht einmal für alle Spuren, nicht in
jeder Zeile — die Zeitachse gilt ohnehin für alle.

Die Wellenformen sind ebenfalls die Zeitachse: hineinklicken springt an die
Stelle, hineinziehen setzt den A/B-Loop. Mit der Tastatur geht dasselbe — eine
Wellenform lässt sich anfokussieren, dann springen Pfeiltasten um eine
Sekunde (mit Umschalt um 0,2 s), Bild auf/ab um zehn und Pos1/Ende an Anfang
und Ende. Stumme oder durch Solo ausgeblendete Spuren werden gedämpft
gezeichnet, man sieht also auf einen Blick, was gerade klingt. Zum Anschauen
muss nichts heruntergeladen werden.

- Die Position und die Loop-Marken sind **immer Sekunden im Originalsong**,
  unabhängig vom eingestellten Tempo.
- Pitch einer Spur ändert nur die Tonhöhe. Dauer und Abspielposition bleiben.
- Mix-Tempo ändert die Geschwindigkeit aller Spuren bei gleicher Tonhöhe.

**Eine Spur üben.** Ist genau eine Spur solo, geht ihre Zeile auf: sie
bekommt eine höhere Wellenform in ihrer Farbe und einen eigenen Temporegler
(50–125 %), unabhängig vom Mix-Tempo, das so lange ruht. Der Transport sagt
links daneben, was gerade zu hören ist. Beim Verlassen von Solo läuft der
Mix an der gerade gehörten Stelle mit dem Mix-Tempo weiter, ohne Sprung.
Der eingestellte Solo-Wert bleibt pro Spur gespeichert, auch wenn man
zwischendurch eine andere Spur solo schaltet.

### Welches Modell

Wenn Spuren ineinander durchschlagen, liegt das am Modell, nicht an der
Verarbeitung: die getrennten Spuren ergeben zusammen wieder exakt das
Original, das Modell verteilt den Klang also genau so.

| Modus in der Oberfläche | Modell | Spuren | 4:33 auf der GPU | VRAM (belegt / reserviert) | Download | Im Browser |
|---|---|---|---|---|---|---|
| Schnell | `htdemucs` | 4 | 10,8 s | 0,53 / 0,71 GiB | 84 MB | **ja**, 174 MB, 18,3 s |
| Detailliert | `htdemucs_ft` | 4 | 27,9 s | 1,01 / 1,18 GiB | 337 MB | nein |
| Instrumente | `htdemucs_6s` | 6 | 29,0 s | 0,57 / 0,73 GiB | 55 MB | **ja**, 115 MB |
| Nur Gesang | `roformer_vocals` | 2 | 27,7 s | 1,96 / 3,57 GiB | 913 MB | nein |

Die letzte Spalte ist der Unterschied zwischen den beiden Trennorten; die
Zeit darin ist dieselbe Datei auf WebGPU statt auf CUDA. Was
dort „nein“ steht, erscheint in der Oberfläche gar nicht, wenn „Auf diesem
Gerät“ gewählt ist — nicht ausgegraut, sondern nicht vorhanden.

**Warum „Detailliert“ im Browser fehlt.** `htdemucs_ft` ist kein Modell,
sondern ein **Bündel aus vier**, je eines pro Spur, deren Ergebnisse
gewichtet gemittelt werden. Im Browser hieße das viermal 174 MB Download
(knapp 700 MB) und viermal die Rechenzeit je Block. Auf der GPU kostet es
schon lokal zweieinhalbmal so lange wie `htdemucs`; im Browser wären es
zehnmal. Das Exportskript weist Bündel deshalb ausdrücklich ab, mit
Begründung, statt sie stillschweigend als ein Modell zu behandeln. Gemessen
wurde es im Browser nicht, also steht hier auch keine Zahl.

**Warum „Nur Gesang“ im Browser fehlt.** `roformer_vocals` ist eine andere
Architektur mit eigener STFT-Vorverarbeitung, 913 MB Gewichten und bis zu
3,6 GB VRAM. Dafür wäre ein eigener Export und eine eigene Kette nötig —
nichts davon ist gebaut und nichts davon gemessen.

Der Name in der ersten Spalte steht als `mode` am Modell in
`backend/app/separation.py` und kommt über `/api/models` in die Oberfläche:
so gibt es die kurzen Namen nur an einer Stelle, und die Karten erfinden
nichts dazu.

**Trennschärfe**, am synthetischen Testmix gegen die bekannten
Ausgangsspuren gemessen (`tools/measure_sdr.py`, mehr dB ist besser):

| | Bass | Drums | Rest | Mittel |
|---|---|---|---|---|
| `htdemucs` | 7,39 | 6,72 | 20,92 | 11,68 dB |
| `htdemucs_ft` | 13,11 | 12,42 | 22,19 | **15,91 dB** |

**Übersprechen zwischen Gesang und Begleitung** auf echtem Material
(`tools/measure_bleed.py`, gemeinsamer Anteil, weniger ist besser):

| | |
|---|---|
| `htdemucs` | 0,61 % |
| `htdemucs_ft` | 0,50 % |
| `roformer_vocals` | **0,24 %** |

Kurz:

- **Vier Spuren und es soll sauber sein** → `htdemucs_ft`. Gemessen 4,2 dB
  besser als `htdemucs` bei zweieinhalbfacher Laufzeit.
- **Nur Gesang und Begleitung** (zum Mitspielen oder Mitsingen) →
  `roformer_vocals`. Weniger als die Hälfte des Übersprechens von `htdemucs`.
- **Schnell etwas hören** → `htdemucs`. Bleibt die Vorgabe.

Zwei Dinge, die **nicht** helfen, beide gemessen und deshalb nicht eingebaut:

- **Mehr `shifts`.** Demucs kann über zufällig verschobene Durchläufe mitteln.
  Von 1 auf 5 brachte das 0,22 dB bei fünffacher Laufzeit. Es bleibt überall
  bei 1.
- **Zwei Schritte hintereinander** (erst Gesang abtrennen, dann die Begleitung
  zerlegen). Klingt plausibel, war aber deutlich schlechter: 8,10 dB gegenüber
  11,68 dB für einen einzelnen `htdemucs`-Durchlauf. Der zweite Durchlauf
  arbeitet auf bereits verarbeitetem Material und fügt mehr Fehler hinzu, als
  das Vorabtrennen einspart.

### Was im Arbeitsspeicher liegt

Beim Öffnen eines Jobs holt der Player jede Spur einmal, dekodiert sie und
übergibt die Rohdaten an das jeweilige Stretch-Worklet. Danach wird zum
Abspielen nichts mehr nachgeladen, auch nicht beim Springen, Loopen oder
Tempowechsel. Die Oberfläche nennt den Betrag unten im Deck.

Gemessen mit der 4:33-Testdatei:

| | Spuren | gehaltenes Audio | Zuwachs im Browser-Prozess |
|---|---|---|---|
| `htdemucs` | 4 | 368 MB | 717 MB |
| `htdemucs_6s` | 6 | 551 MB | 1079 MB |

Die gehaltene Menge ist schlicht `Dauer × 44100 × 2 Kanäle × 4 Byte` je Spur,
also rund 92 MB pro Spur und 4:33. Der Prozess wächst um etwa das Doppelte:
dazu kommen der WASM-Speicher der Worklets und der Zwischenspeicher beim
Dekodieren. Mit 32 GB RAM ist das unkritisch; bei sehr langen Stücken oder
sechs Spuren lohnt ein Blick auf die Anzeige.

Zwei Dinge halten das klein:

- Die Rohdaten werden an das Worklet **übergeben**, nicht kopiert
  (`addBuffers` mit Transferliste). Ohne das läge jede Spur beim Laden
  kurzzeitig zweimal im Speicher.
- Für die Wellenform bleibt nichts zusätzlich liegen. Beim Dekodieren wird
  einmal eine Hüllkurve aus 4096 Abschnitten berechnet, das sind 32 kB pro
  Spur. Die Rohdaten wandern danach direkt ins Worklet.

Im Browserweg kommen die Spuren nicht über eine Adresse, sondern liegen
schon als Abtastwerte da. Das Deck holt und dekodiert dann nichts — es
nimmt sie direkt. Übergeben werden sie trotzdem nicht, sondern kopiert:
der Ergebnisspeicher behält sie für ein späteres Öffnen und für den
WAV-Download, und ein übergebener Puffer wäre dort leer. Die Spitze beim
Laden ist damit dieselbe wie beim Dekodieren einer heruntergeladenen Datei.
Wie lange die Ergebnisse liegen bleiben, steht unter
[Was im Speicher liegt](#was-im-speicher-liegt-und-wie-lange).

### Testpfad

Der Knopf „Testspuren anlegen" erzeugt einen Job, der **nichts trennt**: drei
synthetische WAVs, nämlich zwei Klickspuren mit Klicks auf genau denselben
Zeitpunkten und ein 440-Hz-Dauerton. Damit lässt sich der Player prüfen,
auch wenn kein Trennmodell vorliegt. Solche Jobs tragen in der API das Feld
`is_test_path: true` und in der Oberfläche eine Markierung „Testpfad".

Zum Hören: laufen die beiden Klickspuren synchron, hört man **einen**
Klick. Driften sie, hört man ein Flattern oder zwei getrennte Klicks.

Ohne Backend legt der Browser dieselben drei Spuren selbst an
([`test-signals.ts`](frontend/src/app/separate/test-signals.ts)), aus
derselben Vorschrift und mit denselben Zahlen wie
[`synthetic.py`](backend/app/synthetic.py). Das ist kein Zufall: ein
Messwert aus dem einen Pfad wäre im anderen sonst nicht vergleichbar. So
lässt sich das Deck auch in der öffentlichen Variante prüfen, ohne 174 MB
Modell und ohne Grafikkarte.

---

## Im Browser trennen

Derselbe Song, dasselbe Modell, dieselben vier Spuren — nur rechnet die
Grafikkarte über WebGPU statt über CUDA, und es ist kein Server im Spiel.
Die Datei wird nicht hochgeladen; sie wird gelesen.

### Wo der ONNX-Graph aufhört

Exportiert wird **nicht** das ganze Modell. Die Grenze liegt vor der STFT
und hinter der iSTFT:

```
Datei -> dekodieren (44 100 Hz, Stereo)
      -> Blöcke von 7,8 s, 25 % Überlappung
      -> STFT, Real/Imaginär als Kanäle (CAC), normieren     | Javascript
      ----------------------------------------------------------------
      -> htdemucs.onnx                                        | WebGPU
      ----------------------------------------------------------------
      -> entnormieren, maskieren, iSTFT, Zeitzweig addieren   | Javascript
      -> mit Dreiecksgewicht überlagern, Padding trimmen
      -> vier Spuren, gleiche Länge, gleicher Zeitursprung
```

Zwei Gründe für genau diese Grenze, beide nachgeprüft:

1. **`torch.onnx.export` bekommt die komplexen Tensoren nicht durch.**
   `torch.stft` und `torch.istft` arbeiten mit komplexen Zahlen, und die
   lassen sich nicht ablegen. Das ist der Grund, aus dem jeder öffentliche
   htdemucs-Export dieselbe Grenze zieht.
2. **Die Normierung im Graphen liefert auf WebGPU NaN.** Mittelwert und
   Streuung über den ganzen Spektrogrammblock müsste man einzeln auf die
   CPU zwingen. Davor steht man nicht, wenn sie gar nicht im Graphen ist.

Was draußen bleibt, muss nachgebaut werden, und ein Nachbau kann still
falsch sein: ein halber Block Versatz, eine Fensterfunktion in der
symmetrischen statt der periodischen Variante, ein vergessener Faktor aus
der Normierung. Nichts davon wirft einen Fehler. Man hört es als Dumpfheit
oder als Flattern an den Blockgrenzen — oder man hört es nicht und hält es
für das Modell. Deshalb steht die ganze Kette **zweimal** da, und jede
Fassung wird gegen die vorige gemessen:

| Fassung | Datei | Gemessen gegen |
|---|---|---|
| Torch | `audio-separator`s Demucs-Kopie | — |
| numpy | [`tools/demucs_reference.py`](backend/tools/demucs_reference.py) | die Methoden des Modells selbst, Schritt für Schritt |
| TypeScript | [`separate/dsp.ts`](frontend/src/app/separate/dsp.ts) | Kennzahlen aus der numpy-Fassung |
| im Browser | derselbe Code über den Worker | die getrennten Spuren der numpy-Fassung |

Die Zahlen stehen unter [Gemessen](#gemessen).

### Was ausgeliefert wird

```
frontend/public/models/htdemucs-op17-fp32/     174,3 MB in 9 Stücken + manifest.json
frontend/public/models/htdemucs_6s-op17-fp32/  114,6 MB in 6 Stücken + manifest.json
frontend/public/vendor/onnxruntime/             28,9 MB in 2 Stücken + runtime.json
```

**Warum in Stücken.** Keine einzelne Datei darf größer als 20 MiB sein,
sonst lässt sich der Bau nicht kostenlos ausliefern: GitHub blockt Pushes
über 100 MB, Cloudflare Pages nimmt höchstens **25 MiB je Datei**. Eine
174-MB-ONNX kommt dort gar nicht erst an.

Zerlegt wird auf **Byte-Ebene**, ohne jedes ONNX-Werkzeug: die Stücke
aneinandergehängt sind wieder dieselbe Datei. Der Browser holt sie, setzt
sie im Arbeitsspeicher zusammen und gibt der Laufzeit denselben Puffer wie
zuvor. Zwei Dinge dabei, die sonst wehtun:

- Der Zielpuffer wird **vorab in voller Größe** angelegt und jedes Stück
  direkt hineingeschrieben. Erst sammeln und dann verketten wäre einfacher
  zu schreiben und hätte die 174 MB kurzzeitig doppelt im Speicher — auf
  einem knappen Gerät der Unterschied zwischen läuft und läuft nicht.
- Geprüft wird die **SHA-256 des zusammengesetzten Ganzen** gegen das
  `manifest.json`. Ein Stück, das als Fehlerseite ankommt, oder eine halb
  aktualisierte Auslieferung fällt damit als Ladefehler auf und nicht als
  Trennung, die durchläuft und Unsinn liefert.

Gecacht wird das zusammengesetzte Ganze unter einem Namen — einmal
zusammensetzen, danach einmal lesen statt neunmal. Die 25-MiB-Grenze ist
eine Regel des Hosters, nicht des Browsers; der Cache kennt sie nicht.

Dasselbe gilt für das WASM der Laufzeit (28,7 MB). Es lädt sich sonst
selbst nach, anhand von `wasmPaths` — zerlegt geht das nicht mehr, also
holt es der Browserpfad selbst und übergibt es über
`env.wasm.wasmBinary`. Nebenwirkung, die hier gelegen kommt: die 28 MB
liegen damit im eigenen Cache statt im HTTP-Cache, auf den sich nichts
verlassen kann.

Alles in festen Fassungen und aus dem eigenen Haus: die Gewichte sind aus
den `.th`-Dateien unter `models/` exportiert, die schon für den lokalen Weg
heruntergeladen wurden. Zu jedem Export schreibt das Skript ein
`manifest.json` mit Prüfsummen beider Dateien, Ein- und Ausgabeformen,
Spurreihenfolge, Opset, Parameterzahl und Lizenz — wer wissen will, was da
läuft, muss nichts glauben.

```bash
cd backend
../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs
../.venv/bin/python tools/export_htdemucs_onnx.py htdemucs_6s
```

Das Skript lädt die Gewichte, kapselt den Vorwärtsteil, exportiert, lässt
den Export einmal auf der CPU laufen und vergleicht Wert für Wert mit
Torch. Schlägt der Vergleich fehl, ist der Rückgabewert ungleich Null und
das `manifest.json` sagt, woran.

Die Runtime ist vendoriert, wie Signalsmith Stretch und aus demselben
Grund: sie lädt ihr WASM selbst nach, anhand ihrer eigenen Adresse. Welche
Dateien dazugehören, liest
[`tools/vendor-onnxruntime.mjs`](frontend/tools/vendor-onnxruntime.mjs) in
der Runtime nach, statt eine Liste zu führen — die Namen haben sich zwischen
1.30 und 1.31 geändert (`jsep` → `asyncify`), und eine falsch kopierte
Datei fällt nicht beim Bauen auf, sondern erst beim ersten Trennversuch,
mit „no available backend found“.

```bash
cd frontend
npm run vendor:ort     # nach jedem Versionswechsel von onnxruntime-web
```

### Läuft es wirklich auf der Grafikkarte

`navigator.gpu` vorzufinden heißt nichts. Die Runtime fällt bei jedem
Problem still auf WASM zurück, und ein Browser kann einen reinen
Software-Adapter anbieten — SwiftShader, llvmpipe —, der die ganze
Schnittstelle erfüllt und auf dem Prozessor rechnet. Beides sieht von außen
wie ein GPU-Lauf aus und ist ein Vielfaches langsamer.

Ein Lauf gilt deshalb erst als GPU-Lauf, wenn drei Dinge zusammenkommen
([`runtime.ts`](frontend/src/app/separate/runtime.ts)):

1. `navigator.gpu` liefert einen Adapter, und der bezeichnet sich nicht als
   Software oder Rückfallweg.
2. Die Sitzung entsteht mit WebGPU als **einzigem** Rechenweg. Das ist der
   tragende Beleg: kann die Runtime WebGPU nicht benutzen, hat sie nichts,
   worauf sie zurückfallen könnte, und `create` wirft („no available
   backend found“ — genau diese Meldung kam, als eine WASM-Datei fehlte).
   Ein stilles Ausweichen ist damit ausgeschlossen.
3. Die Runtime nennt nach dem Anlegen der Sitzung das `GPUDevice`, mit dem
   sie rechnet.

Fehlt eines davon, heißt der Weg `WASM (CPU)`, und so steht es in der
Messung, am fertigen Job und in den Technikangaben. Die Messseite nennt
außerdem jeden Beleg einzeln im Klartext.

**Ein vierter Punkt stand hier zuerst und war falsch.** Die Überlegung war:
ein Ergebnis-Tensor in einem GPU-Puffer kann nur von der GPU kommen, also
ist er der sauberste Nachweis. Auf der RTX 4070 unter Chrome 156 kommen die
Ausgaben aber **auf der CPU** zurück, obwohl `preferredOutputLocation`
gesetzt ist, der Adapter `nvidia · lovelace` meldet und die Inferenz
vierzigmal schneller läuft als auf WASM: die Runtime erfüllt den Wunsch nur,
wenn der erzeugende Knoten auf der GPU endet. Als Bedingung hätte dieser
Punkt einen echten GPU-Lauf als WASM-Lauf ausgegeben — und bei einer
Prüfung, die es mit der Wahrheit genau nimmt, ist ein falsches Nein
genauso schädlich wie ein falsches Ja. Der Ort der Ausgaben wird weiterhin
gemeldet, aber als Beobachtung: er sagt, ob die Ergebnisse je Block über
den Bus geholt werden müssen.

**Ohne Grafikbeschleunigung wird trotzdem getrennt.** Das ist eine
Entscheidung: ein Software-Adapter heißt langsam, nicht unmöglich, und wer
nur diesen hat, soll nicht vor einem gesperrten Knopf stehen. Die
Importkarte warnt vorher, dass es bei einem ganzen Lied eher zehn Minuten
als eine dauert, und der Job trägt hinterher `WASM (CPU)`. Der eine Ort, an
dem ein CPU-Lauf **nie** als GPU-Lauf erscheint, ist die Messung.

### Ein Auftrag je Tab

Die Trennung läuft in **zwei** eigenen Workern. Ein Block Inferenz
blockiert seinen Faden für mehrere Hundert Millisekunden und die iSTFT dazu
noch einmal so lange; auf dem Hauptfaden stünde die Fortschrittsanzeige
still und der Abbrechen-Knopf reagierte nicht.

- [`separate.worker.ts`](frontend/src/app/separate/separate.worker.ts) hält
  Modell und Sitzung, macht die STFT und schickt die Blöcke an die Karte.
- [`dsp.worker.ts`](frontend/src/app/separate/dsp.worker.ts) rechnet zurück
  — iSTFT, Maskierung, Überlagerung — und hält die fertigen Spuren.

Zwei und nicht einer, weil sie sich auf einem Faden gegenseitig ausbremsen:
die WebGPU-Laufzeit braucht die Javascript-Schleife zwischen ihren Kernen,
und eine iSTFT gibt sie eine Viertelsekunde lang nicht her. Nebeneinander
spart das ein Drittel der Zeit — gemessen, siehe
[Zwei Fäden](#zwei-fäden-272-s-auf-183-s). Verdrahtet werden sie über einen
`MessageChannel` am Hauptfaden vorbei; der soll je Block nicht 55 MB
weiterreichen müssen.

Mehr als einen Auftrag gleichzeitig gibt es nicht: eine Trennung belegt die
Grafikkarte und knapp ein Gigabyte, zwei wären beide langsamer als eine
nach der anderen. Der zweite Auftrag wird abgewiesen, mit Grund.

Abbrechen geht, und zwar sauber. Der Worker sieht zwischen zwei Blöcken
nach; jede Nachricht trägt die Job-Kennung, und der Empfänger verwirft
alles, was nicht zum gerade aktiven Job gehört. **Ein verspätetes Ergebnis
eines abgebrochenen Jobs kann einen neuen nicht überschreiben** — sonst
bekäme man die Spuren des alten Songs unter dem Namen des neuen und würde
es nicht merken. Geprüft in
[`tests/separate/browser-check.ts`](frontend/tests/separate/browser-check.ts).

### Fortschritt, der stimmt

Einen Prozentwert gibt es nur, wo etwas gezählt wird — und beim Browserweg
wird etwas gezählt, anders als beim Backend:

- **Modelldownload**: gelesene Bytes gegen `content-length`. Fehlt die
  Angabe, gilt die Größe aus dem `manifest.json`; erfunden wird nichts.
- **Trennung**: fertige Blöcke gegen die Gesamtzahl.

Das sind **getrennte Zustände**, und das soll man sehen: beim ersten Lauf
wartet man auf 174 MB, bei jedem weiteren nicht mehr. Danach liegen die
Gewichte in der Cache-API unter einem Namen mit Fassungsnummer, und eine
Trennung läuft auch ohne Netz.

### Was im Speicher liegt, und wie lange

Nichts wird gespeichert. Kein `localStorage`, kein IndexedDB, keine
Telemetrie — Audiodaten und Dateinamen bleiben im Arbeitsspeicher des Tabs
und sind mit dem Neuladen weg. Gecacht werden allein die Modellgewichte.

Aufbewahrt wird trotzdem mit Maß. Ein Song von 4:33 ergibt vier Spuren zu
je rund 92 MB (`Dauer × 44100 × 2 Kanäle × 4 Byte`), also 368 MB je
Ergebnis, bei sechs Spuren 551 MB. Wer fünf Songs hintereinander trennt,
hätte ohne Grenze zwei Gigabyte liegen. Deshalb ein festes Budget von
**1,2 GB** in [`stem-store.ts`](frontend/src/app/separate/stem-store.ts) —
drei Ergebnisse zu vier Spuren — und die ältesten fliegen heraus. Wer ein
Ergebnis gerade geöffnet hat, verliert es nicht: Öffnen macht es zum
jüngsten.

Ein herausgeflogenes Ergebnis verschwindet nicht lautlos. Der Verlauf
behält den Job und schreibt **„Ergebnis nicht mehr im Speicher“** an die
Stelle, an der sonst „Im Deck öffnen“ steht.

Exportdateien entstehen erst beim Klick. Eine Spur von 4:33 ist als WAV
48 MB; vier im Voraus zu schreiben und als Blob-URL offenzuhalten wären
190 MB, die niemand angefordert hat. Die Blob-URL wird nach dem Download
wieder freigegeben, und beim Schließen des Decks gibt der Player den
Speicher der Spuren frei wie bisher.

Geschrieben wird 16-Bit-PCM — dasselbe Format, das `audio-separator` im
lokalen Weg schreibt. Kein Zufall: wer einen Song einmal lokal und einmal
im Browser trennt, soll die Dateien vergleichen können, ohne dass das
Format dazwischenkommt.

### Wenn etwas fehlt

| Lage | Was die Oberfläche sagt |
|---|---|
| Kein WebGPU im Browser | „Dieser Browser bietet kein WebGPU“, mit dem Hinweis auf Chrome oder Edge — und dem Angebot, auf dem Prozessor zu rechnen |
| Nur ein Software-Adapter | nennt den Adapter und was er kostet: „eher zehn Minuten als eine“ |
| Modell lädt nicht | der Job scheitert mit HTTP-Status und Adresse |
| Modus nicht ausgeliefert | erscheint gar nicht in der Auswahl, nicht ausgegraut |
| Kein Platz im Cache | das Modell liegt im Arbeitsspeicher, der Job läuft; nur der nächste Besuch lädt wieder |
| Speicher reicht nicht | „Der Speicher hat nicht gereicht“ samt Vorschlägen — kürzeres Stück, „Schnell“ statt „Instrumente“, Tab neu laden. Stirbt der Worker ganz, ohne Meldung, steht derselbe Grund als der wahrscheinliche da |

### Die Messseite

Hinter `#bench` liegt eine eigene Seite
([`bench-page.ts`](frontend/src/app/bench/bench-page.ts)), die direkt mit
dem Worker redet — ohne Verlauf und ohne Deck dazwischen, damit gemessen
wird, was die Trennung kostet, und nicht der Weg dorthin.

```
http://127.0.0.1:4200/#bench
```

Sie misst Modelldownload, Sitzung, Dekodieren, Inferenz, Signalverarbeitung
in beide Richtungen, die Trennung und die Zeit bis zur ersten abspielbaren
Spur **getrennt**; sie nennt den Ausführungsweg samt Belegen; und sie hält
das Ergebnis gegen die Vergleichswerte aus der numpy-Fassung, die als
`reference/index.json` mit ausgeliefert werden (37 kB). Damit kann auch eine
ausgelieferte Fassung nachweisen, dass sie richtig rechnet.

„Modell-Cache leeren“ wirft die Gewichte heraus und beendet den Worker;
der nächste Lauf ist dann ein kalter.

---

## API

Alles unter `http://127.0.0.1:8000`. Nur die lokale Variante; die
öffentliche spricht `/api` nie an.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/health` | Gerät, VRAM, Hinweise, Warteschlange |
| `GET` | `/api/models` | verfügbare Modelle samt Spurnamen; `mode` ist der Kurzname der Karte („Schnell", „Detailliert", …) |
| `GET` | `/api/jobs` | alle Jobs |
| `POST` | `/api/jobs` | `multipart`: `file`, `model` |
| `POST` | `/api/jobs/test-signals` | Testpfad, trennt nichts |
| `GET` | `/api/jobs/{id}` | ein Job |
| `DELETE` | `/api/jobs/{id}` | Job samt Ordner löschen |
| `DELETE` | `/api/jobs` | alle abgeschlossenen Jobs löschen; Laufendes bleibt. Antwort: `{"deleted": [ids], "kept": n}` |
| `GET` | `/api/jobs/{id}/stems/{slug}` | WAV zum Abspielen |
| `GET` | `/api/jobs/{id}/stems/{slug}?download=1` | dasselbe als Download |

Interaktive Dokumentation: http://127.0.0.1:8000/docs

---

## Wie der Player synchron bleibt

Jede Spur ist ein eigener Signalsmith-Stretch-Knoten auf **einem** geteilten
`AudioContext`:

```
Stretch-Knoten  ->  Gain (Lautstärke, Mute, Solo)  ->  Master-Gain  ->  Ausgang
```

Der Knoten rechnet intern in Sekunden des Eingangsmaterials (`input`), also
in Songsekunden, unabhängig von Tempo (`rate`) und Tonhöhe (`semitones`).
Genau das ist die Zeitachse, die die Oberfläche anzeigt.

Die ganze Synchronität hängt an einer einzigen Regel: **jede** Änderung läuft
durch `reschedule()` in [`mix-engine.ts`](frontend/src/app/audio/mix-engine.ts),
und dort bekommt **jede** Spur denselben `output`-Zeitpunkt und denselben
`input`-Wert. Play, Seek, Tempo, Pitch, Loop und Solo sind alle derselbe
Vorgang. Deshalb können die Spuren gar nicht auseinanderlaufen.

Zwei Feinheiten, die beim Lesen des Bibliothekscodes aufgefallen sind und
die im Code auch so kommentiert stehen:

- Die Doku nennt das Feld `output`, das Worklet liest aber `outputTime`.
  Der Code setzt beide auf denselben Wert.
- Der Knoten muss mit `numberOfInputs: 1` angelegt werden, obwohl die Spur
  aus einem Puffer kommt und nichts am Eingang hängt. Im Zustand
  `active: false` greift das Worklet auf `inputList[0]` zu; mit 0 Eingängen
  wäre das `undefined` und das Worklet würde beim Pausieren abstürzen.

Den A/B-Loop übernimmt der Knoten selbst (`loopStart`/`loopEnd` in
Songsekunden). Alle Knoten führen denselben Umlauf aus, deshalb bleiben sie
auch über viele Durchläufe zusammen.

### Warum die Bibliothek vendoriert ist

Signalsmith Stretch baut sein AudioWorklet, indem es eigenen Quelltext als
Zeichenkette in eine Blob-URL schreibt. Dieser Selbstbezug kann brechen, wenn
ein Bundler die Datei umschreibt. `frontend/public/vendor/SignalsmithStretch.js`
ist deshalb die unveränderte UMD-Originaldatei (MIT, Geraint Luff) und wird
zur Laufzeit über ein `<script>`-Tag geladen. Das WASM steckt als data-URI in
derselben Datei; eine zweite Datei gibt es nicht.

---

## Prüfungen ausführen

**Player-Prüfungen** (Chromium, `OfflineAudioContext`, deterministisch,
braucht kein laufendes Backend):

```powershell
cd frontend
npx playwright install chromium   # einmalig
npm run test:audio
```

Zehn Prüfungen gegen das gerenderte Audio. Die beiden Klickspuren liegen auf
verschiedenen Frequenzen (1000 und 2500 Hz) und lassen sich deshalb im
fertigen Mix getrennt vermessen — gemessen wird, was wirklich am Ausgang
ankommt, nicht der interne Zustand. Die zehnte prüft dasselbe noch einmal
mit Spuren aus dem Arbeitsspeicher statt aus einer Datei: so kommen sie im
Browserweg ins Deck, und ein dabei verschobener oder verdoppelter Kanal
wäre am Versatz zwischen den Spuren zu sehen.

**Signalverarbeitung** (Node, kein Browser, zwei Zehntelsekunden):

```bash
cd frontend
npm run test:separate
```

Siebzehn Prüfungen von [`dsp.ts`](frontend/src/app/separate/dsp.ts) gegen
Kennzahlen, die die numpy-Fassung geschrieben hat — Fensterfunktion, STFT,
CAC-Reihenfolge, Normierung, iSTFT, Blockgewicht, letzter Block — plus das
Byte-Budget des Ergebnisspeichers. Dazu kommt eine Prüfung, die ohne
Referenz auskommt: die halbierte reelle FFT gegen eine ausgeschriebene DFT.

Die Vergleichswerte liegen als
[`fixtures/index.json`](frontend/tests/separate/fixtures/index.json) im Repo
(37 kB). Keine Audiodaten: das Eingangssignal rechnen beide Seiten selbst
nach, über ein Xorshift32, das in Python und Javascript Bit für Bit
dasselbe liefert. Neu erzeugen:

```bash
cd backend
../.venv/bin/python tools/demucs_reference.py --fixtures ../frontend/tests/separate/fixtures
```

**Browserweg, Fehlerfälle** (Chromium, braucht den ONNX-Export):

```bash
cd frontend
npm run test:separate:browser
```

Vierzehn Prüfungen: Dekodieren von Mono und Stereo bei 44,1 und 48 kHz,
Abweisen einer Datei, die kein Audio ist, nur ein Auftrag je Tab, Abbruch
samt Neustart, kein verspätetes Ergebnis zum abgebrochenen Auftrag, die
drei Fälle an der Blockgrenze (genau ein Block, ein Block mit Rest, kürzer
als ein Block) und zweimal dasselbe Ergebnis bei zweimal demselben Lauf.

**Die öffentliche Variante von Ende zu Ende** (Chromium, kein Backend):

```bash
cd frontend
npm run build:public
npm run test:public
```

Der ganze Weg über die normale Oberfläche: Datei hineinlegen, trennen,
zusehen, im Deck üben, als WAV speichern. Dazu die Zusagen der Variante —
keine Anfrage nach `/api` (der Testserver antwortet dort absichtlich mit
500, damit ein übersehener Aufruf auffällt), keine Audiodaten und keine
Dateinamen im dauerhaften Speicher, nur das Modell im Cache, leerer Verlauf
nach dem Neuladen, und eine Trennung bei abgeschaltetem Netz. Dazu zwei
Prüfungen gegen einen veralteten Cache-Eintrag: dass eine alte
Modellbeschreibung ersetzt wird statt die Modusliste zu leeren, und dass
eine wirklich leere Liste sagt, woran es liegt. Und drei zur Oberfläche:
dass die Sprechblase der Moduskarte erst beim Zeigen erscheint, dass vor
dem ersten Download gefragt wird und „Nein" nichts startet, und dass beim
zweiten Lauf nicht noch einmal gefragt wird.

**Messung auf der Grafikkarte** (das Chrome von Windows, aus WSL heraus):

```bash
cd frontend
npm run test:webgpu:windows                              # kalt und warm
npm run test:webgpu:windows -- --song ../testmusik/x.mp3 # dazu ein Song
npm run test:webgpu:windows -- --wasm                    # Gegenprobe
npm run test:webgpu:windows -- --model htdemucs_6s-op17-fp32
```

Das ist der Pfad zu den **echten GPU-Zahlen**. Unter WSL2 gibt es keinen
Vulkan-Treiber für die NVIDIA-Karte, und das Chromium von Playwright
bekommt deshalb nur SwiftShader; das Chrome von Windows sieht die Karte.
Fernsteuern lässt es sich von hier aus nicht, also läuft es umgekehrt: der
Prüfstand liefert die Messung aus und **wartet auf den Rückruf** — die
Seite rechnet und schickt ihr Ergebnis per `fetch` zurück. Erreichbar ist
der Server, weil WSL2 die Ports an den Windows-Host spiegelt; gebunden wird
nur auf `127.0.0.1`. Dass die Adresse `localhost` lautet, ist dabei keine
Bequemlichkeit: nur dort ist der Kontext sicher, und ohne sicheren Kontext
gibt es kein `navigator.gpu`.

Es läuft im neuen Headless-Modus mit einem eigenen Profil unter
`C:\Users\Public\mixapart-messung` — kein Fenster, und das Profil des
Benutzers bleibt unberührt.

**Messung ohne Windows** (Chromium, braucht den Produktionsbau):

```bash
cd frontend
npx ng build
npm run test:webgpu                              # kurzer Clip
npm run test:webgpu -- --song ../testmusik/x.mp3 # ganzer Song
npm run test:webgpu -- --wasm                    # zum Vergleich auf WASM
npm run test:webgpu -- --cold                    # Modell-Cache vorher leeren
```

Treibt die Messseite `#bench` und schreibt dieselben Werte heraus. Das
Skript setzt **nicht** `--enable-unsafe-swiftshader`: eine
Software-Umsetzung von WebGPU soll nicht als Grafikkarte durchgehen. Findet
es keinen echten Adapter, läuft der Vergleich auf WASM und sagt das.

**Die Referenzkette prüfen** (Python, braucht den Export und CUDA):

```bash
cd backend
../.venv/bin/python tools/demucs_reference.py --self-check
../.venv/bin/python tools/demucs_reference.py --compare ../testmusik/x.mp3 --seconds 30
../.venv/bin/python tools/demucs_reference.py --compare ../testmusik/x.mp3 --name htdemucs_6s
```

`--self-check` hält STFT und iSTFT gegen `torch.stft`/`torch.istft` und
`_spec`/`_ispec` gegen die Methoden des Modells. `--compare` trennt eine
Datei zweimal — numpy mit ONNX gegen Torch — und nennt den Abstand je Spur
in dB. Wie dieser Abstand zu lesen ist, steht unter
[Gemessen](#gemessen); kurz: verglichen wird mit Torchs eigener Streuung
zwischen CPU und GPU, nicht mit einem erdachten Grenzwert.

**Ende-zu-Ende** (beide Server müssen laufen):

```powershell
cd frontend
npm run test:e2e -- "C:\Pfad\zu\song.mp3"
```

Ohne Pfad läuft nur der Teil mit dem Testpfad; die echte Trennung wird dann
übersprungen.

**Spurnamen** (laeuft ohne Zusatzpakete, prueft die Zuordnung von
Dateinamen zu Spuren):

```powershell
cd backend
python tests\test_naming.py
```

**Aufraeumen** (ebenfalls ohne Zusatzpakete, in einem eigenen Datenordner —
loescht nichts Echtes):

```powershell
cd backend
python tests\test_cleanup.py
```

Acht Pruefungen gegen `JobStore.delete_finished`: Fertiges und
Fehlgeschlagenes verschwindet samt Ordner, Wartendes und Laufendes bleibt
unberuehrt. Die Ende-zu-Ende-Pruefung bestaetigt dort nur die Rueckfrage und
loescht absichtlich nicht — sie liefe sonst auf echten Jobs.

**Trennqualitaet messen**, falls ein Modell verglichen werden soll:

```powershell
cd backend
python tools\measure_sdr.py <referenzordner> <ordner1> [ordner2 ...]
python tools\measure_bleed.py <ordner1> [ordner2 ...]
```

`measure_sdr.py` braucht bekannte Ausgangsspuren und ist deshalb nur fuer
den synthetischen Testmix sinnvoll; `make_test_wavs.py` schreibt sie mit.
`measure_bleed.py` laeuft auf beliebigem Material und vergleicht Verfahren
untereinander.

**Testsignale als Dateien** erzeugen:

```powershell
cd backend
python tools\make_test_wavs.py ..\testsignale
```

---

## Gemessen

Alle folgenden Zahlen sind auf dieser Maschine entstanden: RTX 4070 Laptop
GPU (8 GB), 32 GB RAM, Treiber 596.21, CUDA 13.2, PyTorch 2.15.0+cu132,
`audio-separator` 0.48.0, `shifts=1`.

### Der ONNX-Export ist dasselbe Modell

| | htdemucs | htdemucs_6s |
|---|---|---|
| Gewichte | `955717e8-8726e21a.th` | `5c90dfd2-34c22ccb.th` |
| Parameter | 41 984 456 | 27 414 996 |
| ONNX, fp32, Opset 17 | 174,3 MB | 114,6 MB |
| Eingaben | `x [1,4,2048,336]`, `xt [1,2,343980]` | dieselben |
| Ausgaben | `x_out [1,16,…]`, `xt_out [1,8,…]` | `[1,24,…]`, `[1,12,…]` |
| Spurreihenfolge des Modells | drums, bass, other, vocals | + guitar, piano |
| Größter relativer Fehler gegen Torch, Frequenzzweig | 5,4·10⁻⁴ | 4,1·10⁻⁴ |
| … Zeitzweig | 2,4·10⁻⁵ | 1,9·10⁻⁴ |
| Lizenz | MIT (facebookresearch/demucs) | dieselbe |

Abtastrate 44 100 Hz, Blocklänge 343 980 Abtastwerte (7,80 s), `nfft` 4096,
`hop` 1024, CAC, keine Wiener-Filterung. Prüfsummen stehen im
`manifest.json` neben jedem Export.

### Die Signalverarbeitung um den Graphen

`tools/demucs_reference.py --self-check`, numpy gegen Torch:

| Prüfung | Ergebnis |
|---|---|
| `stft` gegen `torch.stft` | 3,8·10⁻¹⁶ relativ |
| `istft` gegen `torch.istft` | 3,8·10⁻¹⁶ relativ |
| hin und zurück ergibt das Original | 1,3·10⁻¹⁵ |
| `_spec` gegen die Methode des Modells | 1,6·10⁻⁷ |
| `_ispec` gegen die Methode des Modells | 4,3·10⁻⁷ |

`npm run test:separate`, TypeScript gegen numpy: 17 von 17, größte
Abweichung 1,4·10⁻⁹ bei Beträgen bis 4,9.

### Browserweg gegen Torch, auf echtem Material

30 s der Testdatei, htdemucs. Drei Vergleiche, die zusammen eine Aussage
machen:

| Spur | Spur-RMS | ONNX gegen Torch/GPU | ONNX gegen Torch/CPU | Torch CPU gegen GPU |
|---|---|---|---|---|
| drums | 0,000128 | 9,0 dB | 68,8 dB | 9,0 dB |
| bass | 0,000214 | 0,6 dB | 52,1 dB | 0,6 dB |
| other | 0,083754 | 56,6 dB | 108,0 dB | 56,6 dB |
| vocals | 0,000250 | 12,8 dB | 83,3 dB | 12,8 dB |

Dieselbe Messung mit `htdemucs_6s`:

| Spur | Spur-RMS | ONNX gegen Torch/GPU | ONNX gegen Torch/CPU | Torch CPU gegen GPU |
|---|---|---|---|---|
| drums | 0,000080 | 10,9 dB | 68,0 dB | 10,9 dB |
| bass | 0,000064 | 29,2 dB | 51,3 dB | 29,2 dB |
| other | 0,008055 | 45,7 dB | 75,9 dB | 45,7 dB |
| vocals | 0,011754 | 53,6 dB | 68,4 dB | 55,3 dB |
| guitar | 0,074963 | 64,9 dB | 89,3 dB | 64,9 dB |
| piano | 0,000116 | 36,7 dB | 69,1 dB | 36,7 dB |

**Wie das zu lesen ist.** Die niedrigen Zahlen bei Drums und Bass sind
**kein** Mangel der Umsetzung, und ein fester Grenzwert in dB wäre hier
irreführend. htdemucs legt auf dieses Stück fast nichts auf Drums und Bass
(Spur-RMS 0,00008 gegenüber 0,08 für „Rest“ — dasselbe steht schon unter
[Welches Modell](#welches-modell)). Auf einer Spur, die praktisch leer ist,
verschlingt das Gleitkomma-Rauschen das ganze Signal — **dieselbe Rechnung
einmal auf der CPU und einmal auf der GPU liegt dort auch nur 0,6 dB
auseinander.** Genau das ist die letzte Spalte, und sie ist der Boden, den
keine Umsetzung unterbieten kann.

Der Browserweg trifft diesen Boden bei `htdemucs` auf allen vier Spuren auf
0,0 dB genau und bei `htdemucs_6s` auf fünf von sechs Spuren auf 0,1 dB,
bei `vocals` auf 1,7 dB. Die vierte Spalte sagt, warum das so sein muss:
dort ist nur die Laufzeitumgebung anders, nicht das Gerät, und dort liegen
52 bis 108 dB. **Welches Gerät rechnet, macht mehr aus als
welche Laufzeitumgebung** — die Zahlen aus der dritten Spalte messen also
den Unterschied zwischen GPU und CPU, nicht den zwischen Demucs und diesem
Export.

Die Prüfung gilt deshalb als bestanden, wenn der Browserweg nicht mehr als
3 dB unter diesem Boden liegt. Ein echter Fehler in der Kette — ein halber
Block Versatz, eine Fensterfunktion in der symmetrischen statt der
periodischen Variante — liegt nicht 3 dB daneben, sondern 30.

Derselbe Vergleich **im Browser**, gegen die numpy-Fassung, auf dem
Vergleichssignal und diesmal gegen den Mix gemessen: 58 bis 65 dB unter
Mix (drums 65, bass 58, other 59, vocals 63). Das ist der Abstand, in dem
sich zwei ordentliche fp32-Umsetzungen begegnen.

### Geschwindigkeit

Dieselbe Datei auf drei Wegen, 4:33 Stereo mit `htdemucs`:

| | Rechenweg | 4:33 | Vielfaches der Echtzeit |
|---|---|---|---|
| **lokal** | Python, CUDA | **9,1 s** | 30× |
| **Browser** | WebGPU, RTX 4070 | **18,3 s** | 14,9× |
| **Browser** | WASM, ein Faden | 549,5 s | 0,5× |

Der Browser auf der Grafikkarte ist also rund **doppelt so langsam wie der
lokale Weg und dreißigmal schneller als der Rückfallweg**. Für ein Stück
von viereinhalb Minuten heißt das: achtzehn Sekunden statt neun Minuten.

**Im Einzelnen**, gemessen im Chrome von Windows auf der RTX 4070
(`nvidia · lovelace`, als GPU-Lauf bestätigt):

| | Clip kalt, 8,7 s | Clip warm, 8,7 s | Ganzer Song, 273,2 s |
|---|---|---|---|
| Blöcke | 2 | 2 | 47 |
| Datei dekodieren | — | — | 611 ms |
| Modell laden | 896 ms | aus dem Cache | aus dem Cache |
| Sitzung anlegen | 1,53 s | steht schon | steht schon |
| Inferenz | 2,43 s | 809 ms | **13,34 s** |
| STFT, CAC, Normierung | 138 ms | 113 ms | 2,75 s |
| iSTFT, Maskierung, Überlagerung | 443 ms | 417 ms | 10,97 s |
| Trennung zusammen | 3,03 s | 1,41 s | **27,18 s** |
| bis zur ersten abspielbaren Spur | 5,47 s | 1,41 s | 27,80 s |
| Vielfaches der Echtzeit | 2,9× | 6,2× | **10,0×** |
| mit zwei Worker-Fäden | 3,03 s | **918 ms** | **18,33 s** |
| Abstand zur numpy-Referenz | 58 dB unter Mix | 58 dB | — |

Zum Lesen dieser Tabelle gehören drei Einschränkungen:

- **Der Modelldownload ist hier keiner.** Die 896 ms sind 174 MB von einem
  Server auf derselben Maschine. Über eine echte Leitung dauert das so
  lange, wie 174 MB eben dauern — einmal, danach liegt es im Cache.
- **Kalt und warm unterscheiden sich um mehr als den Download.** Der erste
  Block kostet zusätzlich das Anlegen der Sitzung (1,5 s) und das Aufwärmen
  der Shader; deshalb 2,43 s gegenüber 809 ms für dieselben zwei Blöcke.
- **Die warmen Werte schwanken.** Zwei Läufe ergaben 549 ms und 809 ms
  Inferenz für denselben Clip. Bei einer Zehntelsekunde Unterschied je
  Block fällt das bei zwei Blöcken auf und bei 47 kaum.

**Die Signalverarbeitung in Javascript ist die halbe Zeit.** Beim ganzen
Song stehen 13,34 s Inferenz gegen 13,72 s STFT und iSTFT — auf dem
Rückfallweg waren es 536 s gegen 13,6 s, also 2,5 %. Sobald die Karte
rechnet, ist der eigene Code der Engpass, und zwar überwiegend die
Rücktransformation (10,97 s gegen 2,75 s, weil dort acht Kanäle
zurückzurechnen sind statt zwei hinein).

### Zwei Fäden: 27,2 s auf 18,3 s

Naheliegend und gemessen: 13,3 s auf der Karte, 13,7 s auf dem Prozessor,
verschiedene Recheneinheiten — also müsste sich beides überlappen lassen.

**Der erste Versuch, nur die Reihenfolge umzubauen, brachte sechs Prozent**
(27,18 s auf 25,52 s), und die Zahlen sagten auch, warum. Beim warmen
Clip: 340 ms untätig auf die Karte gewartet, 582 ms Prozessorarbeit,
zusammen 922 ms — und die Trennung dauerte 1,17 s. Die beiden addierten
sich weiterhin, es lief nichts gleichzeitig.

Der Grund steckt in der ausgelieferten Runtime, und ihr Dateiname sagt ihn:
`ort-wasm-simd-threaded.asyncify.wasm`. Die WebGPU-Laufzeit arbeitet über
**Asyncify** — sie hält das WASM zwischen den Kernen an, gibt die Kontrolle
an die Javascript-Schleife zurück und wird von dort fortgesetzt. Sie
braucht den Faden also *zwischendurch immer wieder*. Eine iSTFT ist aber
eine geschlossene Schleife über eine Viertelsekunde; solange sie läuft,
kommt die Runtime nicht voran. Es sind zwar zwei Recheneinheiten, aber ein
Faden — und in welcher Reihenfolge man sie aufruft, ändert daran nichts.

**Mit einem zweiten Worker ändert es sich.** Die Rücktransformation liegt
jetzt in [`dsp.worker.ts`](frontend/src/app/separate/dsp.worker.ts), auf
einem eigenen Faden; verdrahtet sind die beiden über einen
`MessageChannel`, am Hauptfaden vorbei. Je Block gehen 55 MB hinüber, als
Übergabe und nicht als Kopie.

| 4:33, WebGPU | Trennung | × Echtzeit |
|---|---|---|
| nacheinander, ein Worker | 27,18 s | 10,0× |
| Reihenfolge umgebaut, ein Worker | 25,52 s | 10,7× |
| **zwei Worker** | **18,33 s** | **14,9×** |

Ein Drittel schneller als am Anfang, und der Abstand zum lokalen Weg
schrumpft von dreifach auf gut zweifach (9,1 s auf CUDA). Der warme Clip
fällt von 1,17 s auf 918 ms.

Dass es wirklich nebeneinander läuft, steht in den Zahlen: der zweite
Worker rechnete 11,63 s an der Rücktransformation, der erste war 17,41 s
mit Blockumläufen beschäftigt — nacheinander wären das 29 s, gemessen
wurden 18,33 s.

Zwei Dinge, die dabei auffielen:

- **Beide Seiten wurden einzeln langsamer** (Hintransformation 2,46 → 3,45 s,
  Rücktransformation 9,66 → 11,63 s). Zwei Fäden teilen sich eine
  Speicheranbindung, und je Block gehen 55 MB durch sie hindurch. Unterm
  Strich bleibt der Gewinn trotzdem deutlich.
- **Es wird noch 8,20 s untätig auf die Karte gewartet.** Die Karte ist
  also weiterhin der größere Posten — eine schnellere Rücktransformation
  brächte jetzt weniger als vorher.

Bei alledem unverändert: dieselben Spuren, Wert für Wert, und 58 dB unter
Mix gegen die numpy-Referenz.

**Die Zeit bis zur ersten abspielbaren Spur ist die Gesamtzeit.** Das ist
kein Messfehler: es wird erst gespielt, wenn alle Blöcke fertig sind.
Fortschreitende Wiedergabe steht unter [Offene Punkte](#offene-punkte).

**Der Rückfallweg** (WASM, ein Faden) zum Vergleich, dieselbe Maschine:

| | Clip 8,7 s | 4:33-MP3 |
|---|---|---|
| Inferenz | 23,67 s | 535,87 s |
| STFT / iSTFT | 143 ms / 425 ms | 2,80 s / 10,75 s |
| Trennung | 24,25 s | **549,54 s** |
| Vielfaches der Echtzeit | 0,4× | 0,5× |

Ein ganzes Stück braucht dort **gut neun Minuten**; die Warnung in der
Importkarte („eher zehn Minuten als eine“) ist damit gemessen und nicht
geschätzt. Der Renderer wuchs dabei auf gut 5 GB (`ps`-RSS, eine Ablesung,
keine sorgfältige Messung) — auf WebGPU liegen die Zwischenergebnisse auf
der Karte.

Dass eine MP3 dekodiert wurde, steht in der Zeile „Datei dekodieren“:
611 ms für 4:33. `decodeAudioData` nimmt MP3 und WAV gleich und liefert
beides in 44 100 Hz und zwei Kanälen.

### Player und Oberfläche

**Player**, zehn Prüfungen, bestanden. Die ersten neun waren früher
fünfmal hintereinander mit identischen Messwerten bestanden (45 von 45);
die zehnte ist mit dem Browserweg dazugekommen und zweimal gelaufen:

| Prüfung | Ergebnis |
|---|---|
| Zwei Klickspuren synchron | Versatz 0,00 ms |
| Synchron nach Seek auf Sekunde 10 | Versatz 0,00 ms |
| Synchron über 4 Loop-Durchläufe | Versatz 0,36 ms, Loop-Länge auf 2 ms genau |
| Solo mit 60 % Tempo, dann zurück in den Mix | Klickabstand 1,671 s (erwartet 1,667), danach wieder 1,0 s, Versatz 0,00 ms |
| Master-Tempo 50 % | 440,6 Hz gemessen, Tonhöhe also unverändert |
| Pitch +12 Halbtöne | 880,6 Hz, Position läuft unverändert mit 1,0× |
| Pitch +7 Halbtöne | 660,3 Hz (erwartet 659,3) |
| Tempo 75 % und Pitch −5 zusammen | 330,8 Hz (erwartet 329,6) |
| Position läuft nie zurück | 36 Messpunkte über Tempowechsel, Solo und Solo-Ende, größter Rücksprung 0,00 ms |
| Spuren aus dem Arbeitsspeicher (Browserweg) | Versatz 0,00 ms, Länge 30,00 s — dieselben Werte wie über eine Datei |

**Oberfläche**, aus dem Ende-zu-Ende-Lauf:

| Prüfung | Ergebnis |
|---|---|
| Wellenformen werden gezeichnet | 3 Testspuren und 4 echte Stems, jeweils mit gefüllter Fläche zwischen 3 % und 31 % |
| Ziehen in der Wellenform setzt den Loop | von 20 % auf 50 % der Spur ergibt 9,00 s bei 30 s Länge |
| Loop lässt sich in Millisekunden eintippen | 4250 und 7800 ms ergeben 0:04.25 – 0:07.80 (3,55 s) |
| Lineal zeigt die Millisekunde unter dem Zeiger | Zeiger auf halber Bahn: 15000 ms bei 30 s Länge |
| Verlauf blättert seitenweise | 7 Jobs, Seite 1/2, sechs je Seite, zweite Seite ohne Überschneidung |
| Verlauf trennt Songs von Testläufen | Alle 7 · Songs 2 · Testläufe 5, und 2 + 5 = 7 |
| Aufräumen fragt erst nach | „Wirklich? 7 löschen", nach dem Verlassen wieder „Alle", nichts gelöscht |
| Trennort steht zur Wahl, auf dem Gerät als Vorgabe | 2 Einträge in der Liste, gewählt `device` |
| Menschlicher Tastendruck wählt den Ort und klappt die Liste zu | Knopf zeigt „Lokal" |
| Liste nennt beide Orte mit Verfahren und Gerät, ohne umzuschalten | Browser: WebGPU · nvidia · lovelace — Lokal: CUDA · NVIDIA GeForce RTX 4070 Laptop GPU |
| Trennfenster trägt die ausführlichen Angaben | CUDA, RTX 4070 Laptop GPU, 6,85 von 8 GB frei, PyTorch 2.15.0+cu132 |
| Trennung öffnet ein Fortschrittsfenster | modal, mit Dateiname, Modell und laufender Phase |
| Fertige Trennung landet ohne Zutun im Deck | Fortschrittsfenster zu, Deck offen, vier Spuren geladen |
| Spuren liegen im Arbeitsspeicher | Oberfläche meldet 368 MB, Browser-Prozess wächst um 721 MB |

**Öffentliche Variante**, 30 Prüfungen aus `npm run test:public`, alle
bestanden. Die Zahlen daraus, die etwas sagen:

| Prüfung | Ergebnis |
|---|---|
| Anfragen nach `/api` | keine, bei 11 verschiedenen angefragten Pfaden |
| Angebotene Modi | „Minimum“, „Schnell“ und „Instrumente“ — und sonst keine |
| „Minimum“ liefert zwei Spuren, ohne etwas nachzuladen | 2 Spuren (Gesang, Begleitung), 0 Anfragen |
| Knapper Speicher fragt nach, „Nein“ startet nichts | „Knapp: rund 407 MB Arbeitsspeicher nötig.“ — Jobliste unverändert |
| Zu kleines Gerät: abgelehnt, mit Grund, ohne etwas zu laden | „Für „Schnell“ reicht der Arbeitsspeicher dieses Geräts nicht …“ — 0 Anfragen |
| Phasen im Fortschrittsfenster | „Modell wird geladen (n MB von n MB)“ → „Modell wird vorbereitet“ → „Wird getrennt“ |
| WAV-Download einer Spur | `Gesang.wav`, RIFF, 2 Kanäle, 44100 Hz, 16 Bit, 4,00 s bei 4 s Eingabe |
| Dauerhafter Speicher | `localStorage` 0 Einträge, `sessionStorage` 0, IndexedDB 0 Datenbanken |
| Cache | nur `models/*/manifest.json` und `models/htdemucs-op17-fp32/htdemucs.onnx` |
| Verlauf nach dem Neuladen | 0 Jobs |
| Trennung bei abgeschaltetem Netz | 4 Spuren, 0 Anfragen erreichten den Server |

---

## Was tatsächlich ausgeführt wurde

Die Entwicklung lief unter **WSL2 (Linux)** auf demselben Laptop, mit
derselben GPU über CUDA-Durchreichung. Die Windows-Befehle oben sind die
Entsprechungen; **ausgeführt wurden die Linux-Varianten.** Das ist der
einzige Punkt, an dem Dokumentation und Prüfung auseinandergehen.

Ausgeführt und bestanden:

1. `pip install "audio-separator[gpu]==0.48.0"` — danach `pip install audioread`,
   weil der Import ohne dieses Paket scheitert.
2. `torch.cuda.is_available()` → `True`, RTX 4070 Laptop GPU, 8,00 GiB.
3. Echte Separation der mitgelieferten 4:33-MP3 mit `htdemucs` auf CUDA:
   vier WAVs, je 273,18 s, 44,1 kHz, PCM_16.
4. Dasselbe mit `htdemucs_6s` (sechs Spuren), `htdemucs_ft` (27,9 s) und
   `roformer_vocals` (27,7 s, 913 MB Download, 3,57 GiB VRAM reserviert).
5. Trennschärfe gegen bekannte Ausgangsspuren gemessen
   (`tools/measure_sdr.py`) und Übersprechen auf echtem Material
   (`tools/measure_bleed.py`); die Zahlen stehen unter
   [Welches Modell](#welches-modell).
5. CPU-Modus auf einer zweiten Instanz: `cuda_available: false`, Hinweis
   wird gemeldet, Trennung liefert vier Spuren.
6. Warteschlange: drei Jobs gleichzeitig eingereicht, durchgehend
   `processing=1, queued=2`.
7. Fehlerpfade: falscher Dateityp, unbekanntes Modell, unbekannter Job und
   unbekannte Spur liefern verständliche Meldungen bzw. HTTP 404.
8. `npm run test:audio` — 10 von 10, fünfmal wiederholt.
9. `npm run test:e2e <datei.mp3>` — 33 von 33, inklusive echter Trennung mit
   zwei verschiedenen Modellen, Zustandsanzeige, Solo samt eigenem Tempo,
   Wellenformen, Loop per Ziehen, Speichermessung und WAV-Download mit
   korrekt kodiertem Dateinamen. **Ohne** Datei sind es 21, und auch die
   laufen auf einem leeren Jobspeicher durch: Die Prüfung der Reiter
   („Songs" gegen „Testläufe") braucht einen echten Trennjob und setzte
   dafür stillschweigend einen vom vorigen Lauf voraus — war keiner da,
   war der Reiter deaktiviert und der Klick lief in seinen Timeout. Jetzt
   legt der Prüfstand sich zwei Sekunden künstlichen Ton selbst an, über
   `POST /api/jobs` statt über die Oberfläche: ein dort gestarteter Job
   zöge das Deck auf, sobald er fertig ist, und das offene Modal finge ab
   da jeden Klick ab.
10. `npx ng build` (Produktionsbau) ohne Fehler.

Für den Browserweg dazugekommen:

11. `tools/export_htdemucs_onnx.py htdemucs` und `… htdemucs_6s` — Export
    samt Vergleich gegen Torch, beide bestanden; Zahlen unter
    [Gemessen](#gemessen).
12. `tools/demucs_reference.py --self-check` — 5 von 5.
13. `tools/demucs_reference.py --compare <datei.mp3> --seconds 30`, einmal
    je Modell — bestanden gegen Torchs eigene Streuung zwischen CPU und GPU.
14. `npm run test:separate` — 17 von 17 (Signalverarbeitung gegen numpy,
    Byte-Budget des Ergebnisspeichers, reelle FFT gegen eine DFT).
15. `npm run test:separate:browser`, einmal je Modell — 14 von 14
    (Dekodieren von Mono/Stereo bei 44,1 und 48 kHz, ein Auftrag je Tab,
    Abbruch samt Neustart ohne verspätetes Ergebnis, drei Fälle an der
    Blockgrenze, Wiederholbarkeit).
16. `npm run test:public` — 28 von 28 gegen den öffentlichen Bau: kein
    Backendaufruf, voller Weg über die Oberfläche bis zum WAV-Download,
    Deckbedienung, Speicher- und Netzinspektion, leerer Verlauf nach dem
    Neuladen, Trennung bei abgeschaltetem Netz, und zwei Prüfungen gegen
    einen veralteten Eintrag im Modell-Cache, Sprechblase an der
    Moduskarte und die Rückfrage vor dem ersten Modelldownload.
17. `npm run test:webgpu` — lief durch, meldete ehrlich **WASM** und keinen
    GPU-Lauf, weil es unter WSL2 nur SwiftShader gibt.
18. `npm run test:webgpu:windows -- --song <datei.mp3> --wasm` — **der
    GPU-Lauf**, im Chrome von Windows auf der RTX 4070: Adapter
    `nvidia · lovelace`, keine Software-Umsetzung, als GPU-Lauf bestätigt.
    Kalt, warm, ganzer Song und Gegenprobe auf WASM; der Abstand zur
    numpy-Referenz liegt bei 58 dB unter Mix. Zahlen unter
    [Geschwindigkeit](#geschwindigkeit).
19. `npm run build:public` — Produktionsbau der öffentlichen Variante; im
    Bündel steht „Alles auf diesem Gerät“ und nicht „Lokale Verarbeitung“,
    die Gegenprobe im lokalen Bündel umgekehrt.
20. Echte Trennung über das Backend nach allen Änderungen: 4:33 mit
    `htdemucs` auf CUDA in 9,1 s, vier Spuren — der lokale Weg ist
    unberührt.

Beim Bauen und Prüfen gefundene und behobene Fehler, die hier festgehalten
sind, damit sie nicht wiederkehren:

- Die Anzeige sprang beim Verlassen von Solo um 0,07 s zurück. Ursache: die
  Position wurde mit dem **neuen** Tempo rückwärts durch die Vorlaufzeit
  gerechnet, in der noch das alte Tempo klang. Jetzt gilt während der
  Vorlaufzeit der vorherige Zeitanker.
- `reschedule()` veröffentlichte die Position zum künftigen Umschaltzeitpunkt
  als wäre sie die aktuelle. Angezeigt wird jetzt, was gerade zu hören ist.
- Die Warnschwelle für knappen VRAM stand bei 6 GB und hätte dauernd grundlos
  gewarnt. Nach der Messung (0,75 GiB) steht sie bei 1,5 GB.
- Die Oberfläche zeigte einen „Drift" von −111 ms. Das war nicht die
  Synchronität, sondern die Eigenlatenz der Stretch-Knoten. Der Wert heißt
  jetzt so, wie er gemeint ist.
- Nach einem Upload blieb der Dateiname im Auswahlfeld stehen, während
  „Trennen" deaktiviert war; dieselbe Datei erneut zu wählen löste dann kein
  Ereignis mehr aus. Das Feld wird jetzt mit zurückgesetzt.
- Ein erster Versuch, die Trennung in zwei Schritte zu zerlegen, lieferte nur
  zwei statt vier Spuren: als „Begleitung" wurde die `other`-Spur des ersten
  Modells genommen statt der Summe aller Spuren außer Gesang. Der Ansatz ist
  nach der Messung ohnehin verworfen, siehe [Welches Modell](#welches-modell).
- **Spuren bekamen bei manchen Dateinamen Notnamen statt „Gesang", „Drums",
  „Bass".** `audio-separator` schreibt `<eingabe>_(Vocals)_<modell>.wav`, und
  die Erkennung nahm die erste Klammer im Dateinamen. Bei einer Datei wie
  `Song (Official Music Video) [id]_(Bass)_htdemucs_6s.wav` ist das aber
  „Official Music Video". Jetzt wird die hinterste Klammer genommen, die zu
  einer bekannten Spur passt. Abgedeckt von `backend/tests/test_naming.py`.
- **Jobs überlebten keinen Neustart der API.** `job.json` wurde zwar je Job
  geschrieben, aber nie wieder eingelesen; die Ordner blieben als unsichtbarer
  Ballast auf der Platte liegen (hier 768 MB). Sie werden jetzt beim Start
  eingelesen, samt Pfaden zu den Spuren. Für ältere Jobs ohne Pfadangabe gibt
  es einen Rückfallweg über die Dateinamen.
- Der Ende-zu-Ende-Test maß zeitweise den falschen Job: er griff sich den
  ersten Job der Liste statt den gerade selbst angelegten und meldete deshalb
  ein Modell, das die Oberfläche nie gesendet hatte. Er merkt sich jetzt die
  vorhandenen Jobs und verfolgt gezielt seinen eigenen.
- Zwei Prüfungen schlugen fehl, weil sie die Oberfläche sofort nach einem
  Klick lasen. Die Änderungserkennung läuft über Signale und greift erst im
  nächsten Bildaufbau; die Prüfungen warten jetzt darauf.
- **Der Nachweis des GPU-Laufs hatte eine Bedingung zu viel.** Als vierter
  Beleg stand dort: „ein Ergebnis-Tensor liegt im GPU-Puffer". Auf der
  RTX 4070 kommen die Ausgaben aber auf der CPU zurück, obwohl der Adapter
  `nvidia · lovelace` meldet und die Inferenz vierzigmal schneller läuft
  als auf WASM — die Runtime erfüllt `preferredOutputLocation` nur, wenn
  der erzeugende Knoten auf der GPU endet. Die Prüfung hätte damit einen
  echten GPU-Lauf als WASM-Lauf ausgegeben. Bei einer Prüfung, die es mit
  der Wahrheit genau nimmt, ist ein falsches Nein genauso schädlich wie
  ein falsches Ja; der Punkt ist jetzt eine Beobachtung und kein Beleg.
- **Die halbierte reelle FFT lieferte alles halb so laut.** Die
  Rücktransformation teilte durch die Fensterlänge statt durch die halbe
  Länge — die komplexe Reihe, die dabei zurückkommt, ist nur halb so lang.
  Hörbar wäre es als zu leise Spuren gewesen, nicht als Fehler; gefunden
  hat es der Vergleich gegen numpy, der bei `_ispec` einen Faktor 2 zeigte,
  während `_spec` längst stimmte.
- **Das Vergleichsmaß war anfangs irreführend.** Erst wurde der Abstand je
  Spur in dB gegen diese Spur gemessen, mit 60 dB als Grenze. Auf dem
  Testmaterial legt htdemucs fast nichts auf Drums und Bass, und auf einer
  praktisch leeren Spur verschlingt das Gleitkomma-Rauschen das Signal: die
  Prüfung schlug mit 0,6 dB fehl, obwohl nichts kaputt war. Die Gegenprobe
  — Torch gegen Torch, CPU gegen GPU — lag bei genau denselben 0,6 dB.
  Verglichen wird jetzt mit dieser Streuung statt mit einer erdachten
  Grenze; siehe [Gemessen](#gemessen).
- **Die falsche WASM-Datei vendoriert.** Bis onnxruntime-web 1.30 heißt sie
  `ort-wasm-simd-threaded.jsep.wasm`, ab 1.31 `….asyncify.wasm`. Mit der
  alten scheitert erst der Trennversuch im Browser, mit „no available
  backend found“ — nicht der Bau. Das Vendorskript liest die Namen jetzt in
  der Runtime nach, statt eine Liste zu führen.
- **Bei abgeschaltetem Netz scheiterte die Trennung an der kleinsten
  Datei.** Die 174 MB Gewichte lagen im Cache, das `manifest.json` mit
  einem Kilobyte nicht — es kam über das Netz. Es geht jetzt denselben Weg
  wie die Gewichte.
- **Die Ortsliste ließ sich nicht bedienen, und die Prüfung sagte nichts.**
  Sie klappte beim Loslassen der Maustaste zu, ohne zu wählen. Der Grund
  liegt in der Fokusfolge eines gewöhnlichen Klicks auf ein Etikett: beim
  Drücken verlässt der Fokus den Knopf und landet erst beim Loslassen im
  Optionsfeld. Dazwischen meldet der Browser einen Fokusverlust ohne Ziel
  (`relatedTarget` ist `null`), die Liste hielt das für „woanders
  hingeklickt" und nahm dem Klick sein Ziel weg. Zugeklappt wird jetzt nur
  noch, wenn der Fokus wirklich woandershin geht; für den Rest sorgen
  Escape und ein Zeigen daneben. **Die Prüfung ging derweil durch**, weil
  `locator.click()` Drücken und Loslassen in denselben Arbeitsschritt setzt
  — ein Mensch lässt achtzig Millisekunden dazwischen, und erst in dieser
  Lücke tritt der Fehler auf. Die Prüfung drückt jetzt von Hand.
- **Ein alter Cache-Eintrag nahm die ganze Modusliste mit.** Das
  `manifest.json` liegt im Cache, und seine Form hat sich geändert: vor dem
  Zerlegen der Gewichte standen `file` und `bytes` flach darin, heute unter
  `weights`. Der Cache-Name blieb derselbe, also lieferte der Browser die
  alte Beschreibung weiter, und `manifest.weights.file` stolperte über
  `undefined`. Sichtbar war davon nichts — nur eine Importkarte **ohne
  einen einzigen Trennmodus**, weil der Fehler `init()` scheitern ließ und
  `void` die Begründung verschluckte. Gefunden hat ihn niemandes Prüfung:
  jeder Testlauf startet mit frischem Profil und damit mit leerem Cache.
  Drei Änderungen: `fetchCachedJson` nimmt jetzt ein Prädikat und behandelt
  einen Eintrag, mit dem der Aufrufer nicht arbeiten kann, wie einen
  beschädigten — verwerfen und über das Netz ersetzen. `refreshModels`
  packt jeden Modus einzeln ein, damit einer die Liste nicht mitnimmt. Und
  eine leere Liste sagt jetzt, woran es liegt. Den Cache-Namen hochzuzählen
  wäre der naheliegende Weg gewesen, aber der falsche: die gecachten
  Gewichte sind zusammengesetzt Byte für Byte dieselben wie vorher, und ein
  neuer Name hätte 174 MB ohne Grund neu geladen.
- **`StemStore` ließ sich nicht per Konstruktor konfigurieren.** Angular
  kann keine Zahl injizieren (NG2003); `tsc` sah das nicht, der
  Angular-Compiler schon. Das Budget ist jetzt ein Feld.
- **`variant.public.ts` importierte seinen Typ aus der Datei, die es
  ersetzt.** Mit `fileReplacements` zeigte der Import auf die Ersatzdatei
  selbst, und der Typ war weg — ein Fehler, der nur im öffentlichen Bau
  auftrat. Der Vertrag steht jetzt in `variant.types.ts`.
- **Zwei Prüfungen bestätigten nichts.** Die Ende-zu-Ende-Prüfung der
  öffentlichen Variante suchte im Speicher nach einem Dateinamen mit
  Umlauten, während die Prüfdatei „Pruefstueck“ hieß — sie hätte einen
  Treffer nie finden können. Und die alte Ende-zu-Ende-Prüfung verlangte
  das Wort „Fertig“ in der Jobzeile, das die Oberfläche dort nie schreibt
  (Fertiges zeigt die Spurzahl und den Knopf ins Deck). Beide prüfen jetzt,
  was wirklich dasteht.
- **Die Blätterprüfung brach ab, statt etwas zu messen.** Sie braucht mehr
  als sechs Jobs; auf einem aufgeräumten Rechner gab es keine Leiste und
  der Lauf endete mit einer Zeitüberschreitung. Sie legt sich die nötigen
  Testläufe jetzt selbst an.
- Der Prüfstand selbst war anfangs unzuverlässig: etwa jeder achte Lauf
  lieferte bei einer beliebigen Prüfung völlige Stille, während die
  Positionsbuchhaltung stimmte. Ein `OfflineAudioContext` lässt sich nicht
  schließen, und ein Browser erlaubt nur wenige gleichzeitig; die Contexts
  vorheriger Prüfungen blieben dem Prozess erhalten. Seit jede Prüfung einen
  frischen Browser bekommt, ist das weg. Die Engine war daran nicht beteiligt
  — das ist aus dem Fehlerbild und der Wirkung der Änderung geschlossen, nicht
  direkt beobachtet.

## Der Umweg zur Grafikkarte

Dieser Punkt war offen und ist es nicht mehr; der Weg dorthin gehört
hierher, weil er beim nächsten Mal Zeit spart.

Unter WSL2 liegt **kein Vulkan-Treiber** für die RTX 4070
(`/usr/share/vulkan/icd.d/` enthält keinen NVIDIA-Eintrag; `/usr/lib/wsl/lib`
bringt D3D12 und CUDA mit, aber kein Vulkan). Das Chromium von Playwright
bekommt dort nur SwiftShader, eine Software-Umsetzung — und aus der kann
kein GPU-Wert werden.

Das **Chrome von Windows** sieht die Karte, und aus WSL heraus lässt es
sich starten. Fernsteuern lässt es sich von hier aus nicht, also läuft es
umgekehrt: `tests/webgpu/run-windows.mjs` liefert die Messung aus und
wartet auf den Rückruf per `fetch`. Zwei Dinge daran sind nicht beliebig:

- **`localhost`, nicht die WSL-IP.** WSL2 spiegelt die Ports an den
  Windows-Host, gebunden wird nur auf `127.0.0.1`. Und nur unter
  `localhost` ist der Kontext sicher — ohne sicheren Kontext gibt es kein
  `navigator.gpu`.
- **Ein eigenes Profil je Lauf, als Windows-Pfad.** Ein Linux-Pfad lässt
  chrome.exe mit „Failed To Create Data Directory" als Fenster stehen,
  mitten im angeblich kopflosen Lauf. Ein *fester* Pfad ist schlimmer:
  läuft noch eine Instanz mit demselben Profil, reicht der neue Aufruf ihr
  nur die Adresse und endet — der Prüfstand wartet dann auf einen Rückruf,
  den niemand schickt. Beides ist hier passiert. Aufgeräumt wird am Ende
  über den Profilpfad in der Befehlszeile, nicht über
  `taskkill /IM chrome.exe`: das Fenster des Benutzers ist kein Preis für
  eine Messung.

```bash
cd frontend
npm run test:webgpu:windows -- --song ../testmusik/x.mp3 --wasm
```

Die Zahlen stehen unter [Geschwindigkeit](#geschwindigkeit). Kurz: 27,2 s
für 4:33, zehnfache Echtzeit, bestätigter GPU-Lauf, und der Abstand zur
numpy-Referenz liegt bei 58 dB unter Mix.

**Was dabei auffiel und noch offen ist:** die Signalverarbeitung in
Javascript ist auf der Karte die halbe Laufzeit (13,72 s gegen 13,34 s
Inferenz). Die iSTFT wiegt dabei viermal so schwer wie die STFT. Dort läge
der nächste Gewinn — nicht am Modell, und auch nicht an der Runtime.

---

## Offene Punkte

### Was bewusst nicht gebaut ist

- **Keine fortschreitende Wiedergabe.** Gespielt wird erst, wenn alle
  Blöcke fertig sind; die Zeit bis zur ersten abspielbaren Spur ist deshalb
  die Gesamtzeit. Hörbar wäre früher möglich — die Blöcke entstehen von
  vorn nach hinten —, aber die Überlappung heißt, dass ein Abschnitt erst
  mit dem Folgeblock endgültig ist, und das Deck erwartet fertige Spuren.
- **Keine Cloud mit eigenem API-Key.** Nicht angefangen.
- **Kein Service Worker.** Folge: eine Trennung läuft bei abgeschaltetem
  Netz weiter, solange die Seite offen ist (geprüft, 0 Anfragen erreichten
  den Server) — aber ein **Neuladen** ohne Netz schlägt fehl. Die
  ONNX-Runtime holt bei jedem Seitenaufbau ihre Javascript-Brücke (53 kB)
  selbst nach, und ohne Service Worker liegt die nur im HTTP-Cache, auf den
  sich nichts verlassen kann.
- **Einfädiges WASM.** Der Rückfallweg nutzt einen Kern. Mehrere bräuchten
  `SharedArrayBuffer` und damit `Cross-Origin-Opener-Policy` und
  `Cross-Origin-Embedder-Policy` auf dem ausliefernden Server. Nicht
  eingebaut, nicht gemessen.
- **`htdemucs_ft` und `roformer_vocals` nicht im Browser.** Begründet unter
  [Welches Modell](#welches-modell).
- **Entwickelt und geprüft unter WSL2, nicht unter Windows.** Eine
  Ausnahme gibt es inzwischen: die Messung auf der Grafikkarte lief im
  Chrome von Windows (siehe [Der Umweg zur Grafikkarte](#der-umweg-zur-grafikkarte)).
  Backend, Dev-Server und die Prüfstände liefen ausschließlich unter Linux;
  die PowerShell-Befehle oben sind die Entsprechungen.
- **Nur die beiden Demucs-Modelle** sind eingebunden. `audio-separator` kann
  deutlich mehr; `MODEL_PRESETS` in
  [`separation.py`](backend/app/separation.py) ist die Stelle dafür. Für
  dichtes Material wäre `htdemucs_ft` der nächste Versuch — ungeprüft, siehe
  oben.
- **Kein echter Fortschritt in Prozent — auf dem Backendweg.**
  `audio-separator` liefert keinen, den man ehrlich umrechnen könnte; dort
  bleibt es bei Phasen und Lauflicht. Der Browserweg zählt Bytes und Blöcke
  und zeigt deshalb einen Balken.
- **Die Wellenform hat eine feste Auflösung** von 4096 Abschnitten über die
  ganze Länge. Zoomen gibt es nicht; bei einem langen Stück ist ein Abschnitt
  entsprechend grob.
- **`onnxruntime-gpu` meldet beim Start `Failed to load libcurand.so.10`.**
  Harmlos: die Demucs-Modelle laufen über PyTorch, nicht über ONNX Runtime.
  Die Meldung kommt daher, dass das Paket CUDA 12 erwartet und hier CUDA 13
  installiert ist.
