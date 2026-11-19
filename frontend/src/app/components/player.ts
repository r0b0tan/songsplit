import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  LOOP_MIN_SECONDS,
  type LoopRange,
  MASTER_RATE_MAX,
  MASTER_RATE_MIN,
  MixEngine,
  SEMITONE_RANGE,
  SOLO_RATE_MAX,
  SOLO_RATE_MIN,
  type TrackView,
} from '../audio/mix-engine';
import { IconComponent } from '../core/icon';
import { RangeScrollGuard } from '../core/range-scroll-guard';
import type { Job } from '../core/models';
import { stemColor } from '../core/stem-colors';
import { shortStemName } from '../core/stem-name';
import { StemStore } from '../separate/stem-store';
import { downloadWav } from '../separate/wav';
import { TimeRulerComponent } from './time-ruler';
import { WaveformComponent } from './waveform';

/**
 * Das Deck: ein Song, alle Spuren untereinander, eine gemeinsame Zeitachse.
 *
 * Der Aufbau folgt dem, was beim Ueben gebraucht wird, von oben nach unten:
 * welcher Song, wo stehe ich, welche Spuren hoere ich, welchen Takt uebe ich.
 * Die Wellenformen liegen in einer Spalte uebereinander, damit dieselbe
 * Songsekunde in jeder Spur an derselben Stelle liegt.
 *
 * Die Reglerspalte zeigt nicht alles gleichzeitig. Immer sichtbar ist der
 * Pegel, denn den stellt man an jeder Spur ein. Die Tonhoehe erscheint, wenn
 * man den Spurnamen antippt (oder wenn sie nicht auf Null steht — eine
 * verstellte Tonhoehe darf nicht unsichtbar sein). Das Solo-Tempo erscheint
 * in der Zeile, die gerade allein zu hoeren ist: dort gehoert es hin, nicht
 * in eine Fusszeile, in der es von seiner Spur getrennt waere.
 */
