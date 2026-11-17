# MixApart — Anleitung

Ein Song hinein, die einzelnen Spuren heraus: Gesang, Drums, Bass, Rest.
Danach ein Deck zum Üben — Spuren stummschalten, einzeln hören, Tempo und
Tonhöhe getrennt ändern, eine Stelle in Schleife legen.

Diese Seite beschreibt, wie man es aufsetzt und was es kann. Das **Warum**
hinter den Entscheidungen, die Messwerte und die Fallstricke stehen in
[README.md](README.md) — das ist ein Arbeitsjournal, kein Einstieg.

---

## Was es kann

- **Trennen** einer MP3 oder WAV in 2, 4 oder 6 Spuren (Demucs v4).
  „Minimum" gibt Gesang und Begleitung — derselbe Lauf wie „Schnell", nur
  zusammengefasst, ohne zusätzlichen Download.
- **Üben** im Deck: gemeinsames Play/Pause, Seek, Tempo 50–125 %, A/B-Loop.
  Je Spur Wellenform, Lautstärke, Mute, Solo und Tonhöhe in Halbtönen. Wer
  eine Spur solo hört, kann für sie ein eigenes Tempo einstellen.
- **Speichern** jeder Spur einzeln als WAV.
- **Verlauf** aller Trennungen, mit erneutem Öffnen im Deck.

Was es **nicht** kann, und zwar bewusst: Hören, bevor die Trennung fertig
ist. Und es bindet keinen fremden Trenndienst mit eigenem Schlüssel ein.

### Zwei Varianten

|  | **lokal** | **öffentlich** |
|---|---|---|
| Rechnet | Python + CUDA, oder Browser | im Browser (WebGPU) — wo das Gerät das nicht kann, wahlweise auf unserem Server |
| Braucht | Python, FFmpeg, NVIDIA-Treiber | einen Browser mit WebGPU |
| Trennmodi | 4 Modelle, dazu die Browser-Modi | „Minimum", „Schnell", „Instrumente" |
| Verlauf | übersteht den Neustart | gilt für die Sitzung |
| Ausliefern | zwei Prozesse auf `127.0.0.1` | statische Dateien über HTTPS |

Beide benutzen dieselbe Oberfläche. Der Unterschied steckt in einer einzigen
Datei, die der öffentliche Bau austauscht.

**Es gibt keine Datenbank.** Jobs des Backends liegen als `job.json` im
Jobordner, Jobs des Browsers im Arbeitsspeicher des Tabs.

In der öffentlichen Variante verlässt **nichts** das Gerät: keine Datei,
kein Dateiname, kein Messwert. Gecacht werden nur die Modellgewichte und
die Laufzeit.

Eine Ausnahme gibt es, und sie ist freiwillig: Geräte, die selbst nicht
rechnen können — Android vor allem —, bekommen „Server" zur Wahl. Dann wird
die Datei zu einem GPU-Dienst in den USA hochgeladen, dort getrennt und
nach sechs Stunden gelöscht. Angeboten wird das nur dort, wo es sonst
keinen gangbaren Weg gibt; abschaltbar ist es ohne Neubau (siehe
*Ausliefern*). Die Einzelheiten stehen in der README unter *Der Serverweg*
und in der Datenschutzerklärung.

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
3. **Trennmodus** wählen: „Minimum" (Gesang + Begleitung), „Schnell"
   (4 Spuren) oder „Instrumente" (6). Die Spuren des gewählten Modus
   stehen farbig unter den Karten.
4. **Trennen.** Beim allerersten Lauf im Browser fragt MixApart, ob die
   174 MB Modellgewichte geladen werden dürfen. Danach nie wieder — sie
   bleiben im Browser-Cache, und jeder weitere Song beginnt sofort, auch
   ohne Netz.
5. Das **Deck** geht von selbst auf, sobald alle Spuren da sind.

Bei einem **langen Stück** kann vorher eine zweite Frage kommen: im Browser
liegt alles im Arbeitsspeicher, und ein Lied belegt dort rund 21 MB je
Minute und Spur. MixApart rechnet das vor dem Start aus und sagt, wenn es
knapp wird — bei einem Telefon früher als bei einem Rechner. Wird es
abgelehnt, steht in der Meldung, bis zu welcher Länge es auf diesem Gerät
ginge. Ein kürzerer Ausschnitt lässt sich dann trennen.

Im Verlauf darunter steht jede Trennung mit Zustand; fertige lassen sich
erneut im Deck öffnen oder spurweise als WAV speichern.

---

## Ausliefern

```bash
cd frontend
npm run build:public      # → dist/mixapart-public/browser/
```

Der Inhalt dieses Ordners ist eine Sammlung gewöhnlicher Dateien: hochladen,
über HTTPS ausliefern, fertig. Kein Server, keine Datenbank, kein Konto.

**HTTPS ist Pflicht** — ohne sicheren Kontext gibt es kein WebGPU.

Keine Datei im Bau ist größer als 21 MB. Damit passt er dorthin, wo es
Grenzen je Datei gibt: GitHub blockt ab 100 MiB, Cloudflare Pages ab
25 MiB. Deshalb liegen Gewichte und Laufzeit in Stücken — der Browser setzt
sie beim Laden wieder zusammen und prüft die Prüfsumme des Ganzen.

Die lokale Variante baut `npm run build`; sie braucht das laufende Backend.

### Den Serverweg an- und abschalten

Ob die ausgelieferte Seite einen Serverweg anbietet, steht **nicht** im
Bau, sondern in `cloud.json` daneben:

```json
{ "url": "", "token": "", "region": "…", "keep_hours": 6, "provider_keep_days": 7 }
```

Leere `url` oder `token` heißen: es gibt ihn nicht. Die Fassung auf dem
Server trägt Adresse und Token und ist die maßgebliche — `deploy.sh` nimmt
genau diese Datei vom Abgleich aus. Abschalten heißt deshalb: beide Werte
dort leeren, fertig. Kein Deploy, keine Codeänderung. Der Token gehört
**nicht** in die Fassung im Repo.

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
cloud/app.py      der GPU-Endpunkt bei Modal (siehe README, Der Serverweg)
cloud/probe.sh    prüft ihn Ende zu Ende, mit Fortschritt
```

---

## Einstellungen

Über Umgebungsvariablen, alle optional:

| Variable | Vorgabe | Bedeutung |
|---|---|---|
| `MIXAPART_DEVICE` | `auto` | `auto`, `cuda` oder `cpu` |
| `MIXAPART_PORT` | `8000` | Port der API |
| `MIXAPART_UI_PORT` | `4200` | Port der Oberfläche |
| `MIXAPART_DATA_DIR` | `./data` | wohin die Jobs schreiben |
| `MIXAPART_MODEL_DIR` | `./models` | wo die Demucs-Gewichte liegen |
| `MIXAPART_MAX_UPLOAD_MB` | `200` | Obergrenze je Datei |

`MIXAPART_HOST` steht fest auf `127.0.0.1`; `run.py` verweigert jede andere
Adresse. Das Backend ist nicht dafür gebaut, im Netz zu stehen.
