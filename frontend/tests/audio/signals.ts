/** Testsignale im Browser erzeugen und als blob:-URL bereitstellen. */

export const SR = 44100;

export function clickTrack(durationS: number, freq: number, intervalS = 1, decayS = 0.004) {
  const n = Math.round(durationS * SR);
  const out = new Float32Array(n);
  const burstN = Math.round(decayS * 4 * SR);
  for (let k = 0; k * intervalS <= durationS; k++) {
    const start = Math.round(k * intervalS * SR);
    for (let i = 0; i < burstN && start + i < n; i++) {
      const t = i / SR;
      out[start + i] += Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / decayS) * 0.8;
    }
  }
  return out;
}

export function sineTrack(durationS: number, freq: number, amp = 0.3) {
  const n = Math.round(durationS * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

/** Mono-Float32 als 16-Bit-Stereo-WAV verpacken. */
export function wavBlobUrl(mono: Float32Array): string {
  const frames = mono.length;
  const bytes = 44 + frames * 4; // 2 Kanaele * 2 Byte
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const text = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 4, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = v < 0 ? v * 0x8000 : v * 0x7fff;
    view.setInt16(off, s, true);
    view.setInt16(off + 2, s, true);
    off += 4;
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
