/**
 * Prueft die Mix-Engine im Browser gegen einen OfflineAudioContext.
 *
 * Gepruefte Zusagen:
 *  1. Zwei Spuren mit Klicks auf denselben Zeitpunkten bleiben zusammen.
 *  2. Auch nach einem Seek.
 *  3. Auch ueber mehrere Loop-Durchlaeufe.
 *  4. Auch nach dem Wechsel von Solo zurueck in den Mix, und der Mix setzt
 *     an der gerade gehoerten Stelle mit dem Master-Tempo fort.
 *  5. Tempo und Tonhoehe sind unabhaengig: Tempo aendert die Geschwindigkeit
 *     ohne die Tonhoehe, Pitch aendert die Tonhoehe ohne Dauer und Position.
 *
 * Die Klickspuren liegen auf verschiedenen Frequenzen (1000 und 2500 Hz).
 * Deshalb lassen sie sich im gemischten Ergebnis getrennt vermessen, und
 * gemessen wird das, was wirklich am Ausgang ankommt.
 */
import { MixEngine, type StemSource } from '../../src/app/audio/mix-engine';
import { bandEnvelope, bestLag, normalize, onsets, rms, zeroCrossingFreq } from './analysis';
import { SR, clickTrack, sineTrack, wavBlobUrl } from './signals';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const HOP = 16;
const CLICK_A_HZ = 1000;
const CLICK_B_HZ = 2500;
const STEM_SECONDS = 30;

let cached: { a: string; b: string; sine: string } | null = null;

function stemUrls() {
  cached ??= {
    a: wavBlobUrl(clickTrack(STEM_SECONDS, CLICK_A_HZ)),
    b: wavBlobUrl(clickTrack(STEM_SECONDS, CLICK_B_HZ)),
    sine: wavBlobUrl(sineTrack(STEM_SECONDS, 440)),
  };
  return cached;
}

function clickStems(): StemSource[] {
  const u = stemUrls();
  return [
    { slug: 'click-a', name: 'Click A', url: u.a, downloadUrl: u.a },
    { slug: 'click-b', name: 'Click B', url: u.b, downloadUrl: u.b },
  ];
}

function sineStems(): StemSource[] {
  const u = stemUrls();
  return [{ slug: 'sine', name: 'Sine 440', url: u.sine, downloadUrl: u.sine }];
}

/**
 * Dieselben Klickspuren, aber als Abtastwerte statt als Adresse.
 *
 * Das ist der Weg des Browserpfads: dort liegen die Spuren schon im
 * Arbeitsspeicher und werden nicht geholt und dekodiert. Weil die Spuren
 * identisch sind, muss die Messung identisch ausfallen — tut sie es nicht,
 * geht beim Uebergeben an das Worklet etwas verloren, und das waere am
 * Versatz zwischen den Spuren zu sehen.
 */
function clickStemsInMemory(): StemSource[] {
  const a = clickTrack(STEM_SECONDS, CLICK_A_HZ);
  const b = clickTrack(STEM_SECONDS, CLICK_B_HZ);
  return [
    {
      slug: 'click-a',
      name: 'Click A',
      url: '',
      downloadUrl: '',
      channels: [new Float32Array(a), new Float32Array(a)],
      sampleRate: SR,
    },
    {
      slug: 'click-b',
      name: 'Click B',
      url: '',
      downloadUrl: '',
      channels: [new Float32Array(b), new Float32Array(b)],
      sampleRate: SR,
    },
  ];
}

/** Auf ein Render-Quantum runden: `suspend` verlangt das. */
function quantize(t: number): number {
  return (Math.round((t * SR) / 128) * 128) / SR;
}

interface RenderOptions {
  lengthS: number;
  stems: StemSource[];
  /** Vor dem Start, mit noch stehender Zeit. */
  before?: (engine: MixEngine) => void;
  /** Eingriffe mitten im Rendern. */
  at?: Array<{ t: number; fn: (engine: MixEngine) => void }>;
}

