#!/usr/bin/env bash
#
# deploy.sh — baut die oeffentliche Variante und spielt sie nach mixapart.de.
#
# Die Zugangsdaten stehen in .env.deploy daneben, nicht hier und nicht in Git.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEPLOY_ENV:-$SCRIPT_DIR/.env.deploy}"

BUILD=1
DELETE=1
DRYRUN=0
RELOAD_NGINX=0
MODE=deploy

usage() {
  cat <<'HILFE'
deploy.sh — baut die oeffentliche Variante und spielt sie nach mixapart.de.

  ./deploy.sh                  bauen, hochladen, pruefen
  ./deploy.sh -n               nur zeigen, was rsync tun wuerde
  ./deploy.sh --no-build       vorhandenes dist/ nehmen
  ./deploy.sh --no-delete      Fremddateien im Ziel stehen lassen
  ./deploy.sh --reload-nginx   danach nginx -t && systemctl reload nginx (sudo-Passwort)

Sicherheitskopfzeilen (CSP, nosniff, HSTS — siehe nginx-security-headers.conf):

  ./deploy.sh install-headers  Snippet auf den Server legen und einbinden
  ./deploy.sh check-headers    nachsehen, was die Seite wirklich ausliefert

Sitzung (du meldest dich einmal selbst an, danach braucht das Script
keine Zugangsdaten mehr — es benutzt denselben offenen Kanal):

  ./deploy.sh session          Verbindung aufbauen, bleibt im Hintergrund offen
  ./deploy.sh session-status   laeuft sie noch?
  ./deploy.sh session-stop     Verbindung schliessen
  ./deploy.sh setup-key        Schluessel hinterlegen bzw. zum Einsetzen ausgeben
HILFE
}

die()  { printf '\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mHinweis:\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    setup-key)      MODE=setup-key ;;
    install-headers) MODE=install-headers ;;
    check-headers)  MODE=check-headers ;;
    session|session-start) MODE=session ;;
    session-status) MODE=session-status ;;
    session-stop)   MODE=session-stop ;;
    --no-build)     BUILD=0 ;;
    --no-delete)    DELETE=0 ;;
    -n|--dry-run)   DRYRUN=1 ;;
    --reload-nginx) RELOAD_NGINX=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unbekannte Option: $1" ;;
  esac
  shift
done

# ---------------------------------------------------------------- Umgebung ---

[ -f "$ENV_FILE" ] || die "$ENV_FILE fehlt. Kopiere .env.deploy.example dorthin und trage die Passwoerter ein."

perms=$(stat -c '%a' "$ENV_FILE")
case "$perms" in
  600|400) ;;
  *) warn "$ENV_FILE ist $perms — enthaelt Passwoerter. Besser: chmod 600 $ENV_FILE" ;;
esac

# Die Datei wird gelesen, nicht ausgefuehrt: ein Passwort mit Leerzeichen
# oder Sonderzeichen ist ein Wert, kein Shell-Befehl.
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  case "$line" in ''|'#'*) continue ;; esac
  line="${line#export }"
  case "$line" in *=*) ;; *) warn "$ENV_FILE Zeile $lineno ohne '=' — uebersprungen"; continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  key="${key%"${key##*[![:space:]]}"}"
  case "$key" in ''|*[!A-Za-z0-9_]*) warn "$ENV_FILE Zeile $lineno: '$key' ist kein Variablenname — uebersprungen"; continue ;; esac
  case "$val" in
    '"'*'"') val="${val#\"}"; val="${val%\"}" ;;
    "'"*"'") val="${val#\'}"; val="${val%\'}" ;;
  esac
  printf -v "$key" '%s' "$val"
  export "$key"
done < "$ENV_FILE"

: "${DEPLOY_HOST:?DEPLOY_HOST fehlt in $ENV_FILE}"
: "${DEPLOY_USER:?DEPLOY_USER fehlt in $ENV_FILE}"
: "${DEPLOY_TARGET:?DEPLOY_TARGET fehlt in $ENV_FILE}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
DEPLOY_SSH_PASS="${DEPLOY_SSH_PASS:-}"
DEPLOY_SUDO_PASS="${DEPLOY_SUDO_PASS:-}"
DEPLOY_DIST="${DEPLOY_DIST:-$SCRIPT_DIR/frontend/dist/mixapart-public/browser}"
DEPLOY_BUILD_CMD="${DEPLOY_BUILD_CMD:-npm run build:public}"
DEPLOY_URL="${DEPLOY_URL:-https://mixapart.de/}"

