/**
 * Dateiname → Interpret und Titel.
 *
 * Was aus einem Download kommt, heisst selten nur nach dem Stueck:
 * "Yeah Yeah Yeahs - Heads Will Roll (Official Music Video) [auzfTPp4moA].mp3".
 * Im Verlauf steht davon nur, was man zum Wiedererkennen braucht. Der
 * vollstaendige Name geht nicht verloren — er steht im Tooltip der Zeile
 * und ueberall sonst (Deck, Job, Dateinamen der Spuren).
 */

/** Klammerinhalte, die nichts ueber das Stueck sagen. */
const NOISE =
  /^(official|offizielle?s?|original|full|hd|hq|4k|8k|uhd|music|musik|lyric|lyrics|audio|video|visuali[sz]er|mv|clip|remaster(ed)?|explicit|cc|sub(title)?s?|\d{4})\b/i;

export interface SongName {
  /** Das Stueck. Immer gesetzt. */
  title: string;
  /** Wer es spielt — oder null, wenn der Dateiname es nicht hergibt. */
  artist: string | null;
}

export function songName(source: string): SongName {
  let name = source.replace(/\.[a-z0-9]{2,4}$/i, '');

  // Eckige Klammern sind in Downloadnamen praktisch immer eine Kennung
  // ("[auzfTPp4moA]"), runde oft eine Herkunftsangabe. Entfernt wird nur,
  // was nach Beiwerk aussieht: "(Remix)" oder "(Live in Tokyo)" gehoeren
  // zum Stueck und bleiben stehen.
  name = name.replace(/\[[^\]]*\]/g, ' ');
  name = name.replace(/\(([^)]*)\)/g, (whole, inner: string) =>
    NOISE.test(inner.trim()) ? ' ' : whole,
  );
  name = name.replace(/\s{2,}/g, ' ').replace(/[\s._-]+$/, '').trim();

  // "Interpret - Titel", mit Bindestrich, Gedankenstrich oder Halbgeviert.
  const split = /\s+[-–—]\s+/.exec(name);
  if (split && split.index > 0) {
    const artist = name.slice(0, split.index).trim();
    const title = name.slice(split.index + split[0].length).trim();
    if (artist && title) return { title, artist };
  }
  return { title: name || source, artist: null };
}