async function render(opts: RenderOptions): Promise<{ buffer: AudioBuffer; engine: MixEngine }> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(opts.lengthS * SR),
    sampleRate: SR,
  });
  const engine = new MixEngine();
  engine.createAudioContext = () => ctx as unknown as AudioContext;

  await engine.load(opts.stems);
  if (engine.error()) throw new Error(`Laden fehlgeschlagen: ${engine.error()}`);
  opts.before?.(engine);
  await engine.play();

  for (const step of opts.at ?? []) {
    void ctx.suspend(quantize(step.t)).then(() => {
      step.fn(engine);
      void ctx.resume();
    });
  }

  const buffer = await ctx.startRendering();
  return { buffer, engine };
}

function slice(buffer: AudioBuffer, fromS: number, toS: number): Float32Array {
  const data = buffer.getChannelData(0);
  const from = Math.max(0, Math.round(fromS * buffer.sampleRate));
  const to = Math.min(data.length, Math.round(toS * buffer.sampleRate));
  return data.slice(from, to);
}

/** Verschiebung der beiden Klickspuren gegeneinander, in Millisekunden. */
function clickOffsetMs(buffer: AudioBuffer, fromS: number, toS: number): number {
  const seg = slice(buffer, fromS, toS);
  const envA = normalize(bandEnvelope(seg, SR, CLICK_A_HZ, 128, HOP));
  const envB = normalize(bandEnvelope(seg, SR, CLICK_B_HZ, 128, HOP));
  const maxLag = Math.round((0.05 * SR) / HOP);
  const { lag } = bestLag(envA, envB, maxLag);
  return (lag * HOP * 1000) / SR;
}

function clickTimes(buffer: AudioBuffer, fromS: number, toS: number, freq: number): number[] {
  const seg = slice(buffer, fromS, toS);
  const env = bandEnvelope(seg, SR, freq, 128, HOP);
  return onsets(env, HOP, SR);
}

