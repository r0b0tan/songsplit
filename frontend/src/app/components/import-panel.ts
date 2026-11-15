import { Component, ElementRef, computed, inject, output, signal, viewChild } from '@angular/core';

import { ApiService, describeHttp } from '../core/api.service';
import { IconComponent } from '../core/icon';
import { DeviceFacts } from '../core/device-facts';
import { JobsService, type Site } from '../core/jobs.service';
import type { Job, ModelInfo } from '../core/models';
import { stemColor } from '../core/stem-colors';
import { VARIANT } from '../core/variant';
import { DeviceSeparator } from '../separate/device-separator';
import { probeDuration } from '../separate/decode';
import {
  SHORTEST_WORTH_SUGGESTING_S,
  asMinutes,
  assess,
  deviceMemoryGb,
} from '../separate/memory-budget';

/** Ein Balken der Wellenform: Hoehe in Pixeln, Deckkraft. */
interface Bar {
  h: number;
  a: number;
}

/**
 * Die Wellenform der Ablegeflaeche, fest gerechnet: ein Ausschlag, der zur
 * Mitte hin lauter wird. Hier liegt noch keine Datei, die man zeichnen
 * koennte — das Bild sagt nur, was hier hingehoert.
 */
/**
 * Wie gross die Welle in der Ablegeflaeche steht. Die Formel darunter
 * beschreibt ihre Form, diese Zahl allein ihre Groesse -- Balkenbreite und
 * Abstand im Stilblock sind darauf abgestimmt.
 */
const WAVE_SCALE = 1.4;

/**
 * Wie hoch die Welle darueber hinaus steht. Breite und Abstand der Balken
 * bleiben davon unberuehrt: die Welle wird schlanker, nicht groesser. Der
 * hoechste Balken ist WAVE_SCALE mal WAVE_RISE mal 32 Pixel hoch -- genau
 * die Hoehe, die .wave im Stilblock hat.
 */
const WAVE_RISE = 1.4;

const BARS: readonly Bar[] = Array.from({ length: 31 }, (_, i) => {
  const envelope = 1 - Math.abs(i - 15) / 16;
  return {
    h: (4 + Math.abs(Math.sin(i * 2.28)) * (4 + 24 * envelope)) * WAVE_SCALE * WAVE_RISE,
    a: 0.3 + 0.69 * envelope,
  };
});

/** Was die Ablegeflaeche annimmt. Der Rest wird abgewiesen, mit Grund. */
const ACCEPTED = /\.(mp3|wav)$/i;

/**
 * Import: Datei hineinziehen, Trennmodus waehlen, trennen.
 *
 * Aufbau und Masse folgen der Vorlage `exampledata/mixapart-uploadmaske`:
 * eine Kopfleiste mit Marke und Zustand, darunter grosse Ueberschrift, eine
 * Ablegeflaeche ueber die ganze Breite mit einem Schein in Pflaume, die
 * Auswahl als drei bis vier gleich breite Karten, darunter die Spuren des
 * gewaehlten Modus und eine Fusszeile aus Link und Hauptaktion.
 *
 * Die Kopfleiste gehoert in dieselbe Flaeche, nicht in eine eigene Karte
 * darueber. Sie sagt in einem ruhigen Grau, dass hier nichts den Rechner
 * verlaesst; worauf gerechnet wird, steht hinter dem (i). Dass auf der CPU
 * getrennt wird, geht dabei nicht verloren: das meldet das Backend als
 * Hinweis, und der steht unter der Karte, nicht in einem Tooltip.
 *
 * Gewaehlt wird ein *Modus* — "Schnell", "Detailliert", "Instrumente" —,
 * kein Modellname: wer trennen will, entscheidet zwischen Ergebnis und
 * Wartezeit, nicht zwischen htdemucs und htdemucs_ft. Der technische Name
 * steht im Tooltip der Karte und spaeter am Job.
 *
 * Die Ablegeflaeche ist ein echtes Dateifeld mit `opacity: 0` darueber. Damit
 * funktionieren Klick, Tastatur und Ablegen ohne eigenen Code; die
 * Drag-Ereignisse dienen nur der Rueckmeldung, dass die Flaeche trifft.
 */
