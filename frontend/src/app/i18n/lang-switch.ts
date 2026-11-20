/**
 * Der Sprachumschalter: EN / DE.
 *
 * Er steht in der Kopfleiste der Importkarte, hinter dem Trennort und einem
 * senkrechten Strich — also dort, wo schon die anderen Angaben ueber diese
 * Sitzung stehen. Eine eigene Zeile bekaeme er nicht gefuellt, und eine
 * eigene Karte waere ein Kasten fuer zwei Knoepfe.
 *
 * **Zwei Knoepfe, kein Auswahlfeld.** Bei zwei Moeglichkeiten ist ein
 * Dropdown ein Klick mehr fuer dieselbe Entscheidung. `aria-pressed` sagt,
 * welche gilt; die Gruppe traegt den Namen, damit eine Vorlesestimme nicht
 * zwei Kuerzel ohne Zusammenhang liest.
 *
 * Die Kuerzel selbst stehen hier im Code und in keinem Woerterbuch: „EN"
 * und „DE" sind die Sprachcodes nach ISO 639-1 und lauten in jeder Sprache
 * gleich. Was uebersetzt wird, ist das, was die Vorlesestimme daraus macht.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { I18n, type Lang } from './i18n';

@Component({
  selector: 'app-lang-switch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="langs" role="group" [attr.aria-label]="t().lang.group">
      @for (l of LANGS; track l; let last = $last) {
        <button
          type="button"
          [class.on]="i18n.lang() === l"
          [attr.aria-pressed]="i18n.lang() === l"
          [attr.aria-label]="t().lang[l]"
          [attr.data-lang]="l"
          data-testid="lang-option"
          (click)="i18n.lang.set(l)"
        >
          {{ l.toUpperCase() }}
        </button>
        @if (!last) {
          <span class="slash" aria-hidden="true">/</span>
        }
      }
    </span>
  `,
  styles: [
    `
      .langs {
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }
      /* Dieselbe Schrift und dieselbe Groesse wie der Text daneben: der
         Umschalter ist eine Angabe der Kopfleiste und kein Werkzeug, das
         sich hervortun muesste. Deshalb auch keine Flaeche und kein
         Rahmen — die stehen in dieser Leiste nur um das, was aufklappt. */
      button {
        min-height: 0;
        padding: 1px 2px;
        border: 0;
        background: none;
        color: inherit;
        font: inherit;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition: color 0.12s;
      }
      button:hover {
        color: var(--accent);
      }
      /* Die gewaehlte Sprache traegt die Akzentfarbe, nicht nur mehr
         Fettung: fett allein ist bei 11 Pixeln kaum ein Unterschied, und
         ein unterlegter Kasten waere der dritte Kasten in der Leiste. */
      button.on {
        color: var(--accent);
        font-weight: 600;
        cursor: default;
      }
      button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      .slash {
        opacity: 0.5;
      }
      /* Mit dem Finger bedient braucht der Knopf eine Flaeche, die man
         trifft. Gewachsen wird nach aussen, damit die Leiste ihre Hoehe
         behaelt: 11 Pixel Schrift und 44 Pixel Zeile waeren sonst eine
         Stufe in der Kopfleiste. */
      @media (pointer: coarse) {
        button {
          padding: 9px 5px;
          margin-block: -9px;
        }
      }
    `,
  ],
})
export class LangSwitchComponent {
  protected readonly i18n = inject(I18n);
  protected readonly t = this.i18n.t;

  /**
   * Die Reihenfolge am Schirm: Englisch zuerst, weil es die Vorgabe ist.
   * Eine Liste und keine zwei festen Knoepfe — eine dritte Sprache soll
   * hier nichts kosten als einen Eintrag.
   */
  protected readonly LANGS: readonly Lang[] = ['en', 'de'];
}
