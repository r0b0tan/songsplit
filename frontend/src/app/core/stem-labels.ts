/**
 * Welche Spur welchen Namen traegt — und wie man vom Namen zurueckfindet.
 *
 * Die Tabelle ist dieselbe wie `STEM_LABELS` in
 * `backend/app/separation.py`. Sie steht hier, weil zwei Wege sie brauchen:
 * der Browserpfad benennt seine Spuren selbst, und die Oberflaeche muss aus
 * einem fertigen Namen wieder den Slug gewinnen koennen, um ihn zu
 * uebersetzen.
 *
 * **Warum der Rueckweg ueber den deutschen Namen laeuft** und nicht ueber
 * einen durchgereichten Slug: bei den Spuren eines Jobs gaebe es einen
 * (`Stem.slug`), aber er ist nicht der Anzeigename, sondern die Kennung der
 * Datei. Das Zweispurmodell des Backends liefert eine Spur mit dem Slug
 * `other`, und die heisst dort nicht „Rest", sondern „Begleitung": neben
 * Gesang ist alles andere die Begleitung, nicht ein Rest neben Drums und
 * Bass. Das Backend weiss das und sagt es im Namen; der Slug weiss es
 * nicht. Wer den Slug uebersetzte, machte aus „Begleitung" wieder „Other"
 * und verlore genau die Unterscheidung, die das Backend getroffen hat.
 *
 * Die Namen in `ModelInfo.stems` haben ohnehin keinen Slug neben sich — da
 * steht nur eine Liste von Namen. Ein Slug dorthin durchgereicht hiesse:
 * ein Feld mehr im Schema, im Backend, im Browserpfad und im Serverweg,
 * damit dieselbe Tabelle einmal weniger rueckwaerts gelesen wird.
 *
 * Der Rueckweg ist eindeutig, solange die Namen es sind — `umgekehrt()`
 * prueft das beim Laden und nicht erst, wenn eine Spur falsch heisst.
 */

/** Slug → deutscher Name. Dieselbe Tabelle wie im Backend. */
export const STEM_LABELS: Record<string, string> = {
  vocals: 'Gesang',
  drums: 'Drums',
  bass: 'Bass',
  other: 'Rest',
  guitar: 'Gitarre',
  piano: 'Klavier',
  instrumental: 'Begleitung',
};

function umgekehrt(tabelle: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, name] of Object.entries(tabelle)) {
    const key = name.toLowerCase();
    // Zwei Slugs mit demselben Namen waeren hier nicht zu unterscheiden,
    // und der Rueckweg raete. Das faellt beim Laden auf und nicht im
    // Betrieb an einer falsch benannten Spur.
    if (out[key]) {
      throw new Error(`Zwei Spuren heissen „${name}": ${out[key]} und ${slug}`);
    }
    out[key] = slug;
    // Der Slug selbst zaehlt mit: der Browserpfad reicht ihn stellenweise
    // unuebersetzt durch, und eine Spur aus einem Dateinamen traegt ihn
    // ohnehin.
    out[slug.toLowerCase()] = slug;
  }
  return out;
}

const SLUG_BY_NAME = umgekehrt(STEM_LABELS);

/**
 * Der Slug zu einem Spurnamen, oder `null`.
 *
 * `null` heisst: diese Spur kennt die Tabelle nicht. Das ist kein Fehler —
 * liefert ein Modell etwas Unbekanntes, nimmt das Backend den Dateinamen
 * (`separation.py`, `_stems_from_files`), und der gehoert dann so auf den
 * Schirm, wie er ist. Uebersetzt wird, was benannt ist; durchgereicht, was
 * gefunden wurde.
 */
export function stemSlug(name: string): string | null {
  return SLUG_BY_NAME[name.trim().toLowerCase()] ?? null;
}
