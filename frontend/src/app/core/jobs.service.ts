/**
 * Ein Verlauf für beide Trennorte.
 *
 * Der Verlauf soll nicht zweimal dastehen, einmal für das Backend und
 * einmal für den Browser. Es ist derselbe Song, es sind dieselben Spuren,
 * und wer gestern lokal getrennt hat und heute auf dem Gerät, will eine
 * Liste sehen. Dieser Dienst legt beide Quellen zusammen und schickt jede
 * Handlung — löschen, aufräumen — an die Stelle, die sie ausführen kann.
 *
 * Die Reihenfolge ist die Zeit, jüngster Job oben. Dass einer vom Server
 * kommt und einer vom Gerät, steht am Job (`site`) und wird in der Zeile
 * gezeigt; sortiert wird danach nicht.
 */
import { Injectable, computed, inject } from '@angular/core';

import { CloudSeparator } from '../separate/cloud-separator';
import { DeviceSeparator } from '../separate/device-separator';
import { StemStore } from '../separate/stem-store';
import { ApiService } from './api.service';
import { I18n } from '../i18n/i18n';
import type { Job, ModelInfo } from './models';
import { VARIANT } from './variant';

/** Woher die Oberfläche einen Job rechnen lässt. */
export type Site = 'device' | 'backend' | 'cloud';

@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly api = inject(ApiService);
  private readonly device = inject(DeviceSeparator);
  private readonly cloud = inject(CloudSeparator);
  private readonly store = inject(StemStore);
  private readonly i18n = inject(I18n);

  /** Gibt es überhaupt eine Wahl, oder nur „Auf diesem Gerät"? */
  readonly serverAvailable = VARIANT.backend;

  /**
   * Steht der Serverweg zur Verfügung?
   *
   * Nur ob er **eingerichtet** ist — nicht, ob er angeboten werden soll.
   * Das entscheidet die Fähigkeitsprüfung am Gerät: wo der Browser selbst
   * rechnen kann, taucht er gar nicht erst auf. Ein PC mit Grafikkarte
   * soll nicht aus Neugier Rechenzeit verbrauchen, die jemand bezahlt.
   */
  readonly cloudAvailable = computed(() => this.cloud.available());

  /**
   * Steht die Antwort auf diese Frage schon fest?
   *
   * Solange `cloud.json` noch geladen wird, ist `cloudAvailable()` falsch,
   * ohne dass das etwas heißt. Wer daraus etwas folgert, folgert es zu
   * früh — siehe `CloudSeparator.checked`.
   */
  readonly cloudChecked = computed(() => this.cloud.checked());

  readonly jobs = computed(() =>
    [...this.device.jobs(), ...this.cloud.jobs(), ...this.api.jobs()].sort(
      (a, b) => b.created_at - a.created_at,
    ),
  );

  /** Modi beider Orte, für die Importkarte. */
  readonly models = computed((): ModelInfo[] => [
    ...this.device.models(),
    ...this.cloud.models(),
    ...this.api.models(),
  ]);

  modelsFor(site: Site): ModelInfo[] {
    return this.models().filter((m) => m.site === site);
  }

  async init(): Promise<void> {
    // Beides gleichzeitig: das Abfragen des Geräts dauert, weil es die
    // Runtime lädt, und das Backend soll darauf nicht warten.
    await Promise.all([this.api.init(), this.device.init(), this.cloud.init()]);
  }

  /**
   * Liegt das Ergebnis dieses Jobs noch zum Öffnen bereit?
   *
   * Beim Backend gilt: ja, die Dateien liegen auf der Platte. Beim
   * Browserpfad hängt es am Budget in `StemStore` — ältere Ergebnisse werden
   * verdrängt, und dann sagt der Verlauf das.
   */
  /**
   * Welches Modell, wie viele Spuren — die Zeile unter dem Dateinamen.
   *
   * Sie steht im Trennfenster und im Deck, und deshalb steht sie hier und
   * nicht zweimal dort. Frueher brachte jeder Erzeuger eines Jobs den Satz
   * fertig mit (`model_label`); gebaut wird er jetzt aus dem technischen
   * Namen und der Spurzahl des Modells, denn beide sind in jeder Sprache
   * dieselben.
   *
   * Faellt das Modell nicht auf — ein alter Job, ein Modus, den es nicht
   * mehr gibt —, bleibt der Satz stehen, den der Job mitbringt. Lieber
   * eine Zeile in der falschen Sprache als eine leere.
   */
  modelLine(job: Job): string {
    const t = this.i18n.t();
    if (job.is_test_path) return t.run.testPath;
    const model = this.models().find((m) => m.name === job.model);
    return model ? t.run.model(job.model, model.stems.length) : job.model_label;
  }

  openable(job: Job): boolean {
    if (job.status !== 'done') return false;
    if (job.site === 'backend') return true;
    return this.store.available().has(job.id);
  }

  /**
   * Warum nicht öffenbar — im Klartext, oder `null`.
   *
   * Gelesen wird über das Signal `available()`, nicht über `has()`: wird ein
   * Ergebnis verdrängt, ändert sich die Jobliste nicht, und die Zeile würde
   * sonst weiter einen Knopf zeigen, der nichts mehr tut.
   */
  unavailableReason(job: Job): string | null {
    if (job.status !== 'done' || job.site === 'backend') return null;
    if (this.store.available().has(job.id)) return null;
    return this.i18n.t().list.gone;
  }

  async remove(job: Job): Promise<void> {
    if (job.site === 'device') {
      this.device.remove(job.id);
      return;
    }
    if (job.site === 'cloud') {
      this.cloud.remove(job.id);
      return;
    }
    await this.api.remove(job.id);
  }

  async removeMany(jobs: readonly Job[]): Promise<string[]> {
    const device = jobs.filter((j) => j.site === 'device');
    for (const job of device) this.device.remove(job.id);
    const cloud = jobs.filter((j) => j.site === 'cloud');
    for (const job of cloud) this.cloud.remove(job.id);
    const server = jobs.filter((j) => j.site === 'backend').map((j) => j.id);
    const gone = server.length ? await this.api.removeMany(server) : [];
    return [...device.map((j) => j.id), ...cloud.map((j) => j.id), ...gone];
  }

  /**
   * Räumt alles Abgeschlossene weg, an beiden Orten.
   *
   * Was läuft oder wartet, bleibt stehen — beim Backend, weil der Worker
   * minutenlang in genau dieses Verzeichnis schreibt, und beim Gerät, weil
   * ein laufender Job seine Puffer noch braucht.
   */
  async removeFinished(): Promise<{ deleted: string[]; kept: number }> {
    const onDevice = [...this.device.removeFinished(), ...this.cloud.removeFinished()];
    const keptOnDevice = this.device.jobs().length + this.cloud.jobs().length;
    if (!this.api.enabled) {
      return { deleted: onDevice, kept: keptOnDevice };
    }
    const server = await this.api.removeFinished();
    return {
      deleted: [...onDevice, ...server.deleted],
      kept: keptOnDevice + server.kept,
    };
  }
}
