import { Component, ElementRef, effect, signal, viewChild } from '@angular/core';

import { IconComponent } from '../core/icon';
import { LEGAL, fehlt, luecken } from '../core/legal';
import { VARIANT } from '../core/variant';

/** Welcher Text liegt offen — oder keiner. */
type Blatt = 'impressum' | 'datenschutz' | null;

/**
 * Die Fussleiste: eine Zeile, zwei Verweise, das Jahr.
 *
 * Sie ist absichtlich schmal. Die Seite ist ein Werkzeug, und was hier
 * steht, braucht niemand beim Arbeiten — es muss nur da sein, wenn jemand
 * danach sucht. Deshalb eine Zeile in gedaempfter Schrift unter der letzten
 * Karte, keine eigene Karte.
 *
 * Die Texte stehen in einem Dialog und nicht auf einer eigenen Seite: die
 * Anwendung hat keinen Router (siehe `main.ts`), und ein Router fuer zwei
 * Rechtstexte waere mehr Geruest als Weg. Ein Dialog hat ausserdem den
 * Vorteil, dass niemand aus seiner Arbeit faellt: der Verlauf, das geladene
 * Deck, alles steht hinterher noch da.
 *
 * Das Jahr kommt aus der Uhr, nicht aus dem Quelltext. Eine Jahreszahl, die
 * jemand von Hand nachziehen muss, steht irgendwann falsch da — und sie
 * steht genau an der Stelle, an der eine falsche Angabe am meisten auffaellt.
 */
