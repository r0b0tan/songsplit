#!/usr/bin/env bash
#
# songsplit einrichten: alles, was ein frischer Klon braucht.
#
#   ./install.sh           Backend, Frontend, Runtime und Gewichte
#   ./install.sh --cpu     Torch ohne CUDA (spart rund 3 GB Download)
#   ./install.sh --check   nur nachsehen, was fehlt — nichts tun
#   ./install.sh --force   auch das neu machen, was schon da ist
#
# Nicht alles liegt im Repo: die exportierten Modellgewichte (289 MB) und
# die vendorierte ONNX-Runtime (29 MB) sind erzeugtes Beiwerk und stehen
# in .gitignore, samt Begruendung. Dieses Skript stellt sie her. Es laeuft
# mehrfach ohne Schaden: was schon da ist, wird uebersprungen.
#
# Dauer beim ersten Mal: der Torch-Download bestimmt sie. Mit CUDA etwa
# 3 GB, dazu rund 170 MB Demucs-Gewichte je Modell.

set -uo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
venv=$root/.venv
py=$venv/bin/python
pip=$venv/bin/pip

requirements=requirements.txt
check_only=0
force=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --cpu)     requirements=requirements-cpu.txt ;;
    --check)   check_only=1 ;;
    --force)   force=1 ;;
    -h|--help) sed -n '3,16p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; exit 0 ;;
    *)         echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
  shift
done

# ----------------------------------------------------------------- Ausgabe
if [[ -t 1 ]]; then
  dim=$'\e[2m'; bold=$'\e[1m'; red=$'\e[31m'; grn=$'\e[32m'; ylw=$'\e[33m'; off=$'\e[0m'
else
  dim=''; bold=''; red=''; grn=''; ylw=''; off=''
fi

schritt=0
step() { schritt=$((schritt + 1)); printf '\n%s%d/6 %s%s\n' "$bold" "$schritt" "$*" "$off"; }
note() { printf '  %s%s%s\n' "$dim" "$*" "$off"; }
ok()   { printf '  %s✓%s %s\n' "$grn" "$off" "$*"; }
warn() { printf '  %s!%s %s\n' "$ylw" "$off" "$*"; }
die()  { printf '\n%s%sAbbruch:%s %s\n' "$red" "$bold" "$off" "$*" >&2; exit 1; }

# Fehlt etwas, oder soll es neu? Dann tun, sonst melden und weiter.
fehlt=0
noetig() {
  local was=$1 pfad=$2
  if [[ $force -eq 1 ]]; then return 0; fi
  if [[ -e $pfad ]]; then ok "$was liegt bereit"; return 1; fi
  fehlt=$((fehlt + 1))
  return 0
}

# Fuehrt aus — es sei denn, es wird nur nachgesehen.
tun() {
  if [[ $check_only -eq 1 ]]; then note "wuerde laufen: $*"; return 0; fi
  "$@" || die "fehlgeschlagen: $*"
}

# ------------------------------------------------------- 1. Vorbedingungen
step "Werkzeuge pruefen"

have() { command -v "$1" >/dev/null 2>&1; }

have python3 || die "python3 fehlt. Gebraucht wird 3.10 oder neuer (nicht 3.14.1)."
pyver=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 - <<'PY' || die "Python $pyver ist zu alt oder ausgeschlossen. Gebraucht wird >=3.10, nicht 3.14.1."
import sys
v = sys.version_info[:3]
raise SystemExit(0 if v >= (3, 10) and v[:3] != (3, 14, 1) else 1)
PY
ok "Python $pyver"

have node || die "node fehlt. Angular 22 verlangt Node 20 oder neuer."
nodever=$(node -p 'process.versions.node')
node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
  || die "Node $nodever ist zu alt. Gebraucht wird 20 oder neuer."
ok "Node $nodever"

have npm || die "npm fehlt."

if have ffmpeg; then
  ok "FFmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
else
  # Kein Abbruch: ohne FFmpeg laeuft alles ausser dem Lesen von MP3 im
  # Backend. Wer nur die oeffentliche Variante baut, braucht es nie.
  warn "FFmpeg fehlt. Das Backend liest MP3 darueber — WAV geht auch ohne."
fi

# ------------------------------------------------------------- 2. Backend
step "Python-Umgebung"
if noetig ".venv" "$py"; then
  note "lege .venv an"
  tun python3 -m venv "$venv"
fi
# Gefragt wird die Umgebung selbst, nicht ein Merkzettel daneben: eine
# Datei, die „installiert" behauptet, kann richtig liegen und trotzdem
# falsch sein — ein Import kann das nicht.
if [[ $force -eq 1 ]] || ! "$py" -c 'import torch, audio_separator' 2>/dev/null; then
  fehlt=$((fehlt + 1))
  note "installiere backend/$requirements (beim ersten Mal gross)"
  tun "$pip" install --upgrade pip --quiet
  tun "$pip" install -r "$root/backend/$requirements"
else
  ok "Torch und audio-separator sind einsatzbereit"
fi

# ------------------------------------------- 3. Demucs-Gewichte fuer Torch
step "Demucs-Gewichte holen"
note "Quelle fuer den Export und fuer den lokalen Trennweg"
if noetig "models/htdemucs.yaml" "$root/models/htdemucs.yaml" ||
   noetig "models/htdemucs_6s.yaml" "$root/models/htdemucs_6s.yaml"; then
  tun "$py" "$root/backend/tools/fetch_model_configs.py" htdemucs htdemucs_6s
fi

# ------------------------------------------------------------ 4. Frontend
step "npm-Pakete"
if noetig "frontend/node_modules" "$root/frontend/node_modules"; then
  tun npm --prefix "$root/frontend" install
fi

# ------------------------------------------------------------- 5. Runtime
step "ONNX-Runtime vendorieren"
note "liegt nicht im Repo, siehe .gitignore"
if noetig "public/vendor/onnxruntime" "$root/frontend/public/vendor/onnxruntime/runtime.json"; then
  tun npm --prefix "$root/frontend" run vendor:ort
fi

# ------------------------------------------------------------ 6. Gewichte
step "Modelle nach ONNX exportieren"
note "289 MB, liegen nicht im Repo — der Export prueft sich gegen Torch"
for modell in htdemucs htdemucs_6s; do
  ziel=$root/frontend/public/models
  gefunden=$(find "$ziel" -maxdepth 2 -name manifest.json -path "*$modell-*" 2>/dev/null | head -1)
  if [[ $force -eq 1 || -z $gefunden ]]; then
    fehlt=$((fehlt + 1))
    note "exportiere $modell"
    tun "$py" "$root/backend/tools/export_htdemucs_onnx.py" "$modell"
  else
    ok "$modell exportiert"
  fi
done

# -------------------------------------------------------------- Abschluss
if [[ $check_only -eq 1 ]]; then
  printf '\n%s%s%s\n' "$bold" \
    "$([[ $fehlt -eq 0 ]] && echo 'Alles da. ./start.sh startet.' \
       || echo "$fehlt Schritt(e) fehlen. ./install.sh macht sie.")" "$off"
  exit 0
fi

printf '\n%sFertig.%s Starten mit:\n' "$bold" "$off"
printf '  ./start.sh            %slokale Variante, Backend und Oberflaeche%s\n' "$dim" "$off"
printf '  ./start.sh --public   %snur der Browser, ohne Backend%s\n' "$dim" "$off"
