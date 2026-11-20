/**
 * Die deutschen Texte — und damit die Form, die jede Sprache erfuellen muss.
 *
 * Hier steht kein JSON, und das ist der Punkt: aus diesem Objekt leitet
 * `Texte` den Typ ab, und `en.ts` traegt ihn. Fehlt dort ein Schluessel oder
 * steht einer zu viel darin, sagt es der Compiler — nicht die Oberflaeche,
 * die an der Stelle dann leer bleibt. Ein Tippfehler in der Vorlage kostet
 * genauso den Build statt einen stillen Leertext.
 *
 * **Platzhalter sind Funktionen.** `spuren: (n) => ...` ist eine gewoehnliche
 * Funktion mit einem gewoehnlichen Typ; es braucht dafuer weder eine
 * Ersetzungssyntax noch einen Parser, und die Zahl der Argumente prueft
 * derselbe Compiler mit.
 *
 * **Was nicht hierher gehoert:** Namen, die in jeder Sprache gleich stehen.
 * „WebGPU", „CUDA", „htdemucs", „MP3" sind keine Worte, sondern Bezeichner.
 * Sie bleiben im Code, wo sie gebraucht werden.
 *
 * Die Gliederung folgt den Bauteilen, nicht dem Satzbau: `header` ist die
 * Kopfleiste der Importkarte, `card` ihr Inneres, `sites` die Trennorte.
 * Wer einen Text sucht, sucht ihn an der Komponente, in der er steht.
 */
