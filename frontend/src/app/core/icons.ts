/**
 * Zeichen aus Lucide 1.70.0 (ISC), erzeugt von tools/icons.mjs.
 * Nicht von Hand ändern — Zeichen dort eintragen und neu erzeugen.
 *
 * ISC License · Copyright (c) for portions of Lucide are held by Cole
 * Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for
 * Lucide are held by Lucide Contributors 2022.
 * https://lucide.dev · https://github.com/lucide-icons/lucide/blob/main/LICENSE
 */

/** Eine Form: Name des SVG-Elements und seine Attribute. */
export type IconShape = readonly [string, Readonly<Record<string, string>>];

export const ICONS = {
  // Transport: abspielen
  'play': [
    ['path', {"d":"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"}],
  ],
  // Transport: pausieren
  'pause': [
    ['rect', {"x":"14","y":"3","width":"5","height":"18","rx":"1"}],
    ['rect', {"x":"5","y":"3","width":"5","height":"18","rx":"1"}],
  ],
  // Transport: an den Anfang
  'skip-back': [
    ['path', {"d":"M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"}],
    ['path', {"d":"M3 20V4"}],
  ],
  // Transport: fünf Sekunden zurück
  'rewind': [
    ['path', {"d":"M12 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 12 18z"}],
    ['path', {"d":"M22 6a2 2 0 0 0-3.414-1.414l-6 6a2 2 0 0 0 0 2.828l6 6A2 2 0 0 0 22 18z"}],
  ],
  // Transport: fünf Sekunden vor
  'fast-forward': [
    ['path', {"d":"M12 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 12 18z"}],
    ['path', {"d":"M2 6a2 2 0 0 1 3.414-1.414l6 6a2 2 0 0 1 0 2.828l-6 6A2 2 0 0 1 2 18z"}],
  ],
  // Transport: A–B-Loop an oder aus
  'repeat': [
    ['path', {"d":"m17 2 4 4-4 4"}],
    ['path', {"d":"M3 11v-1a4 4 0 0 1 4-4h14"}],
    ['path', {"d":"m7 22-4-4 4-4"}],
    ['path', {"d":"M21 13v1a4 4 0 0 1-4 4H3"}],
  ],
  // Spur: klingt
  'volume-2': [
    ['path', {"d":"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"}],
    ['path', {"d":"M16 9a5 5 0 0 1 0 6"}],
    ['path', {"d":"M19.364 18.364a9 9 0 0 0 0-12.728"}],
  ],
  // Spur: stumm
  'volume-x': [
    ['path', {"d":"M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z"}],
    ['path', {"d":"m16.5 14.5 5-5"}],
    ['path', {"d":"m16.5 9.5 5 5"}],
  ],
  // Spur: solo
  'headphones': [
    ['path', {"d":"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"}],
  ],
  // Tonhöhe einen Halbton höher
  'plus': [
    ['path', {"d":"M5 12h14"}],
    ['path', {"d":"M12 5v14"}],
  ],
  // Tonhöhe einen Halbton tiefer
  'minus': [
    ['path', {"d":"M5 12h14"}],
  ],
  // Loop-Marke auf die aktuelle Stelle setzen
  'arrow-down-to-line': [
    ['path', {"d":"M12 17V3"}],
    ['path', {"d":"m6 11 6 6 6-6"}],
    ['path', {"d":"M19 21H5"}],
  ],
  // schließen, aufheben, löschen
  'x': [
    ['path', {"d":"M18 6 6 18"}],
    ['path', {"d":"m6 6 12 12"}],
  ],
  // Hinweis, der im Titel steht
  'info': [
    ['circle', {"cx":"12","cy":"12","r":"10"}],
    ['path', {"d":"M12 16v-4"}],
    ['path', {"d":"M12 8h.01"}],
  ],
  // Spur als WAV speichern
  'download': [
    ['path', {"d":"M12 15V3"}],
    ['path', {"d":"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"}],
    ['path', {"d":"m7 10 5 5 5-5"}],
  ],
  // Job löschen
  'trash': [
    ['path', {"d":"M10 11v6"}],
    ['path', {"d":"M14 11v6"}],
    ['path', {"d":"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"}],
    ['path', {"d":"M3 6h18"}],
    ['path', {"d":"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"}],
  ],
  // Jobliste: eine Seite zurück
  'chevron-left': [
    ['path', {"d":"m15 18-6-6 6-6"}],
  ],
  // Jobliste: eine Seite vor
  'chevron-right': [
    ['path', {"d":"m9 18 6-6-6-6"}],
  ],
  // Verlauf: Job im Deck öffnen
  'square-arrow-out-up-right': [
    ['path', {"d":"M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"}],
    ['path', {"d":"m21 3-9 9"}],
    ['path', {"d":"M15 3h6v6"}],
  ],
  // Verlauf: weitere Aktionen zu einem Job
  'ellipsis': [
    ['circle', {"cx":"12","cy":"12","r":"1"}],
    ['circle', {"cx":"19","cy":"12","r":"1"}],
    ['circle', {"cx":"5","cy":"12","r":"1"}],
  ],
  // Verlauf: Job wartet oder laeuft
  'clock': [
    ['circle', {"cx":"12","cy":"12","r":"10"}],
    ['path', {"d":"M12 6v6l4 2"}],
  ],
  // Job im Deck öffnen
  'audio-lines': [
    ['path', {"d":"M2 10v3"}],
    ['path', {"d":"M6 6v11"}],
    ['path', {"d":"M10 3v18"}],
    ['path', {"d":"M14 8v7"}],
    ['path', {"d":"M18 5v13"}],
    ['path', {"d":"M22 10v3"}],
  ],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICONS;
