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
import { I18n } from '../i18n/i18n';
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
  private readonly i18n = inject(I18n);

  /**
   * Die Benennungen und die wenigen Worte unter den Messwerten.
   *
   * Als Eigenschaft und nicht je Methode geholt: jede Zeile unten liest
   * sie, und `t()` ist ein Signal — beim Umschalten rechnet jede
   * Fassung, die diese Zeilen anzeigt, neu.
   */
  private get f() {
    return this.i18n.t().facts;
  }

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
    if (!support) return { method: this.f.checking, device: '' };
    return {
      method: support.available ? 'WebGPU' : this.f.cpu,
      device: adapterLabel(support.adapter),
    };
  }

  private serverSummary(): Summary {
    const device = this.api.health()?.device;
    if (!device) return { method: this.f.checking, device: '' };
    return {
      method: device.effective.toUpperCase(),
      device: device.gpu_name ?? this.f.localCpu,
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
    // Hier steht der Ort und nicht die Karte: welche es wird, entscheidet
    // sich erst beim Start des Containers, und raten waere das Gegenteil
    // einer Auskunft. Der Ort dagegen steht fest — und er ist ohnehin das,
    // was an diesem Weg zaehlt.
    return {
      method: this.f.server,
      device: this.anbieter(),
    };
  }

  /**
   * Wer rechnet, in einer Zeile.
   *
   * `cloud.json` traegt die lange Fassung („Modal Labs, USA — Standort
   * nicht festgelegt"), und die ist dort richtig aufgehoben: sie steht in
   * der Datenschutzerklaerung und begruendet, warum kein Rechenzentrum
   * genannt wird. In der Anzeige richtet sie Schaden an — auf einem Handy
   * bricht sie ueber drei Zeilen und draengt die Angaben auseinander, auf
   * die es waehrend des Wartens ankommt.
   *
   * Genannt wird deshalb der Anbieter, und der steht vor dem
   * Gedankenstrich. „Ort" stand frueher an der Zeile und versprach mehr,
   * als dasteht: einen Standort gibt es nicht, der Anbieter schon.
   */
  private anbieter(): string {
    const voll = this.cloud.where();
    const kurz = voll.split('—')[0].trim();
    return kurz || 'Modal Labs, USA';
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
    // Vier Zeilen, jede kurz genug fuer eine Handybreite. Aufbewahrung
    // und Datenabfluss standen hier auch — beides steht in der
    // Datenschutzerklaerung und, was den Abfluss angeht, vor dem Klick in
    // der Importkarte. Wer hier liest, hat laengst zugestimmt und wartet;
    // ihm dieselben Saetze ein drittes Mal hinzustellen, macht die
    // Angaben nicht ehrlicher, nur unleserlicher.
    return [
      { label: this.f.provider, value: this.anbieter() },
      { label: this.f.gpu, value: run?.karte || this.f.assigning },
      { label: this.f.model, value: 'htdemucs' },
      { label: this.f.stems, value: 'MP3, 192 kbit/s' },
    ];
  }

  private browserRows(): Fact[] {
    const support = this.browser.support();
    if (!support) return [{ label: this.f.device, value: this.f.checking }];
    const rows: Fact[] = [
      { label: this.f.runsOn, value: support.available ? 'WebGPU' : this.f.cpu },
      { label: this.f.adapter, value: adapterLabel(support.adapter) },
    ];
    const version = this.browser.runtimeVersion();
    if (version) rows.push({ label: 'ONNX Runtime', value: version });
    const cached = this.browser.cachedModelBytes();
    if (cached > 0) {
      rows.push({ label: this.f.cachedModels, value: `${megabytes(cached)} MB` });
    }
    // „Daten verlassen das Geraet nicht" stand hier auch. Es war eine
    // Zusicherung zwischen lauter Messwerten -- Laufzeit, Adapter,
    // Cachegroesse --, und zwischen denen las sie sich wie Werbung. Die
    // Aussage selbst bleibt richtig und steht, wo man sie sucht: in den
    // FAQ und in der Datenschutzerklaerung.
    return rows;
  }

  private serverRows(): Fact[] {
    const device = this.api.health()?.device;
    if (!device) return [{ label: this.f.backend, value: this.f.connecting }];
    const rows: Fact[] = [
      { label: this.f.runsOn, value: device.effective.toUpperCase() },
      { label: this.f.device, value: device.gpu_name ?? this.f.localCpu },
    ];
    if (device.vram_total_gib) {
      rows.push({
        label: this.f.vram,
        value: this.f.vramFree(device.vram_free_gib, device.vram_total_gib),
      });
    }
    if (device.torch_version) rows.push({ label: 'PyTorch', value: device.torch_version });
    if (device.cuda_runtime) rows.push({ label: 'CUDA', value: device.cuda_runtime });
    rows.push({ label: this.f.data, value: this.f.localOnly });
    return rows;
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1e6);
}
