import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ApiService, describeHttp } from '../core/api.service';
import { IconComponent } from '../core/icon';
import type { Texte } from '../i18n/de';
import { I18n } from '../i18n/i18n';
import { LangSwitchComponent } from '../i18n/lang-switch';
import { DeviceFacts } from '../core/device-facts';
import { CloudSeparator } from '../separate/cloud-separator';
import { JobsService, type Site } from '../core/jobs.service';
import type { Job, ModelInfo } from '../core/models';
import { stemColor } from '../core/stem-colors';
import { stemSlug } from '../core/stem-labels';
import { VARIANT } from '../core/variant';
import { DeviceSeparator } from '../separate/device-separator';
import { probeDuration } from '../separate/decode';
import { isMobileDevice } from '../separate/platform';
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
  imports: [IconComponent, LangSwitchComponent],
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
      /* Eine Stufe schwaecher als --faint, aber nicht schwaecher als
         lesbar: #635d70 auf der Karte waren 2,7:1 und damit der klarste
         Kontrastfehler der Seite. Der neue Wert liegt bei 5,0:1 und bleibt
         trotzdem unter --faint (5,3:1) — die Abstufung, um die es hier
         geht, steht also weiter, nur eben oberhalb der Grenze. */
      .local {
        font-size: 11px;
        color: light-dark(#706a80, #8e879b);
      }
      .what-wrap {
        position: relative;
        display: inline-flex;
      }
      /* Der Strich zwischen Trennort und Sprache. Schwaecher als der Text
         links und rechts davon: er trennt, er sagt nichts. */
      .sep {
        opacity: 0.45;
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
        border-radius: 0;
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
        border-radius: 0;
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

         Das Winkelchen war lange ein um 45 Grad gedrehtes Quadrat aus zwei
         Raendern. Das sieht sparsam aus und ist es nicht: gedreht liegt
         die sichtbare Tinte eines solchen Kaestchens nicht in seiner Box,
         sondern daneben, und jede Zentrierung braucht einen Ausgleich von
         Hand. Drei Anlaeufe, drei Messungen, dreimal daneben — und beim
         naechsten Eingriff an Schrift oder Zeilenhoehe waere es wieder
         krumm gewesen.

         Jetzt steht dort das Lucide-Zeichen aus app-icon. Dessen Pfad
         ist symmetrisch zur Mitte des Zeichenfelds (m6 9 6 6 6-6: Tinte
         von 9 bis 15 bei 24 Einheiten), und der Knopf ist ein Flexkasten
         mit align-items: center. Die Mitte macht damit der Umbruch, und
         es gibt keine Zahl mehr, die falsch werden kann. */
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
        border-radius: 0;
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
        display: inline-flex;
        align-items: center;
        gap: 1px;
        /* Groesse des Zeichens, relativ zur Kopfzeilenschrift: so bleiben
           Wort und Winkel im Verhaeltnis, auch wenn die Schrift sich
           aendert. */
        --icon-size: 1.4em;
        color: var(--accent);
        margin-left: -4px;
        padding: 1px 2px 1px 4px;
        border: 1px solid transparent;
        border-radius: 0;
        background: transparent;
        font: inherit;
        cursor: pointer;
      }
      /* Hier stand lange ein Ausgleich. Es braucht keinen.

         Das Lucide-Zeichen ist symmetrisch zur Mitte seines Zeichenfelds,
         der Knopf zentriert es mit align-items: center, und damit sitzt
         es auf der Mitte der Schrift daneben. Gemessen, je Element
         einzeln aufgenommen und in Seitenkoordinaten verglichen:

           Versatz                       11px     16px     30px
           ohne                          0,14    -0,06    -0,28
           (1cap - 1em) / 2             -1,56    -3,05    -4,95
           (1cap - 1em) / 4             -0,70    -1,80    -2,11
           (1cap - 1em) / 8             -0,78    -0,67    -1,44

         Jeder Ausgleich verschlechtert es. Die vier Anlaeufe davor
         korrigierten einen Fehler, der aus dem gedrehten Rand-Kaestchen
         kam und mit dem Zeichen verschwunden ist — und sie wurden gegen
         DejaVu Sans gemessen, waehrend auf dem Zielrechner Segoe UI
         steht. Wer hier wieder eine Zahl eintragen will: die Tabelle
         oben ist der Grund, es nicht zu tun. */
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
        border-radius: 0;
        background: var(--panel-2);
        color: var(--dim);
        font-weight: 700;
      }
      button.demo:hover:not(:disabled) {
        border-color: var(--accent);
        color: var(--accent);
      }
      .transfer {
        margin-top: 12px;
        font-size: 0.92rem;
      }
      .transfer summary {
        cursor: pointer;
        color: var(--muted, inherit);
      }
      .transfer p {
        margin: 8px 0 0;
        color: var(--muted, inherit);
      }
      .transfer .est {
        opacity: 0.85;
      }
      /* Die ruhige Fassung einer Auskunft, die keine Warnung ist:
         dieselbe Flaeche wie die Karte, kein Balken, kein Ausrufezeichen. */
      .cant {
        margin-top: 12px;
        padding: 9px 11px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel-2);
        color: var(--dim);
        font-size: 12.5px;
        line-height: 1.45;
      }
      .cant strong {
        color: var(--ink);
        font-weight: 650;
      }
      button.start {
        min-height: 38px;
        padding: 8px 14px;
        border: 0;
        border-radius: 0;
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

      /* Schmale Karte: alles untereinander, nichts nebeneinander.
         Zwei Modi nebeneinander ergeben auf einem Handy zwei schmale
         Kaestchen, in denen „Instrumente" umbricht und die dritte Karte
         allein in der naechsten Zeile steht — eine Reihe, die halb leer
         ist. Untereinander sind sie gleich breit, gleich hoch und in
         derselben Reihenfolge lesbar wie angeordnet.

         Die Grenze liegt bei 460px und nicht bei den 350px darunter: ein
         Telefon im Hochformat hat 360 bis 430 CSS-Pixel, und genau dort
         trat der Fall auf. Die 350er-Regel bleibt daneben stehen, sie
         macht etwas anderes — sie nimmt Polster weg, wenn es wirklich eng
         wird. */
      @container (max-width: 460px) {
        .modes {
          grid-template-columns: 1fr;
        }
        /* Mittig, weil die Karte jetzt die ganze Breite hat: linksbuendig
           stuende die Schrift an einer Kante, zu der sonst nichts mehr
           ausgerichtet ist. */
        .mode {
          align-items: center;
          text-align: center;
        }
        .go {
          flex-direction: column;
          align-items: stretch;
        }
        button.demo,
        button.start {
          width: 100%;
          /* Die Knoepfe sind inline-flex mit Zeichen und Beschriftung;
             ohne diese Zeile klebte beides am linken Rand eines Knopfes,
             der die ganze Breite einnimmt. */
          justify-content: center;
        }
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
          @if (sites().length > 1) {
            <span class="mode-group">
            <span class="mode-label" id="site-label">{{ t().header.mode }}</span>
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
                <span id="site-pick-value">{{ currentShort() }}</span>
                <app-icon
                  [name]="pickOpen() ? 'chevron-up' : 'chevron-down'"
                  [weight]="2.6"
                />
              </button>
              @if (pickOpen()) {
                <div
                  class="pick-panel"
                  role="radiogroup"
                  [attr.aria-label]="t().header.pickGroup"
                  data-testid="site-panel"
                  (keydown.escape)="closePick()"
                >
                  @for (s of sites(); track s.key) {
                    <label
                      class="pick-opt"
                      [class.on]="site() === s.key"
                      data-testid="site-option"
                      [attr.data-site]="s.key"
                      [title]="t().sites[s.key].hint"
                    >
                      <input
                        type="radio"
                        name="site"
                        [value]="s.key"
                        [checked]="site() === s.key"
                        [disabled]="busy()"
                        (change)="chooseSite(s.key)"
                      />
                      <span class="pick-head">{{ shortFor(s.key) }}</span>
                      <!-- Eine Zeile darunter, mehr nicht: worauf gerechnet
                           wird. Der Rechenweg steht schon in der Kopfzeile,
                           ihn zu wiederholen waere eine Zeile fuer nichts. -->
                      <!-- Das Geraet — und wenn es noch keines gibt, der
                           Stand statt einer leeren Zeile: ein Backend, das
                           nicht laeuft, stuende sonst wortlos da. -->
                      <span class="pick-sum dim">{{
                        facts.summary(s.key).device || facts.summary(s.key).method
                      }}</span>
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
            {{ soleLabel() }}
            <span class="what-wrap">
              <button
                type="button"
                class="what"
                data-testid="device-info"
                [attr.aria-label]="t().header.facts"
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

          <!-- Der Strich trennt zwei Angaben derselben Leiste: links, wo
               getrennt wird, rechts, in welcher Sprache die Oberflaeche
               davon erzaehlt. Er gehoert dem Auge und nicht der
               Vorlesestimme, die liest zwei Gruppen ohne Satzzeichen
               dazwischen. -->
          <span class="sep" aria-hidden="true">|</span>
          <app-lang-switch />
        </span>
      </header>

      <div class="inner">
      <div class="eyebrow">{{ t().card.eyebrow }}</div>
      <h2 class="lede">{{ t().card.lede }}</h2>

      <!-- ------------------------------------------------------- Datei -->
      <label
        class="drop"
        [class.over]="over()"
        (dragenter)="over.set(true)"
        (dragover)="over.set(true)"
        (dragleave)="over.set(false)"
        (drop)="over.set(false)"
      >
        <!-- Auf dem Handy ohne accept, und das ist kein Versehen.
             Chromes Android-Dateidialog (SelectFileDialog.java) sieht
             Audiotypen im accept, will daraufhin den Sprachrecorder als
             Quelle mit anbieten und verlangt dafuer vorher die
             Aufnahmeberechtigung — gefragt wird also nach dem Mikrofon,
             bevor ueberhaupt ein Dateidialog zu sehen ist. Wer hochladen
             will, versteht die Frage nicht, und wer sie versteht, versteht
             sie falsch: eine Seite, die Musik zerlegt, hat nach dem
             Mikrofon nicht zu fragen.

             Die Endungen allein helfen nicht, Chromium rechnet sie in
             MIME-Typen um — aus .mp3 wird audio/mpeg. Es bleibt nur, auf
             dem Handy gar nichts zu nennen.

             Verloren geht dabei die Vorauswahl im Dateidialog, nicht die
             Pruefung: welche Datei angenommen wird, entscheidet ACCEPTED
             in pick(), und das galt ohnehin schon fuer alles, was
             hereingezogen wird. -->
        <input
          #fileInput
          id="audio-file"
          type="file"
          [attr.accept]="isMobile ? null : '.mp3,.wav,audio/mpeg,audio/wav'"
          [disabled]="busy()"
          [attr.aria-label]="t().card.file.pick"
          (change)="pick($event)"
        />
        <span>
          <span class="wave" aria-hidden="true">
            @for (bar of bars; track $index) {
              <i [style.height.px]="bar.h" [style.opacity]="bar.a"></i>
            }
          </span>
          <span class="file-label">
            {{ file()?.name ?? t().card.file.drop }}
          </span>
          <span class="sub">
            {{ file() ? t().card.file.another : t().card.file.orPick }}
          </span>
        </span>
      </label>

      <!-- -------------------------------------------------- Trennmodus -->
      <p class="model-head" id="mode-label">{{ t().card.modes.head }}</p>
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
            {{ i18n.mode(m.mode) }}
            <span>{{ t().card.modes.stems(m.stems.length) }}</span>
          </label>
        }
      </div>

      <!-- Eine leere Modusliste darf nicht stumm bleiben. Sie sah aus wie
           „noch nicht geladen" und blieb es auch: Grund war ein alter
           Eintrag im Browser-Cache, und ohne diese Zeile gab es nichts,
           woran das zu erkennen war. -->
      @if (site() === 'device' && device.modelProblem(); as why) {
        <div class="notice" style="margin-top: 12px" data-testid="no-model">
          <span><strong>{{ t().card.modes.none }}</strong> {{ why }}</span>
        </div>
      }

      <div
        class="outputs"
        aria-live="polite"
        [attr.aria-label]="t().card.modes.outputs"
      >
        @if (selectedModel(); as m) {
          @for (stem of m.stems; track stem; let i = $index) {
            <span class="stem" [style.--sig]="color(stem, i)">{{
              i18n.stem(stem)
            }}</span>
          }
        }
      </div>

      <!-- Hier stand der Hinweis, dass dieses Geraet nicht selbst rechnet.
           Er ist in die FAQ gewandert: in der Karte stand er an der Stelle,
           an der jemand gerade etwas tun will, und erklaerte ihm statt
           dessen die Lage. Was fuer die Entscheidung noetig ist, steht am
           Ortsnamen; alles weitere steht jetzt unter faq.html. -->

      @if (selectedModel(); as m) {
        <!-- Der Browserpfad sagt seinen Download nicht mehr hier: 174 MB
             sind eine Folge des Startens, kein Zustand der Karte. Gefragt
             wird beim Start, siehe ask() weiter unten. Der Backendpfad bleibt stehen,
             weil dort ein Befehl steht, den jemand abtippen koennen muss —
             in einer Sprechblase waere er nicht zu markieren. -->
        @if (m.site === 'backend' && !m.downloaded) {
          <div class="notice" style="margin-top: 12px">
            <span>
              <strong>{{ i18n.mode(m.mode) }}</strong>
              {{ t().card.modes.willDownload(m.name, m.missing_files.length) }}
              <span class="mono">python tools/fetch_model_configs.py {{ m.name }}</span
              >{{ t().card.modes.willDownloadAfter }}
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
            <button type="button" class="demo" (click)="answer(false)">
              {{ t().card.ask.no }}
            </button>
            <button type="button" class="start" (click)="answer(true)">
              {{ t().card.ask.yes }}
            </button>
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
          [title]="t().card.foot.testWhy"
          (click)="startTest()"
        >
          <app-icon name="plus" />{{ t().card.foot.test }}
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
  readonly cloud = inject(CloudSeparator);
  private readonly jobs = inject(JobsService);
  protected readonly i18n = inject(I18n);

  /**
   * Die Texte der gewaehlten Sprache.
   *
   * Im Template als `t()`. Ein Signal-Lesen je Ausdruck, und die Kopfzeile
   * wechselt beim Umschalten mit — siehe `i18n.ts`.
   */
  protected readonly t = this.i18n.t;

  readonly VARIANT = VARIANT;

  /**
   * Auf einem Geraet, das nicht selbst rechnen kann, steht der Serverweg
   * vorn — sobald es ihn gibt.
   *
   * Sonst zeigte ein Handy als Vorgabe auf den Prozessorweg, und ein Tippen
   * auf „Spuren trennen" startete eine Stunde Rechnen, die der Browser
   * wahrscheinlich vorher abbricht. Der Weg, der dort funktioniert, darf
   * dann nicht der sein, den man erst suchen muss.
   *
   * **Hochgeladen wird deshalb nichts von allein.** Ausgewaehlt ist ein
   * Ort, mehr nicht; was der Serverweg bedeutet, steht darunter zum
   * Aufklappen, und losgeschickt wird erst mit dem Knopf. Wer lieber auf
   * dem Prozessor rechnet, stellt oben um — und ab dann bleibt es dabei,
   * auch wenn dieser Effekt erneut laeuft.
   */
  private siteChosen = false;

  constructor() {
    effect(() => {
      if (this.siteChosen || this.busy()) return;
      if (!this.cloudOffered()) return;
      if (this.site() !== 'device') return;
      this.setSite('cloud');
    });

    /**
     * Haelt die Auswahl auf einem Ort, den es hier gibt.
     *
     * Die Liste haengt an der Geraetepruefung und steht deshalb erst eine
     * Sekunde spaeter fest. Faellt der vorausgewaehlte Ort dabei weg — der
     * Geraetepfad auf einem Telefon ohne Grafikfreigabe —, zeigte die
     * Karte sonst auf etwas, das nicht mehr dasteht: kein Eintrag
     * markiert, und der Knopf startete einen Weg, den die Liste nicht
     * mehr anbietet. Auch eine ausdrueckliche Wahl zaehlt hier nicht
     * dagegen, denn gewaehlt werden konnte nur, was es noch gab.
     */
    effect(() => {
      const orte = this.sites();
      if (!orte.length) return;
      if (orte.some((o) => o.key === this.site())) return;
      this.setSite(orte[0].key);
    });
  }

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
  /**
   * Wird der Serverweg hier ueberhaupt angeboten?
   *
   * Nur, wenn dieses Geraet selbst **nicht** rechnen kann. Das Kriterium
   * ist absichtlich die Faehigkeit und nicht die Bauform: es gibt Handys
   * mit nutzbarem WebGPU — die sollen lokal rechnen, statt eine Datei
   * hochzuladen, die hierbleiben koennte — und es gibt Rechner ohne, in
   * einer virtuellen Maschine, mit Software-Renderer oder abgeriegeltem
   * Browser, die sonst nur der stundenlange WASM-Weg bliebe.
   *
   * `support()` ist `null`, solange geprueft wird; dann wird nichts
   * angeboten. Lieber eine Zeile spaeter als eine falsche Zeile frueh.
   */
  readonly cloudOffered = computed(() => {
    if (!this.jobs.cloudAvailable()) return false;
    const support = this.device.support();
    return support !== null && !support.available;
  });

  /**
   * Die Orte, die hier wirklich zur Wahl stehen.
   *
   * Drei Regeln, und jede haelt einen Eintrag heraus, der nichts kann:
   *
   * **CUDA nur mit Backend.** Die oeffentliche Variante hat keines. Der
   * Eintrag stand trotzdem in der Liste, liess sich auswaehlen — und
   * danach war die Modusliste leer, weil `modelsFor('backend')` nichts
   * liefert. Auf dem Handy war er noch deutlicher daneben: darunter stand
   * dauerhaft „wird geprueft", denn gefragt wird ein Dienst, den es dort
   * nicht gibt.
   *
   * **Der Geraetepfad nur, wenn das Geraet rechnen kann** — oder wenn es
   * sonst nichts gibt. Ein Telefon ohne Grafikfreigabe rechnet auf dem
   * Prozessor eine knappe Stunde je Lied und bricht vorher wahrscheinlich
   * ab; als Eintrag neben „Fremdserver" ist das kein Angebot, sondern eine
   * Falle. Bleibt er der einzige Weg, steht er trotzdem da: dann ist er
   * die Wahrheit ueber dieses Geraet und nicht eine Alternative.
   *
   * **Server nur ohne eigene Rechenmoeglichkeit**, siehe `cloudOffered`.
   */
  readonly sites = computed(() => {
    const support = this.device.support();
    // Solange geprueft wird, gilt das Geraet als tauglich: eine Zeile, die
    // fuer eine Sekunde erscheint und dann verschwindet, ist schlimmer als
    // eine, die steht.
    const geraetKann = support === null || support.available;
    const cloud = this.cloudOffered();
    const sonstWas = this.jobs.serverAvailable || cloud;
    return [
      ...this.ALL_SITES.filter(
        (s) =>
          (s.key === 'device' && (geraetKann || !sonstWas)) ||
          (s.key === 'backend' && this.jobs.serverAvailable),
      ),
      ...(cloud ? this.ALL_SITES.filter((s) => s.key === 'cloud') : []),
    ];
  });

  /**
   * Die Orte, in der Reihenfolge, in der sie zur Wahl stehen.
   *
   * Nur noch die Schluessel. Das eine Wort auf dem Knopf und der Satz zum
   * Nachlesen stehen in `t().sites` — sie sind Text, und Text steht in
   * dieser Anwendung an einer Stelle. Die Reihenfolge bleibt hier, denn sie
   * ist keine Uebersetzung: „auf diesem Geraet" steht zuerst, weil es die
   * Vorgabe ist, und der Fremdserver zuletzt, weil er der einzige Weg ist,
   * auf dem die Datei den Rechner verlaesst.
   */
  readonly ALL_SITES: readonly { key: Site }[] = [
    { key: 'device' },
    { key: 'backend' },
    { key: 'cloud' },
  ];

  readonly file = signal<File | null>(null);
  /** Vorgabe: auf dem Gerät. */
  readonly site = signal<Site>('device');
  readonly model = signal('htdemucs');
  readonly busy = signal(false);

  /**
   * Fehler und Hinweis als **Bauanweisung**, nicht als fertiger Satz.
   *
   * Ein fertiger Satz waere in der Sprache geschrieben, die beim Entstehen
   * galt — und stuende danach auf Deutsch in einer englischen Oberflaeche,
   * denn der Umschalter liegt in derselben Karte und ist waehrend einer
   * Fehlermeldung anklickbar. Gespeichert wird deshalb, wie der Satz zu
   * bauen ist; gebaut wird er beim Lesen, mit dem Woerterbuch, das dann
   * gilt. Die Zahlen darin sind zur Zeit des Fehlers festgehalten, der Text
   * drumherum nicht.
   */
  private readonly errorText = signal<((t: Texte) => string) | null>(null);
  private readonly hintText = signal<((t: Texte) => string) | null>(null);

  readonly error = computed(() => this.errorText()?.(this.t()) ?? null);
  /** Kurze Rueckmeldung unter der Fusszeile, etwa zum Dateityp. */
  readonly hint = computed(() => this.hintText()?.(this.t()) ?? null);
  /** Haengt eine Datei gerade ueber der Ablegeflaeche? */
  readonly over = signal(false);

  /** Die Modi des gewählten Orts — und nur die. */
  readonly models = computed(() => this.jobs.modelsFor(this.site()));

  readonly selectedModel = computed(
    () => this.models().find((m) => m.name === this.model()) ?? null,
  );

  /**
   * Handy oder nicht — entscheidet hier nur noch ueber den Dateidialog.
   *
   * Ein Feld, kein Signal: das Geraet wechselt waehrend einer Sitzung nicht.
   */
  protected readonly isMobile = isMobileDevice();

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
    this.errorText.set(null);
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

  /**
   * Der Satz, wenn nur ein Ort uebrig ist.
   *
   * Der Satz der Variante waere hier eine falsche Auskunft, sobald der letzte
   * verbliebene Ort der Serverweg ist: „Alles auf diesem Geraet" stuende
   * dann ueber einer Karte, die die Datei hochlaedt. Auf dem Handy ohne
   * Grafikfreigabe ist das der Regelfall, nicht die Ausnahme.
   *
   * Beim Serverweg steht hier dieselbe Form wie oben mit Wahl —
   * „Modus:" und das eine Wort —, nur ohne Rahmen und ohne Knopf, denn
   * zu bedienen ist hier nichts. Der Satz „Verarbeitung auf unserem
   * Server" sprengte auf dem Handy die Kopfzeile; das Wort aus der Liste
   * sagt dasselbe und steht in einer Zeile. Es kommt aus `ALL_SITES`, damit
   * derselbe Weg nicht zwei Namen traegt.
   *
   * Der Geraetepfad behaelt seinen Satz: „Alles auf diesem Geraet" ist die
   * Zusicherung, um die es dort geht, und die ist keine Modusangabe.
   */
  readonly soleLabel = computed(() => {
    const nur = this.sites()[0]?.key ?? 'device';
    const t = this.t();
    if (nur !== 'device') return t.header.modeIs(t.sites[nur].short);
    return t.variant[VARIANT.labelKey];
  });

  readonly currentSite = computed(
    () => this.ALL_SITES.find((s) => s.key === this.site()) ?? this.ALL_SITES[0],
  );

  /**
   * Das eine Wort auf dem zugeklappten Knopf.
   *
   * Meist der hinterlegte Kurzname — beim Geraetepfad aber das, was dort
   * **wirklich** rechnet. „WebGPU" waere auf einem Geraet ohne
   * Grafikfreigabe schlicht falsch: eine Zeile tiefer stuende in der
   * Liste „Prozessor (WASM)", und zwei Angaben, die sich widersprechen,
   * sind schlechter als eine ungenaue.
   *
   * Solange die Geraetepruefung laeuft, steht der Kurzname da. Das ist die
   * Annahme, nicht die Messung — sie haelt hoechstens eine Sekunde, und
   * ein Platzhalter an dieser Stelle liesse die Kopfzeile springen.
   */
  readonly currentShort = computed(() => this.shortFor(this.site()));

  /**
   * Der Name eines Ortes — am Knopf wie im Eintrag derselbe.
   *
   * Beim Geraetepfad das, was dort **wirklich** rechnet: „WebGPU" waere
   * auf einem Geraet ohne Grafikfreigabe falsch, dort steht „WASM".
   * Solange die Pruefung laeuft, steht der hinterlegte Name da — das ist
   * die Annahme, nicht die Messung, sie haelt hoechstens eine Sekunde,
   * und ein Platzhalter liesse die Kopfzeile springen.
   */
  shortFor(key: Site): string {
    const hinterlegt = this.t().sites[key].short;
    if (key !== 'device') return hinterlegt;
    const support = this.device.support();
    if (!support) return hinterlegt;
    // Rechenwege, keine Worte: in jeder Sprache dasselbe, und deshalb
    // nicht im Woerterbuch.
    return support.available ? 'WebGPU' : 'WASM';
  }

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
    // Von Hand gewaehlt heisst: ab hier redet die Vorauswahl nicht mehr
    // mit. Auch dann nicht, wenn wieder „WASM" dasteht — das ist dann eine
    // Entscheidung und kein Zustand, der sich korrigieren liesse.
    this.siteChosen = true;
    this.setSite(site);
    this.closePick();
  }

  /**
   * Die offene Rueckfrage, oder `null`.
   *
   * Zwei Arten teilen sich denselben Dialog: der Modelldownload und der
   * Speicher. `kind` entscheidet, was ein „Ja" auslöst — ohne das wäre
   * `answer()` nicht zu sagen, welche Frage gerade beantwortet wurde.
   *
   * Hier stehen fertige Sätze und keine Bauanweisung wie bei `errorText`:
   * der Dialog ist modal, der Umschalter liegt hinter seinem Schleier und
   * ist so lange nicht zu erreichen. Eine Frage, die ihre Sprache mitten im
   * Lesen wechselt, kann es also nicht geben.
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
    const foot = this.t().card.foot;
    if (this.busy()) {
      return this.site() === 'device' ? foot.preparing : foot.sending;
    }
    const stems = this.selectedModel()?.stems.length;
    return stems ? foot.startStems(stems) : foot.start;
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
    // Beim Browserpfad kommt eines dazu: die Modusliste steht schon, bevor
    // die Manifeste gelesen sind (siehe `provisionalModels` in
    // device-separator.ts). Bis dahin fehlen dem gewaehlten Modus die
    // Zahlen, an denen Speicherwaechter und Downloadfrage haengen — also
    // wird so lange nicht gestartet. Die Wartezeit faellt nicht auf: eine
    // Datei auszuwaehlen dauert laenger als die drei kleinen Abrufe.
    if (this.site() === 'device') {
      return this.device.modelsVerified() && !this.device.busy();
    }
    return true;
  });

  /**
   * Die Farbe einer Spur.
   *
   * Am Slug und nicht am Anzeigenamen: sonst haenge die Farbe an der
   * Sprache, und „Rest" und „Other" waeren zwei verschiedene Spuren.
   * `stemColor` kaeme zwar auch mit dem Namen zurecht — es kennt die
   * gelaeufigen Woerter —, aber auf einem Umweg, den es hier nicht
   * braucht. Der Name geht trotzdem mit: fuer Spuren ohne festen Platz
   * ist er alles, was es gibt.
   */
  color(stem: string, index: number): string {
    return stemColor(stemSlug(stem) ?? stem.toLowerCase(), index, stem);
  }

  /**
   * `accept` filtert nur den Dateidialog. Hineingezogen werden kann alles,
   * und eine Textdatei ergaebe erst beim Hochladen einen Fehler vom Server
   * — das sagt sich hier schneller.
   */
  pick(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    this.errorText.set(null);
    if (chosen && !ACCEPTED.test(chosen.name)) {
      this.hintText.set((t) => t.card.file.wrongType);
      input.value = '';
      return;
    }
    this.hintText.set(null);
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

    // Zahlen jetzt, Worte spaeter: `mb` und `geraet`/`waehrend` haengen am
    // Woerterbuch und werden deshalb erst beim Bauen des Satzes gerufen.
    // Die Messwerte stehen hier schon fest.
    const gb = deviceMemoryGb().gb;
    const mb = (t: Texte, n: number) => Math.round(n).toLocaleString(t.locale);
    const geraet = (t: Texte) =>
      urteil.measured
        ? t.card.memory.deviceSays(gb)
        : t.card.memory.deviceUnknown;
    // Die Spitze, nicht das Ergebnis: bei „Minimum" stehen am Ende zwei
    // Spuren, während des Laufs sind es vier.
    // Der Anzeigename des Modus, nicht seine Kennung. Ueber den Dienst,
    // damit die Tabelle an einer Stelle nachgeschlagen wird.
    const modus = () => this.i18n.mode(model.mode);
    const waehrend = (t: Texte) => t.card.memory.during(modus(), stems);

    if (urteil.verdict === 'aussichtslos') {
      // Zwei verschiedene Absagen. Liegt die machbare Länge unter einer
      // halben Minute, ist nicht der Song zu lang, sondern das Gerät zu
      // klein — dann wäre „nimm einen kürzeren Ausschnitt" ein Rat, der
      // ins Leere geht.
      this.errorText.set((t) =>
        urteil.fitsSeconds < SHORTEST_WORTH_SUGGESTING_S
          ? t.card.memory.tooSmall(modus(), mb(t, urteil.neededMib), geraet(t))
          : t.card.memory.tooLong(
              asMinutes(seconds),
              waehrend(t),
              mb(t, urteil.neededMib),
              geraet(t),
              asMinutes(urteil.fitsSeconds),
            ),
      );
      return 'halt';
    }

    const t = this.t();
    this.pending.set({
      kind: 'speicher',
      question: t.card.memory.tight(mb(t, urteil.neededMib)),
      why: t.card.memory.tightWhy(
        waehrend(t),
        asMinutes(seconds),
        mb(t, urteil.audioMib),
        geraet(t),
      ),
    });
    this.askDialog().nativeElement.showModal();
    return 'gefragt';
  }

  private ask(model: ModelInfo): void {
    const mb = this.megabytes(model.download_bytes ?? 0);
    const t = this.t();
    this.pending.set({
      kind: 'download',
      question: t.card.ask.download(mb),
      why: t.card.ask.downloadWhy(this.i18n.mode(model.mode), model.name, mb),
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
    this.errorText.set(null);
    this.hintText.set(null);
    try {
      const job =
        this.site() === 'device'
          ? await this.device.start(file, this.model())
          : this.site() === 'cloud'
            ? await this.cloud.start(file)
            : await this.api.upload(file, this.model());
      this.file.set(null);
      // Auch das Eingabefeld leeren. Sonst steht dort weiter ein Dateiname,
      // waehrend "Trennen" deaktiviert ist, und dieselbe Datei nochmal zu
      // waehlen loest kein change-Ereignis aus.
      this.fileInput().nativeElement.value = '';
      this.started.emit(job);
    } catch (err) {
      this.errorText.set(() => describeHttp(err));
    } finally {
      this.busy.set(false);
    }
  }

  async startTest(): Promise<void> {
    this.busy.set(true);
    this.errorText.set(null);
    this.hintText.set(null);
    try {
      // Ohne Backend legt der Browser die Testspuren selbst an — dieselben
      // drei Spuren, aus derselben Vorschrift.
      if (this.api.enabled) await this.api.createTestJob();
      else this.device.createTestJob();
    } catch (err) {
      this.errorText.set(() => describeHttp(err));
    } finally {
      this.busy.set(false);
    }
  }
}
