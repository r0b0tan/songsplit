/**
 * Der Serverweg — ob es ihn gibt, und wohin er führt.
 *
 * Die Angaben stehen **nicht** im Quelltext, sondern in `public/cloud.json`
 * neben der ausgelieferten Seite. Drei Gründe, und alle drei sind praktisch:
 *
 * 1. Der Token käme sonst ins Repository. Er ist zwar kein Geheimnis — er
 *    steht ohnehin im ausgelieferten JavaScript, das ist bekannt und in
 *    Kauf genommen —, aber „nicht geheim" und „für immer in der Historie"
 *    sind zwei verschiedene Dinge.
 * 2. Ihn zu wechseln heißt so: `modal secret create` und eine Datei
 *    austauschen. Kein Neubauen der Seite.
 * 3. Ob der Weg überhaupt angeboten wird, ist damit eine Eigenschaft der
 *    Auslieferung und keine des Baus. Dasselbe `dist/` läuft mit und ohne.
 *
 * **Die Datei wird mitgeliefert, auch leer** — und das ist nicht
 * gleichgültig, sondern der Unterschied zwischen „nicht eingerichtet" und
 * „kaputt". Wäre sie nur dort vorhanden, wo jemand sie angelegt hat,
 * stünde bei jedem Aufruf ohne sie ein 404 im Browserprotokoll. Genau
 * daran ist die Prüfung „Keine Anfrage außer eigenen Dateien" in
 * `tests/public/run.mjs` hängengeblieben, und sie hatte recht: ein
 * Fehlschlag, den man als normal abtut, ist einer, den man beim nächsten
 * Mal übersieht. Leere Werte heißen jetzt „es gibt ihn nicht", und das
 * ist eine Aussage statt eines Fehlers.
 *
 * Auf dem Server trägt die Datei Adresse und Token; `deploy.sh` nimmt sie
 * vom Abgleich aus, sonst schaltete jeder Deploy den Serverweg lautlos ab.
 *
 * Gelesen wird einmal beim Start. Schlägt es fehl, bleibt es bei `null`:
 * ein fehlender Rückfallweg ist kein Fehler, über den jemand etwas lesen
 * müsste, der das Gerät ohnehin selbst rechnen lassen kann.
 */

export interface CloudConfig {
  /** Basisadresse des Endpunkts, ohne Schrägstrich am Ende. */
  url: string;
  /** Wandert als `X-Mixapart-Token` an jede Anfrage. */
  token: string;
  /** Wo gerechnet wird, im Klartext — für die Anzeige und den Hinweis. */
  region: string;
  /** Wie lange die Spuren dort liegen, bis der Aufräumlauf sie löscht. */
  keepHours: number;
  /** Wie lange der Rechenanbieter Ein- und Ausgaben aufbewahrt. */
  providerKeepDays: number;
}

/** Was `/health` über den Endpunkt sagt. */
export interface CloudHealth {
  ok: boolean;
  format: string;
  /**
   * Sekunden Rechenzeit je Minute Musik — gemessen, nicht geschätzt.
   *
   * Damit steht schon beim Auswählen einer Datei da, wie lange es etwa
   * dauert. Die Wartezeit auf eine freie Grafikkarte ist **nicht** darin
   * enthalten; die ist nicht vorhersagbar, und sie hineinzurechnen hieße,
   * eine Zahl auszugeben, die regelmäßig falsch ist.
   */
  secondsPerMinute: number;
  /** Falsch heißt: der Wert ist die Vorgabe, noch nichts gemessen. */
  measured: boolean;
}

export async function loadCloudConfig(): Promise<CloudConfig | null> {
  try {
    // Absolut: die Seite liegt unter /de/ oder /en/, die Datei im Wurzelverzeichnis.
    const response = await fetch('/cloud.json', { cache: 'no-cache' });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    const url = typeof o['url'] === 'string' ? o['url'].replace(/\/+$/, '') : '';
    const token = typeof o['token'] === 'string' ? o['token'] : '';
    // Ohne beides ist der Weg nicht begehbar, und eine halb gefüllte
    // Konfiguration ist schlimmer als keine: sie führt zu einem Knopf, der
    // erst nach dem Hochladen scheitert. Die mitgelieferte Fassung ist
    // genau deshalb leer und nicht halb ausgefüllt.
    if (!url || !token) return null;
    return {
      url,
      token,
      region: typeof o['region'] === 'string' ? o['region'] : 'unbekannt',
      keepHours: typeof o['keep_hours'] === 'number' ? o['keep_hours'] : 6,
      providerKeepDays:
        typeof o['provider_keep_days'] === 'number' ? o['provider_keep_days'] : 7,
    };
  } catch {
    return null;
  }
}
