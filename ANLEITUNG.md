# songsplit — Anleitung

Ein Song hinein, die einzelnen Spuren heraus: Gesang, Drums, Bass, Rest.
Danach ein Deck zum Üben — Spuren stummschalten, einzeln hören, Tempo und
Tonhöhe getrennt ändern, eine Stelle in Schleife legen.

Diese Seite beschreibt, wie man es aufsetzt und was es kann. Das **Warum**
hinter den Entscheidungen, die Messwerte und die Fallstricke stehen in
[README.md](README.md) — das ist ein Arbeitsjournal, kein Einstieg.

---

## Was es kann

- **Trennen** einer MP3 oder WAV in 4 oder 6 Spuren (Demucs v4).
- **Üben** im Deck: gemeinsames Play/Pause, Seek, Tempo 50–125 %, A/B-Loop.
  Je Spur Wellenform, Lautstärke, Mute, Solo und Tonhöhe in Halbtönen. Wer
  eine Spur solo hört, kann für sie ein eigenes Tempo einstellen.
- **Speichern** jeder Spur einzeln als WAV.
- **Verlauf** aller Trennungen, mit erneutem Öffnen im Deck.

Was es **nicht** kann, und zwar bewusst: Hören, bevor die Trennung fertig
ist. Und es gibt keine Cloud-Anbindung mit eigenem Schlüssel.

### Zwei Varianten

|  | **lokal** | **öffentlich** |
|---|---|---|
| Rechnet | Python + CUDA, oder Browser | nur im Browser (WebGPU) |
| Braucht | Python, FFmpeg, NVIDIA-Treiber | einen Browser mit WebGPU |
| Trennmodi | 4 Modelle, dazu die Browser-Modi | „Schnell" und „Instrumente" |
| Verlauf | übersteht den Neustart | gilt für die Sitzung |
| Ausliefern | zwei Prozesse auf `127.0.0.1` | statische Dateien über HTTPS |

Beide benutzen dieselbe Oberfläche. Der Unterschied steckt in einer einzigen
Datei, die der öffentliche Bau austauscht.

**Es gibt keine Datenbank.** Jobs des Backends liegen als `job.json` im
Jobordner, Jobs des Browsers im Arbeitsspeicher des Tabs.

In der öffentlichen Variante verlässt **nichts** das Gerät: keine Datei,
kein Dateiname, kein Messwert. Gecacht werden nur die Modellgewichte und
die Laufzeit.

---

## Voraussetzungen

| Werkzeug | Version | wofür |
|---|---|---|
| Python | ≥ 3.10, **nicht** 3.14.1 | Backend und Modellexport |
| Node.js | ≥ 20 | Oberfläche (Angular 22) |
| FFmpeg | aktuell, im `PATH` | das Backend liest MP3 darüber |
| NVIDIA-Treiber | aktuell | nur für den CUDA-Weg |

Für den Browserweg zusätzlich **Chrome oder Edge mit WebGPU**. Ohne
Grafikbeschleunigung rechnet der Browser auf dem Prozessor — das geht, dauert
bei einem ganzen Lied aber eher zehn Minuten als eine. Die Importkarte sagt
es vorher.

---

## Aufsetzen

```bash
git clone https://github.com/r0b0tan/songsplit.git
cd songsplit
./install.sh
```

Das war alles. Das Skript prüft die Werkzeuge, legt `.venv` an, installiert
die Abhängigkeiten, holt die Demucs-Gewichte, installiert die npm-Pakete,
vendoriert die ONNX-Runtime und exportiert beide Modelle nach ONNX.

```bash
./install.sh --cpu      # Torch ohne CUDA — spart rund 3 GB Download
./install.sh --check    # nur nachsehen, was fehlt; ändert nichts
./install.sh --force    # auch das neu machen, was schon da ist
```

Es läuft mehrfach ohne Schaden: was schon da ist, wird übersprungen.

**Beim ersten Mal dauert es.** Torch mit CUDA sind rund 3 GB, dazu je
Modell etwa 170 MB Demucs-Gewichte. Der Export rechnet danach ein paar
Minuten und prüft sich dabei Wert für Wert gegen Torch.

### Warum nach dem Klonen noch etwas fehlt

Zwei Dinge liegen nicht im Repo und entstehen erst beim Aufsetzen:

| | Größe | entsteht durch |
|---|---|---|
| Exportierte Modellgewichte | 289 MB | `export_htdemucs_onnx.py` |
| Vendorierte ONNX-Runtime | 29 MB | `npm run vendor:ort` |

Beides ist erzeugtes Beiwerk. Git legt jede Fassung einer Binärdatei ganz ab
und vergisst keine — ein Satz Gewichte kostet gepackt rund 172 MB, und jeder
neue Export kostet dieselbe Summe noch einmal, dauerhaft. So wiegt der Klon
**1,2 MB** statt 320 MB.

Wer den Export überspringt, sieht in der Importkarte „Kein Trennmodus" —
samt dem Befehl, der fehlt.

---

## Starten

```bash
./start.sh              # lokale Variante: Backend + Oberfläche
./start.sh --public     # öffentliche Variante: nur der Browser
./start.sh --cpu        # CUDA nicht benutzen
./start.sh --open       # danach den Browser öffnen
```