@Component({
  selector: 'app-import-panel',
  standalone: true,
  imports: [IconComponent],
  // Ein Zeigen irgendwo auf der Seite klappt die Ortsliste zu. Der Fokus
  // allein reicht dafuer nicht, siehe `onDocumentPointerDown`.
  host: { '(document:pointerdown)': 'onDocumentPointerDown($event)' },
  styles: [
    `
      /* Die Importkarte steht eine Spur groesser als der Rest der Seite:
         dieselben Masse wie zuvor, im Ganzen um 15 % vergroessert. Das
         geschieht hier an einer Stelle und nicht an jedem Pixelwert
         einzeln -- so bleiben alle Verhaeltnisse der Karte so, wie sie
         entworfen sind. Die Karte selbst bleibt dabei so breit wie die
         Spalte: zoom rechnet auch die verfuegbare Breite mit um. */
      :host {
        display: block;
        container-type: inline-size;
        zoom: 1.15;
      }
      /* Und breiter als die Spalte darf sie auch sein: zu beiden Seiten
         gleich ueberstehend, waehrend der Platz in der Spalte derselbe
         bleibt. Wie weit, sagen --bleed-width und --bleed-margin aus
         app.ts; dort stehen auch die Schirmbreiten, ab denen der
         Ueberstand einsetzt. Die Fusszeile liest dieselben Token und
         zieht ihre Linie damit genau auf Kartenbreite.

         Die Prozente rechnen im Massstab der Karte, nicht der Seite --
         deshalb heben sie sich gegen den zoom darueber sauber auf. */
      :host {
        width: var(--bleed-width, 100%);
        margin-inline: var(--bleed-margin, 0);
      }
      .box {
        padding: 0;
        overflow: hidden;
      }

      /* ------------------------------------------------------ Kopfleiste */
      .bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 14px 16px;
        border-bottom: 1px solid var(--edge);
      }
      .brand,
      .local {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      /* Das Zeichen der App, nicht mehr aus Balken nachgebaut: hier liegt
         dieselbe app-icon.svg, aus der auch der Startbildschirm gerastert
         wird. Eine Quelle, ein Zeichen -- wer die Marke aendert, aendert die
         SVG, und die Leiste geht mit. Ohne eigene Rundung: die bringt das
         Zeichen selbst mit, und zwei Rundungen uebereinander schneiden eine
         Ecke doppelt. */
      .logo {
        display: block;
        width: 28px;
        height: 28px;
        flex: none;
      }
      /* Die Leiste sagt etwas Beruhigendes, und Beruhigendes muss nicht
         laut sein: kein Zustandspunkt, nur Text, eine Stufe schwaecher als
         jedes andere Grau der Oberflaeche. */
      .local {
        font-size: 11px;
        color: light-dark(#9f98a8, #635d70);
      }
      .what-wrap {
        position: relative;
        display: inline-flex;
      }
      .local .what {
        display: inline-flex;
        min-height: 0;
        padding: 0;
        border: 0;
        background: none;
        color: var(--accent);
        cursor: help;
        --icon-size: 13px;
      }
      .local .what:hover,
      .what-wrap:hover .what {
        filter: brightness(1.12);
      }

      /* Eigene Sprechblase statt des title-Attributs: die des Browsers
         kommt mit einer
         Sekunde Verzoegerung, in Systemschrift und ohne Gliederung — fuenf
         Angaben in einer Zeile sind dort nicht zu lesen. */
      .tip {
        position: absolute;
        top: calc(100% + 9px);
        right: -4px;
        z-index: 5;
        width: max-content;
        max-width: min(320px, 78cqw);
        padding: 9px 11px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel-2);
        color: var(--ink);
        box-shadow: 0 14px 30px -12px light-dark(rgb(24 19 30 / 0.3), rgb(0 0 0 / 0.6));
        opacity: 0;
        visibility: hidden;
        transform: translateY(-3px);
        transition: opacity 0.12s, transform 0.12s, visibility 0.12s;
      }
      /* Die Spitze sitzt unter dem Zeichen, nicht in der Mitte der Blase:
         die Blase ist breiter als ihr Ausloeser. */
      .tip::before {
        content: '';
        position: absolute;
        bottom: 100%;
        right: 7px;
        border: 5px solid transparent;
        border-bottom-color: var(--edge);
      }
      .what-wrap:hover .tip,
      .what:focus-visible + .tip,
      .tip.show {
        opacity: 1;
        visibility: visible;
        transform: none;
      }
      /* Eine Schriftstufe fuer alle Angaben — in der Sprechblase am ⓘ, in
         der Ortsliste und an der Moduskarte. Sie sind Beiwerk: wer sie
         braucht, liest sie, und wer nicht, soll von ihnen nicht
         angesprungen werden.

         Die Spalte der Benennungen ist fest und nicht automatisch: sonst
         richtet sich jeder Block nach seinem eigenen laengsten Wort, und
         zwei Eintraege untereinander haben ihre Werte an zwei Stellen. */
      .tip dl,
      .pick-panel dl {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 2px 9px;
        margin: 0;
        font-size: 10.5px;
      }
      .tip dt,
      .pick-panel dt {
        color: var(--faint);
        white-space: nowrap;
      }
      .tip dd,
      .pick-panel dd {
        margin: 0;
        color: var(--dim);
        font-family: var(--mono);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      .inner {
        padding: 18px;
      }

      /* ---------------------------------------------------------- Titel */
      .eyebrow {
        color: var(--accent);
      }
      .lede {
        font-size: clamp(24px, 5cqw, 36px);
        font-weight: 700;
        letter-spacing: -0.055em;
        line-height: 1.05;
        margin: 4px 0 18px;
      }

      /* ------------------------------------------------------- Ablegefeld */
      .drop {
        position: relative;
        display: grid;
        place-items: center;
        text-align: center;
        /* Die Hoehe haengt an der Breite: das Feld behaelt sein
           Verhaeltnis von 7:2, egal wie breit die Karte gerade steht.
           Die Mindesthoehe faengt die schmalen Schirme ab, wo 7:2 einen
           Streifen ergaebe, in dem Welle und Beschriftung klemmen.

           Die Breite steht ausdruecklich auf 100 %: sonst rechnet der
           Browser sie aus der Mindesthoehe mal dem Verhaeltnis und das
           Feld steht breiter als die Karte, die es traegt. */
        width: 100%;
        aspect-ratio: 7 / 2;
        min-height: 204px;
        padding: 18px 14px;
        /* Der gestrichelte Rand ist nicht grau, sondern gedaempft in der
           Akzentfarbe: die Flaeche gehoert zum Hauptweg. */
        border: 1px dashed light-dark(#c6a49d, #6d4c53);
        border-radius: 12px;
        /* Schein von oben, in Pflaume: er macht aus dem Kasten eine
           Flaeche, auf die man zielt. */
        background: radial-gradient(
          ellipse at 50% 28%,
          light-dark(#ece4ec, #352530) 0%,
          light-dark(#f4f2f6, #1d1b24) 70%
        );
        transition: border-color 0.18s, background-color 0.18s;
      }
      .drop.over,
      .drop:focus-within {
        border-color: var(--accent);
        outline: 1px solid var(--accent);
      }
      .drop input[type='file'] {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
      }
      .drop input[type='file']:disabled {
        cursor: not-allowed;
      }
      /* Breite und Abstand folgen WAVE_SCALE: 3 mal 1,4. Die Hoehe folgt
         WAVE_SCALE mal WAVE_RISE: 32 mal 1,4 mal 1,4. Wer die Welle aendern
         will, aendert die Zahlen dort und diese Werte mit. */
      .wave {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        height: 63px;
        margin-bottom: 13px;
        color: var(--accent);
      }
      .wave i {
        display: block;
        width: 4px;
        border-radius: 4px;
        background: currentColor;
      }
      .file-label {
        display: block;
        font-weight: 650;
        overflow-wrap: anywhere;
      }
      .sub {
        color: var(--dim);
        font-size: 12px;
      }

      /* ------------------------------------------------------- Trennmodus */
      .model-head {
        margin: 17px 0 8px;
        font-weight: 650;
      }
      .modes {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
        gap: 6px;
      }
      /* Jede Karte ist ein echtes Optionsfeld: damit funktionieren
         Pfeiltasten und Vorlesesoftware ohne eigenen Code. Sichtbar ist
         nur die Karte. */
      .mode {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 48px;
        padding: 7px 9px;
        border: 1px solid var(--edge);
        border-radius: 8px;
        background: var(--panel-2);
        cursor: pointer;
        font-size: 13px;
        font-weight: 650;
        transition: border-color 0.12s, background 0.12s;
      }
      .mode:hover {
        border-color: var(--accent);
      }
      .mode input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }
      .mode span {
        display: block;
        font-size: 11px;
        font-weight: 400;
        color: var(--dim);
      }
      .mode.on {
        border-color: var(--accent);
        background: light-dark(#f7e9e9, #31232d);
      }
      .mode:has(input:focus-visible) {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      /* Der Trennort in der Kopfzeile: ein Auswahlfeld, das aussieht wie
         der Text, der vorher dort stand. Erst beim Zeigen zeigt es, dass
         es eines ist.

         Das Winkelchen zeichnet der Rahmen eines leeren Kaestchens, nicht
         der Pfeil des Systems: dessen Groesse und Farbe richten sich nach
         der Oberflaeche des Betriebssystems und passten hier zu nichts. */
      .pick::after {
        content: '';
        position: absolute;
        right: 6px;
        width: 4px;
        height: 4px;
        border-right: 1.2px solid currentColor;
        border-bottom: 1.2px solid currentColor;
        transform: translateY(-1.5px) rotate(45deg);
        opacity: 0.75;
        pointer-events: none;
      }
      /* Aufgeklappt zeigt das Winkelchen nach oben. */
      .pick:has([aria-expanded='true'])::after {
        transform: translateY(1px) rotate(225deg);
      }
      /* Das Wort steht in der Schriftfarbe, das Bedienbare daneben in der
         Akzentfarbe: so ist auf einen Blick zu sehen, was hier nur
         beschriftet und was anzufassen ist. */
      /* Beschriftung und Auswahl sind ein Bedienelement, also tragen sie
         einen Rahmen gemeinsam — derselbe wie an jedem zweitrangigen Knopf
         (button und select in styles.css), nur eine Nummer kleiner, weil die
         Kopfzeile in 11 px gesetzt ist. */
      .mode-group {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px 2px 9px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        /* Ohne Fuellung: in der Kopfzeile soll nur der Rahmen sagen, dass
           hier etwas zu bedienen ist. Eine Flaeche daneben waere ein
           zweiter Kasten im Kasten. */
        background: transparent;
        transition: border-color 0.12s;
      }
      .mode-group:hover {
        border-color: var(--accent);
      }
      .mode-group:has(:focus-visible) {
        border-color: var(--accent);
      }
      .local .mode-label {
        margin-right: 1px;
        color: var(--ink);
        cursor: pointer;
      }
      .pick {
        position: relative;
        display: inline-flex;
        align-items: center;
        color: var(--accent);
      }
      /* Die aufgeklappte Liste: beide Orte untereinander, jeder mit seinen
         Angaben. Sie sieht aus wie die Sprechblase am ⓘ, weil sie deren
         Aufgabe uebernommen hat. */
      .pick-panel {
        position: absolute;
        top: calc(100% + 11px);
        right: -9px;
        z-index: 6;
        display: grid;
        gap: 4px;
        width: max-content;
        max-width: min(310px, 86cqw);
        padding: 5px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel-2);
        box-shadow: 0 16px 34px -12px light-dark(rgb(24 19 30 / 0.34), rgb(0 0 0 / 0.65));
      }
      .pick-opt {
        display: block;
        padding: 7px 9px;
        border: 1px solid transparent;
        border-radius: 7px;
        color: var(--ink);
        cursor: pointer;
      }
      .pick-opt:hover {
        border-color: var(--edge);
      }
      .pick-opt.on {
        border-color: var(--accent);
        background: light-dark(#f7e9e9, #31232d);
      }
      .pick-opt:has(input:focus-visible) {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      /* Laeuft gerade ein Job, bleibt die Liste lesbar, aber nicht
         bedienbar: die Angaben sind dann erst recht interessant. */
      .pick-opt:has(input:disabled) {
        opacity: 0.55;
        cursor: default;
      }
      .pick-opt input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }
      .pick-head {
        display: block;
        margin-bottom: 4px;
        font-size: 11.5px;
        font-weight: 650;
      }
      /* Die zwei Zeilen darunter: Verfahren und Geraet. Eine Stufe
         kleiner, in der Schrift der Messwerte — es sind Namen, keine
         Saetze, und untereinander sollen sie sich ausrichten. */
      .pick-sum {
        display: block;
        color: var(--dim);
        font-family: var(--mono);
        font-size: 10.5px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .pick-sum.dim {
        color: var(--faint);
      }
      .local .site-pick {
        appearance: none;
        color: var(--accent);
        margin-left: -4px;
        padding: 1px 15px 1px 4px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        font: inherit;
        cursor: pointer;
      }
      .local .site-pick:hover:not(:disabled) {
        filter: brightness(1.12);
      }
      .local .site-pick:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      /* Die aufgeklappte Liste zeichnet das System, nicht diese Karte —
         ohne diese Zeile stuende sie im Dunkelmodus schwarz auf schwarz. */
      .local .site-pick option {
        background: var(--panel-2);
        color: var(--ink);
      }

      /* ------------------------------------------------------ Rueckfrage */
      .ask {
        width: min(400px, calc(100vw - 32px));
        padding: 19px 21px 16px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel-2);
        color: var(--ink);
      }
      .ask::backdrop {
        background: light-dark(rgb(28 22 34 / 0.32), rgb(0 0 0 / 0.55));
      }
      .ask-q {
        margin: 0;
        font-size: 15px;
        font-weight: 650;
      }
      .ask-why {
        margin: 8px 0 0;
        color: var(--dim);
        font-size: 12px;
        line-height: 1.55;
      }
      .ask-go {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 16px;
        margin-top: 18px;
      }

      /* Die Spuren des gewaehlten Modus, jede mit dem Strich in ihrer
         Farbe — derselben, die sie spaeter im Deck traegt. */
      .outputs {
        display: flex;
        flex-wrap: wrap;
        gap: 5px 11px;
        margin-top: 11px;
        min-height: 20px;
        color: var(--dim);
        font-size: 12px;
      }
      .stem {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .stem::before {
        content: '';
        width: 8px;
        height: 3px;
        border-radius: 4px;
        background: var(--sig);
      }

      /* ------------------------------------------------------------- Fuss */
      /* Der Fuss ist ein eigenes Band und nicht bloss eine Trennlinie im
         Polster: eigene Flaeche, ueber die ganze Breite der Karte bis an
         ihre Kanten, abgesetzt durch eine Kante nach oben. Deshalb steht
         er in der Vorlage neben .inner und nicht darin. Die Rundung unten
         besorgt das overflow: hidden der Karte. */
      .foot {
        padding: 14px 18px;
        border-top: 1px solid var(--edge);
        /* Dieselbe Flaeche wie die Karte, nur eine Stufe dunkler als das
           panel-2, das hier zuerst stand: das Band traegt sich ueber seine
           Kante nach oben und das Polster bis an die Kartenraender, nicht
           ueber eine zweite Farbe. */
        background: var(--panel);
      }
      .go {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px 14px;
        flex-wrap: wrap;
      }
      /* Die Nebenhandlung ist ein Knopf in derselben Form wie die
         Hauptaktion daneben: gleiche Hoehe, gleiche Rundung, gleiches
         Polster. Nur die Flaeche ist eine ruhige -- zwei gleich helle
         Knoepfe waeren zwei gleich laute Angebote, und die Hauptaktion
         steht rechts. */
      /* Derselbe Knopf wie rechts, nur gedaempft: dieselbe Flaeche und
         dieselbe graue Schrift, die die Hauptaktion traegt, solange sie
         wartet. Die 0,72 Deckkraft von dort fehlt mit Absicht -- die
         gehoert zum Ausgegrauten, und dieser Knopf ist zu haben. */
      button.demo {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 38px;
        padding: 8px 14px;
        /* Die Kante ist schon da, nur unsichtbar: beim Zeigen faerbt sie
           sich, statt zu erscheinen. Sonst waere der Knopf unter dem
           Zeiger zwei Pixel groesser als daneben. */
        border: 1px solid transparent;
        border-radius: 8px;
        background: var(--panel-2);
        color: var(--dim);
        font-weight: 700;
      }
      button.demo:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      button.start {
        min-height: 38px;
        padding: 8px 14px;
        border: 0;
        border-radius: 8px;
        background: var(--key);
        color: var(--on-key);
        font-weight: 700;
      }
      button.start:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      button.start:disabled {
        background: var(--panel-2);
        color: var(--dim);
        opacity: 0.72;
      }

      .hint {
        margin-top: 8px;
        color: var(--dim);
        font-size: 12px;
      }

      @container (max-width: 350px) {
        .inner {
          padding: 13px;
        }
        .foot {
          padding: 11px 13px;
        }
        .mode {
          padding-inline: 5px;
        }
        button.demo,
        button.start {
          width: 100%;
        }
      }
      @media (pointer: coarse) {
        button.demo,
        button.start {
          min-height: 44px;
        }
      }
    `,
  ],
  template: `
    <section class="panel box">
      <header class="bar">
        <div class="brand">
          <img class="logo" src="/app-icon.svg" alt="" aria-hidden="true" width="28" height="28" />
          <strong>MixApart</strong>
        </div>
        <span class="local">
          <!-- Der Trennort steht da, wo vorher nur sein Name stand, und das
               ⓘ ist darin aufgegangen: aufgeklappt zeigt die Liste beide
               Moeglichkeiten **mit ihren Angaben nebeneinander**. Vorher
               nannte die Blase nur den gerade gewaehlten Ort — wer
               vergleichen wollte, musste erst umschalten, also genau das
               tun, worueber er sich noch nicht entschieden hatte.

               Die Eintraege sind echte Optionsfelder in einer
               Radiogruppe: Pfeiltasten, Auswahl und Vorlesesoftware
               kommen damit ohne eigenen Code zurecht. -->
          @if (jobs.serverAvailable) {
            <span class="mode-group">
            <span class="mode-label" id="site-label">Modus:</span>
            <div class="pick" (focusout)="onPickBlur($event)">
              <button
                #pickButton
                type="button"
                class="site-pick"
                data-testid="site-select"
                aria-haspopup="true"
                aria-labelledby="site-label site-pick-value"
                [attr.aria-expanded]="pickOpen()"
                (click)="pickOpen.set(!pickOpen())"
                (keydown.escape)="closePick()"
                (keydown.arrowdown)="onPickKey($event)"
                (keydown.arrowup)="onPickKey($event)"
              >
                <span id="site-pick-value">{{ currentSite().short }}</span>
              </button>
              @if (pickOpen()) {
                <div
                  class="pick-panel"
                  role="radiogroup"
                  aria-label="Wo getrennt wird"
                  data-testid="site-panel"
                  (keydown.escape)="closePick()"
                >
                  @for (s of SITES; track s.key) {
                    <label
                      class="pick-opt"
                      [class.on]="site() === s.key"
                      data-testid="site-option"
                      [attr.data-site]="s.key"
                      [title]="s.hint"
                    >
                      <input
                        type="radio"
                        name="site"
                        [value]="s.key"
                        [checked]="site() === s.key"
                        [disabled]="busy()"
                        (change)="chooseSite(s.key)"
                      />
                      <span class="pick-head">{{ s.short }}</span>
                      <!-- Zwei Zeilen, mehr nicht: womit gerechnet wird und
                           worauf. Alles Weitere steht im Fenster der
                           laufenden Trennung — dort wartet man ohnehin. -->
                      <span class="pick-sum">{{ facts.summary(s.key).method }}</span>
                      <span class="pick-sum dim">{{ facts.summary(s.key).device }}</span>
                    </label>
                  }
                </div>
              }
            </div>
            </span>
          } @else {
            <!-- Ohne Wahl bleibt es beim Satz und beim ⓘ daneben: eine
                 Liste mit einem Eintrag waere keine Wahl, die Angaben
                 muessen aber trotzdem irgendwo stehen. -->
            {{ VARIANT.label }}
            <span class="what-wrap">
              <button
                type="button"
                class="what"
                data-testid="device-info"
                aria-label="Worauf gerechnet wird"
                aria-describedby="device-tip"
                [attr.aria-expanded]="infoOpen()"
                (click)="infoOpen.set(!infoOpen())"
                (blur)="infoOpen.set(false)"
              >
                <app-icon name="info" />
              </button>
              <span
                class="tip"
                id="device-tip"
                role="tooltip"
                data-testid="device-tip"
                [class.show]="infoOpen()"
              >
                <dl>
                  @for (row of deviceRows(); track row.label) {
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  }
                </dl>
              </span>
            </span>
          }
        </span>
      </header>

      <div class="inner">
      <div class="eyebrow">Import</div>
      <h2 class="lede">Song trennen</h2>

      <!-- ------------------------------------------------------- Datei -->
      <label
        class="drop"
        [class.over]="over()"
        (dragenter)="over.set(true)"
        (dragover)="over.set(true)"
        (dragleave)="over.set(false)"
        (drop)="over.set(false)"
      >
        <input
          #fileInput
          id="audio-file"
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav"
          [disabled]="busy()"
          aria-label="MP3- oder WAV-Datei auswählen"
          (change)="pick($event)"
        />
        <span>
          <span class="wave" aria-hidden="true">
            @for (bar of bars; track $index) {
              <i [style.height.px]="bar.h" [style.opacity]="bar.a"></i>
            }
          </span>
          <span class="file-label">
            {{ file()?.name ?? 'MP3 oder WAV hierher ziehen' }}
          </span>
          <span class="sub">
            {{ file() ? 'Andere Datei auswählen' : 'oder Datei auswählen' }}
          </span>
        </span>
      </label>

      <!-- -------------------------------------------------- Trennmodus -->
      <p class="model-head" id="mode-label">Trennmodus</p>
      <div class="modes" role="radiogroup" aria-labelledby="mode-label">
        @for (m of models(); track m.name) {
          <label
            class="mode"
            [class.on]="model() === m.name"
            data-testid="model"
          >
            <input
              type="radio"
              name="model"
              [value]="m.name"
              [checked]="model() === m.name"
              [disabled]="busy()"
              (change)="model.set(m.name)"
            />
            {{ m.mode }}
            <span>{{ m.stems.length }} Spuren</span>
          </label>
        }
      </div>

      <!-- Eine leere Modusliste darf nicht stumm bleiben. Sie sah aus wie
           „noch nicht geladen" und blieb es auch: Grund war ein alter
           Eintrag im Browser-Cache, und ohne diese Zeile gab es nichts,
           woran das zu erkennen war. -->
      @if (site() === 'device' && device.modelProblem(); as why) {
        <div class="notice" style="margin-top: 12px" data-testid="no-model">
          <span><strong>Kein Trennmodus:</strong> {{ why }}</span>
        </div>
      }

      <div class="outputs" aria-live="polite" aria-label="Spuren im gewählten Modus">
        @if (selectedModel(); as m) {
          @for (stem of m.stems; track stem; let i = $index) {
            <span class="stem" [style.--sig]="color(stem, i)">{{ stem }}</span>
          }
        }
      </div>

      <!-- Kein WebGPU, oder nur eine Software-Umsetzung. Das ist eine
           Warnung und keine Sperre: gerechnet wird dann auf dem Prozessor,
           und das dauert. Wer die Wartezeit in Kauf nimmt, soll trennen
           können — aber vorher wissen, worauf er sich einlässt, und nicht
           erst nach zehn Minuten. -->
      @if (site() === 'device' && deviceProblem(); as why) {
        <div class="notice" style="margin-top: 12px" data-testid="no-webgpu">
          <span>
            <strong>Keine Grafikbeschleunigung:</strong> {{ why }}
            Getrennt wird dann auf dem Prozessor — das geht, dauert aber ein
            Vielfaches, bei einem ganzen Lied eher zehn Minuten als eine.
            @if (jobs.serverAvailable) {
              Über „Auf diesem Rechner“ läuft es in Sekunden.
            }
          </span>
        </div>
      }

      @if (selectedModel(); as m) {
        <!-- Der Browserpfad sagt seinen Download nicht mehr hier: 174 MB
             sind eine Folge des Startens, kein Zustand der Karte. Gefragt
             wird beim Start, siehe ask() weiter unten. Der Backendpfad bleibt stehen,
             weil dort ein Befehl steht, den jemand abtippen koennen muss —
             in einer Sprechblase waere er nicht zu markieren. -->
        @if (m.site === 'server' && !m.downloaded) {
          <div class="notice" style="margin-top: 12px">
            <span>
              <strong>{{ m.mode }}</strong> ({{ m.name }}) wird beim ersten Lauf
              erst heruntergeladen ({{ m.missing_files.length }}
              {{ m.missing_files.length === 1 ? 'Datei' : 'Dateien' }}). Der Job
              bleibt so lange auf „Wird verarbeitet“. Schlägt der Download fehl,
              hilft
              <span class="mono">python tools/fetch_model_configs.py {{ m.name }}</span>:
              das Skript probiert mehrere Quellen und sagt, woran es scheitert.
            </span>
          </div>
        }
      }

      @if (error(); as e) {
        <div class="notice bad" style="margin-top: 12px"><span>{{ e }}</span></div>
      }

      <!-- Die Rueckfrage vor dem ersten Modelldownload.
           Oben die Frage, darunter klein und grau, was sie nach sich zieht:
           wer weiss, worum es geht, liest nur die erste Zeile. Escape und
           ein Klick daneben zaehlen wie „Nein" — das Teuerste darf nicht
           das sein, was aus Versehen passiert. -->
      <dialog
        #askDialog
        class="ask"
        data-testid="ask-download"
        (close)="onAskClosed()"
        (click)="onAskClick($event)"
      >
        @if (pending(); as ask) {
          <p class="ask-q">{{ ask.question }}</p>
          <p class="ask-why">{{ ask.why }}</p>
          <div class="ask-go">
            <button type="button" class="demo" (click)="answer(false)">Nein</button>
            <button type="button" class="start" (click)="answer(true)">Ja</button>
          </div>
        }
      </dialog>

      </div>

      <!-- --------------------------------------------------------- Fuss -->
      <footer class="foot">
      <div class="go">
        <button
          type="button"
          class="demo"
          [disabled]="busy()"
          title="Legt drei synthetische Spuren an, ohne zu trennen: zwei Klickspuren mit Klicks auf genau denselben Zeitpunkten und einen 440-Hz-Dauerton. Laufen die Klickspuren synchron, hört man einen einzigen Klick."
          (click)="startTest()"
        >
          <app-icon name="plus" />Testspuren anlegen
        </button>
        <button
          type="button"
          class="start"
          [disabled]="!canStart()"
          (click)="start()"
        >
          {{ startLabel() }} <span aria-hidden="true">↗</span>
        </button>
      </div>

      @if (hint(); as h) {
        <p class="hint" role="status">{{ h }}</p>
      }
      </footer>
    </section>
  `,
})
export class ImportPanelComponent {
  readonly api = inject(ApiService);
  readonly device = inject(DeviceSeparator);
  readonly facts = inject(DeviceFacts);
  private readonly jobs = inject(JobsService);

