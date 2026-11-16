import { fetchCachedJson, fetchWeights } from './model-cache';
import { isMobileDevice } from './platform';

/**
 * Laedt die ONNX-Runtime und weist nach, worauf sie wirklich rechnet.
 *
 * Der Nachweis ist hier der eigentliche Zweck. `navigator.gpu` vorzufinden
 * heisst noch nicht, dass gerechnet wird: die Runtime faellt bei jedem
 * Problem still auf WASM zurueck, und ein Browser kann einen reinen
 * Software-Adapter anbieten (SwiftShader, llvmpipe), der die ganze
 * WebGPU-Schnittstelle erfuellt und dabei auf der CPU rechnet. Beides sieht
 * von aussen wie ein GPU-Lauf aus und ist fuenf- bis zwanzigmal langsamer.
 *
 * Ein Lauf gilt deshalb erst als GPU-Lauf, wenn drei Dinge zusammenkommen:
 *
 * 1. `navigator.gpu` liefert einen Adapter, und der bezeichnet sich nicht
 *    als Software oder Rueckfallweg.
 * 2. Die Sitzung entsteht mit WebGPU als **einzigem** Rechenweg. Das ist
 *    der tragende Beleg: kann die Runtime WebGPU nicht benutzen, hat sie
 *    nichts, worauf sie zurueckfallen koennte, und `create` wirft („no
 *    available backend found"). Ein stilles Ausweichen auf WASM ist damit
 *    ausgeschlossen.
 * 3. Die Runtime nennt nach dem Anlegen der Sitzung das `GPUDevice`, mit
 *    dem sie rechnet.
 *
 * Fehlt eines davon, heisst das Ergebnis `wasm`, und so steht es dann auch
 * in der Messung.
 *
 * **Wo die Ergebnisse liegen, gehoert nicht zu den Belegen** — und das war
 * ein Irrtum, der hier zuerst stand. Die Vermutung war: ein Tensor in einem
 * GPU-Puffer kann nur von der GPU kommen, also ist er der sauberste
 * Nachweis. Gemessen auf einer RTX 4070 unter Chrome 156 kommen die
 * Ausgaben aber auf der CPU zurueck, obwohl `preferredOutputLocation`
 * gesetzt ist, der Adapter `nvidia · lovelace` meldet und die Inferenz
 * vierzigmal schneller laeuft als auf WASM. Die Runtime haelt sich an den
 * Wunsch nur, wenn der erzeugende Knoten auf der GPU endet. Als Bedingung
 * haette dieser Punkt also einen echten GPU-Lauf als WASM-Lauf ausgegeben —
 * und ein falsches Nein ist bei einem Ehrlichkeitstest genauso schaedlich
 * wie ein falsches Ja. Gemeldet wird der Ort weiterhin, als Beobachtung.
 */

/** Was die Runtime braucht, um ohne Netz und ohne CDN zu starten. */
const VENDOR_PATH = '/vendor/onnxruntime/';
const RUNTIME_FILE = 'ort.webgpu.bundle.min.mjs';

/** Was `tools/vendor-onnxruntime.mjs` neben die Dateien schreibt. */
interface RuntimeManifest {
  version: string;
  runtime: string;
  wasm: {
    file: string;
    total_bytes: number;
    sha256: string;
    parts: { name: string; bytes: number }[];
  } | null;
}

/** Namen, hinter denen sich eine Software-Umsetzung von WebGPU verbirgt. */
const SOFTWARE_HINTS = [
  'swiftshader',
  'llvmpipe',
  'lavapipe',
  'software',
  'basic render',
  'microsoft basic',
];

