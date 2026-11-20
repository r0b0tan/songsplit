export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

/**
 * Was gerade geschieht — als Befund, nicht als Satz.
 *
 * Dieselbe Trennung wie bei `GpuReason`, aus demselben Grund: die Phasen
 * entstehen im Worker und im Abfragelauf des Serverwegs, also dort, wo die
 * gewaehlte Sprache nicht bekannt ist. Gemeldet wird, **was** laeuft; den
 * Satz schreibt `I18n.stage`.
 *
 * `text` ist die Ausnahme und steht fuer den Serverweg mit Python-Backend:
 * dessen Phasen kommen als fertige Saetze ueber `/api/jobs` und lassen
 * sich hier nicht mehr aufloesen. Sie werden durchgereicht wie ein
 * Spurname, den die Tabelle nicht kennt — lieber ein Satz in der falschen
 * Sprache als gar keiner.
 */
export type JobStage =
  /** Eine Phase ohne Zahlen. */
  | { key: PlainStage }
  /** Der Modelldownload, in Megabyte. */
  | { key: 'modell-mb'; loaded: number; total: number }
  /** Die Trennung, in Bloecken. Geraet wie Serverweg. */
  | { key: 'block'; done: number; total: number }
  /** Der Serverweg holt die fertigen Spuren ab. */
  | { key: 'spuren'; done: number; total: number }
  /** Ein fertiger Satz vom Backend. */
  | { key: 'text'; text: string };

export type PlainStage =
  /** In der Warteschlange. */
  | 'warten'
  | 'modell-prüfen'
  | 'laufzeit-laden'
  | 'modell-laden'
  /** Der Download entfaellt, die Gewichte liegen schon. */
  | 'modell-bereit'
  | 'sitzung-anlegen'
  | 'trennen'
  | 'fertig'
  /** Serverweg: noch kein Container, meist eine Warteschlange. */
  | 'cloud-warten'
  | 'cloud-lesen'
  | 'cloud-schreiben';

/**
 * Wo ein Job gerechnet wurde.
 *
 * `device` ist der Browser mit WebGPU, `backend` der oertliche Python-Dienst,
 * `cloud` unser Endpunkt für Geräte, die ihre Grafikeinheit nicht hergeben.
 * Alle drei stehen im Verlauf nebeneinander, denn es ist derselbe Song mit
 * denselben Spuren — nur mit anderer Wartezeit und, messbar, demselben
 * Klang.
 *
 * Der Unterschied, der am Job hängen bleiben muss: bei `cloud` hat die
 * Datei das Gerät verlassen. Deshalb steht die Herkunft in der Zeile des
 * Verlaufs und nicht nur im Protokoll.
 */
export type JobSite = 'device' | 'backend' | 'cloud';

export interface Stem {
  name: string;
  slug: string;
  /**
   * Adresse zum Abspielen. Im Browserpfad leer: die Abtastwerte liegen im
   * Arbeitsspeicher (`StemStore`) und gehen ohne Umweg über eine URL an das
   * Deck.
   */
  url: string;
  download_url: string;
  bytes: number;
}

export interface Job {
  id: string;
  source_name: string;
  model: string;
  model_label: string;
  site: JobSite;
  status: JobStatus;
  /**
   * Fortschritt von 0 bis 1, oder `null`.
   *
   * Der Python-Worker liefert keinen, der sich ehrlich umrechnen ließe —
   * dort bleibt es `null`. Der Browserpfad kennt seine Blöcke und die Bytes
   * des Modelldownloads und rechnet daraus einen echten Wert; `progress_of`
   * sagt, woraus.
   */
  progress: number | null;
  /** Worauf sich `progress` bezieht. */
  progress_of: 'modell' | 'blöcke' | null;
  /**
   * Geschätzte Restzeit in Sekunden, oder `null`.
   *
   * Dieselbe Regel wie bei `progress`: die Zahl steht nur da, wo sie aus
   * Gemessenem kommt. Jeder Block ist dieselbe Rechnung über dieselbe
   * Menge Ton — aus der Zeit der bisherigen Blöcke lässt sich der Rest
   * deshalb hochrechnen, und zwar nicht als Gefühl, sondern als Dreisatz.
   *
   * `null` heißt „noch nicht abschätzbar" und ist kein Mangel: in den
   * ersten Sekunden ist es die Wahrheit. Die ersten beiden Blöcke werden
   * bewusst übersprungen, siehe `device-separator.ts`.
   */
  remaining_seconds: number | null;
  stage: JobStage | null;
  error: string | null;
  is_test_path: boolean;
  device: string | null;
  duration_seconds: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  stems: Stem[];
}

export interface ModelInfo {
  name: string;
  /** Kurzname fuer die Auswahl: „Schnell", „Detailliert", „Instrumente". */
  mode: string;
  label: string;
  description: string;
  stems: string[];
  is_default: boolean;
  available: boolean;
  detail: string | null;
  /** Alle Modelldateien liegen lokal, der Job startet ohne Download. */
  downloaded: boolean;
  /** Dateien, die beim ersten Lauf noch geholt werden muessen. */
  missing_files: string[];
  /**
   * Wo dieser Modus gerechnet wird. Die Importkarte zeigt je Trennort nur
   * die Modi, die es dort auch gibt — „Instrumente" kann auf dem Gerät
   * verfügbar sein und auf dem Backend fehlen, oder umgekehrt.
   */
  site: JobSite;
  /** Browserpfad: Größe des Modelldownloads in Byte. */
  download_bytes?: number;
  /**
   * Browserpfad: wie viele Spuren das **Modell** liefert.
   *
   * Nicht `stems.length`: dort stehen die angezeigten Spuren, und bei
   * „Minimum" sind das zwei, während des Laufs aber vier. Der
   * Speicherwächter braucht die Spitze, nicht das Ergebnis.
   */
  peak_stems?: number;
}

export interface DeviceInfo {
  requested: string;
  effective: string;
  cuda_available: boolean;
  gpu_name: string | null;
  vram_total_gib: number | null;
  vram_free_gib: number | null;
  torch_version: string | null;
  cuda_runtime: string | null;
  notes: string[];
}

export interface Health {
  ok: boolean;
  separator_available: boolean;
  separator_detail: string | null;
  device: DeviceInfo;
  queued: number;
  processing: number;
}

/**
 * Wie der Job ueber die Leitung kommt.
 *
 * Nur ein Feld weicht ab, und genau darum geht es: das Backend schickt
 * seine Phase als fertigen Satz. `fromServer` in `api.service.ts` packt
 * ihn in `{ key: 'text' }` — an einer Stelle, nicht an jeder, die einen
 * Job anfasst.
 */
export type ServerJob = Omit<Job, 'stage'> & { stage: string | null };