Dann **http://127.0.0.1:4200**. Strg-C beendet beides. Läuft eines schon,
wird es mitbenutzt statt doppelt gestartet. Die volle Ausgabe steht in
`.run/api.log` und `.run/web.log`.

Von Hand geht es auch:

```bash
cd frontend && npm start           # Oberfläche, lokale Variante
cd frontend && npm run start:public   # Oberfläche, öffentliche Variante
cd backend  && ../.venv/bin/python run.py   # nur die API
```

---

## Bedienen

1. **Datei** auf die Fläche ziehen oder anklicken — MP3 oder WAV.
2. **Modus** oben rechts: „Browser" oder „Lokal". Beim Aufklappen steht zu
   jedem, womit gerechnet wird und worauf. Vorgabe ist der Browser.
3. **Trennmodus** wählen: „Schnell" (4 Spuren) oder „Instrumente" (6).
   Die Sprechblase neben der Karte nennt Modell, Spuren und Download.
4. **Trennen.** Beim allerersten Lauf im Browser fragt songsplit, ob die
   174 MB Modellgewichte geladen werden dürfen. Danach nie wieder — sie
   bleiben im Browser-Cache, und jeder weitere Song beginnt sofort, auch
   ohne Netz.
5. Das **Deck** geht von selbst auf, sobald alle Spuren da sind.

Im Verlauf darunter steht jede Trennung mit Zustand; fertige lassen sich
erneut im Deck öffnen oder spurweise als WAV speichern.

---

## Ausliefern

```bash
cd frontend
npm run build:public      # → dist/songsplit-public/browser/
```

Der Inhalt dieses Ordners ist eine Sammlung gewöhnlicher Dateien: hochladen,
über HTTPS ausliefern, fertig. Kein Server, keine Datenbank, kein Konto.

**HTTPS ist Pflicht** — ohne sicheren Kontext gibt es kein WebGPU.

Keine Datei im Bau ist größer als 21 MB. Damit passt er dorthin, wo es
Grenzen je Datei gibt: GitHub blockt ab 100 MiB, Cloudflare Pages ab
25 MiB. Deshalb liegen Gewichte und Laufzeit in Stücken — der Browser setzt
sie beim Laden wieder zusammen und prüft die Prüfsumme des Ganzen.

Die lokale Variante baut `npm run build`; sie braucht das laufende Backend.

---

## Prüfen

```bash
cd frontend
npm run test:separate          # Signalverarbeitung gegen numpy (Node)
npm run test:separate:browser  # derselbe Weg im echten Browser
npm run test:audio             # Wiedergabe, Tempo, Loop
npm run test:public            # öffentliche Variante Ende zu Ende
npm run test:e2e <song.mp3>    # lokale Variante gegen das Backend
npm run test:webgpu            # läuft es wirklich auf der Grafikkarte
```

`test:e2e` braucht das laufende Backend, alles andere nicht. `test:public`
braucht vorher `npm run build:public`.

---

## Wenn etwas fehlt

| Was Sie sehen | Was zu tun ist |
|---|---|
| „Kein Trennmodus" | `./install.sh` — der Export fehlt |
| „Keine Grafikbeschleunigung" | Grafiktreiber aktualisieren; in einer VM ist WebGPU meist aus. Es läuft trotzdem, nur langsam |
| „no available backend found" | `npm run vendor:ort` — die Runtime fehlt oder passt nicht zur Version |
| Backend meldet sich nicht | `.run/api.log` lesen; `./install.sh --check` |
| Der Modus erscheint, aber der Download scheitert | Gewichte unvollständig: `./install.sh --force` |

---

## Wo was liegt

```
backend/          FastAPI, Trennung über audio-separator
  tools/          Export nach ONNX, Modell-Downloads
frontend/
  src/app/        Oberfläche (Angular, standalone, signals)
    separate/     der Browserpfad: Worker, Signalverarbeitung, Modellcache
    components/   Importkarte, Deck, Verlauf, Fortschrittsfenster
  public/models/  exportierte Gewichte (nicht im Repo, siehe Aufsetzen)
  tests/          die Prüfungen von oben
models/           Demucs-Gewichte für Torch (nicht im Repo)
data/             Jobs des Backends (nicht im Repo)
install.sh        einmalig nach dem Klonen
start.sh          startet beides
```

---

## Einstellungen

Über Umgebungsvariablen, alle optional:

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `SONGSPLIT_DEVICE` | `auto` | `auto`, `cuda` oder `cpu` |
| `SONGSPLIT_PORT` | `8000` | Port der API |
| `SONGSPLIT_UI_PORT` | `4200` | Port der Oberfläche |
| `SONGSPLIT_DATA_DIR` | `./data` | wohin die Jobs schreiben |
| `SONGSPLIT_MODEL_DIR` | `./models` | wo die Demucs-Gewichte liegen |
| `SONGSPLIT_MAX_UPLOAD_MB` | `200` | Obergrenze je Datei |

`SONGSPLIT_HOST` steht fest auf `127.0.0.1`; `run.py` verweigert jede andere
Adresse. Das Backend ist nicht dafür gebaut, im Netz zu stehen.
