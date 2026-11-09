/**
 * WAV schreiben — für den Download einer Spur aus dem Browserpfad.
 *
 * 16-Bit-PCM, wie es auch `audio-separator` im lokalen Pfad schreibt
 * (README: „vier WAVs, je 273,18 s, 44,1 kHz, PCM_16"). Dass beide Wege
 * dasselbe Format liefern, ist kein Zufall: wer einen Song einmal lokal und
 * einmal im Browser trennt, soll die Dateien vergleichen können, ohne dass
 * das Format dazwischenkommt. Und 16-Bit-PCM nimmt jedes Programm.
 *
 * Erzeugt wird erst beim Klick. Eine Spur von 4:33 ist als WAV 48 MB; vier
 * davon im Voraus zu schreiben und als Blob-URL offenzuhalten wären 190 MB,
 * die niemand angefordert hat.
 */

/** Begrenzen statt überlaufen lassen: über 1 klingt ein Überlauf als Knacken. */
function clamp(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * Schreibt die Kanäle als WAV-Datei.
 *
 * Alle Kanäle müssen gleich lang sein — im Browserpfad sind sie das, weil
 * jede Spur aus demselben Blockraster kommt.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Blob {
  if (!channels.length) throw new Error('Keine Kanäle zum Schreiben');
  const frames = channels[0].length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new Error('Die Kanäle sind unterschiedlich lang');
    }
  }
  const count = channels.length;
  const bytesPerSample = 2;
  const dataBytes = frames * count * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // Länge des fmt-Blocks
  view.setUint16(20, 1, true); // 1 = PCM, ganzzahlig
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * bytesPerSample, true);
  view.setUint16(32, count * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Verschachtelt, Bild für Bild: so erwartet es das Format.
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const value = clamp(channels[c][i]);
      // Negativ hat einen Schritt mehr Spielraum als positiv, deshalb die
      // beiden verschiedenen Faktoren.
      view.setInt16(at, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Lädt die Kanäle als Datei herunter.
 *
 * Die Blob-URL wird gleich wieder freigegeben: sie hält sonst die ganzen
 * 48 MB bis zum Verlassen der Seite fest, auch wenn der Browser die Datei
 * längst geschrieben hat.
 */
export function downloadWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  filename: string,
): void {
  const url = URL.createObjectURL(encodeWav(channels, sampleRate));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.click();
  } finally {
    // Nicht sofort: der Browser liest die URL noch, während der Klick
    // verarbeitet wird.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