case "${DEPLOY_SSH_PASS}${DEPLOY_SUDO_PASS}" in
  *HIER_EINTRAGEN*) die "In $ENV_FILE stehen noch Platzhalter statt der Passwoerter." ;;
esac

# ------------------------------------------- Sicherheitskopfzeilen pruefen ---
#
# Eine Konfiguration, die nur gemeint ist, ist keine. nginx-security-headers.conf
# stand monatelang fertig im Repo und war auf dem Server nirgends eingebunden —
# `curl -I https://mixapart.de/` lieferte keine einzige dieser Zeilen. Auffallen
# konnte das niemandem: die Seite funktioniert ohne sie genauso.
#
# Deshalb wird nach jedem Deploy nachgesehen, und zwar an der Seite selbst und
# nicht an der Datei. Nur was wirklich beim Browser ankommt, zaehlt.

KOPFZEILEN=(content-security-policy x-content-type-options referrer-policy
            permissions-policy cross-origin-opener-policy strict-transport-security)

kopfzeilen_pruefen() {
  local kopf fehlt='' h
  if ! kopf=$(curl -sS -I --max-time 20 "$DEPLOY_URL" 2>/dev/null | tr -d '\r'); then
    warn "$DEPLOY_URL fuer die Kopfzeilenprobe nicht erreichbar."
    return 1
  fi
  for h in "${KOPFZEILEN[@]}"; do
    printf '%s\n' "$kopf" | grep -qi "^$h:" || fehlt="$fehlt $h"
  done
  if [ -n "$fehlt" ]; then
    warn "Die Seite liefert ohne Sicherheitskopfzeilen aus. Es fehlen:$fehlt
       Einrichten mit:  ./deploy.sh install-headers
       Steht Cloudflare davor, kann auch dort eine Regel dazwischenstehen."
    return 1
  fi
  info "Sicherheitskopfzeilen stehen (${#KOPFZEILEN[@]} geprueft)."
}

# ------------------------------------------------------------- Sitzung -------
#
# ssh kann mehrere Verbindungen durch einen einzigen, schon offenen Kanal
# schicken (ControlMaster). Meldest du dich einmal selbst an, laeuft der
# Socket im Hintergrund weiter und jeder spaetere Aufruf — Dateirechte
# pruefen, rsync, nginx neu laden — benutzt ihn, ohne sich erneut
# auszuweisen. Dann braucht das Script weder Passwort noch Schluessel.

DEPLOY_CONTROL_PERSIST="${DEPLOY_CONTROL_PERSIST:-2h}"
CONTROL_DIR="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/mixapart-deploy"
mkdir -p "$CONTROL_DIR" && chmod 700 "$CONTROL_DIR"
# %C ist ein kurzer Hash aus Host, Port und Benutzer — der Socketpfad darf
# nicht laenger als rund 100 Zeichen werden.
CONTROL_PATH="${DEPLOY_CONTROL_PATH:-$CONTROL_DIR/%C}"

SSH_OPTS=(-p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15
          -o ControlPath="$CONTROL_PATH")
REMOTE="$DEPLOY_USER@$DEPLOY_HOST"

session_alive() { ssh "${SSH_OPTS[@]}" -O check "$REMOTE" >/dev/null 2>&1; }

case "$MODE" in
  session)
    if session_alive; then
      info "Sitzung zu $REMOTE laeuft bereits."
      exit 0
    fi
    info "Verbindung zu $REMOTE aufbauen — du meldest dich jetzt selbst an."
    # Ohne Auth-Vorgaben: Schluessel, Agent, Passwort, 2FA — was immer du nutzt.
    ssh "${SSH_OPTS[@]}" -o ControlMaster=yes -o ControlPersist="$DEPLOY_CONTROL_PERSIST" -fN "$REMOTE"
    if session_alive; then
      info "Sitzung offen. Sie schliesst sich nach $DEPLOY_CONTROL_PERSIST ohne Nutzung von selbst."
      info "Jetzt laeuft ./deploy.sh ohne weitere Anmeldung. Vorzeitig schliessen: ./deploy.sh session-stop"
      exit 0
    fi
    die "Sitzung kam nicht zustande."
    ;;
  session-status)
    if session_alive; then info "Sitzung zu $REMOTE ist offen."; exit 0
    else info "Keine offene Sitzung zu $REMOTE."; exit 1; fi
    ;;
  check-headers)
    # Braucht keinen Zugang: gefragt wird die Seite, nicht der Server.
    info "Pruefe die Kopfzeilen von $DEPLOY_URL"
    kopfzeilen_pruefen && exit 0 || exit 1
    ;;
  session-stop)
    if session_alive; then
      ssh "${SSH_OPTS[@]}" -O exit "$REMOTE" >/dev/null 2>&1 || true
      info "Sitzung geschlossen."
    else
      info "Es war keine Sitzung offen."
    fi
    exit 0
    ;;
