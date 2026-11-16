/**
 * Sagt beim Start, wenn auf diesem Geraet nicht zu trennen ist.
 *
 * Vorher stand das als Zeile in der Importkarte, zwischen Dateiwahl und
 * Trennmodi. Auf einem Handy war es damit unterhalb des ersten Bildschirms
 * — man waehlte eine Datei, tippte auf „Trennen" und erfuhr erst danach,
 * dass das hier nichts wird. Die Auskunft kommt jetzt vor dem ersten
 * Handgriff, weil sie den ersten Handgriff betrifft.
 *
 * **Keine Warnoptik.** Das Gelb der `.notice` sagt „pass auf, du machst
 * gleich etwas falsch" — hier macht niemand etwas falsch, das Geraet kann
 * es schlicht nicht. Also dieselbe Flaeche, dieselbe Schrift, dieselben
 * Raender wie jede andere Karte der Seite; der Unterschied liegt darin,
 * dass sie vorn steht, nicht darin, dass sie schreit.
 *
 * **Wegklickbar**, und zwar auf jedem Weg, den jemand probiert: Knopf,
 * Escape, Klick daneben. Gesperrt wird nichts — der WASM-Weg bleibt
 * begehbar, er dauert nur. Wer ihn trotzdem gehen will, soll das duerfen,
 * nachdem er weiss, worauf er sich einlaesst.
 *
 * Einmal je Sitzung: wer es weggeklickt hat, hat es gelesen. Gemerkt wird
 * das im Speicher der Seite, nicht im Browser — ein neuer Besuch morgen
 * soll es wieder sagen, denn bis dahin kann sich das Geraet geaendert
 * haben.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { DeviceSeparator } from '../separate/device-separator';
import { JobsService } from '../core/jobs.service';
import { isMobileDevice } from '../separate/platform';

@Component({
  selector: 'app-device-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dlg
      class="device-modal"
      aria-labelledby="device-notice-title"
      (close)="dismiss()"
      (pointerdown)="downOnBackdrop = $event.target === dlg"
      (click)="onClick($event, dlg)"
    >
      <!-- Der Fokus beginnt auf der Flaeche, nicht auf dem Knopf. Sonst
           setzt ihn showModal() auf „Verstanden", und der steht dann mit
           Fokusring da, als haette ihn schon jemand gedrueckt — auf einem
           Handy, wo niemand eine Tastatur hat. Im Dialog bleibt der Fokus
           trotzdem, und vorgelesen wird ueber aria-labelledby die
           Ueberschrift. -->
      <div class="sheet" #sheet tabindex="-1">
        <h2 id="device-notice-title">{{ title() }}</h2>

        <p>{{ lead() }}</p>

        <!-- Wo es stattdessen geht. Grob gehalten und ohne Fassungsnummern:
             wer hier liest, sucht einen Ausweg, keine Systemvoraussetzungen
             — und eine Angabe wie „ab Chrome 121" waere in einem Jahr
             falsch, ohne dass es jemandem auffiele. -->
        @if (!jobs.cloudAvailable()) {
        <p class="where">
          Gut läuft MixApart auf einem Rechner mit Windows, macOS oder Linux
          und einem aktuellen Chrome oder Edge. Auf Smartphones und Tablets
          geben die Browser die Grafikeinheit bisher nur selten frei; die
          Hersteller erweitern das schrittweise, es lohnt sich also, später
          noch einmal vorbeizuschauen.
        </p>
        }

        <!-- Der Code steht fuer sich, gross genug zum Vorlesen. Er ist der
             Grund, warum niemand einen Treiberstring abtippen muss. -->
        @if (device.support()?.code; as code) {
          <div class="code-row">
            <span class="code">{{ code }}</span>
            <button type="button" (click)="copy()">
              {{ copied() ? 'Kopiert' : 'Bericht kopieren' }}
            </button>
          </div>
        }

        <p class="foot">{{ foot() }}</p>

        <div class="actions">
          <button type="button" class="key" (click)="close(dlg)">Verstanden</button>
        </div>
      </div>
    </dialog>
  `,
  styles: [
    `
      /* Derselbe Rahmen wie Deck und Fortschritt: der Dialog traegt nur,
         sichtbar ist die Flaeche darin. */
      .device-modal {
        width: min(460px, calc(100vw - 2 * clamp(8px, 2vw, 26px)));
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
      .device-modal::backdrop {
        background: light-dark(rgb(31 27 36 / 0.42), rgb(6 6 9 / 0.66));
        backdrop-filter: blur(2.5px);
      }
      .device-modal[open] {
        animation: notice-in 0.16s cubic-bezier(0.2, 0, 0.2, 1);
      }
      @keyframes notice-in {
        from {
          opacity: 0;
          transform: translateY(8px) scale(0.995);
        }
      }

      /* Traegt den Startfokus, ist aber keine Bedienstelle — ein Ring um
         die ganze Karte sagte nur aus, was der Rahmen ohnehin zeigt. */
      .sheet:focus {
        outline: none;
      }
      .sheet {
        background: var(--panel);
        border: 1px solid var(--edge);
        border-radius: var(--radius);
        padding: 20px 22px 18px;
        display: flex;
        flex-direction: column;
        gap: 11px;
      }

      h2 {
        margin: 0;
        font-size: 16.5px;
        font-weight: 650;
        letter-spacing: -0.012em;
        color: var(--ink);
      }

      p {
        margin: 0;
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--ink);
      }
      /* Ausweg und Vorbehalt stehen leiser als die Nachricht selbst —
         gelesen werden sie von dem, der nach dem ersten Satz weiterliest. */
      .where,
      .foot {
        color: var(--dim);
        font-size: 12.5px;
      }

      .code-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 9px 11px;
        background: var(--panel-2);
        border: 1px solid var(--edge-soft);
        border-radius: var(--radius-sm);
      }
      .code {
        font: 600 13px/1 var(--mono);
        color: var(--ink);
        letter-spacing: 0.02em;
      }
      .code-row button {
        margin-left: auto;
        font-size: 12.5px;
        min-height: 29px;
        padding: 4px 10px;
      }

      .actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 2px;
      }
    `,
  ],
})
export class DeviceNoticeComponent {
  protected readonly device = inject(DeviceSeparator);
  protected readonly jobs = inject(JobsService);

  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  private readonly sheet = viewChild.required<ElementRef<HTMLElement>>('sheet');

  protected readonly copied = signal(false);
  protected downOnBackdrop = false;

  /** Gelesen heisst gelesen — in dieser Sitzung kein zweites Mal. */
  private dismissed = false;

  private readonly mobile = isMobileDevice();

  constructor() {
    effect(() => {
      const support = this.device.support();
      const dialog = this.dlg().nativeElement;
      // `support()` ist null, solange geprueft wird. Erst danach steht fest,
      // ob es etwas zu sagen gibt.
      if (!support || support.available || this.dismissed) return;
      // Mit Serverpfad ist die Anwendung benutzbar, nur nicht auf diesem
      // Weg. Dann genuegt die Zeile in der Importkarte; ein Fenster ueber
      // allem waere eine Meldung ueber ein Problem, das keines ist.
      if (this.jobs.serverAvailable) return;
      if (!dialog.open) {
        dialog.showModal();
        this.sheet().nativeElement.focus();
      }
    });
  }

  /**
   * Warum es nicht geht — in einem Satz, ohne Fachwort.
   *
   * Der genaue Grund steht weiterhin in der Importkarte, auf der Messseite
   * und im Bericht zum Kopieren. Hier haette er nichts zu suchen: wer
   * dieses Fenster liest, hat die Seite gerade erst geoeffnet und will
   * wissen, ob er bleiben kann, nicht welcher Adapter fehlt.
   */
  /**
   * Die Ueberschrift haengt daran, ob es einen Ausweg gibt.
   *
   * „Nicht unterstuetzt" waere falsch, sobald der Serverweg bereitsteht:
   * benutzbar ist die Anwendung dann sehr wohl, nur nicht auf diesem
   * Rechenweg. Eine Ueberschrift, die mehr behauptet als zutrifft,
   * vertreibt Leute, die bleiben koennten.
   */
  protected title(): string {
    return this.jobs.cloudAvailable()
      ? 'Dieses Gerät kann nicht selbst trennen'
      : 'Leider wird Ihr Gerät momentan nicht unterstützt';
  }

  protected lead(): string {
    return this.mobile
      ? 'MixApart trennt die Spuren direkt hier im Browser und braucht dafür ' +
          'die Grafikeinheit Ihres Geräts. Dieser Browser gibt sie nicht frei — ' +
          'die Musik würde Ihr Gerät nicht verlassen, nur rechnen lässt sich ' +
          'hier nichts.'
      : 'MixApart trennt die Spuren direkt hier im Browser und braucht dafür ' +
          'eine Grafikkarte, auf die der Browser zugreifen darf. Die steht auf ' +
          'diesem Gerät nicht zur Verfügung.';
  }

  /**
   * Dass es trotzdem weitergeht, und was das kostet.
   *
   * Das Fenster laesst sich wegklicken, und danach steht die Oberflaeche da,
   * als waere nichts. Ohne diesen Satz waere der naechste Schritt ein
   * Trennversuch, der auf dem Handy eine Stunde laeuft oder im Speicher
   * endet — und niemand haette es vorher gesagt.
   */
  protected foot(): string {
    // Mit Serverweg ist das die Auskunft, die zaehlt — und sie nennt den
    // Preis gleich mit. Ein Angebot, dessen Haken erst spaeter auftaucht,
    // waere schlechter als keines: die Datei ist dann schon unterwegs.
    if (this.jobs.cloudAvailable()) {
      return (
        'Sie können trotzdem trennen: In der Karte darunter steht „Über ' +
        'unseren Server“ zur Wahl. Dabei wird Ihre Datei hochgeladen und in ' +
        'den USA verarbeitet — was das genau heißt, steht dort zum ' +
        'Aufklappen. Auf diesem Gerät bliebe sonst nur der Prozessor, und ' +
        'der braucht für ein ganzes Lied ein Vielfaches der Zeit.'
      );
    }
    return this.mobile
      ? 'Weiterklicken können Sie trotzdem: dann rechnet der Prozessor. Das ' +
          'dauert bei einem ganzen Lied eher eine Stunde als zehn Minuten, und ' +
          'der Browser kann den Tab vorher wegen Speichermangels beenden.'
      : 'Weiterklicken können Sie trotzdem: dann rechnet der Prozessor. Das ' +
          'dauert bei einem ganzen Lied ein Vielfaches — eher zehn Minuten als ' +
          'eine.';
  }

  protected async copy(): Promise<void> {
    const text = this.device.diagnosis();
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      // Ohne Zwischenablage — aelterer Browser, fehlende Freigabe — bleibt
      // der Weg ueber die Messseite unter #bench, wo dasselbe zum Markieren
      // steht. Der Knopf sagt es, statt still nichts zu tun.
      this.copied.set(false);
      alert(text);
    }
  }

  protected onClick(event: MouseEvent, dialog: HTMLDialogElement): void {
    // Nur wenn Druck und Loslassen beide daneben lagen: ein Zug, der in der
    // Flaeche beginnt und ausserhalb endet, ist kein Klick daneben.
    if (this.downOnBackdrop && event.target === dialog) this.close(dialog);
    this.downOnBackdrop = false;
  }

  protected close(dialog: HTMLDialogElement): void {
    this.dismissed = true;
    if (dialog.open) dialog.close();
  }

  /** Auch Escape und jeder andere Weg nach draussen zaehlen als gelesen. */
  protected dismiss(): void {
    this.dismissed = true;
  }
}
