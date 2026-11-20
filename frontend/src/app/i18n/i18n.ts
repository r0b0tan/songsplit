/**
 * Welche Sprache die Oberflaeche spricht.
 *
 * Ein Signal und ein daraus abgeleitetes Woerterbuch, mehr ist es nicht.
 * Komponenten lesen `t()` im Template; weil das ein Signal-Lesen innerhalb
 * des Template-Ausdrucks ist, merkt sich Angular die Abhaengigkeit und
 * zeichnet beim Umschalten genau die Views neu, die Text enthalten — auch
 * unter `OnPush` und ohne `markForCheck()`. Das ist der Grund fuer diesen
 * Weg und gegen `@angular/localize`: das baut ein Bundle je Sprache, und
 * umschalten heisst dort, die Seite unter einer anderen Adresse neu zu
 * laden. Ein Umschalter in der Kopfleiste soll sofort greifen.
 *
 * Beide Woerterbuecher liegen im Bundle. Zusammen sind sie einige Kilobyte
 * — ein zweiter Netzabruf beim Umschalten waere teurer als ihr Platz, und
 * nachzuladende Texte blitzten beim Start unuebersetzt auf.
 */
import { Injectable, computed, effect, signal } from '@angular/core';

import type { JobStage, JobStatus } from '../core/models';
import { stemSlug } from '../core/stem-labels';
import type { GpuReason } from '../separate/runtime';
import { DE, type Texte } from './de';
import { EN } from './en';

export type Lang = 'en' | 'de';

/** Wo die Wahl liegt, wenn der Browser sie behalten darf. */
const STORAGE_KEY = 'mixapart.lang';

/**
 * Darf die Spracheinstellung des Browsers entscheiden?
 *
 * Steht hier `false`, kommt jeder zuerst auf Englisch und stellt selbst um.
 * Mit `true` bekommt ein deutsch eingestellter Browser Deutsch, alle
 * anderen Englisch — und die ausdrueckliche Wahl schlaegt beides.
 */
const FOLLOW_BROWSER = true;

/**
 * Nachschlagen mit einem Schluessel, den erst die Laufzeit kennt.
 *
 * Die beiden Tabellen stehen im Woerterbuch als gewoehnliche Objekte und
 * **nicht** als `Record<string, string>`. Das ist der Unterschied zwischen
 * „en.ts muss dieselben Spuren kennen" und „fehlt halt eine". Ein Slug aus
 * einem Dateinamen ist dafuer keine bekannte Eigenschaft, und genau diese
 * eine Stelle weitet den Typ — einmal, benannt, mit `undefined` als
 * moeglichem Ergebnis, statt es dem Woerterbuch abzugewoehnen.
 */
function nachschlagen(tabelle: Record<string, string>, key: string): string | undefined {
  return (tabelle as Record<string, string | undefined>)[key];
}

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'de';
}

/**
 * Die Sprache beim Start, in dieser Reihenfolge:
 *
 * 1. `?lang=de` in der Adresse. Das ist der Weg fuer die Tests: sie pruefen
 *    deutsche Texte und sollen das weiter tun koennen, ohne vorher am
 *    Speicher des Browsers zu drehen. Gleichzeitig ist es der Link, mit
 *    dem sich eine Sprache verschicken laesst.
 * 2. Die letzte eigene Wahl.
 * 3. Die Spracheinstellung des Browsers, siehe `FOLLOW_BROWSER`.
 * 4. Englisch.
 *
 * Jeder Zugriff ist eingeklammert: `localStorage` wirft im Privatmodus und
 * bei abgeschalteten Seitendaten, und eine Seite, die daran nicht startet,
 * waere an einer Nebensache gescheitert.
 */
function startLang(): Lang {
  try {
    const wished = new URLSearchParams(location.search).get('lang');
    if (isLang(wished)) return wished;
  } catch {
    // Keine lesbare Adresse — dann eben nicht.
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // Kein Speicher: die Wahl gilt dann fuer diese Sitzung.
  }
  if (FOLLOW_BROWSER) {
    const tags = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    for (const tag of tags) {
      // Nur das Sprach-Teilstueck zaehlt: `de-AT` ist deutsch, `en-GB`
      // englisch, und `de` steckt auch in `gsw-de` nicht als Sprache.
      const base = tag.toLowerCase().split('-')[0];
      if (base === 'de') return 'de';
      if (base === 'en') return 'en';
    }
  }
  return 'en';
}