@Component({
  selector: 'app-site-footer',
  standalone: true,
  imports: [IconComponent],
  styles: [
    `
      :host {
        display: block;
      }

      .foot {
        display: flex;
        gap: 6px 14px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        /* Keine Karte: nur eine Linie, die den Fuss vom Inhalt abhebt. */
        border-top: 1px solid var(--edge-soft);
        padding-top: 11px;
        color: var(--faint);
        font-size: 11.5px;
      }

      nav {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      /* Ein Knopf, der wie ein Verweis aussieht: er oeffnet einen Dialog,
         fuehrt also nirgendwohin, und darf deshalb kein <a href> sein. */
      button.link {
        background: none;
        border: none;
        padding: 0;
        min-height: 0;
        color: inherit;
        font: inherit;
        text-decoration: underline;
        text-decoration-color: color-mix(in srgb, currentColor 32%, transparent);
        text-underline-offset: 2px;
      }
      button.link:hover {
        color: var(--accent);
        border-color: transparent;
        text-decoration-color: currentColor;
      }
      @media (pointer: coarse) {
        /* Die Mindesthoehe fuer Finger gilt auch hier, aber als Polster um
           die Schrift -- nicht als Kasten, der die Zeile aufblaest. */
        button.link {
          min-height: 32px;
          display: inline-flex;
          align-items: center;
        }
      }

      .sep {
        color: var(--edge);
      }

      /* ----------------------------------------------------------- Dialog */
      /* Dasselbe Prinzip wie Deck und Fortschritt in app.ts: der Dialog
         ist der Rahmen, sichtbar ist die Karte darin. */
      .sheet {
        width: min(680px, calc(100vw - 2 * clamp(8px, 2vw, 26px)));
        max-width: none;
        max-height: calc(100dvh - 2 * clamp(8px, 2vh, 26px));
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        overflow: auto;
        overscroll-behavior: contain;
        border-radius: var(--radius);
        box-shadow: 0 20px 54px -14px light-dark(rgb(24 19 30 / 0.34), rgb(0 0 0 / 0.66));
        scrollbar-width: thin;
        scrollbar-color: var(--edge) transparent;
      }
      .sheet::backdrop {
        background: light-dark(rgb(31 27 36 / 0.42), rgb(6 6 9 / 0.66));
        backdrop-filter: blur(2.5px);
      }

      .card {
        padding: clamp(18px, 2.6vw, 26px) clamp(16px, 2.6vw, 28px)
          clamp(18px, 2.4vw, 24px);
      }
      .card-head {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 14px;
      }
      .card-head h2 {
        font-size: clamp(17px, 2.4cqw, 21px);
        letter-spacing: -0.025em;
      }
      .close {
        --icon-size: 16px;
        flex: none;
      }

      /* Lesetext: etwas groesser als die Oberflaeche und mit Luft zwischen
         den Absaetzen -- hier wird gelesen, nicht bedient. */
      .text {
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-size: 13px;
        line-height: 1.6;
        color: var(--ink);
        overflow-wrap: break-word;
      }
      .text h3 {
        font-size: 12px;
        margin-bottom: -7px;
      }
      .text address {
        font-style: normal;
        white-space: pre-line;
      }
      .text dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 12px;
        margin: 0;
      }
      .text dt {
        color: var(--dim);
      }
      .text dd {
        margin: 0;
      }
      .text ul {
        margin: 0;
        padding-left: 18px;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
    `,
  ],
  template: `
    <footer class="foot">
      <!-- Keine Jahreszahl von Hand: siehe Klassenkommentar. -->
      <small data-testid="foot-year">MixApart {{ jahr }}</small>
      <nav aria-label="Rechtliches">
        <button type="button" class="link" data-testid="foot-impressum" (click)="zeige('impressum')">
          Impressum
        </button>
        <span class="sep" aria-hidden="true">·</span>
        <button
          type="button"
          class="link"
          data-testid="foot-datenschutz"
          (click)="zeige('datenschutz')"
        >
          Datenschutz
        </button>
      </nav>
    </footer>

    <dialog
      #sheet
      class="sheet"
      data-testid="foot-sheet"
      [attr.aria-label]="blatt() === 'datenschutz' ? 'Datenschutz' : 'Impressum'"
      (close)="blatt.set(null)"
      (click)="schliesseAmRand($event, sheet)"
    >
      <div class="panel card">
        <div class="card-head">
          <h2>{{ blatt() === 'datenschutz' ? 'Datenschutz' : 'Impressum' }}</h2>
          <button
            type="button"
            class="icon close"
            aria-label="Schließen"
            title="Schließen"
            (click)="blatt.set(null)"
          >
            <app-icon name="x" />
          </button>
        </div>

        @if (blatt() === 'impressum') {
          <div class="text">
            @if (luecken().length) {
              <div class="notice bad">
                <span>
                  <strong>Dieses Impressum ist unvollständig.</strong>
                  Es fehlen: {{ luecken().join(', ') }}. Die Angaben stehen in
                  <code>src/app/core/legal.ts</code> und müssen vor dem
                  Veröffentlichen ausgefüllt werden (§ 5 DDG).
                </span>
              </div>
            }

            <h3>Angaben gemäß § 5 DDG</h3>
            <address>{{ anschrift() }}</address>

            <dl>
              <dt>E-Mail</dt>
              <dd>{{ wert(L.email) }}</dd>
              @if (!fehlt(L.telefon)) {
                <dt>Telefon</dt>
                <dd>{{ L.telefon }}</dd>
              }
              @if (!fehlt(L.ustId)) {
                <dt>USt-IdNr.</dt>
                <dd>{{ L.ustId }}</dd>
              }
            </dl>

            <h3>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h3>
            <p>{{ wert(L.verantwortlich) }}</p>

            <h3>Haftung für Inhalte und Links</h3>
            <p>
              Die Inhalte dieser Seite werden mit Sorgfalt erstellt, für ihre
              Richtigkeit und Vollständigkeit wird jedoch keine Gewähr
              übernommen. Für die Inhalte verlinkter Seiten ist deren
              jeweiliger Anbieter verantwortlich; zum Zeitpunkt der
              Verlinkung waren dort keine Rechtsverstöße erkennbar.
            </p>
          </div>
        } @else {
          <div class="text">
            <h3>Kurz gesagt</h3>
            <p>
              MixApart trennt Musik im Browser. Die Audiodatei, die hier
              hineingelegt wird, wird nicht hochgeladen: sie bleibt auf
              diesem Gerät, und die Trennung rechnet das Gerät selbst. Es
              gibt kein Konto, keine Anmeldung, keine Auswertung des
              Verhaltens und keine Weitergabe an Dritte.
            </p>

            <h3>Was auf dem Gerät bleibt</h3>
            <ul>
              <li>
                <strong>Audiodaten und Dateinamen</strong> liegen im
                Arbeitsspeicher der Sitzung. Sie werden nicht dauerhaft
                gespeichert; mit dem Schließen des Reiters sind sie weg.
              </li>
              <li>
                <strong>Die Modellgewichte</strong> der Trennung liegen im
                Cache-Speicher des Browsers, damit sie nicht bei jedem Besuch
                neu geladen werden müssen. Sie enthalten keine persönlichen
                Daten und lassen sich über die Browsereinstellungen löschen
                („Websitedaten").
              </li>
            </ul>

            @if (oeffentlich) {
              <h3>Was der Server sieht</h3>
              <p>
                Beim Aufruf der Seite werden die Programmdateien und die
                Modellgewichte von unserem Hoster
                ({{ wert(L.hoster) }}) ausgeliefert. Dabei fallen die üblichen
                Zugriffsdaten an — IP-Adresse, Zeitpunkt, angeforderte Datei,
                übertragene Menge, Browserkennung. Sie dienen allein der
                Auslieferung und der Sicherheit des Betriebs
                (Art. 6 Abs. 1 lit. f DSGVO) und werden nicht mit anderen
                Daten zusammengeführt. Weitere Server werden nicht
                angesprochen: es sind keine fremden Schriften, Skripte,
                Kartendienste oder Analysewerkzeuge eingebunden.
              </p>
            } @else {
              <h3>Was der Server sieht</h3>
              <p>
                Diese Fassung läuft örtlich auf diesem Rechner. Die Trennung
                kann dabei an ein Backend auf demselben Rechner gehen; auch
                dann verlässt die Datei das Gerät nicht.
              </p>
            }

            <h3>Cookies</h3>
            <p>
              Es werden keine Cookies gesetzt und keine Kennungen zur
              Wiedererkennung vergeben.
            </p>

            <h3>Rechte</h3>
            <p>
              Für Auskunft, Berichtigung, Löschung, Einschränkung der
              Verarbeitung, Datenübertragbarkeit und Widerspruch
              (Art. 15–21 DSGVO) sowie für Beschwerden genügt eine Nachricht
              an {{ wert(L.email) }}. Daneben besteht das Recht, sich bei
              einer Datenschutzaufsichtsbehörde zu beschweren.
            </p>

            <h3>Verantwortlich</h3>
            <address>{{ anschrift() }}</address>
          </div>
        }
      </div>
    </dialog>
  `,
})
export class SiteFooterComponent {
  /**
   * Das laufende Jahr. Einmal beim Aufbau gelesen — eine Seite, die ueber
   * Silvester offen bleibt, zeigt dann noch das alte Jahr, und das ist der
   * einzige Fall, in dem das vorkommt.
   */
  readonly jahr = new Date().getFullYear();

