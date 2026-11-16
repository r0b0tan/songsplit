/**
 * Woraufhin gerechnet wird — als Angaben, die mehrere Stellen zeigen.
 *
 * Die Importkarte braucht davon die **kurze** Fassung: zwei Zeilen je
 * Trennort, gerade genug, um sich zu entscheiden. Das Fenster der
 * laufenden Trennung braucht die **lange**: dort steht man ohnehin und
 * wartet, dort stoeren fuenf Zeilen Technik niemanden.
 *
 * Beide Fassungen kommen aus derselben Quelle. Stuenden sie an zwei
 * Stellen im Code, waere die eine irgendwann aktuell und die andere nicht
 * — und es gaebe keinen Weg, das zu bemerken.
 */
import { Injectable, inject } from '@angular/core';

import { CloudSeparator } from '../separate/cloud-separator';
import { DeviceSeparator } from '../separate/device-separator';
import { adapterLabel } from '../separate/runtime';
import { ApiService } from './api.service';
import type { Site } from './jobs.service';

export interface Fact {
  label: string;
  value: string;
}

/** Die zwei Zeilen unter dem Namen eines Trennorts. */
export interface Summary {
  /** Wie gerechnet wird: WebGPU, CUDA, Prozessor. */
  method: string;
  /** Womit: Grafikadapter oder Grafikkarte. */
  device: string;
}

@Injectable({ providedIn: 'root' })
export class DeviceFacts {
  private readonly api = inject(ApiService);
  private readonly browser = inject(DeviceSeparator);
  private readonly cloud = inject(CloudSeparator);

  summary(site: Site): Summary {
    if (site === 'device') return this.browserSummary();
    if (site === 'cloud') return this.cloudSummary();
    return this.serverSummary();
  }

  rows(site: Site): Fact[] {
    if (site === 'device') return this.browserRows();
    if (site === 'cloud') return this.cloudRows();
    return this.serverRows();
  }

  private browserSummary(): Summary {
    const support = this.browser.support();
    if (!support) return { method: 'wird geprüft', device: '' };
    return {
      method: support.available ? 'WebGPU' : 'Prozessor (WASM)',
      device: adapterLabel(support.adapter),
    };
  }

  private serverSummary(): Summary {
    const device = this.api.health()?.device;
    if (!device) return { method: 'wird geprüft', device: '' };
    return {
      method: device.effective.toUpperCase(),
      device: device.gpu_name ?? 'Prozessor dieses Rechners',
    };
  }

  /**
   * Die zwei Zeilen in der Auswahl.
   *
   * Die Karte steht hier **nicht**, und das ist kein Vergessen: welche es
   * wird, entscheidet sich erst beim Start des Containers — der Endpunkt
   * fragt eine Liste an und nimmt die nächste freie. Eine Karte vorher zu
   * nennen hieße, sie zu raten.
   *
   * Was stattdessen dasteht, ist die Angabe, die für die Entscheidung
   * zählt: wohin die Datei geht.
   */
  private cloudSummary(): Summary {
    return {
      method: this.cloud.where() || 'unser Server',
      device: 'Grafikkarte wird zugeteilt',
    };
  }

  /**
   * Die lange Fassung, im Fenster der laufenden Trennung.
   *
   * Die wichtigste Zeile darin ist „Modell": sie beantwortet die Frage,
   * die sonst offenbliebe — ob man sich mit dem Serverweg ein schlechteres
   * Ergebnis einhandelt. Tut man nicht, es ist derselbe Graph und dieselbe
   * Laufzeitfassung wie im Browser, und das ist gemessen.
   */
  private cloudRows(): Fact[] {
    const run = this.cloud.run();
    const rows: Fact[] = [
      { label: 'Ort', value: this.cloud.where() || 'unbekannt' },
      {
        label: 'Grafikkarte',
        value: run?.karte || 'wird zugeteilt',
      },
      { label: 'Modell', value: 'htdemucs — dasselbe wie auf dem Gerät' },
      { label: 'Spuren', value: 'MP3, 192 kbit/s' },
      {
        label: 'Aufbewahrung',
        value:
          `Spuren ${this.cloud.keepHours()} Stunden · beim Anbieter bis zu ` +
          `${this.cloud.providerKeepDays()} Tage`,
      },
      { label: 'Daten', value: 'die Datei hat dieses Gerät verlassen' },
    ];
    return rows;
  }

  private browserRows(): Fact[] {
    const support = this.browser.support();
    if (!support) return [{ label: 'Gerät', value: 'wird geprüft' }];
    const rows: Fact[] = [
      { label: 'Rechnet auf', value: support.available ? 'WebGPU' : 'Prozessor (WASM)' },
      { label: 'Adapter', value: adapterLabel(support.adapter) },
    ];
    const version = this.browser.runtimeVersion();
    if (version) rows.push({ label: 'ONNX Runtime', value: version });
    const cached = this.browser.cachedModelBytes();
    if (cached > 0) {
      rows.push({ label: 'Modelle im Cache', value: `${megabytes(cached)} MB` });
    }
    rows.push({ label: 'Daten', value: 'verlassen das Gerät nicht' });
    return rows;
  }

  private serverRows(): Fact[] {
    const device = this.api.health()?.device;
    if (!device) return [{ label: 'Backend', value: 'Verbindung wird geprüft' }];
    const rows: Fact[] = [
      { label: 'Rechnet auf', value: device.effective.toUpperCase() },
      { label: 'Gerät', value: device.gpu_name ?? 'Prozessor dieses Rechners' },
    ];
    if (device.vram_total_gib) {
      rows.push({
        label: 'Grafikspeicher',
        value: `${device.vram_free_gib} von ${device.vram_total_gib} GB frei`,
      });
    }
    if (device.torch_version) rows.push({ label: 'PyTorch', value: device.torch_version });
    if (device.cuda_runtime) rows.push({ label: 'CUDA', value: device.cuda_runtime });
    rows.push({ label: 'Daten', value: 'nur lokal' });
    return rows;
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1e6);
}
