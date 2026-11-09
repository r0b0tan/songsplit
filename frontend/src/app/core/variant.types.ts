/**
 * Der Vertrag, den beide Varianten erfüllen.
 *
 * Er steht in einer eigenen Datei, weil `variant.public.ts` beim Bauen der
 * öffentlichen Variante **an die Stelle** von `variant.ts` tritt
 * (`fileReplacements`). Stünde der Typ dort, importierte die Ersatzdatei
 * sich selbst und der Typ wäre weg — ein Fehler, der nur in der einen
 * Variante auftritt und in der anderen nicht.
 */
export interface Variant {
  kind: 'lokal' | 'öffentlich';
  /**
   * Gibt es ein Backend, das nach Jobs und Geräten gefragt werden soll?
   * Ist es `false`, wird `/api` nie angesprochen — kein Request, der ins
   * Leere liefe, und keine Fehlermeldung über eine fehlende Verbindung,
   * die hier niemand herstellen könnte.
   */
  backend: boolean;
  /** Was in der Kopfzeile der Importkarte steht. */
  label: string;
}
