/**
 * Was schiefging — als Befund, nicht als Satz.
 *
 * Die dritte Stelle, an der dieselbe Trennung noetig ist, nach `GpuReason`
 * und `JobStage`. Der Grund ist derselbe: Fehler entstehen im Worker, in
 * einem Modul ohne Angular und in der Antwort eines fremden Servers —
 * ueberall dort also, wo die gewaehlte Sprache nicht bekannt ist. Ein Satz,
 * der da entstuende, stuende spaeter in der falschen Sprache da, und zwar
 * ausgerechnet in dem Moment, in dem jemand verstehen will, was los ist.
 *
 * Gemeldet wird deshalb **was** schiefging, mitsamt den Zahlen und Namen,
 * die in den Satz gehoeren. Den Satz schreibt `I18n.trouble`.
 *
 * Alles hier ist strukturklonbar — einfache Objekte aus Zeichenketten und
 * Zahlen. Das muss es sein: die Befunde des Trennworkers gehen per
 * `postMessage` in die Oberflaeche.
 */
export type Trouble =
  // ------------------------------------------------------------- die Datei
  | { key: 'datei-leer' }
  | { key: 'nicht-dekodierbar'; detail: string }
  | { key: 'falsche-rate'; got: number; wanted: number }
  | { key: 'nur-mp3-wav' }

  // ------------------------------------------------------------ das Modell
  | { key: 'modell-http'; status: number; url: string }
  | { key: 'modell-zu-gross' }
  | { key: 'modell-unvollstaendig'; loaded: number; total: number }
  | { key: 'keine-pruefsummen' }
  | { key: 'pruefsumme-falsch' }
  /** Zu dieser Kennung liegt in dieser Variante kein Export. */
  | { key: 'modell-fehlt'; modelId: string }
  /** Der gewaehlte Modus steht auf diesem Geraet nicht zur Wahl. */
  | { key: 'modus-unbekannt'; mode: string }
  | { key: 'rate-passt-nicht'; model: number; input: number }

  // -------------------------------------------------------------- der Lauf
  | { key: 'laeuft-schon' }
  | { key: 'geraet-wird-geprueft' }
  | { key: 'speicher-aus'; detail: string }
  /** Der Trennworker starb mit Meldung. */
  | { key: 'trennung-abgebrochen'; detail: string }
  /** Der Trennworker starb wortlos — meist fehlender Speicher. */
  | { key: 'trennung-weg' }
  | { key: 'dsp-abgebrochen'; detail: string }
  | { key: 'dsp-weg' }

  // --------------------------------------------------------- der Serverweg
  | { key: 'serverweg-fehlt' }
  | { key: 'server-gescheitert' }

  // ------------------------------------------------------- die Modusliste
  | { key: 'modi-unlesbar'; liste: string }
  | { key: 'keine-modi' }

  /**
   * Ein fertiger Satz, der von woanders kommt.
   *
   * Das Python-Backend und der Trennserver melden ihre Fehler als Text; der
   * laesst sich hier nicht mehr aufloesen und wird durchgereicht, wie ein
   * Spurname, den die Tabelle nicht kennt. Dasselbe gilt fuer alles, was
   * der Browser selbst wirft — seine Meldungen stehen in der Sprache, die
   * er gewaehlt hat, und eine erfundene Uebersetzung waere schlechter als
   * das Original.
   */
  | { key: 'text'; text: string };

/**
 * Ein Fehler, der seinen Befund mittraegt.
 *
 * Die Meldung des `Error` ist der Schluessel. Das ist Absicht: in der
 * Konsole und im Stapelprotokoll steht damit der Name des Zustands, und
 * der ist beim Suchen mehr wert als ein uebersetzter Satz.
 */
export class AppError extends Error {
  constructor(readonly trouble: Trouble) {
    super(trouble.key);
    this.name = 'AppError';
  }
}

/**
 * Macht aus allem, was geworfen wurde, einen Befund.
 *
 * Ein `AppError` bringt ihn mit. Alles andere — ein `RangeError` der
 * Laufzeit, ein `DOMException` des Browsers — wird durchgereicht: dort
 * steht eine Meldung, die jemand geschrieben hat, der die Lage kennt.
 */
export function troubleOf(err: unknown): Trouble {
  if (err instanceof AppError) return err.trouble;
  return { key: 'text', text: err instanceof Error ? err.message : String(err) };
}
