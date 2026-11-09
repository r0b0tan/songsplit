import { Component, computed, input } from '@angular/core';

import { ICONS, type IconName, type IconShape } from './icons';

/**
 * Ein Zeichen aus Lucide.
 *
 *     <app-icon name="play" />
 *
 * Immer schmueckend, nie tragend: das Zeichen ist `aria-hidden`, die
 * Bedeutung steht am Knopf (`aria-label` oder sichtbarer Text). Ein Knopf,
 * der nur aus einem Zeichen besteht, braucht beides — `aria-label` fuer
 * Vorlesesoftware und `title` fuer die Maus.
 *
 * Groesse und Farbe kommen aus dem Umfeld: `currentColor` und eine
 * Kantenlaenge, die am Host eingestellt wird (Vorgabe 15 px). Damit passt
 * sich jedes Zeichen dem Knopf an, in dem es steht.
 */
@Component({
  selector: 'app-icon',
  standalone: true,
  styles: [
    `
      :host {
        display: inline-flex;
        width: var(--icon-size, 15px);
        height: var(--icon-size, 15px);
        flex: none;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
        /* Lucide zeichnet mit Strichen. Wo ein Zeichen eine Richtung meint
           (die Dreiecke des Transports), wirkt es gefuellt besser — das
           stellt die Umgebung ueber die Variable --icon-fill ein. Zeichen
           aus offenen Linien duerfen das nicht, die faenden sonst eine
           Flaeche. */
        fill: var(--icon-fill, none);
      }
    `,
  ],
  template: `
    <svg
      viewBox="0 0 24 24"
      stroke="currentColor"
      [attr.stroke-width]="weight()"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      @for (shape of shapes(); track $index) {
        @switch (shape[0]) {
          @case ('path') {
            <path [attr.d]="shape[1]['d']" />
          }
          @case ('circle') {
            <circle
              [attr.cx]="shape[1]['cx']"
              [attr.cy]="shape[1]['cy']"
              [attr.r]="shape[1]['r']"
            />
          }
          @case ('rect') {
            <rect
              [attr.x]="shape[1]['x']"
              [attr.y]="shape[1]['y']"
              [attr.width]="shape[1]['width']"
              [attr.height]="shape[1]['height']"
              [attr.rx]="shape[1]['rx']"
            />
          }
        }
      }
    </svg>
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  /**
   * Strichstaerke. Lucide zeichnet auf 24 Einheiten mit Staerke 2; wo ein
   * Zeichen gefuellt wirken soll (Play im Transport), hilft etwas mehr.
   */
  readonly weight = input(2);

  readonly shapes = computed<readonly IconShape[]>(() => ICONS[this.name()]);
}
