import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { MixEngine } from './audio/mix-engine';
import { DeviceNoticeComponent } from './components/device-notice';
import { ImportPanelComponent } from './components/import-panel';
import { JobListComponent } from './components/job-list';
import { PlayerComponent } from './components/player';
import { RunProgressComponent } from './components/run-progress';
import { ApiService } from './core/api.service';
import { IconComponent } from './core/icon';
import { JobsService } from './core/jobs.service';
import type { Job } from './core/models';
import { DeviceSeparator } from './separate/device-separator';
import { isMobileDevice } from './separate/platform';
import { StemStore } from './separate/stem-store';

/**
 * Die Oberflaeche ist eine schmale Spalte: der Import als Karte, darunter
 * der Verlauf als Liste. Die Breite folgt der Vorlage
 * `exampledata/mixapart-uploadmaske` — eine Spalte, keine Flaeche, die
 * sich ueber den ganzen Schirm zieht.
 *
 * Marke und Geraet stehen in der Kopfleiste der Importkarte, nicht in einer
 * eigenen Karte darueber. Was schiefliegt — keine Verbindung, kein
 * Trennprogramm —, steht als Hinweis darunter, wo es im Weg ist, bis es
 * behoben ist.
 *
 * Der Weg ist eine Linie: Datei hineinziehen, trennen, zusehen, ueben.
 * Nach dem Start liegt das Fortschrittsfenster ueber der Seite, und sobald
 * die Spuren da sind, macht es dem Deck Platz — ohne dass man dazwischen
 * etwas anklicken muesste. Wer nicht warten will, schliesst es; der Job
 * laeuft weiter und steht danach im Verlauf.
 *
 * Das Deck liegt darueber, in einem modalen Dialog. Es ist kein dritter
 * Abschnitt der Seite, sondern ein eigener Arbeitsmodus: wer uebt, hat den
 * ganzen Bildschirm dafuer und nicht die halbe Liste darueber. `<dialog>`
 * und `showModal()` bringen das mit, was ein Modal ausmacht — oberste
 * Ebene, Tastaturfang, Escape, der Rest der Seite stillgelegt.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    DeviceNoticeComponent,
    IconComponent,
    ImportPanelComponent,
    JobListComponent,
    PlayerComponent,
    RunProgressComponent,
  ],
  styles: [
    `
      /* Die Seite ist eine Spalte ueber die volle Hoehe: Inhalt oben,
         Fussband unten. Ohne das haengt das Band bei wenig Inhalt mitten
         auf dem Schirm, und darunter steht die nackte Flaeche. */
      :host {
        display: flex;
        flex-direction: column;
        min-height: 100dvh;

        /* Der Ueberstand der Importkarte ueber die Spalte, als Paar:
           Breite und Gegenrand gehoeren zusammen (115 % breit heisst
           7,5 % nach jeder Seite hinaus). Beides steht hier und nicht in
           der Karte, weil der Fuss dieselbe Linie zieht -- stuenden die
           Zahlen zweimal da, liefen sie irgendwann auseinander.

           Die Prozente rechnen im Massstab des Elements, das sie liest.
           Die Karte traegt zoom: 1.15, ihre Prozente heben sich dagegen
           auf; der Fuss hat keinen Zoom. Beide landen so bei derselben
           Breite in Seitenpixeln. */
        --bleed-width: 100%;
        --bleed-margin: 0;
      }
      /* Erst ab einem Schirm, der den Ueberstand hergibt. Darunter bleiben
         Karte und Fuss in der Spalte, sonst schoeben sie die Seite
         seitlich. */
      @media (min-width: 960px) {
        :host {
          --bleed-width: 115%;
          --bleed-margin: -7.5%;
        }
      }
      /* Und wo mehr Schirm ist, eine Stufe weiter. Mehr traegt der
         Ueberstand nicht, ohne dass die Karte den Fensterrand sucht. */
      @media (min-width: 1040px) {
        :host {
          --bleed-width: 125%;
          --bleed-margin: -12.5%;
        }
      }
      .shell {
        /* Etwas breiter als die Vorlage (780 px): so traegt die
           Verlaufszeile Stueck, Modus, Laenge und Spurzahl nebeneinander,
           ohne dass die Seite zur Flaeche wird. */
        /* Die Breite steht ausdruecklich da: der Wirt ist eine Flex-Spalte,
           und ein Flex-Element mit waagerechtem "margin: auto" wird nicht
           mehr auf die Breite gezogen, sondern schrumpft auf seinen Inhalt
           -- bei Komponenten ohne Eigenbreite also auf nichts. */
        width: 100%;
        max-width: 900px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        /* Der Abstand zwischen den Karten der Seite -- der Verlauf soll
           nicht an der Importkarte kleben. */
        gap: 22px;
        padding-inline: max(14px, env(safe-area-inset-left, 0px))
          max(14px, env(safe-area-inset-right, 0px));
        padding-block: clamp(22px, 5vw, 64px) 72px;
      }

      .notes {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      /* Die Fusszeile der Seite: leise, aber da. */
      /* Kein Band mehr: eigene Flaeche und durchgehender Rand haben den
         Fuss wie einen angeklebten Streifen wirken lassen -- viel Gewicht
         fuer zwei Zeilen Text. Jetzt traegt er denselben Grund wie die
         Seite und schliesst sie nur mit einer Linie ab, die so breit ist
         wie die Karten darueber. Deshalb liegt die Spaltenbreite hier
         aussen und die Linie innen: ein Rand auf dem Element mit dem
         Polster liefe bis unter den Seitenrand und waere breiter als die
         Importkarte. */
      .legal {
        /* Dieselbe Spalte wie .shell -- ausdrueckliche Breite, weil ein
           Flex-Element mit "margin: auto" sonst auf seinen Inhalt
           schrumpft. */
        width: 100%;
        max-width: 900px;
        margin: 0 auto;
        /* Und hier erst wird aus der Vollhoehe oben ein Fuss unten.
           Der Wirt ist laengst eine Spalte ueber 100dvh, aber ohne diese
           Zeile standen Inhalt und Fuss einfach gestapelt am oberen Rand:
           bei wenig Inhalt -- ein frisch geladener Verlauf, ein hohes
           Fenster -- blieben darunter mehrere hundert Pixel nackte
           Flaeche, und der Fuss schwebte mitten auf dem Schirm. Das auto
           nimmt den uebrigen Platz vorweg und schiebt ihn nach unten;
           reicht der Inhalt ueber den Schirm hinaus, ist nichts uebrig
           und die Zeile tut nichts. Beide Faelle, eine Regel. */
        margin-top: auto;
        padding-inline: max(14px, env(safe-area-inset-left, 0px))
          max(14px, env(safe-area-inset-right, 0px));
        font-size: 12.5px;
        color: var(--faint);
      }
      .legal-inner {
        /* So breit wie die Importkarte, nicht wie die Spalte: der Fuss
           schliesst die Seite ab, und ein Abschluss, der schmaler ist als
           das breiteste Element darueber, sieht aus wie eingerueckt. */
        width: var(--bleed-width);
        margin-inline: var(--bleed-margin);
        display: flex;
        gap: 2px 18px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        min-width: 0;
        border-top: 1px solid var(--edge-soft);
        /* Oben die Luft zur Linie, unten der Abstand zum Seitenende. */
        padding-block: 14px 26px;
      }
      .legal-mark {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      /* Dasselbe Zeichen wie in der Kopfleiste, nur kleiner und ohne
         Hintergrund. Das Zeichen ist breiter als hoch (1342:894), also
         bekommt es seine eigene Breite: in ein Quadrat gezwungen wuerde
         es gestaucht. */
      .legal-logo {
        display: block;
        width: 27px;
        height: 18px;
        flex: none;
      }
      .legal-links {
        display: flex;
        gap: 0;
        align-items: center;
        flex: none;
      }
      .legal-dot {
        flex: none;
      }
      /* Ein Verweis ist eine Flaeche, kein Wort: hoch genug, um ihn mit
         Maus und Daumen zu treffen. Das Polster bleibt knapp, damit der
         Punkt dazwischen nicht in der Luft haengt. */
      .legal a {
        display: inline-flex;
        align-items: center;
        min-height: 36px;
        padding-inline: 7px;
        border-radius: var(--radius-sm);
        /* Im Ruhezustand so leise wie der Rest der Zeile. Farbe gibt es
           erst, wenn jemand hinzeigt -- so konkurriert der Fuss nicht mit
           dem Verlauf darueber. */
        color: inherit;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, currentColor 28%, transparent);
        text-underline-offset: 3px;
        transition: color 0.12s;
      }
      .legal a:hover {
        color: var(--accent);
        text-decoration-color: currentColor;
      }
      /* Der Finger braucht mehr als die Maus. */
      @media (pointer: coarse) {
        .legal a {
          min-height: 44px;
          padding-inline: 9px;
        }
      }
      /* Auf schmalen Schirmen zwei Zeilen, mittig: Marke oben, Verweise
         darunter. Nebeneinander passen sie dort nicht mehr — mit drei
         Verweisen brach die Zeile ohnehin, und was dabei herauskam, war
         eine linksbuendige Marke neben einem Rest, der umbrach. Zwei
         Zeilen, die beide gemeint sind, lesen sich besser als eine, die
         zerfaellt. */
      @media (max-width: 560px) {
        .legal-inner {
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          text-align: center;
        }
      }

      /* ------------------------------------------------------------- Deck */
      /* Der Dialog ist nur der Rahmen: sichtbar ist die Deck-Karte darin,
         deshalb ohne eigene Flaeche, ohne Rand, ohne Polster. Gescrollt
         wird im Dialog, nicht auf der Seite dahinter. */
      .deck-modal {
        /* Breit: die Wellenformen sind das Werkzeug, jede Pixelspalte mehr
           ist mehr Zeit, die man im Song auseinanderhaelt. Die Spalten
           links und rechts stehen fest, der Zugewinn geht ganz an die
           Bahnen. */
        width: min(1640px, calc(100vw - 2 * clamp(8px, 2vw, 26px)));
        max-width: none;
        max-height: calc(100dvh - 2 * clamp(8px, 2vh, 26px));
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        overflow: auto;
        overscroll-behavior: contain;
        /* Dieselbe Rundung wie die Karte darin, damit der Schatten nicht
           ueber die Ecken hinaussteht. */
        border-radius: var(--radius);
        box-shadow: 0 20px 54px -14px light-dark(rgb(24 19 30 / 0.34), rgb(0 0 0 / 0.66));
        /* Muss das Deck doch einmal scrollen -- kleines Fenster, viele
           Spuren --, dann wenigstens schmal: der Balken liegt ausserhalb
           der Karte und soll dort nicht auftragen. */
        scrollbar-width: thin;
        scrollbar-color: var(--scroll-thumb) transparent;
      }
      /* Das Fortschrittsfenster ist dasselbe Prinzip, nur schmaler: es
         traegt eine Karte, keine Flaeche. */
      .run-modal {
        width: min(560px, calc(100vw - 2 * clamp(8px, 2vw, 26px)));
        max-width: none;
        max-height: calc(100dvh - 2 * clamp(8px, 2vh, 26px));
        overflow: auto;
        overscroll-behavior: contain;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        border-radius: var(--radius);
        box-shadow: 0 20px 54px -14px light-dark(rgb(24 19 30 / 0.34), rgb(0 0 0 / 0.66));
      }
      .deck-modal::backdrop,
      .run-modal::backdrop {
        background: light-dark(rgb(31 27 36 / 0.42), rgb(6 6 9 / 0.66));
        backdrop-filter: blur(2.5px);
      }
      .deck-modal[open],
      .run-modal[open] {
        animation: deck-in 0.16s cubic-bezier(0.2, 0, 0.2, 1);
      }
      .deck-modal[open]::backdrop,
      .run-modal[open]::backdrop {
        animation: deck-veil 0.16s ease-out;
      }
      @keyframes deck-in {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.995);
        }
      }
      @keyframes deck-veil {
        from {
          opacity: 0;
        }
      }

      /* ------------------------------------------------- Bitte drehen */
      /* Das Deck ist eine Zeitachse ueber die ganze Breite: Spurkopf,
         Wellenform, Regler nebeneinander, und darunter so viele Bahnen wie
         Spuren. Hochkant bleibt davon auf einem Telefon nichts uebrig --
         die Wellenform, das eigentliche Werkzeug, waere schmaler als der
         Pegelregler daneben, und der Rest des Decks laege unterhalb des
         Schirms.

         Deshalb hochkant kein verkleinertes Deck, sondern ein Satz: dreh
         das Geraet. Das ist keine Notloesung, sondern dieselbe Auskunft,
         die ein Mischpult gaebe -- quer ist die Form, in der das Werkzeug
         funktioniert.

         Die Bedingung steht ganz im CSS, nicht in Javascript: matchMedia
         und ein Signal daneben waeren zwei Quellen fuer dieselbe Frage, und
         die laufen beim Drehen auseinander. Nur der Ausweg ("trotzdem")
         ist ein Signal -- den kann CSS nicht wissen.

         Ueber der Karte liegt der Hinweis fest am Fenster, und das
         geht hier auf, weil der Dialog in der obersten Ebene liegt und
         selbst keine Verschiebung traegt: gemessen wird am Fenster, nicht
         an der gescrollten Karte darunter. Haette das Deck den Hinweis
         getragen, waere er an dessen Hoehe geklebt -- sein Wirt traegt
         einen Container-Kontext, und der macht ihn zum Bezug fuer alles
         Festgestellte darin. */
      .turn {
        display: none;
      }
      @media (orientation: portrait) and (pointer: coarse) and (max-width: 860px) {
        .turn {
          position: fixed;
          inset: 0;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 13px;
          /* Deckend, nicht durchscheinend: das halbe Deck dahinter waere
             genau das Bild, das der Hinweis gerade abloest. */
          background: var(--bg);
          padding: 30px max(22px, env(safe-area-inset-left, 0px))
            max(30px, env(safe-area-inset-bottom, 0px))
            max(22px, env(safe-area-inset-right, 0px));
          text-align: center;
        }
      }
      /* Das Zeichen: ein Telefon, das sich in den Bogen eines Pfeils legt.
         Der Bogen allein hiesse nur "drehen", das Telefon allein nur
         "Telefon" -- zusammen sagen sie, was zu tun ist. Die Bewegung
         macht aus der Aufforderung eine Vorfuehrung. */
      .turn-sign {
        position: relative;
        display: grid;
        place-items: center;
        width: 96px;
        height: 96px;
        margin-bottom: 2px;
      }
      .turn-ring {
        --icon-size: 96px;
        color: var(--accent);
        opacity: 0.32;
      }
      .turn-phone {
        position: absolute;
        --icon-size: 42px;
        color: var(--accent);
        animation: kippen 3.2s cubic-bezier(0.5, 0, 0.3, 1) infinite;
      }
      /* Aufrecht stehen, kippen, quer liegen bleiben, zurueck: die Pausen
         an beiden Enden sind laenger als die Drehung dazwischen, sonst
         wirbelt das Zeichen, statt etwas zu zeigen. */
      @keyframes kippen {
        0%,
        26% {
          transform: rotate(0deg);
        }
        46%,
        82% {
          transform: rotate(-90deg);
        }
      }
      /* Wer keine Bewegung will, bekommt das Ergebnis statt des Wegs: das
         Telefon liegt quer. Die allgemeine Regel in styles.css kuerzt jede
         Dauer auf nichts -- stehen bliebe damit der letzte Schritt, also
         wieder aufrecht, und das Zeichen sagte das Gegenteil. */
      @media (prefers-reduced-motion: reduce) {
        .turn-phone {
          animation: none !important;
          transform: rotate(-90deg);
        }
      }
      .turn h2 {
        font-size: 17px;
      }
      /* Ein Satz, der den Grund nennt -- leiser als die Aufforderung
         darueber, denn gehandelt wird nach der ersten Zeile. */
      .turn p {
        max-width: 34ch;
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--dim);
      }
      /* Die Flaeche ist bedienbar, sieht aber nicht danach aus: kein Ring
         beim Tippen, nur beim Weg ueber die Tastatur. */
      .turn:focus {
        outline: none;
      }
    `,
  ],
  template: `
    <main class="shell">
      <!-- Auf dem Handy tritt der Fortschritt an die Stelle der
           Importkarte, statt als Fenster darueber zu liegen. Ein Modal
           laesst sich wegtippen — und auf einem Telefon passiert das
           versehentlich, waehrend das Lied noch laeuft. Danach stand im
           Verlauf „In Verarbeitung" und sonst nichts: kein Prozentsatz,
           keine Restzeit, kein Weg zurueck in die Anzeige.

           Zwei Karten nebeneinander waeren die schlechtere Loesung: auf
           einer Handybreite ist Platz fuer eine, und solange getrennt
           wird, gibt es ohnehin nichts zu importieren. Am Rechner bleibt
           es beim Fenster — dort stoert es nicht, und der Verlauf liegt
           sichtbar daneben. -->
      @if (inlineRun(); as laufend) {
        <app-run-progress
          [job]="laufend"
          [dismissible]="false"
          (close)="stopWatching()"
          (cancel)="cancelJob(laufend)"
        />
      } @else {
        <app-import-panel (started)="watch($event)" />
      }

      @if (api.connectionError() || notes().length || separatorProblem()) {
        <div class="notes">
          @if (api.connectionError(); as e) {
            <div class="notice bad"><span>{{ e }}</span></div>
          }
          @if (separatorProblem(); as detail) {
            <div class="notice bad">
              <span>
                <strong>audio-separator ist nicht verfügbar:</strong> {{ detail }}.
                Echte Trennungen sind daher nicht möglich. Der Testpfad
                funktioniert weiterhin.
              </span>
            </div>
          }
          @for (note of notes(); track note) {
            <div class="notice info"><span>{{ note }}</span></div>
          }
        </div>
      }

      <!-- Der Verlauf erscheint erst, wenn er etwas zu zeigen hat. Eine
           Liste, die nur mitteilt, dass sie leer ist, kostet beim ersten
           Besuch Platz und Aufmerksamkeit und sagt nichts, was die
           Importkarte darueber nicht schon klarmacht.

           Die Bedingung steht hier und nicht in der Liste selbst: der
           Wirt ist eine Flex-Spalte mit Abstand zwischen den Kindern, und
           ein leeres, aber vorhandenes Element nimmt diesen Abstand
           trotzdem mit -- es bliebe eine Luecke ueber dem Fuss. -->
      @if (jobs.jobs().length) {
        <app-job-list
          [selectedId]="selected()?.id ?? null"
          (open)="openJob($event)"
          (closed)="closeJob()"
        />
      }

    </main>

    <!-- Impressum und Datenschutz muessen von jeder Seite aus mit einem
         Klick erreichbar sein. Beide liegen als eigene Seiten neben der
         Anwendung (public/), nicht als Ansicht darin: so stehen sie auch
         dann, wenn vom Bau nichts laedt. Deshalb echte Verweise und kein
         Routing.

         Das Band steht ausserhalb der Spalte: es laeuft ueber die ganze
         Breite, sein Text bleibt in derselben Spalte wie die Karten
         darueber. -->
    <footer class="legal">
      <div class="legal-inner">
        <span class="legal-mark">
          <img
            class="legal-logo"
            src="/icon_no_bg.svg"
            alt=""
            aria-hidden="true"
            width="27"
            height="18"
          />
          <!-- Keine Jahreszahl von Hand: eine, die jemand nachziehen muss,
               steht irgendwann falsch da. Das Copyright-Zeichen steht
               nicht dabei — es behauptet eine Rechtslage, die diese Seite
               nicht geltend macht, und der Fuss ist der falsche Ort fuer
               eine Behauptung. -->
          <span>MixApart {{ jahr }}</span>
        </span>
        <span class="legal-links">
          <a href="/faq.html">FAQ</a>
          <span class="legal-dot" aria-hidden="true">&middot;</span>
          <a href="/impressum.html">Impressum</a>
          <!-- Der Punkt trennt fuers Auge, nicht fuer die Vorlesestimme:
               sie liest zwei Verweise, kein Satzzeichen dazwischen. -->
          <span class="legal-dot" aria-hidden="true">&middot;</span>
          <a href="/datenschutz.html">Datenschutz</a>
        </span>
      </div>
    </footer>

    <!-- ------------------------------------------------ Trennung laeuft -->
    <dialog
      #runDialog
      class="run-modal"
      aria-label="Trennung läuft"
      (close)="stopWatching()"
      (pointerdown)="markBackdrop($event, runDialog)"
      (click)="closeOnBackdrop($event, runDialog)"
    >
      @if (modalRun(); as job) {
        <app-run-progress
          [job]="job"
          (close)="stopWatching()"
          (cancel)="cancelJob(job)"
        />
      }
    </dialog>

    <!-- ------------------------------------------------------------- Deck -->
    <dialog
      #deckDialog
      class="deck-modal"
      [attr.aria-label]="selected() ? 'Deck: ' + selected()!.source_name : 'Deck'"
      (close)="closeJob()"
      (pointerdown)="markBackdrop($event, deckDialog)"
      (click)="closeOnBackdrop($event, deckDialog)"
    >
      <!-- Das Deck wird nachgeladen, nicht mitgeliefert. Player,
           Wellenform, Zeitlineal, Mischpult und Signalsmith sind zusammen
           der groesste Posten des Hauptbuendels — und beim ersten Aufruf
           der Seite braucht sie niemand: gesehen wird die Importkarte, und
           ob ueberhaupt je ein Job geoeffnet wird, entscheidet sich
           spaeter. Lighthouse hat 43 KiB ungenutztes JavaScript gezaehlt;
           das ist im Wesentlichen das hier.

           „prefetch on idle" nimmt dem Tausch die Kehrseite: sobald der
           Hauptstrang nichts mehr zu tun hat, liegt das Stueck bereit.
           Wer also irgendwann einen Job oeffnet, wartet nicht darauf — es
           ist nur nicht mehr im Weg, solange er es nicht tut. -->
      @defer (when selected(); prefetch on idle) {
        @if (selected(); as job) {
          <app-player [job]="job" (close)="closeJob()" />
        }
      }

      <!-- Hochkant auf einem Telefon: statt eines Decks, von dem man ein
           Viertel sieht, ein Satz und ein Zeichen. Sichtbar wird das
           allein ueber die Abfrage im CSS — hier steht nur, was gesagt
           wird, und dass es sich wegtippen laesst. -->
      @if (selected() && !hochkantEgal()) {
        <!-- Ein Zeichen, ein Satz, sonst nichts: wer das Telefon in der
             Hand hat, braucht keine Begruendung, sondern eine Richtung.

             Die ganze Flaeche ist der Ausweg — ein Tipp irgendwohin zeigt
             das Deck doch hochkant. Sichtbar steht das nirgends, weil es
             nur den einen Fall betrifft: Drehsperre an, Geraet liegt fest.
             Ein Knopf dafuer stuende sonst in jedem anderen Fall im Bild
             und laedt ein, die bessere Ansicht zu uebergehen. -->
        <div
          class="turn"
          role="button"
          tabindex="0"
          aria-label="Bitte das Gerät drehen — antippen, um das Deck trotzdem hochkant zu zeigen"
          (click)="hochkantEgal.set(true)"
          (keydown.enter)="hochkantEgal.set(true)"
          (keydown.space)="hochkantEgal.set(true)"
        >
          <span class="turn-sign" aria-hidden="true">
            <app-icon class="turn-ring" name="rotate-cw" />
            <app-icon class="turn-phone" name="smartphone" />
          </span>
          <h2>Bitte Gerät drehen</h2>
          <p>
            Um alle Spuren an einer gemeinsamen Zeitachse zu zeigen,
            braucht der Player die Breite des Querformats.
          </p>
        </div>
      }
    </dialog>

    <!-- ------------------------------------------- Geraet kann es nicht -->
    <!-- Steht zuletzt im Baum und trotzdem ueber allem: ein Dialog in der
         Top-Layer kennt keine Reihenfolge im Dokument. Er meldet sich von
         selbst, sobald die Geraetepruefung durch ist. -->
    <app-device-notice />
  `,
})
export class AppComponent {
  readonly api = inject(ApiService);
  private readonly engine = inject(MixEngine);
  protected readonly jobs = inject(JobsService);
  private readonly store = inject(StemStore);
  private readonly device = inject(DeviceSeparator);

  readonly selected = signal<Job | null>(null);

  /**
   * Hochkant trotzdem: der Ausweg aus dem Drehhinweis.
   *
   * Pro geoeffnetem Deck, nicht pro Sitzung — wer ihn einmal gebraucht
   * hat, hatte dafuer einen Grund in diesem Moment (Drehsperre, Geraet
   * liegt fest), und beim naechsten Deck gilt wieder, was besser ist.
   */
  protected readonly hochkantEgal = signal(false);

  /**
   * Das laufende Jahr fuer das Fussband. Einmal beim Aufbau gelesen -- eine
   * Seite, die ueber Silvester offen bleibt, zeigt dann noch das alte Jahr,
   * und das ist der einzige Fall, in dem das vorkommt.
   */
  readonly jahr = new Date().getFullYear();

  /** Ein Feld, kein Signal: die Bauform wechselt waehrend einer Sitzung nicht. */
  protected readonly isMobile = isMobileDevice();

  /**
   * Der laufende Job, wenn er in die Seite gehoert statt in ein Fenster.
   *
   * `null` am Rechner — dort bleibt es beim Modal, und die Importkarte
   * steht weiter da.
   */
  readonly inlineRun = computed(() => (this.isMobile ? this.watched() : null));

  /**
   * Derselbe Job fuer das Fenster — und `null`, wo es eingebettet steht.
   *
   * Ohne diese zweite Frage stand die Anzeige zweimal in der Seite: der
   * Dialog ist auf dem Handy zwar zu, sein Inhalt wird aber trotzdem
   * gebaut. Sichtbar war davon nichts, zu holen auch nichts — aber es
   * liefen zwei Bauteile auf demselben Job, und eine Vorlesesoftware
   * findet in einem geschlossenen Dialog Text, den es fuer sie nicht
   * geben sollte.
   */
  readonly modalRun = computed(() => (this.isMobile ? null : this.watched()));

  private readonly deckDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('deckDialog');
  private readonly runDialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('runDialog');

  /** Job, dem gerade zugesehen wird — oder null. */
  private readonly watchedId = signal<string | null>(null);

  /**
   * Der beobachtete Job, frisch aus der Liste: die Abfrage laeuft ohnehin
   * im Sekundentakt, und so traegt das Fenster immer den aktuellen Stand.
   */
  readonly watched = computed(
    () => this.jobs.jobs().find((j) => j.id === this.watchedId()) ?? null,
  );

  /** Lag der Druckpunkt auf dem Schleier und nicht im Deck? */
  private downOnBackdrop = false;

  constructor() {
    // Nicht `void`: ein Fehler beim Abfragen von Gerät und Backend blieb
    // sonst unsichtbar — die Oberflaeche stand da wie halb geladen. Der
    // Grund gehoert in die Konsole, und die Teile, die dafuer eine eigene
    // Anzeige haben (Modi, Grafikadapter), zeigen ihn ohnehin selbst.
    this.jobs.init().catch((error: unknown) => {
      console.error('Start unvollständig:', error);
    });

    // Zuerst das Fortschrittsfenster, danach das Deck: so wird in der
    // gleichen Runde erst geschlossen und dann geoeffnet, und nicht
    // umgekehrt.
    effect(() => {
      // Eingebettet gibt es kein Fenster, das aufgehen koennte — sonst
      // laege der Fortschritt zweimal auf der Seite.
      const open = !!this.watched() && !this.isMobile;
      const dialog = this.runDialog().nativeElement;
      if (open && !dialog.open) dialog.showModal();
      if (!open && dialog.open) dialog.close();
    });

    // Fertig heisst: weiter ins Deck. Das ist der Grund, warum das Fenster
    // ueberhaupt aufgeht — es haelt die Stelle, bis es etwas zu hoeren gibt.
    effect(() => {
      const job = this.watched();
      if (job?.status !== 'done') return;
      untracked(() => {
        this.watchedId.set(null);
        this.openJob(job);
      });
    });

    // Der Dialog folgt der Auswahl, nicht umgekehrt: so schliesst ihn auch
    // das Loeschen des offenen Jobs, nicht nur der Knopf im Deck.
    effect(() => {
      const open = !!this.selected();
      const dialog = this.deckDialog().nativeElement;
      if (open && !dialog.open) dialog.showModal();
      if (!open && dialog.open) dialog.close();
    });

    // Sonst scrollt die Liste hinter dem offenen Fenster mit, sobald man
    // darin am Ende angekommen ist.
    effect(() => {
      // Die eingebettete Anzeige ist kein Modal: dahinter liegt nichts,
      // was nicht scrollen duerfte — der Verlauf steht darunter und soll
      // erreichbar bleiben.
      const open = !!this.selected() || (!!this.watched() && !this.isMobile);
      document.documentElement.classList.toggle('modal-open', open);
    });
  }

  /** Einem gerade angelegten Job zusehen. */
  watch(job: Job): void {
    this.watchedId.set(job.id);
  }

  stopWatching(): void {
    this.watchedId.set(null);
  }

  /**
   * Bricht einen laufenden Trennjob auf dem Geraet ab.
   *
   * Der Worker sieht zwischen zwei Bloecken nach; ein spaeter eintreffendes
   * Ergebnis wird verworfen, nicht eingetragen. Das Fenster geht hier gleich
   * zu, denn der Job verschwindet mit dem Abbruch aus dem Verlauf.
   */
  cancelJob(job: Job): void {
    if (job.site !== 'device') return;
    this.device.cancel(job.id);
    this.watchedId.set(null);
  }

  readonly notes = computed(() => this.api.health()?.device.notes ?? []);

  /** Grund, warum keine echte Trennung laufen kann — oder null. */
  readonly separatorProblem = computed(() => {
    const health = this.api.health();
    if (!health || health.separator_available) return null;
    return health.separator_detail ?? 'kein Grund gemeldet';
  });

  /**
   * Oeffnet einen Job im Deck.
   *
   * Zwei Wege, ein Deck: ein Job vom Backend bringt Adressen mit, die der
   * Player holt und dekodiert; alle anderen bringen die Abtastwerte selbst
   * mit und brauchen dafuer kein Netz. Welcher Weg es ist, entscheidet sich
   * hier — ab der `load`-Schnittstelle ist es dasselbe Deck.
   *
   * **Gefragt wird nach dem Backend, nicht nach dem Geraet**, und das ist
   * der Unterschied, an dem der Serverweg zuerst gescheitert ist. Hier
   * stand `job.site === 'device'`; ein Cloudjob fiel damit in den
   * Backendzweig und wurde ueber `s.url` geladen. Die ist bei ihm aber
   * absichtlich leer — die Spuren liegen laengst dekodiert im `StemStore`
   * —, und ein `fetch('')` holt die Seite selbst, an der sich dann
   * `decodeAudioData` verschluckt. Im Deck kam keine einzige Spur an.
   *
   * Dieselbe Frage stellt `JobsService.openable`, und dort stand sie von
   * Anfang an richtig herum: alles ausser `backend` muss im Store liegen.
   * Zwei Stellen, die dasselbe entscheiden, muessen es gleich entscheiden.
   */
  openJob(job: Job): void {
    if (job.site !== 'backend') {
      const held = this.store.get(job.id);
      if (!held) {
        // Das Ergebnis ist aus dem Speicher verdraengt worden. Der Verlauf
        // sagt das an der Zeile; hier bleibt nur, das Deck nicht zu oeffnen.
        return;
      }
      this.selected.set(job);
      void this.engine.load(
        held.stems.map((stem) => ({
          slug: stem.source,
          name: job.stems.find((s) => s.slug === stem.source)?.name ?? stem.source,
          url: '',
          downloadUrl: '',
          channels: stem.channels,
          sampleRate: held.sampleRate,
        })),
      );
      return;
    }
    this.selected.set(job);
    void this.engine.load(
      job.stems.map((s) => ({
        slug: s.slug,
        name: s.name,
        url: s.url,
        downloadUrl: s.download_url,
      })),
    );
  }

  closeJob(): void {
    if (!this.selected()) return;
    this.selected.set(null);
    this.hochkantEgal.set(false);
    this.engine.teardown();
  }

  /**
   * Klick auf den Schleier schliesst das Deck — aber nur, wenn er dort auch
   * begonnen hat. Im Deck wird an Reglern und Loop-Marken gezogen, und so
   * ein Zug endet leicht neben dem Dialog; er darf ihn nicht schliessen.
   */
  markBackdrop(event: PointerEvent, dialog: HTMLDialogElement): void {
    this.downOnBackdrop = event.target === dialog;
  }

  closeOnBackdrop(event: MouseEvent, dialog: HTMLDialogElement): void {
    if (this.downOnBackdrop && event.target === dialog) {
      if (dialog === this.deckDialog().nativeElement) this.closeJob();
      else this.stopWatching();
    }
    this.downOnBackdrop = false;
  }
}
