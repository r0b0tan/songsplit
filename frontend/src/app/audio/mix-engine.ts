import { Injectable, computed, signal } from '@angular/core';

import { createStretchNode, type StretchNode } from './signalsmith';

/** A/B-Loop, Sekunden im Originalsong. */
export interface LoopRange {
  a: number;
  b: number;
}

/**
 * Huellkurve einer Spur: je Abschnitt der kleinste und groesste Ausschlag.
 * Daraus wird die Wellenform gezeichnet. Rund 32 kB pro Spur, waehrend die
 * Spur selbst zweistellige Megabyte belegt: die Rohdaten muessen fuer die
 * Darstellung also nicht im Javascript-Speicher bleiben.
 */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  buckets: number;
}

/** Aufloesung der Huellkurve. Breiter als jeder uebliche Bildschirm. */
const PEAK_BUCKETS = 4096;

function computePeaks(
  channels: readonly Float32Array[],
  buckets = PEAK_BUCKETS,
): Peaks {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const frames = channels[0]?.length ?? 0;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * frames) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * frames) / buckets));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      for (let i = from; i < to && i < frames; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, buckets };
}

export interface TrackView {
  slug: string;
  name: string;
  downloadUrl: string;
  /** 0 bis 1.5 */
  volume: number;
  muted: boolean;
  solo: boolean;
  /** Halbtoene, ganzzahlig */
  semitones: number;
  /** Solo-Tempo dieser Spur als Faktor, z. B. 0.75 */
  soloRate: number;
  /** Huellkurve fuer die Wellenform, sobald die Spur dekodiert ist. */
  peaks: Peaks | null;
  /** Belegter Audiospeicher dieser Spur in Byte. */
  bytes: number;
  state: 'loading' | 'ready' | 'error';
  error?: string;
}

export interface StemSource {
  slug: string;
  name: string;
  url: string;
  downloadUrl: string;
  /**
   * Fertige Abtastwerte, falls die Spur nicht geholt werden muss.
   *
   * Der Browserpfad trennt im Arbeitsspeicher und hat die Werte schon da.
   * Sie erst als WAV zu schreiben, in eine Blob-URL zu stecken und wieder
   * zu dekodieren waere derselbe Umweg zweimal — und waehrend des Umwegs
   * laegen sie doppelt im Speicher. Ist `channels` gesetzt, bleiben `url`
   * und `downloadUrl` leer.
   */
  channels?: Float32Array[];
  /** Abtastrate von `channels`. Der Context wird darauf angelegt. */
  sampleRate?: number;
}

interface Track {
  slug: string;
  name: string;
  url: string;
  downloadUrl: string;
  channels: Float32Array[] | null;
  node: StretchNode | null;
  gain: GainNode | null;
  /** Abgriff hinter dem Gain, nur zum Messen des Pegels. */
  analyser: AnalyserNode | null;
  /** Wiederverwendeter Puffer fuer die Pegelmessung. */
  scratch: Float32Array<ArrayBuffer> | null;
  duration: number;
  volume: number;
  muted: boolean;
  solo: boolean;
  semitones: number;
  soloRate: number;
  peaks: Peaks | null;
  bytes: number;
  state: 'loading' | 'ready' | 'error';
  error?: string;
}

/**
 * Zeitanker: ab der Audiozeit `outputTime` steht die Wiedergabe bei `songPos`
 * und laeuft von dort mit `rate` weiter, mit `loop` als Umlaufbereich.
 * `rate: 0` heisst: steht still.
 */
interface Anchor {
  outputTime: number;
  songPos: number;
  rate: number;
  loop: LoopRange | null;
}

export const MASTER_RATE_MIN = 0.5;
export const MASTER_RATE_MAX = 1.25;
export const SOLO_RATE_MIN = 0.5;
export const SOLO_RATE_MAX = 1.25;
export const SEMITONE_RANGE = 12;
/**
 * Kuerzester sinnvoller Loop. Darunter laesst `setLoop` den Loop fallen,
 * und die Marken A und B halten diesen Abstand ein.
 */
