/**
 * Welche Trennmodi der Browserpfad anbietet.
 *
 * Die Namen und die Reihenfolge der Spuren stehen hier genauso wie in
 * `MODEL_PRESETS` in `backend/app/separation.py` — dieselben Kurznamen
 * („Schnell", „Instrumente"), damit ein Job im Verlauf gleich heisst,
 * gleichgueltig wo er gerechnet wurde. Auch die Reihenfolge der Eintraege
 * folgt der dortigen: zuerst der schnelle Weg, dann aufsteigend nach Zahl
 * der Spuren — die Karten stehen an beiden Orten gleich.
 *
 * Angeboten wird nur, was wirklich ausgeliefert ist: `available()` fragt das
 * `manifest.json` ab. Ein Modus, dessen Export fehlt, erscheint nicht in der
 * Oberflaeche — nicht ausgegraut, sondern gar nicht. Ein Knopf, der
 * verspricht, was die Variante nicht kann, ist schlimmer als ein Knopf, den
 * es nicht gibt.
 */

import type { ModelShape } from './dsp';
import { fetchCachedJson } from './model-cache';

export interface BrowserModel {
  /** Ordner unter `/models/`. */
  id: string;
  /** Name im Backend, fuer den Vergleich der Jobs. */
  name: string;
  /** Kurzname der Karte, wie im Backend. */
  mode: string;
  label: string;
  description: string;
  /** Spuren in der Reihenfolge der Anzeige, nicht der des Modells. */
  display: readonly string[];
  /**
   * Spuren, die nach dem Lauf zu einer zusammenfallen.
   *
   * Kein eigenes Modell und kein eigener Download: das Ergebnis liegt
   * schon vor, es wird nur anders zusammengefasst. Weil die Ausgaben von
   * Demucs sich zum Mix addieren, ist die Summe aus Drums, Bass und Rest
   * genau „Mix ohne Gesang".
   */
  merge?: { into: string; from: readonly string[] };
}

/**
 * Die ausgelieferten Exporte. Jeder Eintrag zeigt auf einen Ordner, den
 * `backend/tools/export_htdemucs_onnx.py` geschrieben hat.
 */
export const BROWSER_MODELS: readonly BrowserModel[] = [
  {
    id: 'htdemucs-op17-fp32',
    name: 'htdemucs',
    mode: 'Schnell',
    label: 'htdemucs — 4 Spuren',
    description: 'Gesang, Drums, Bass und Rest. Der schnellste Weg.',
    display: ['vocals', 'drums', 'bass', 'other'],
  },
  {
    // Dasselbe Modell und dieselbe Kennung wie „Schnell" — deshalb
    // derselbe Eintrag im Cache, kein zweiter Download und keine
    // zusaetzliche Rechenzeit. Nur die Spuren fallen hinterher zusammen.
    id: 'htdemucs-op17-fp32',
    name: 'htdemucs_2s',
    mode: 'Minimum',
    label: 'htdemucs — 2 Spuren',
    description:
      'Gesang und alles andere in einer Spur. Dieselbe Trennung wie ' +
      '„Schnell", nur zusammengefasst — zum Mitspielen oder Mitsingen.',
    display: ['vocals', 'instrumental'],
    merge: { into: 'instrumental', from: ['drums', 'bass', 'other'] },
  },
  {
    id: 'htdemucs_6s-op17-fp32',
    name: 'htdemucs_6s',
    mode: 'Instrumente',
    label: 'htdemucs_6s — 6 Spuren',
    description: 'Zusätzlich Gitarre und Klavier. Langsamer, größeres Modell.',
    display: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
  },
];

/** Ein Stueck der Gewichte. */
export interface WeightPart {
  name: string;
  bytes: number;
  sha256: string;
}

/** Inhalt des `manifest.json`, das der Export schreibt. */
export interface ModelManifest {
  name: string;
  sources: string[];
  sample_rate: number;
  channels: number;
  segment_samples: number;
  nfft: number;
  hop_length: number;
  freq_bins: number;
  frames: number;
  opset: number;
  precision: string;
  /**
   * Die Gewichte, in Stuecken.
   *
   * Aneinandergehaengt ergeben die Stuecke wieder die ONNX-Datei; die
   * Pruefsumme gilt fuer das zusammengesetzte Ganze. Zerlegt sind sie,
   * weil 174 MB auf keinen kostenlosen Statik-Hoster passen — GitHub
   * blockt ueber 100 MB, Cloudflare Pages nimmt 25 MiB je Datei.
   */
  weights: {
    file: string;
    total_bytes: number;
    sha256: string;
    parts: WeightPart[];
  };
  parameters: number;
  license: string;
  checkpoint: { file: string; sha256: string };
}

