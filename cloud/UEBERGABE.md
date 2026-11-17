# Übergabe an die Sitzung auf dem Produktivserver

Du arbeitest auf dem Webserver von **mixapart.de**. Dort liegt nur die
gebaute Anwendung, kein Quelltext und kein Repository. Dein Auftrag ist
**eine einzige Datei** — alles andere auf diesem Server geht dich nichts
an, und für das meiste fehlen dir ohnehin die Rechte.

Gebaut und ausgeliefert wird von einem anderen Rechner aus. Was du hier
änderst, darf deshalb nur das sein, was ein Deploy *nicht* überschreibt —
alles andere wäre beim nächsten `rsync` weg.

## Was wo liegt

| | |
|---|---|
| Ausgelieferte Anwendung | `/var/www/mixapart.de/public/` |
| Eigentümer | `christoph:www-data`, Dateien 644, Ordner 755 |
| nginx-Konfiguration | `/etc/nginx/sites-enabled/mixapart.de` (nur root, `sudo` mit Passwort) |
| Davor | Cloudflare als Proxy |

**Das Verzeichnis wird bei jedem Deploy mit `--delete` abgeglichen.** Was du
dort anlegst oder änderst, ist beim nächsten Mal weg — mit **einer**
Ausnahme, und genau um die geht es:

## Die Ausnahme: `cloud.json`

`/var/www/mixapart.de/public/cloud.json` steuert, ob die Seite einen
Serverweg zum Trennen anbietet. Das Deploy-Skript nimmt diese eine Datei
vom Abgleich aus und legt sie nur an, wenn sie fehlt. **Die Fassung auf
dem Server ist die maßgebliche.**

Im Moment steht da:

```json
{ "url": "", "token": "", "region": "us-east · Virginia, USA",
  "keep_hours": 6, "provider_keep_days": 7 }
```

Leere `url` und `token` heißen: es gibt den Serverweg nicht, die Seite
verhält sich, als wäre nichts. Genau so soll es im Moment auch sein.

## Was du an nginx **nicht** tun kannst (und nicht sollst)

Eine frühere Fassung dieser Übergabe bat hier um einen `location`-Block für
`/cloud.json`. **Das ist zurückgezogen**, aus drei Gründen, die eine
Sitzung auf diesem Server bereits nachgewiesen hat:

1. Der dort eingebundene Pfad
   `/etc/nginx/snippets/mixapart-security-headers.conf` **existiert nicht**.
   Ein `include` darauf lässt `nginx -t` scheitern.
2. `/etc/nginx/sites-enabled/mixapart.de` bindet überhaupt nichts ein und
   setzt keine Sicherheits-Kopfzeilen. Die Konfiguration auf dem Server
   entspricht nicht der Vorlage im Repository.
3. Für beides bräuchte es `sudo` mit Passwort, das hier niemand hat.

**Fass die nginx-Konfiguration nicht an.** Wenn du etwas daran auffällig
findest, schreib es auf und gib es zurück — ändern soll es jemand mit
Zugang und Überblick.

Der Block war ohnehin nur Vorsorge: gemessen liefert der Server für
`/cloud.json` kein `Cache-Control`, und Cloudflare meldet
`cf-cache-status: DYNAMIC`, cacht die Datei also nicht. Das Einschalten
unten wirkt auch ohne ihn sofort.

### Befund zum Weitergeben

Von außen geprüft (`curl -sI https://mixapart.de/`): die Seite sendet
**keine** der üblichen Sicherheits-Kopfzeilen — kein
`Content-Security-Policy`, kein `X-Frame-Options`, kein
`X-Content-Type-Options`, kein `Referrer-Policy`, kein
`Permissions-Policy`. Im Repository liegt dafür eine fertige Datei
(`nginx-security-headers.conf`), sie wurde nur nie eingespielt. Das ist
unabhängig vom Serverweg und gehört auf den Tisch desjenigen, der `sudo`
hat.

## Dein Auftrag — den Serverweg einschalten

**Nur ausführen, wenn beide Bedingungen erfüllt sind:**

1. Auf `https://mixapart.de/datenschutz.html` steht ein Abschnitt über die
   Verarbeitung auf einem Server in den USA. Prüf das selbst mit `curl`,
   verlass dich nicht auf eine Zusage.
2. Du hast Adresse und Token ausdrücklich bekommen. **Erfinde den Token
   nicht und rate ihn nicht.** Er liegt auf dem Entwicklungsrechner unter
   `cloud/.token` und muss dir gegeben werden.

Fehlt eines von beidem: nicht einschalten, nachfragen.

```bash
cat > /var/www/mixapart.de/public/cloud.json <<'JSON'
{
  "url": "https://wutzewatz--mixapart-api.modal.run",
  "token": "HIER_DER_TOKEN",
  "region": "us-east · Virginia, USA",
  "keep_hours": 6,
  "provider_keep_days": 7
}
JSON
chmod 644 /var/www/mixapart.de/public/cloud.json
curl -s https://mixapart.de/cloud.json
```

Danach erscheint auf Geräten **ohne** nutzbares WebGPU — also vor allem auf
Android — ein dritter Trennort namens „Server". Auf einem Rechner mit
funktionierender Grafikkarte taucht er nicht auf; das ist Absicht und keine
Fehlfunktion.

### Ausschalten geht genauso

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path('/var/www/mixapart.de/public/cloud.json')
d = json.loads(p.read_text())
d['url'] = d['token'] = ''
p.write_text(json.dumps(d, ensure_ascii=False, indent=2))
PY
```

Leere Werte, und der Weg ist sofort wieder zu. Das ist der Notaus, falls
etwas schiefgeht — kein Deploy nötig, keine Codeänderung.

## Was du **nicht** tun sollst

**Keine andere Datei unter `public/` anfassen.** Sie kommen alle aus dem
Bau und werden beim nächsten Deploy überschrieben oder gelöscht. Das gilt
besonders für `datenschutz.html` und `impressum.html`: eine Änderung dort
wäre beim nächsten Deploy weg, und niemand würde es merken. Diese Texte
gehören ins Repository.

**Keinen Token in eine Datei schreiben, die ins Repository gehört.** Die
Fassung dort ist absichtlich leer.

**Nichts neu bauen, nichts deployen.** Dafür gibt es hier weder den
Quelltext noch die Werkzeuge.

## Zum Verständnis, falls du gefragt wirst

Android-Browser geben die Grafikeinheit meist nicht frei; auf dem Handy
kann die Seite deshalb nicht selbst rechnen. Der Serverweg schickt die
Datei an einen GPU-Dienst (Modal, Region us-east, Virginia), lässt sie dort
trennen und holt die Spuren zurück. Rechenzeit rund 11 Sekunden je Minute
Musik.

Es ist der **einzige** der drei Wege, bei dem eine Datei das Gerät des
Besuchers verlässt — deshalb hängt das Einschalten am Datenschutztext und
nicht an der Technik. Die getrennten Spuren löscht ein Aufräumlauf nach
sechs Stunden; beim Rechenanbieter können Datei und Ergebnis bis zu sieben
Tage liegen.

## Prüfen, dass es steht

```bash
curl -s  https://mixapart.de/cloud.json                        # Werte wie gesetzt
curl -sI https://mixapart.de/cloud.json | grep -i cache-control # no-cache
curl -sI https://mixapart.de/ | head -1                         # 200
curl -s  https://wutzewatz--mixapart-api.modal.run/health       # ok: true
```

Die letzte Zeile fragt den Trennendpunkt selbst. Antwortet er nicht, nützt
der eingeschaltete Serverweg nichts — dann ist das Problem bei Modal und
nicht hier.
