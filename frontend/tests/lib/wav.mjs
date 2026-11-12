/**
 * Ein kurzes, kuenstliches Stueck als WAV — fuer beide Pruefstaende.
 *
 * Lag frueher nur im oeffentlichen Pruefstand. Der Ende-zu-Ende-Pruefstand
 * braucht dasselbe, seit er sich den echten Trennjob selbst anlegt, statt
 * auf einen vom vorigen Lauf zu hoffen. Eine Datei, zwei Aufrufer.
 *
 * Bass, Klopfen und eine Melodie: genug Struktur, dass eine Trennung
 * daran etwas zu tun hat, und kurz genug, dass sie nicht dauert.
 */
export function makeInputWav(seconds, rate) {
  const frames = Math.round(seconds * rate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const bass = 0.35 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-((t % 0.5) / 0.25));
    const beat = (t % 0.25) < 0.02 ? 0.3 * Math.sin(2 * Math.PI * 180 * t) : 0;
    const lead = 0.25 * Math.sin(2 * Math.PI * 440 * t);
    left[i] = bass + beat + lead * 0.9;
    right[i] = bass + beat + lead * 1.1;
  }
  const bytes = 44 + frames * 4;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(frames * 4, 40);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of [left, right]) {
      const v = Math.max(-1, Math.min(1, channel[i]));
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), at);
      at += 2;
    }
  }
  return buf;
}
