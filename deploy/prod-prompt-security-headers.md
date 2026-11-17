# Übergabe an die Serversitzung: Sicherheitskopfzeilen für mixapart.de

> Dieser Text ist ein Prompt. Er wird in eine Claude-Code-Sitzung **auf dem
> Server** eingefügt (`ssh christoph@mixapart.de`, dort `claude`). Die
> ausführliche, kommentierte Fassung des Snippets liegt im Entwicklungsrepo
> unter `nginx-security-headers.conf` — sie ist die Quelle der Wahrheit.

---

Du arbeitest auf dem Produktionsserver von **mixapart.de**. Die Seite läuft
und soll das die ganze Zeit über tun — sie ist öffentlich erreichbar und
wird benutzt. Alles, was du tust, muss jederzeit in einem Zug rückgängig zu
machen sein.

## Lage

- nginx liefert statische Dateien aus `/var/www/mixapart.de/public`
  (Eigentümer `christoph:www-data`). Es gibt keine Anwendung dahinter, kein
  PHP, keinen Reverse Proxy auf einen Dienst.
- **Cloudflare steht davor.** Was `curl -I https://mixapart.de/` von außen
  zeigt, ist die Antwort von Cloudflare, nicht die des Ursprungs. Für den
  Ursprung musst du lokal fragen (siehe *Prüfen*).
- Zertifikate kommen von certbot. `/var/www/mixapart.de/public/.well-known`
  gehört certbot — **nicht anfassen**.
- Die Dateien des Angular-Baus tragen ihren Inhalt im Namen
  (`main-ABC123.js`). Deshalb gibt es locations mit eigenen Cache-Regeln.

## Was fehlt und warum

Die Seite liefert **keine einzige** Sicherheitskopfzeile aus. Nachgemessen:

```
$ curl -I https://mixapart.de/
HTTP/2 200
content-type: text/html
server: cloudflare
# keine CSP, kein nosniff, kein Referrer-Policy,
# kein Permissions-Policy, kein COOP, kein HSTS
```

Die Konfiguration dafür ist seit Längerem geschrieben, war aber nie im
server-Block eingebunden. Deine Aufgabe ist genau das: dafür sorgen, dass
sie wirklich beim Browser ankommt.

## Die eine Falle, an der das hier hängt

**`add_header` in einem location-Block ersetzt *alle* geerbten
`add_header`-Zeilen des server-Blocks.** Nicht ergänzen — ersetzen.

Es gibt in dieser Konfiguration mehrere locations mit eigenen
`add_header`-Zeilen (typisch `Cache-Control` für `/models/`, `/vendor/`,
`index.html`, `cloud.json`, das gehashte Hauptbündel). Jede davon braucht
das `include` **noch einmal**, sonst liefert ausgerechnet das Hauptbündel
ohne Richtlinie aus — und das fällt niemandem auf, weil die Seite dabei
völlig normal funktioniert.

Such sie alle. `grep -n add_header` über die Site-Datei, und zwar bevor du
etwas änderst.

## Schritte

1. **Sichern.** Kopiere die Site-Datei aus `/etc/nginx/sites-available/`
   (bzw. `sites-enabled/`) mit Zeitstempel beiseite. Sag mir den Pfad der
   Sicherung, bevor du weitermachst.

2. **Lage aufnehmen.** Zeig mir den vollständigen server-Block und das
   Ergebnis von `grep -n 'add_header\|location\|include' <site-datei>`.
   Beschreibe, welche locations eigene `add_header`-Zeilen haben.

3. **Snippet anlegen** als `/etc/nginx/snippets/mixapart-security-headers.conf`,
   Rechte 644, Eigentümer root. Liegt die Datei schon dort (`deploy.sh
   install-headers` kann sie gelegt haben), **nimm die vorhandene** und
   ändere sie nicht — melde nur, dass sie da war. Sonst mit genau diesem
   Inhalt:

   ```nginx
   add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'" always;
   add_header X-Content-Type-Options "nosniff" always;
   add_header Referrer-Policy "strict-origin-when-cross-origin" always;
   add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()" always;
   add_header Cross-Origin-Opener-Policy "same-origin" always;
   add_header Strict-Transport-Security "max-age=31536000" always;
   ```

   Zwei Dinge an diesem Text sind nicht verhandelbar:

   - **`blob:` in `script-src` muss bleiben.** Signalsmith Stretch baut sein
     AudioWorklet aus einer Blob-URL, und Worklet-Skripte fallen unter
     `script-src`, nicht unter `worker-src`. Ohne `blob:` lädt das Deck
     keine einzige Spur — und zwar lautlos: Chromium meldet Verstöße aus
     einem Worklet weder in der Konsole noch an `report-uri`.
   - **`'unsafe-inline'` steht nur bei `style-src`**, nie bei `script-src`.
     Angular hängt Komponenten-Styles als `<style>` in die Seite; das
     Inline-Skript des Critical-CSS-Inliners ist im Build abgeschaltet.