/** Die beiden Enden des Loops — Reihenfolge wie in der Anzeige. */
type LoopEnd = 'a' | 'b';

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [IconComponent, RangeScrollGuard, TimeRulerComponent, WaveformComponent],
  styles: [
    `
      /* Der Host traegt den Container-Kontext, nicht das Deck selbst: eine
         Container-Abfrage greift nur auf Nachfahren, nie auf den Container.
         Die Breiten-Variablen stehen deshalb am Deck, der Kontext darueber. */
      :host {
        display: block;
        container-type: inline-size;
      }
      .deck {
        overflow: hidden;
        --label: 196px;
        --knobs: 190px;
        /* Breite und Rand der Speichern-Spalte. Sie stehen hier, weil die
           Kopfzeile dasselbe Mass braucht: nur wenn ihr leeres Feld genau
           so breit ist, liegt die Trennlinie oben ueber der unten. */
        --save-w: 26px;
        --save-pad: 9px;
        /* Die Spurhoehe teilt sich auf, was vom Fenster uebrig bleibt,
           wenn Kopf, Transport und Fuss ihren Platz haben. Geraten wird
           dabei nichts: --chrome ist gemessen (siehe Klasse), --lanes ist
           die Zahl der Spuren, und --deck-space ist genau die Hoehe, die
           der Dialog zulaesst. So sind die Bahnen so hoch wie moeglich und
           das Deck scrollt trotzdem nicht. Der Rueckfallwert gilt nur fuer
           den ersten Bildaufbau, bis gemessen ist. */
        --deck-space: calc(100dvh - 2 * clamp(8px, 2vh, 26px));
        --lane-h: clamp(
          66px,
          calc((var(--deck-space) - var(--chrome, 330px)) / var(--lanes, 6)),
          150px
        );
      }

      /* ------------------------------------------------------------- Song */
      .song {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 17px clamp(13px, 2.2vw, 19px) 15px;
        /* Ein schwacher Schein von der Ecke her: er setzt den Songkopf vom
           Bandwerk darunter ab, ohne eine weitere Linie zu ziehen. */
        background: radial-gradient(
            ellipse at 16% 0%,
            color-mix(in srgb, var(--accent) 7%, transparent),
            transparent 62%
          ),
          var(--panel);
      }
      .title {
        font-size: clamp(20px, 3cqw, 27px);
        font-weight: 680;
        letter-spacing: -0.035em;
        line-height: 1.07;
        margin: 5px 0 6px;
        overflow-wrap: anywhere;
      }
      .song-meta {
        display: flex;
        gap: 9px;
        flex-wrap: wrap;
        font: 11.5px/1.4 var(--mono);
        color: var(--dim);
        font-variant-numeric: tabular-nums;
      }
      .song-meta .sep {
        color: var(--edge);
      }

      .messages {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 0 clamp(13px, 2.2vw, 19px) 15px;
      }

      /* ----------------------------------------------------------- Warten */
      /* Die Hoehe ist grosszuegig, damit der Dialog beim Erscheinen des
         Decks nicht aus einem Streifen aufspringt. */
      .boot {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 11px;
        min-height: 210px;
        padding: 24px clamp(13px, 2.2vw, 19px) 34px;
        border-top: 1px solid var(--edge);
        background: var(--panel-2);
      }
      .boot-what {
        font-size: 13px;
        color: var(--dim);
      }

      /* -------------------------------------------------------- Transport */
      .transport {
        display: flex;
        gap: 11px 20px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 10px clamp(13px, 2.2vw, 19px);
        border-block: 1px solid var(--edge);
        background: var(--panel-2);
      }
      /* Die Transportzeichen sind Zeichen aus Lucide, keine Schriftzeichen:
         ▶ und ⏮ fehlen in manchen Systemschriften und erscheinen dann als
         leeres Kaestchen. */
      .play {
        min-width: 46px;
        display: grid;
        place-items: center;
        --icon-size: 17px;
        --icon-fill: currentColor;
      }
      .solid {
        --icon-fill: currentColor;
      }
      /* Zahl und Zeichen bilden eine Angabe: "zurueck, fuenf Sekunden". */
      .step {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-variant-numeric: tabular-nums;
        --icon-size: 13px;
        --icon-fill: currentColor;
      }
      .close {
        --icon-size: 16px;
      }
      .clock {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
        font: 14px/1 var(--mono);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        padding-inline: 7px 3px;
      }
      .clock small {
        color: var(--dim);
        font-size: 11.5px;
      }
      /* Der Loop-Schalter steht beim Transport, weil er zum Abspielen
         gehoert: er sagt, ob die Marken A und B gerade wirken. */
      .loop-switch {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font: 12px/1 var(--sans);
      }
      .loop-switch {
        --icon-size: 14px;
      }
      /* Welcher Hoerzustand gerade gilt — die eine Angabe, die man beim
         Ueben im Auge hat. */
      .mode {
        display: inline-flex;
        align-items: baseline;
        gap: 7px;
        min-width: 0;
      }
      .mode b {
        font: 600 12.5px/1.4 var(--mono);
        color: var(--accent);
        letter-spacing: -0.01em;
        max-width: 34ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tempo {
        width: min(100%, 250px);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .tempo-label {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        align-items: baseline;
      }

      /* -------------------------------------------------------- Workspace */
      .table-head,
      .track {
        display: grid;
        grid-template-columns: var(--label) minmax(0, 1fr) var(--knobs);
        align-items: stretch;
      }
      .table-head {
        border-bottom: 1px solid var(--edge);
        background: var(--bg);
      }
      .heading {
        padding: 8px 12px;
        align-self: center;
      }

      .track {
        border-bottom: 1px solid var(--edge-soft);
        min-height: var(--lane-h);
        background: var(--panel);
        transition: min-height 0.18s ease, background 0.18s ease;
      }
      /* Die Spur im Solo bekommt Platz: in ihrer Zeile steht jetzt auch das
         Solo-Tempo, und ihre Wellenform ist die, auf die man hoert. */
      .track.soloed {
        background: var(--tint);
        min-height: calc(var(--lane-h) + 46px);
      }

      .track-head {
        display: grid;
        grid-template-columns: 8px minmax(0, 1fr) auto;
        align-content: center;
        gap: 5px 7px;
        padding: 8px 11px;
      }
      .sig {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--sig);
        align-self: center;
      }
      .track.hushed .sig {
        background: var(--edge);
      }
      .track-head .buttons {
        display: flex;
        gap: 5px;
        align-self: center;
        --icon-size: 13px;
      }
      /* Der Name ist der Schalter fuer die Tonhoehe: er ist das groesste
         Ziel in der Zeile und braucht dafuer kein eigenes Symbol. */
      .track-name {
        min-width: 0;
        padding: 0;
        text-align: left;
        background: none;
        border: 0;
        min-height: 0;
        border-radius: 0;
        display: flex;
        /* Mittig, nicht auf der Grundlinie, und mittig in der Zeile.
           Der Name ist ein Schalter und damit hoeher als seine Schrift —
           mit dem Finger 30 Pixel, die Zeile daneben 36. Ohne diese beiden
           Zeilen klebt die Schrift oben in ihrem Kasten: der Name stuende
           dann ueber dem Punkt davor und ueber Mute und Solo daneben, die
           beide mittig sitzen. Am Rechner faellt das nicht auf, weil die
           Zeile dort nur so hoch ist wie ihr Inhalt. */
        align-items: center;
        align-self: center;
        gap: 4px;
      }
      /* Das Zeichen sagt, was hinter dem Namen steckt: die Tonhoehe. Ohne
         es waere der Schalter unsichtbar — ein Name sieht nicht nach
         Schalter aus. */
      .hash {
        font: 12px/1 var(--mono);
        color: var(--faint);
        flex: none;
      }
      .track-name[aria-pressed='true'] .hash,
      .track-name:hover:not(:disabled) .hash {
        color: var(--sig);
      }
      .track-name:hover:not(:disabled) strong {
        text-decoration: underline;
        text-decoration-color: var(--sig);
        text-underline-offset: 4px;
      }
      .track-name[aria-pressed='true'] {
        background: none;
        color: inherit;
      }
      .track-name[aria-pressed='true'] strong {
        text-decoration: underline 1.5px;
        text-decoration-color: var(--sig);
        text-underline-offset: 4px;
      }
      .track-head strong {
        display: block;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .track.hushed .track-head strong {
        color: var(--dim);
      }
      /* Zweite Zeile unter dem Namen: Groesse oder Fehler, immer am
         gleichen Platz, damit die Reihen nicht springen. */
      .track-note {
        grid-column: 2 / -1;
        font: 10.5px/1.3 var(--mono);
        color: var(--faint);
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .track-note.bad {
        color: var(--bad);
      }

      /* ---------------------------------------------------------- Regler */
      /* Die Reglerspalte zerfaellt in zwei Teile: links, was an der Spur
         eingestellt wird, rechts das Speichern. Dazwischen dieselbe Linie,
         die auch die Wellenform von der Spalte trennt — sie sagt, dass
         rechts davon kein Regler mehr steht, sondern eine Handlung. */
      .track-knobs {
        display: flex;
        align-items: stretch;
        min-width: 0;
      }
      .knob-stack {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 5px;
        padding: 7px 11px;
      }
      /* Das Speichern steht in der Reglerspalte ganz rechts, hinter der
         Trennlinie, und reicht ueber die ganze Bahnhoehe. Frueher hing es
         als 12-Pixel-Zeichen an der Zeile "10 MB" — am Rechner kaum zu
         sehen, quer gehalten gar nicht, weil diese Zeile dort wegfaellt. */
      .save,
      .head-save {
        flex: none;
        box-sizing: content-box;
        width: var(--save-w);
        border-left: 1px solid var(--edge-soft);
        padding-inline: var(--save-pad);
      }
      .save {
        display: grid;
        place-items: center;
      }
      /* Die Kopfzeile teilt sich wie die Spalte darunter. Die Beschriftung
         sitzt mittig ueber den Reglern — ueber dem Speichern steht nichts,
         denn es ist keine Einstellung, sondern eine eigene Spalte. */
      .head-knobs {
        display: flex;
        align-items: stretch;
        min-width: 0;
      }
      .head-knobs .heading {
        flex: 1 1 auto;
        min-width: 0;
        text-align: center;
      }
      .level {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .level input {
        min-width: 28px;
      }
      .level .val {
        font: 10.5px/1 var(--mono);
        font-variant-numeric: tabular-nums;
        color: var(--dim);
        min-width: 3ch;
        text-align: right;
      }
      /* Im Serverweg ist das Speichern ein Link auf eine liegende Datei, im
         Browserpfad ein Knopf, der die WAV erst schreibt. Beide sehen
         gleich aus: dieselbe Handlung, dieselbe Stelle, dieselbe Groesse. */
      .save .wav {
        box-sizing: border-box;
        min-height: var(--save-w);
        width: var(--save-w);
        padding: 0;
        display: grid;
        place-items: center;
        background: var(--panel-2);
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        color: var(--dim);
        text-decoration: none;
        cursor: pointer;
        --icon-size: 14px;
        transition: border-color 0.12s, background 0.12s, color 0.12s;
      }
      .save .wav:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      .save button.wav:disabled {
        opacity: 0.42;
        cursor: not-allowed;
      }

      .pitch {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 4px;
      }
      /* Nicht schrumpfen zu duerfen ist hier kein Feinschliff, sondern
         die ganze Sache:
         ohne sie geben die beiden Knoepfe als erste nach, wenn die Zeile
         zu schmal wird. Quer gehalten blieben von 34 Pixeln Breite 14 —
         zwei Schlitze unter dem Pegelregler. Wer mit dem Finger auf das
         Plus zielte, traf die Schiene darueber, und statt der Tonhoehe
         stieg die Lautstaerke. Eher soll die Zeile ueberlaufen als
         unbedienbar werden. */
      .pitch button {
        flex: none;
        min-height: 24px;
        width: 26px;
        padding: 0;
        display: grid;
        place-items: center;
        font: 600 12px/1 var(--mono);
      }
      .pitch output {
        flex: none;
        font: 10.5px/1 var(--mono);
        font-variant-numeric: tabular-nums;
        min-width: 5ch;
        text-align: center;
        white-space: nowrap;
      }
      .pitch .what {
        flex: none;
        font: 13px/1 var(--mono);
        color: var(--faint);
        margin-right: auto;
        cursor: help;
      }
      .pitch .unit {
        color: var(--faint);
      }
      .pitch button {
        --icon-size: 12px;
      }

      .solo-tempo {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .solo-tempo label {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: baseline;
        font: 10.5px/1.4 var(--mono);
        color: var(--dim);
      }
      .solo-tempo output {
        color: var(--accent);
        font-variant-numeric: tabular-nums;
      }

      /* ------------------------------------------------------ Statusleiste */
      .status {
        display: flex;
        gap: 8px 18px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 9px clamp(13px, 2.2vw, 19px);
        background: var(--panel-2);
      }
      /* Die Loop-Felder: A und B als Zahl in Millisekunden.
         Auf der Schiene zieht man grob; hier steht der Wert, den man
         abgelesen, abgezaehlt oder aus einer Partitur hat. Die Einheit ist
         die Millisekunde, weil ein Takt bei 120 bpm zwei Sekunden dauert
         und die Hundertstel der Anzeige dafuer zu grob sind. */
      .loop-edit {
        gap: 5px 7px;
      }
      .field {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding-left: 7px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel);
        --icon-size: 12px;
      }
      .field:focus-within {
        border-color: var(--accent);
      }
      .field > b {
        font: 700 11px/1 var(--mono);
        color: var(--accent);
      }
      .field input {
        width: 7.5ch;
        min-width: 0;
        padding: 4px 0;
        border: 0;
        background: none;
        color: inherit;
        font: 12px/1 var(--mono);
        font-variant-numeric: tabular-nums;
        text-align: right;
        /* Ohne Pfeilchen: sie kosten im schmalen Feld mehr Platz, als sie
           wert sind. Die Pfeiltasten stufen weiter, und fuer das Setzen
           von Hand steht der Knopf daneben. */
        appearance: textfield;
      }
      .field input::-webkit-inner-spin-button,
      .field input::-webkit-outer-spin-button {
        appearance: none;
        margin: 0;
      }
      .field .unit {
        font: 10.5px/1 var(--mono);
        color: var(--faint);
      }
      .field button {
        min-height: 25px;
        width: 24px;
        margin-left: 2px;
        padding: 0;
        display: grid;
        place-items: center;
        border: 0;
        border-left: 1px solid var(--edge);
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        background: none;
      }
      .field button:hover:not(:disabled) {
        background: var(--ghost);
        color: var(--accent);
      }
      /* Ohne gesetzten Loop zeigen die Felder, was gelten wuerde: der ganze
         Song. Gestrichelt, damit das nicht wie ein gesetzter Loop aussieht. */
      .loop-edit.unset .field {
        border-style: dashed;
        color: var(--dim);
      }
      .loop-edit.unset .field > b {
        color: var(--faint);
      }
      /* Der Hinweis steht im Titel, nicht in der Leiste: eine Zeile Text
         weniger, die man nach dem ersten Mal nicht mehr liest. */
      .status .hint {
        margin-left: auto;
        display: inline-flex;
        color: var(--faint);
        cursor: help;
        --icon-size: 14px;
      }
      .status .hint:hover {
        color: var(--dim);
      }

      /* ------------------------------------------------------------ Technik */
      /* Vier Saetze, die beim ersten Mal erklaeren und danach nur noch
         Platz kosten: zugeklappt, einen Klick entfernt. */
      .tech {
        border-top: 1px solid var(--edge-soft);
        font: 10.5px/1.5 var(--mono);
        color: var(--faint);
        background: var(--panel);
      }
      .tech summary {
        display: flex;
        align-items: center;
        gap: 5px;
        width: fit-content;
        padding: 8px clamp(13px, 2.2vw, 19px);
        cursor: pointer;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        --icon-size: 13px;
      }
      .tech summary::marker,
      .tech summary::-webkit-details-marker {
        content: '';
        display: none;
      }
      .tech summary:hover {
        color: var(--dim);
      }
      .tech[open] summary {
        padding-bottom: 3px;
      }
      .tech > span {
        display: block;
        padding: 0 clamp(13px, 2.2vw, 19px) 3px;
      }
      .tech > span:last-child {
        padding-bottom: 11px;
      }

      /* Mit dem Finger brauchen die beiden kleinen Tonhoehen-Schalter
         dieselbe Flaeche wie alles andere. */
      @media (pointer: coarse) {
        .pitch button {
          min-height: 34px;
          width: 34px;
        }
        .field button {
          min-height: 34px;
          width: 34px;
        }
        .field input {
          padding: 8px 0;
        }
        .track-name {
          min-height: 30px;
        }
        /* Und das Speichern ebenso: 26 Pixel sind mit der Maus genug, mit
           dem Finger nicht. Der Platz dafuer kommt vom Pegelregler, der
           hier ein Stueck kuerzer wird — eine Schiene, die man mit dem
           Finger ohnehin grob stellt, vertraegt das eher als ein Ziel,
           das man trifft oder verfehlt. */
        .deck {
          --save-w: 34px;
        }
        .save .wav {
          --icon-size: 15px;
        }
      }

      /* ------------------------------------------------------------ Schmal */
      @container (max-width: 760px) {
        .status .hint {
          display: none;
        }
      }
      @container (max-width: 700px) {
        .deck {
          --label: 158px;
          --knobs: 150px;
        }
        .track-head,
        .knob-stack {
          padding-inline: 8px;
        }
        /* Enger Platz: der Name bekommt die Zeile fuer sich, Mute und Solo
           ruecken darunter. Nebeneinander blieben vom Namen drei Buchstaben,
           und gerade der Name entscheidet, was man anfasst. */
        .track-head {
          grid-template-columns: 8px minmax(0, 1fr);
        }
        .track-head .track-name,
        .track-head .buttons,
        .track-head .track-note {
          grid-column: 2;
        }
        .level .val {
          display: none;
        }
        /* Die Tonhoehe nur noch als Zahl: das Zeichen davor und die
           Einheit dahinter kosten zusammen rund 30 Pixel, und die
           braucht die Zeile fuer ihre beiden Schrittknoepfe. Was die
           Zahl bedeutet, hat gerade der Tipp auf das ♯ im Namen
           gesagt. */
        .pitch .what,
        .pitch .unit {
          display: none;
        }
        .pitch output {
          min-width: 3ch;
        }
      }
      /* ------------------------------------------------------- Quer gehalten */
      /* Ein Telefon im Querformat hat gut 400 Pixel Hoehe, und davon gingen
         322 an Kopf, Transport, Tabellenkopf, Fuss und Technik: fuer die
         Spuren -- das, wofuer das Deck da ist -- blieben 74. Gemessen bei
         870 auf 412, drei Spuren, Deck insgesamt 702 Pixel hoch.

         Dieser Block raeumt genau dort auf. Er haengt an der Hoehe, nicht
         an der Breite: schmal ist das Deck hier nicht, es ist flach. Die
         Container-Abfragen weiter oben greifen quer nie, weil der Container
         835 Pixel breit ist -- und sie sollen es auch nicht, denn breit ist
         richtig. Falsch ist nur, was hoch baut. */
      @media (max-height: 560px) {
        .deck {
          /* Niedrigere Bahnen als die 66 Pixel der Vorgabe. Zum Ziehen auf
             der Wellenform reicht das noch; fuenf Spuren, die man nur
             nacheinander sieht, reichen nicht. */
          --lane-h: clamp(
            54px,
            calc((var(--deck-space) - var(--chrome, 330px)) / var(--lanes, 6)),
            110px
          );
          /* Spurkopf und Regler geben ab, die Wellenform nimmt. Weiter
             herunter geht es nicht: unter rund 158 Pixeln passen Name,
             Mute und Solo nicht mehr in eine Zeile, und sie untereinander
             zu stellen machte die Bahnen wieder hoeher -- genau das, was
             dieser Block gerade abgeschafft hat. */
          --label: 186px;
          /* 138 reichten, solange die Spalte nur Regler trug. Seit das
             Speichern rechts daneben seine eigene Spalte hat, blieben
             fuer die Tonhoehenzeile 73 Pixel — zu wenig fuer zwei
             Fingerknoepfe. Die 24 Pixel mehr nimmt die Wellenform auf,
             die quer ohnehin die breiteste Spalte ist. */
          --knobs: 162px;
        }
        /* Enger an den Rand: die gewonnenen Pixel gehen an den Namen, der
           sonst nach drei Buchstaben abbricht. */
        .track-head,
        .knob-stack {
          padding-inline: 8px;
        }
        .deck {
          --save-pad: 7px;
        }
        .pitch .what,
        .pitch .unit {
          display: none;
        }
        .pitch output {
          min-width: 3ch;
        }

        /* Der Songkopf sagt dasselbe in halber Hoehe. */
        .song {
          padding: 9px clamp(13px, 2.2vw, 19px) 10px;
        }
        .title {
          font-size: clamp(17px, 2.4cqw, 20px);
          margin: 3px 0 4px;
        }
        .messages {
          padding-bottom: 10px;
        }
        .transport {
          padding-block: 6px;
        }
        .status {
          padding-block: 6px;
        }

        /* Die Spaltenbeschriftungen stehen schmal gedraengt ueber zwei
           Zeilen und erklaeren, was die Zeichen darunter ohnehin zeigen.
           Die Zeitachse behaelt ihre Zeile. */
        .table-head .heading,
        .table-head .head-knobs {
          display: none;
        }
        /* Und die Achse ausdruecklich in die mittlere Spalte: ohne die
           Beschriftung davor sucht sie sich sonst die erste und liegt
           damit neben den Wellenformen statt ueber ihnen. */
        .table-head app-time-ruler {
          grid-column: 2;
        }

        /* Vier Saetze ueber AudioContext und Vorlauf -- auf einem Telefon
           beim Ueben nicht die 33 Pixel wert, die die zugeklappte Zeile
           kostet. Am Rechner steht sie weiter da. */
        .tech {
          display: none;
        }

        /* Das Speichern sitzt in der Pegelzeile, und dort ist quer gehalten
           kein Platz zu verschenken. Die Prozentzahl geht: wie laut eine
           Spur steht, sagt die Schiene daneben ohnehin, und unter 700
           Pixel Breite steht sie schon jetzt nicht da. Ihre rund 25 Pixel
           tragen das Download-Ziel, ohne dass die Wellenform etwas abgibt. */
        .level .val {
          display: none;
        }

        /* Das hier war der eigentliche Hoehenfresser: nicht die Wellenform,
           sondern die Zeile "12 MB" darunter. Mit dem Finger waere sie mit
           Abstand 44 Pixel hoch -- so wurde aus einer 66-Pixel-Bahn eine
           von 102.

           Weg ist sie nicht: ein Tipp auf den Spurnamen klappt sie auf,
           zusammen mit der Tonhoehe. Was gemeldet werden muss, bleibt
           stehen -- eine Spur, die nicht geladen hat, sagt das weiter von
           selbst. Das Speichern haengt nicht mehr daran: es steht jetzt
           bei den Reglern und ist damit auch quer immer da. */
        .track .track-note {
          display: none;
        }
        .track.detailed .track-note,
        .track .track-note.bad {
          display: block;
        }
      }

      @container (max-width: 520px) {
        .deck {
          --label: 132px;
          --knobs: 0px;
        }
        .table-head .head-knobs {
          display: none;
        }
        /* Schmal stehen Name, Schalter und Angabe untereinander. Nebeneinander
           blieben vom Namen zwei Buchstaben uebrig, und gerade der Name
           entscheidet, welche Spur man gleich stummschaltet. */
        .track-head {
          grid-template-columns: 8px minmax(0, 1fr);
          grid-row: span 2;
        }
        .track-head strong {
          grid-column: 2;
        }
        .track-head .buttons {
          grid-column: 2;
        }
        .track-knobs {
          grid-column: 2;
        }
        .knob-stack {
          padding: 2px 9px 9px;
        }
        .level .val {
          display: block;
        }
      }
    `,
  ],
  template: `
    <section
      class="panel deck"
      #deck
      [style.--lanes]="engine.tracks().length || 1"
      [style.--chrome.px]="chrome()"
    >
      <!-- ----------------------------------------------------------- Song -->
      <header class="song">
        <div class="grow">
          <div class="eyebrow">
            {{ job().model_label }}
            @if (job().device && job().device !== 'keins') {
              · {{ job().device!.toUpperCase() }}
            }
            @if (job().is_test_path && !job().model_label.includes('Testpfad')) {
              · Testpfad
            }
          </div>
          <h2 class="title">{{ job().source_name }}</h2>
          @if (!booting()) {
            <div class="song-meta">
              <span>{{ engine.tracks().length }} Spuren</span>
              <span class="sep">/</span>
              <span>{{ clock(engine.duration()) }}</span>
              @if (engine.sampleRate()) {
                <span class="sep">/</span>
                <span>{{ engine.sampleRate() }} Hz</span>
              }
              @if (engine.effectiveRateView() !== 1) {
                <span class="sep">/</span>
                <span>Wiedergabe {{ percent(engine.effectiveRateView()) }} %</span>
              }
            </div>
          }
        </div>
        <button
          class="icon close"
          [attr.aria-label]="booting() ? 'Laden abbrechen' : 'Deck schließen'"
          [title]="booting() ? 'Laden abbrechen' : 'Deck schließen'"
          (click)="close.emit()"
        >
          <app-icon name="x" />
        </button>
      </header>

      @if (booting()) {
        <!-- Warten. Das Deck erscheint erst, wenn alle Spuren klingen
             koennen: ein halb gefuelltes Deck laedt zum Klicken ein und
             antwortet dann nicht. -->
        <div class="boot" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <p class="boot-what">Spuren werden geladen und dekodiert …</p>
          <p class="mono tiny faint">
            @if (engine.tracks().length) {
              {{ settled() }} von {{ engine.tracks().length }} Spuren
            } @else {
              Spuren werden geholt
            }
          </p>
        </div>
      } @else {
        @if (job().is_test_path || engine.error()) {
          <div class="messages">
            @if (job().is_test_path) {
              <div class="notice test">
                <span>
                  <strong>Testpfad.</strong> Diese Spuren sind synthetisch, es
                  wurde nichts getrennt. Die beiden Klickspuren klicken auf genau
                  denselben Zeitpunkten: synchron hört man einen einzigen Klick.
                </span>
              </div>
            }
            @if (engine.error(); as e) {
              <div class="notice bad"><span>{{ e }}</span></div>
            }
          </div>
        }

        <!-- ------------------------------------------------------ Transport -->
        <div class="transport">
          <div class="row-tight">
            <button
              class="key play"
              data-testid="playpause"
              [disabled]="!ready()"
              [attr.aria-label]="engine.playing() ? 'Pause' : 'Abspielen'"
              (click)="engine.toggle()"
            >
              <app-icon [name]="engine.playing() ? 'pause' : 'play'" [weight]="2.4" />
            </button>
            <button
              class="icon"
              aria-label="An den Anfang"
              title="An den Anfang"
              [disabled]="!ready()"
              (click)="engine.seek(0)"
            >
              <app-icon name="skip-back" />
            </button>
            <button
              class="sm step"
              aria-label="Fünf Sekunden zurück"
              title="Fünf Sekunden zurück"
              [disabled]="!ready()"
              (click)="nudge(-5)"
            >
              <app-icon name="rewind" />5
            </button>
            <button
              class="sm step"
              aria-label="Fünf Sekunden vor"
              title="Fünf Sekunden vor"
              [disabled]="!ready()"
              (click)="nudge(5)"
            >
              5<app-icon name="fast-forward" />
            </button>
            <span class="clock">
              <span data-testid="position">{{ time(engine.position()) }}</span>
              <small>/ {{ time(engine.duration()) }}</small>
            </span>
            <button
              class="loop-switch"
              [disabled]="!engine.loop()"
              [attr.aria-pressed]="engine.loopEnabled() && !!engine.loop()"
              [title]="
                engine.loop()
                  ? 'Loop zwischen A und B ein- oder ausschalten'
                  : 'Noch kein Loop gesetzt — A/B unten setzen oder in eine Wellenform ziehen'
              "
              (click)="engine.setLoopEnabled(!engine.loopEnabled())"
            >
              <app-icon name="repeat" /> A–B
            </button>
          </div>

          <div class="row-tight">
            <span class="mode">
              <span class="eyebrow">{{ engine.loneSolo() ? 'Übemodus' : 'Mix' }}</span>
              <b aria-live="polite" [title]="modeLabel()">{{ modeLabel() }}</b>
            </span>
            @if (anySolo()) {
              <button
                class="icon sm"
                aria-label="Solo aufheben"
                title="Solo aufheben"
                (click)="engine.clearSolo()"
              >
                <app-icon name="x" />
              </button>
            }
          </div>

          <div class="tempo">
            <div class="tempo-label">
              <label class="small" for="master-rate">
                Mix-Tempo
                @if (engine.loneSolo()) {
                  <span class="faint tiny">(Solo-Tempo gilt)</span>
                }
              </label>
              <span class="mono small">{{ percent(engine.masterRate()) }} %</span>
            </div>
            <input
              id="master-rate"
              data-testid="master-rate"
              type="range"
              [min]="MASTER_RATE_MIN * 100"
              [max]="MASTER_RATE_MAX * 100"
              step="1"
              [value]="engine.masterRate() * 100"
              [disabled]="!ready() || !!engine.loneSolo()"
              aria-label="Mix-Tempo in Prozent"
              (input)="setMasterRate($event)"
            />
          </div>
        </div>

        <!-- ------------------------------------------------------- Workspace -->
        <div class="table-head">
          <div class="heading eyebrow">Spur · Mute · Solo</div>
          <app-time-ruler
            [duration]="engine.duration()"
            [position]="engine.position()"
            [loop]="engine.loop()"
            [loopEnabled]="engine.loopEnabled()"
            [hover]="hoverAt()"
            (loopChange)="setLoop($event)"
          />
          <!-- Die Kopfzeile teilt sich wie die Spalte darunter: die
               Beschriftung gilt den Reglern, nicht dem Speichern. Dessen
               Feld bleibt leer und fuehrt nur die Trennlinie nach oben
               durch — eine eigene Spalte, keine Unterabteilung der
               Tonhoehe. -->
          <div class="head-knobs">
            <div class="heading eyebrow">Tonhöhe</div>
            <div class="head-save" aria-hidden="true"></div>
          </div>
        </div>

        <div class="lanes" #lanes>
        @for (track of engine.tracks(); track track.slug; let i = $index) {
          <div
            class="track"
            [class.soloed]="track.solo"
            [class.hushed]="!audible(track)"
            [class.detailed]="showPitch(track)"
            [style.--sig]="color(track, i)"
            data-testid="track"
            [attr.data-slug]="track.slug"
            [attr.data-state]="track.state"
          >
            <div class="track-head">
              <span class="sig" aria-hidden="true"></span>
              <button
                class="track-name"
                data-testid="track-name"
                [attr.aria-pressed]="showPitch(track)"
                [attr.aria-label]="'Tonhöhe von ' + short(track.name) + ' anzeigen'"
                [disabled]="track.state !== 'ready'"
                (click)="togglePitch(track.slug)"
              >
                <strong [title]="track.name">{{ short(track.name) }}</strong>
                <span class="hash" aria-hidden="true">♯</span>
              </button>
              <span class="buttons">
                <button
                  class="icon"
                  data-testid="mute"
                  [attr.aria-label]="short(track.name) + ' stummschalten'"
                  [attr.aria-pressed]="track.muted"
                  [title]="track.muted ? 'stumm — wieder hörbar machen' : 'stummschalten'"
                  [disabled]="track.state !== 'ready'"
                  (click)="engine.toggleMute(track.slug)"
                >
                  <app-icon [name]="track.muted ? 'volume-x' : 'volume-2'" />
                </button>
                <button
                  class="icon"
                  data-testid="solo"
                  [attr.aria-label]="short(track.name) + ' solo hören'"
                  [attr.aria-pressed]="track.solo"
                  [title]="track.solo ? 'solo — aufheben' : 'nur diese Spur hören'"
                  [disabled]="track.state !== 'ready'"
                  (click)="engine.toggleSolo(track.slug)"
                >
                  <app-icon name="headphones" />
                </button>
              </span>
              <span class="track-note" [class.bad]="track.state === 'error'">
                @switch (track.state) {
                  @case ('loading') { lädt … }
                  @case ('error') { {{ track.error }} }
                  @default { {{ megabytes(track.bytes) }} MB }
                }
              </span>
            </div>

            <app-waveform
              data-testid="waveform"
              [peaks]="track.peaks"
              [duration]="engine.duration()"
              [position]="engine.position()"
              [loop]="engine.loop()"
              [loopEnabled]="engine.loopEnabled()"
              [faded]="!audible(track)"
              [lit]="track.solo"
              [emptyLabel]="waveformLabel(track)"
              [label]="'Songposition auf Spur ' + short(track.name)"
              [minHeight]="track.solo ? 76 : 52"
              (seek)="engine.seek($event)"
              (loopChange)="setLoop($event)"
              (hoverTime)="hoverAt.set($event)"
            />

            <div class="track-knobs">
              <div class="knob-stack">
              <div class="level">
                <input
                  [id]="'vol-' + track.slug"
                  data-testid="volume"
                  type="range"
                  min="0"
                  max="150"
                  step="1"
                  [value]="track.volume * 100"
                  [disabled]="track.state !== 'ready'"
                  [attr.aria-label]="'Pegel von ' + short(track.name) + ' in Prozent'"
                  (input)="setVolume(track.slug, $event)"
                />
                <b class="val">{{ percent(track.volume) }}</b>
              </div>

              @if (showPitch(track)) {
                <div class="pitch" data-testid="pitch">
                  <span class="what" aria-hidden="true" title="Tonhöhe in Halbtönen">♯</span>
                  <button
                    [attr.aria-label]="short(track.name) + ' einen Halbton tiefer'"
                    [disabled]="track.state !== 'ready' || track.semitones <= -SEMITONE_RANGE"
                    (click)="stepSemitones(track, -1)"
                  >
                    <app-icon name="minus" />
                  </button>
                  <output
                    data-testid="pitch-value"
                    [attr.aria-label]="'Tonhöhe von ' + short(track.name)"
                  >
                    {{ semitoneValue(track.semitones) }}<span class="unit"> HT</span>
                  </output>
                  <button
                    data-testid="pitch-up"
                    [attr.aria-label]="short(track.name) + ' einen Halbton höher'"
                    [disabled]="track.state !== 'ready' || track.semitones >= SEMITONE_RANGE"
                    (click)="stepSemitones(track, 1)"
                  >
                    <app-icon name="plus" />
                  </button>
                </div>
              }

              @if (isLoneSolo(track)) {
                <div class="solo-tempo">
                  <label [attr.for]="'solo-rate-' + track.slug">
                    <span>Solo-Tempo</span>
                    <output class="mono">{{ percent(track.soloRate) }} %</output>
                  </label>
                  <input
                    [id]="'solo-rate-' + track.slug"
                    data-testid="solo-rate"
                    type="range"
                    [min]="SOLO_RATE_MIN * 100"
                    [max]="SOLO_RATE_MAX * 100"
                    step="1"
                    [value]="track.soloRate * 100"
                    [attr.aria-label]="'Solo-Tempo von ' + short(track.name) + ' in Prozent'"
                    (input)="setSoloRate(track.slug, $event)"
                  />
                </div>
              }
              </div>

              <div class="save">
                @if (job().site === 'backend' && track.state === 'ready') {
                  <!-- Serverweg: die Datei liegt schon, ein Link genuegt. -->
                  <a
                    class="wav"
                    data-testid="track-download"
                    [href]="track.downloadUrl"
                    [download]="track.name + '.wav'"
                    [attr.aria-label]="short(track.name) + ' als WAV speichern'"
                    [title]="short(track.name) + ' als WAV speichern'"
                  >
                    <app-icon name="download" />
                  </a>
                } @else {
                  <!-- Browserpfad: es gibt keine Datei, auf die ein Link
                       zeigen koennte. Die WAV entsteht beim Klick. Und
                       solange eine Spur laedt, steht der Knopf gesperrt da
                       statt zu fehlen — sonst springt die Zeile. -->
                  <button
                    type="button"
                    class="wav"
                    data-testid="track-download"
                    [attr.aria-label]="short(track.name) + ' als WAV speichern'"
                    [title]="short(track.name) + ' als WAV speichern'"
                    [disabled]="track.state !== 'ready'"
                    (click)="save(track)"
                  >
                    <app-icon name="download" />
                  </button>
                }
              </div>
            </div>
          </div>
        }
        </div>

        <!-- --------------------------------------------------- Statusleiste -->
        <footer class="status">
          <div class="row-tight loop-edit" [class.unset]="!engine.loop()">
            <span class="eyebrow">A–B Loop</span>
            @for (end of ends; track end) {
              <span class="field">
                <b aria-hidden="true">{{ end === 'a' ? 'A' : 'B' }}</b>
                <input
                  type="number"
                  [attr.data-testid]="'loop-' + end + '-ms'"
                  min="0"
                  [max]="msMax()"
                  step="10"
                  [value]="markMs(end)"
                  [disabled]="!ready()"
                  [attr.aria-label]="
                    end === 'a'
                      ? 'Loop-Anfang A in Millisekunden'
                      : 'Loop-Ende B in Millisekunden'
                  "
                  [title]="
                    end === 'a'
                      ? 'Loop-Anfang in Millisekunden — Pfeiltasten stufen in 10 ms'
                      : 'Loop-Ende in Millisekunden — Pfeiltasten stufen in 10 ms'
                  "
                  (change)="commitMark(end, $event)"
                />
                <span class="unit" aria-hidden="true">ms</span>
                <button
                  [attr.aria-label]="
                    end === 'a'
                      ? 'Loop-Anfang A auf die aktuelle Stelle setzen'
                      : 'Loop-Ende B auf die aktuelle Stelle setzen'
                  "
                  [title]="
                    end === 'a'
                      ? 'Loop-Anfang A auf die aktuelle Stelle setzen'
                      : 'Loop-Ende B auf die aktuelle Stelle setzen'
                  "
                  [disabled]="!ready()"
                  (click)="markHere(end)"
                >
                  <app-icon name="arrow-down-to-line" />
                </button>
              </span>
            }
            @if (engine.loop()) {
              <button
                class="icon sm"
                aria-label="Loop löschen"
                title="Loop löschen"
                (click)="engine.clearLoop()"
              >
                <app-icon name="x" />
              </button>
            }
          </div>

          @if (engine.loop(); as loop) {
            <span class="mono tiny dim">
              {{ engine.loopEnabled() ? 'Loop an' : 'Loop aus' }} ·
              {{ time(loop.a) }} – {{ time(loop.b) }}
              ({{ (loop.b - loop.a).toFixed(2) }} s)
            </span>
          } @else {
            <span class="mono tiny faint">
              Kein Loop · Zum Setzen mit der Maus markieren
            </span>
          }

          @if (engine.loop()) {
            <span
              class="hint"
              title="Die Marken A und B lassen sich auf der Zeitachse ziehen — mit Maus, Finger oder Tastatur: Pfeiltasten 1 s, mit Umschalt 0,1 s, Bild auf/ab 10 s, Pos1 und Ende an die Grenze."
            >
              <app-icon name="info" />
              <span class="sr">Hinweis zur Bedienung der Loop-Marken</span>
            </span>
          }
        </footer>

        <!-- -------------------------------------------------------- Technik -->
        <details class="tech">
          <summary>
            <app-icon name="info" />
            Technik
          </summary>
          <span>Position in Sekunden des Originalsongs</span>
          @if (engine.sampleRate()) {
            <span>gemeinsamer AudioContext {{ engine.sampleRate() }} Hz</span>
          }
          @if (engine.leadMs() !== null) {
            <span>
              Umschaltung {{ engine.leadMs() }} ms im Voraus, für alle Spuren auf
              dieselbe Audiozeit (Stretch-Knoten {{ engine.nodeLatencyMs() }} ms)
            </span>
          }
          @if (engine.memoryBytes()) {
            <span>
              {{ megabytes(engine.memoryBytes()) }} MB insgesamt im Arbeitsspeicher,
              dekodiert
            </span>
          }
        </details>
      }
    </section>
  `,
})
export class PlayerComponent {
  readonly engine = inject(MixEngine);
  private readonly store = inject(StemStore);
  readonly job = input.required<Job>();
  readonly close = output<void>();

