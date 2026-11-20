/**
 * Die öffentliche Variante: alles im Browser.
 *
 * Tritt über `fileReplacements` an die Stelle von `variant.ts`, siehe dort.
 * Kein Backend heißt: `ApiService` fragt nichts ab, der Verlauf gilt für die
 * Sitzung, und als Trennort gibt es nur „Auf diesem Gerät".
 */
import type { Variant } from './variant.types';

export const VARIANT: Variant = {
  kind: 'öffentlich',
  backend: false,
  labelKey: 'device',
};
