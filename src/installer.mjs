import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { atomicJson, assertRegularFile, saveConfig, validateConfig, configPath } from '../skills/linger-image-gen/scripts/lib/config.mjs';

export const PLUGIN_NAME = 'linger-image-gen';
const SOURCE = fileURLToPath(new URL('../', import.meta.url));

async function readMarketplace(path) {
  if (!(await assertRegularFile(path, true))) {
    return { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  }
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('现有 personal marketplace 不是有效 JSON，安装已停止。'); }
  if (!data || typeof data.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.name) || !Array.isArray(data.plugins)) {
    throw new Error('现有 marketplace 名称或 plugins 数组无效，安装已停止。');
  }
  if (data.interface !== undefined && (!data.interface || typeof data.interface !== 'object' || Array.isArray(data.interface))) {
    throw new Error('现有 marketplace.interface 格式无效，安装已停止。');
  }
  return data;
}

export async function installPlugin(config, {
  home = homedir(), configFile = configPath(), skipCodex = false,
  source = SOURCE, runCodex = (args) => spawnSync('codex', args, { encoding: 'utf8', timeout: 60000, shell: false }),
} = {}) {
  config = validateConfig(config);
  const marketplaceFile = join(home, '.agents', 'plugins', 'marketplace.json');
  const marketplace = await readMarketplace(marketplaceFile);
  const entry = marketplace.plugins.find((item) => item?.name === PLUGIN_NAME);
  if (entry && (entry.source?.source !== 'local' || entry.source?.path !== `./plugins/${PLUGIN_NAME}`)) {
    throw new Error('已有同名插件指向其他来源，安装已停止以保留现有设置。');
  }
  const destination = join(home, 'plugins', PLUGIN_NAME);
  let exists = false;
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件目标不是普通目录，无法更新。');
    let manifest;
    try { manifest = JSON.parse(await readFile(join(destination, '.codex-plugin', 'plugin.json'), 'utf8')); }
    catch { throw new Error('插件目标目录含有无法识别的文件，无法覆盖。'); }
    if (manifest.name !== PLUGIN_NAME) throw new Error('插件目标目录名称冲突，无法覆盖。');
    exists = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await assertRegularFile(configFile, true);
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.stage-${randomUUID()}`;
  const backup = `${destination}.backup-${randomUUID()}`;
  let moved = false;
  try {
    await mkdir(staging);
    for (const path of ['.codex-plugin', 'skills']) await cp(join(source, path), join(staging, path), { recursive: true });
    const manifestFile = join(staging, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.name !== PLUGIN_NAME) throw new Error('安装包中的插件名称无效。');
    manifest.version = `${manifest.version.split('+')[0]}+codex.${Date.now()}`;
    await atomicJson(manifestFile, manifest);
    if (exists) { await rename(destination, backup); moved = true; }
    try { await rename(staging, destination); }
    catch (error) { if (moved) { await rename(backup, destination); moved = false; } throw error; }
    await saveConfig(config, configFile);
    if (!entry) {
      marketplace.plugins.push({
        name: PLUGIN_NAME, source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
      });
      await atomicJson(marketplaceFile, marketplace);
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
    // Retain the previous plugin if a later step fails; its path is recoverable.
  }
  if (moved) await rm(backup, { recursive: true });
  const selector = `${PLUGIN_NAME}@${marketplace.name}`;
  const result = skipCodex ? undefined : runCodex(['plugin', 'add', selector]);
  return {
    destination, configFile, marketplaceFile, selector,
    activated: result?.status === 0,
    activation: skipCodex ? 'skipped' : result?.error?.code === 'ENOENT' ? 'missing-cli' : result?.status === 0 ? 'installed' : 'failed',
  };
}
