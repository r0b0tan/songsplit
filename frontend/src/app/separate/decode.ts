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
  if (!bytes.byteLength) throw new Error('Die Datei ist leer.');

  // Länge und Kanalzahl stehen erst nach dem Dekodieren fest, deshalb ein
  // Context mit einem Bild: `decodeAudioData` richtet sich nicht danach.
  const probe = new OfflineAudioContext(1, 1, targetRate);
  let buffer: AudioBuffer;
  try {
    buffer = await probe.decodeAudioData(bytes);
  } catch (err) {
    throw new Error(
      'Die Datei ließ sich nicht dekodieren. Der Browser nimmt MP3 und WAV; ' +
        'bei einer WAV-Datei mit 24 oder 32 Bit hilft es, sie als 16 Bit zu ' +
        `speichern. (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // `decodeAudioData` liefert den Puffer in der Rate des Contexts, eine
  // Datei mit 48 kHz ist hier also schon umgerechnet. Die Prüfung ist
  // trotzdem da: wäre sie es einmal nicht, klänge die Trennung einfach zu
  // hoch oder zu tief, und niemand käme auf die Abtastrate.
  if (buffer.sampleRate !== targetRate) {
    throw new Error(
      `Der Browser hat die Datei mit ${buffer.sampleRate} Hz dekodiert, ` +
        `obwohl ${targetRate} Hz verlangt waren. Ohne die richtige Abtastrate ` +
        'würde die Trennung in der falschen Tonhöhe laufen.',
    );
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