export const LOOP_MIN_SECONDS = 0.25;

/** Fenster der Pegelmessung. 256 Abtastwerte sind rund 5 ms. */
const METER_FFT = 256;
/** Abfall des Pegels je Bildaufbau, damit die Anzeige nicht flackert. */
const METER_FALL = 0.86;
/** Darunter gilt der Pegel als Null. Rund minus 46 dB. */
const METER_FLOOR = 0.005;

/** Untergrenze fuer die Vorlaufzeit beim Umplanen, in Sekunden. */
const LEAD_MIN = 0.08;
const LEAD_MAX = 0.3;

/**
 * Spielt alle Spuren eines Jobs auf einem gemeinsamen AudioContext.
 *
 * Aufbau pro Spur: Stretch-Knoten -> Gain -> Master-Gain -> Ausgang.
 *
 * Alle Positionen sind **Sekunden im Originalsong**. Der Stretch-Knoten
 * rechnet in genau dieser Groesse (`input`), unabhaengig von Tempo und
 * Tonhoehe. Damit bleiben Anzeige und Loop-Marken immer im Originalmass.
 *
 * Die eine Regel, aus der die Synchronitaet folgt: jede Aenderung laeuft
 * durch `reschedule()`, und dort bekommt **jede** Spur denselben
 * `output`-Zeitpunkt und denselben `input`-Wert. Spuren koennen deshalb
 * nicht auseinanderlaufen, auch nicht nach Seek, Loop oder Solo-Wechsel.
 */
@Injectable({ providedIn: 'root' })
export class MixEngine {
  // ------------------------------------------------------------- oeffentlich
  readonly tracks = signal<TrackView[]>([]);
  readonly playing = signal(false);
  readonly position = signal(0);
  readonly duration = signal(0);
  readonly masterRate = signal(1);
  readonly loop = signal<LoopRange | null>(null);
  readonly loopEnabled = signal(true);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly sampleRate = signal(0);
  /**
   * Pegel je Spur, 0 bis 1, aus dem laufenden Ton gemessen — nicht aus dem
   * Reglerwert gerechnet. Stumme und nicht hoerbare Spuren stehen auf 0,
   * weil hinter dem Gain gemessen wird.
   */
  readonly levels = signal<Record<string, number>>({});

  /** Insgesamt von den Spuren belegter Audiospeicher, in Byte. */
  readonly memoryBytes = computed(() =>
    this.tracks().reduce((sum, t) => sum + t.bytes, 0),
  );

  /** Eigenlatenz der Stretch-Knoten in Millisekunden. */
  readonly nodeLatencyMs = signal<number | null>(null);
  /** Vorlaufzeit, mit der Umschaltungen geplant werden, in Millisekunden. */
  readonly leadMs = signal<number | null>(null);

  /** Die einzige Solo-Spur, falls genau eine aktiv ist. */
  readonly loneSolo = computed(() => {
    const solos = this.tracks().filter((t) => t.solo);
    return solos.length === 1 ? solos[0] : null;
  });

  /** Tempo, mit dem gerade tatsaechlich abgespielt wird. */
  readonly effectiveRateView = computed(() => {
    const lone = this.loneSolo();
    return lone ? lone.soloRate : this.masterRate();
  });

  /**
   * Erzeugt den AudioContext. Ueberschreibbar, damit die Engine auch gegen
   * einen OfflineAudioContext laufen kann: dann ist die Wiedergabe
   * deterministisch und laesst sich Sample fuer Sample nachrechnen.
   * Genau das nutzt `tests/audio/engine-check.ts`.
   */
  /**
   * Der Context. `rate` wird gesetzt, wenn die Spuren aus dem Speicher
   * kommen: dort gibt es kein `decodeAudioData`, das umrechnen koennte, also
   * muss der Context in der Rate der Spuren laufen. Sonst liefe der ganze
   * Song zu schnell oder zu langsam — bei 44,1 gegen 48 kHz um fast einen
   * Halbton.
   */
  createAudioContext: (rate?: number) => AudioContext = (rate) =>
    rate ? new AudioContext({ sampleRate: rate }) : new AudioContext();

