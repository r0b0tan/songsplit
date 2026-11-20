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