  readonly VARIANT = VARIANT;

  /** Der angelegte Job — der Aufrufer zeigt ihm beim Laufen zu. */
  readonly started = output<Job>();

  private readonly fileInput =
    viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  readonly bars = BARS;

  /**
   * Die beiden Trennorte.
   *
   * „Auf diesem Gerät" steht zuerst und ist die Vorgabe: es braucht kein
   * Backend, nichts verlässt den Rechner, und es ist der Weg, den die
   * öffentliche Variante überhaupt hat. „Auf diesem Rechner" meint den
   * Python-Dienst mit CUDA — schneller, aber er muss laufen.
   */
  readonly SITES: readonly {
    key: Site;
    label: string;
    /** Was auf dem Knopf und ueber dem Eintrag steht. Ein Wort. */
    short: string;
    where: string;
    hint: string;
  }[] = [
    {
      key: 'device',
      label: 'Auf diesem Gerät',
      short: 'Browser',
      where: 'im Browser, WebGPU',
      hint:
        'Rechnet im Browser auf der Grafikkarte. Kein Backend nötig, die ' +
        'Datei verlässt das Gerät nicht. Beim ersten Lauf werden die ' +
        'Modellgewichte geladen.',
    },
    {
      key: 'server',
      label: 'Auf diesem Rechner',
      short: 'Lokal',
      where: 'Python, CUDA',
      hint:
        'Rechnet im lokalen Python-Dienst mit CUDA. Deutlich schneller, ' +
        'braucht aber das laufende Backend.',
    },
  ];

