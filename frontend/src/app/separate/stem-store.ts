/**
 * Die Ergebnisse des Browserpfads, für die Dauer der Sitzung.
 *
 * Nichts davon wird gespeichert. Kein `localStorage`, kein IndexedDB, kein
 * Cache — Audiodaten und Dateinamen bleiben im Arbeitsspeicher dieses Tabs
 * und sind mit dem Neuladen weg. Gecacht werden nur die Modellgewichte,
 * und die stehen in `model-cache.ts`.
 *
 * Trotzdem muss das hier eine Grenze haben. Ein Song von 4:33 ergibt vier
 * Spuren zu je rund 92 MB (`Dauer × 44100 × 2 Kanäle × 4 Byte`), also 368 MB
 * je Ergebnis — bei sechs Spuren 551 MB. Wer fünf Songs hintereinander
 * trennt, hätte ohne Grenze zwei Gigabyte liegen, und der Tab stürbe am
 * dritten. Deshalb ein festes Budget und die ältesten Ergebnisse fliegen
 * heraus.
 *
 * Herausgeflogen heißt nicht „weg ohne Spur": der Verlauf behält den Job und
 * schreibt „Ergebnis nicht mehr im Speicher" dazu. Trennen kann man
 * denselben Song erneut.
 */
import { Injectable, computed, signal } from '@angular/core';

/**
 * Budget für aufbewahrte Ergebnisse.
 *
 * 1,2 GB fasst drei Ergebnisse zu vier Spuren von viereinhalb Minuten, oder
 * zwei zu sechs Spuren. Das aktive Deck liegt zusätzlich in den
 * Stretch-Worklets — der Browser-Prozess wächst gemessen um etwa das
 * Doppelte der gehaltenen Menge (README). Mit 1,2 GB bleibt das auf einer
 * Maschine mit 8 GB im Rahmen.
 */
export const STEM_BUDGET_BYTES = 1_200_000_000;

export interface StoredStem {
  /** Name, wie das Modell ihn liefert: `vocals`, `drums`, … */
  source: string;
  channels: Float32Array[];
}

export interface StoredResult {
  jobId: string;
  stems: StoredStem[];
  sampleRate: number;
  bytes: number;
}

@Injectable({ providedIn: 'root' })
export class StemStore {
  /**
   * Einfügereihenfolge zählt: `Map` behält sie, und das ist genau die
   * Reihenfolge, in der verdrängt wird — das älteste zuerst.
   */
  private readonly held = new Map<string, StoredResult>();

  /**
   * Das Budget dieses Speichers.
   *
   * Ein Feld und kein Konstruktorparameter: Angular kann keine Zahl
   * injizieren (NG2003), und ein eigener Injektionsschlüssel wäre für eine
   * Konstante mehr Gerüst als Nutzen. Die Prüfung in
   * `tests/separate/dsp-check.ts` setzt es herunter, weil sich die
   * Verdrängung sonst nur mit über einem Gigabyte Audio zeigen ließe.
   */
  budget = STEM_BUDGET_BYTES;

  /** Was gerade liegt. Signal, damit der Verlauf darauf reagieren kann. */
  private readonly version = signal(0);

  readonly bytes = computed(() => {
    this.version();
    let sum = 0;
    for (const result of this.held.values()) sum += result.bytes;
    return sum;
  });

  /** Kennungen der Jobs, deren Ergebnis noch im Speicher liegt. */
  readonly available = computed(() => {
    this.version();
    return new Set(this.held.keys());
  });

  has(jobId: string): boolean {
    return this.held.has(jobId);
  }

  get(jobId: string): StoredResult | null {
    const found = this.held.get(jobId);
    if (!found) return null;
    // Wieder öffnen heißt: es ist das jüngste. Sonst verdrängte man genau
    // das Ergebnis, mit dem gerade gearbeitet wird.
    this.held.delete(jobId);
    this.held.set(jobId, found);
    return found;
  }

  put(result: Omit<StoredResult, 'bytes'>): void {
    let bytes = 0;
    for (const stem of result.stems) {
      for (const channel of stem.channels) bytes += channel.byteLength;
    }
    this.held.delete(result.jobId);
    this.held.set(result.jobId, { ...result, bytes });
    this.evict(result.jobId);
    this.version.update((v) => v + 1);
  }

  /** Nimmt ein Ergebnis aus dem Speicher — etwa wenn der Job gelöscht wird. */
  drop(jobId: string): void {
    if (this.held.delete(jobId)) this.version.update((v) => v + 1);
  }

  clear(): void {
    this.held.clear();
    this.version.update((v) => v + 1);
  }

  /**
   * Verdrängt die ältesten Ergebnisse, bis das Budget wieder stimmt.
   *
   * `keep` fliegt nie heraus: ein Ergebnis, das größer als das ganze Budget
   * ist — ein sehr langes Stück mit sechs Spuren —, soll zumindest einmal
   * benutzbar sein, statt sofort nach dem Rechnen zu verschwinden.
   */
  private evict(keep: string): void {
    let sum = 0;
    for (const result of this.held.values()) sum += result.bytes;
    for (const [id, result] of this.held) {
      if (sum <= this.budget) break;
      if (id === keep) continue;
      this.held.delete(id);
      sum -= result.bytes;
    }
  }
}
