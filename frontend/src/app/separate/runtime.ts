import { fetchCachedJson, fetchWeights } from './model-cache';

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
}

function describeAdapter(info: GPUAdapterInfo, isFallback: boolean): AdapterReport {
  const vendor = info.vendor ?? '';
  const architecture = info.architecture ?? '';
  const device = info.device ?? '';
  const description = info.description ?? '';
  const haystack = `${vendor} ${architecture} ${device} ${description}`.toLowerCase();
  return {
    vendor,
    architecture,
    device,
    description,
    software: SOFTWARE_HINTS.some((hint) => haystack.includes(hint)),
    isFallback,
  };
}

export function adapterLabel(a: AdapterReport | null): string {
  if (!a) return 'kein Adapter';
  const parts = [a.vendor, a.architecture, a.device, a.description].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Adapter ohne Angaben';
}

/**
 * Prueft, ob der Browser WebGPU mit echter Hardware anbietet.
 *
 * Das laeuft vor jedem Download: ein 174-MB-Modell zu holen und erst dann
 * zu merken, dass nichts damit zu rechnen ist, waere die schlechteste
 * Reihenfolge.
 */
export async function probeWebGpu(): Promise<WebGpuSupport> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) {
    return {
      available: false,
      adapter: null,
      reason:
        'Dieser Browser bietet kein WebGPU. Auf dem Gerät trennen geht damit ' +
        'nicht — es braucht Chrome oder Edge in einer aktuellen Fassung.',
    };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (err) {
    return {
      available: false,
      adapter: null,
      reason: `WebGPU ließ sich nicht öffnen: ${describe(err)}`,
    };
  }
  if (!adapter) {
    return {
      available: false,
      adapter: null,
      reason:
        'WebGPU ist vorhanden, liefert aber keinen Grafikadapter. Oft hilft ' +
        'ein aktueller Grafiktreiber; in einer virtuellen Maschine ist ' +
        'WebGPU häufig abgeschaltet.',
    };
  }
  const report = describeAdapter(
    adapter.info,
    // `isFallbackAdapter` ist aelter als `info` und fehlt in neuen Fassungen.
    (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter === true,
  );
  if (report.software || report.isFallback) {
    return {
      available: false,
      adapter: report,
      reason:
        `WebGPU läuft hier über eine Software-Umsetzung (${adapterLabel(report)}). ` +
        'Das rechnet auf der CPU und ist für eine Trennung zu langsam.',
    };
  }
  return { available: true, adapter: report, reason: null };
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

  if (options.preferGpu) {
    const support = await probeWebGpu();
    adapter = support.adapter;
    if (support.available) {
      evidence.push(`Adapter gemeldet: ${adapterLabel(support.adapter)}`);
    } else {
      evidence.push(`Kein nutzbarer Adapter: ${support.reason}`);
    }
  } else {
    evidence.push('WASM ausdrücklich verlangt');
  }

  const wantGpu = options.preferGpu && adapter !== null && !adapter.software;
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
