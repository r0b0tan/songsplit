#!/usr/bin/env bash
#
# MixApart starten: Backend und Frontend in einem Terminal.
#
#   ./start.sh           Geraet automatisch (GPU, wenn vorhanden)
#   ./start.sh --cpu     CPU erzwingen
#   ./start.sh --gpu     GPU verlangen
#   ./start.sh --open    danach den Browser oeffnen
#   ./start.sh --public  nur die Oberflaeche, oeffentliche Variante,
#                        ohne Backend (alles im Browser auf WebGPU)
#
# Strg-C beendet beide wieder. Laeuft eines von beiden schon, wird es
# mitbenutzt statt ein zweites Mal gestartet.
#
# Die vollstaendige Ausgabe steht in .run/api.log und .run/web.log.

set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
logdir=$root/.run

api_port=${MIXAPART_PORT:-8000}
ui_port=${MIXAPART_UI_PORT:-4200}
api=http://127.0.0.1:$api_port
ui=http://127.0.0.1:$ui_port

open_browser=0
public=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --cpu)        export MIXAPART_DEVICE=cpu ;;
    --gpu|--cuda) export MIXAPART_DEVICE=cuda ;;
    --open)       open_browser=1 ;;
    --public)     public=1 ;;
    -h|--help)    sed -n '3,15p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0 ;;
    *)            echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
  shift
done

# ----------------------------------------------------------------- Ausgabe
if [[ -t 1 ]]; then
  dim=$'\e[2m'; bold=$'\e[1m'; red=$'\e[31m'
  c_api=$'\e[38;5;72m'; c_web=$'\e[38;5;68m'; off=$'\e[0m'
else
  dim=''; bold=''; red=''; c_api=''; c_web=''; off=''
fi

note() { printf '%s%s%s\n' "$dim" "$*" "$off"; }
die()  { printf '%s%sAbbruch:%s %s\n' "$red" "$bold" "$off" "$*" >&2; exit 1; }

# Haengt jeder Zeile eines Logs ein eingefaerbtes Kuerzel voran.
follow() {
  local color=$1 tag=$2 file=$3
  tail -n 0 -F "$file" 2>/dev/null | while IFS= read -r line; do
    printf '%s%s%s %s\n' "$color" "$tag" "$off" "$line"
  done
}

# ------------------------------------------------------------ Vorbedingungen
python=$root/.venv/bin/python
ng=$root/frontend/node_modules/.bin/ng

if [[ $public -eq 0 ]]; then
  [[ -x $python ]] || die "Kein venv unter .venv/ — anlegen mit:
  python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
fi
[[ -x $ng ]] || die "Frontend ohne Abhaengigkeiten — anlegen mit:
  (cd frontend && npm install)"

if [[ $api_port != 8000 ]]; then
  note "Hinweis: frontend/proxy.conf.json zeigt fest auf 127.0.0.1:8000."
  note "Mit MIXAPART_PORT=$api_port findet die Oberflaeche die API nicht."
fi