  readonly file = signal<File | null>(null);
  /** Vorgabe: auf dem Gerät. */
  readonly site = signal<Site>('device');
  readonly model = signal('htdemucs');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Kurze Rueckmeldung unter der Fusszeile, etwa zum Dateityp. */
  readonly hint = signal<string | null>(null);
  /** Haengt eine Datei gerade ueber der Ablegeflaeche? */
  readonly over = signal(false);

  /** Die Modi des gewählten Orts — und nur die. */
  readonly models = computed(() => this.jobs.modelsFor(this.site()));

  readonly selectedModel = computed(
    () => this.models().find((m) => m.name === this.model()) ?? null,
  );

  /**
   * Warum „Auf diesem Gerät" nicht geht — oder `null`.
   *
   * Fehlendes WebGPU und eine Software-Umsetzung sind verschiedene Dinge mit
   * derselben Folge, und beide stehen im Klartext in `probeWebGpu`.
   */
  readonly deviceProblem = computed(() => {
    const support = this.device.support();
    if (!support) return null; // wird noch geprüft
    return support.available ? null : support.reason;
  });

  /**
   * Wechselt den Ort und zieht den Trennmodus mit.
   *
   * Beide Orte haben „Schnell"; „Instrumente" kann hier und dort fehlen.
   * Stünde der Modus nach dem Wechsel auf etwas, das es am neuen Ort nicht
   * gibt, wäre keine Karte markiert und der Knopf meldete einen Fehler, den
   * niemand verursacht hat.
   */
  setSite(site: Site): void {
    this.site.set(site);
    this.error.set(null);
    const available = this.jobs.modelsFor(site);
    if (available.some((m) => m.name === this.model())) return;
    const fallback = available.find((m) => m.is_default) ?? available[0];
    if (fallback) this.model.set(fallback.name);
  }