  // ------------------------------------------------------------ Spurhoehe
  /*
   * Die Spuren sollen so hoch sein wie moeglich, ohne dass das Deck
   * scrollt. Rechnen laesst sich das nur, wenn man weiss, wie viel Hoehe
   * alles ausser den Spuren braucht — und das haengt am Titel, der umbrechen
   * kann, an Hinweiszeilen, an der Schriftgroesse. Geschaetzte Zahlen gingen
   * hier reihum daneben, deshalb wird gemessen: Deck minus Spurblock ist das
   * Beiwerk. Den Rest teilt das CSS durch die Zahl der Spuren.
   */
  private readonly deckRef = viewChild<ElementRef<HTMLElement>>('deck');
  private readonly lanesRef = viewChild<ElementRef<HTMLElement>>('lanes');

  /** Gemessene Hoehe alles Nicht-Spurigen im Deck, in CSS-Pixeln. */
  readonly chrome = signal(330);

  constructor() {
    effect((onCleanup) => {
      const deck = this.deckRef()?.nativeElement;
      const lanes = this.lanesRef()?.nativeElement;
      if (!deck || !lanes || typeof ResizeObserver === 'undefined') return;

      /* Zwei Pixel Zugabe fuer Raender und Rundungen: lieber eine Haaresbreite
         Luft als ein Balken am Rand. Unter einem Pixel Abweichung bleibt alles
         stehen, sonst schaukelt sich die Messung mit dem Umbruch auf. */
      let last = 0;
      const measure = () => {
        const rest = Math.round(deck.offsetHeight - lanes.offsetHeight) + 2;
        if (rest > 0 && Math.abs(rest - last) > 1) {
          last = rest;
          this.chrome.set(rest);
        }
      };

      const observer = new ResizeObserver(measure);
      observer.observe(deck);
      observer.observe(lanes);
      measure();
      onCleanup(() => observer.disconnect());
    });
  }

