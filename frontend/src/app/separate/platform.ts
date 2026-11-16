/**
 * Handy oder nicht — und warum das hier ueberhaupt zaehlt.
 *
 * Zwei Meldungen haengen daran, und beide waren vorher fuer einen Desktop
 * geschrieben und auf einem Handy schlicht falsch:
 *
 * 1. Fehlt der Grafikadapter, riet die Oberflaeche zu einem neueren
 *    Grafiktreiber. Auf Android kann den niemand einspielen — er kommt mit
 *    dem Systemupdate oder gar nicht.
 * 2. Der WASM-Rueckfallweg wurde mit „eher zehn Minuten als eine" beziffert.
 *    Das gilt fuer eine Desktop-CPU. Auf einem Handy rechnet derselbe Weg
 *    einfaedig auf deutlich langsameren Kernen, und 174 MB Gewichte plus
 *    knapp ein Gigabyte Arbeitsspeicher stehen davor.
 *
 * Erkannt wird ueber `userAgentData`, wo es das gibt — das ist die Angabe,
 * die der Browser selbst als verlaesslich anbietet. Der UA-Text ist nur der
 * Rueckfallweg; er luegt bei iPadOS, das sich seit Jahren als Macintosh
 * ausgibt, weshalb dort zusaetzlich auf Touch geprueft wird.
 *
 * Funktioniert in beiden Welten: `navigator` gibt es im Fenster wie im
 * Worker, und beide fragen hier.
 */

interface UaData {
  mobile?: boolean;
  platform?: string;
}

export function isMobileDevice(): boolean {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  if (!nav) return false;

  const uaData = (nav as Navigator & { userAgentData?: UaData }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') {
    // Android-Tablets melden `mobile: false`, haben aber dieselben
    // Einschraenkungen. Die Plattform entscheidet deshalb mit.
    if (uaData.mobile) return true;
    if (uaData.platform === 'Android') return true;
  }

  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPod|Mobile|SamsungBrowser/i.test(ua)) return true;
  // iPadOS gibt sich als Macintosh aus — nur die Touchpunkte verraten es.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  return false;
}
