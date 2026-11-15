/**
 * Die Angaben, die eine veroeffentlichte Seite tragen muss.
 *
 * Sie stehen hier und nicht in der Fussleiste, aus demselben Grund wie
 * `variant.ts`: wer sie aendern muss — Umzug, neue Anschrift, anderer
 * Hoster —, aendert eine Datei und kein Markup.
 *
 * **Unausgefuellt gelassene Felder sind sichtbar.** Steht hier noch ein
 * Platzhalter, sagt der Impressumsdialog das im Klartext, statt eine
 * ordentlich aussehende, aber leere Seite zu zeigen. Ein Impressum, das
 * fehlt, ist in Deutschland angreifbar (§ 5 DDG); eines, das aussieht wie
 * ausgefuellt und es nicht ist, faellt niemandem auf.
 */
export interface Legal {
  /** Wer die Seite betreibt — Person oder Firma, so wie es im Register steht. */
  anbieter: string;
  /** Strasse und Hausnummer. Ein Postfach genuegt nicht. */
  strasse: string;
  /** Postleitzahl und Ort. */
  ort: string;
  land: string;
  /** Erreichbarkeit: eine Adresse, die auch gelesen wird. */
  email: string;
  /** Freiwillig, aber oft erwartet. Leer lassen heisst: steht nicht da. */
  telefon: string;
  /**
   * Verantwortlich fuer den Inhalt nach § 18 Abs. 2 MStV. Bei einer
   * Einzelperson derselbe Name wie `anbieter`.
   */
  verantwortlich: string;
  /** Umsatzsteuer-Identifikationsnummer, falls vorhanden. */
  ustId: string;
  /** Wer die Seite ausliefert — gehoert in die Datenschutzerklaerung. */
  hoster: string;
}

/** Noch nicht ausgefuellt: genau dieser Text loest den Hinweis aus. */
export const TODO = 'TODO';

export const LEGAL: Legal = {
  anbieter: TODO,
  strasse: TODO,
  ort: TODO,
  land: 'Deutschland',
  email: TODO,
  telefon: '',
  verantwortlich: TODO,
  ustId: '',
  hoster: TODO,
};

/** Ist ein Feld noch ein Platzhalter? */
export function fehlt(value: string): boolean {
  return value.trim() === '' || value.trim() === TODO;
}

/** Die Pflichtfelder, die noch fehlen — leer heisst: vollstaendig. */
export function luecken(): string[] {
  const pflicht: [keyof Legal, string][] = [
    ['anbieter', 'Anbieter'],
    ['strasse', 'Straße'],
    ['ort', 'PLZ und Ort'],
    ['email', 'E-Mail'],
    ['verantwortlich', 'Verantwortlich für den Inhalt'],
    ['hoster', 'Hoster'],
  ];
  return pflicht.filter(([key]) => fehlt(LEGAL[key])).map(([, label]) => label);
}