esac

# --------------------------------------------------------- Authentifizierung -
#
# Eine offene Sitzung schlaegt alles andere: sie ist bereits authentifiziert.
# Sonst Schluessel, sonst Passwort, sonst das, was ssh von sich aus findet.

if session_alive; then
  SSH=(ssh "${SSH_OPTS[@]}" -o ControlMaster=no)
  AUTH="offene Sitzung, keine erneute Anmeldung"
else
  # Innerhalb eines Laufs trotzdem nur einmal anmelden: der erste Aufruf legt
  # den Kanal an, die folgenden hoeren sich dran.
  SSH_OPTS+=(-o ControlMaster=auto -o ControlPersist=60)

  if [ -n "$DEPLOY_SSH_KEY" ]; then
    key="${DEPLOY_SSH_KEY/#\~/$HOME}"
    [ -f "$key" ] || die "DEPLOY_SSH_KEY zeigt auf keine Datei. Erwartet wird ein Pfad wie ~/.ssh/id_ed25519 — ein Passwort gehoert in DEPLOY_SSH_PASS."
    SSH_OPTS+=(-i "$key" -o IdentitiesOnly=yes)
    SSH=(ssh "${SSH_OPTS[@]}")
    AUTH="Schluessel $DEPLOY_SSH_KEY"
  elif [ -n "$DEPLOY_SSH_PASS" ]; then
    command -v sshpass >/dev/null || die "sshpass fehlt (apt install sshpass) — oder DEPLOY_SSH_KEY setzen."
    export SSHPASS="$DEPLOY_SSH_PASS"
    # Ohne diese drei Optionen probiert ssh erst die lokalen Schluessel durch und
    # faellt dann womoeglich auf keyboard-interactive — da wartet sshpass
    # vergeblich auf den erwarteten Prompt und die Verbindung haengt.
    SSH_OPTS+=(-o PubkeyAuthentication=no
               -o PreferredAuthentications=password,keyboard-interactive
               -o NumberOfPasswordPrompts=1)
    SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
    AUTH="Passwort aus $ENV_FILE"
  else
    SSH=(ssh "${SSH_OPTS[@]}")
    AUTH="ssh-Agent bzw. ~/.ssh/config"
  fi
fi

# ----------------------------------------------------------------- sudo ------
#
# Das Passwort wird abgefragt, nicht gespeichert, und es geht spaeter ueber
# stdin an sudo statt als Argument — ein Argument stuende in der Prozessliste
# des Servers und damit fuer jeden anderen Benutzer dort lesbar da.

sudo_passwort_holen() {
  [ -n "$DEPLOY_SUDO_PASS" ] && return 0
  if [ -t 0 ]; then
    printf 'sudo-Passwort fuer %s auf %s (%s): ' "$DEPLOY_USER" "$DEPLOY_HOST" "$1" >&2
    IFS= read -rs DEPLOY_SUDO_PASS || true
    printf '\n' >&2
    [ -n "$DEPLOY_SUDO_PASS" ] || die "Kein Passwort eingegeben."
  else
    die "$1 braucht ein sudo-Passwort: im Terminal starten oder DEPLOY_SUDO_PASS in $ENV_FILE setzen."
  fi
}

# Ein Befehl als root auf dem Server. stdin ist hier das Passwort, also kann
# nichts anderes durch diese Leitung — wer eine Datei schicken will, schickt
# sie vorher mit einem eigenen Aufruf.
sudo_fern() {
  printf '%s\n' "$DEPLOY_SUDO_PASS" | "${SSH[@]}" -T "$REMOTE" "sudo -S -p '' sh -c $(printf '%q' "$1")"
}

# -------------------------------------------------------- install-headers ----
#
# Legt nginx-security-headers.conf als Snippet auf dem Server ab und sagt,
# was im server-Block noch fehlt.
#
# Was dieses Script **nicht** tut: den server-Block selbst umschreiben. Eine
# nginx-Konfiguration automatisch zu veraendern heisst, im Fehlerfall eine
# Seite abzuschalten, die vorher lief. Die eine Zeile setzt ein Mensch ein;
# das Script sagt genau welche, wohin, und prueft danach nach.