  megabytes(bytes: number): number {
    return Math.round(bytes / 1e6);
  }

  /** Ist die Sprechblase angetippt offen? Fuer Finger und Tastatur. */
  readonly infoOpen = signal(false);

  /** Ist die Ortsliste aufgeklappt? */
  readonly pickOpen = signal(false);

  private readonly pickButton =
    viewChild<ElementRef<HTMLButtonElement>>('pickButton');

  readonly currentSite = computed(
    () => this.SITES.find((s) => s.key === this.site()) ?? this.SITES[0],
  );

  /**
   * Klappt zu, sobald der Fokus die Liste verlaesst.
   *
   * `relatedTarget` ist das, was den Fokus bekommt. Liegt es noch in der
   * Liste — etwa beim Wandern von einem Eintrag zum naechsten —, bleibt
   * sie offen.
   */
  onPickBlur(event: FocusEvent): void {
    const next = event.relatedTarget;
    // Ein `relatedTarget` von `null` heisst: der Fokus ging nirgendwohin.
    // Das passiert mitten in einem gewoehnlichen Mausklick auf einen
    // Eintrag — beim Druecken verlaesst er den Knopf, und erst beim
    // Loslassen landet er im Optionsfeld. Wer hier zuklappt, nimmt dem
    // Klick das Ziel weg, und die Wahl kommt nie an. Genau das ist
    // passiert: ein schneller, synthetischer Klick traf noch, ein
    // menschlicher Tastendruck von achtzig Millisekunden nicht mehr.
    //
    // Zugeklappt wird deshalb nur, wenn der Fokus wirklich woandershin
    // geht. Fuer alles andere sorgen Escape und das Zeigen daneben.
    if (!next) return;
    const wrap = (event.currentTarget as HTMLElement) ?? null;
    if (next instanceof Node && wrap?.contains(next)) return;
    this.pickOpen.set(false);
  }

