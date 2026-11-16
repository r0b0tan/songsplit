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

# Das sudo-Passwort wird abgefragt, nicht gespeichert — gefragt wird vor dem
# Upload, damit danach nichts mehr auf eine Eingabe wartet.
if [ "$RELOAD_NGINX" -eq 1 ] && [ -z "$DEPLOY_SUDO_PASS" ]; then
  if [ -t 0 ]; then
    printf 'sudo-Passwort fuer %s auf %s: ' "$DEPLOY_USER" "$DEPLOY_HOST" >&2
    IFS= read -rs DEPLOY_SUDO_PASS || true
    printf '\n' >&2
    [ -n "$DEPLOY_SUDO_PASS" ] || die "Kein Passwort eingegeben."
  else
    die "--reload-nginx braucht ein sudo-Passwort: im Terminal starten oder DEPLOY_SUDO_PASS in $ENV_FILE setzen."
  fi
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

if [ "$DRYRUN" -eq 1 ]; then
  info "Probelauf beendet."
  exit 0
fi

# ------------------------------------------------------------ nginx/Cache ----

if [ "$RELOAD_NGINX" -eq 1 ]; then
  info "nginx -t && systemctl reload nginx"
  # Ein einziger sudo-Aufruf, das Passwort kommt ueber stdin statt als Argument.
  printf '%s\n' "$DEPLOY_SUDO_PASS" \
    | "${SSH[@]}" -T "$REMOTE" 'sudo -S -p "" sh -c "nginx -t && systemctl reload nginx"'
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
