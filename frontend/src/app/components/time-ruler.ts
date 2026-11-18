import {
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { LOOP_MIN_SECONDS, type LoopRange } from '../audio/mix-engine';

/**
 * Die gemeinsame Zeitachse ueber allen Spuren: Zeitmarken, Abspielkopf und
 * die Loop-Schiene mit den Marken A und B.
 *
 * Die Schiene ist der Ort, an dem der Loop seine Form bekommt. Vorher war
 * er nur eine Zahl in der Fusszeile und eine Flaeche in jeder Wellenform —
 * verschieben liess er sich nur, indem man ihn neu zog. Hier liegen A und B
 * an derselben Stelle wie der Bereich darunter und lassen sich einzeln
 * anfassen, mit Maus, Finger oder Tastatur.
 *
 * Beim Ziehen laeuft die Marke dem Zeiger ohne Verzoegerung nach (`pending`),
 * nach aussen gemeldet wird hoechstens alle `EMIT_MS` — jede Meldung plant
 * die Wiedergabe aller Spuren neu, und das sechzigmal je Sekunde zu tun
 * waere hoerbar. Beim Loslassen wird der Endstand noch einmal gemeldet.
 */
const EMIT_MS = 100;
/** Abstand in Pixeln, unter dem sich die beiden Marken ins Gehege kommen. */
const CROWDED_PX = 34;

type Endpoint = 'a' | 'b';

@Component({
  selector: 'app-time-ruler',
  standalone: true,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
        border-inline: 1px solid var(--edge-soft);
      }
      .ruler {
        position: relative;
        min-height: 54px;
      }
      .ticks {
        display: flex;
        justify-content: space-between;
        gap: 4px;
        padding: 7px 0 0;
        font: 10.5px/1.4 var(--mono);
        font-variant-numeric: tabular-nums;
        color: var(--faint);
      }
      /* Zeiger-Zeit: ein Feld, das mit dem Zeiger ueber der Achse wandert
         und auf die Millisekunde genau sagt, worauf er zeigt. Es liegt
         ueber den Zeitmarken und verdeckt sie kurz — die stehen die
         ganze Zeit da, die Zahl unter dem Zeiger nur jetzt. */
      .scrub {
        position: absolute;
        top: 0;
        left: clamp(62px, var(--pos), calc(100% - 62px));
        transform: translateX(-50%);
        z-index: 4;
        padding: 2px 6px;
        border: 1px solid var(--edge);
        border-radius: 4px;
        background: var(--panel);
        color: var(--ink);
        font: 10.5px/1.4 var(--mono);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        pointer-events: none;
      }
      .scrub b {
        font-weight: 400;
        color: var(--dim);
      }
      /* Der Strich verbindet die Zahl mit der Stelle, auf die sie sich
         bezieht: das Feld selbst steht an den Raendern verschoben. */
      .scrub-line {
        position: absolute;
        inset-block: 0;
        width: 1px;
        background: var(--dim);
        opacity: 0.55;
        pointer-events: none;
      }

      /* Derselbe Strich wie in jeder Wellenform, nur hier oben. */
      .playhead {
        position: absolute;
        inset-block: 0;
        width: 1px;
        background: var(--accent);
        opacity: 0.6;
      }

      /* Die Schiene beginnt unter den Zeitmarken, damit die Marken A und B
         keine Zahl verdecken. */
      .rail {
        position: absolute;
        inset: 26px 0 0;
      }
      .strip {
        position: absolute;
        bottom: 0;
        height: 3px;
        border-radius: 2px;
        background: var(--ring);
        overflow: hidden;
      }
      /* Fuellung = wie weit der Durchlauf im Loop gerade ist. */
      .strip i {
        display: block;
        height: 100%;
        background: var(--accent);
      }
      .rail.off .strip {
        background: var(--edge);
      }
      .rail.off .strip i {
        background: var(--dim);
      }

      .marker {
        position: absolute;
        left: clamp(11px, var(--pos), calc(100% - 11px));
        bottom: 4px;
        transform: translateX(-50%);
        z-index: 2;
        width: 21px;
        min-height: 22px;
        padding: 0;
        border-radius: 5px;
        background: var(--key);
        border: 1px solid var(--key);
        color: var(--on-key);
        font: 700 11px/1 var(--mono);
        cursor: ew-resize;
        touch-action: none;
      }
      .marker:hover:not(:disabled) {
        border-color: var(--key);
        filter: brightness(1.06);
      }
      .rail.off .marker {
        background: var(--panel-2);
        border-color: var(--edge);
        color: var(--dim);
      }
      /* Liegen A und B dicht beieinander, steigt B eine Etage hoch: sonst
         liegt die eine Marke auf der anderen und nur eine ist greifbar. */
      .rail.crowded .marker.b {
        bottom: 29px;
      }
      .marker[data-dragging='true'],
      .marker:focus-visible {
        z-index: 3;
      }
      .marker time {
        position: absolute;
        bottom: calc(100% + 5px);
        left: 50%;
        transform: translateX(-50%);
        white-space: nowrap;
        background: var(--panel);
        border: 1px solid var(--edge);
        border-radius: 4px;
        padding: 3px 5px;
        color: var(--ink);
        font: 10.5px/1.3 var(--mono);
        font-variant-numeric: tabular-nums;
        visibility: hidden;
        pointer-events: none;
      }
      .marker:hover time,
      .marker:focus-visible time,
      .marker[data-dragging='true'] time {
        visibility: visible;
      }

      @media (pointer: coarse) {
        /* Mit dem Finger groesser als mit der Maus, aber nicht so gross,
           dass die Marke die Wellenform darunter verdeckt: 24 auf 26 ist
           knapp unter dem ueblichen Mindestziel und trotzdem sicher zu
           fassen, weil sie frei auf der Schiene liegt und nichts daneben
           steht, das man stattdessen traefe. */
        .marker {
          min-height: 26px;
          width: 24px;
        }
        .rail.crowded .marker.b {
          bottom: 32px;
        }
        .ruler {
          min-height: 62px;
        }
      }
    `,
  ],
  template: `
    <div class="ruler" #ruler>
      <div class="ticks" aria-hidden="true">
        @for (tick of ticks(); track $index) {
          <span>{{ tick }}</span>
        }
      </div>

      <span class="playhead" aria-hidden="true" [style.left]="headLeft()"></span>

      @if (hover(); as h) {
        <span class="scrub-line" aria-hidden="true" [style.left.%]="pct(h)"></span>
        <span class="scrub" aria-hidden="true" [style.--pos]="pct(h) + '%'">
          {{ clock(h) }} <b>· {{ millis(h) }} ms</b>
        </span>
      }

      @if (view(); as l) {
        <div class="rail" [class.off]="!loopEnabled()" [class.crowded]="crowded()">
          <div
            class="strip"
            aria-hidden="true"
            [style.left.%]="pct(l.a)"
            [style.width.%]="pct(l.b) - pct(l.a)"
          >
            <i [style.width.%]="fill()"></i>
          </div>

          @for (end of ends; track end) {
            <button
              type="button"
              class="marker"
              [class.b]="end === 'b'"
              [attr.data-endpoint]="end"
              [attr.data-dragging]="dragging() === end"
              role="slider"
              [attr.aria-label]="end === 'a' ? 'Loop-Anfang A' : 'Loop-Ende B'"
              aria-valuemin="0"
              [attr.aria-valuemax]="duration().toFixed(2)"
              [attr.aria-valuenow]="at(end).toFixed(2)"
              [attr.aria-valuetext]="clock(at(end))"
              [style.--pos]="pct(at(end)) + '%'"
              (pointerdown)="onDown(end, $event)"
              (pointermove)="onMove(end, $event)"
              (pointerup)="onUp(end, $event)"
              (lostpointercapture)="onUp(end, $event)"
              (keydown)="onKey(end, $event)"
            >
              {{ end === 'a' ? 'A' : 'B' }}
              <time aria-hidden="true">
                {{ end === 'a' ? 'A' : 'B' }} · {{ clock(at(end)) }}
              </time>
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class TimeRulerComponent {
  readonly duration = input(0);
  readonly position = input(0);
  readonly loop = input<LoopRange | null>(null);
  readonly loopEnabled = input(true);
  /** Zeit unter dem Zeiger, aus den Wellenformen gemeldet — oder null. */
  readonly hover = input<number | null>(null);

  readonly loopChange = output<LoopRange>();

  readonly ends: readonly Endpoint[] = ['a', 'b'];

  private readonly rulerRef = viewChild.required<ElementRef<HTMLElement>>('ruler');
  private readonly width = signal(0);

  readonly dragging = signal<Endpoint | null>(null);
  /** Stand waehrend des Ziehens, noch nicht gemeldet. */
  private readonly pending = signal<LoopRange | null>(null);

  private dragOrigin = 0;
  private dragFrom: LoopRange | null = null;
  private lastEmit = 0;

  constructor() {
    effect((onCleanup) => {
      const el = this.rulerRef().nativeElement;
      const observer = new ResizeObserver((entries) => {
        this.width.set(Math.round(entries[0].contentRect.width));
      });
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });

    // Der eigene Stand gilt, bis der gemeldete Loop zurueckkommt. Sonst
    // rechnete die naechste Pfeiltaste wieder vom alten Wert aus: zwei
    // schnelle Tastendruecke ergaeben dann nur einen Schritt. Beim Ziehen
    // bleibt er stehen, dort meldet erst das Loslassen den Endstand.
    effect(() => {
      this.loop();
      if (!untracked(this.dragging)) this.pending.set(null);
    });
  }

  /** Was gezeigt wird: beim Ziehen der eigene Stand, sonst der echte Loop. */
  readonly view = computed(() => this.pending() ?? this.loop());

  /**
   * Zeitmarken, die letzte ist das Songende. Wie viele hineinpassen, haengt
   * an der gemessenen Breite: sechs Marken brauchen Platz, und zwei Zahlen,
   * die sich beruehren, sind schlechter als eine Zahl weniger.
   */
  readonly ticks = computed(() => {
    const duration = this.duration();
    if (!duration) return [];
    const width = this.width();
    const count = width >= 430 ? 6 : width >= 260 ? 4 : 3;
    return Array.from({ length: count }, (_, i) =>
      this.clockShort((duration * i) / (count - 1)),
    );
  });

  readonly headLeft = computed(() => {
    const duration = this.duration();
    const pct = duration ? (this.position() / duration) * 100 : 0;
    return `min(calc(100% - 1px), ${pct}%)`;
  });

  /** Fuellstand im Loop: wie weit der laufende Durchgang ist. */
  readonly fill = computed(() => {
    const l = this.view();
    if (!l || l.b <= l.a) return 0;
    return Math.min(100, Math.max(0, ((this.position() - l.a) / (l.b - l.a)) * 100));
  });

  readonly crowded = computed(() => {
    const l = this.view();
    const duration = this.duration();
    if (!l || !duration) return false;
    return ((l.b - l.a) / duration) * this.width() < CROWDED_PX;
  });

  at(end: Endpoint): number {
    const l = this.view();
    if (!l) return 0;
    return end === 'a' ? l.a : l.b;
  }

  pct(seconds: number): number {
    const duration = this.duration();
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (seconds / duration) * 100));
  }

  clock(seconds: number): string {
    const s = isFinite(seconds) && seconds > 0 ? seconds : 0;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(2)}`;
  }

  /** Ganze Millisekunden — die Einheit, in der die Loop-Felder stehen. */
  millis(seconds: number): number {
    return Math.round((isFinite(seconds) && seconds > 0 ? seconds : 0) * 1000);
  }

  private clockShort(seconds: number): string {
    const s = isFinite(seconds) && seconds > 0 ? seconds : 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------- bedienung
  /** Grenzen der einen Marke: die andere bleibt stehen, mit Mindestabstand. */
  private bounds(end: Endpoint, l: LoopRange): [number, number] {
    return end === 'a'
      ? [0, l.b - LOOP_MIN_SECONDS]
      : [l.a + LOOP_MIN_SECONDS, this.duration()];
  }

  private move(end: Endpoint, seconds: number, force: boolean): void {
    const base = this.dragFrom ?? this.view();
    if (!base) return;
    const [lo, hi] = this.bounds(end, base);
    const value = Math.round(Math.min(hi, Math.max(lo, seconds)) * 100) / 100;
    const next: LoopRange = end === 'a' ? { a: value, b: base.b } : { a: base.a, b: value };
    this.pending.set(next);
    const now = performance.now();
    if (force || now - this.lastEmit > EMIT_MS) {
      this.lastEmit = now;
      this.loopChange.emit(next);
    }
  }

  onDown(end: Endpoint, event: PointerEvent): void {
    const l = this.view();
    if (!l || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    this.dragOrigin = event.clientX;
    this.dragFrom = l;
    this.dragging.set(end);
    this.lastEmit = 0;
    const target = event.target as Element;
    (target.closest('.marker') ?? target).setPointerCapture?.(event.pointerId);
    (target.closest('.marker') as HTMLElement | null)?.focus();
  }

  onMove(end: Endpoint, event: PointerEvent): void {
    if (this.dragging() !== end || !this.dragFrom) return;
    const width = this.width();
    if (!width) return;
    const from = end === 'a' ? this.dragFrom.a : this.dragFrom.b;
    const delta = ((event.clientX - this.dragOrigin) / width) * this.duration();
    this.move(end, from + delta, false);
  }

  onUp(end: Endpoint, event: PointerEvent): void {
    if (this.dragging() !== end) return;
    this.onMove(end, event);
    const final = this.pending();
    this.dragging.set(null);
    this.dragFrom = null;
    this.pending.set(null);
    if (final) this.loopChange.emit(final);
  }

  /** Tastatur: ein Pfeil eine Sekunde, mit Umschalt ein Zehntel. */
  onKey(end: Endpoint, event: KeyboardEvent): void {
    const l = this.view();
    if (!l) return;
    const step = event.shiftKey ? 0.1 : 1;
    const current = end === 'a' ? l.a : l.b;
    const [lo, hi] = this.bounds(end, l);
    const target = ((): number | null => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          return current - step;
        case 'ArrowRight':
        case 'ArrowUp':
          return current + step;
        case 'PageDown':
          return current - 10;
        case 'PageUp':
          return current + 10;
        case 'Home':
          return lo;
        case 'End':
          return hi;
        default:
          return null;
      }
    })();
    if (target === null) return;
    event.preventDefault();
    this.dragFrom = l;
    this.move(end, target, true);
    this.dragFrom = null;
  }
}
