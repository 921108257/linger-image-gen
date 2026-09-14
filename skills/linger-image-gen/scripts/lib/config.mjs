import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const MODELS = Object.freeze([
  Object.freeze({ id: 'gpt-image-2.5-flare', name: 'GPT-Image-2.5 Flare', alias: 'flare' }),
  Object.freeze({ id: 'gpt-image-2.5-sunburst', name: 'GPT-Image-2.5 Sunburst', alias: 'sunburst' }),
]);

export function modelId(value) {
  const model = MODELS.find((item) => item.id === value || item.alias === value);
  if (!model) throw new Error('模型只能选择 flare 或 sunburst，不能自定义模型 ID。');
  return model.id;
}

export function normalizeBaseApi(value) {
  let url;
  try { url = new URL(value?.trim()); } catch { throw new Error('BASE_API 必须是完整的 HTTP(S) 地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('BASE_API 仅支持 HTTP(S)，不能包含用户名、密码、查询参数或片段。');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (/\/images\/(generations|edits)$/.test(path) || /\/models$/.test(path)) {
    throw new Error('BASE_API 请填写接口根地址，例如 https://example.com/v1，不要包含 images/generations。');
  }
  if (!path) path = '/v1';
  return `${url.origin}${path}`;
}

export function configPath(env = process.env, home = homedir()) {
  return env.LINGER_IMAGE_GEN_CONFIG
    ? resolve(env.LINGER_IMAGE_GEN_CONFIG)
    : join(home, '.config', 'linger-image-gen', 'config.json');
}

export async function assertRegularFile(path, optional = false) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('配置目标必须是普通文件，不能是符号链接。');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

export function validateConfig(input, { requireKey = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象。');
  if (input.version !== 1) throw new Error('配置版本不受支持，请重新运行安装向导。');
  const baseApi = input.baseApi ? normalizeBaseApi(input.baseApi) : undefined;
  if (requireKey && !baseApi) throw new Error('缺少 BASE_API，请运行安装向导或设置 BASE_API 环境变量。');
  const apiKey = input.apiKey?.trim();
  if (requireKey && !apiKey) throw new Error('缺少 API_KEY，请在本地安装向导中输入或设置 API_KEY 环境变量。');
  if (apiKey && /[\r\n\x00-\x1f\x7f]/.test(apiKey)) throw new Error('API_KEY 不能包含控制字符。');
  if (!Array.isArray(input.enabledModels) || !input.enabledModels.length ||
      input.enabledModels.some((id) => !MODELS.some((m) => m.id === id))) {
    throw new Error('至少启用一个模型，且仅允许固定的 Flare 和 Sunburst 模型 ID。');
  }
  const enabledModels = [...new Set(input.enabledModels)];
  if (!enabledModels.includes(input.defaultModel)) throw new Error('默认模型必须在已启用的模型中。');
  return { version: 1, baseApi, apiKey, enabledModels, defaultModel: input.defaultModel };
}

export async function readConfig({ path = configPath(), env = process.env, requireKey = true } = {}) {
  let stored;
  if (await assertRegularFile(path, true)) {
    try { stored = JSON.parse(await readFile(path, 'utf8')); }
    catch { throw new Error('无法读取配置 JSON，请使用 configure 重新配置。'); }
  }
  const config = validateConfig({
    ...(stored ?? { version: 1, enabledModels: MODELS.map((m) => m.id), defaultModel: MODELS[0].id }),
    ...(env.BASE_API ? { baseApi: env.BASE_API } : {}),
    ...(env.API_KEY ? { apiKey: env.API_KEY } : {}),
  }, { requireKey });
  return { ...config, configured: Boolean(stored), path };
}

export async function atomicJson(path, data, { privateFile = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: privateFile ? 0o700 : 0o755 });
  await assertRegularFile(path, true);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: privateFile ? 0o600 : 0o644 });
    await rename(temp, path);
    if (privateFile) await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function saveConfig(config, path = configPath()) {
  const clean = validateConfig(config);
  await atomicJson(path, clean, { privateFile: true });
  return path;
}

export function publicConfig(config) {
  return {
    path: config.path,
    configured: config.configured,
    baseApi: config.baseApi,
    apiKey: config.apiKey ? '已配置（隐藏）' : '未配置',
    enabledModels: config.enabledModels,
    defaultModel: config.defaultModel,
  };
}