@Injectable({ providedIn: 'root' })
export class I18n {
  /** Die gewaehlte Sprache. Schreiben heisst umschalten. */
  readonly lang = signal<Lang>(startLang());

  /**
   * Das Woerterbuch der gewaehlten Sprache.
   *
   * Ein `computed`, damit ein Template-Ausdruck ein Signal liest und nicht
   * drei: `t().card.foot.start` haengt an der Sprache, nicht an jedem Text
   * einzeln.
   */
  readonly t = computed<Texte>(() => (this.lang() === 'de' ? DE : EN));

  /**
   * Der Anzeigename einer Spur.
   *
   * Herein kommt, was Backend, Browserpfad oder Serverweg geliefert haben
   * — ein deutscher Name oder, bei einer Spur ohne festen Platz, ein
   * Dateiname. Kennt die Tabelle ihn, steht hier die uebersetzte Fassung;
   * kennt sie ihn nicht, bleibt er, wie er kam. Eine Spur, die
   * „Yeah Yeah Yeahs (Bass)" heisst, hat keine englische Fassung, und eine
   * erfundene waere schlimmer als der Name selbst.
   *
   * Liest `t()`, ist also im Template so verwendbar wie jeder andere Text:
   * beim Umschalten wechselt die Spurleiste mit.
   */
  stem(name: string): string {
    const slug = stemSlug(name);
    return (slug && nachschlagen(this.t().stems, slug)) || name;
  }

  /**
   * Der Anzeigename eines Trennmodus.
   *
   * Der Kurzname selbst ist die Kennung — siehe `modes` im Woerterbuch.
   * Ein Modus, den die Tabelle nicht kennt, steht unter seiner Kennung da;
   * so faellt ein neuer Modus im Backend auf, statt leer zu bleiben.
   */
  mode(name: string): string {
    return nachschlagen(this.t().modes, name) || name;
  }

  /**
   * Der Satz zu einem Befund der Geraetepruefung.
   *
   * Der Worker meldet, **was** er gefunden hat (`GpuReason`), diese
   * Methode macht daraus einen Satz in der geltenden Sprache. Eine
   * `switch`-Verzweigung und kein Nachschlagen in einer Tabelle: jeder
   * Fall bringt eigene Angaben mit, und der Compiler prueft hier, dass
   * keiner vergessen ist — kommt in `GpuReason` einer dazu, faellt es
   * beim Bauen auf und nicht an einem leeren Absatz.
   */
  gpuReason(reason: GpuReason | null): string | null {
    if (!reason) return null;
    const gpu = this.t().gpu;
    switch (reason.key) {
      case 'kein-webgpu':
        return gpu.noWebgpu(reason.mobile);
      case 'nicht-zu-oeffnen':
        return gpu.cantOpen(reason.detail);
      case 'kein-adapter':
        return gpu.noAdapter(reason.mobile, reason.renderer, reason.rendererSoftware);
      case 'software':
        return gpu.software(reason.adapter);
      case 'pruefung-abgebrochen':
        return gpu.probeFailed(reason.detail);
      case 'runtime-schweigt':
        return gpu.runtimeSilent;
    }
  }

  /**
   * Was gerade geschieht, in einem Satz.
   *
   * Wie `gpuReason`: ein `switch`, damit der Compiler eine neue Phase
   * anmahnt. Der Fall `text` ist die Durchreiche fuer das Python-Backend,
   * dessen Phasen schon als Satz ankommen — in der Sprache, in der es
   * geschrieben ist, und nicht in der, die hier gilt.
   */
  stage(stage: JobStage | null): string | null {
    if (!stage) return null;
    const t = this.t().stages;
    switch (stage.key) {
      case 'modell-mb':
        return t.modellMb(stage.loaded, stage.total);
      case 'block':
        return t.block(stage.done, stage.total);
      case 'spuren':
        return t.spuren(stage.done, stage.total);
      case 'text':
        return stage.text;
      default:
        return t[stage.key];
    }
  }

  /** Der Zustand eines Jobs, wo keine Phase dasteht. */
  status(status: JobStatus): string {
    return this.t().status[status];
  }

  constructor() {
    effect(() => {
      const lang = this.lang();
      // `<html lang>` ist keine Zierde: daran entscheidet die
      // Vorlesestimme ihre Aussprache und der Browser seine Trennregeln.
      document.documentElement.lang = lang;
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch {
        // Siehe `startLang`: ohne Speicher gilt die Wahl fuer diese Sitzung.
      }
    });
  }
}