  /**
   * Schreibt eine Spur des Browserpfads als WAV.
   *
   * Erst jetzt: eine Spur von 4:33 ist als WAV 48 MB, und vier davon im
   * Voraus zu schreiben waeren 190 MB fuer einen Klick, der vielleicht nie
   * kommt.
   */
  save(track: TrackView): void {
    const held = this.store.get(this.job().id);
    const found = held?.stems.find((s) => s.source === track.slug);
    if (!held || !found) return;
    downloadWav(found.channels, held.sampleRate, `${track.name}.wav`);
  }

  readonly MASTER_RATE_MIN = MASTER_RATE_MIN;
  readonly MASTER_RATE_MAX = MASTER_RATE_MAX;
  readonly SOLO_RATE_MIN = SOLO_RATE_MIN;
  readonly SOLO_RATE_MAX = SOLO_RATE_MAX;
  readonly SEMITONE_RANGE = SEMITONE_RANGE;

  /** Spur, deren Tonhoehe gerade aufgeklappt ist. */
  private readonly pitchOpen = signal<string | null>(null);

  /**
   * Zeit unter dem Zeiger, aus der Wellenform gemeldet, fuer die Anzeige
   * oben in der Zeitachse. Sie steht dort nur einmal statt in jeder Spur —
   * die Zeitachse gilt ohnehin fuer alle.
   */
  readonly hoverAt = signal<number | null>(null);