if [ "$MODE" = install-headers ]; then
  snippet="$SCRIPT_DIR/nginx-security-headers.conf"
  ziel=/etc/nginx/snippets/mixapart-security-headers.conf
  [ -f "$snippet" ] || die "$snippet fehlt."
  sudo_passwort_holen "Sicherheitskopfzeilen einrichten"

  info "Uebertrage nginx-security-headers.conf nach $REMOTE"
  "${SSH[@]}" -T "$REMOTE" 'cat > /tmp/mixapart-security-headers.conf' < "$snippet" \
    || die "Uebertragung fehlgeschlagen."

  info "Lege $ziel an"
  sudo_fern "mkdir -p $(dirname "$ziel") && install -m 644 -o root -g root /tmp/mixapart-security-headers.conf $ziel && rm -f /tmp/mixapart-security-headers.conf" \
    || die "Konnte $ziel nicht anlegen."

  # Steht das include schon irgendwo? Ohne es liegt die Datei da und wirkt nicht.
  eingebunden=$(sudo_fern "grep -rl mixapart-security-headers /etc/nginx/sites-enabled/ 2>/dev/null || true") || true
  if [ -z "$eingebunden" ]; then
    # Der Name der Site-Datei folgt gewoehnlich der Domain, nicht der IP:
    # DEPLOY_HOST ist hier die falsche Auskunft, DEPLOY_URL die richtige.
    site=${DEPLOY_URL#*://}; site=${site%%/*}
    warn "Das Snippet liegt jetzt dort, ist aber noch nirgends eingebunden."
    printf '\nDiese Zeile in den server-Block von /etc/nginx/sites-enabled/%s:\n\n' "$site"
    printf '    include %s;\n\n' "$ziel"
    printf 'Und in jede location, die eigene add_header-Zeilen setzt, noch einmal:\n'
    printf 'add_header in einer location ersetzt *alle* geerbten add_header des\n'
    printf 'server-Blocks. Welche das sind, steht in deploy/nginx-mixapart.de.conf.\n\n'
    printf 'Danach:  ./deploy.sh --reload-nginx  und  ./deploy.sh check-headers\n\n'
    exit 1
  fi

  info "Eingebunden in:"
  printf '%s\n' "$eingebunden" | sed 's/^/    /'
  info "nginx -t && systemctl reload nginx"
  sudo_fern 'nginx -t && systemctl reload nginx' || die "nginx hat die Konfiguration nicht angenommen — nichts neu geladen."
  kopfzeilen_pruefen
  exit $?
fi

# ------------------------------------------------------------- setup-key -----

if [ "$MODE" = setup-key ]; then
  pub="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"; pub="${pub/#\~/$HOME}.pub"
  [ -f "$pub" ] || die "$pub nicht gefunden. Erzeugen mit: ssh-keygen -t ed25519"
  info "Hinterlege $pub bei $REMOTE"
  if "${SSH[@]}" -T "$REMOTE" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$pub" 2>/dev/null; then
    info "Fertig. Jetzt DEPLOY_SSH_KEY in $ENV_FILE setzen und DEPLOY_SSH_PASS leeren."
    exit 0
  fi
  # Nimmt der Server nur Schluessel an, kommt dieser Weg nicht herein — dann
  # bleibt nur, den Key von Hand einzusetzen. Also wenigstens ausgeben.
  warn "Automatisches Hinterlegen fehlgeschlagen (der Server laesst vermutlich keinen Passwort-Login zu)."
  printf '\nDiese eine Zeile auf dem Server an ~/.ssh/authorized_keys von %s anhaengen\n' "$DEPLOY_USER"
  printf 'ueber die Hetzner-Konsole oder einen Rechner, der schon hereinkommt:\n\n'
  cat "$pub"
  printf '\nDort:  mkdir -p ~/.ssh && chmod 700 ~/.ssh\n'
  printf '       echo "<Zeile>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys\n\n'
  exit 1
fi

# ------------------------------------------------------------------- Bau -----

if [ "$BUILD" -eq 1 ]; then
  info "Baue: $DEPLOY_BUILD_CMD"
  ( cd "$SCRIPT_DIR/frontend" && eval "$DEPLOY_BUILD_CMD" )
fi

[ -f "$DEPLOY_DIST/index.html" ] || die "$DEPLOY_DIST/index.html fehlt — erst bauen (ohne --no-build)."

# Rechtstexte mit offenen Platzhaltern gehen nicht raus.
#
# Der Abschnitt ueber die Verarbeitung in den USA traegt Stellen in doppelten
# eckigen Klammern, die nur ein Mensch fuellen kann: Firmierung des
# Rechenanbieters, Auftragsverarbeitungsvertrag, Zertifizierung. Stehen die
# noch da, ist der Text nicht fertig — und eine Datenschutzerklaerung, in der
# „[[FIRMIERUNG …]]" steht, ist schlimmer als keine neue.
#
# Die Pruefung laeuft gegen den **Bau**, nicht gegen die Quelle: nur was
# wirklich hochgeht, zaehlt.
for rechtstext in "$DEPLOY_DIST"/datenschutz.html "$DEPLOY_DIST"/impressum.html; do
  [ -f "$rechtstext" ] || continue
  if grep -q '\[\[' "$rechtstext"; then
    die "$(basename "$rechtstext") enthaelt noch Platzhalter:
$(grep -o '\[\[[^]]*\]\]' "$rechtstext" | sed 's/^/    /')
  Erst ausfuellen, dann deployen."
  fi
done

# Ohne die Modelle bietet die Seite keinen Trennmodus an; ein halber Upload
# faellt sonst erst im Browser auf.
[ -d "$DEPLOY_DIST/models" ] || warn "$DEPLOY_DIST/models fehlt — die Oberflaeche wird keine Trennung anbieten."

info "Verbindung zu $REMOTE ($AUTH)"
probe=$("${SSH[@]}" -T "$REMOTE" "test -w '$DEPLOY_TARGET' && echo OK || echo NOWRITE" 2>&1) || true

case "$probe" in
  *OK*)
    ;;
  *NOWRITE*)
    die "Login steht, aber $DEPLOY_TARGET ist fuer $DEPLOY_USER nicht beschreibbar.
       Pruefen mit: ls -ld $DEPLOY_TARGET  (erwartet: $DEPLOY_USER:www-data, 755)"
    ;;
  *"Permission denied (publickey"*)
    die "Der Server nimmt nur Schluessel an, kein Passwort — DEPLOY_SSH_PASS hilft hier nicht.
       Einfachster Weg: einmal selbst anmelden mit  ./deploy.sh session  — danach
       laeuft das Deploy durch denselben Kanal, ohne Zugangsdaten im Script.
       Vorhandene Schluessel zeigt:   ssh -v $REMOTE 2>&1 | grep -i 'offering\|identity file'
       Liegt dein Schluessel woanders: DEPLOY_SSH_KEY=<pfad> in $ENV_FILE setzen.
       Noch gar keiner auf dem Server: Public Key ueber die Hetzner-Konsole
       (oder von einem Rechner, der schon reinkommt) in ~/.ssh/authorized_keys
       von $DEPLOY_USER eintragen."
    ;;
  *"Permission denied"*)
    die "Login abgelehnt: $probe"
    ;;
  *)
    die "Verbindung zu $REMOTE fehlgeschlagen: ${probe:-keine Antwort}"
    ;;
