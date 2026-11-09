/**
 * Fuehrt die Pruefungen der Signalverarbeitung aus.
 *
 *   node tests/separate/run.mjs
 *
 * Kein Browser: hier wird nur gerechnet. `dsp-check.ts` wird mit esbuild
 * gebuendelt und in Node geladen; verglichen wird gegen
 * `fixtures/index.json` aus `backend/tools/demucs_reference.py --fixtures`.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));

async function main() {
  let fixtures;
  try {
    fixtures = JSON.parse(await readFile(join(here, 'fixtures', 'index.json'), 'utf8'));
  } catch {
    console.error(
      'fixtures/index.json fehlt. Erst anlegen:\n' +
        '  cd backend && ../.venv/bin/python tools/demucs_reference.py ' +
        '--fixtures ../frontend/tests/separate/fixtures\n',
    );
    process.exit(2);
  }

  const out = await mkdtemp(join(tmpdir(), 'songsplit-dsp-'));
  const bundle = join(out, 'dsp-check.mjs');
  await esbuild.build({
    entryPoints: [join(here, 'dsp-check.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: bundle,
    logLevel: 'warning',
  });

  const mod = await import(pathToFileURL(bundle).href);
  const started = Date.now();
  const checks = mod.runChecks(fixtures);
  const seconds = (Date.now() - started) / 1000;

  console.log('\nSIGNALVERARBEITUNG (Node, gegen die numpy-Referenz)\n');
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`  [${c.pass ? 'OK  ' : 'FEHL'}] ${c.name}`);
    console.log(`         ${c.detail}`);
  }
  console.log(
    `\n  ${checks.length - failed} von ${checks.length} Pruefungen bestanden ` +
      `(${seconds.toFixed(1)} s).\n`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