  readonly ends: readonly LoopEnd[] = ['a', 'b'];

  readonly ready = computed(() =>
    this.engine.tracks().some((t: TrackView) => t.state === 'ready'),
  );

  /**
   * Warten, bis alle Spuren geladen und dekodiert sind.
   *
   * Solange laeuft kein Ton, die Dauer steht nicht fest und die
   * Wellenformen sind leer — ein Deck, das in diesem Zustand schon dasteht,
   * nimmt Klicks an und tut nichts. Deshalb erst der Spinner, dann das Deck.
   */
  readonly booting = computed(() => this.engine.loading());

  /** Wie viele Spuren schon fertig sind — geladen oder gescheitert. */
  readonly settled = computed(
    () => this.engine.tracks().filter((t: TrackView) => t.state !== 'loading').length,
  );
  readonly anySolo = computed(() => this.engine.tracks().some((t: TrackView) => t.solo));

  readonly modeLabel = computed(() => {
    const lone = this.engine.loneSolo();
    if (lone) return `${shortStemName(lone.name)} solo`;
    const solos = this.engine.tracks().filter((t) => t.solo);
    if (solos.length > 1) return `${solos.length} Spuren solo`;
    const muted = this.engine.tracks().filter((t) => t.muted).length;
    return muted ? `Alle Spuren, ${muted} stumm` : 'Alle Spuren';
  });