esac

# Gefragt wird vor dem Upload, damit danach nichts mehr auf eine Eingabe wartet.
if [ "$RELOAD_NGINX" -eq 1 ]; then
  sudo_passwort_holen "--reload-nginx"
fi

# ---------------------------------------------------------------- Upload -----
#
# -rlt statt -a: Besitzer, Gruppe und lokale Rechte bleiben draussen, nginx
# bekommt stattdessen feste 755/644. .well-known gehoert certbot, nicht dem
# Bau — --delete darf es nicht wegraeumen.
#
# cloud.json ebenso: im Bau steht sie mit leeren Werten, auf dem Server mit
# Adresse und Token des Trennendpunkts. Ohne diese Ausnahme wuerde jeder
# Deploy den Serverweg abschalten, und zwar lautlos — die Seite verhielte
# sich dann einfach so, als gaebe es ihn nicht.

RSYNC=(rsync -rlt --human-readable --info=stats1 --chmod=D755,F644 \
       --exclude='.well-known' --exclude='cloud.json')
# Fortschrittsbalken nur im Terminal — in einem Log waere er nur Rauschen.
[ -t 1 ] && RSYNC+=(--info=progress2)
[ "$DELETE" -eq 1 ] && RSYNC+=(--delete)
[ "$DRYRUN" -eq 1 ] && RSYNC+=(--dry-run --itemize-changes --info=name1)
RSYNC+=(-e "$(printf '%q ' "${SSH[@]}")")

