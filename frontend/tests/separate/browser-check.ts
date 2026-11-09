/**
 * Die Fehlerfälle des Browserpfads, im Browser geprüft.
 *
 * Was hier steht, lässt sich in Node nicht prüfen: `decodeAudioData` gibt es
 * nur im Browser, und das Nachrichtenspiel zwischen Oberfläche und Worker
 * braucht einen echten Worker. Gemessen wird deshalb in Chromium —
 * aufgerufen von `tests/separate/run-browser.mjs`.
 *
 * Die Prüfungen sind nach Kosten sortiert: erst alles, was ohne Modell
 * geht (Dekodieren, Abbruch, verspätete Antworten), dann die eine, die das
 * Modell wirklich laufen lässt. So steht nach wenigen Sekunden schon fest,
 * ob die Verdrahtung stimmt.
 */
import { decodeForModel } from '../../src/app/separate/decode';
import { encodeWav } from '../../src/app/separate/wav';
import { makeReferenceSignal } from '../../src/app/separate/reference-signal';
import type { FromWorker, ToWorker } from '../../src/app/separate/separate.worker';

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

declare global {
  interface Window {
    runSeparateChecks: (
    workerUrl: string,
    dspUrl: string,
    modelId: string,
    songUrl?: string,
  ) => Promise<Check[]>;
  }
}

const RATE = 44100;
const CHANNELS = 2;

/** Ein kurzes Stück Audio in beliebiger Rate und Kanalzahl. */
function makeWav(seconds: number, rate: number, channels: number): Blob {
  const frames = Math.round(seconds * rate);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const channel = new Float32Array(frames);
    // Je Kanal eine andere Frequenz, damit ein vertauschter oder
    // verdoppelter Kanal auffällt.
    const freq = 220 * (c + 1);
    for (let i = 0; i < frames; i++) {
      channel[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / rate);
    }
    data.push(channel);
  }
  return encodeWav(data, rate);
}

// ------------------------------------------------------------- Dekodieren