export interface AdapterReport {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** Der Browser bietet nur eine Software-Umsetzung an. */
  software: boolean;
  isFallback: boolean;
  /**
   * Nur ueber den Compatibility-Modus erreichbar.
   *
   * Dieser Modus laeuft auf OpenGL ES 3.1 und Direct3D 11 und hat kleinere
   * Grenzen als der Kernmodus. Er steht hier, weil er auf Android der
   * Unterschied zwischen „rechnet auf der Grafikkarte" und „rechnet gar
   * nicht darauf" sein kann — und weil er an der Messung sichtbar bleiben
   * soll: ein Lauf darauf ist ein GPU-Lauf, aber nicht derselbe.
   */
  compat: boolean;
}

export type Provider = 'webgpu' | 'wasm';

export interface ExecutionProof {
  provider: Provider;
  /** Nur wahr, wenn alle drei Belege zusammenpassen. */
  gpuConfirmed: boolean;
  /** Belege und Gegenbelege im Klartext, fuer die Anzeige und das Protokoll. */
  evidence: string[];
  adapter: AdapterReport | null;
  runtimeVersion: string;
  /** Mehrere WASM-Faeden brauchen `crossOriginIsolated`. */
  wasmThreads: number;
}

export interface WebGpuSupport {
  available: boolean;
  adapter: AdapterReport | null;
  /** Grund, falls nicht nutzbar — im Klartext fuer die Oberflaeche. */
  reason: string | null;
  /**
   * Was WebGL ueber die verbaute Grafikeinheit sagt — oder `null`.
   *
   * Gefuellt nur, wenn WebGPU keinen Adapter hergab. Dann ist es die
   * einzige Stelle, an der sich die Frage „ist ueberhaupt eine Grafikkarte
   * da?" beantworten laesst, und sie wird gestellt: wer auf dem Handy
   * liest, WebGPU sei nicht verfuegbar, haelt das fuer einen Fehler der
   * Seite — das Geraet hat ja sichtbar eine GPU. Steht ihr Name da, ist
   * klar, dass sie erkannt wurde und der Browser sie trotzdem nicht
   * freigibt.
   */
  renderer: string | null;
}

/**
 * Fasst zusammen, was der Adapter ueber sich sagt.
 *
 * `info` ist absichtlich als fehlend zugelassen, obwohl die Typen es als
 * gesetzt fuehren: das Attribut gibt es erst ab Chromium 128, davor hiess
 * es `requestAdapterInfo()`. Ohne diesen Vorbehalt warf ein Zugriff auf
 * `info.vendor` dort einen `TypeError`, und weil der Aufruf im Worker in
 * keinem `catch` stand, kam die Antwort auf die Geraetepruefung nie an. Was
 * der Mensch dann sah, war nach acht Sekunden Wartezeit die Meldung, die
 * Runtime antworte nicht — auf einem Geraet, das WebGPU durchaus kann.
 */
function describeAdapter(
  info: GPUAdapterInfo | undefined,
  isFallback: boolean,
  compat: boolean,
): AdapterReport {
  const vendor = info?.vendor ?? '';
  const architecture = info?.architecture ?? '';
  const device = info?.device ?? '';
  const description = info?.description ?? '';
  const haystack = `${vendor} ${architecture} ${device} ${description}`.toLowerCase();
  return {
    vendor,
    architecture,
    device,
    description,
    software: SOFTWARE_HINTS.some((hint) => haystack.includes(hint)),
    isFallback,
    compat,
  };
}

export function adapterLabel(a: AdapterReport | null): string {
  if (!a) return 'kein Adapter';
  const parts = [a.vendor, a.architecture, a.device, a.description].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Adapter ohne Angaben';
}

