/**
 * Anbindung an Signalsmith Stretch (MIT, Geraint Luff), Version 1.3.2.
 *
 * Die Bibliothek liegt unveraendert unter `public/vendor/`. Das WASM ist als
 * data-URI in der Datei enthalten, es gibt also keine zweite Datei zu laden.
 *
 * Geladen wird die UMD-Variante ueber ein klassisches <script>-Tag und nicht
 * als Modulimport. Grund: die Bibliothek baut ihr AudioWorklet, indem sie
 * eigenen Quelltext als Zeichenkette in eine Blob-URL schreibt. Laeuft sie
 * durch einen Bundler, kann dieser Selbstbezug brechen. Als Vendor-Datei
 * bleibt sie Byte fuer Byte die Originaldatei.
 */

/** Werte fuer `schedule`. Alle Zeiten in Sekunden. */
export interface StretchSchedule {
  /** Audiozeit, zu der die Aenderung gilt (in der Doku `output`). */
  output?: number;
  /**
   * Dasselbe unter dem Namen, den die Worklet-Seite tatsaechlich ausliest.
   * Die Doku nennt `output`, der Code im Worklet liest `outputTime`. Wir
   * setzen beide, damit Zeitkarte und zurueckgemeldete Position passen.
   */
  outputTime?: number;
  /** Laeuft die Spur? */
  active?: boolean;
  /** Position im Eingangspuffer, also Sekunde im Originalsong. */
  input?: number;
  /** Abspielrate: 1 = Original, 0.5 = halbe Geschwindigkeit. */
  rate?: number;
  /** Tonhoehe in Halbtoenen, unabhaengig von `rate`. */
  semitones?: number;
  tonalityHz?: number;
  /** Loop im Eingangspuffer. Gleich gesetzt = aus. */
  loopStart?: number;
  loopEnd?: number;
}

export interface StretchNode extends AudioNode {
  /** Aktuelle Position im Eingangspuffer, vom Worklet gemeldet. */
  readonly inputTime: number;
  schedule(options: StretchSchedule): Promise<unknown>;
  start(when?: number): Promise<unknown>;
  stop(when?: number): Promise<unknown>;
  /**
   * Fuegt Kanalpuffer gleicher Laenge an. Liefert das neue Pufferende.
   *
   * `transfer` uebergibt die Speicherbereiche an das Worklet, statt sie zu
   * kopieren. Danach sind sie im Hauptthread leer. Das halbiert die
   * Speicherspitze beim Laden, denn ohne Transferliste liegt jede Spur
   * kurzzeitig zweimal im Speicher.
   */
  addBuffers(buffers: Float32Array[], transfer?: ArrayBufferLike[]): Promise<number>;
  dropBuffers(toSeconds?: number): Promise<unknown>;
  /** Eigenlatenz in Sekunden (Ein- plus Ausgangslatenz). */
  latency(): Promise<number>;
  setUpdateInterval(seconds: number, callback?: (t: number) => void): Promise<unknown>;
  configure(config: {
    blockMs?: number | null;
    intervalMs?: number;
    splitComputation?: boolean;
    preset?: 'default' | 'cheaper';
  }): Promise<unknown>;
}

type StretchFactory = (
  context: BaseAudioContext,
  options?: AudioWorkletNodeOptions,
) => Promise<StretchNode>;

const VENDOR_URL = 'vendor/SignalsmithStretch.js';

let loader: Promise<StretchFactory> | null = null;

function loadScript(): Promise<StretchFactory> {
  return new Promise((resolve, reject) => {
    const existing = (globalThis as Record<string, unknown>)['SignalsmithStretch'];
    if (typeof existing === 'function') {
      resolve(existing as StretchFactory);
      return;
    }
    const el = document.createElement('script');
    el.src = VENDOR_URL;
    el.async = true;
    el.onload = () => {
      const factory = (globalThis as Record<string, unknown>)['SignalsmithStretch'];
      if (typeof factory !== 'function') {
        reject(new Error(`${VENDOR_URL} wurde geladen, aber SignalsmithStretch fehlt.`));
        return;
      }
      resolve(factory as StretchFactory);
    };
    el.onerror = () =>
      reject(new Error(`${VENDOR_URL} konnte nicht geladen werden.`));
    document.head.appendChild(el);
  });
}

export function loadSignalsmith(): Promise<StretchFactory> {
  loader ??= loadScript();
  return loader;
}

/**
 * Erzeugt einen Stretch-Knoten fuer eine Spur.
 *
 * `numberOfInputs` muss 1 bleiben, auch wenn die Spur aus einem Puffer kommt
 * und nichts an den Eingang gehaengt wird: das Worklet greift im Zustand
 * `active: false` auf `inputList[0]` zu. Mit 0 Eingaengen waere das
 * `undefined` und das Worklet wuerde beim Pausieren eine Ausnahme werfen.
 */
export async function createStretchNode(
  context: BaseAudioContext,
  channels = 2,
): Promise<StretchNode> {
  const factory = await loadSignalsmith();
  return factory(context, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
  });
}
