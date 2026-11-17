import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
    }
  }
}
for (const directory of ['bin', 'src', 'lib', 'skills', 'scripts', 'test']) await check(directory);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
assert.equal(pkg.name, manifest.name);
// An installed copy of the Codex plugin manifest carries build metadata
// (`0.1.0+codex.<timestamp>`); the base version must still match the package.
assert.equal(manifest.version.split('+')[0], pkg.version);

// The dsh bundle patch must insert exactly this package, otherwise
// `dsh plugin add` installs a layer that resolves to nothing.
const patch = await readFile('cordis.patch.yml', 'utf8');
const rows = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1]);
assert.deepEqual(rows, [pkg.name]);
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
assert.ok(pkg.files.includes('cordis.patch.yml'), 'cordis.patch.yml must ship in the package');
assert.ok(pkg.files.includes('lib/'), 'lib/ must ship in the package');
assert.equal(pkg.exports['.'], './lib/index.mjs');
console.log('Syntax and package metadata checks passed.');
