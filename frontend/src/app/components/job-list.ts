import { Component, computed, effect, inject, input, output, signal } from '@angular/core';

import { IconComponent } from '../core/icon';
import { JobsService } from '../core/jobs.service';
import { STATUS_LABELS, type Job, type Stem } from '../core/models';
import { songName } from '../core/song-name';
import { shortStemName } from '../core/stem-name';
import { StemStore } from '../separate/stem-store';
import { downloadWav } from '../separate/wav';

/** Jobs je Seite. Sechs passen auf einen Blick, ohne dass man scrollt. */
const PAGE_SIZE = 6;

/** Die drei Sichten auf den Verlauf. */
type Tab = 'alle' | 'songs' | 'tests';

/**
 * Verlauf: was getrennt wurde und was gerade laeuft.
 *
 * Eine Zeile je Job, nur durch eine Linie getrennt — keine Karten in der
 * Karte. In der Zeile steht, woran man den Job wiedererkennt: das Stueck,
 * darunter Interpret, Trennmodus, Laenge und Spurzahl. Alles Weitere
 * (Spuren speichern, loeschen) liegt hinter dem Menue am Zeilenende, denn
 * gebraucht wird fast immer dasselbe: das Deck oeffnen.
 *
 * Die Reiter trennen, was sich nicht vergleichen laesst: echte Trennungen
 * und Testlaeufe. Letztere sammeln sich beim Ausprobieren an und waeren
 * sonst die Mehrheit der Liste.
 */