4. **Einbinden.** `include /etc/nginx/snippets/mixapart-security-headers.conf;`
   in den server-Block — und in **jede** location mit eigenen
   `add_header`-Zeilen noch einmal. Zeig mir den Diff, bevor du ihn
   schreibst.

5. **Prüfen, dann laden.** `nginx -t`. Erst wenn das sauber ist:
   `systemctl reload nginx`. Niemals `restart`.

6. **Nachmessen** (siehe unten) und mir berichten.

## Prüfen

Am Ursprung vorbei an Cloudflare:

```bash
curl -sI --resolve mixapart.de:443:127.0.0.1 https://mixapart.de/ | grep -i \
  'content-security-policy\|x-content-type\|referrer-policy\|permissions-policy\|cross-origin-opener\|strict-transport'
```

Und — das ist der Teil, der meistens vergessen wird — auch für eine Datei
aus einer location mit eigenen Kopfzeilen, etwa das gehashte Hauptbündel:

```bash
ls /var/www/mixapart.de/public/main-*.js
curl -sI --resolve mixapart.de:443:127.0.0.1 https://mixapart.de/main-XXXX.js | grep -ic 'content-security-policy'
```

Kommt dort `0` heraus, fehlt in genau jener location das `include`.

Lehnt curl das Zertifikat ab, liegt am Ursprung vermutlich ein
Cloudflare-Origin-Zertifikat statt eines von certbot — dann `-k`
dazunehmen. Das ist hier in Ordnung: geprüft werden Kopfzeilen, nicht die
Vertrauenskette. Hört nginx am Ursprung gar nicht auf 443, frag mich,
bevor du etwas umstellst.

Danach von außen, durch Cloudflare: `curl -I https://mixapart.de/`. Weicht
das Ergebnis vom Ursprung ab, liegt es an Cloudflare (Cache oder eine
Transform Rule) und nicht an nginx.

## HSTS: einmal nachsehen, nicht raten

`Strict-Transport-Security` kann Cloudflare selbst setzen (SSL/TLS → Edge
Certificates → HSTS). Steht es dort **und** hier, kommt die Kopfzeile
doppelt. Prüf die Antwort von außen auf Dubletten und melde mir, was du
siehst — die Entscheidung, welche der beiden bleibt, treffe ich.

Bewusst **ohne** `includeSubDomains` und **ohne** `preload`: Ersteres würde
jede künftige Unterdomain ohne Zertifikat für ein Jahr unerreichbar machen,
Letzteres ist eine Tür, die sich nur in eine Richtung öffnet. Füg beides
nicht von dir aus hinzu.

## Grenzen

- Ändere **nichts** am Inhalt von `/var/www/mixapart.de/public`. Dort spielt
  `deploy.sh` vom Entwicklungsrechner aus ein; eine Änderung hier wäre beim
  nächsten Deploy weg.
- Fass `cloud.json` nicht an. Sie trägt Adresse und Token des Trennwegs und
  wird vom Deploy absichtlich ausgespart.
- Kein `certbot`, keine Zertifikate, keine Firewall, keine Pakete.
- Wenn `nginx -t` fehlschlägt: Sicherung zurückspielen, `nginx -t` erneut,
  und mir sagen, was los war. Nicht weiterprobieren.
- Fragen statt raten, wenn die Site-Datei anders aussieht als hier
  beschrieben.

## Fertig ist es, wenn

Alle sechs Kopfzeilen kommen am Ursprung heraus — für `/` **und** für eine
Datei aus jeder location mit eigenen `add_header`-Zeilen —, `nginx -t` ist
sauber, die Seite lädt im Browser normal und das Deck spielt eine Spur ab.

Berichte zum Schluss: welche Dateien du geändert hast, wo die Sicherung
liegt, welche locations das `include` bekommen haben, und was die
Nachmessung am Ursprung und durch Cloudflare ergeben hat.