  // --------------------------------------------------------------- intern
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private trackList: Track[] = [];
  private anchor: Anchor | null = null;
  /**
   * Der Anker, der bis `anchor.outputTime` noch gilt. Jede Umplanung greift
   * erst eine Vorlaufzeit spaeter; bis dahin klingt die vorherige Planung.
   * Ohne diesen Anker wuerde die Anzeige den neuen Zustand zu frueh
   * hochrechnen und bei einem Tempowechsel kurz zuruecklaufen.
   */
  private anchorPrev: Anchor | null = null;
  /** Position, wenn nichts laeuft. */
  private restPos = 0;
  private lead = 0.12;
  private frame = 0;
  /** Solo-Tempo pro Spur, ueberlebt den Wechsel zu einer anderen Spur. */
  private readonly soloRateMemory = new Map<string, number>();
  /**
   * Letzter ungerundeter Pegel je Spur. Der Nachlauf rechnet mit diesem
   * Wert, nicht mit dem angezeigten: aus dem gerundeten heraus faende das
   * Abklingen keinen Weg mehr nach Null (0,03 mal 0,86 rundet wieder auf
   * 0,03), und jeder Pegel bliebe fuer immer ein Haar ueber Null stehen.
   */
  private readonly meterMemory = new Map<string, number>();
  private loadToken = 0;
  /** Bricht die laufenden Downloads ab, wenn das Deck zugeht. */
  private loadAbort: AbortController | null = null;

