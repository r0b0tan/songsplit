#!/usr/bin/env bash
#
# deploy.sh — baut die oeffentliche Variante und spielt sie nach mixapart.de.
#
# Die Zugangsdaten stehen in .env.deploy daneben, nicht hier und nicht in Git.
# Vorlage: .env.deploy.example
#
# Aufruf:
#   ./deploy.sh                  bauen, hochladen, pruefen
#   ./deploy.sh -n               nur zeigen, was rsync tun wuerde
#   ./deploy.sh --no-build       vorhandenes dist/ nehmen
#   ./deploy.sh --no-delete      Fremddateien im Ziel stehen lassen
#   ./deploy.sh --reload-nginx   danach nginx -t && systemctl reload nginx (braucht sudo-Passwort)
#   ./deploy.sh setup-key        eigenen SSH-Schluessel hinterlegen, danach ist das Passwort entbehrlich
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEPLOY_ENV:-$SCRIPT_DIR/.env.deploy}"

BUILD=1
DELETE=1
DRYRUN=0
RELOAD_NGINX=0
MODE=deploy

die()  { printf '\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mHinweis:\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    setup-key)      MODE=setup-key ;;
    --no-build)     BUILD=0 ;;
    --no-delete)    DELETE=0 ;;
    -n|--dry-run)   DRYRUN=1 ;;
    --reload-nginx) RELOAD_NGINX=1 ;;
    -h|--help)      sed -n '3,15p' "$0" | sed 's/^#\{1\} \{0,1\}//;s/^#$//'; exit 0 ;;
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

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

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

# --------------------------------------------------------- Authentifizierung -
#
# Mit Schluessel laeuft alles ohne Passwort. Ohne Schluessel springt sshpass
# ein; das Passwort geht dabei ueber die Umgebung (-e), damit es nicht in der
# Prozessliste des Rechners auftaucht.

SSH_OPTS=(-p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "$DEPLOY_SSH_KEY" ] && [ -f "${DEPLOY_SSH_KEY/#\~/$HOME}" ]; then
  SSH_OPTS+=(-i "${DEPLOY_SSH_KEY/#\~/$HOME}" -o IdentitiesOnly=yes)
  SSH=(ssh "${SSH_OPTS[@]}")
  AUTH="Schluessel $DEPLOY_SSH_KEY"
elif [ -n "$DEPLOY_SSH_PASS" ]; then
  command -v sshpass >/dev/null || die "sshpass fehlt (apt install sshpass) — oder DEPLOY_SSH_KEY setzen."
  export SSHPASS="$DEPLOY_SSH_PASS"
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
  AUTH="Passwort aus $ENV_FILE"
else
  die "Weder DEPLOY_SSH_KEY noch DEPLOY_SSH_PASS gesetzt."
fi
REMOTE="$DEPLOY_USER@$DEPLOY_HOST"

# ------------------------------------------------------------- setup-key -----

if [ "$MODE" = setup-key ]; then
  pub="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"; pub="${pub/#\~/$HOME}.pub"
  [ -f "$pub" ] || die "$pub nicht gefunden. Erzeugen mit: ssh-keygen -t ed25519"
  info "Hinterlege $pub bei $REMOTE"
  "${SSH[@]}" -T "$REMOTE" 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$pub"
  info "Fertig. Jetzt DEPLOY_SSH_KEY in $ENV_FILE setzen und DEPLOY_SSH_PASS leeren."
  exit 0
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
"${SSH[@]}" -T -o BatchMode=no "$REMOTE" "test -w '$DEPLOY_TARGET'" \
  || die "$DEPLOY_TARGET auf $DEPLOY_HOST nicht beschreibbar (oder Login fehlgeschlagen)."

# ---------------------------------------------------------------- Upload -----
#
# -rlt statt -a: Besitzer, Gruppe und lokale Rechte bleiben draussen, nginx
# bekommt stattdessen feste 755/644. .well-known gehoert certbot, nicht dem
# Bau — --delete darf es nicht wegraeumen.

RSYNC=(rsync -rlt --human-readable --info=stats1 --chmod=D755,F644 --exclude='.well-known')
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
  [ -n "$DEPLOY_SUDO_PASS" ] || die "--reload-nginx braucht DEPLOY_SUDO_PASS in $ENV_FILE."
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

info "Pruefe $DEPLOY_URL"
if code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$DEPLOY_URL"); then
  [ "$code" = 200 ] && info "Antwort $code — fertig." || warn "Antwort $code (Zertifikat, Cloudflare-SSL-Modus oder nginx pruefen)"
else
  warn "$DEPLOY_URL nicht erreichbar — DNS, Zertifikat oder nginx pruefen."
fi