export function shapeOf(m: ModelManifest): ModelShape {
  return {
    sources: m.sources,
    sampleRate: m.sample_rate,
    channels: m.channels,
    segment: m.segment_samples,
    nfft: m.nfft,
    hopLength: m.hop_length,
    freqBins: m.freq_bins,
    frames: m.frames,
  };
}

export function manifestUrl(id: string): string {
  return `models/${id}/manifest.json`;
}

/** Die Adressen der Stuecke, in der Reihenfolge, in der sie gehoeren. */
export function weightPartUrls(id: string, manifest: ModelManifest): string[] {
  return manifest.weights.parts.map((part) => `models/${id}/${part.name}`);
}

export function weightsBytes(manifest: ModelManifest): number {
  return manifest.weights.total_bytes;
}

/**
 * Der Name, unter dem die **zusammengesetzten** Gewichte im Cache stehen.
 *
 * Nicht die einzelnen Stuecke: zusammengesetzt wird einmal, danach soll
 * ein Start ein einziges Mal lesen und nicht neun Mal. Der Browser-Cache
 * kennt die 25-MiB-Grenze nicht — die ist eine Regel des Hosters.
 */
export function weightsCacheKey(id: string, manifest: ModelManifest): string {
  return `models/${id}/${manifest.weights.file}`;
}

/**
 * Traegt das Manifest alles, was der Browserpfad braucht?
 *
 * Gefragt wird nicht aus Misstrauen gegen den Export, sondern gegen den
 * **Cache**: das Manifest hat seine Form schon geaendert — vor dem Zerlegen
 * der Gewichte standen `file` und `bytes` flach darin, heute unter
 * `weights`. Ein Eintrag von vorher blieb im Browser liegen, und der Code
 * stolperte an `manifest.weights.file` ueber `undefined`. Die Folge war
 * nicht eine Fehlermeldung, sondern eine **leere Modusliste**: die
 * Importkarte zeigte ueberhaupt keinen Trennmodus mehr.
 *
 * Deshalb wird hier gefragt, bevor gelesen wird. Was die Pruefung nicht
 * besteht, gilt als veraltet und wird ueber das Netz ersetzt.
 */
function isUsable(m: ModelManifest | null): boolean {
  return !!(
    m &&
    m.weights &&
    typeof m.weights.file === 'string' &&
    typeof m.weights.total_bytes === 'number' &&
    Array.isArray(m.weights.parts) &&
    m.weights.parts.length > 0 &&
    typeof m.sample_rate === 'number' &&
    Array.isArray(m.sources)
  );
}

/**
 * Laedt das `manifest.json` eines Modus, oder `null`, wenn es fehlt.
 *
 * Ueber denselben Cache wie die Gewichte: ohne das Manifest beginnt keine
 * Trennung, und bei abgeschaltetem Netz scheiterte sie sonst an der
 * kleinsten Datei, waehrend die 174 MB daneben bereitlaegen.
 *
 * Die gecachten **Gewichte** bleiben dabei gueltig: sie stehen unter
 * `models/<id>/<datei>.onnx`, und zusammengesetzt sind es Byte fuer Byte
 * dieselben wie vor dem Zerlegen. Nur die Beschreibung wird erneuert, nicht
 * die 174 MB.
 */
export async function loadManifest(id: string): Promise<ModelManifest | null> {
  return fetchCachedJson<ModelManifest>(manifestUrl(id), isUsable);
}

/** Die Modi, deren Export tatsaechlich ausgeliefert ist. */
export async function availableModels(): Promise<
  { model: BrowserModel; manifest: ModelManifest }[]
> {
  // Je Kennung einmal, nicht je Eintrag: „Schnell" und „Minimum" zeigen auf
  // denselben Ordner, und ohne diese Zwischenablage gingen beim Start zwei
  // Anfragen fuer dasselbe `manifest.json` hinaus. Nebeneinander gestartet
  // hilft auch der Cache nichts — die zweite ist schon unterwegs, bevor die
  // erste antwortet. Also wird das Versprechen geteilt, nicht die Antwort.
  const pending = new Map<string, Promise<ModelManifest | null>>();
  const once = (id: string): Promise<ModelManifest | null> => {
    let p = pending.get(id);
    if (!p) {
      p = loadManifest(id);
      pending.set(id, p);
    }
    return p;
  };

  const found = await Promise.all(
    BROWSER_MODELS.map(async (model) => {
      const manifest = await once(model.id);
      return manifest ? { model, manifest } : null;
    }),
  );
  return found.filter((f): f is { model: BrowserModel; manifest: ModelManifest } => !!f);
}