/**
 * Fragt WebGL, welche Grafikeinheit verbaut ist.
 *
 * Der Umweg lohnt genau dann, wenn WebGPU nichts hergibt. WebGL laeuft auf
 * praktisch jedem Geraet, auch auf denen, fuer die Chrome WebGPU noch nicht
 * freigegeben hat, und `WEBGL_debug_renderer_info` nennt den echten
 * Treiberstring statt der maskierten Fassung.
 *
 * Das aendert nichts daran, dass nicht gerechnet werden kann — es ist eine
 * Auskunft, kein Rechenweg. Aber es beantwortet die Frage, die sonst offen
 * bleibt und die jeder zuerst stellt: liegt es am Geraet oder an der Seite?
 * Steht „Samsung Xclipse 540" in der Meldung, ist beides beantwortet.
 *
 * Nicht ueberall zu haben: Firefox fuehrt die Erweiterung als veraltet und
 * schaltet sie beim Fingerprinting-Schutz ab. Dann bleibt der maskierte
 * `RENDERER`, und taugt auch der nichts, gibt es eben `null` — die Meldung
 * kommt ohne aus.
 *
 * Laeuft im Worker wie im Fenster: `OffscreenCanvas` gibt es in beiden, und
 * der Kontext wird sofort wieder freigegeben.
 */
let rendererCache: string | null | undefined;

export function readWebGlRenderer(): string | null {
  // Gemerkt, weil zwei Stellen fragen — die Meldung und der Bericht — und
  // jede Frage sonst einen eigenen WebGL-Kontext kostete. Die verbaute
  // Grafikeinheit wechselt waehrend einer Sitzung nicht.
  if (rendererCache !== undefined) return rendererCache;
  rendererCache = probeWebGlRenderer();
  return rendererCache;
}

function probeWebGlRenderer(): string | null {
  const Canvas = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
  if (!Canvas) return null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = new Canvas(1, 1);
    gl = (canvas.getContext('webgl2') ??
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    if (!gl) return null;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const raw: unknown = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const name = typeof raw === 'string' ? raw.trim() : '';
    return name.length ? name : null;
  } catch {
    return null;
  } finally {
    // Ohne das bliebe ein WebGL-Kontext offen. Browser halten nur eine
    // begrenzte Zahl davon und raeumen den aeltesten weg — hier waere das
    // moeglicherweise einer, den die Oberflaeche noch braucht.
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Dann eben nicht; der Kontext faellt mit dem Canvas weg.
    }
  }
}

/**
 * Prueft, ob der Browser WebGPU mit echter Hardware anbietet.
 *
 * Das laeuft vor jedem Download: ein 174-MB-Modell zu holen und erst dann
 * zu merken, dass nichts damit zu rechnen ist, waere die schlechteste
 * Reihenfolge.
 */
export async function probeWebGpu(): Promise<WebGpuSupport> {
  const { report, reason } = await requestUsableAdapter();
  const available = reason === null && report !== null;
  // Nur im Fehlerfall gefragt: liegt ein Adapter vor, sagt der schon alles,
  // und ein WebGL-Kontext waere Aufwand fuer nichts.
  return {
    available,
    adapter: report,
    reason,
    renderer: available ? null : readWebGlRenderer(),
  };
}

/**
 * Was `lib.dom` in TypeScript 6.0 noch nicht kennt.
 *
 * `featureLevel` steht in der WebGPU-Spezifikation und in `@webgpu/types`,
 * aber die mitgelieferte `lib.dom` fuehrt eine aeltere Fassung von
 * `GPURequestAdapterOptions` und gewinnt gegen das Paket. Nachdeklariert
 * statt weggecastet: so bleibt das Feld getippt, und faellt es eines Tages
 * mit der echten Deklaration zusammen, meldet der Compiler es.
 */
interface AdapterOptionsWithLevel extends GPURequestAdapterOptions {
  featureLevel?: string;
}

/** Was die Adaptersuche gefunden hat — mit dem rohen Adapter dazu. */
interface AdapterAttempt {
  /**
   * Der Adapter selbst, fuer `env.webgpu.adapter`.
   *
   * Bleibt absichtlich aus `WebGpuSupport` heraus: ein `GPUAdapter` ist
   * nicht strukturklonbar, und `WebGpuSupport` geht per `postMessage` aus
   * dem Worker in die Oberflaeche. Stuende er darin, waere die Nachricht
   * nicht zustellbar.
   */
  adapter: GPUAdapter | null;
  report: AdapterReport | null;
  /** Grund, falls nicht nutzbar — im Klartext fuer die Oberflaeche. */
  reason: string | null;
}

