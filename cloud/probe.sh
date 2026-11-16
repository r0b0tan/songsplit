#!/usr/bin/env bash
#
# probe.sh — den Modal-Endpunkt einmal ganz durchspielen.
#
# Hochladen, warten, Spuren holen. Dasselbe, was das Handy spaeter tut, nur
# im Terminal und mit Zwischenstand auf dem Schirm.
#
#   cloud/probe.sh https://wutzewatz--mixapart-api.modal.run
#   cloud/probe.sh https://… "testmusik/anderer song.mp3"

set -euo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

URL="${1:-}"
AUDIO="${2:-testmusik/Minenwerfer - Tiroler Edelweiß.mp3}"
OUT="cloud/out"

die()  { printf '\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

[ -n "$URL" ] || die "Aufruf: cloud/probe.sh <URL> [audiodatei]"
[ -f cloud/.token ] || die "cloud/.token fehlt. Siehe cloud/app.py, Abschnitt Einrichten."
[ -f "$AUDIO" ] || die "Keine Datei: $AUDIO"

URL="${URL%/}"
TOKEN="$(cat cloud/.token)"
KOPF=(-H "X-Mixapart-Token: $TOKEN")

# Ein Feld aus einer JSON-Antwort holen. python3 statt jq, weil python3
# ohnehin da ist und jq nicht auf jedem Rechner.
feld() { python3 -c "import json,sys; print(json.load(sys.stdin).get(sys.argv[1],''))" "$1"; }

# ------------------------------------------------------------------ lebt es?

info "Erreichbarkeit"
GESUND="$(curl -fsS "${KOPF[@]}" "$URL/health")" || die "$URL antwortet nicht."
echo "    $GESUND"

# ------------------------------------------------------------------ abgeben

info "Hochladen: $(basename "$AUDIO") ($(du -h "$AUDIO" | cut -f1))"
ANTWORT="$(curl -fsS -X POST "${KOPF[@]}" -F "datei=@$AUDIO" "$URL/separate")" \
  || die "Der Upload wurde abgewiesen."
JOB="$(printf '%s' "$ANTWORT" | feld job)"
[ -n "$JOB" ] || die "Keine Auftragskennung in der Antwort: $ANTWORT"
echo "    Auftrag $JOB"

# ------------------------------------------------------------------- warten

info "Trennen — der erste Lauf zahlt den Cold Start mit"
BEGONNEN=$SECONDS
PAUSE=2
while :; do
  STAND="$(curl -fsS "${KOPF[@]}" "$URL/status/$JOB")" || die "Nachfragen schlug fehl."
  ZUSTAND="$(printf '%s' "$STAND" | feld zustand)"
  case "$ZUSTAND" in
    laeuft)
      PHASE="$(printf '%s' "$STAND" | feld phase)"
      case "$PHASE" in
        # Der aufschlussreiche Fall: der Auftrag liegt bei Modal, aber es
        # laeuft noch kein Container. Meist der Cold Start, manchmal eine
        # Warteschlange, weil gerade keine Karte frei ist.
        angenommen) WAS="wartet auf einen Container" ;;
        dekodieren) WAS="liest die Datei" ;;
        trennen)
          BLOCK="$(printf '%s' "$STAND" | feld block)"
          BLOECKE="$(printf '%s' "$STAND" | feld blocks)"
          KARTE="$(printf '%s' "$STAND" | feld karte)"
          PROZENT="$(printf '%s' "$STAND" | feld prozent)"
          REST="$(printf '%s' "$STAND" | feld rest)"
          WAS="Block ${BLOCK:-0}/${BLOECKE:-?}${KARTE:+ auf $KARTE}"
          [ -n "$PROZENT" ] && WAS="${PROZENT} %  $WAS"
          [ -n "$REST" ] && WAS="$WAS, noch ~${REST}s"
          ;;
        kodieren)   WAS="schreibt die Spuren" ;;
        *)          WAS="$PHASE" ;;
      esac
      printf '\r    %3ds   %-52s' "$((SECONDS - BEGONNEN))" "$WAS"
      sleep "$PAUSE"
      # Langsamer nachfragen, je laenger es dauert. Jede Nachfrage weckt
      # den Web-Container; im Minutentakt zu fragen, waehrend auf eine
      # Karte gewartet wird, waere Rechenzeit fuer nichts.
      [ "$PAUSE" -lt 10 ] && PAUSE=$((PAUSE + 1))
      ;;
    fertig) printf "\r    %3ds   fertig%*s\n" "$((SECONDS - BEGONNEN))" 52 ""; break ;;
    fehler) printf '\n'; die "$(printf '%s' "$STAND" | feld grund)" ;;
    *)      printf '\n'; die "Unerwartete Antwort: $STAND" ;;
  esac
done

echo "    $(printf '%s' "$STAND" | python3 -c "
import json,sys
d=json.load(sys.stdin)
z=d.get('zeiten',{})
print(f\"{d.get('seconds','?')} s Musik — dekodieren {z.get('dekodieren','?')} s, \"
      f\"trennen {z.get('trennen','?')} s, kodieren {z.get('kodieren','?')} s\")
")"

# -------------------------------------------------------------------- holen

mkdir -p "$OUT/$JOB"
info "Spuren holen nach $OUT/$JOB/"
printf '%s' "$STAND" | python3 -c "
import json,sys
for s in json.load(sys.stdin)['stems']:
    print(s['slug'], s['label'], s['bytes'])
" | while read -r SLUG LABEL BYTES; do
  curl -fsS "${KOPF[@]}" -o "$OUT/$JOB/$SLUG.mp3" "$URL/stem/$JOB/$SLUG"
  printf '    %-8s %-10s %s\n' "$SLUG" "$LABEL" "$(du -h "$OUT/$JOB/$SLUG.mp3" | cut -f1)"
done

echo
info "Durch. Anhoeren:  ffplay '$OUT/$JOB/vocals.mp3'"