async function decodeChecks(): Promise<Check[]> {
  const cases: { label: string; rate: number; channels: number }[] = [
    { label: 'Stereo 44,1 kHz', rate: 44100, channels: 2 },
    { label: 'Stereo 48 kHz', rate: 48000, channels: 2 },
    { label: 'Mono 44,1 kHz', rate: 44100, channels: 1 },
    { label: 'Mono 48 kHz', rate: 48000, channels: 1 },
  ];
  const out: Check[] = [];
  for (const c of cases) {
    try {
      const seconds = 2;
      const decoded = await decodeForModel(makeWav(seconds, c.rate, c.channels), RATE, CHANNELS);
      const expected = Math.round(seconds * RATE);
      // Der Resampler darf ein paar Abtastwerte abweichen; eine ganze
      // Rate daneben (also Faktor 48/44,1) darf er nicht.
      const slack = Math.abs(decoded.channels[0].length - expected) <= 256;
      const twoChannels = decoded.channels.length === CHANNELS;
      const sameLength = decoded.channels[0].length === decoded.channels[1].length;
      // Bei Mono müssen beide Kanäle gleich sein, bei Stereo nicht.
      let identical = true;
      for (let i = 0; i < decoded.channels[0].length; i += 97) {
        if (decoded.channels[0][i] !== decoded.channels[1][i]) {
          identical = false;
          break;
        }
      }
      const channelsRight = c.channels === 1 ? identical : !identical;
      // Nicht still: ein Resampler, der nur Nullen liefert, bestünde alles
      // andere.
      let peak = 0;
      for (const value of decoded.channels[0]) peak = Math.max(peak, Math.abs(value));
      const loud = peak > 0.2;

      const pass = slack && twoChannels && sameLength && channelsRight && loud;
      out.push({
        name: `Dekodieren: ${c.label}`,
        pass,
        detail:
          `${decoded.channels.length} Kanäle, ${decoded.channels[0].length} ` +
          `Abtastwerte (erwartet ${expected}), Spitze ${peak.toFixed(3)}, ` +
          `Kanäle ${identical ? 'gleich' : 'verschieden'}` +
          (decoded.notes.length ? `; ${decoded.notes.join(' ')}` : ''),
      });
    } catch (err) {
      out.push({
        name: `Dekodieren: ${c.label}`,
        pass: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Und etwas, das kein Audio ist: der Fehler soll verständlich sein und
  // nicht als Ausnahme aus dem Dekoder fallen.
  try {
    await decodeForModel(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), RATE, CHANNELS);
    out.push({
      name: 'Dekodieren: keine Audiodatei wird abgewiesen',
      pass: false,
      detail: 'Es kam kein Fehler — fünf zufällige Bytes wurden angenommen.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.push({
      name: 'Dekodieren: keine Audiodatei wird abgewiesen',
      pass: message.includes('dekodieren'),
      detail: message,
    });
  }
  return out;
}

// ----------------------------------------------------------- Worker-Spiel

/**
 * Das Paar aus Inferenz- und Signalverarbeitungs-Worker, verdrahtet.
 *
 * Dieselbe Verdrahtung wie in `DeviceSeparator`: der Hauptfaden legt beide
 * an, reicht ihnen die Enden eines `MessageChannel` und haelt sich danach
 * heraus.
 */
function open(url: string, dspUrl: string): Worker {
  const worker = new Worker(url, { type: 'module' });
  const dsp = new Worker(dspUrl, { type: 'module' });
  const channel = new MessageChannel();
  worker.postMessage({ type: 'link', port: channel.port1 }, [channel.port1]);
  dsp.postMessage({ type: 'link', port: channel.port2 }, [channel.port2]);
  // Der zweite Worker haengt am ersten: wird der beendet, geht der andere
  // mit. `terminate` wird deshalb hier ueberschrieben.
  const stop = worker.terminate.bind(worker);
  worker.terminate = () => {
    dsp.terminate();
    stop();
  };
  return worker;
}

function send(worker: Worker, message: ToWorker, transfer: Transferable[] = []): void {
  worker.postMessage(message, transfer);
}

/** Sammelt alle Nachrichten zu einem Auftrag, bis er endet. */
function collect(
  worker: Worker,
  jobId: string,
): { messages: FromWorker[]; ended: Promise<FromWorker> } {
  const messages: FromWorker[] = [];
  const ended = new Promise<FromWorker>((resolve) => {
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (!('jobId' in message) || message.jobId !== jobId) return;
      messages.push(message);
      if (message.type === 'done' || message.type === 'error') resolve(message);
    });
  });
  return { messages, ended };
}

/**
 * Abbruch und sofortiger Neustart.
 *
 * Der interessante Fall ist nicht der Abbruch selbst, sondern was danach
 * kommt: der abgebrochene Auftrag darf nicht als Ergebnis zurückkommen, und
 * der neue muss ohne Weiteres durchlaufen. Ginge das schief, bekäme man die
 * Spuren des alten Songs unter dem Namen des neuen — und würde es nicht
 * merken.
 */
async function cancelAndRestart(workerUrl: string, dspUrl: string, modelId: string): Promise<Check[]> {
  const out: Check[] = [];
  const worker = open(workerUrl, dspUrl);
  try {
    const signal = makeReferenceSignal(343980 + 1024 * 37, RATE);
    const first = collect(worker, 'job-a');
    send(
      worker,
      {
        type: 'start',
        jobId: 'job-a',
        modelId,
        channels: signal.map((c) => new Float32Array(c)),
        sampleRate: RATE,
        preferGpu: true,
      },
      [],
    );
    // Abbrechen, sobald der Worker arbeitet. Vorher wäre es ein Abbruch
    // einer Nachricht, die noch in der Warteschlange steht, und das prüft
    // nichts.
    await waitFor(() => first.messages.some((m) => m.type === 'stage'), 30_000);
    send(worker, { type: 'cancel', jobId: 'job-a' });

    const ended = await first.ended;
    const cancelled = ended.type === 'error' && ended.cancelled;
    out.push({
      name: 'Abbruch: der Auftrag endet als Abbruch, nicht als Ergebnis',
      pass: cancelled,
      detail:
        ended.type === 'error'
          ? `Antwort: ${ended.message} (cancelled=${ended.cancelled})`
          : `Antwort: ${ended.type} — der abgebrochene Auftrag lieferte ein Ergebnis`,
    });
    const gotResult = first.messages.some((m) => m.type === 'done');
    out.push({
      name: 'Abbruch: kein verspätetes Ergebnis zum abgebrochenen Auftrag',
      pass: !gotResult,
      detail: gotResult
        ? 'Es kam doch ein „done" für job-a.'
        : `${first.messages.length} Nachrichten, keine davon ein Ergebnis.`,
    });

    // Neustart direkt danach, mit kürzerem Material, damit es schnell geht.
    const second = collect(worker, 'job-b');
    const short = makeReferenceSignal(343980, RATE);
    send(
      worker,
      {
        type: 'start',
        jobId: 'job-b',
        modelId,
        channels: short.map((c) => new Float32Array(c)),
        sampleRate: RATE,
        preferGpu: true,
      },
      [],
    );
    const result = await second.ended;
    out.push({
      name: 'Nach dem Abbruch läuft der nächste Auftrag durch',
      pass: result.type === 'done',
      detail:
        result.type === 'done'
          ? `${result.stems.length} Spuren, ${result.timings.blocks} Block/Blöcke, ` +
            `${Math.round(result.timings.totalMs)} ms`
          : `Antwort: ${result.type === 'error' ? result.message : result.type}`,
    });
    if (result.type === 'done') {
      // Die Spuren des neuen Auftrags müssen die Länge des neuen Materials
      // haben, nicht die des abgebrochenen.
      const length = result.stems[0]?.channels[0]?.length ?? 0;
      out.push({
        name: 'Das Ergebnis gehört zum neuen Material, nicht zum alten',
        pass: length === 343980,
        detail: `${length} Abtastwerte, erwartet 343980`,
      });
    }
  } catch (err) {
    out.push({
      name: 'Abbruch und Neustart',
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    worker.terminate();
  }
  return out;
}

/**
 * Zwei Aufträge gleichzeitig: der zweite wird abgewiesen.
 *
 * Ein Trennjob belegt die Grafikkarte und knapp ein Gigabyte. Zwei
 * gleichzeitig wären beide langsamer als einer nach dem anderen, und der
 * Speicher reichte womöglich für keinen.
 */
async function oneAtATime(workerUrl: string, dspUrl: string, modelId: string): Promise<Check> {
  const worker = open(workerUrl, dspUrl);
  try {
    const signal = makeReferenceSignal(343980, RATE);
    const first = collect(worker, 'job-1');
    const second = collect(worker, 'job-2');
    for (const jobId of ['job-1', 'job-2']) {
      const data = makeReferenceSignal(343980, RATE);
      send(worker, {
        type: 'start',
        jobId,
        modelId,
        channels: data,
        sampleRate: RATE,
        preferGpu: true,
      });
    }
    void signal;
    const rejected = await second.ended;
    const ok = rejected.type === 'error' && !rejected.cancelled;
    send(worker, { type: 'cancel', jobId: 'job-1' });
    await first.ended.catch(() => undefined);
    return {
      name: 'Nur ein Trennjob je Tab',
      pass: ok,
      detail:
        rejected.type === 'error'
          ? `Der zweite Auftrag wurde abgewiesen: ${rejected.message}`
          : 'Der zweite Auftrag wurde angenommen, statt abgewiesen zu werden.',
    };
  } catch (err) {
    return {
      name: 'Nur ein Trennjob je Tab',
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    worker.terminate();
  }
}

/**
 * Ein Block genau und ein Block mit Rest.
 *
 * Der letzte Block eines Songs ist fast immer kürzer als 7,8 s und wird
 * mittig mit Stille umgeben. Alle Spuren müssen danach dieselbe Länge und
 * denselben Zeitursprung haben wie die Eingabe — sonst läge das Deck
 * daneben, und zwar genau am Ende.
 */
async function blockEdges(workerUrl: string, dspUrl: string, modelId: string): Promise<Check[]> {
  const out: Check[] = [];
  const cases: { label: string; samples: number }[] = [
    { label: 'genau ein Block', samples: 343980 },
    { label: 'ein Block und ein Rest von 0,2 s', samples: 343980 + 8820 },
    { label: 'kürzer als ein Block (3 s)', samples: 3 * RATE },
  ];
  const worker = open(workerUrl, dspUrl);
  try {
    for (const c of cases) {
      const jobId = `edge-${c.samples}`;
      const run = collect(worker, jobId);
      send(
        worker,
        {
          type: 'start',
          jobId,
          modelId,
          channels: makeReferenceSignal(c.samples, RATE),
          sampleRate: RATE,
          preferGpu: true,
        },
        [],
      );
      const result = await run.ended;
      if (result.type !== 'done') {
        out.push({
          name: `Blockgrenze: ${c.label}`,
          pass: false,
          detail: result.type === 'error' ? result.message : result.type,
        });
        continue;
      }
      const lengths = new Set(
        result.stems.flatMap((s) => s.channels.map((ch) => ch.length)),
      );
      const right = lengths.size === 1 && lengths.has(c.samples);
      // Nicht still: ein falsch zusammengesetzter letzter Block kann als
      // Stille herauskommen, und die hätte auch die richtige Länge.
      let peak = 0;
      for (const stem of result.stems) {
        for (const channel of stem.channels) {
          for (let i = 0; i < channel.length; i += 31) {
            peak = Math.max(peak, Math.abs(channel[i]));
          }
        }
      }
      out.push({
        name: `Blockgrenze: ${c.label}`,
        pass: right && peak > 0.01,
        detail:
          `${result.stems.length} Spuren, Längen ${[...lengths].join('/')} ` +
          `(erwartet ${c.samples}), größter Ausschlag ${peak.toFixed(3)}, ` +
          `${result.timings.blocks} Block/Blöcke`,
      });
    }
  } catch (err) {
    out.push({
      name: 'Blockgrenzen',
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    worker.terminate();
  }
  return out;
}

/**
 * Derselbe Song zweimal ergibt zweimal dasselbe.
 *
 * Der Browserpfad rechnet ohne Zufallsversatz (`shifts = 0`), ist also
 * deterministisch. Wäre er es nicht, liesse sich keine der Messungen hier
 * wiederholen.
 */
async function deterministic(workerUrl: string, dspUrl: string, modelId: string): Promise<Check> {
  const worker = open(workerUrl, dspUrl);
  try {
    const results: Float32Array[] = [];
    for (const jobId of ['det-1', 'det-2']) {
      const run = collect(worker, jobId);
      send(worker, {
        type: 'start',
        jobId,
        modelId,
        channels: makeReferenceSignal(343980, RATE),
        sampleRate: RATE,
        preferGpu: true,
      });
      const result = await run.ended;
      if (result.type !== 'done') {
        return {
          name: 'Zwei gleiche Läufe liefern dasselbe',
          pass: false,
          detail: result.type === 'error' ? result.message : result.type,
        };
      }
      results.push(result.stems[0].channels[0]);
    }
    let worst = 0;
    for (let i = 0; i < results[0].length; i += 17) {
      worst = Math.max(worst, Math.abs(results[0][i] - results[1][i]));
    }
    return {
      name: 'Zwei gleiche Läufe liefern dasselbe',
      pass: worst === 0,
      detail:
        worst === 0
          ? 'Wert für Wert gleich.'
          : `größter Unterschied ${worst.toExponential(2)}`,
    };
  } finally {
    worker.terminate();
  }
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Bedingung nach ${timeoutMs} ms nicht erfüllt`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Eine echte Datei dekodieren — in der Regel eine MP3.
 *
 * Die uebrigen Dekodierpruefungen arbeiten mit WAV, weil der Browser keine
 * MP3 schreiben kann und eine mitgelieferte Datei im Repo laege. Wird dem
 * Pruefstand eine Datei uebergeben, wird genau dieser Weg gegangen: MP3
 * hinein, 44 100 Hz und zwei Kanaele heraus.
 */
async function decodeRealFile(url: string): Promise<Check> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const decoded = await decodeForModel(blob, RATE, CHANNELS);
    let peak = 0;
    for (let i = 0; i < decoded.channels[0].length; i += 37) {
      peak = Math.max(peak, Math.abs(decoded.channels[0][i]));
    }
    const name = url.split('/').pop() ?? url;
    return {
      name: `Dekodieren: ${name}`,
      pass:
        decoded.channels.length === CHANNELS &&
        decoded.sampleRate === RATE &&
        decoded.duration > 1 &&
        peak > 0.01,
      detail:
        `${decoded.channels.length} Kanäle, ${decoded.sampleRate} Hz, ` +
        `${decoded.duration.toFixed(1)} s, Spitze ${peak.toFixed(3)}` +
        (decoded.notes.length ? `; ${decoded.notes.join(' ')}` : ''),
    };
  } catch (err) {
    return {
      name: `Dekodieren: ${url}`,
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

window.runSeparateChecks = async (workerUrl, dspUrl, modelId, songUrl) => {
  const checks: Check[] = [];
  checks.push(...(await decodeChecks()));
  if (songUrl) checks.push(await decodeRealFile(songUrl));
  checks.push(await oneAtATime(workerUrl, dspUrl, modelId));
  checks.push(...(await cancelAndRestart(workerUrl, dspUrl, modelId)));
  checks.push(...(await blockEdges(workerUrl, dspUrl, modelId)));
  checks.push(await deterministic(workerUrl, dspUrl, modelId));
  return checks;
};