/**
 * Sucht einen Adapter, auf dem sich rechnen laesst — in zwei Anlaeufen.
 *
 * Der zweite Anlauf ist der Grund fuer diese Funktion. Chrome gibt WebGPU
 * auf Android nur fuer einen Teil der Grafikeinheiten frei; auf den
 * uebrigen ist `navigator.gpu` da und `requestAdapter()` liefert trotzdem
 * `null`. Seit Chrome 146 gibt es dafuer den Compatibility-Modus, der auf
 * OpenGL ES 3.1 aufsetzt und genau diese Geraete erreichen soll.
 *
 * Er kostet nichts, wo er nicht gebraucht wird: angefragt wird er nur,
 * wenn der Kernmodus nichts geliefert hat. Kennt ein Browser `featureLevel`
 * nicht, ignoriert er das unbekannte Feld, und der zweite Anlauf scheitert
 * genau wie der erste — ohne Schaden.
 *
 * Eine Zusage ist er nicht. Seine Grenzen sind kleiner als die des
 * Kernmodus, und ob die Shaders des Modells darin uebersetzen, zeigt erst
 * das Anlegen der Sitzung. Deshalb steht `compat` im Bericht: geht es dort
 * schief, soll in der Messung stehen, worauf es schiefging.
 */
async function requestUsableAdapter(): Promise<AdapterAttempt> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) {
    return {
      adapter: null,
      report: null,
      reason: isMobileDevice()
        ? 'Dieser Browser bietet kein WebGPU. Auf Android kann es Chrome ab ' +
          'Fassung 121; Firefox und ältere Fassungen von Samsung Internet ' +
          'liefern es nicht.'
        : 'Dieser Browser bietet kein WebGPU. Auf dem Gerät trennen geht damit ' +
          'nicht — es braucht Chrome oder Edge in einer aktuellen Fassung.',
    };
  }

  let adapter: GPUAdapter | null = null;
  let openError: string | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (err) {
    openError = describe(err);
  }

  let compat = false;
  if (!adapter) {
    const compatOptions: AdapterOptionsWithLevel = { featureLevel: 'compatibility' };
    try {
      adapter = await gpu.requestAdapter(compatOptions);
      compat = adapter !== null;
    } catch {
      // Bleibt bei `null`. Der Grund steht unten; der des ersten Anlaufs
      // ist der aussagekraeftigere und hat deshalb Vorrang.
    }
  }

  if (!adapter) {
    return {
      adapter: null,
      report: null,
      reason:
        openError !== null
          ? `WebGPU ließ sich nicht öffnen: ${openError}`
          : noAdapterReason(),
    };
  }

  // Eine Anfrage im Compatibility-Modus darf auch einen Kern-Adapter
  // zurueckgeben. Welcher es geworden ist, sagt dieses Feature — kennt der
  // Browser es nicht, bleibt es bei der Annahme aus der Anfrage.
  if (compat && adapter.features.has('core-features-and-limits')) compat = false;

  const report = describeAdapter(
    adapter.info,
    // `isFallbackAdapter` ist aelter als `info` und fehlt in neuen Fassungen.
    (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter === true,
    compat,
  );
  if (report.software || report.isFallback) {
    return {
      adapter,
      report,
      reason:
        `WebGPU läuft hier über eine Software-Umsetzung (${adapterLabel(report)}). ` +
        'Das rechnet auf der CPU und ist für eine Trennung zu langsam.',
    };
  }
  return { adapter, report, reason: null };
}

/**
 * Warum es keinen Adapter gibt — und was der Mensch dagegen tun kann.
 *
 * Auf dem Handy: nichts, und das steht da auch. Der vorige Text riet hier
 * zu einem neueren Grafiktreiber und erwaehnte virtuelle Maschinen — auf
 * einem Android-Telefon ist das erste unmoeglich und das zweite sinnlos.
 * Ein Rat, den niemand befolgen kann, ist schlechter als keiner: er laesst
 * den Fehler beim Menschen suchen, wo keiner ist.
 */