  /**
   * Pfeiltaste auf dem Knopf klappt auf und springt in die Liste.
   *
   * Wer ein Auswahlfeld vor sich sieht, probiert die Pfeiltasten. Vorher
   * geschah dabei nichts — der Knopf ist keins, und die Optionsfelder
   * liegen eine Ebene tiefer.
   */
  onPickKey(event: Event): void {
    event.preventDefault();
    if (!this.pickOpen()) this.pickOpen.set(true);
    // Erst nach dem Zeichnen: vorher gibt es die Eintraege noch nicht.
    setTimeout(() => {
      const host = this.pickButton()?.nativeElement.closest('.pick') ?? null;
      const radio =
        host?.querySelector<HTMLInputElement>('input[name="site"]:checked') ??
        host?.querySelector<HTMLInputElement>('input[name="site"]');
      radio?.focus();
    });
  }

  /**
   * Ein Zeigen daneben klappt zu.
   *
   * Der Fokus allein reicht nicht: ein Tippen auf leere Flaeche bewegt ihn
   * auf manchen Geraeten gar nicht, und die Liste bliebe stehen.
   */
  onDocumentPointerDown(event: Event): void {
    if (!this.pickOpen()) return;
    const target = event.target;
    const host = this.pickButton()?.nativeElement.closest('.pick') ?? null;
    if (target instanceof Node && host?.contains(target)) return;
    this.pickOpen.set(false);
  }

