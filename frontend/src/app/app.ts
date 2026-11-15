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
import { ImportPanelComponent } from './components/import-panel';
import { JobListComponent } from './components/job-list';
import { PlayerComponent } from './components/player';
import { RunProgressComponent } from './components/run-progress';
import { ApiService } from './core/api.service';
import { JobsService } from './core/jobs.service';
import type { Job } from './core/models';
import { DeviceSeparator } from './separate/device-separator';
import { StemStore } from './separate/stem-store';

/**
 * Die Oberflaeche ist eine schmale Spalte: der Import als Karte, darunter
 * der Verlauf. Die Breite folgt der Vorlage
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
    ImportPanelComponent,
    JobListComponent,
    PlayerComponent,
    RunProgressComponent,
  ],
  styles: [
    `
      :host {
        display: block;
      }
      .shell {
        /* Dieselbe Spaltenbreite wie die Vorlage: 780 px abzueglich der
           Raender ergibt die Karte darin. */
        max-width: 780px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        /* Der Abstand zwischen den Karten der Seite -- der Verlauf soll
           nicht an der Importkarte kleben. */
        gap: 22px;
        padding-inline: max(14px, env(safe-area-inset-left, 0px))
          max(14px, env(safe-area-inset-right, 0px));
        padding-block: clamp(22px, 5vw, 64px) 56px;
      }

      .notes {
        display: flex;
        flex-direction: column;
        gap: 7px;
      }

      /* ------------------------------------------------------------- Deck */
      /* Der Dialog ist nur der Rahmen: sichtbar ist die Deck-Karte darin,
         deshalb ohne eigene Flaeche, ohne Rand, ohne Polster. Gescrollt
         wird im Dialog, nicht auf der Seite dahinter. */
      .deck-modal {
        width: min(1180px, calc(100vw - 2 * clamp(8px, 2vw, 26px)));
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
    `,
  ],
  template: `
    <main class="shell">
      <app-import-panel (started)="watch($event)" />

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

      <app-job-list
        [selectedId]="selected()?.id ?? null"
        (open)="openJob($event)"
        (closed)="closeJob()"
      />

    </main>

    <!-- ------------------------------------------------ Trennung laeuft -->
    <dialog
      #runDialog
      class="run-modal"
      aria-label="Trennung läuft"
      (close)="stopWatching()"
      (pointerdown)="markBackdrop($event, runDialog)"
      (click)="closeOnBackdrop($event, runDialog)"
    >
      @if (watched(); as job) {
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
      @if (selected(); as job) {
        <app-player [job]="job" (close)="closeJob()" />
      }
    </dialog>
  `,
})
export class AppComponent {
  readonly api = inject(ApiService);
  private readonly engine = inject(MixEngine);
  private readonly jobs = inject(JobsService);
  private readonly store = inject(StemStore);
  private readonly device = inject(DeviceSeparator);

  readonly selected = signal<Job | null>(null);

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
      const open = !!this.watched();
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
      const open = !!this.selected() || !!this.watched();
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
   * Player holt und dekodiert; ein Job vom Geraet bringt die Abtastwerte
   * selbst mit und braucht dafuer kein Netz. Welcher Weg es ist, entscheidet
   * sich hier — ab der `load`-Schnittstelle ist es dasselbe Deck.
   */
  openJob(job: Job): void {
    if (job.site === 'device') {
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
