import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { modelId } from './config.mjs';

const MAX_RESPONSE = 150 * 1024 * 1024;
const MAX_IMAGE = 50 * 1024 * 1024;

async function limitedBody(response, limit = MAX_RESPONSE) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('接口返回内容超过大小限制。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Error('接口返回内容超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function httpError(status) {
  const hints = {
    400: '请求参数不受接口支持，请检查尺寸、质量及图片格式。',
    401: 'API_KEY 无效或已过期。',
    403: 'API_KEY 无权使用此模型或端点。',
    404: '请检查 BASE_API、模型权限与接口路径。',
    429: '请求过于频繁或额度不足。',
  };
  return new Error(`接口请求失败（HTTP ${status}）。${hints[status] ?? '请检查服务状态后再试。'}未自动重试。`);
}

async function request(url, options = {}, { timeout = 180000, fetchImpl = fetch, signal } = {}) {
  // Cancellation uses one dedicated controller instead of AbortSignal.any so
  // the two causes stay distinguishable: a caller abort is a user decision,
  // the request deadline is a transport fault.
  const deadline = AbortSignal.timeout(timeout);
  const controller = new AbortController();
  const abort = (reason) => controller.abort(reason);
  if (signal) {
    if (signal.aborted) abort(signal.reason);
    else signal.addEventListener('abort', () => abort(signal.reason), { once: true });
  }
  if (deadline.aborted) abort(deadline.reason);
  else deadline.addEventListener('abort', () => abort(deadline.reason), { once: true });
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    return await limitedBody(response);
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      // A cancelled call is a user decision, not a retryable transport fault.
      if (signal?.aborted) throw new Error('请求已取消；服务端可能仍在处理，未自动重试。');
      throw new Error('接口请求超时；服务端可能仍在处理，未自动重试。');
    }
    if (error instanceof TypeError) throw new Error('网络请求失败，请检查 BASE_API、网络和 TLS 配置。未自动重试。');
    throw error;
  }
}

async function jsonRequest(config, endpoint, options = {}, network = {}) {
  const buffer = await request(`${config.baseApi}${endpoint}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${config.apiKey}` },
  }, network);
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('接口返回的不是有效 JSON，请检查 BASE_API 是否指向兼容 API。'); }
}

export async function checkModels(config, network = {}) {
  const response = await jsonRequest(config, '/models', {}, { timeout: 15000, ...network });
  if (!Array.isArray(response.data)) throw new Error('模型列表响应缺少 data 数组。');
  const ids = new Set(response.data.map((item) => item?.id));
  return config.enabledModels.map((id) => ({ id, listed: ids.has(id) }));
}

export function imageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('接口或输入文件不是受支持的 PNG、JPEG 或 WebP 图片。');
}

export function validateJob(job, config) {
  if (typeof job.prompt !== 'string' || !job.prompt.trim()) throw new Error('请输入非空 prompt。');
  const model = modelId(job.model ?? config.defaultModel);
  if (!config.enabledModels.includes(model)) throw new Error('此模型未启用，请运行 configure 在多选框中启用。');
  const n = Number(job.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('n 必须是 1–10 的整数。');
  const quality = job.quality;
  if (quality && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(quality)) throw new Error('quality 必须为 auto、low、medium、high、xhigh 或 max。');
  const size = job.size;
  if (size && size !== 'auto') {
    if (!/^\d+x\d+$/.test(size)) throw new Error('size 必须为 auto 或 WIDTHxHEIGHT。');
    const [w, h] = size.split('x').map(Number);
    if (w % 16 || h % 16 || Math.min(w, h) <= 0 || Math.max(w, h) > 3840 ||
        Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) {
      throw new Error('尺寸边长须为 16 的倍数，最大边 3840，宽高比在 1:3–3:1，像素数在 655360–8294400。');
    }
  }
  const format = job.output_format ?? 'png';
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('format 必须为 png、jpeg 或 webp。');
  if (job.background && !['auto', 'opaque', 'transparent'].includes(job.background)) throw new Error('background 必须为 auto、opaque 或 transparent。');
  if (job.background === 'transparent' && format === 'jpeg') throw new Error('透明背景需要 png 或 webp 格式。');
  if (job.image !== undefined && (!Array.isArray(job.image) || !job.image.length || job.image.length > 16 || job.image.some((p) => typeof p !== 'string' || !p))) {
    throw new Error('image 必须包含 1–16 个本地图片路径。');
  }
  if (job.mask && !job.image?.length) throw new Error('mask 必须与输入图片一起使用。');
  if (job.mask !== undefined && (typeof job.mask !== 'string' || !job.mask)) throw new Error('mask 必须为本地 PNG 文件路径。');
  return { ...job, model, n, output_format: format };
}

async function inputBlob(path, mask = false) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_IMAGE) throw new Error('输入图片必须为不超过 50 MB 的普通文件。');
  const bytes = await readFile(path);
  const format = imageFormat(bytes);
  if (mask && format !== 'png') throw new Error('蒙版必须是带透明通道的 PNG 图片。');
  return new Blob([bytes], { type: `image/${format}` });
}

export async function validateInputs(job) {
  for (const path of job.image ?? []) await inputBlob(path);
  if (job.mask) await inputBlob(job.mask, true);
  if (job.out !== undefined && (typeof job.out !== 'string' || !job.out.trim())) throw new Error('out 必须为非空文件路径。');
  if (job.out) {
    const ext = extname(job.out).toLowerCase();
    const expected = job.output_format === 'jpeg' ? ['.jpg', '.jpeg'] : [`.${job.output_format}`];
    if (!expected.includes(ext)) throw new Error('输出文件扩展名与 format 不一致。');
  }
}

export async function createImages(input, config, network = {}) {
  const job = validateJob(input, config);
  const fields = { model: job.model, prompt: job.prompt, n: job.n };
  for (const key of ['size', 'quality', 'background', 'output_format']) {
    if (job[key] !== undefined) fields[key] = job[key];
  }
  let response;
  if (job.image?.length) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    for (const path of job.image) body.append('image[]', await inputBlob(path), basename(path));
    if (job.mask) body.set('mask', await inputBlob(job.mask, true), basename(job.mask));
    response = await jsonRequest(config, '/images/edits', { method: 'POST', body }, network);
  } else {
    response = await jsonRequest(config, '/images/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    }, network);
  }
  if (!Array.isArray(response.data) || response.data.length !== job.n) {
    throw new Error(`图片接口返回数量与请求数量 ${job.n} 不符。未自动重试。`);
  }
  const images = [];
  for (const item of response.data) {
    let bytes;
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json) || item.b64_json.length % 4 === 1) throw new Error('图片 base64 数据无效。');
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item?.url === 'string') {
      let url;
      try { url = new URL(item.url); } catch { throw new Error('图片下载地址无效。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('图片下载地址必须为无凭据的 HTTP(S) URL。');
      // Image hosts never receive API credentials. Redirects are rejected.
      bytes = await request(url, {}, network);
    } else {
      throw new Error('图片响应缺少 b64_json 或 url。');
    }
    if (imageFormat(bytes) !== job.output_format) throw new Error('接口返回的图片格式与请求不一致，未保存伪装扩展名的文件。');
    images.push(bytes);
  }
  return images;
}