  readonly L = LEGAL;
  readonly fehlt = fehlt;
  readonly luecken = luecken;
  readonly oeffentlich = VARIANT.kind === 'öffentlich';

  readonly blatt = signal<Blatt>(null);

  private readonly sheet =
    viewChild.required<ElementRef<HTMLDialogElement>>('sheet');

  constructor() {
    // Der Dialog folgt dem Zustand, nicht umgekehrt: so schliesst ihn der
    // Knopf, Escape und der Rand auf demselben Weg.
    effect(() => {
      const offen = this.blatt() !== null;
      const dialog = this.sheet().nativeElement;
      if (offen && !dialog.open) dialog.showModal();
      if (!offen && dialog.open) dialog.close();
    });
  }

  zeige(blatt: Exclude<Blatt, null>): void {
    this.blatt.set(blatt);
  }

  /** Ein Platzhalter wird nicht als Angabe ausgegeben. */
  wert(value: string): string {
    return fehlt(value) ? '— noch nicht angegeben —' : value;
  }

  anschrift(): string {
    return [this.L.anbieter, this.L.strasse, this.L.ort, this.L.land]
      .map((line) => (fehlt(line) ? '— noch nicht angegeben —' : line))
      .join('\n');
  }

  /**
   * Klick auf den Schleier schliesst. Hier gelesen und nicht gezogen, also
   * genuegt der Klick allein — anders als im Deck, wo ein Zug an einem
   * Regler neben dem Dialog enden kann.
   */
  schliesseAmRand(event: MouseEvent, dialog: HTMLDialogElement): void {
    if (event.target === dialog) this.blatt.set(null);
  }
}