@Component({
  selector: 'app-job-list',
  standalone: true,
  imports: [IconComponent],
  styles: [
    `
      :host {
        display: block;
        container-type: inline-size;
      }
      .history {
        padding: 0;
        overflow: hidden;
        /* Ohne Rand: der Verlauf ist eine Liste, keine zweite Karte neben
           dem Import. Die Flaeche traegt ihn, die Linien zwischen den
           Zeilen gliedern ihn. */
        border: 0;
      }

      /* ------------------------------------------------------- Kopfzeile */
      .head {
        display: flex;
        gap: 10px 16px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 13px 16px 0;
      }
      .head h2 {
        font-size: 13.5px;
        font-weight: 650;
        letter-spacing: -0.012em;
      }
      .tabs {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      /* Reiter, keine Schalter: sie liegen auf einer Linie und tragen die
         Anzahl gleich mit, damit man vorher weiss, was einen erwartet. */
      .tabs button.tab {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        min-height: 0;
        padding: 2px 0 7px;
        border: 0;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        background: none;
        color: var(--dim);
        font-size: 12.5px;
      }
      .tabs button.tab:hover:not(:disabled) {
        color: var(--ink);
      }
      .tabs button.tab b {
        font: 11px/1 var(--mono);
        font-variant-numeric: tabular-nums;
        color: var(--faint);
      }
      .tabs button.tab[aria-selected='true'] {
        color: var(--ink);
        border-bottom-color: var(--accent);
      }
      .tabs button.tab[aria-selected='true'] b {
        color: var(--accent);
      }

      /* ------------------------------------------------------------ Zeile */
      .row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 11px;
        padding: 10px 16px;
        border-top: 1px solid var(--edge-soft);
        transition: background 0.12s;
      }
      .row:hover {
        background: light-dark(rgb(0 0 0 / 0.025), rgb(255 255 255 / 0.022));
      }
      .row.current {
        background: var(--tint);
      }
      .glyph {
        display: inline-flex;
        color: var(--faint);
        --icon-size: 17px;
      }
      .row.current .glyph {
        color: var(--accent);
      }
      .what {
        min-width: 0;
      }
      .song {
        font-size: 13.5px;
        font-weight: 620;
        letter-spacing: -0.012em;
      }
      .meta {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 2px;
        font: 11.5px/1.4 var(--mono);
        color: var(--dim);
        font-variant-numeric: tabular-nums;
      }
      .meta .sep {
        color: var(--edge);
      }
      .meta.bad {
        color: var(--bad);
        font-family: var(--sans);
      }

      /* --------------------------------------------------------- Aktionen */
      .actions {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .state {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        color: var(--dim);
        --icon-size: 14px;
      }
      .state.bad {
        color: var(--bad);
      }
      /* Die eine Handlung, um die es im Verlauf geht, sieht auch so aus:
         ein Knopf in der Akzentfarbe, mit dem Zeichen fuer "geht auf".
         Ein Haken und ein Stueck Text daneben waren zwei halbe Angaben. */
      .open {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 29px;
        padding: 4px 11px;
        border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
        border-radius: var(--radius-sm);
        background: none;
        color: var(--accent);
        font-size: 12.5px;
        font-weight: 550;
        --icon-size: 14px;
      }
      .open:hover:not(:disabled) {
        border-color: var(--accent);
        background: var(--ghost);
      }
      .open[aria-pressed='true'] {
        border-color: var(--accent);
        background: var(--ghost);
      }

      /* Das Menue am Zeilenende: alles, was selten gebraucht wird. */
      .menu-wrap {
        position: relative;
        display: inline-flex;
      }
      button.dots {
        min-height: 0;
        width: 22px;
        height: 22px;
        padding: 0;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--faint);
        --icon-size: 15px;
      }
      button.dots:hover:not(:disabled),
      button.dots[aria-expanded='true'] {
        color: var(--ink);
        background: var(--ghost);
      }
      .menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        z-index: 6;
        min-width: 196px;
        padding: 5px;
        border: 1px solid var(--edge);
        border-radius: var(--radius-sm);
        background: var(--panel-2);
        box-shadow: 0 14px 30px -12px light-dark(rgb(24 19 30 / 0.3), rgb(0 0 0 / 0.6));
      }
      .menu > * {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        min-height: 0;
        padding: 6px 8px;
        border: 0;
        border-radius: 5px;
        background: none;
        color: var(--ink);
        font-size: 12.5px;
        text-align: left;
        text-decoration: none;
        --icon-size: 13px;
      }
      .menu > *:hover {
        background: var(--ghost);
        color: var(--accent);
      }
      .menu hr {
        margin: 4px 2px;
        padding: 0;
        min-height: 0;
      }
      .menu .danger {
        color: var(--bad);
      }
      .menu .danger:hover {
        background: var(--bad-bg);
        color: var(--bad);
      }

      /* ------------------------------------------------------------ Fuss */
      .pager {
        display: flex;
        gap: 7px;
        align-items: center;
        padding: 9px 16px;
        border-top: 1px solid var(--edge-soft);
        --icon-size: 14px;
      }
      .pager .of {
        margin-left: auto;
      }
      .empty {
        padding: 16px;
        border-top: 1px solid var(--edge-soft);
        color: var(--dim);
        font-size: 12.5px;
      }

      @container (max-width: 520px) {
        .row {
          grid-template-columns: auto minmax(0, 1fr);
          row-gap: 7px;
        }
        .actions {
          grid-column: 2;
        }
      }
    `,
  ],
  template: `
    <section class="panel history">
      <div class="head">
        <h2>Verlauf</h2>

        <div class="tabs" role="tablist" aria-label="Verlauf filtern">
          @for (t of TABS; track t.key) {
            <button
              class="tab"
              role="tab"
              data-testid="tab"
              [attr.aria-selected]="tab() === t.key"
              [disabled]="!count(t.key) && tab() !== t.key"
              (click)="setTab(t.key)"
            >
              {{ t.label }} <b>{{ count(t.key) }}</b>
            </button>
          }

          <span
            class="menu-wrap"
            (focusout)="closeMenu($event, 'liste')"
            (keydown.escape)="menu.set(null)"
          >
            <button
              class="dots"
              data-testid="purge"
              aria-label="Weitere Aktionen für den Verlauf"
              [attr.aria-expanded]="menu() === 'liste'"
              (click)="toggleMenu('liste')"
            >
              <app-icon name="ellipsis" />
            </button>
            @if (menu() === 'liste') {
              <div class="menu" role="menu">
                <button
                  class="danger"
                  role="menuitem"
                  data-testid="purge-item"
                  [disabled]="!removable()"
                  (click)="armOrPurge()"
                >
                  <app-icon name="trash" />
                  {{ purgeArmed() ? 'Wirklich? ' + removable() + ' löschen' : purgeLabel() }}
                </button>
              </div>
            }
          </span>
        </div>
      </div>

      @if (jobs.jobs().length === 0) {
        <p class="empty">
          Noch keine Jobs. Nach dem Import erscheint hier jede Trennung mit
          ihrem Zustand; sobald eine fertig ist, lässt sie sich im Deck öffnen
          und jede Spur einzeln als WAV speichern.
        </p>
      } @else if (filtered().length === 0) {
        <p class="empty">In dieser Sicht steht nichts.</p>
      }

      @for (job of visible(); track job.id) {
        <article
          class="row"
          [class.current]="job.id === selectedId()"
          data-testid="job"
          [attr.data-job-id]="job.id"
          [attr.data-status]="job.status"
          [attr.data-test-path]="job.is_test_path"
        >
          <span class="glyph" aria-hidden="true"><app-icon name="audio-lines" /></span>

          <div class="what">
            <div class="song truncate" [title]="job.source_name">
              {{ name(job).title }}
            </div>
            @if (job.status === 'failed') {
              <div class="meta bad">{{ job.error ?? 'Fehlgeschlagen' }}</div>
            } @else {
              <div class="meta">
                @if (name(job).artist; as artist) {
                  <span>{{ artist }}</span>
                  <span class="sep">·</span>
                }
                <span>{{ mode(job) }}</span>
                @if (job.duration_seconds) {
                  <span class="sep">·</span>
                  <span>{{ formatDuration(job.duration_seconds) }}</span>
                }
                @if (job.status === 'done') {
                  <span class="sep">·</span>
                  <span>{{ job.stems.length }} Spuren</span>
                } @else {
                  <span class="sep">·</span>
                  <span>{{ job.stage ?? STATUS_LABELS[job.status] }}</span>
                }
              </div>
            }
          </div>

          <div class="actions">
            @switch (job.status) {
              @case ('done') {
                @if (gone(job); as why) {
                  <!-- Das Ergebnis lag nur im Arbeitsspeicher dieser
                       Sitzung und ist dem Budget zum Opfer gefallen. Der
                       Job bleibt stehen, damit man sieht, dass er lief —
                       aufmachen kann man ihn nicht mehr. -->
                  <span class="state" data-testid="stems-gone" [title]="goneHint">
                    {{ why }}
                  </span>
                } @else {
                  <button
                    class="open"
                    data-testid="open-in-player"
                    [attr.aria-pressed]="job.id === selectedId()"
                    [title]="elapsed(job) ?? 'Fertig getrennt'"
                    (click)="open.emit(job)"
                  >
                    <app-icon name="square-arrow-out-up-right" />
                    {{ job.id === selectedId() ? 'Im Deck geöffnet' : 'Im Deck öffnen' }}
                  </button>
                }
              }
              @case ('failed') {
                <span class="state bad">Fehlgeschlagen</span>
              }
              @default {
                <span class="state">
                  <app-icon name="clock" />
                  {{ job.status === 'processing' ? 'läuft' : 'wartet' }}
                </span>
              }
            }

            <span
              class="menu-wrap"
              (focusout)="closeMenu($event, job.id)"
              (keydown.escape)="menu.set(null)"
            >
              <button
                class="dots"
                [attr.aria-label]="'Weitere Aktionen zu ' + name(job).title"
                [attr.aria-expanded]="menu() === job.id"
                (click)="toggleMenu(job.id)"
              >
                <app-icon name="ellipsis" />
              </button>
              @if (menu() === job.id) {
                <div class="menu" role="menu">
                  @for (stem of job.stems; track stem.slug) {
                    @if (job.site === 'server') {
                      <a
                        role="menuitem"
                        [href]="stem.download_url"
                        [download]="stem.name + '.wav'"
                      >
                        <app-icon name="download" />{{ short(stem.name) }} speichern
                      </a>
                    } @else if (!gone(job)) {
                      <!-- Im Browserpfad gibt es keine Datei, auf die ein
                           Link zeigen koennte. Die WAV wird beim Klick
                           geschrieben — vier Spuren im Voraus waeren 190 MB,
                           die niemand angefordert hat. -->
                      <button role="menuitem" (click)="save(job, stem)">
                        <app-icon name="download" />{{ short(stem.name) }} speichern
                      </button>
                    }
                  }
                  @if (job.stems.length) {
                    <hr />
                  }
                  <button class="danger" role="menuitem" (click)="armOrRemove(job)">
                    <app-icon name="trash" />
                    {{ armed() === job.id ? 'Wirklich löschen?' : 'Job löschen' }}
                  </button>
                </div>
              }
            </span>
          </div>
        </article>
      }

      @if (pages() > 1) {
        <nav class="pager" aria-label="Seiten des Verlaufs">
          <button
            class="icon sm"
            data-testid="page-back"
            aria-label="Eine Seite zurück"
            title="Eine Seite zurück"
            [disabled]="page() === 0"
            (click)="turn(-1)"
          >
            <app-icon name="chevron-left" />
          </button>
          <span class="mono tiny dim" aria-live="polite" data-testid="page-of">
            Seite {{ page() + 1 }} / {{ pages() }}
          </span>
          <button
            class="icon sm"
            data-testid="page-next"
            aria-label="Eine Seite vor"
            title="Eine Seite vor"
            [disabled]="page() >= pages() - 1"
            (click)="turn(1)"
          >
            <app-icon name="chevron-right" />
          </button>
          <span class="tiny faint of">{{ filtered().length }} Jobs in dieser Sicht</span>
        </nav>
      }
    </section>
  `,
})
export class JobListComponent {
  readonly jobs = inject(JobsService);
  private readonly store = inject(StemStore);
  readonly selectedId = input<string | null>(null);
  readonly open = output<Job>();
  readonly closed = output<string>();