  closePick(): void {
    if (!this.pickOpen()) return;
    this.pickOpen.set(false);
    this.pickButton()?.nativeElement.focus();
  }

  /** Ort waehlen und zuklappen — der Fokus geht zurueck auf den Knopf. */
  chooseSite(site: Site): void {
    this.setSite(site);
    this.closePick();
  }

  /**
   * Die offene Rueckfrage, oder `null`.
   *
   * Zwei Arten teilen sich denselben Dialog: der Modelldownload und der
   * Speicher. `kind` entscheidet, was ein „Ja" auslöst — ohne das wäre
   * `answer()` nicht zu sagen, welche Frage gerade beantwortet wurde.
   */
  readonly pending = signal<{
    kind: 'speicher' | 'download';
    question: string;
    why: string;
  } | null>(null);

  /**
   * Die Datei, für die der Speicher schon bejaht wurde.
   *
   * Dieselbe Begründung wie bei `agreed`: wer gerade „trotzdem" gesagt
   * hat, soll nicht bei jedem Anlauf wieder gefragt werden. Hängt an der
   * Datei, weil die Frage von ihrer Länge abhängt.
   */
  private memoryAgreed: File | null = null;

  /**
   * Modi, deren Download in dieser Sitzung schon bejaht wurde.
   *
   * `downloaded` wird erst wahr, wenn die Gewichte liegen. Ohne dieses
   * Gedaechtnis fragte ein Abbruch mit anschliessendem zweiten Versuch
   * dieselbe Frage noch einmal — und das ist der Fall, in dem der Mensch
   * gerade bewiesen hat, dass er sie kennt.
   */
  private readonly agreed = new Set<string>();

  private readonly askDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('askDialog');

  /**
   * Worauf gerechnet wird — alles, was hinter dem (i) steht.
   *
   * Je Ort etwas anderes: beim Gerät der Grafikadapter und die Fassung der
   * Runtime, beim Backend die Grafikkarte, der freie Speicher und die
   * Fassungen von PyTorch und CUDA.
   */
  /**
   * Die langen Angaben — nur noch fuer das ⓘ der oeffentlichen Variante.
   *
   * Dort gibt es keine Ortsliste und kein anderes Fenster, in dem sie
   * stehen koennten; in der lokalen Variante zeigt sie das Fenster der
   * laufenden Trennung.
   */
  readonly deviceRows = computed(() => this.facts.rows(this.site()));





  readonly startLabel = computed(() => {
    if (this.busy()) {
      return this.site() === 'device' ? 'wird vorbereitet …' : 'wird hochgeladen …';
    }
    const stems = this.selectedModel()?.stems.length;
    return stems ? `${stems} Spuren trennen` : 'Trennen';
  });

  /**
   * Kann jetzt getrennt werden?
   *
   * Fehlende Grafikbeschleunigung hält hier nicht auf — dann rechnet der
   * Prozessor, und die Warnung darüber sagt, was das bedeutet. Was aufhält,
   * ist eine Trennung, die schon läuft: davon gibt es eine je Tab.
   */
  readonly canStart = computed(() => {
    if (!this.file() || this.busy()) return false;
    if (!this.selectedModel()) return false;
    if (this.site() === 'device') return !this.device.busy();
    return true;
  });

  color(stem: string, index: number): string {
    return stemColor(stem.toLowerCase(), index, stem);
  }