# Laeuft da schon etwas, und ist es unseres?
port_busy()  { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
api_is_ours() { curl -fsS -m 2 "$api/api/health" 2>/dev/null | grep -q '"ok"'; }
ui_is_ours()  { curl -fsS -m 3 "$ui" 2>/dev/null | grep -q '<app-root>'; }

# Die oeffentliche Variante hat kein Backend — es wird weder gestartet noch
# gesucht noch abgefragt.
start_api=$(( public == 0 ? 1 : 0 ))
start_ui=1

if [[ $start_api -eq 1 ]] && port_busy "$api_port"; then
  api_is_ours || die "Port $api_port ist belegt, aber dort antwortet nicht die MixApart-API."
  start_api=0
  note "Backend laeuft bereits auf :$api_port — wird mitbenutzt."
fi
if port_busy "$ui_port"; then
  ui_is_ours || die "Port $ui_port ist belegt, aber dort liegt nicht die MixApart-Oberflaeche."
  start_ui=0
  note "Frontend laeuft bereits auf :$ui_port — wird mitbenutzt."
fi

# ---------------------------------------------------------------- Aufraeumen
servers=()
tails=()

cleanup() {
  trap - INT TERM EXIT
  [[ ${#servers[@]} -eq 0 && ${#tails[@]} -eq 0 ]] && return 0
  printf '\n'
  note 'beenden …'
  for pid in ${tails[@]+"${tails[@]}"}; do kill "$pid" 2>/dev/null; done
  for pid in ${servers[@]+"${servers[@]}"}; do kill "$pid" 2>/dev/null; done
  # Freiwillig gehen lassen, erst danach nachhelfen.
  for _ in $(seq 20); do
    local alive=0
    for pid in ${servers[@]+"${servers[@]}"}; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [[ $alive -eq 0 ]] && break
    sleep 0.25
  done
  for pid in ${servers[@]+"${servers[@]}"}; do kill -9 "$pid" 2>/dev/null; done
  wait 2>/dev/null
}

# Nach einem Signal muss der Durchlauf auch enden. Ohne das eigene `exit`
# kehrt bash aus dem Handler in die Warteschleife zurueck und laeuft weiter.
on_signal() { cleanup; exit 0; }
trap on_signal INT TERM
trap cleanup EXIT

# ------------------------------------------------------------------- Starten
mkdir -p "$logdir"

if [[ $start_api -eq 1 ]]; then
  : > "$logdir/api.log"
  ( cd "$root/backend" && exec "$python" run.py ) >>"$logdir/api.log" 2>&1 &
  servers+=($!)
  follow "$c_api" 'api' "$logdir/api.log" & tails+=($!)
fi

if [[ $start_ui -eq 1 ]]; then
  : > "$logdir/web.log"
  if [[ $public -eq 1 ]]; then
    ( cd "$root/frontend" && exec "$ng" serve --configuration public \
        --port "$ui_port" ) >>"$logdir/web.log" 2>&1 &
  else
    ( cd "$root/frontend" && exec "$ng" serve --port "$ui_port" ) >>"$logdir/web.log" 2>&1 &
  fi
  servers+=($!)
  follow "$c_web" 'web' "$logdir/web.log" & tails+=($!)
fi

# ------------------------------------------------------------------- Warten
wait_for() {
  local what=$1 probe=$2 seconds=${3:-90}
  for _ in $(seq $((seconds * 2))); do
    $probe && return 0
    # Ist der Server unterwegs gestorben, hat Warten keinen Sinn mehr.
    for pid in ${servers[@]+"${servers[@]}"}; do
      kill -0 "$pid" 2>/dev/null || return 1
    done
    sleep 0.5
  done
  printf '%s%s antwortet nach %s s noch nicht.%s\n' "$dim" "$what" "$seconds" "$off"
  return 1
}

if [[ $public -eq 0 ]]; then
  wait_for 'Backend' api_is_ours 60 || die "Backend kam nicht hoch. Log: $logdir/api.log"
fi
wait_for 'Frontend' ui_is_ours 120 || die "Frontend kam nicht hoch. Log: $logdir/web.log"

if [[ $public -eq 1 ]]; then
  # Worauf im Browser gerechnet wird, weiss nur der Browser. Die Seite sagt
  # es hinter dem (i) in der Importkarte.
  device='im Browser (WebGPU)'
else
  device=$(curl -fsS -m 2 "$api/api/health" | sed -n 's/.*"effective":"\([^"]*\)".*/\1/p')
fi

if [[ ${#servers[@]} -eq 0 ]]; then
  hint='laeuft schon, dieses Fenster wird nicht gebraucht'
else
  hint='Strg-C beendet'
fi
printf '\n  %sMixApart%s   %s   %sGeraet %s · %s%s\n\n' \
  "$bold" "$off" "$ui" "$dim" "${device:-unbekannt}" "$hint" "$off"

if [[ $open_browser -eq 1 ]]; then
  for opener in wslview xdg-open open; do
    command -v "$opener" >/dev/null && { "$opener" "$ui" >/dev/null 2>&1 & break; }
  done
fi

# Stand beides schon, gibt es nichts zu bewachen.
[[ ${#servers[@]} -eq 0 ]] && exit 0

# Laufen lassen, bis einer der beiden aufgibt oder Strg-C kommt.
while true; do
  for pid in ${servers[@]+"${servers[@]}"}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '\n%sEin Dienst hat sich beendet. Logs: %s%s\n' "$red" "$logdir" "$off"
      exit 1
    fi
  done
  sleep 1
done