function spacings(times: number[]): number[] {
  return times.slice(1).map((t, i) => +(t - times[i]).toFixed(3));
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// --------------------------------------------------------------------- Pruefungen

async function checkSyncPlain(): Promise<CheckResult> {
  const { buffer } = await render({ lengthS: 6, stems: clickStems() });
  const offset = clickOffsetMs(buffer, 0.6, 6);
  const times = clickTimes(buffer, 0.6, 6, CLICK_A_HZ);
  const gaps = spacings(times);
  const worstGap = gaps.length ? Math.max(...gaps.map((g) => Math.abs(g - 1))) : 1;
  const pass = Math.abs(offset) < 1 && worstGap < 0.02 && times.length >= 4;
  return {
    name: '1. Zwei Klickspuren laufen synchron',
    pass,
    detail:
      `Versatz der Spuren ${fmt(offset)} ms; ${times.length} Klicks, ` +
      `Abstaende ${gaps.join(', ')} s (erwartet 1,0)`,
  };
}

/**
 * Dasselbe wie Pruefung 1, nur mit Spuren aus dem Arbeitsspeicher.
 *
 * Der Browserpfad gibt dem Deck keine Adressen, sondern die fertigen
 * Abtastwerte. Gemessen wird deshalb noch einmal dasselbe: wenn das
 * Uebergeben an das Worklet einen Kanal verschiebt, verdoppelt oder
 * verschluckt, steht es hier.
 */
async function checkSyncFromMemory(): Promise<CheckResult> {
  const { buffer, engine } = await render({ lengthS: 6, stems: clickStemsInMemory() });
  const offset = clickOffsetMs(buffer, 0.6, 6);
  const times = clickTimes(buffer, 0.6, 6, CLICK_A_HZ);
  const gaps = spacings(times);
  const worstGap = gaps.length ? Math.max(...gaps.map((g) => Math.abs(g - 1))) : 1;
  // Die Laenge muss aus den Abtastwerten kommen, nicht aus einem Dekoder.
  const duration = engine.duration();
  const rightLength = Math.abs(duration - STEM_SECONDS) < 0.01;
  const pass = Math.abs(offset) < 1 && worstGap < 0.02 && times.length >= 4 && rightLength;
  return {
    name: '10. Spuren aus dem Arbeitsspeicher laufen genauso synchron',
    pass,
    detail:
      `Versatz der Spuren ${fmt(offset)} ms; ${times.length} Klicks, ` +
      `Abstaende ${gaps.join(', ')} s (erwartet 1,0); Laenge ${fmt(duration)} s ` +
      `(erwartet ${STEM_SECONDS})`,
  };
}

async function checkSyncAfterSeek(): Promise<CheckResult> {
  const { buffer } = await render({
    lengthS: 8,
    stems: clickStems(),
    at: [{ t: 1.5, fn: (e) => e.seek(10) }],
  });
  const offset = clickOffsetMs(buffer, 3, 8);
  const times = clickTimes(buffer, 3, 8, CLICK_A_HZ);
  const gaps = spacings(times);
  const worstGap = gaps.length ? Math.max(...gaps.map((g) => Math.abs(g - 1))) : 1;
  const pass = Math.abs(offset) < 1 && worstGap < 0.02 && times.length >= 4;
  return {
    name: '2. Synchron nach Seek auf Sekunde 10',
    pass,
    detail:
      `Versatz ${fmt(offset)} ms; ${times.length} Klicks nach dem Sprung, ` +
      `Abstaende ${gaps.join(', ')} s (erwartet 1,0)`,
  };
}

async function checkSyncOverLoop(): Promise<CheckResult> {
  // Loop 2,25 bis 4,75 s, also 2,5 s lang. Die Klicks liegen auf ganzen
  // Sekunden und damit bewusst **nicht** auf der Loop-Grenze: ein Transient
  // genau am Umschaltpunkt wird vom Loop-Uebergang verschliffen und waere
  // kein Mass fuer die Synchronitaet.
  // Pro Durchlauf sind die Klicks bei Songsekunde 3 und 4 zu hoeren. In
  // Renderzeit ergibt das abwechselnd 1,0 s und 1,5 s Abstand, zusammen die
  // Loop-Laenge von 2,5 s.
  const { buffer } = await render({
    lengthS: 13,
    stems: clickStems(),
    before: (e) => {
      e.setLoop(2.25, 4.75);
      e.seek(2.25);
    },
  });
  const offsetEarly = clickOffsetMs(buffer, 1, 5);
  const offsetLate = clickOffsetMs(buffer, 9, 13);
  const gaps = spacings(clickTimes(buffer, 1, 13, CLICK_A_HZ));

  const near = (g: number, target: number) => Math.abs(g - target) < 0.06;
  const allKnown = gaps.every((g) => near(g, 1) || near(g, 1.5));
  const alternates = gaps.every((g, i) => (i === 0 ? true : near(g, 1) !== near(gaps[i - 1], 1)));
  // Je zwei aufeinanderfolgende Abstaende sind ein Durchlauf.
  const periods = gaps.slice(1).map((g, i) => g + gaps[i]);
  const periodWorst = periods.length ? Math.max(...periods.map((p) => Math.abs(p - 2.5))) : 1;
  const passCount = gaps.filter((g) => near(g, 1.5)).length;

  const pass =
    Math.abs(offsetEarly) < 1 &&
    Math.abs(offsetLate) < 1 &&
    allKnown &&
    alternates &&
    periodWorst < 0.06 &&
    passCount >= 4;
  return {
    name: '3. Synchron ueber mehrere Loop-Durchlaeufe',
    pass,
    detail:
      `Versatz am Anfang ${fmt(offsetEarly)} ms, am Ende ${fmt(offsetLate)} ms; ` +
      `${passCount} Durchlaeufe; Abstaende ${gaps.join(', ')} s ` +
      `(erwartet 1,0 und 1,5 abwechselnd); groesste Abweichung der ` +
      `Loop-Laenge ${fmt(periodWorst, 3)} s von 2,5 s`,
  };
}

async function checkSoloBackToMix(): Promise<CheckResult> {
  // Click A solo mit 60 Prozent Tempo, dann zurueck in den Mix.
  const { buffer } = await render({
    lengthS: 10,
    stems: clickStems(),
    before: (e) => {
      e.setSoloRate('click-a', 0.6);
      e.toggleSolo('click-a');
    },
    at: [{ t: 4.5, fn: (e) => e.clearSolo() }],
  });

  // Waehrend Solo darf die zweite Spur nicht zu hoeren sein. Hier wird der
  // **Rohpegel** im 2500-Hz-Band gemessen, nicht die normierte Huellkurve:
  // normieren wuerde genau den Pegelunterschied wegrechnen, um den es geht.
  const bHeardWhileSolo = rms(bandEnvelope(slice(buffer, 1, 4), SR, CLICK_B_HZ, 128, HOP));
  const bHeardAfter = rms(bandEnvelope(slice(buffer, 6, 10), SR, CLICK_B_HZ, 128, HOP));
  const ratio = bHeardWhileSolo > 0 ? bHeardAfter / bHeardWhileSolo : Infinity;

  // Klickabstand im Solo: 1 s Songzeit bei 60 Prozent Tempo = 1,667 s.
  const soloGaps = spacings(clickTimes(buffer, 0.6, 4.4, CLICK_A_HZ));
  const soloWorst = soloGaps.length
    ? Math.max(...soloGaps.map((g) => Math.abs(g - 1 / 0.6)))
    : 1;
  // Nach dem Verlassen wieder Master-Tempo, also 1,0 s.
  const mixGaps = spacings(clickTimes(buffer, 5.5, 10, CLICK_A_HZ));
  const mixWorst = mixGaps.length ? Math.max(...mixGaps.map((g) => Math.abs(g - 1))) : 1;
  const offset = clickOffsetMs(buffer, 5.5, 10);

  const pass =
    soloWorst < 0.05 &&
    mixWorst < 0.03 &&
    Math.abs(offset) < 1 &&
    ratio > 4;
  return {
    name: '4. Solo mit eigenem Tempo, dann synchron zurueck in den Mix',
    pass,
    detail:
      `Solo-Abstaende ${soloGaps.join(', ')} s (erwartet 1,667 bei 60 Prozent); ` +
      `nach Mix ${mixGaps.join(', ')} s (erwartet 1,0); Versatz danach ${fmt(offset)} ms; ` +
      `Pegel der zweiten Spur waehrend Solo ${bHeardWhileSolo.toExponential(2)}, ` +
      `danach ${bHeardAfter.toExponential(2)} (Faktor ${fmt(ratio, 1)})`,
  };
}

async function checkTempoKeepsPitch(): Promise<CheckResult> {
  const { buffer, engine } = await render({
    lengthS: 5,
    stems: sineStems(),
    before: (e) => e.setMasterRate(0.5),
  });
  const seg = slice(buffer, 2, 4);
  const freq = zeroCrossingFreq(seg, SR);
  const level = rms(seg);
  // Bei halbem Tempo ist nach 5 s Audiozeit rund die halbe Songzeit vergangen.
  const pos = engine.currentPosition();
  const expectedPos = (5 - 0.12) * 0.5;
  const pass = Math.abs(freq - 440) < 4 && Math.abs(pos - expectedPos) < 0.15;
  return {
    name: '5. Master-Tempo 50 Prozent laesst die Tonhoehe gleich',
    pass,
    detail:
      `gemessen ${fmt(freq, 1)} Hz (erwartet 440), Pegel ${level.toExponential(2)}; ` +
      `Songposition nach 5 s ${fmt(pos)} s (erwartet rund ${fmt(expectedPos)})`,
  };
}

async function checkPitchKeepsTempo(): Promise<CheckResult> {
  const { buffer, engine } = await render({
    lengthS: 5,
    stems: sineStems(),
    before: (e) => e.setSemitones('sine', 12),
  });
  const freq = zeroCrossingFreq(slice(buffer, 2, 4), SR);
  const pos = engine.currentPosition();
  const expectedPos = 5 - 0.12;
  const pass = Math.abs(freq - 880) < 8 && Math.abs(pos - expectedPos) < 0.15;
  return {
    name: '6. Pitch plus 12 Halbtoene laesst Dauer und Position gleich',
    pass,
    detail:
      `gemessen ${fmt(freq, 1)} Hz (erwartet 880); Songposition nach 5 s ` +
      `${fmt(pos)} s (erwartet rund ${fmt(expectedPos)}, also unveraendert)`,
  };
}

async function checkPitchSevenSemitones(): Promise<CheckResult> {
  const { buffer } = await render({
    lengthS: 5,
    stems: sineStems(),
    before: (e) => e.setSemitones('sine', 7),
  });
  const freq = zeroCrossingFreq(slice(buffer, 2, 4), SR);
  const expected = 440 * Math.pow(2, 7 / 12);
  const pass = Math.abs(freq - expected) < 8;
  return {
    name: '7. Pitch plus 7 Halbtoene trifft die Quinte',
    pass,
    detail: `gemessen ${fmt(freq, 1)} Hz (erwartet ${fmt(expected, 1)})`,
  };
}

async function checkTempoAndPitchTogether(): Promise<CheckResult> {
  const { buffer } = await render({
    lengthS: 5,
    stems: sineStems(),
    before: (e) => {
      e.setMasterRate(0.75);
      e.setSemitones('sine', -5);
    },
  });
  const freq = zeroCrossingFreq(slice(buffer, 2, 4), SR);
  const expected = 440 * Math.pow(2, -5 / 12);
  const pass = Math.abs(freq - expected) < 8;
  return {
    name: '8. Tempo 75 Prozent und Pitch minus 5 greifen unabhaengig',
    pass,
    detail: `gemessen ${fmt(freq, 1)} Hz (erwartet ${fmt(expected, 1)}, vom Tempo unberuehrt)`,
  };
}

/**
 * Die Wiedergabeposition darf bei keiner Umschaltung zuruecklaufen. Geprueft
 * wird quer durch Tempowechsel, Solo mit eigenem Tempo und Solo-Ende, indem
 * die Position an vielen Zeitpunkten mitten im Rendern abgelesen wird.
 */
async function checkPositionMonotone(): Promise<CheckResult> {
  const samples: Array<{ t: number; pos: number }> = [];
  const probes: RenderOptions['at'] = [];
  for (let t = 0.5; t < 9.5; t += 0.25) {
    const at = t;
    probes.push({ t: at, fn: (e) => samples.push({ t: at, pos: e.currentPosition() }) });
  }
  // Umschaltungen zwischen die Messpunkte legen.
  probes.push({ t: 2.6, fn: (e) => e.setMasterRate(0.7) });
  probes.push({ t: 4.1, fn: (e) => e.toggleSolo('click-a') });
  probes.push({ t: 6.1, fn: (e) => e.clearSolo() });
  probes.sort((x, y) => x.t - y.t);

  await render({
    lengthS: 10,
    stems: clickStems(),
    before: (e) => e.setSoloRate('click-a', 0.55),
    at: probes,
  });

  let worstDrop = 0;
  let where = 0;
  for (let i = 1; i < samples.length; i++) {
    const drop = samples[i - 1].pos - samples[i].pos;
    if (drop > worstDrop) {
      worstDrop = drop;
      where = samples[i].t;
    }
  }
  const pass = samples.length > 20 && worstDrop <= 0.001;
  return {
    name: '9. Position laeuft bei Umschaltungen nie zurueck',
    pass,
    detail:
      `${samples.length} Messpunkte ueber Tempowechsel, Solo mit 55 Prozent und ` +
      `Solo-Ende; groesster Ruecksprung ${(worstDrop * 1000).toFixed(2)} ms` +
      (worstDrop > 0.001 ? ` bei Sekunde ${where}` : ''),
  };
}

/**
 * Die Pruefungen laufen einzeln, jede in einem frischen Seitenaufruf.
 * Grund: jede Pruefung braucht ihren eigenen AudioContext, und ein Browser
 * laesst nur eine kleine Zahl gleichzeitig offener Contexts zu. Ein
 * OfflineAudioContext hat kein `close()`, also kann ihn nur der Seitenwechsel
 * sicher freigeben.
 */
const CHECKS: Array<() => Promise<CheckResult>> = [
  checkSyncPlain,
  checkSyncAfterSeek,
  checkSyncOverLoop,
  checkSoloBackToMix,
  checkTempoKeepsPitch,
  checkPitchKeepsTempo,
  checkPitchSevenSemitones,
  checkTempoAndPitchTogether,
  checkPositionMonotone,
  checkSyncFromMemory,
];

export async function runEngineCheck(index: number): Promise<CheckResult> {
  const check = CHECKS[index];
  if (!check) throw new Error(`Keine Pruefung mit Index ${index}`);
  try {
    return await check();
  } catch (err) {
    return {
      name: `Pruefung ${index + 1}`,
      pass: false,
      detail: `Ausnahme: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

declare global {
  interface Window {
    runEngineCheck?: (index: number) => Promise<CheckResult>;
    engineCheckCount?: number;
  }
}
window.runEngineCheck = runEngineCheck;
window.engineCheckCount = CHECKS.length;
