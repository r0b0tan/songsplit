import {
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { IconComponent } from '../core/icon';
import { JobsService } from '../core/jobs.service';
import { STATUS_LABELS, type Job } from '../core/models';
import { songName } from '../core/song-name';

/** Jobs je Seite. Zehn Zeilen fuellen das Blatt, ohne dass man scrollt. */
const PAGE_SIZE = 10;

/** Die drei Sichten auf den Verlauf. */
type Tab = 'alle' | 'songs' | 'tests';

/**
 * Verlauf: was getrennt wurde und was gerade laeuft. Er steht als Liste
 * unter der Importkarte, in derselben Spalte.
 *
 * Eine Zeile je Job, nur durch eine Linie getrennt — keine Karten in der
 * Karte. Die Zeile ist eine Tabellenzeile: links das Stueck, daneben
 * Modus, Laenge und Spurzahl, rechts die eine Handlung, um die es geht —
 * das Deck oeffnen. Alles Weitere (Spuren speichern, loeschen) liegt
 * hinter dem Menue am Zeilenende.
 *
 * Beim Erscheinen kommt die Liste aus der unteren rechten Ecke heran, die
 * Zeilen gestaffelt hinterher: so sieht man, dass sie nachgetragen wird,
 * und liest nicht in eine Liste, die schon dasteht.
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
      /* Der Verlauf haelt dieselbe Kante wie die Importkarte darueber und
         die Fusslinie darunter: eine Spaltenkante fuer die ganze Seite.
         Wie weit der Ueberstand geht, sagen --bleed-width und
         --bleed-margin aus app.ts. */
      :host {
        display: block;
        container-type: inline-size;
        width: var(--bleed-width, 100%);
        margin-inline: var(--bleed-margin, 0);
      }
      .history {
        padding: 0;
        overflow: hidden;
        /* Luft nach oben, zusaetzlich zum Abstand der Spalte: der Verlauf
           ist ein eigener Abschnitt und soll nicht an der Importkarte
           kleben. */
        margin-top: 28px;
        /* Ohne Rand: der Verlauf ist eine Liste, keine zweite Karte neben
           dem Import. Die Flaeche traegt ihn, die Linien zwischen den
           Zeilen gliedern ihn. */
        border: 0;
        background: none;
        /* Er kommt von unten rechts heran — aus der Ecke, in der die
           Seite endet. */
        animation: history-in 0.42s cubic-bezier(0.2, 0, 0.2, 1) both;
      }
      @keyframes history-in {
        from {
          opacity: 0;
          transform: translate(30px, 38px);
        }
      }

      /* ------------------------------------------------------- Kopfzeile */
      .head {
        display: flex;
        gap: 12px 20px;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        padding: 19px 21px 2px;
      }
      .head h2 {
        font-size: 19px;
        font-weight: 650;
        letter-spacing: -0.02em;
      }
      .tabs {
        display: flex;
        align-items: center;
        gap: 18px;
      }
      /* Reiter, keine Schalter: sie liegen auf einer Linie und tragen die
         Anzahl gleich mit, damit man vorher weiss, was einen erwartet. */
      .tabs button.tab {
        display: inline-flex;
        align-items: baseline;
        gap: 7px;
        min-height: 0;
        padding: 2px 0 9px;
        border: 0;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        background: none;
        color: var(--dim);
        font-size: 13.5px;
      }
      .tabs button.tab:hover:not(:disabled) {
        color: var(--ink);
      }
      .tabs button.tab b {
        font: 11.5px/1 var(--mono);
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
      /* Eine Tabelle ohne Tabellenkopf: die Spalten stehen untereinander
         fest, damit das Auge sie von Zeile zu Zeile wiederfindet. */
      .row {
        display: grid;
        grid-template-columns:
          20px minmax(0, 1fr) minmax(0, 1fr) 46px 80px 140px 26px;
        align-items: center;
        gap: 14px;
        /* Luft in der Zeile: die Liste wird oft ueberflogen, und zwischen
           zehn Zeilen liest es sich leichter, wenn jede fuer sich steht. */
        min-height: 66px;
        padding: 13px 21px;
        border-top: 1px solid var(--edge-soft);
        transition: background 0.12s;
      }
      .row:hover {
        background: light-dark(rgb(0 0 0 / 0.025), rgb(255 255 255 / 0.022));
      }
      .row.current {
        background: var(--tint);
      }
      /* Die Zeilen kommen gestaffelt nach, in derselben Richtung wie das
         Blatt — sonst steht die Liste schon da, bevor sie angekommen ist. */
      .row {
        animation: row-in 0.34s cubic-bezier(0.2, 0, 0.2, 1) both;
        animation-delay: calc(var(--i) * 20ms + 120ms);
      }
      @keyframes row-in {
        from {
          opacity: 0;
          transform: translate(14px, 8px);
        }
      }
      .glyph {
        display: inline-flex;
        color: var(--faint);
        --icon-size: 18px;
      }
      .row.current .glyph {
        color: var(--accent);
      }
      .song {
        font-size: 14px;
        font-weight: 620;
        letter-spacing: -0.012em;
      }
      .song .artist {
        margin-left: 7px;
        font-weight: 400;
        color: var(--faint);
      }
      .cell {
        min-width: 0;
        font-size: 13px;
        color: var(--dim);
      }
      .cell.num {
        font-family: var(--mono);
        font-size: 12.5px;
        font-variant-numeric: tabular-nums;
      }
      .cell.bad {
        color: var(--bad);
      }

      /* --------------------------------------------------------- Aktionen */
      .state {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--dim);
        --icon-size: 14px;
      }
      .state.bad {
        color: var(--bad);
      }
      /* Die eine Handlung, um die es im Verlauf geht, steht als Text da —
         kein Kasten, denn die Spalte ist schon die Trennung. */
      .open {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 30px;
        padding: 4px 9px;
        margin-left: -9px;
        border: 0;
        border-radius: var(--radius-sm);
        background: none;
        color: var(--accent);
        font-size: 13px;
        font-weight: 550;
        text-align: left;
        --icon-size: 14px;
      }
      .open:hover:not(:disabled),
      .open[aria-pressed='true'] {
        background: var(--ghost);
      }

      /* Das Menue am Zeilenende: alles, was selten gebraucht wird. */
      .menu-wrap {
        position: relative;
        display: inline-flex;
        justify-self: end;
      }
      button.dots {
        min-height: 0;
        width: 26px;
        height: 26px;
        padding: 0;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 6px;
        background: none;
        color: var(--faint);
        --icon-size: 16px;
      }
      button.dots:hover:not(:disabled),
      button.dots[aria-expanded='true'] {
        color: var(--ink);
        background: var(--ghost);
      }
      /* Der Loeschgriff der Zeile. Im Ruhezustand so leise wie die
         Punkte vorher -- er soll beim Ueberfliegen nicht nach vorne
         treten. Farbe bekommt er erst, wenn jemand hinzeigt. */
      button.kill {
        justify-self: end;
      }
      button.kill:hover:not(:disabled) {
        color: var(--bad);
        background: var(--bad-bg);
      }

      /* ------------------------------------------------- Rueckfrage */
      /* Das Schild haengt ueber dem Griff: rechts buendig mit ihm, mit
         einer Zeile Luft darueber. Die beiden Masse setzt ask(). */
      .kill-ask {
        position: fixed;
        inset: auto var(--kill-right, 16px) var(--kill-bottom, 16px) auto;
        width: auto;
        max-width: none;
        margin: 0;
        padding: 0;
        border: 1px solid var(--edge);
        border-radius: 10px;
        background: var(--panel-2);
        color: var(--ink);
        /* Zwei Schatten: der weiche traegt das Schild ueber die Zeile,
           der harte zeichnet seine Kante im Dunkeln nach. */
        box-shadow:
          0 10px 24px -8px light-dark(rgb(24 19 30 / 0.28), rgb(0 0 0 / 0.62)),
          0 1px 0 light-dark(rgb(255 255 255 / 0.5), rgb(255 255 255 / 0.04)) inset;
        /* Die Spitze steht ausserhalb -- sie darf nicht abgeschnitten
           werden. */
        overflow: visible;
      }
      /* Nur im offenen Zustand eine Zeile: ohne [open] uebersteuerte das
         display die eingebaute Regel, und das Schild stuende immer da. */
      .kill-ask[open] {
        display: block;
        animation: kill-ask-in 0.13s cubic-bezier(0.2, 0, 0.2, 1);
      }
      /* Es kommt von unten, aus dem Griff heraus. */
      @keyframes kill-ask-in {
        from {
          opacity: 0;
          translate: 0 5px;
        }
      }
      /* Die Spitze zeigt auf den Griff: ein gedrehtes Quadrat, das nur
         seine zwei unteren Kanten zeigt -- so setzt es den Rand des
         Schildes fort, statt ihn zu kreuzen. 13 px von rechts ist die
         Mitte des 26 px breiten Griffs darunter. */
      .kill-ask::after {
        content: '';
        position: absolute;
        right: 8.5px;
        bottom: -5px;
        width: 9px;
        height: 9px;
        rotate: 45deg;
        border-right: 1px solid var(--edge);
        border-bottom: 1px solid var(--edge);
        border-bottom-right-radius: 2px;
        background: var(--panel-2);
      }
      /* Durchsichtig: das Schild gehoert zur Zeile, es legt die Seite
         nicht stumm. Klickbar bleibt der Hintergrund trotzdem -- so
         schliesst ein Klick daneben. */
      .kill-ask::backdrop {
        background: transparent;
      }
      .kill-ask-in {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 7px 8px 7px 13px;
      }
      /* Die Frage traegt das Schild, sie muss nicht rufen. */
      .kill-ask-text {
        margin-inline-end: 5px;
        font-size: 12.5px;
        letter-spacing: -0.008em;
        white-space: nowrap;
      }
      .kill-ask-in button {
        min-height: 27px;
        padding-inline: 12px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 600;
        transition: background 0.12s, color 0.12s, border-color 0.12s;
      }
      /* Die Antwort, die etwas zerstoert, traegt die Warnfarbe -- aber
         getoent, nicht gefuellt. Gefuellt sass sie als korallener Klotz
         im Schild und sah aus wie der Hauptweg der App, nicht wie ein
         Loeschen. */
      .kill-ask-yes {
        border: 1px solid color-mix(in srgb, var(--bad) 34%, transparent);
        background: var(--bad-bg);
        color: var(--bad);
      }
      .kill-ask-yes:hover {
        border-color: color-mix(in srgb, var(--bad) 60%, transparent);
        background: color-mix(in srgb, var(--bad) 17%, var(--bad-bg));
      }
      /* Die Antwort, die nichts tut, ist die leiseste: kein Rand, keine
         Flaeche, bis jemand hinzeigt. */
      .kill-ask-no {
        border: 1px solid transparent;
        background: none;
        color: var(--dim);
      }
      .kill-ask-no:hover {
        border-color: var(--edge);
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
        gap: 8px;
        align-items: center;
        padding: 14px 21px 6px;
        border-top: 1px solid var(--edge-soft);
        --icon-size: 14px;
      }
      .pager .of {
        margin-left: auto;
      }
      .empty {
        padding: 16px 21px 6px;
        border-top: 1px solid var(--edge-soft);
        color: var(--dim);
        font-size: 13px;
        max-width: 64ch;
      }

      /* Schmaler: erst faellt der Modus weg, dann Laenge und Spurzahl —
         das Stueck und der Weg ins Deck bleiben am laengsten. */
      @container (max-width: 700px) {
        .row {
          grid-template-columns: 20px minmax(0, 1fr) 46px 80px auto 26px;
          gap: 11px;
          padding-inline: 14px;
        }
        .head,
        .pager,
        .empty {
          padding-inline: 14px;
        }
        .c-mode {
          display: none;
        }
      }
      @container (max-width: 520px) {
        .row {
          grid-template-columns: 20px minmax(0, 1fr) auto 26px;
        }
        .c-dur,
        .c-stems {
          display: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .history,
        .row {
          animation: none;
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

      <!-- Den Fall "gar keine Jobs" gibt es hier nicht mehr: dann wird
           die Liste erst gar nicht eingehaengt (siehe app.ts). Bleibt der
           Fall, der sich durch einen Klick aufloest -- ein Reiter ohne
           Treffer, waehrend andere welche haben. -->
      @if (filtered().length === 0) {
        <p class="empty">In dieser Sicht steht nichts.</p>
      }

      @for (job of visible(); track job.id; let i = $index) {
        <article
          class="row"
          [class.current]="job.id === selectedId()"
          [style.--i]="i"
          data-testid="job"
          [attr.data-job-id]="job.id"
          [attr.data-status]="job.status"
          [attr.data-test-path]="job.is_test_path"
        >
          <span class="glyph" aria-hidden="true"><app-icon name="audio-lines" /></span>

          <div class="song truncate" [title]="job.source_name">
            {{ name(job).title }}
            @if (name(job).artist; as artist) {
              <span class="artist">{{ artist }}</span>
            }
          </div>

          @if (job.status === 'failed') {
            <div class="cell bad truncate c-mode" [title]="job.error ?? 'Fehlgeschlagen'">
              {{ job.error ?? 'Fehlgeschlagen' }}
            </div>
          } @else {
            <div class="cell truncate c-mode" [title]="mode(job)">{{ mode(job) }}</div>
          }

          <div class="cell num c-dur">
            {{ job.duration_seconds ? formatDuration(job.duration_seconds) : '—' }}
          </div>

          <div class="cell truncate c-stems">
            @if (job.status === 'done') {
              {{ job.stems.length }} Spuren
            } @else if (job.status === 'failed') {
              —
            } @else {
              {{ job.stage ?? STATUS_LABELS[job.status] }}
            }
          </div>

          <div class="cell">
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
          </div>

          <!-- Loeschen ist das Einzige, was die Zeile selbst anbietet:
               die Spuren speichert man im Deck, wo man sie auch hoert.
               Ein Menue fuer einen einzigen Eintrag waere ein Klick zu
               viel, also steht der Griff direkt da.

               Die Rueckfrage stellt er nicht in der Zeile: dort hat sie
               entweder den Weg ins Deck zugedeckt oder die Spalten zur
               Seite geschoben. Sie steht unten im Dialog. -->
          <button
            class="dots kill"
            type="button"
            [attr.aria-label]="'Löschen: ' + name(job).title"
            title="Job löschen"
            (click)="ask(job, $event)"
          >
            <app-icon name="trash" />
          </button>
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

    <!-- Die Rueckfrage: ein kleines Schild ueber dem Griff, der sie
         ausgeloest hat. Mehr als die Frage und zwei Knoepfe steht nicht
         darin.

         <dialog> statt eines gewoehnlichen Feldes, weil es mitbringt,
         was eine Rueckfrage braucht: oberste Ebene (die Liste schneidet
         mit overflow: hidden ab, ein Schild in der Zeile waere also
         abgeschnitten), Escape und Tastaturfang. Der Hintergrund bleibt
         durchsichtig -- es soll ein Schild sein, kein Blatt vor der
         Seite --, faengt aber den Klick daneben ab und schliesst.

         Wo es steht, rechnet ask() aus der Lage des Griffs aus. -->
    <dialog
      #confirm
      class="kill-ask"
      data-testid="ask-delete"
      (close)="pending.set(null)"
      (click)="confirm.close()"
    >
      @if (pending(); as job) {
        <!-- Der Klick im Schild darf nicht als Klick daneben gelten. -->
        <div class="kill-ask-in" (click)="$event.stopPropagation()">
          <span class="kill-ask-text">Wirklich löschen?</span>
          <button type="button" class="kill-ask-yes" (click)="remove(job)">Ja</button>
          <button type="button" class="kill-ask-no" (click)="confirm.close()">Nein</button>
        </div>
      }
    </dialog>
  `,
})
export class JobListComponent {
  readonly jobs = inject(JobsService);
  readonly selectedId = input<string | null>(null);
  readonly open = output<Job>();
  readonly closed = output<string>();

  readonly STATUS_LABELS = STATUS_LABELS;

  readonly TABS: readonly { key: Tab; label: string }[] = [
    { key: 'alle', label: 'Alle' },
    { key: 'songs', label: 'Songs' },
    { key: 'tests', label: 'Testläufe' },
  ];

  /** Job, dessen Loeschen im Dialog gerade zur Frage steht. */
  readonly pending = signal<Job | null>(null);
  private readonly confirm =
    viewChild.required<ElementRef<HTMLDialogElement>>('confirm');
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
    this.purgeArmed.set(false);
  }

  /** Schliesst das Menue, sobald der Fokus die Gruppe verlaesst. */
  closeMenu(event: FocusEvent, key: string): void {
    if (this.menu() !== key) return;
    const wrap = event.currentTarget as HTMLElement;
    const next = event.relatedTarget;
    if (next instanceof Node && wrap.contains(next)) return;
    this.menu.set(null);
    this.purgeArmed.set(false);
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
   * Fragt nach, statt zu loeschen. Eine Trennung kostet Minuten und kommt
   * nicht zurueck -- ein Griff von 26 px soll sie nicht im Vorbeiklicken
   * ausloesen koennen.
   */
  ask(job: Job, event: Event): void {
    const griff = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const schild = this.confirm().nativeElement;
    // Rechts buendig mit dem Griff, sechs Pixel darueber. Von rechts und
    // unten gemessen, damit die Breite des Schildes keine Rolle spielt --
    // sie steht erst fest, wenn es schon sichtbar ist.
    schild.style.setProperty('--kill-right', `${window.innerWidth - griff.right}px`);
    schild.style.setProperty('--kill-bottom', `${window.innerHeight - griff.top + 6}px`);
    this.pending.set(job);
    schild.showModal();
  }

  /** Der zweite Schritt: hier faellt die Entscheidung. */
  async remove(job: Job): Promise<void> {
    // Erst zu, dann loeschen: schliesst der Dialog spaeter, steht er
    // kurz ueber einer Liste, in der die Zeile schon fehlt.
    this.confirm().nativeElement.close();
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