  /**
   * `accept` filtert nur den Dateidialog. Hineingezogen werden kann alles,
   * und eine Textdatei ergaebe erst beim Hochladen einen Fehler vom Server
   * — das sagt sich hier schneller.
   */
  pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    this.error.set(null);
    if (chosen && !ACCEPTED.test(chosen.name)) {
      this.hint.set('Bitte eine MP3- oder WAV-Datei auswählen.');
      input.value = '';
      return;
    }
    this.hint.set(null);
    this.file.set(chosen);
    // Die Zusage galt der vorigen Datei und ihrer Länge, nicht dieser.
    this.memoryAgreed = null;
  }

  /**
   * Startet — oder fragt vorher. Zweimal, im schlimmsten Fall.
   *
   * Gefragt wird nur im Browserpfad: dort laedt der Start 174 MB ueber
   * die Leitung des Menschen, und dort liegt die ganze Trennung in
   * seinem Arbeitsspeicher. Beides sind Folgen, die vor den Klick
   * gehoeren und nicht dahinter. Der Backendpfad laedt auf dem Server und
   * rechnet dort, und fragt deshalb keines von beidem.
   *
   * Die Reihenfolge ist Absicht: erst der Speicher, dann der Download.
   * Wer wegen der Laenge abbricht, soll das koennen, bevor die 174 MB
   * geflossen sind.
   */
  async start(): Promise<void> {
    const file = this.file();
    if (!file) return;
    const model = this.selectedModel();

    // Der Speicher zuerst, der Download danach. Wer wegen der Länge
    // abbricht, soll das tun können, bevor 174 MB über seine Leitung
    // gegangen sind — andersherum wäre die teure Frage die erste.
    if (model?.site === 'device' && this.memoryAgreed !== file) {
      if ((await this.judgeMemory(file, model)) !== 'weiter') return;
    }
    this.afterMemory();
  }

  /** Download-Rueckfrage, oder los. */
  private afterMemory(): void {
    const model = this.selectedModel();
    if (
      model &&
      model.site === 'device' &&
      !model.downloaded &&
      !this.agreed.has(model.name)
    ) {
      this.ask(model);
      return;
    }
    void this.launch();
  }

  /**
   * Passt der Song in den Arbeitsspeicher dieses Geraets?
   *
   * Getrennt wird im Arbeitsspeicher der Sitzung, und die Laenge des
   * Liedes ist damit eine Systemgrenze — siehe `memory-budget.ts`. Bis
   * hierher lief jeder Start ungeprueft los; ging er schief, starb der
   * Tab ohne Meldung, und niemand erfuhr, woran es lag.
   *
   * Drei Ausgaenge: `weiter` (reicht, oder nicht zu beurteilen), `halt`
   * (aussichtslos, Meldung steht) und `gefragt` (Dialog ist offen, es
   * geht in `answer()` weiter).
   */
  private async judgeMemory(
    file: File,
    model: ModelInfo,
  ): Promise<'weiter' | 'halt' | 'gefragt'> {
    const stems = model.peak_stems;
    // Ohne Spurzahl oder ohne lesbare Laenge wird nicht geraten. Ein
    // Waechter, der seine Zahlen nicht kennt, haelt sich heraus.
    if (!stems) return 'weiter';
    const seconds = await probeDuration(file);
    if (seconds === null) return 'weiter';

    const urteil = assess(seconds, stems);
    if (urteil.verdict === 'reicht') return 'weiter';

    const mb = (n: number) => Math.round(n).toLocaleString('de-DE');
    const geraet = urteil.measured
      ? `Dieses Gerät meldet ${deviceMemoryGb().gb} GB.`
      : 'Dieser Browser nennt den Speicher des Geräts nicht; angenommen sind 4 GB.';
    // Die Spitze, nicht das Ergebnis: bei „Minimum" stehen am Ende zwei
    // Spuren, während des Laufs sind es vier.
    const waehrend =
      `„${model.mode}" hält während des Laufs ${stems} Spuren und die ` +
      `Eingabe gleichzeitig im Arbeitsspeicher`;

    if (urteil.verdict === 'aussichtslos') {
      // Zwei verschiedene Absagen. Liegt die machbare Länge unter einer
      // halben Minute, ist nicht der Song zu lang, sondern das Gerät zu
      // klein — dann wäre „nimm einen kürzeren Ausschnitt" ein Rat, der
      // ins Leere geht.
      this.error.set(
        urteil.fitsSeconds < SHORTEST_WORTH_SUGGESTING_S
          ? `Für „${model.mode}" reicht der Arbeitsspeicher dieses Geräts nicht: ` +
              `gebraucht werden rund ${mb(urteil.neededMib)} MB, und allein die ` +
              `Modellgewichte belegen davon etwa 400 MB. ${geraet} Ein kürzerer ` +
              'Ausschnitt hilft hier nicht.'
          : `${asMinutes(seconds)} ist zu lang für dieses Gerät. ${waehrend} — ` +
              `zusammen mit dem Modell rund ${mb(urteil.neededMib)} MB. ${geraet} ` +
              `Bis etwa ${asMinutes(urteil.fitsSeconds)} geht es hier; ein kürzerer ` +
              'Ausschnitt lässt sich trennen.',
      );
      return 'halt';
    }

    this.pending.set({
      kind: 'speicher',
      question: `Knapp: rund ${mb(urteil.neededMib)} MB Arbeitsspeicher nötig.`,
      why:
        `${waehrend} — bei ${asMinutes(seconds)} sind das ${mb(urteil.audioMib)} MB, ` +
        `dazu etwa 400 MB für das Modell. ${geraet} Es kann gutgehen. Geht es ` +
        'nicht gut, beendet der Browser den Tab, und die Trennung ist weg — ' +
        'gespeichert wird unterwegs nichts.',
    });
    this.askDialog().nativeElement.showModal();
    return 'gefragt';
  }

  private ask(model: ModelInfo): void {
    const mb = this.megabytes(model.download_bytes ?? 0);
    this.pending.set({
      kind: 'download',
      question: `${mb} MB Modellgewichte laden?`,
      why:
        `„${model.mode}" (${model.name}) rechnet im Browser und holt die ` +
        'Gewichte dafür einmalig. Sie bleiben danach im Browser-Cache: ' +
        'jeder weitere Song beginnt sofort, auch ohne Netz. Über Mobilfunk ' +
        'zählen die ' +
        `${mb} MB auf das Datenvolumen.`,
    });
    this.askDialog().nativeElement.showModal();
  }

  /**
   * „Ja" startet, alles andere nicht.
   *
   * Welche Frage offen war, muss **vor** dem Schliessen gelesen werden:
   * das `close`-Ereignis setzt `pending` auf `null`.
   */
  answer(yes: boolean): void {
    const offen = this.pending();
    const model = this.selectedModel();
    this.askDialog().nativeElement.close();
    if (!yes) return;
    if (offen?.kind === 'speicher') {
      this.memoryAgreed = this.file();
      this.afterMemory();
      return;
    }
    if (!model) return;
    this.agreed.add(model.name);
    void this.launch();
  }

  /**
   * Aufraeumen, wenn der Dialog wirklich zu ist.
   *
   * Nicht einfach `pending.set(null)`: `close()` feuert sein Ereignis
   * **nachtraeglich**, als eigene Aufgabe. Auf die Speicherfrage folgt
   * aber unter Umstaenden sofort die Downloadfrage, die denselben Dialog
   * wieder oeffnet — das Ereignis der ersten traefe dann die zweite und
   * loeschte ihren Text, waehrend sie offen steht. Gefragt wird deshalb
   * den Dialog selbst, ob er noch auf ist.
   */
  onAskClosed(): void {
    if (!this.askDialog().nativeElement.open) this.pending.set(null);
  }

  /**
   * Ein Klick auf den Schleier zaehlt als „Nein".
   *
   * Das Ereignis des Dialogs trifft bei einem Klick daneben ihn selbst;
   * im Inneren trifft es den Absatz oder den Knopf. Genau daran laesst
   * sich beides unterscheiden.
   */
  onAskClick(event: MouseEvent): void {
    if (event.target === this.askDialog().nativeElement) this.answer(false);
  }

  private async launch(): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.busy.set(true);
    this.error.set(null);
    this.hint.set(null);
    try {
      const job =
        this.site() === 'device'
          ? await this.device.start(file, this.model())
          : await this.api.upload(file, this.model());
      this.file.set(null);
      // Auch das Eingabefeld leeren. Sonst steht dort weiter ein Dateiname,
      // waehrend "Trennen" deaktiviert ist, und dieselbe Datei nochmal zu
      // waehlen loest kein change-Ereignis aus.
      this.fileInput().nativeElement.value = '';
      this.started.emit(job);
    } catch (err) {
      this.error.set(describeHttp(err));
    } finally {
      this.busy.set(false);
    }
  }

  async startTest(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.hint.set(null);
    try {
      // Ohne Backend legt der Browser die Testspuren selbst an — dieselben
      // drei Spuren, aus derselben Vorschrift.
      if (this.api.enabled) await this.api.createTestJob();
      else this.device.createTestJob();
    } catch (err) {
      this.error.set(describeHttp(err));
    } finally {
      this.busy.set(false);
    }
  }
}