function noAdapterReason(): string {
  // WebGL laeuft auch dort, wo WebGPU nichts hergibt, und nennt den
  // Treiberstring. Steht der in der Meldung, erledigt sich die naechste
  // Frage von selbst: die Grafikeinheit ist erkannt, sie wird nur nicht
  // freigegeben. Ohne diesen Namen liest sich dieselbe Meldung wie ein
  // Fehler der Seite.
  const renderer = readWebGlRenderer();

  // Der Treiberstring kann selbst eine Software-Umsetzung benennen — unter
  // WSL2 und in Testbrowsern steht da regelmaessig SwiftShader. „Die
  // Grafikeinheit ist erkannt" waere dann das Gegenteil der Wahrheit, und
  // zwar die bequeme Richtung: es klaenge, als fehle nur eine Freigabe, wo
  // in Wirklichkeit nichts zu rechnen ist. Also wird derselbe Massstab
  // angelegt wie beim WebGPU-Adapter.
  const rendererIsSoftware =
    renderer !== null && SOFTWARE_HINTS.some((hint) => renderer.toLowerCase().includes(hint));

  let named = '';
  if (renderer !== null && rendererIsSoftware) {
    named =
      ` Auch WebGL rechnet hier auf dem Prozessor (meldet „${renderer}“) — ` +
      'eine nutzbare Grafikeinheit ist also nicht vorhanden.';
  } else if (renderer !== null) {
    named =
      ` Erkannt wird sie durchaus — WebGL meldet „${renderer}“ —, für WebGPU ` +
      'gibt der Browser sie nur nicht frei.';
  }

  if (isMobileDevice()) {
    return (
      'WebGPU ist vorhanden, der Browser gibt die Grafikeinheit dieses ' +
      'Geräts aber nicht frei — auch nicht im Compatibility-Modus.' +
      named +
      ' Das liegt am Gerät: Chrome schaltet WebGPU auf Android bisher nur ' +
      'für einen Teil der verbauten Grafikeinheiten frei. Daran lässt sich ' +
      'hier nichts ändern.'
    );
  }
  return (
    'WebGPU ist vorhanden, liefert aber keinen Grafikadapter — auch nicht ' +
    'im Compatibility-Modus.' +
    named +
    ' Oft hilft ein aktueller Grafiktreiber; in einer virtuellen Maschine ' +
    'ist WebGPU häufig abgeschaltet.'
  );
}

/** Die Runtime, so wie sie aus der vendorierten Datei kommt. */
// Der Typ ist absichtlich weit: `onnxruntime-web` wird nicht gebuendelt,
// sondern zur Laufzeit geladen, es gibt hier also kein Modul zum Importieren.
// Die Typen aus `onnxruntime-common` sind ueber `OrtModule` angebunden.
export type OrtModule = typeof import('onnxruntime-web');

let loading: Promise<OrtModule> | null = null;

/**
 * Laedt die Runtime aus `public/vendor/onnxruntime/`.
 *
 * Der Pfad wird erst zur Laufzeit gebildet, damit der Bundler die Datei
 * nicht anfasst: sie laedt ihr WASM selbst nach, anhand ihrer eigenen
 * Adresse. Siehe `frontend/tools/vendor-onnxruntime.mjs`.
 */
export function loadRuntime(): Promise<OrtModule> {
  loading ??= (async () => {
    const url = new URL(VENDOR_PATH + RUNTIME_FILE, self.location.origin).href;
    const ort = (await import(/* @vite-ignore */ url)) as OrtModule;
    ort.env.wasm.wasmPaths = new URL(VENDOR_PATH, self.location.origin).href;
    // Mehrere Faeden setzen `SharedArrayBuffer` voraus, und der braucht die
    // Kopfzeilen fuer `crossOriginIsolated`. Die Seite setzt sie nicht — sie
    // wuerden jede eingebettete Fremdressource aussperren —, deshalb bleibt
    // der WASM-Rueckfallweg einfaedig. Das ist der Grund, warum er so
    // deutlich langsamer ist, und es steht in der Messung.
    ort.env.wasm.numThreads = globalThis.crossOriginIsolated
      ? Math.min(4, navigator.hardwareConcurrency || 1)
      : 1;
    ort.env.logLevel = 'error';
    return ort;
  })();
  return loading;
}

