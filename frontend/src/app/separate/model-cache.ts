/**
 * Haelt die Modellgewichte im Browser-Cache.
 *
 * Der Export ist 174 MB. Ihn bei jedem Besuch neu zu holen waere nicht nur
 * langsam, es waere auch der einzige Grund, aus dem die oeffentliche
 * Variante dauerhaft ein Netz braeuchte. Einmal geholt, liegt er in der
 * Cache-API und die Trennung laeuft danach auch offline.
 *
 * Gecacht werden **nur** Modellgewichte, und sie stehen unter einem Namen,
 * der die Fassung enthaelt. Audiodaten und Dateinamen kommen hier nicht
 * vorbei — die bleiben im Arbeitsspeicher der Sitzung, siehe
 * `stem-store.ts`.
 */

import { AppError } from '../core/trouble';

const CACHE_NAME = 'mixapart-modelle-v1';

export interface DownloadProgress {
  loaded: number;
  total: number;
  /** Kam die Datei aus dem Cache? Dann gab es keinen Download. */
  fromCache: boolean;
}

/**
 * Holt eine kleine Datei und legt sie mit in den Cache.
 *
 * Für das `manifest.json`. Es ist knapp ein Kilobyte, aber ohne es beginnt
 * keine Trennung — und wenn es über das Netz kommen muss, hilft es nicht,
 * dass die 174 MB Gewichte daneben längst im Cache liegen: bei
 * abgeschaltetem Netz scheiterte der Job an der kleinsten Datei. Deshalb
 * geht sie denselben Weg wie die Gewichte.
 *
 * `usable` entscheidet, ob ein gecachter Eintrag noch zu diesem Programm
 * passt. Das ist nicht Vorsicht um ihrer selbst willen: das `manifest.json`
 * hat seine Form schon geändert (beim Zerlegen der Gewichte kam `weights`
 * hinzu), und ein Eintrag von vorher blieb liegen, weil der Cache-Name
 * derselbe war. Ein Eintrag, mit dem der Aufrufer nicht arbeiten kann, wird
 * behandelt wie ein beschädigter: verworfen und über das Netz ersetzt.
 * Sonst hängt eine alte Beschreibung im Browser fest, die niemand löschen
 * kann, ohne die Entwicklerwerkzeuge zu kennen.
 */
export async function fetchCachedJson<T>(
  url: string,
  usable?: (value: T) => boolean,
): Promise<T | null> {
  const cache = 'caches' in globalThis ? await openCache() : null;
  const hit = await cache?.match(url);
  if (hit) {
    try {
      const value = (await hit.json()) as T;
      if (!usable || usable(value)) return value;
      // Veraltete Form: weg damit, sonst liefert der Cache sie ewig weiter.
      await cache?.delete(url);
    } catch {
      // Beschädigter Eintrag: einmal über das Netz versuchen.
      await cache?.delete(url);
    }
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    const value = JSON.parse(text) as T;
    if (usable && !usable(value)) {
      // Auch über das Netz kam nichts Brauchbares. Nicht cachen — sonst
      // steckt der Fehler beim nächsten Start wieder fest.
      return null;
    }
    if (cache) {
      try {
        await cache.put(
          url,
          new Response(text, { headers: { 'content-type': 'application/json' } }),
        );
      } catch {
        // Kein Platz: es läuft trotzdem, nur eben nicht offline.
      }
    }
    return value;
  } catch {
    return null;
  }
}