info "Uebertrage $DEPLOY_DIST/ -> $REMOTE:$DEPLOY_TARGET"
[ "$DRYRUN" -eq 1 ] && info "(Probelauf, es wird nichts geschrieben)"
"${RSYNC[@]}" "$DEPLOY_DIST/" "$REMOTE:$DEPLOY_TARGET"

# cloud.json: nur anlegen, nie ueberschreiben.
#
# Der Abgleich oben laesst sie aus, damit ein Deploy nicht die auf dem
# Server hinterlegte Fassung mit Adresse und Token plattmacht. Genau das
# hiesse aber auch: auf einem Server, der sie noch nicht hat, kaeme sie nie
# an — und die Seite fragte bei jedem Aufruf eine Datei ab, die es nicht
# gibt. Ein 404 in jedem Protokoll, bei jedem Besucher.
#
# Deshalb ein zweiter, winziger Abgleich mit --ignore-existing: fehlt sie,
# wird die leere Fassung aus dem Bau hinterlegt; ist sie da, bleibt sie
# unangetastet. --delete steht hier bewusst nicht dabei.
if [ -f "$DEPLOY_DIST/cloud.json" ]; then
  info "cloud.json anlegen, falls sie dort fehlt"
  rsync -rlt --chmod=F644 --ignore-existing \
    -e "$(printf '%q ' "${SSH[@]}")" \
    $([ "$DRYRUN" -eq 1 ] && printf '%s' --dry-run) \
    "$DEPLOY_DIST/cloud.json" "$REMOTE:$DEPLOY_TARGET"
fi

if [ "$DRYRUN" -eq 1 ]; then
  info "Probelauf beendet."
  exit 0
fi

# ------------------------------------------------------------ nginx/Cache ----

if [ "$RELOAD_NGINX" -eq 1 ]; then
  info "nginx -t && systemctl reload nginx"
  sudo_fern 'nginx -t && systemctl reload nginx'
fi

# Cloudflare steht davor: ohne Purge sehen Besucher den alten Bau noch eine
# Weile. Nur wenn Token und Zone hinterlegt sind.
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ZONE_ID:-}" ]; then
  info "Leere den Cloudflare-Cache"
  curl -fsS -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data '{"purge_everything":true}' >/dev/null \
    && info "Cache geleert" || warn "Cache-Purge fehlgeschlagen"
fi

# ------------------------------------------------------------------ Probe ----

# Modul-Scripts muessen als JavaScript ankommen. Liefert nginx sie als
# application/octet-stream — .mjs fehlt in seiner mime.types —, verweigert der
# Browser den Import, und die Oberflaeche bietet keine Hardware-Auswahl an.
mjs=$(cd "$DEPLOY_DIST" && find . -name '*.mjs' -printf '%P\n' 2>/dev/null | head -1)
if [ -n "$mjs" ]; then
  ct=$(curl -sI --max-time 20 "${DEPLOY_URL%/}/$mjs" \
       | awk 'BEGIN{IGNORECASE=1} /^content-type:/{print tolower($2)}' | tr -d '\r')
  case "$ct" in
    *javascript*) info "Content-Type von .mjs: $ct" ;;
    '')           warn "Content-Type von /$mjs nicht feststellbar." ;;
    *)            warn "/$mjs kommt als '$ct' statt JavaScript.
       Der Browser lehnt das Modul ab — die Hardware-Auswahl fehlt dann.
       In /etc/nginx/sites-enabled/mixapart.de im server-Block ergaenzen,
       oberhalb des bestehenden Asset-Blocks:

           location ~* \\.mjs\$ {
               types { }
               default_type text/javascript;
               expires 7d;
           }

       Danach: sudo nginx -t && sudo systemctl reload nginx" ;;
  esac
fi

info "Pruefe $DEPLOY_URL"
if code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$DEPLOY_URL"); then
  [ "$code" = 200 ] && info "Antwort $code — fertig." || warn "Antwort $code (Zertifikat, Cloudflare-SSL-Modus oder nginx pruefen)"
else
  warn "$DEPLOY_URL nicht erreichbar — DNS, Zertifikat oder nginx pruefen."
fi

# Zum Schluss: liefert die Seite ihre Sicherheitskopfzeilen? Ein Deploy, der
# daran scheitert, ist trotzdem ein gelungener Deploy — die Dateien liegen
# oben. Deshalb nur eine Warnung und kein Abbruch.
kopfzeilen_pruefen || true
