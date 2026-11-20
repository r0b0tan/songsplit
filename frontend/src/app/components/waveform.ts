import {
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { LoopRange, Peaks } from '../audio/mix-engine';

/**
 * Wellenform einer Spur. Sie ist gleichzeitig die Zeitachse der Spur.
 *
 * Gezeichnet wird nur die Huellkurve, und zwar nur, wenn sie sich aendert,
 * die Breite sich aendert oder das Farbthema wechselt. Abspielkopf, Loop
 * und Mauszeiger liegen als eigene Elemente darueber: die laufende
 * Wiedergabe kostet damit kein Neuzeichnen.
 *
 * Die Farbe kommt aus der aufgeloesten `color`-Eigenschaft des Canvas, nicht
 * aus einem Custom Property. Ein Token wie `--sig` ist fuer Javascript nur
 * Text: `light-dark(#2d7265, #7fc0ae)` ist kein Farbwert, den Canvas
 * annehmen koennte. `getComputedStyle(...).color` liefert dagegen die
 * Farbe, die im gerade geltenden Thema wirklich gilt.
 *
 * Bedienung: klicken springt an die Stelle, ziehen setzt den A/B-Loop,
 * mit der Tastatur sind Pfeiltasten, Bild-auf/ab und Pos1/Ende belegt.
 */
@Component({
  selector: 'app-waveform',
  standalone: true,
  styles: [
    `
      /* Der Host ist Zelle eines Rasters: er soll die Zeilenhoehe mitgehen,
         damit die Bahn die ganze Spur ausfuellt und keine Luecke bleibt. */
      :host {
        display: flex;
        min-width: 0;
      }
      .frame {
        position: relative;
        flex: 1;
        min-width: 0;
        color: var(--sig, var(--accent));
        background: linear-gradient(to bottom, var(--lane), var(--lane-2));
        border-inline: 1px solid var(--edge-soft);
        overflow: hidden;
        isolation: isolate;
        cursor: text;
        touch-action: none;
      }
      /* Die Spur, die man gerade allein hoert, bekommt ihre eigene Farbe
         in die Bahn gelegt: im Deck sieht man dann auf einen Blick, welche
         Zeile gerade den Ton macht. */
      .frame.lit {
        background: linear-gradient(
          115deg,
          color-mix(in srgb, var(--sig, var(--accent)) 13%, var(--lane)),
          var(--lane) 72%
        );
      }
      .frame:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .overlay {
        position: absolute;
        inset-block: 0;
        pointer-events: none;
      }
      /* Loop als eingefaerbter Bereich mit harten Kanten: die Grenzen sind
         die Marken A und B, sie muessen genau ablesbar sein. */
      .loop {
        background: var(--ghost);
        border-inline: 1px solid var(--ring);
        z-index: 1;
      }
      .loop.off {
        background: light-dark(rgb(0 0 0 / 0.04), rgb(255 255 255 / 0.04));
        border-inline-color: var(--edge);
      }
      .drag {
        background: light-dark(rgb(0 0 0 / 0.1), rgb(255 255 255 / 0.1));
        border-inline: 1px dashed var(--dim);
        z-index: 2;
      }
      .hover {
        width: 1px;
        background: var(--dim);
        opacity: 0.55;
        z-index: 2;
      }
      .playhead {
        width: 1px;
        background: var(--accent);
        box-shadow: 0 0 0 0.5px var(--accent);
        z-index: 3;
      }
      .playhead::before {
        content: '';
        position: absolute;
        top: 0;
        left: -2.5px;
        width: 6px;
        height: 3px;
        background: var(--accent);
      }
      .empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        font: 11.5px/1 var(--mono);
        color: var(--faint);
        z-index: 2;
      }
    `,
  ],
  template: `
    <div
      class="frame"
      #frame
      [class.lit]="lit()"
      tabindex="0"
      role="slider"
      [attr.aria-label]="label()"
      aria-valuemin="0"
      [attr.aria-valuemax]="duration().toFixed(2)"
      [attr.aria-valuenow]="position().toFixed(2)"
      [attr.aria-valuetext]="clock(position()) + ' von ' + clock(duration())"
      [style.min-height.px]="minHeight()"
      (pointerdown)="onDown($event)"
      (pointermove)="onMove($event)"
      (pointerup)="onUp($event)"
      (pointercancel)="cancelDrag()"
      (pointerleave)="setHover(null)"
      (keydown)="onKey($event)"
    >
      <canvas #canvas></canvas>

      @if (!peaks()) {
        <div class="empty">{{ emptyLabel() }}</div>
      }

      @if (loop(); as l) {
        <div
          class="overlay loop"
          [class.off]="!loopEnabled()"
          [style.left.%]="pct(l.a)"
          [style.width.%]="pct(l.b) - pct(l.a)"
        ></div>
      }

      @if (dragRange(); as d) {
        <div
          class="overlay drag"
          [style.left.%]="pct(d.a)"
          [style.width.%]="pct(d.b) - pct(d.a)"
        ></div>
      }

      @if (hover(); as h) {
        <div class="overlay hover" [style.left.%]="pct(h)"></div>
      }

      <div class="overlay playhead" [style.left.%]="pct(position())"></div>
    </div>
  `,
})
export class WaveformComponent {
  readonly peaks = input<Peaks | null>(null);
  readonly duration = input(0);
  readonly position = input(0);
  readonly loop = input<LoopRange | null>(null);
  readonly loopEnabled = input(true);
  /**
   * Mindesthoehe der Bahn. Die tatsaechliche Hoehe kann groesser sein, weil
   * der Host sich in die Rasterzeile streckt; gezeichnet wird nach der
   * gemessenen Hoehe, nicht nach diesem Wert.
   */
  readonly minHeight = input(52);
  /** Gedaempft zeichnen, etwa wenn die Spur stumm ist. */
  readonly faded = input(false);
  /** Bahn in der Spurfarbe hinterlegen — fuer die Spur im Solo. */
  readonly lit = input(false);
  readonly emptyLabel = input('wird geladen …');
  /**
   * Die Beschriftung fuer die Vorlesestimme.
   *
   * Ohne Vorgabe: wer eine Wellenform einhaengt, kennt die Spur und die
   * Sprache. Ein deutscher Ruecktext stuende sonst in einer englischen
   * Oberflaeche, und zwar genau dort, wo ihn niemand sieht und nur die
   * Vorlesestimme ihn liest.
   */
  readonly label = input.required<string>();

  readonly seek = output<number>();
  readonly loopChange = output<LoopRange>();
  /**
   * Zeit unter dem Zeiger, oder null, sobald er die Bahn verlaesst.
   *
   * Die Bahn zeigt den Zeiger selbst als Strich; die Zahl dazu gehoert
   * nach oben in die Zeitachse, wo sie nur einmal steht statt in jeder
   * Spur. Deshalb wird sie gemeldet und nicht hier gezeichnet.
   */
  readonly hoverTime = output<number | null>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly frameRef = viewChild.required<ElementRef<HTMLElement>>('frame');

  /** Gemessene Innenmasse der Bahn in CSS-Pixeln, per ResizeObserver. */
  private readonly width = signal(0);
  private readonly boxHeight = signal(0);
  /** Zaehler, der bei Themenwechsel hochgeht und damit neu zeichnen laesst. */
  private readonly theme = signal(0);

  readonly dragRange = signal<LoopRange | null>(null);
  readonly hover = signal<number | null>(null);

  private dragStart: number | null = null;
  private dragMoved = false;

  constructor() {
    effect((onCleanup) => {
      const el = this.frameRef().nativeElement;
      const observer = new ResizeObserver((entries) => {
        this.width.set(Math.round(entries[0].contentRect.width));
        this.boxHeight.set(Math.round(entries[0].contentRect.height));
      });
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });

    // Seit `color-scheme: dark` in styles.css steht, aendert ein Wechsel am
    // Betriebssystem hier nichts mehr: es gilt immer dieselbe Haelfte jedes
    // light-dark()-Paares. Der Horcher bleibt trotzdem stehen — er kostet
    // nichts, zeichnet im schlimmsten Fall dasselbe Bild noch einmal, und
    // kaeme die helle Fassung je zurueck, zoege das Canvas sofort wieder
    // mit. Ohne ihn behielte es beim Wechsel die Farben von vorher.
    effect((onCleanup) => {
      const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
      if (!query) return;
      const bump = () => this.theme.update((n) => n + 1);
      query.addEventListener('change', bump);
      onCleanup(() => query.removeEventListener('change', bump));
    });

    // Neu zeichnen, wenn sich Huellkurve, Breite, Hoehe, Daempfung oder
    // Thema aendern.
    effect(() => {
      const peaks = this.peaks();
      const width = this.width();
      const height = Math.max(this.boxHeight(), this.minHeight());
      const faded = this.faded();
      this.theme();
      this.draw(peaks, width, height, faded);
    });
  }

  pct(seconds: number): number {
    const duration = this.duration();
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (seconds / duration) * 100));
  }

  clock(seconds: number): string {
    const s = isFinite(seconds) && seconds > 0 ? seconds : 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------- zeichnen
  private draw(peaks: Peaks | null, width: number, height: number, faded: boolean): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!peaks || width <= 0) return;

    // Die aufgeloeste Farbe des gerade geltenden Themas, siehe Klassendoku.
    const signal = getComputedStyle(canvas).color || '#a6433a';
    const mid = h / 2;

    ctx.globalAlpha = faded ? 0.3 : 1;
    ctx.fillStyle = signal;

    // Eine Saeule je Geraetepixel. Liegen mehrere Abschnitte auf einer
    // Saeule, werden sie zusammengefasst, damit kein Ausschlag verloren
    // geht: bei einem langen Stueck ist das die Regel, nicht die Ausnahme.
    for (let x = 0; x < w; x++) {
      const from = Math.floor((x * peaks.buckets) / w);
      const to = Math.max(from + 1, Math.floor(((x + 1) * peaks.buckets) / w));
      let lo = 0;
      let hi = 0;
      for (let b = from; b < to && b < peaks.buckets; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      const top = mid - hi * mid;
      const bottom = mid - lo * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }

    // Nulllinie: sie macht auch bei stillen Stellen sichtbar, dass hier
    // eine Spur liegt, und gibt dem Ausschlag einen Bezug.
    ctx.globalAlpha = faded ? 0.18 : 0.38;
    ctx.fillRect(0, Math.round(mid), w, Math.max(1, Math.round(dpr)));
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- bedienung
  private secondsAt(event: PointerEvent): number {
    const rect = this.frameRef().nativeElement.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / Math.max(1, rect.width);
    return Math.min(1, Math.max(0, fraction)) * this.duration();
  }

  onDown(event: PointerEvent): void {
    if (!this.duration()) return;
    this.dragStart = this.secondsAt(event);
    this.dragMoved = false;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    this.frameRef().nativeElement.focus();
  }

  /** Zeiger-Zeit setzen und melden — beides immer zusammen. */
  setHover(seconds: number | null): void {
    if (this.hover() === seconds) return;
    this.hover.set(seconds);
    this.hoverTime.emit(seconds);
  }

  onMove(event: PointerEvent): void {
    const now = this.secondsAt(event);
    if (this.dragStart === null) {
      if (this.duration()) this.setHover(now);
      return;
    }
    this.setHover(now);
    // Erst ab einem spuerbaren Weg als Ziehen werten, sonst ist jeder
    // Klick schon eine winzige Auswahl.
    if (Math.abs(now - this.dragStart) * 1000 < 1) return;
    this.dragMoved = true;
    this.dragRange.set({ a: Math.min(this.dragStart, now), b: Math.max(this.dragStart, now) });
  }

  onUp(event: PointerEvent): void {
    if (this.dragStart === null) return;
    const end = this.secondsAt(event);
    const start = this.dragStart;
    this.dragStart = null;
    this.dragRange.set(null);

    if (this.dragMoved && Math.abs(end - start) >= 0.2) {
      this.loopChange.emit({ a: Math.min(start, end), b: Math.max(start, end) });
    } else {
      this.seek.emit(end);
    }
  }

  cancelDrag(): void {
    this.dragStart = null;
    this.dragRange.set(null);
  }

  /** Tastatur: dieselbe Zeitachse, ohne Maus. */
  onKey(event: KeyboardEvent): void {
    const duration = this.duration();
    if (!duration) return;
    const fine = event.shiftKey ? 0.2 : 1;
    const target = ((): number | null => {
      switch (event.key) {
        case 'ArrowLeft': return this.position() - fine;
        case 'ArrowRight': return this.position() + fine;
        case 'PageDown': return this.position() - 10;
        case 'PageUp': return this.position() + 10;
        case 'Home': return 0;
        case 'End': return duration;
        default: return null;
      }
    })();
    if (target === null) return;
    event.preventDefault();
    this.seek.emit(Math.min(duration, Math.max(0, target)));
  }
}