  short(name: string): string {
    return shortStemName(name);
  }

  color(track: TrackView, index: number): string {
    return stemColor(track.slug, index, track.name);
  }

  /** Ist die Spur gerade zu hoeren? Steuert die Daempfung der Wellenform. */
  audible(track: TrackView): boolean {
    if (track.muted) return false;
    return this.anySolo() ? track.solo : true;
  }

  /** Ist diese Spur die einzige im Solo? Nur dann gilt ihr eigenes Tempo. */
  isLoneSolo(track: TrackView): boolean {
    return this.engine.loneSolo()?.slug === track.slug;
  }

  /**
   * Tonhoehe zeigen: wenn der Name angetippt ist — oder wenn sie verstellt
   * ist, denn eine wirkende Einstellung darf nicht verborgen sein.
   */
  showPitch(track: TrackView): boolean {
    return this.pitchOpen() === track.slug || track.semitones !== 0;
  }

  togglePitch(slug: string): void {
    this.pitchOpen.update((open) => (open === slug ? null : slug));
  }

  stepSemitones(track: TrackView, step: number): void {
    const next = Math.max(
      -SEMITONE_RANGE,
      Math.min(SEMITONE_RANGE, track.semitones + step),
    );
    this.engine.setSemitones(track.slug, next);
  }