/**
 * Holt das WASM der Runtime selbst und reicht es ihr als Puffer.
 *
 * Normalerweise laedt die Runtime es anhand von `wasmPaths` allein nach.
 * Das geht hier nicht: die Datei ist 28,7 MB, und Cloudflare Pages nimmt
 * hoechstens 25 MiB je Datei. Zerlegt liegt sie in Stuecken, und wer sie
 * zusammensetzt, muss sie auch uebergeben — dafuer gibt es
 * `env.wasm.wasmBinary`, und ist das gesetzt, ignoriert die Runtime
 * `wasmPaths`.
 *
 * Nebenwirkung, die hier gelegen kommt: die 28 MB liegen damit in
 * **unserem** Cache statt im HTTP-Cache, auf den sich nichts verlassen
 * kann.
 *
 * Geladen wird erst, wenn wirklich getrennt werden soll — wer die Seite
 * nur ansieht, soll keine 28 MB holen.
 */
export async function ensureWasmBinary(
  ort: OrtModule,
  onProgress: (loaded: number, total: number, fromCache: boolean) => void,
): Promise<void> {
  if (ort.env.wasm.wasmBinary) return;
  const manifest = await fetchCachedJson<RuntimeManifest>(VENDOR_PATH + 'runtime.json');
  if (!manifest?.wasm) return; // Ohne Beschreibung bleibt es beim Nachladen.
  const { wasm } = manifest;
  const binary = await fetchWeights(
    wasm.parts.map((part) => VENDOR_PATH + part.name),
    VENDOR_PATH + wasm.file,
    wasm.total_bytes,
    wasm.sha256,
    (p) => onProgress(p.loaded, p.total, p.fromCache),
  );
  ort.env.wasm.wasmBinary = binary;
}

export interface SessionResult {
  session: import('onnxruntime-common').InferenceSession;
  proof: ExecutionProof;
}

/**
 * Legt die Sitzung an und stellt dabei fest, worauf sie rechnet.
 *
 * `preferGpu: false` erzwingt den WASM-Pfad — so laesst sich beides mit
 * demselben Code vermessen, und der Vergleich in der Messung ist dann auch
 * einer.
 */
