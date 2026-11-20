/**
 * Die englischen Texte.
 *
 * `Texte` kommt aus `de.ts` und ist hier eine Zusage: fehlt ein Schluessel,
 * steht einer zu viel darin oder nimmt eine Funktion andere Argumente,
 * schlaegt der Build fehl. Pflegen heisst damit: in `de.ts` schreiben, bauen,
 * und der Compiler sagt, was hier noch fehlt.
 *
 * Englisch ist die Vorgabe (siehe `i18n.ts`), deutsch bleibt die Vorlage —
 * dort entstehen die Texte, hier kommen sie an.
 */
import type { Texte } from './de';

export const EN: Texte = {
  locale: 'en-US',

  lang: {
    group: 'Language',
    de: 'German',
    en: 'English',
  },

  sites: {
    device: {
      short: 'WebGPU',
      hint:
        "Runs in the browser on this computer's graphics card. The file stays " +
        'here. No backend needed; the first run downloads 174 MB of model ' +
        'weights once. Around 18 s for four and a half minutes of audio.',
    },
    backend: {
      short: 'CUDA',
      hint:
        'Runs on the same graphics card, but through CUDA instead of WebGPU — ' +
        'about twice as fast (9 s instead of 18 s). The file stays here. ' +
        'Needs the Python service running, and knows more models.',
    },
    cloud: {
      short: 'Remote server',
      hint:
        'For devices that keep their graphics unit to themselves. Of the three ' +
        'routes this is the only one the file leaves this computer on: it is ' +
        'sent to our server and processed in the USA.',
    },
  },

  stems: {
    vocals: 'Vocals',
    drums: 'Drums',
    bass: 'Bass',
    other: 'Other',
    guitar: 'Guitar',
    piano: 'Piano',
    instrumental: 'Instrumental',
  },

  modes: {
    Schnell: 'Fast',
    Minimum: 'Minimal',
    Instrumente: 'Instruments',
    Detailliert: 'Detailed',
    'Nur Gesang': 'Vocals only',
  },

  header: {
    mode: 'Mode:',
    modeIs: (short: string) => `Mode: ${short}`,
    pickGroup: 'Where separation runs',
    facts: 'What it runs on',
  },

  variant: {
    local: 'Local processing',
    device: 'Everything on this device',
  },

  gpu: {
    noWebgpu: (mobile: boolean) =>
      mobile
        ? 'This browser does not offer WebGPU. On Android, Chrome 121 and ' +
          'later can; Firefox and older versions of Samsung Internet do not.'
        : 'This browser does not offer WebGPU. Separating on this device ' +
          'needs a current Chrome or Edge.',

    cantOpen: (detail: string) => `WebGPU could not be opened: ${detail}`,

    noAdapter: (mobile: boolean, renderer: string | null, rendererSoftware: boolean) => {
      const start = mobile
        ? 'WebGPU is present, but the browser will not release this ' +
          "device's graphics unit — not even in compatibility mode."
        : 'WebGPU is present but returns no graphics adapter — not even in ' +
          'compatibility mode.';
      const middle =
        renderer === null
          ? ''
          : rendererSoftware
            ? ` WebGL runs on the processor here as well (it reports “${renderer}”), ` +
              'so there is no usable graphics unit at all.'
            : ` It is detected — WebGL reports “${renderer}” — the browser ` +
              'just will not release it for WebGPU.';
      const end = mobile
        ? ' That is down to the device: so far Chrome enables WebGPU on ' +
          'Android for only some of the graphics units in use. Nothing can ' +
          'be done about it here.'
        : ' A current graphics driver often helps; in a virtual machine ' +
          'WebGPU is frequently switched off.';
      return start + middle + end;
    },

    software: (adapter: string) =>
      `WebGPU runs through a software implementation here (${adapter}). ` +
      'That computes on the CPU and is too slow for a separation.',

    probeFailed: (detail: string) =>
      `The device check broke off: ${detail}. Separation then runs on the ` +
      'processor.',

    runtimeSilent:
      'The separation could not be prepared. The ONNX runtime under ' +
      '/vendor/onnxruntime/ is not responding.',
  },

  notice: {
    title: 'Unfortunately your device is not supported at the moment',
    lead: (mobile: boolean) =>
      mobile
        ? 'MixApart separates the stems right here in the browser and needs ' +
          "your device's graphics unit for it. This browser does not release " +
          'it — your music would not leave your device, there is just nothing ' +
          'here to compute with.'
        : 'MixApart separates the stems right here in the browser and needs a ' +
          'graphics card the browser is allowed to use. None is available on ' +
          'this device.',
    where:
      'MixApart runs well on a computer with Windows, macOS or Linux and a ' +
      'current Chrome or Edge. On phones and tablets browsers rarely release ' +
      'the graphics unit yet; the makers are extending that step by step, so ' +
      'it is worth looking in again later.',
    foot: (mobile: boolean) =>
      mobile
        ? 'You can carry on regardless: the processor will do the work. For a ' +
          'whole song that takes nearer an hour than ten minutes, and the ' +
          'browser may end the tab before then for lack of memory.'
        : 'You can carry on regardless: the processor will do the work. For a ' +
          'whole song that takes several times as long — nearer ten minutes ' +
          'than one.',
    copy: 'Copy report',
    copied: 'Copied',
    ok: 'Got it',
  },

  report: {
    head: 'MixApart — device report',
    code: 'Code',
    ok: 'fine',
    unknown: 'unknown',
    webgpu: 'WebGPU',
    usable: 'usable',
    unusable: 'not usable',
    adapter: 'Adapter',
    webgl: 'WebGL',
    reason: 'Reason',
    runtime: 'Runtime',
    browser: 'Browser',
    cores: 'Cores',
    isolated: 'isolated',
    yes: 'yes',
    no: 'no',
  },

  stages: {
    warten: 'Waiting',
    'modell-prüfen': 'Checking the model',
    'laufzeit-laden': 'Loading the runtime',
    'modell-laden': 'Loading the model',
    'modell-bereit': 'Model ready',
    'sitzung-anlegen': 'Preparing the model',
    trennen: 'Separating',
    fertig: 'Done',
    'cloud-warten': 'Waiting for a free graphics card',
    'cloud-lesen': 'Reading the file',
    'cloud-schreiben': 'Writing the stems',
    modellMb: (loaded: number, total: number) =>
      `Loading the model (${loaded} MB of ${total} MB)`,
    block: (done: number, total: number) =>
      `Separating (block ${done} of ${total})`,
    spuren: (done: number, total: number) =>
      `Loading stems (${done} of ${total})`,
  },

  status: {
    queued: 'Waiting',
    processing: 'Processing',
    done: 'Done',
    failed: 'Failed',
  },

  run: {
    eyebrow: 'Separation',
    hide: 'Close this window, separation keeps running',
    failed: 'The separation failed.',
    queued: 'Waiting for a free slot',
    cancel: 'Cancel',
    close: 'Close',
    background: 'Keep running in the background',
    back: 'Back',
    length: (mmss: string) => `${mmss} long`,
    testPath: 'Test path — separates nothing',
    testStems: 'Test stems',
    model: (name: string, stems: number) => `${name} — ${stems} stems`,
    almost: 'almost done',
    secondsLeft: (s: number) => `about ${s} s left`,
    minutesLeft: (min: number) => `about ${min.toFixed(1).replace('.0', '')} min left`,
  },

  facts: {
    checking: 'checking',
    connecting: 'checking the connection',
    cpu: 'Processor (WASM)',
    localCpu: "this computer's processor",
    server: 'Server',
    runsOn: 'Runs on',
    adapter: 'Adapter',
    device: 'Device',
    backend: 'Backend',
    cachedModels: 'Models cached',
    vram: 'Graphics memory',
    vramFree: (free: number | null, total: number) => `${free} of ${total} GB free`,
    data: 'Data',
    localOnly: 'local only',
    provider: 'Provider',
    gpu: 'Graphics card',
    assigning: 'being assigned',
    model: 'Model',
    stems: 'Stems',
  },

  list: {
    head: 'History',
    filter: 'Filter the history',
    tabs: { alle: 'All', songs: 'Songs', tests: 'Test runs' },
    more: 'More actions for the history',
    purge: { songs: 'Delete all finished songs', tests: 'Delete all test runs', alle: 'Delete all finished' },
    purgeArmed: (n: number) => `Really? Delete ${n}`,
    empty: 'Nothing in this view.',
    failed: 'Failed',
    stems: (n: number) => `${n} stems`,
    separated: 'Separated',
    separatedIn: (seconds: string) => `separated in ${seconds} s`,
    open: 'Open in deck',
    opened: 'Opened in deck',
    running: 'running',
    queued: 'waiting',
    gone: 'Result no longer in memory',
    goneWhy:
      "The stems were only held in this session's memory and have given way " +
      'to a newer result. Separating the same song again works.',
    remove: (title: string) => `Delete: ${title}`,
    removeJob: 'Delete job',
    reallyRemove: 'Really delete?',
    yes: 'Yes',
    no: 'No',
    pages: 'History pages',
    back: 'One page back',
    next: 'One page forward',
    pageOf: (page: number, pages: number) => `Page ${page} / ${pages}`,
    inView: (n: number) => `${n} jobs in this view`,
  },

  trouble: {
    dateiLeer: 'The file is empty.',
    nichtDekodierbar: (detail: string) =>
      'The file could not be decoded. The browser takes MP3 and WAV; for a ' +
      'WAV file at 24 or 32 bit it helps to save it as 16 bit. ' +
      `(${detail})`,
    falscheRate: (got: number, wanted: number) =>
      `The browser decoded the file at ${got} Hz although ${wanted} Hz were ` +
      'asked for. Without the right sample rate the separation would run at ' +
      'the wrong pitch.',
    nurMp3Wav: 'MP3 and WAV only.',

    modellHttp: (status: number, url: string) =>
      `Model not loadable: HTTP ${status} for ${url}`,
    modellZuGross:
      'The model pieces together are larger than the manifest.json says. ' +
      'The pieces and the description probably do not belong together.',
    modellUnvollstaendig: (loaded: number, total: number) =>
      `The model is incomplete: ${loaded} of ${total} bytes.`,
    keinePruefsummen:
      'The model cannot be verified: this browser provides no checksums. ' +
      'That happens when the page is opened over http:// — it needs ' +
      'https://, and the check is available again.',
    pruefsummeFalsch:
      'The checksum of the model does not match. The pieces that were loaded ' +
      'do not belong to what the manifest.json describes — either an ' +
      'interrupted download or a half-updated deployment.',
    modellFehlt: (modelId: string) =>
      `No model is available for “${modelId}”. This separation mode is ` +
      'not available in this build.',
    modusUnbekannt: (mode: string) =>
      `“${mode}” does not exist on this device.`,
    ratePasstNicht: (model: number, input: number) =>
      `The model computes at ${model} Hz, but it was given ${input} Hz.`,

    laeuftSchon:
      'A separation is already running in this tab. Wait for it or cancel it.',
    geraetWirdGeprueft: 'The device is still being checked. One moment.',
    speicherAus: (detail: string) =>
      'There was not enough memory. A shorter excerpt, the mode ' +
      '“Fast” instead of “Instruments” or reloading the tab helps; ' +
      `closing other tabs frees room as well. (${detail})`,
    trennungAbgebrochen: (detail: string) => `The separation broke off: ${detail}`,
    trennungWeg:
      'The separation broke off without a message. That happens when the ' +
      'browser runs out of memory — a shorter excerpt or reloading the tab ' +
      'helps.',
    dspAbgebrochen: (detail: string) => `Signal processing broke off: ${detail}`,
    dspWeg:
      'Signal processing broke off without a message — usually missing ' +
      'memory. A shorter excerpt or reloading the tab helps.',

    serverwegFehlt: 'The server route is not set up on this page.',
    serverGescheitert: 'The separation failed on the server.',

    modiUnlesbar: (liste: string) =>
      `These separation modes are not available in readable form: ${liste}. ` +
      'Reloading the page fetches the descriptions again.',
    keineModi:
      'No model description is readable. Either the export under /models/ is ' +
      'missing — it is not in the repository and is produced with ' +
      '“python backend/tools/export_htdemucs_onnx.py htdemucs” — ' +
      'or an outdated description sits in the browser cache and the network ' +
      'cannot be reached to replace it. Reloading once with a network ' +
      'connection clears the second case.',
  },

  shell: {
    noSeparator: (detail: string) =>
      `audio-separator is not available: ${detail}. Real separations are ` +
      'therefore not possible. The test path still works.',
    runDialog: 'Separation running',
    deck: 'Deck',
    deckOf: (song: string) => `Deck: ${song}`,
    turnAria: 'Please turn the device — tap to show the deck upright anyway',
    turnHead: 'Please turn the device',
    turnWhy:
      'To show every stem on a shared timeline, the player needs the width of ' +
      'landscape orientation.',
    loopStart: 'Loop start A',
    loopEnd: 'Loop end B',
    songPosition: 'Song position',
    noBackend: 'No connection to the backend. Is it running on 127.0.0.1:8000?',
  },

  deck: {
    testPath: 'Test path',
    testLead: 'Test path.',
    testWhy:
      'These stems are synthetic, nothing was separated. The two click tracks ' +
      'click at exactly the same moments: in sync you hear a single click.',
    stems: (n: number) => `${n} stems`,
    playback: (percent: string) => `Playback ${percent} %`,
    cancelLoad: 'Cancel loading',
    close: 'Close the deck',
    loading: 'Loading and decoding the stems …',
    loadedOf: (done: number, total: number) => `${done} of ${total} stems`,
    fetching: 'Fetching the stems',

    play: 'Play',
    pause: 'Pause',
    toStart: 'To the start',
    back5: 'Five seconds back',
    forward5: 'Five seconds forward',
    loopToggle: 'Switch the loop between A and B on or off',
    loopNone: 'No loop set yet — set A/B below or drag across a waveform',

    practice: 'Practice',
    mix: 'Mix',
    allStems: 'All stems',
    allStemsMuted: (muted: number) => `All stems, ${muted} muted`,
    soloOne: (stem: string) => `${stem} solo`,
    soloMany: (n: number) => `${n} stems solo`,
    clearSolo: 'Clear solo',
    masterRate: 'Mix tempo',
    masterRateAria: 'Mix tempo in percent',
    soloRateApplies: '(solo tempo applies)',

    headTrack: 'Stem · Mute · Solo',
    headPitch: 'Pitch',
    showPitch: (stem: string) => `Show the pitch of ${stem}`,
    pitchOf: (stem: string) => `Pitch of ${stem}`,
    semitones: 'Pitch in semitones',
    semitoneUnit: ' st',
    down1: (stem: string) => `${stem} one semitone down`,
    up1: (stem: string) => `${stem} one semitone up`,
    muted: 'muted — make audible again',
    mute: 'mute',
    muteAria: (stem: string) => `Mute ${stem}`,
    soloed: 'solo — clear',
    solo: 'hear this stem alone',
    soloAria: (stem: string) => `Hear ${stem} alone`,
    position: (stem: string) => `Song position on stem ${stem}`,
    level: (stem: string) => `Level of ${stem} in percent`,
    soloRate: 'Solo tempo',
    soloRateAria: (stem: string) => `Solo tempo of ${stem} in percent`,
    save: (stem: string) => `Save ${stem} as WAV`,
    notLoaded: 'not loaded',
    stemLoading: 'loading …',
    loadingShort: 'loading …',

    loop: 'A–B loop',
    loopStartAria: 'Loop start A in milliseconds',
    loopEndAria: 'Loop end B in milliseconds',
    loopStartTitle: 'Loop start in milliseconds — arrow keys step by 10 ms',
    loopEndTitle: 'Loop end in milliseconds — arrow keys step by 10 ms',
    loopSetStart: 'Set loop start A to the current position',
    loopSetEnd: 'Set loop end B to the current position',
    loopClear: 'Clear the loop',
    loopOn: 'Loop on',
    loopOff: 'Loop off',
    loopEmpty: 'No loop · drag across a waveform to set one',
    loopHelp:
      'The A and B marks can be dragged along the timeline — with mouse, ' +
      'finger or keyboard: arrow keys 1 s, with shift 0.1 s, page up/down ' +
      '10 s, home and end to the edges.',
    loopHelpSr: 'How to use the loop marks',

    tech: 'Technical',
    techPosition: 'Position in seconds of the original song',
    techContext: (hz: number) => `shared AudioContext ${hz} Hz`,
    techLead: (lead: number | null, node: number | null) =>
      `Switching ${lead} ms ahead, onto the same audio time for every stem ` +
      `(stretch node ${node} ms)`,
    techMemory: (mb: string) => `${mb} MB decoded in memory in total`,
  },

  card: {
    eyebrow: 'Import',
    lede: 'Separate a song',

    file: {
      pick: 'Choose an MP3 or WAV file',
      drop: 'Drag an MP3 or WAV here',
      another: 'Choose a different file',
      orPick: 'or choose a file',
      wrongType: 'Please choose an MP3 or WAV file.',
    },

    modes: {
      head: 'Separation mode',
      stems: (n: number) => `${n} stems`,
      none: 'No separation mode:',
      outputs: 'Stems in the selected mode',
      willDownload: (name: string, files: number) =>
        `(${name}) is downloaded on the first run ` +
        `(${files} ${files === 1 ? 'file' : 'files'}). Until then the job stays ` +
        'at “Processing”. If the download fails,',
      willDownloadAfter:
        ' helps: the script tries several sources and says where it fails.',
    },

    ask: {
      no: 'No',
      yes: 'Yes',
      download: (mb: number) => `Download ${mb} MB of model weights?`,
      downloadWhy: (mode: string, name: string, mb: number) =>
        `“${mode}” (${name}) runs in the browser and fetches its weights once. ` +
        'They stay in the browser cache afterwards: every further song starts ' +
        `right away, even offline. On mobile data those ${mb} MB count ` +
        'against your allowance.',
    },

    memory: {
      during: (mode: string, stems: number) =>
        `“${mode}” holds ${stems} stems and the input in memory at the same ` +
        'time while it runs',
      deviceSays: (gb: number) => `This device reports ${gb} GB.`,
      deviceUnknown:
        "This browser does not disclose the device's memory; 4 GB is assumed.",
      tooSmall: (mode: string, needed: string, device: string) =>
        `There is not enough memory on this device for “${mode}”: around ` +
        `${needed} MB is needed, and the model weights alone take about ` +
        `400 MB of that. ${device} A shorter excerpt will not help here.`,
      tooLong: (
        length: string,
        during: string,
        needed: string,
        device: string,
        fits: string,
      ) =>
        `${length} is too long for this device. ${during} — around ` +
        `${needed} MB together with the model. ${device} Up to about ${fits} ` +
        'works here; a shorter excerpt can be separated.',
      tight: (needed: string) => `Tight: around ${needed} MB of memory needed.`,
      tightWhy: (
        during: string,
        length: string,
        audio: string,
        device: string,
      ) =>
        `${during} — at ${length} that is ${audio} MB, plus about 400 MB for ` +
        `the model. ${device} It may well work. If it does not, the browser ` +
        'ends the tab and the separation is gone — nothing is saved along the ' +
        'way.',
    },

    foot: {
      test: 'Create test stems',
      testWhy:
        'Creates three synthetic stems without separating anything: two click ' +
        'tracks with clicks at exactly the same moments, and a steady 440 Hz ' +
        'tone. If the click tracks run in sync, you hear a single click.',
      start: 'Separate',
      startStems: (stems: number) => `Separate ${stems} stems`,
      preparing: 'preparing …',
      sending: 'sending to the server …',
    },
  },
};