/** Steht die Datei schon im Cache? Beantwortet die Frage ohne sie zu laden. */
export async function isCached(url: string): Promise<boolean> {
  if (!('caches' in globalThis)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Holt die Gewichte und setzt sie im Arbeitsspeicher zusammen.
 *
 * Die Gewichte liegen in Stücken zu 20 MB, weil 174 MB auf keinen
 * kostenlosen Statik-Hoster passen (GitHub blockt über 100 MB, Cloudflare
 * Pages nimmt 25 MiB je Datei). Für die Laufzeit ändert das nichts — sie
 * bekommt denselben Puffer wie zuvor.
 *
 * Der Zielpuffer wird **vorab in voller Größe** angelegt und jedes Stück
 * direkt hineingeschrieben. Die Stücke erst zu sammeln und dann zu
 * verketten wäre einfacher zu schreiben und hätte die 174 MB kurzzeitig
 * doppelt im Speicher — bei einem Gerät, auf dem es ohnehin knapp ist, ist
 * das der Unterschied zwischen läuft und läuft nicht.
 *
 * Gecacht wird das **zusammengesetzte** Ganze unter `cacheKey`: einmal
 * zusammensetzen, danach einmal lesen statt neunmal.
 */
export async function fetchWeights(
  urls: readonly string[],
  cacheKey: string,
  expectedBytes: number,
  expectedSha256: string | null,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const cache = 'caches' in globalThis ? await openCache() : null;

  const hit = await cache?.match(cacheKey);
  if (hit) {
    const buffer = await hit.arrayBuffer();
    if (buffer.byteLength === expectedBytes) {
      onProgress({ loaded: buffer.byteLength, total: buffer.byteLength, fromCache: true });
      return buffer;
    }
    // Ein angefangener oder beschaedigter Eintrag: lieber neu holen als
    // der Laufzeit halbe Gewichte geben.
    await cache?.delete(cacheKey);
  }

  const buffer = new ArrayBuffer(expectedBytes);
  const view = new Uint8Array(buffer);
  let loaded = 0;
  onProgress({ loaded: 0, total: expectedBytes, fromCache: false });

  for (const url of urls) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new AppError({ key: 'modell-http', status: response.status, url });
    }
    if (!response.body) {
      // Ohne lesbaren Strom (manche Proxys) gibt es je Stueck nur ein
      // Ergebnis statt laufender Werte. Erfunden wird nichts.
      const part = new Uint8Array(await response.arrayBuffer());
      view.set(part, loaded);
      loaded += part.byteLength;
      onProgress({ loaded, total: expectedBytes, fromCache: false });
      continue;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.byteLength > expectedBytes) {
        throw new AppError({ key: 'modell-zu-gross' });
      }
      view.set(value, loaded);
      loaded += value.byteLength;
      onProgress({ loaded, total: expectedBytes, fromCache: false });
    }
  }

  if (loaded !== expectedBytes) {
    throw new AppError({
      key: 'modell-unvollstaendig',
      loaded,
      total: expectedBytes,
    });
  }
  await verify(buffer, expectedSha256);
  await put(cache, cacheKey, buffer, 'application/octet-stream');
  return buffer;
}

/**
 * Prüft die Prüfsumme des zusammengesetzten Ganzen.
 *
 * Ein Stück, das als HTML-Fehlerseite ankommt, oder eine Reihenfolge, die
 * durcheinandergeraten ist, ergäbe sonst eine Laufzeit, die mit einer
 * unverständlichen Meldung abbricht — oder, schlimmer, eine Trennung, die
 * durchläuft und Unsinn liefert.
 */
async function verify(buffer: ArrayBuffer, expected: string | null): Promise<void> {
  if (!expected) return;
  // Fehlt `crypto.subtle`, wird **nicht** geladen.
  //
  // Vorher stand hier ein stilles `return`, und das war die falsche
  // Richtung: `crypto.subtle` fehlt genau dann, wenn die Seite in keinem
  // sicheren Kontext läuft — also über reines `http://`. Das ist der eine
  // Fall, in dem unterwegs jemand an den 174 MB Gewichten gedreht haben
  // könnte, und ausgerechnet dort hätte niemand nachgesehen. Die Prüfung
  // auszulassen, wo sie am meisten trägt, ist schlimmer als gar keine.
  //
  // Es kostet auch nichts: WebGPU gibt es im unsicheren Kontext ohnehin
  // nicht, und die Tests liefern über `http://127.0.0.1` aus — localhost
  // gilt als sicher, `crypto.subtle` ist dort da.
  if (!globalThis.crypto?.subtle) {
    throw new AppError({ key: 'keine-pruefsummen' });
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const got = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (got !== expected) {
    throw new AppError({ key: 'pruefsumme-falsch' });
  }
}

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    // Im privaten Fenster oder bei gesperrtem Speicher gibt es keinen Cache.
    // Das Modell wird dann jedes Mal geholt — langsamer, aber es laeuft.
    return null;
  }
}

async function put(
  cache: Cache | null,
  url: string,
  buffer: ArrayBuffer,
  contentType: string | null,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(
      url,
      new Response(buffer, {
        headers: {
          'content-type': contentType ?? 'application/octet-stream',
          'content-length': String(buffer.byteLength),
        },
      }),
    );
  } catch {
    // Kein Platz im Cache: das Modell liegt im Arbeitsspeicher und der Job
    // laeuft. Nur der naechste Besuch holt es wieder.
  }
}

/** Raeumt alle gecachten Modelle weg. Fuer die Oberflaeche und Messungen. */
export async function clearCache(): Promise<void> {
  if (!('caches' in globalThis)) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // Nichts zu tun.
  }
}

/** Wie viel Platz die gecachten Modelle belegen. */
export async function cachedBytes(): Promise<number> {
  if (!('caches' in globalThis)) return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let sum = 0;
    for (const key of keys) {
      const hit = await cache.match(key);
      const length = Number(hit?.headers.get('content-length') ?? 0);
      sum += length;
    }
    return sum;
  } catch {
    return 0;
  }
}
