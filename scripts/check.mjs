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
for (const directory of ['bin', 'src', 'skills', 'scripts', 'test']) await check(directory);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
assert.equal(pkg.name, manifest.name);
assert.equal(pkg.version, manifest.version);
console.log('Syntax and package metadata checks passed.');