  waveformLabel(track: TrackView): string {
    if (track.state === 'error') return 'nicht geladen';
    return 'wird geladen …';
  }

  megabytes(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(0);
  }

  percent(factor: number): string {
    return (factor * 100).toFixed(0);
  }

  /** Zeit mit Hundertsteln. Die Loop-Marken sind auf diese Stelle genau. */
  time(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
  }

  /** Kurze Zeit ohne Hundertstel, fuer die Kopfzeile. */
  clock(seconds: number): string {
    const s = isFinite(seconds) && seconds > 0 ? seconds : 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  /**
   * Die Zahl allein. Die Einheit steht als eigenes Stueck daneben, weil
   * sie in schmalen Spalten wegfaellt: dort ist die Zahl das Noetige, und
   * die 19 Pixel von " HT" entscheiden, ob die Schrittknoepfe noch ihre
   * volle Breite behalten.
   */
  semitoneValue(semitones: number): string {
    if (semitones === 0) return '±0';
    return `${semitones > 0 ? '+' : '−'}${Math.abs(semitones)}`;
  }

  setLoop(range: LoopRange): void {
    this.engine.setLoop(range.a, range.b);
  }

  // ------------------------------------------------------------ loop-felder
  /**
   * Was in den Feldern steht, wenn kein Loop gesetzt ist: der ganze Song.
   * Das ist nicht geraten, sondern genau der Bereich, der ohne Loop
   * durchlaeuft — und tippt man eine Zahl hinein, wird daraus der Loop.
   */
  private mark(end: LoopEnd): number {
    const loop = this.engine.loop();
    if (end === 'a') return loop ? loop.a : 0;
    return loop ? loop.b : this.engine.duration();
  }

  markMs(end: LoopEnd): number {
    return Math.round(this.mark(end) * 1000);
  }

  msMax(): number {
    return Math.round(this.engine.duration() * 1000);
  }

  markHere(end: LoopEnd): void {
    if (end === 'a') this.engine.setLoopStartHere();
    else this.engine.setLoopEndHere();
  }

  /**
   * Eine getippte Zahl uebernehmen. Gemeldet wird erst beim Verlassen des
   * Feldes oder mit der Eingabetaste, nicht bei jedem Tastendruck: jede
   * Meldung plant die Wiedergabe aller Spuren neu, und "1", "12", "123"
   * waeren drei Spruenge an drei falsche Stellen.
   *
   * Der Wert wird danach zurueckgeschrieben. Er kann an die Grenze gestossen
   * sein, und dann steht im Feld sonst weiter die abgelehnte Zahl: der
   * gebundene Wert hat sich ja nicht geaendert.
   */
  commitMark(end: LoopEnd, event: Event): void {
    const field = event.target as HTMLInputElement;
    const a = this.mark('a');
    const b = this.mark('b');
    const typed = Number(field.value);
    const wanted = isFinite(typed) && field.value.trim() !== '' ? typed / 1000 : end === 'a' ? a : b;
    const value =
      end === 'a'
        ? Math.min(Math.max(0, wanted), b - LOOP_MIN_SECONDS)
        : Math.max(Math.min(this.engine.duration(), wanted), a + LOOP_MIN_SECONDS);
    if (end === 'a') this.engine.setLoop(value, b);
    else this.engine.setLoop(a, value);
    field.value = String(Math.round(value * 1000));
  }

  nudge(delta: number): void {
    this.engine.seek(this.engine.currentPosition() + delta);
  }

  setMasterRate(event: Event): void {
    this.engine.setMasterRate(Number((event.target as HTMLInputElement).value) / 100);
  }

  setVolume(slug: string, event: Event): void {
    this.engine.setVolume(slug, Number((event.target as HTMLInputElement).value) / 100);
  }

  setSoloRate(slug: string, event: Event): void {
    this.engine.setSoloRate(slug, Number((event.target as HTMLInputElement).value) / 100);
  }
}
