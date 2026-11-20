import type { Variant } from './variant.types';
/**
 * Welche Variante gerade gebaut wird.
 *
 * Es gibt zwei:
 *
 * **lokal** — mit Python-Backend. Trennen geht auf dem Gerät (WebGPU) oder
 * über das Backend (CUDA). Der Backendweg ist der Vergleichswert für
 * Geschwindigkeit und Klang und bleibt deshalb erhalten.
 *
 * **öffentlich** — nur der Browser. Kein Backend, keine Datenbank, kein
 * Konto, keine Datei verlässt das Gerät. Das ist die Variante, die sich
 * kostenlos über HTTPS ausliefern lässt.
 *
 * Diese Datei ist die lokale Fassung. Für die öffentliche tauscht der Build
 * sie gegen `variant.public.ts` aus (`fileReplacements` in `angular.json`,
 * Konfiguration `public`). Das ist der ganze Unterschied: wer wissen will,
 * was die öffentliche Variante nicht kann, liest die eine Datei.
 */
export const VARIANT: Variant = {
  kind: 'lokal',
  backend: true,
  labelKey: 'local',
};
