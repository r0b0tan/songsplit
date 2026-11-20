/**
 * Eine lokale Datei in das Format bringen, mit dem das Modell rechnet.
 *
 * Das Modell will genau 44 100 Hz und genau zwei Kanäle. Der Browser bringt
 * beides mit: ein `OfflineAudioContext` mit der Zielrate dekodiert **und**
 * rechnet dabei um, über denselben Resampler, mit dem er auch abspielt. Ein
 * eigener Resampler wäre hier die schlechtere Wahl — er wäre eine weitere
 * Stelle, an der sich die Tonhöhe verschieben kann.
 *
 * Nichts davon verlässt das Gerät: `File` → `ArrayBuffer` → `decodeAudioData`
 * ist der ganze Weg, und keiner der Schritte kennt ein Netz.
 */

import { AppError } from '../core/trouble';

export interface DecodedInput {
  /** Genau so viele Kanäle, wie das Modell erwartet. */
  channels: Float32Array[];
  sampleRate: number;
  /** Länge in Sekunden, nach dem Umrechnen. */
  duration: number;
  /** Was beim Umrechnen passiert ist — für die Anzeige, falls es auffällt. */
  notes: string[];
}

/** Was die Oberfläche annimmt. Dieselbe Liste wie in der Importkarte. */
export const ACCEPTED_TYPES = /\.(mp3|wav)$/i;

export async function decodeForModel(
  file: File | Blob,
  targetRate: number,
  targetChannels: number,
): Promise<DecodedInput> {
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength) throw new AppError({ key: 'datei-leer' });

  // Länge und Kanalzahl stehen erst nach dem Dekodieren fest, deshalb ein
  // Context mit einem Bild: `decodeAudioData` richtet sich nicht danach.
  const probe = new OfflineAudioContext(1, 1, targetRate);
  let buffer: AudioBuffer;
  try {
    buffer = await probe.decodeAudioData(bytes);
  } catch (err) {
    throw new AppError({
      key: 'nicht-dekodierbar',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // `decodeAudioData` liefert den Puffer in der Rate des Contexts, eine
  // Datei mit 48 kHz ist hier also schon umgerechnet. Die Prüfung ist
  // trotzdem da: wäre sie es einmal nicht, klänge die Trennung einfach zu
  // hoch oder zu tief, und niemand käme auf die Abtastrate.
  if (buffer.sampleRate !== targetRate) {
    throw new AppError({
      key: 'falsche-rate',
      got: buffer.sampleRate,
      wanted: targetRate,
    });
  }

  const notes: string[] = [];

  const source: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    source.push(buffer.getChannelData(c));
  }

  const channels: Float32Array[] = [];
  if (source.length === 1) {
    // Mono: beide Kanäle derselbe Inhalt. Eine Kopie je Kanal, denn der
    // Worker bekommt die Puffer übergeben und nicht geteilt.
    for (let c = 0; c < targetChannels; c++) channels.push(new Float32Array(source[0]));
    notes.push('Mono-Datei: beide Kanäle tragen dasselbe Signal.');
  } else {
    for (let c = 0; c < targetChannels; c++) {
      channels.push(new Float32Array(source[Math.min(c, source.length - 1)]));
    }
    if (source.length > targetChannels) {
      notes.push(
        `Die Datei hat ${source.length} Kanäle; getrennt wurden die ersten ` +
          `${targetChannels}.`,
      );
    }
  }

  return {
    channels,
    sampleRate: targetRate,
    duration: channels[0].length / targetRate,
    notes,
  };
}

/**
 * Nur die Laenge, ohne zu dekodieren.
 *
 * Der Speicherwaechter muss vor dem Start wissen, wie lang das Stueck ist
 * — und zwar **bevor** `decodeForModel` die Abtastwerte anlegt. Ein
 * `<audio>`-Element liest dafuer die Kopfdaten und sonst nichts: bei einer
 * MP3 sind das ein paar Kilobyte, bei einer WAV der RIFF-Kopf.
 *
 * Bei einer MP3 mit wechselnder Bitrate ohne Xing-Kopf schaetzt der
 * Browser die Dauer; fuer einen Budgetvergleich reicht das. Geht etwas
 * schief — kaputter Kopf, Format, das der Browser nicht mag —, kommt
 * `null` zurueck und der Waechter haelt sich heraus, statt einen Start zu
 * verbieten, den er nicht beurteilen kann. Gescheitert wird dann weiter
 * unten beim Dekodieren, mit der besseren Meldung.
 */
export function probeDuration(file: File | Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    let done = false;

    const fertig = (value: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };

    // Ohne Frist haengt ein Browser, der die Kopfdaten nicht versteht,
    // den Start fuer immer auf. Lieber nach drei Sekunden nichts wissen
    // als nie starten.
    const timer = setTimeout(() => fertig(null), 3000);

    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration;
      fertig(Number.isFinite(d) && d > 0 ? d : null);
    });
    audio.addEventListener('error', () => fertig(null));

    audio.preload = 'metadata';
    audio.src = url;
  });
}
