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

  summary(site: Site): Summary {
    return site === 'device' ? this.browserSummary() : this.serverSummary();
  }

  rows(site: Site): Fact[] {
    return site === 'device' ? this.browserRows() : this.serverRows();
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