  readonly STATUS_LABELS = STATUS_LABELS;

  readonly TABS: readonly { key: Tab; label: string }[] = [
    { key: 'alle', label: 'Alle' },
    { key: 'songs', label: 'Songs' },
    { key: 'tests', label: 'Testläufe' },
  ];

  /** Job, dessen Loeschen angefragt, aber noch nicht bestaetigt ist. */
  readonly armed = signal<string | null>(null);
  /** Dasselbe fuer das grosse Aufraeumen. */
  readonly purgeArmed = signal(false);
  /** Welches Menue offen ist: eine Job-Kennung oder 'liste'. */
  readonly menu = signal<string | null>(null);

  readonly tab = signal<Tab>('alle');
  /** Gewuenschte Seite. Was wirklich gilt, steht in `page`. */
  private readonly wanted = signal(0);

  private newest: string | null = null;

  constructor() {
    // Ein neuer Job steht oben. Wer gerade auf Seite drei blaettert, soll
    // ihn trotzdem sehen — sonst scheint der Import nichts getan zu haben.
    effect(() => {
      const top = this.jobs.jobs()[0]?.id ?? null;
      if (top === this.newest) return;
      this.newest = top;
      this.wanted.set(0);
    });
  }

  count(tab: Tab): number {
    return this.jobs.jobs().filter((j) => this.matches(j, tab)).length;
  }

