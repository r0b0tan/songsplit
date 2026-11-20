import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { Texte } from '../i18n/de';
import { I18n } from '../i18n/i18n';
import type { Health, Job, ModelInfo, ServerJob } from './models';
import { VARIANT } from './variant';

/** Schnelleres Nachfragen, solange etwas laeuft. */
const POLL_BUSY_MS = 1200;
const POLL_IDLE_MS = 5000;

/**
 * Ergaenzt, was die Antwort des Backends nicht mitbringt.
 *
 * `site` und `progress_of` sind Felder des Browserpfads; am Backendjob
 * stehen sie fest. Sie hier zu setzen heisst, dass der Verlauf beide Arten
 * ohne Sonderfall behandeln kann.
 */
function fromServer(job: ServerJob): Job {
  return {
    ...job,
    site: 'backend',
    // Das Backend schreibt seine Phase als fertigen Satz — in der Sprache,
    // in der es geschrieben ist. Der Rest der Anwendung rechnet mit einem
    // Befund; hier wird der Satz zu einem, den die Oberflaeche unveraendert
    // durchreicht. Das ist die eine Stelle, an der das noetig ist.
    stage: job.stage === null ? null : { key: 'text', text: job.stage },
    error: job.error === null ? null : { key: 'text', text: job.error },
    progress_of: job.progress === null ? null : 'blöcke',
    // Das Backend liefert die Restzeit mit, sobald es sie messen kann;
    // fehlt das Feld (aeltere Fassung), bleibt es bei `null`.
    remaining_seconds: job.remaining_seconds ?? null,
  };
}

function modelFromServer(model: ModelInfo): ModelInfo {
  return { ...model, site: 'backend' };
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly i18n = inject(I18n);

  readonly jobs = signal<Job[]>([]);
  readonly models = signal<ModelInfo[]>([]);
  readonly health = signal<Health | null>(null);
  readonly connectionError = signal<string | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * In der oeffentlichen Variante gibt es kein Backend.
   *
   * Dann wird `/api` nie angesprochen: kein Request, der ins Leere laeuft,
   * und keine Meldung ueber eine fehlende Verbindung, die hier niemand
   * herstellen koennte.
   */
  readonly enabled = VARIANT.backend;

  async init(): Promise<void> {
    if (!this.enabled) return;
    await Promise.all([this.refreshModels(), this.refresh()]);
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const busy = this.jobs().some((j) => j.status === 'queued' || j.status === 'processing');
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  async refresh(): Promise<void> {
    if (!this.enabled) return;
    try {
      const [jobs, health] = await Promise.all([
        firstValueFrom(this.http.get<ServerJob[]>('/api/jobs')),
        firstValueFrom(this.http.get<Health>('/api/health')),
      ]);
      this.jobs.set(jobs.map(fromServer));
      this.health.set(health);
      this.connectionError.set(null);
    } catch (err) {
      this.connectionError.set(describeHttp(err, this.i18n.t()));
    }
  }

  async refreshModels(): Promise<void> {
    if (!this.enabled) return;
    try {
      const models = await firstValueFrom(this.http.get<ModelInfo[]>('/api/models'));
      this.models.set(models.map(modelFromServer));
    } catch (err) {
      this.connectionError.set(describeHttp(err, this.i18n.t()));
    }
  }

  async upload(file: File, model: string): Promise<Job> {
    const body = new FormData();
    body.append('file', file, file.name);
    body.append('model', model);
    const job = await firstValueFrom(this.http.post<ServerJob>('/api/jobs', body));
    await this.refresh();
    this.schedule();
    return fromServer(job);
  }

  async createTestJob(): Promise<Job> {
    const job = await firstValueFrom(
      this.http.post<ServerJob>('/api/jobs/test-signals', {}),
    );
    await this.refresh();
    return fromServer(job);
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/jobs/${id}`));
    await this.refresh();
  }

  /**
   * Loescht eine Auswahl von Jobs, nacheinander und mit einer einzigen
   * Abfrage danach: zwanzig Loeschungen sollen nicht zwanzig Mal die
   * ganze Liste nachladen.
   */
  async removeMany(ids: readonly string[]): Promise<string[]> {
    const gone: string[] = [];
    for (const id of ids) {
      try {
        await firstValueFrom(this.http.delete(`/api/jobs/${id}`));
        gone.push(id);
      } catch {
        // Ein Job, den es schon nicht mehr gibt, ist kein Grund
        // aufzuhoeren — der naechste soll trotzdem weg.
      }
    }
    await this.refresh();
    return gone;
  }

  /**
   * Raeumt alle abgeschlossenen Jobs weg. Was laeuft oder wartet, bleibt
   * stehen — das Backend schuetzt das Verzeichnis, in das der Worker
   * gerade schreibt. Gemeldet wird, wie viele behalten wurden.
   */
  async removeFinished(): Promise<{ deleted: string[]; kept: number }> {
    const result = await firstValueFrom(
      this.http.delete<{ deleted: string[]; kept: number }>('/api/jobs'),
    );
    await this.refresh();
    return result;
  }
}

/**
 * Was schiefging, in einem Satz.
 *
 * Nimmt das Woerterbuch als Argument statt den Dienst zu holen: diese
 * Funktion steht ausserhalb jeder Klasse und wird aus Komponenten gerufen,
 * die `t()` ohnehin zur Hand haben. Ein `inject` hier hinge an einem
 * Injektionskontext, den der Aufrufer nicht immer hat.
 */
export function describeHttp(err: unknown, texte: Texte): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return texte.shell.noBackend;
    }
    const detail = (err.error as { detail?: string } | null)?.detail;
    return detail ?? `${err.status} ${err.statusText}`;
  }
  return err instanceof Error ? err.message : String(err);
}