export const DE = {
  /** Fuer `toLocaleString`: Tausenderpunkt, Dezimalkomma. */
  locale: 'de-DE',

  /** Der Umschalter selbst. Die Kuerzel stehen im Code, nicht hier. */
  lang: {
    /** Liest die Vorlesestimme anstelle der zwei Kuerzel. */
    group: 'Sprache',
    de: 'Deutsch',
    en: 'Englisch',
  },

  /**
   * Die Trennorte.
   *
   * `short` ist das eine Wort auf dem zugeklappten Knopf, `hint` der Satz
   * zum Nachlesen am Eintrag. Bei Gerät und Backend ist `short` ein
   * Rechenweg und bleibt deshalb in beiden Sprachen gleich — uebersetzt
   * wird nur, was ein Wort ist.
   */
  sites: {
    device: {
      short: 'WebGPU',
      hint:
        'Rechnet im Browser auf der Grafikkarte dieses Rechners. Die Datei ' +
        'bleibt hier. Braucht kein laufendes Backend; beim ersten Lauf ' +
        'werden einmalig 174 MB Modellgewichte geladen. Rund 18 s für ' +
        'viereinhalb Minuten.',
    },
    backend: {
      short: 'CUDA',
      hint:
        'Rechnet auf derselben Grafikkarte, aber über CUDA statt WebGPU — ' +
        'rund doppelt so schnell (9 s statt 18 s). Die Datei bleibt hier. ' +
        'Braucht den laufenden Python-Dienst und kennt mehr Modelle.',
    },
    cloud: {
      short: 'Fremdserver',
      hint:
        'Für Geräte, die ihre Grafikeinheit nicht freigeben. Als einziger ' +
        'der drei Wege verlässt die Datei dabei diesen Rechner: sie wird an ' +
        'unseren Server geschickt und in den USA verarbeitet.',
    },
  },

  /**
   * Die Spuren, nach Slug.
   *
   * Woher der Slug kommt, steht in `core/stem-labels.ts`. Was nicht in
   * dieser Tabelle steht, bleibt so stehen, wie es geliefert wurde.
   */
  stems: {
    vocals: 'Gesang',
    drums: 'Drums',
    bass: 'Bass',
    other: 'Rest',
    guitar: 'Gitarre',
    piano: 'Klavier',
    instrumental: 'Begleitung',
  },

  /**
   * Die Trennmodi, nach ihrem Kurznamen.
   *
   * Der Schluessel ist der Kurzname aus `MODEL_PRESETS` im Backend und aus
   * `BROWSER_MODELS` im Katalog — dieselbe Kennung, an der ein Job im
   * Verlauf wiedererkannt wird, gleichgueltig wo er gerechnet wurde. Sie
   * ist deutsch, weil sie aelter ist als die zweite Sprache; sie zu
   * uebersetzen hiesse, zwei Rechenorte auseinanderlaufen zu lassen.
   * Angezeigt wird, was hier steht.
   */
  modes: {
    Schnell: 'Schnell',
    Minimum: 'Minimum',
    Instrumente: 'Instrumente',
    Detailliert: 'Detailliert',
    'Nur Gesang': 'Nur Gesang',
  },

  /** Die Kopfleiste der Importkarte. */
  header: {
    mode: 'Modus:',
    /** Mit Doppelpunkt davor, wenn nur ein Ort uebrig ist. */
    modeIs: (short: string) => `Modus: ${short}`,
    pickGroup: 'Wo getrennt wird',
    facts: 'Worauf gerechnet wird',
  },

  /**
   * Was die Variante ueber sich sagt.
   *
   * Die Variante waehlt hier einen Schluessel, keinen Satz: `variant.ts`
   * und `variant.public.ts` werden beim Bauen gegeneinander getauscht, und
   * ein Satz darin stuende in genau einer Sprache da.
   */
  variant: {
    local: 'Lokale Verarbeitung',
    device: 'Alles auf diesem Gerät',
  },

  /**
   * Warum die Grafikeinheit nicht zu gebrauchen ist.
   *
   * Der Grund entsteht im Worker, waehrend der die Grafikeinheit abklopft
   * — dort gibt es keinen Angular-Dienst und also auch kein Woerterbuch.
   * Der Worker meldet deshalb keinen Satz, sondern einen Befund
   * (`GpuReason` in `separate/runtime.ts`): welcher Fall, auf was fuer
   * einem Geraet, und die gemessenen Angaben dazu. Der Satz entsteht hier,
   * in der Sprache, die beim Lesen gilt.
   *
   * Das ist kein Umweg um der Uebersetzung willen: ein Worker, der Prosa
   * liefert, entscheidet ueber die Oberflaeche, und zwar an der Stelle, an
   * der am wenigsten davon zu sehen ist.
   */
  gpu: {
    noWebgpu: (mobile: boolean) =>
      mobile
        ? 'Dieser Browser bietet kein WebGPU. Auf Android kann es Chrome ab ' +
          'Fassung 121; Firefox und ältere Fassungen von Samsung Internet ' +
          'liefern es nicht.'
        : 'Dieser Browser bietet kein WebGPU. Auf dem Gerät trennen geht damit ' +
          'nicht — es braucht Chrome oder Edge in einer aktuellen Fassung.',

    cantOpen: (detail: string) => `WebGPU ließ sich nicht öffnen: ${detail}`,

    /**
     * Kein Adapter — in drei Teilen.
     *
     * Der mittlere faellt weg, wenn WebGL nichts meldet. Er steht hier
     * trotzdem als eigener Satz und nicht als angeklebtes Bruchstueck: im
     * Deutschen haengt er hinten dran, im Englischen koennte er anders
     * stehen, und eine Sprache, die nur Bruchstuecke zusammensetzt, hat
     * diese Wahl nicht.
     */
    noAdapter: (mobile: boolean, renderer: string | null, rendererSoftware: boolean) => {
      const anfang = mobile
        ? 'WebGPU ist vorhanden, der Browser gibt die Grafikeinheit dieses ' +
          'Geräts aber nicht frei — auch nicht im Compatibility-Modus.'
        : 'WebGPU ist vorhanden, liefert aber keinen Grafikadapter — auch nicht ' +
          'im Compatibility-Modus.';
      const mitte =
        renderer === null
          ? ''
          : rendererSoftware
            ? ` Auch WebGL rechnet hier auf dem Prozessor (meldet „${renderer}“) — ` +
              'eine nutzbare Grafikeinheit ist also nicht vorhanden.'
            : ` Erkannt wird sie durchaus — WebGL meldet „${renderer}“ —, für WebGPU ` +
              'gibt der Browser sie nur nicht frei.';
      const schluss = mobile
        ? ' Das liegt am Gerät: Chrome schaltet WebGPU auf Android bisher nur ' +
          'für einen Teil der verbauten Grafikeinheiten frei. Daran lässt sich ' +
          'hier nichts ändern.'
        : ' Oft hilft ein aktueller Grafiktreiber; in einer virtuellen Maschine ' +
          'ist WebGPU häufig abgeschaltet.';
      return anfang + mitte + schluss;
    },

    software: (adapter: string) =>
      `WebGPU läuft hier über eine Software-Umsetzung (${adapter}). ` +
      'Das rechnet auf der CPU und ist für eine Trennung zu langsam.',

    probeFailed: (detail: string) =>
      `Die Geräteprüfung brach ab: ${detail}. Getrennt wird dann ` +
      'auf dem Prozessor.',

    runtimeSilent:
      'Der Trennvorgang ließ sich nicht vorbereiten. Die ONNX-Runtime ' +
      'unter /vendor/onnxruntime/ antwortet nicht.',
  },

  /**
   * Das Fenster, das beim Start sagt, wenn hier nicht zu trennen ist.
   *
   * Es geht nur dort auf, wo es wirklich keinen Weg gibt — und damit liest
   * es ausgerechnet, wer sonst nichts von dieser Seite hat. Entsprechend
   * geradeheraus steht es da: was fehlt, wo es stattdessen geht, und was
   * es kostet, trotzdem weiterzuklicken.
   */
  notice: {
    title: 'Leider wird Ihr Gerät momentan nicht unterstützt',
    lead: (mobile: boolean) =>
      mobile
        ? 'MixApart trennt die Spuren direkt hier im Browser und braucht dafür ' +
          'die Grafikeinheit Ihres Geräts. Dieser Browser gibt sie nicht frei — ' +
          'die Musik würde Ihr Gerät nicht verlassen, nur rechnen lässt sich ' +
          'hier nichts.'
        : 'MixApart trennt die Spuren direkt hier im Browser und braucht dafür ' +
          'eine Grafikkarte, auf die der Browser zugreifen darf. Die steht auf ' +
          'diesem Gerät nicht zur Verfügung.',
    where:
      'Gut läuft MixApart auf einem Rechner mit Windows, macOS oder Linux ' +
      'und einem aktuellen Chrome oder Edge. Auf Smartphones und Tablets ' +
      'geben die Browser die Grafikeinheit bisher nur selten frei; die ' +
      'Hersteller erweitern das schrittweise, es lohnt sich also, später ' +
      'noch einmal vorbeizuschauen.',
    foot: (mobile: boolean) =>
      mobile
        ? 'Weiterklicken können Sie trotzdem: dann rechnet der Prozessor. Das ' +
          'dauert bei einem ganzen Lied eher eine Stunde als zehn Minuten, und ' +
          'der Browser kann den Tab vorher wegen Speichermangels beenden.'
        : 'Weiterklicken können Sie trotzdem: dann rechnet der Prozessor. Das ' +
          'dauert bei einem ganzen Lied ein Vielfaches — eher zehn Minuten als ' +
          'eine.',
    copy: 'Bericht kopieren',
    copied: 'Kopiert',
    ok: 'Verstanden',
  },

  /**
   * Der Bericht zum Kopieren.
   *
   * Er geht an einen Menschen, der helfen soll — deshalb stehen die
   * Angaben in der Sprache dessen, der ihn abschickt, und nicht in einer
   * dritten, die keiner von beiden gewählt hat.
   */
  report: {
    head: 'MixApart — Gerätebericht',
    code: 'Code',
    ok: 'in Ordnung',
    unknown: 'unbekannt',
    webgpu: 'WebGPU',
    usable: 'nutzbar',
    unusable: 'nicht nutzbar',
    adapter: 'Adapter',
    webgl: 'WebGL',
    reason: 'Grund',
    runtime: 'Runtime',
    browser: 'Browser',
    cores: 'Kerne',
    isolated: 'isoliert',
    yes: 'ja',
    no: 'nein',
  },

  /**
   * Der Stand eines Jobs — aus dem Befund `JobStage` gebaut.
   *
   * Die Schluessel heissen wie die Phasen, weil sie dieselben sind. Was
   * das Backend als fertigen Satz schickt, kommt hier nicht vorbei.
   */
  stages: {
    warten: 'Wartet',
    'modell-prüfen': 'Modell wird geprüft',
    'laufzeit-laden': 'Laufzeit wird geladen',
    'modell-laden': 'Modell wird geladen',
    'modell-bereit': 'Modell liegt bereit',
    'sitzung-anlegen': 'Modell wird vorbereitet',
    trennen: 'Wird getrennt',
    fertig: 'Fertig',
    'cloud-warten': 'Wartet auf eine freie Grafikkarte',
    'cloud-lesen': 'Die Datei wird gelesen',
    'cloud-schreiben': 'Die Spuren werden geschrieben',
    modellMb: (loaded: number, total: number) =>
      `Modell wird geladen (${loaded} MB von ${total} MB)`,
    block: (done: number, total: number) =>
      `Wird getrennt (Block ${done} von ${total})`,
    spuren: (done: number, total: number) =>
      `Spuren werden geladen (${done} von ${total})`,
  },

  /** Der Zustand eines Jobs, wo keine Phase dasteht. */
  status: {
    queued: 'Wartet',
    processing: 'Wird verarbeitet',
    done: 'Fertig',
    failed: 'Fehlgeschlagen',
  },

  /**
   * Das Fenster der laufenden Trennung.
   *
   * Die Restzeit ist grosszuegig gerundet — das steht im Code begruendet.
   * Hier ist nur zu beachten, dass die Nachkommastelle im Deutschen ein
   * Komma hat und im Englischen einen Punkt; deshalb formatiert jede
   * Sprache die Zahl selbst und bekommt sie nicht fertig gereicht.
   */
  run: {
    eyebrow: 'Trennung',
    hide: 'Fenster schließen, Trennung läuft weiter',
    failed: 'Die Trennung ist fehlgeschlagen.',
    queued: 'Wartet auf einen freien Platz',
    cancel: 'Abbrechen',
    close: 'Schließen',
    background: 'Im Hintergrund weiterlaufen lassen',
    back: 'Zurück',
    /** Die Laenge des Liedes, hinter den Angaben zum Modell. */
    length: (mmss: string) => `${mmss} lang`,
    /** Was statt des Modellnamens dasteht, wenn nichts getrennt wird. */
    testPath: 'Testpfad — trennt nichts',
    /** Der Name des Testjobs, im Verlauf und als Überschrift im Deck. */
    testStems: 'Testspuren',
    /** „htdemucs — 4 Spuren" */
    model: (name: string, stems: number) => `${name} — ${stems} Spuren`,
    almost: 'gleich fertig',
    secondsLeft: (s: number) => `noch etwa ${s} s`,
    minutesLeft: (min: number) =>
      `noch etwa ${min.toFixed(1).replace('.0', '').replace('.', ',')} min`,
  },

  /**
   * Worauf gerechnet wird — die Tabelle im Trennfenster und die zwei
   * Zeilen in der Importkarte.
   *
   * Die Werte daneben sind grossenteils Messwerte und bleiben, wie sie
   * sind: ein Adaptername, eine Fassungsnummer, „CUDA". Uebersetzt wird,
   * was ein Wort ist.
   */
  facts: {
    checking: 'wird geprüft',
    connecting: 'Verbindung wird geprüft',
    cpu: 'Prozessor (WASM)',
    localCpu: 'Prozessor dieses Rechners',
    server: 'Server',
    runsOn: 'Rechnet auf',
    adapter: 'Adapter',
    device: 'Gerät',
    backend: 'Backend',
    cachedModels: 'Modelle im Cache',
    vram: 'Grafikspeicher',
    vramFree: (free: number | null, total: number) => `${free} von ${total} GB frei`,
    data: 'Daten',
    localOnly: 'nur lokal',
    provider: 'Anbieter',
    gpu: 'Grafikkarte',
    assigning: 'wird zugeteilt',
    model: 'Modell',
    stems: 'Spuren',
  },

  /**
   * Der Verlauf.
   *
   * Die Reiter tragen ihre Beschriftung nicht mehr in `TABS`, sondern
   * hier: dort stand sie neben dem Schluessel, an dem gefiltert wird, und
   * ein Reiter, dessen Name sein Schluessel ist, laesst sich nicht
   * uebersetzen, ohne den Filter mitzuuebersetzen.
   */
  list: {
    head: 'Verlauf',
    filter: 'Verlauf filtern',
    tabs: { alle: 'Alle', songs: 'Songs', tests: 'Testläufe' },
    more: 'Weitere Aktionen für den Verlauf',
    purge: { songs: 'Alle fertigen Songs löschen', tests: 'Alle Testläufe löschen', alle: 'Alle abgeschlossenen löschen' },
    purgeArmed: (n: number) => `Wirklich? ${n} löschen`,
    empty: 'In dieser Sicht steht nichts.',
    failed: 'Fehlgeschlagen',
    stems: (n: number) => `${n} Spuren`,
    /** Am fertigen Job, als Titel des Knopfes. */
    separated: 'Fertig getrennt',
    separatedIn: (seconds: string) => `in ${seconds} s getrennt`,
    open: 'Im Deck öffnen',
    opened: 'Im Deck geöffnet',
    running: 'läuft',
    queued: 'wartet',
    /** Das Ergebnis ist dem Speicherbudget zum Opfer gefallen. */
    gone: 'Ergebnis nicht mehr im Speicher',
    goneWhy:
      'Die Spuren lagen nur im Arbeitsspeicher dieser Sitzung und sind einem ' +
      'neueren Ergebnis gewichen. Denselben Song erneut zu trennen geht.',
    remove: (title: string) => `Löschen: ${title}`,
    removeJob: 'Job löschen',
    reallyRemove: 'Wirklich löschen?',
    yes: 'Ja',
    no: 'Nein',
    pages: 'Seiten des Verlaufs',
    back: 'Eine Seite zurück',
    next: 'Eine Seite vor',
    pageOf: (page: number, pages: number) => `Seite ${page} / ${pages}`,
    inView: (n: number) => `${n} Jobs in dieser Sicht`,
  },

  /**
   * Was schiefging — aus dem Befund `Trouble` gebaut.
   *
   * Die Saetze sagen, soweit es geht, auch was zu tun ist. Ein Fehler, der
   * nur feststellt, laesst den Menschen stehen.
   */
  trouble: {
    dateiLeer: 'Die Datei ist leer.',
    nichtDekodierbar: (detail: string) =>
      'Die Datei ließ sich nicht dekodieren. Der Browser nimmt MP3 und WAV; ' +
      'bei einer WAV-Datei mit 24 oder 32 Bit hilft es, sie als 16 Bit zu ' +
      `speichern. (${detail})`,
    falscheRate: (got: number, wanted: number) =>
      `Der Browser hat die Datei mit ${got} Hz dekodiert, obwohl ${wanted} Hz ` +
      'verlangt waren. Ohne die richtige Abtastrate würde die Trennung in ' +
      'der falschen Tonhöhe laufen.',
    nurMp3Wav: 'Nur MP3 und WAV.',

    modellHttp: (status: number, url: string) =>
      `Modell nicht ladbar: HTTP ${status} für ${url}`,
    modellZuGross:
      'Die Modellstücke sind zusammen größer als im manifest.json steht. ' +
      'Vermutlich passen Stücke und Beschreibung nicht zueinander.',
    modellUnvollstaendig: (loaded: number, total: number) =>
      `Das Modell ist unvollständig: ${loaded} von ${total} Byte.`,
    keinePruefsummen:
      'Das Modell lässt sich nicht prüfen: dieser Browser stellt keine ' +
      'Prüfsummen bereit. Das passiert bei einem Aufruf über http:// — ' +
      'die Seite braucht https://, dann steht die Prüfung wieder zur ' +
      'Verfügung.',
    pruefsummeFalsch:
      'Die Prüfsumme des Modells stimmt nicht. Die geladenen Stücke passen ' +
      'nicht zu dem, was im manifest.json steht — ein abgebrochener ' +
      'Download oder eine halb aktualisierte Auslieferung.',
    modellFehlt: (modelId: string) =>
      `Zu „${modelId}" liegt kein Modell bereit. Dieser Trennmodus ist in ` +
      'dieser Variante nicht verfügbar.',
    modusUnbekannt: (mode: string) => `„${mode}" gibt es auf diesem Gerät nicht.`,
    ratePasstNicht: (model: number, input: number) =>
      `Das Modell rechnet mit ${model} Hz, bekommen hat es ${input} Hz.`,

    laeuftSchon:
      'Es läuft schon eine Trennung in diesem Tab. Erst abwarten oder abbrechen.',
    geraetWirdGeprueft: 'Das Gerät wird noch geprüft. Einen Moment.',
    speicherAus: (detail: string) =>
      'Der Speicher hat nicht gereicht. Ein kürzeres Stück, der Modus ' +
      '„Schnell" statt „Instrumente" oder ein Neuladen des Tabs hilft; ' +
      `andere Tabs zu schließen gibt ebenfalls Platz. (${detail})`,
    trennungAbgebrochen: (detail: string) => `Der Trennvorgang brach ab: ${detail}`,
    trennungWeg:
      'Der Trennvorgang brach ohne Meldung ab. Das passiert, wenn dem Browser ' +
      'der Speicher ausgeht — ein kürzeres Stück oder ein Neuladen des ' +
      'Tabs hilft.',
    dspAbgebrochen: (detail: string) => `Die Signalverarbeitung brach ab: ${detail}`,
    dspWeg:
      'Die Signalverarbeitung brach ohne Meldung ab — meist fehlender ' +
      'Speicher. Ein kürzeres Stück oder ein Neuladen des Tabs hilft.',

    serverwegFehlt: 'Der Serverweg ist auf dieser Seite nicht eingerichtet.',
    serverGescheitert: 'Die Trennung ist auf dem Server gescheitert.',

    modiUnlesbar: (liste: string) =>
      `Diese Trennmodi liegen nicht in lesbarer Form vor: ${liste}. Ein ` +
      'Neuladen der Seite holt die Beschreibung neu.',
    keineModi:
      'Keine Modellbeschreibung ist lesbar. Entweder fehlt der Export ' +
      'unter /models/ — er liegt nicht im Repo und entsteht mit ' +
      '„python backend/tools/export_htdemucs_onnx.py htdemucs" —, ' +
      'oder eine veraltete Beschreibung liegt im Browser-Cache und das ' +
      'Netz ist nicht erreichbar, um sie zu ersetzen. Einmal mit Netz ' +
      'neu laden räumt den zweiten Fall auf.',
  },

  /** Die Huelle: Band, Fenster und der Hinweis zum Drehen. */
  shell: {
    noSeparator: (detail: string) =>
      `audio-separator ist nicht verfügbar: ${detail}. Echte Trennungen sind ` +
      'daher nicht möglich. Der Testpfad funktioniert weiterhin.',
    runDialog: 'Trennung läuft',
    deck: 'Deck',
    deckOf: (song: string) => `Deck: ${song}`,
    turnAria:
      'Bitte das Gerät drehen — antippen, um das Deck trotzdem hochkant zu zeigen',
    turnHead: 'Bitte Gerät drehen',
    turnWhy:
      'Um alle Spuren an einer gemeinsamen Zeitachse zu zeigen, braucht der ' +
      'Player die Breite des Querformats.',
    /** Die Marken auf der Zeitachse. */
    loopStart: 'Loop-Anfang A',
    loopEnd: 'Loop-Ende B',
    songPosition: 'Songposition',
    /** Das Backend antwortet nicht. */
    noBackend: 'Keine Verbindung zum Backend. Läuft es auf 127.0.0.1:8000?',
    /** Die Fusszeile. Impressum und Datenschutz bleiben deutsch. */
    imprint: 'Impressum',
    privacy: 'Datenschutz',
  },

  /** Das Deck: abspielen, ueben, speichern. */
  deck: {
    testPath: 'Testpfad',
    testLead: 'Testpfad.',
    testWhy:
      'Diese Spuren sind synthetisch, es wurde nichts getrennt. Die beiden ' +
      'Klickspuren klicken auf genau denselben Zeitpunkten: synchron hört ' +
      'man einen einzigen Klick.',
    stems: (n: number) => `${n} Spuren`,
    playback: (percent: string) => `Wiedergabe ${percent} %`,
    cancelLoad: 'Laden abbrechen',
    close: 'Deck schließen',
    loading: 'Spuren werden geladen und dekodiert …',
    loadedOf: (done: number, total: number) => `${done} von ${total} Spuren`,
    fetching: 'Spuren werden geholt',

    play: 'Abspielen',
    pause: 'Pause',
    toStart: 'An den Anfang',
    back5: 'Fünf Sekunden zurück',
    forward5: 'Fünf Sekunden vor',
    loopToggle: 'Loop zwischen A und B ein- oder ausschalten',
    loopNone: 'Noch kein Loop gesetzt — A/B unten setzen oder in eine Wellenform ziehen',

    practice: 'Übemodus',
    mix: 'Mix',
    /** Was im Kopf steht: welche Spuren gerade zu hören sind. */
    allStems: 'Alle Spuren',
    allStemsMuted: (muted: number) => `Alle Spuren, ${muted} stumm`,
    soloOne: (stem: string) => `${stem} solo`,
    soloMany: (n: number) => `${n} Spuren solo`,
    clearSolo: 'Solo aufheben',
    masterRate: 'Mix-Tempo',
    masterRateAria: 'Mix-Tempo in Prozent',
    soloRateApplies: '(Solo-Tempo gilt)',

    headTrack: 'Spur · Mute · Solo',
    headPitch: 'Tonhöhe',
    showPitch: (stem: string) => `Tonhöhe von ${stem} anzeigen`,
    pitchOf: (stem: string) => `Tonhöhe von ${stem}`,
    semitones: 'Tonhöhe in Halbtönen',
    semitoneUnit: ' HT',
    down1: (stem: string) => `${stem} einen Halbton tiefer`,
    up1: (stem: string) => `${stem} einen Halbton höher`,
    muted: 'stumm — wieder hörbar machen',
    mute: 'stummschalten',
    muteAria: (stem: string) => `${stem} stummschalten`,
    soloed: 'solo — aufheben',
    solo: 'nur diese Spur hören',
    soloAria: (stem: string) => `${stem} solo hören`,
    position: (stem: string) => `Songposition auf Spur ${stem}`,
    level: (stem: string) => `Pegel von ${stem} in Prozent`,
    soloRate: 'Solo-Tempo',
    soloRateAria: (stem: string) => `Solo-Tempo von ${stem} in Prozent`,
    save: (stem: string) => `${stem} als WAV speichern`,
    notLoaded: 'nicht geladen',
    stemLoading: 'wird geladen …',
    loadingShort: 'lädt …',

    loop: 'A–B Loop',
    loopStartAria: 'Loop-Anfang A in Millisekunden',
    loopEndAria: 'Loop-Ende B in Millisekunden',
    loopStartTitle: 'Loop-Anfang in Millisekunden — Pfeiltasten stufen in 10 ms',
    loopEndTitle: 'Loop-Ende in Millisekunden — Pfeiltasten stufen in 10 ms',
    loopSetStart: 'Loop-Anfang A auf die aktuelle Stelle setzen',
    loopSetEnd: 'Loop-Ende B auf die aktuelle Stelle setzen',
    loopClear: 'Loop löschen',
    loopOn: 'Loop an',
    loopOff: 'Loop aus',
    loopEmpty: 'Kein Loop · Zum Setzen mit der Maus markieren',
    loopHelp:
      'Die Marken A und B lassen sich auf der Zeitachse ziehen — mit Maus, ' +
      'Finger oder Tastatur: Pfeiltasten 1 s, mit Umschalt 0,1 s, Bild auf/ab ' +
      '10 s, Pos1 und Ende an die Grenze.',
    loopHelpSr: 'Hinweis zur Bedienung der Loop-Marken',

    tech: 'Technik',
    techPosition: 'Position in Sekunden des Originalsongs',
    techContext: (hz: number) => `gemeinsamer AudioContext ${hz} Hz`,
    techLead: (lead: number | null, node: number | null) =>
      `Umschaltung ${lead} ms im Voraus, für alle Spuren auf dieselbe ` +
      `Audiozeit (Stretch-Knoten ${node} ms)`,
    techMemory: (mb: string) => `${mb} MB insgesamt im Arbeitsspeicher, dekodiert`,
  },

  /** Das Innere der Importkarte. */
  card: {
    eyebrow: 'Import',
    lede: 'Song trennen',

    file: {
      pick: 'MP3- oder WAV-Datei auswählen',
      drop: 'MP3 oder WAV hierher ziehen',
      another: 'Andere Datei auswählen',
      orPick: 'oder Datei auswählen',
      wrongType: 'Bitte eine MP3- oder WAV-Datei auswählen.',
    },

    modes: {
      head: 'Trennmodus',
      stems: (n: number) => `${n} Spuren`,
      none: 'Kein Trennmodus:',
      outputs: 'Spuren im gewählten Modus',
      /**
       * Der Backendweg laedt beim ersten Lauf nach.
       *
       * Zwei Teile, weil zwischen ihnen der Befehl steht — markierbar, in
       * Festbreitenschrift, und in beiden Sprachen derselbe. Der Modus
       * steht als eigenes `<strong>` davor.
       */
      willDownload: (name: string, files: number) =>
        `(${name}) wird beim ersten Lauf erst heruntergeladen ` +
        `(${files} ${files === 1 ? 'Datei' : 'Dateien'}). Der Job bleibt so ` +
        'lange auf „Wird verarbeitet“. Schlägt der Download fehl, hilft',
      /** Hinter dem Befehl, der dazwischen steht. */
      willDownloadAfter:
        ': das Skript probiert mehrere Quellen und sagt, woran es scheitert.',
    },

    ask: {
      no: 'Nein',
      yes: 'Ja',
      /** Die Downloadfrage: oben die Frage, darunter ihre Folgen. */
      download: (mb: number) => `${mb} MB Modellgewichte laden?`,
      downloadWhy: (mode: string, name: string, mb: number) =>
        `„${mode}" (${name}) rechnet im Browser und holt die Gewichte dafür ` +
        'einmalig. Sie bleiben danach im Browser-Cache: jeder weitere Song ' +
        'beginnt sofort, auch ohne Netz. Über Mobilfunk zählen die ' +
        `${mb} MB auf das Datenvolumen.`,
    },

    /**
     * Der Speicherwaechter.
     *
     * Vier Texte, die aufeinander aufbauen: `during` sagt, was waehrend des
     * Laufs im Speicher liegt, `deviceSays`/`deviceUnknown`, woran das
     * gemessen ist, und darauf setzen die beiden Absagen und die Rueckfrage
     * auf. Sie sind deshalb Funktionen mit fertigen Teilsaetzen als
     * Argument — nicht aneinandergeklebte Bruchstuecke, die sich in einer
     * anderen Sprache nicht umstellen liessen.
     */
    memory: {
      during: (mode: string, stems: number) =>
        `„${mode}" hält während des Laufs ${stems} Spuren und die Eingabe ` +
        'gleichzeitig im Arbeitsspeicher',
      deviceSays: (gb: number) => `Dieses Gerät meldet ${gb} GB.`,
      deviceUnknown:
        'Dieser Browser nennt den Speicher des Geräts nicht; angenommen sind 4 GB.',
      /** Zu klein fuer jeden Ausschnitt — ein kuerzerer hilft hier nicht. */
      tooSmall: (mode: string, needed: string, device: string) =>
        `Für „${mode}" reicht der Arbeitsspeicher dieses Geräts nicht: ` +
        `gebraucht werden rund ${needed} MB, und allein die Modellgewichte ` +
        `belegen davon etwa 400 MB. ${device} Ein kürzerer Ausschnitt hilft ` +
        'hier nicht.',
      /** Zu lang fuer dieses Geraet — mit der Laenge, die noch geht. */
      tooLong: (
        length: string,
        during: string,
        needed: string,
        device: string,
        fits: string,
      ) =>
        `${length} ist zu lang für dieses Gerät. ${during} — zusammen mit dem ` +
        `Modell rund ${needed} MB. ${device} Bis etwa ${fits} geht es hier; ` +
        'ein kürzerer Ausschnitt lässt sich trennen.',
      tight: (needed: string) =>
        `Knapp: rund ${needed} MB Arbeitsspeicher nötig.`,
      tightWhy: (
        during: string,
        length: string,
        audio: string,
        device: string,
      ) =>
        `${during} — bei ${length} sind das ${audio} MB, dazu etwa 400 MB für ` +
        `das Modell. ${device} Es kann gutgehen. Geht es nicht gut, beendet ` +
        'der Browser den Tab, und die Trennung ist weg — gespeichert wird ' +
        'unterwegs nichts.',
    },

    foot: {
      test: 'Testspuren anlegen',
      testWhy:
        'Legt drei synthetische Spuren an, ohne zu trennen: zwei Klickspuren ' +
        'mit Klicks auf genau denselben Zeitpunkten und einen 440-Hz-Dauerton. ' +
        'Laufen die Klickspuren synchron, hört man einen einzigen Klick.',
      /** Der Hauptknopf. Mit Spurzahl, wenn sie feststeht. */
      start: 'Trennen',
      startStems: (stems: number) => `${stems} Spuren trennen`,
      preparing: 'wird vorbereitet …',
      sending: 'wird an den Server geschickt …',
    },
  },
};

/**
 * Die Form, die jede Sprache erfuellt.
 *
 * Abgeleitet und nicht von Hand geschrieben: eine Form, die man pflegen
 * muesste, waere nach dem zweiten neuen Text nicht mehr dieselbe wie das
 * Woerterbuch. Absichtlich **ohne** `as const` — mit `as const` waere jeder
 * Text sein eigener Typ, und `en.ts` duerfte keinen anderen einsetzen.
 */
export type Texte = typeof DE;