export async function createSession(
  model: ArrayBuffer | Uint8Array,
  options: { preferGpu: boolean },
): Promise<SessionResult> {
  const ort = await loadRuntime();
  const evidence: string[] = [];
  let adapter: AdapterReport | null = null;
  let usable = false;

  if (options.preferGpu) {
    const attempt = await requestUsableAdapter();
    adapter = attempt.report;
    if (attempt.reason === null && attempt.adapter !== null) {
      usable = true;
      evidence.push(`Adapter gemeldet: ${adapterLabel(attempt.report)}`);
      if (attempt.report?.compat) {
        evidence.push(
          'Adapter nur über den Compatibility-Modus erreichbar — kleinere ' +
            'Grenzen als im Kernmodus',
        );
      }
      // Genau diesen Adapter soll die Runtime nehmen, und das ist keine
      // Feinheit: fragte sie selbst, fragte sie ohne `featureLevel`. Auf
      // einem Geraet, das nur ueber den Compatibility-Modus erreichbar ist,
      // bekaeme sie damit `null` zurueck — und das Anlegen der Sitzung
      // schluge fehl, obwohl die Pruefung eben noch einen Adapter hatte.
      ort.env.webgpu.adapter = attempt.adapter;
    } else {
      evidence.push(`Kein nutzbarer Adapter: ${attempt.reason}`);
    }
  } else {
    evidence.push('WASM ausdrücklich verlangt');
  }

  // Frueher stand hier `adapter !== null && !adapter.software`. Das liess
  // einen Rueckfall-Adapter ohne Software-Kennung durch, obwohl die
  // Geraetepruefung ihn als unbrauchbar meldete — zwei Stellen, zwei
  // Urteile. Jetzt entscheidet beides dieselbe Funktion.
  const wantGpu = options.preferGpu && usable;
  const session = await ort.InferenceSession.create(
    model instanceof Uint8Array ? model : new Uint8Array(model),
    {
      executionProviders: wantGpu ? ['webgpu'] : ['wasm'],
      graphOptimizationLevel: 'all',
      // Beide Ausgaben moeglichst im GPU-Puffer halten: das spart je Block
      // 55 MB ueber den Bus. Ein Wunsch, keine Zusage — die Runtime
      // erfuellt ihn nur, wenn der erzeugende Knoten auf der GPU endet, und
      // auf einer RTX 4070 unter Chrome 156 tut er das nicht. Es laeuft
      // trotzdem auf der Grafikkarte; siehe Klassendoku.
      ...(wantGpu ? { preferredOutputLocation: 'gpu-buffer' as const } : {}),
    },
  );

  let provider: Provider = wantGpu ? 'webgpu' : 'wasm';
  let gpuConfirmed = false;
  if (wantGpu) {
    // Dass wir hier stehen, ist schon ein Beleg: angelegt wurde mit WebGPU
    // als einzigem Rechenweg, und ohne nutzbares WebGPU haette `create`
    // geworfen, statt auf WASM auszuweichen.
    evidence.push('Sitzung mit WebGPU als einzigem Rechenweg angelegt');
    try {
      const device = await ort.env.webgpu.device;
      if (device) {
        evidence.push('onnxruntime nennt das GPUDevice, mit dem es rechnet');
        gpuConfirmed = true;
      } else {
        evidence.push('onnxruntime meldet kein GPUDevice — es läuft auf WASM');
        provider = 'wasm';
      }
    } catch (err) {
      evidence.push(`GPUDevice nicht abfragbar: ${describe(err)} — es läuft auf WASM`);
      provider = 'wasm';
    }
  }

  return {
    session,
    proof: {
      provider,
      gpuConfirmed,
      evidence,
      adapter,
      runtimeVersion: ort.env.versions?.common ?? 'unbekannt',
      wasmThreads: ort.env.wasm.numThreads ?? 1,
    },
  };
}

/**
 * Haelt nach dem ersten Block fest, wo die Ergebnisse liegen.
 *
 * Eine Beobachtung, kein Beleg — und genau das ist hier der Punkt. Ein
 * Tensor im GPU-Puffer waere ein schoener Nachweis, aber sein Fehlen ist
 * keiner fuer das Gegenteil: auf einer RTX 4070 unter Chrome 156 kommen
 * die Ausgaben auf der CPU zurueck, waehrend die Inferenz vierzigmal
 * schneller laeuft als auf WASM. Wer daraus „kein GPU-Lauf" schloesse,
 * laege falsch. Festgehalten wird es trotzdem: es sagt, ob der Umweg ueber
 * den Bus je Block anfaellt.
 */
export function noteOutputLocations(
  proof: ExecutionProof,
  outputs: Record<string, { location: string }>,
): ExecutionProof {
  const locations = Object.entries(outputs).map(([k, v]) => `${k}:${v.location}`);
  const onGpu = Object.values(outputs).some((t) => t.location === 'gpu-buffer');
  return {
    ...proof,
    evidence: [
      ...proof.evidence,
      `Ausgaben liegen in ${locations.join(', ')}` +
        (proof.provider === 'webgpu' && !onGpu
          ? ' — sie werden je Block von der Karte geholt'
          : ''),
    ],
  };
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
