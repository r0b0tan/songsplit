import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app';
import { BenchPageComponent } from './app/bench/bench-page';

/**
 * Zwei Seiten, kein Router.
 *
 * `#bench` oeffnet die Messseite, alles andere die Anwendung. Ein Router
 * waere fuer zwei Seiten mehr Geruest als Weg — und die Messseite soll
 * ausdruecklich *neben* der Anwendung stehen, nicht in ihr: sie redet
 * direkt mit dem Worker, damit gemessen wird, was die Trennung kostet, und
 * nicht, was der Weg dorthin kostet.
 *
 * Die Entscheidung faellt einmal beim Start. Wer von der Messseite zurueck
 * will, laedt die Seite neu — ein Wechsel im laufenden Betrieb braeuchte
 * genau das Gerüst, das hier vermieden wird.
 */
const bench = location.hash.replace(/^#/, '') === 'bench';
if (bench) {
  // `bootstrapApplication` sucht das Wirtselement am Selektor der
  // Komponente. In `index.html` steht nur `<app-root>`, also wird das
  // Element hier gesetzt — ausdruecklich und sichtbar, statt der Messseite
  // denselben Selektor zu geben und sich darauf zu verlassen, dass nie
  // beide gleichzeitig gebraucht werden.
  document.body.innerHTML = '<app-bench></app-bench>';
  document.title = 'songsplit — Messung';
}

bootstrapApplication(bench ? BenchPageComponent : AppComponent, {
  providers: [
    // Die Anwendung laedt kein zone.js. Die Aenderungserkennung laeuft
    // ueber Signale, und das steht hier ausdruecklich, statt sich auf eine
    // stillschweigende Vorgabe zu verlassen. Sie greift asynchron: nach
    // einer Signaländerung ist die Oberflaeche erst im naechsten
    // Bildaufbau aktuell, nicht schon im selben Aufruf.
    provideZonelessChangeDetection(),
    provideHttpClient(),
  ],
}).catch((err) => console.error(err));