  private matches(job: Job, tab: Tab): boolean {
    switch (tab) {
      case 'songs': return !job.is_test_path;
      case 'tests': return job.is_test_path;
      default: return true;
    }
  }

  readonly filtered = computed(() =>
    this.jobs.jobs().filter((j) => this.matches(j, this.tab())),
  );

  readonly pages = computed(() => Math.max(1, Math.ceil(this.filtered().length / PAGE_SIZE)));

  /**
   * Die Seite, die wirklich gilt. Die Liste aendert sich im Hintergrund
   * weiter — wird sie kuerzer, waere die gewuenschte Seite sonst leer.
   */
  readonly page = computed(() => Math.min(this.wanted(), this.pages() - 1));

  readonly visible = computed(() => {
    const from = this.page() * PAGE_SIZE;
    return this.filtered().slice(from, from + PAGE_SIZE);
  });

  /**
   * Abgeschlossene Jobs der gerade gezeigten Sicht — nur die raeumt das
   * Menue weg. Wer auf "Testlaeufe" steht, meint die Testlaeufe und nicht
   * die Trennungen, die Minuten gekostet haben.
   */
  private readonly doomed = computed(() =>
    this.filtered().filter((j) => j.status === 'done' || j.status === 'failed'),
  );

  readonly removable = computed(() => this.doomed().length);