  // ------------------------------------------------------------------ laden
  /** Laedt die Spuren eines Jobs. Ein laufender Ladevorgang wird verworfen. */
  async load(stems: StemSource[]): Promise<void> {
    // Erst abbauen, dann die neue Marke ziehen: `teardown` verwirft laufende
    // Ladevorgaenge ueber genau diese Marke, und das darf den eigenen nicht
    // treffen.
    this.teardown();
    const token = ++this.loadToken;
    const abort = new AbortController();
    this.loadAbort = abort;
    this.loading.set(true);
    this.error.set(null);

    try {
      const inMemoryRate = stems.find((s) => s.channels)?.sampleRate;
      const ctx = this.createAudioContext(inMemoryRate);
      this.ctx = ctx;
      this.sampleRate.set(ctx.sampleRate);
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      this.master = master;

      this.trackList = stems.map((s) => ({
        slug: s.slug,
        name: s.name,
        url: s.url,
        downloadUrl: s.downloadUrl,
        channels: s.channels ?? null,
        node: null,
        gain: null,
        analyser: null,
        scratch: null,
        duration: 0,
        volume: 1,
        muted: false,
        solo: false,
        semitones: 0,
        soloRate: this.soloRateMemory.get(s.slug) ?? 1,
        peaks: null,
        bytes: 0,
        state: 'loading',
      }));
      this.publish();

      // Spuren parallel holen und dekodieren, danach erst verdrahten.
      await Promise.all(this.trackList.map((t) => this.loadTrack(ctx, master, t, token)));
      if (token !== this.loadToken) return;

      const ready = this.trackList.filter((t) => t.state === 'ready');
      if (!ready.length) {
        throw new Error('Keine einzige Spur konnte geladen werden.');
      }
      this.duration.set(Math.max(...ready.map((t) => t.duration)));

      // Vorlaufzeit aus der Eigenlatenz der Knoten ableiten.
      const latency = await ready[0].node!.latency();
      this.lead = Math.min(LEAD_MAX, Math.max(LEAD_MIN, latency + 0.03));
      this.nodeLatencyMs.set(Math.round(latency * 1000));
      this.leadMs.set(Math.round(this.lead * 1000));

      this.restPos = 0;
      this.position.set(0);
      this.publish();
      this.reschedule(0);
    } catch (err) {
      if (token === this.loadToken) {
        this.error.set(describe(err));
      }
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  private async loadTrack(
    ctx: AudioContext,
    master: GainNode,
    track: Track,
    token: number,
  ): Promise<void> {
    try {
      /** Die Rohdaten der Spur und ihre Laenge in Sekunden. */
      let source: readonly Float32Array[];
      let duration: number;

      if (track.channels) {
        // Browserpfad: die Werte liegen schon da. Sie gehoeren aber dem
        // `StemStore`, der sie fuer ein spaeteres Oeffnen und fuer den
        // WAV-Download behaelt. Weitergegeben wird deshalb die Kopie
        // unten, nicht das Original.
        source = track.channels;
        duration = track.channels[0].length / ctx.sampleRate;
        // Die Referenz hier loslassen: der Track haelt die Werte nicht, der
        // Store tut es.
        track.channels = null;
      } else {
        const response = await fetch(track.url, { signal: this.loadAbort?.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} beim Laden von ${track.name}`);
        }
        const bytes = await response.arrayBuffer();
        // decodeAudioData rechnet auf die Rate des Context um. Alle Spuren
        // bekommen dieselbe Behandlung, die Zeitachse bleibt die des Songs.
        const buffer = await ctx.decodeAudioData(bytes);
        if (token !== this.loadToken) return;
        const have: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          have.push(buffer.getChannelData(c));
        }
        source = have;
        duration = buffer.duration;
      }
      if (token !== this.loadToken) return;

      // Huellkurve jetzt berechnen, solange die Rohdaten noch da sind.
      // Danach wandern sie ins Worklet und werden hier nicht gehalten.
      const peaks = computePeaks(source);

      const node = await createStretchNode(ctx, 2);
      if (token !== this.loadToken) {
        node.disconnect();
        return;
      }

      // Immer zwei Kanaele: eine Monospur traegt beide Male dasselbe
      // Signal. `data` ist in jedem Fall frisch belegt — aus dem dekodierten
      // Puffer oder aus dem Speicher des Stores —, deshalb darf es
      // uebergeben werden.
      const last = source.length - 1;
      const data: Float32Array[] = [];
      for (let c = 0; c < 2; c++) {
        data.push(new Float32Array(source[Math.min(c, last)]));
      }
      const audioBytes = data.reduce((sum, d) => sum + d.byteLength, 0);
      // Uebergeben statt kopieren: nach diesem Aufruf gehoeren die
      // Speicherbereiche dem Worklet und sind hier leer.
      await node.addBuffers(
        data,
        data.map((d) => d.buffer),
      );

      const gain = ctx.createGain();
      gain.gain.value = track.volume;
      // Der Analyser liegt im Signalweg, gibt aber unveraendert weiter: er
      // misst damit genau das, was von dieser Spur im Mix landet.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = METER_FFT;
      node.connect(gain);
      gain.connect(analyser);
      analyser.connect(master);

      track.node = node;
      track.gain = gain;
      track.analyser = analyser;
      track.scratch = new Float32Array(analyser.fftSize);
      track.duration = duration;
      track.peaks = peaks;
      track.bytes = audioBytes;
      track.state = 'ready';
    } catch (err) {
      track.state = 'error';
      track.error = describe(err);
    } finally {
      if (token === this.loadToken) this.publish();
    }
  }

  // --------------------------------------------------------------- transport
  async play(): Promise<void> {
    if (!this.ctx || this.playing()) return;
    try {
      await this.ctx.resume();
    } catch {
      // Ein OfflineAudioContext laesst sich erst nach Renderstart fortsetzen.
      // Im Browser ist das der Normalfall und `resume` gelingt.
    }
    // Am Ende angekommen: von vorn, sonst startet nichts hoerbar.
    if (!this.activeLoop() && this.restPos >= this.duration() - 0.05) {
      this.restPos = 0;
    }
    this.playing.set(true);
    this.reschedule();
    this.startFrameLoop();
  }

  pause(): void {
    if (!this.ctx || !this.playing()) return;
    const pos = this.posAt(this.ctx.currentTime + this.lead);
    this.playing.set(false);
    this.reschedule(pos);
    this.stopFrameLoop();
    this.clearLevels();
  }

  async toggle(): Promise<void> {
    if (this.playing()) this.pause();
    else await this.play();
  }

  /** Springt auf eine Sekunde im Originalsong. */
  seek(seconds: number): void {
    this.reschedule(clamp(seconds, 0, this.duration()));
  }

  setMasterRate(rate: number): void {
    this.masterRate.set(clamp(rate, MASTER_RATE_MIN, MASTER_RATE_MAX));
    this.reschedule();
  }

  // ------------------------------------------------------------------ spuren
  setVolume(slug: string, volume: number): void {
    const track = this.find(slug);
    if (!track) return;
    track.volume = clamp(volume, 0, 1.5);
    this.publish();
    this.applyGains();
  }

  toggleMute(slug: string): void {
    const track = this.find(slug);
    if (!track) return;
    track.muted = !track.muted;
    this.publish();
    // Stummschalten aendert das Tempo nicht, also reicht die Lautstaerke.
    this.applyGains();
  }

  toggleSolo(slug: string): void {
    const track = this.find(slug);
    if (!track) return;
    const rateBefore = this.effectiveRate();
    track.solo = !track.solo;
    this.publish();
    this.applyGains();
    // Nur wenn sich das Tempo aendert, muss die Zeitachse neu gesetzt werden.
    // Genau das ist der Uebergang Solo -> Mix: der Mix laeuft an der gerade
    // gehoerten Stelle mit dem Master-Tempo weiter.
    if (this.effectiveRate() !== rateBefore) {
      this.reschedule();
    }
  }

  clearSolo(): void {
    if (!this.trackList.some((t) => t.solo)) return;
    const rateBefore = this.effectiveRate();
    for (const t of this.trackList) t.solo = false;
    this.publish();
    this.applyGains();
    if (this.effectiveRate() !== rateBefore) this.reschedule();
  }

  /** Tonhoehe einer Spur. Dauer und Position bleiben unberuehrt. */
  setSemitones(slug: string, semitones: number): void {
    const track = this.find(slug);
    if (!track) return;
    track.semitones = Math.round(clamp(semitones, -SEMITONE_RANGE, SEMITONE_RANGE));
    this.publish();
    // Umplanen mit unveraenderter Position und unveraendertem Tempo:
    // es wandert nur `semitones`.
    this.reschedule();
  }

  /** Solo-Tempo der Spur. Wirkt nur, solange genau diese Spur solo ist. */
  setSoloRate(slug: string, rate: number): void {
    const track = this.find(slug);
    if (!track) return;
    track.soloRate = clamp(rate, SOLO_RATE_MIN, SOLO_RATE_MAX);
    this.soloRateMemory.set(slug, track.soloRate);
    this.publish();
    const lone = this.trackList.filter((t) => t.solo);
    if (lone.length === 1 && lone[0] === track) {
      this.reschedule();
    }
  }

  // -------------------------------------------------------------------- loop
  setLoop(a: number, b: number): void {
    const lo = clamp(Math.min(a, b), 0, this.duration());
    const hi = clamp(Math.max(a, b), 0, this.duration());
    if (hi - lo < 0.2) {
      this.loop.set(null);
    } else {
      this.loop.set({ a: lo, b: hi });
    }
    this.reschedule();
  }

  /** Setzt A auf die aktuelle Position, B bleibt oder wird das Songende. */
  setLoopStartHere(): void {
    const pos = this.currentPosition();
    const existing = this.loop();
    const b = existing && existing.b > pos + 0.2 ? existing.b : this.duration();
    this.setLoop(pos, b);
  }

  /** Setzt B auf die aktuelle Position, A bleibt oder wird der Songanfang. */
  setLoopEndHere(): void {
    const pos = this.currentPosition();
    const existing = this.loop();
    const a = existing && existing.a < pos - 0.2 ? existing.a : 0;
    this.setLoop(a, pos);
  }

  clearLoop(): void {
    this.loop.set(null);
    this.reschedule();
  }

  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled.set(enabled);
    this.reschedule();
  }

  // ------------------------------------------------------------------ abbau
  /**
   * Haelt alles an und gibt alles frei — auch einen Ladevorgang, der noch
   * laeuft. Die Marke `loadToken` weiterzudrehen genuegt dafuer nicht: ein
   * halb geladener Song zoege sonst noch Minuten lang Daten, die niemand
   * mehr hoeren will.
   */
  teardown(): void {
    this.loadToken++;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.loading.set(false);
    this.error.set(null);
    this.stopFrameLoop();
    for (const t of this.trackList) {
      try {
        t.node?.disconnect();
        t.gain?.disconnect();
        t.analyser?.disconnect();
      } catch {
        /* beim Abbau nicht weiter wichtig */
      }
    }
    this.trackList = [];
    this.master?.disconnect();
    this.master = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.anchor = null;
    this.anchorPrev = null;
    this.restPos = 0;
    this.playing.set(false);
    this.position.set(0);
    this.duration.set(0);
    this.loop.set(null);
    this.nodeLatencyMs.set(null);
    this.leadMs.set(null);
    this.tracks.set([]);
    this.clearLevels();
  }

  /** Aktuelle Sekunde im Originalsong. */
  currentPosition(): number {
    if (!this.ctx) return this.restPos;
    return this.playing() ? this.posAt(this.ctx.currentTime) : this.restPos;
  }

  // ------------------------------------------------------------------- kern
  /**
   * Setzt alle Spuren gemeinsam neu an.
   *
   * `seekTo` gesetzt = Sprung auf diese Sekunde. Ohne `seekTo` laeuft die
   * Wiedergabe an der Stelle weiter, an der sie zum Umschaltzeitpunkt steht;
   * geaendert wird dann nur, was sich geaendert hat (Tempo, Tonhoehe, Loop).
   */
  private reschedule(seekTo?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const when = ctx.currentTime + this.lead;
    const pos = clamp(seekTo ?? this.posAt(when), 0, Math.max(this.duration(), 0));
    const rate = this.effectiveRate();
    const loop = this.activeLoop();
    const playing = this.playing();

    for (const track of this.trackList) {
      if (!track.node) continue;
      track.node.schedule({
        output: when,
        outputTime: when,
        active: playing,
        input: pos,
        rate,
        semitones: track.semitones,
        loopStart: loop ? loop.a : 0,
        loopEnd: loop ? loop.b : 0,
      });
    }

    // Bisherige Planung festhalten, damit die Anzeige in der Vorlaufzeit
    // weiterhin das zeigt, was in dieser Zeit noch zu hoeren ist. Stand die
    // Wiedergabe, wird das als Anker mit Rate 0 abgebildet.
    this.anchorPrev =
      this.anchor ?? { outputTime: when, songPos: this.restPos, rate: 0, loop };
    this.anchor = playing ? { outputTime: when, songPos: pos, rate, loop } : null;
    this.restPos = pos;
    // `pos` gilt erst ab `when`. Angezeigt wird, was **jetzt** zu hoeren ist,
    // sonst zeigte die Anzeige bei jeder Umplanung kurz zu weit nach vorn und
    // liefe danach wieder zurueck.
    this.position.set(this.posAt(ctx.currentTime));
    this.applyGains(when);
  }

  /** Gerechnete Position zur Audiozeit `t`, inklusive Loop-Umlauf. */
  private posAt(t: number): number {
    const current = this.anchor;
    // Vor `outputTime` gilt noch die vorherige Planung.
    const anchor =
      current && t < current.outputTime ? (this.anchorPrev ?? current) : current;
    if (!anchor) return this.restPos;
    let p = anchor.songPos + (t - anchor.outputTime) * anchor.rate;

    const loop = anchor.loop;
    if (loop) {
      const length = loop.b - loop.a;
      // Gleiche Rechnung wie im Worklet: beim Ueberschreiten von `b` wird
      // die Loop-Laenge abgezogen. Ergebnis liegt in [a, b).
      if (length > 0 && p >= loop.b) {
        p = loop.a + ((p - loop.a) % length);
      }
      return p;
    }
    return clamp(p, 0, this.duration());
  }

  private activeLoop(): LoopRange | null {
    const loop = this.loop();
    if (!loop || !this.loopEnabled()) return null;
    return loop.b - loop.a > 0 ? loop : null;
  }

  private effectiveRate(): number {
    const solos = this.trackList.filter((t) => t.solo);
    // Genau eine Solo-Spur: deren eigenes Tempo gilt. Sonst das Master-Tempo.
    return solos.length === 1 ? solos[0].soloRate : this.masterRate();
  }

  private audible(track: Track): boolean {
    if (track.muted) return false;
    const anySolo = this.trackList.some((t) => t.solo);
    return anySolo ? track.solo : true;
  }

  private applyGains(when?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const at = when ?? ctx.currentTime;
    for (const track of this.trackList) {
      if (!track.gain) continue;
      const target = this.audible(track) ? track.volume : 0;
      // Kurze Rampe statt Sprung, sonst knackt es.
      track.gain.gain.setTargetAtTime(target, at, 0.015);
    }
  }

  private find(slug: string): Track | undefined {
    return this.trackList.find((t) => t.slug === slug);
  }

  private publish(): void {
    this.tracks.set(
      this.trackList.map((t) => ({
        slug: t.slug,
        name: t.name,
        downloadUrl: t.downloadUrl,
        volume: t.volume,
        muted: t.muted,
        solo: t.solo,
        semitones: t.semitones,
        soloRate: t.soloRate,
        peaks: t.peaks,
        bytes: t.bytes,
        state: t.state,
        error: t.error,
      })),
    );
  }

  /**
   * Liest den Pegel jeder Spur aus ihrem Analyser.
   *
   * Gemessen wird der quadratische Mittelwert eines kurzen Fensters,
   * angehoben, damit auch leise Stellen sichtbar sind. Nach oben wird
   * sofort gefolgt, nach unten gebremst: ein Meter, der mit jedem
   * Bildaufbau auf Null fiele, flackert nur.
   */
  private measureLevels(): void {
    const next: Record<string, number> = {};
    const previous = this.levels();
    let changed = false;
    for (const track of this.trackList) {
      if (!track.analyser || !track.scratch) continue;
      track.analyser.getFloatTimeDomainData(track.scratch);
      let sum = 0;
      for (let i = 0; i < track.scratch.length; i++) {
        sum += track.scratch[i] * track.scratch[i];
      }
      const rms = Math.sqrt(sum / track.scratch.length);
      const raw = Math.min(1, rms * 2.6);
      const fell = (this.meterMemory.get(track.slug) ?? 0) * METER_FALL;
      const exact = Math.max(raw, fell);
      this.meterMemory.set(track.slug, exact < METER_FLOOR ? 0 : exact);
      const level = Math.round(exact * 100) / 100;
      next[track.slug] = level;
      if (level !== previous[track.slug]) changed = true;
    }
    if (changed) this.levels.set(next);
  }

  private clearLevels(): void {
    this.meterMemory.clear();
    if (Object.keys(this.levels()).length) this.levels.set({});
  }

  // ----------------------------------------------------------- anzeigeschleife
  private startFrameLoop(): void {
    if (this.frame) return;
    const tick = () => {
      if (!this.playing() || !this.ctx) {
        this.frame = 0;
        return;
      }
      const pos = this.posAt(this.ctx.currentTime);
      this.position.set(pos);
      this.measureLevels();

      // Ohne Loop am Ende anhalten.
      if (!this.activeLoop() && pos >= this.duration() - 0.01) {
        this.pause();
        this.restPos = this.duration();
        this.position.set(this.duration());
        this.frame = 0;
        return;
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stopFrameLoop(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
