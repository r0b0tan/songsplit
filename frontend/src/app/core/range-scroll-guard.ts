import { Directive, ElementRef, inject } from '@angular/core';

/**
 * Haelt Schieberegler davon ab, sich beim Scrollen zu verstellen.
 *
 * Im Deck liegen die Pegelschienen genau dort, wo auf einem Telefon
 * gescrollt wird: rechts neben den Wellenformen, eine pro Spur. Wer mit
 * dem Daumen nach unten wischt, setzt dabei unweigerlich auf einer von
 * ihnen auf — und ein Regler springt in jedem Browser sofort auf die
 * Stelle, an der der Finger aufgesetzt hat. Die Spur ist danach zu laut
 * oder zu leise, und gesehen hat es niemand: die Hand lag auf der Zahl.
 *
 * **`touch-action: pan-y` allein genuegt nicht.** Es sagt dem Browser, dass
 * senkrechte Zuege der Seite gehoeren, und das tut es auch — aber den
 * Sprung macht der Regler schon beim Aufsetzen, bevor ueberhaupt feststeht,
 * wohin der Zug geht. Nachgemessen in Chromium: mit und ohne die Zeile
 * steht der Wert nach einem senkrechten Wisch gleich falsch da.
 *
 * Was verlaesslich kommt, ist `pointercancel`: der Browser schickt es,
 * sobald er den Zug als Scrollen uebernimmt und dem Regler entzieht. Genau
 * das ist der Moment, in dem der Sprung zurueckzunehmen ist — der Zug war
 * nie als Einstellen gemeint.
 *
 * Absichtliches Ziehen bleibt unberuehrt: dort kommt kein
 * `pointercancel`, sondern `pointerup`. Und ein Tipp mitten auf die
 * Schiene stellt weiter ein, wie an jedem Regler mit Maus auch.
 *
 * Gilt nur fuer den Finger. Mit der Maus gibt es kein Scrollen, das einen
 * Zug uebernehmen koennte, und ein gefangener Mauszeiger soll sich nicht
 * selbst zurueckstellen.
 */
@Directive({
  selector: 'input[type=range]',
  standalone: true,
  host: {
    '(pointerdown)': 'merken($event)',
    '(pointercancel)': 'zurueck()',
    '(pointerup)': 'vergessen()',
  },
})
export class RangeScrollGuard {
  private readonly ref = inject<ElementRef<HTMLInputElement>>(ElementRef);

  /** Der Wert vor dem Aufsetzen — oder null, wenn nichts zu huetet ist. */
  private held: string | null = null;

  /**
   * Beim Aufsetzen steht noch der alte Wert im Feld: der Sprung kommt erst
   * danach, als eigenes `input`-Ereignis. Deshalb laesst er sich hier
   * ueberhaupt aufheben.
   */
  merken(event: PointerEvent): void {
    this.held = event.pointerType === 'touch' ? this.ref.nativeElement.value : null;
  }

  /**
   * Der Zug war Scrollen. Wert zurueckschreiben und melden — ohne das
   * `input`-Ereignis hoerte die Oberflaeche weiter den falschen Pegel,
   * denn das Mischpult kennt nur, was gemeldet wurde.
   */
  zurueck(): void {
    const el = this.ref.nativeElement;
    if (this.held !== null && el.value !== this.held) {
      el.value = this.held;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.held = null;
  }

  vergessen(): void {
    this.held = null;
  }
}