  readonly purgeLabel = computed(() => {
    switch (this.tab()) {
      case 'songs': return 'Alle fertigen Songs löschen';
      case 'tests': return 'Alle Testläufe löschen';
      default: return 'Alle abgeschlossenen löschen';
    }
  });

  name(job: Job): { title: string; artist: string | null } {
    return songName(job.source_name);
  }

  /**
   * Der Trennmodus, wie er bei der Auswahl hiess ("Schnell"). Am Job steht
   * nur der Modellname; den Kurznamen kennt die Modelliste. Faellt sie aus
   * oder gibt es das Modell nicht mehr, steht da die lange Beschriftung —
   * laenger, aber nie falsch.
   */
  mode(job: Job): string {
    return this.jobs.models().find((m) => m.name === job.model)?.mode ?? job.model_label;
  }

  turn(step: number): void {
    this.wanted.set(Math.min(Math.max(this.page() + step, 0), this.pages() - 1));
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    this.wanted.set(0);
  }

  toggleMenu(key: string): void {
    this.menu.update((open) => (open === key ? null : key));
    this.armed.set(null);
    this.purgeArmed.set(false);
  }

  /** Schliesst das Menue, sobald der Fokus die Gruppe verlaesst. */
  closeMenu(event: FocusEvent, key: string): void {
    if (this.menu() !== key) return;
    const wrap = event.currentTarget as HTMLElement;
    const next = event.relatedTarget;
    if (next instanceof Node && wrap.contains(next)) return;
    this.menu.set(null);
    this.armed.set(null);
    this.purgeArmed.set(false);
  }

  short(name: string): string {
    return shortStemName(name);
  }

  /**
   * „Ergebnis nicht mehr im Speicher", oder `null`.
   *
   * Betrifft nur Jobs vom Geraet: die Spuren eines Backendjobs liegen auf
   * der Platte und sind auch morgen noch da.
   */
  gone(job: Job): string | null {
    return this.jobs.unavailableReason(job);
  }

  readonly goneHint =
    'Die Spuren lagen nur im Arbeitsspeicher dieser Sitzung und sind einem ' +
    'neueren Ergebnis gewichen. Denselben Song erneut zu trennen geht.';

  /** Schreibt eine Spur als WAV — erst jetzt, beim Klick. */
  save(job: Job, stem: Stem): void {
    const held = this.store.get(job.id);
    const found = held?.stems.find((s) => s.source === stem.slug);
    if (!held || !found) return;
    this.menu.set(null);
    downloadWav(found.channels, held.sampleRate, `${stem.name}.wav`);
  }

  formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /** Laufzeit der Trennung, sobald sie bekannt ist. */
  elapsed(job: Job): string | null {
    if (job.started_at && job.finished_at) {
      return `in ${(job.finished_at - job.started_at).toFixed(1)} s getrennt`;
    }
    return null;
  }

  /**
   * Erster Klick fragt, zweiter loescht. Eine Trennung kostet Minuten und
   * kommt nicht zurueck, deshalb nicht beim ersten Treffer loeschen.
   */
  async armOrRemove(job: Job): Promise<void> {
    if (this.armed() !== job.id) {
      this.armed.set(job.id);
      return;
    }
    this.armed.set(null);
    this.menu.set(null);
    if (job.id === this.selectedId()) this.closed.emit(job.id);
    await this.jobs.remove(job);
  }

  /**
   * Dasselbe zweistufig fuer alles Abgeschlossene der gezeigten Sicht.
   * Laufendes bleibt stehen: das Backend ruehrt das Verzeichnis nicht an,
   * in das der Worker gerade schreibt.
   */
  async armOrPurge(): Promise<void> {
    if (!this.purgeArmed()) {
      this.purgeArmed.set(true);
      return;
    }
    this.purgeArmed.set(false);
    this.menu.set(null);
    const open = this.selectedId();
    // Ueber die ganze Liste geht es in einem Aufruf; eine Sicht loescht
    // der Reihe nach, denn welche Jobs gemeint sind, weiss nur die
    // Oberflaeche.
    const deleted =
      this.tab() === 'alle'
        ? (await this.jobs.removeFinished()).deleted
        : await this.jobs.removeMany(this.doomed());
    if (open && deleted.includes(open)) this.closed.emit(open);
  }
}
