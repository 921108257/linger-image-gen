import { parseArgs } from 'node:util';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, publicConfig, MODELS } from './config.mjs';
import { checkModels, createImages, validateInputs, validateJob } from './api.mjs';

export const HELP = `Linger Image Gen

  linger-image-gen                         交互安装向导
  linger-image-gen install [--skip-codex]   安装插件并配置
  linger-image-gen configure               修改 API 配置和已启用模型
  linger-image-gen config                  查看配置（隐藏 API Key）
  linger-image-gen models                  查看固定模型和启用状态
  linger-image-gen doctor                  检查 API 连接（GET /models，不生成图片）
  linger-image-gen generate --prompt "..." [--model flare|sunburst] [--out path.png]
  linger-image-gen edit --image input.png --prompt "..." [--mask mask.png]
  linger-image-gen generate-batch --input jobs.jsonl [--out-dir output/imagegen]

图片选项：
  --prompt-file PATH       从 UTF-8 文件读取提示词，与 --prompt 二选一
  --model ID              只能使用已启用的 flare / sunburst 或其固定完整 ID
  --n 1                   同一个提示词的图片数量（1–10）
  --size WIDTHxHEIGHT     例如 1024x1024、1536x1024、auto
  --quality VALUE         auto / low / medium / high / xhigh / max
  --format VALUE          png（默认）/ jpeg / webp
  --background VALUE      auto / opaque / transparent
  --image PATH            本地参考图或编辑目标；可重复指定
  --out PATH              输出位置；已有文件使用编号，不覆盖
  --out-dir PATH          默认 output/imagegen
  --timeout SECONDS       请求超时，默认 180 秒
  --dry-run               验证配置和任务，不发出 API 请求

环境变量：BASE_API、API_KEY、LINGER_IMAGE_GEN_CONFIG（配置文件路径）
`;

const GENERATION_OPTIONS = {
  prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, model: { type: 'string' },
  n: { type: 'string' }, size: { type: 'string' }, quality: { type: 'string' },
  format: { type: 'string' }, background: { type: 'string' },
  image: { type: 'string', multiple: true }, mask: { type: 'string' },
  out: { type: 'string' }, 'out-dir': { type: 'string' },
  timeout: { type: 'string' }, 'dry-run': { type: 'boolean' },
};

export function parseCommand(args) {
  const [command = 'install', ...rest] = args;
  if (['--help', '-h', 'help'].includes(command)) return { command: 'help', values: {} };
  const options = {
    install: { 'skip-codex': { type: 'boolean' } }, configure: {}, config: {}, models: {}, doctor: {},
    generate: GENERATION_OPTIONS, edit: GENERATION_OPTIONS,
    'generate-batch': {
      input: { type: 'string' }, 'out-dir': { type: 'string' }, timeout: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  }[command];
  if (!options) throw new Error('未知命令。运行 linger-image-gen --help 查看用法。');
  // Reject unknown options without echoing their value (a key might be passed accidentally).
  let parsed;
  try { parsed = parseArgs({ args: rest, options: { ...options, help: { type: 'boolean', short: 'h' } }, strict: true }); }
  catch { throw new Error('命令参数无效；请查看 --help。API_KEY 只能通过向导或环境变量输入。'); }
  return { command: parsed.values.help ? 'help' : command, values: parsed.values };
}

async function promptFrom(values) {
  if (values.prompt !== undefined && values['prompt-file'] !== undefined) throw new Error('prompt 与 prompt-file 只能提供一个。');
  return values['prompt-file'] ? readFile(resolve(values['prompt-file']), 'utf8') : values.prompt;
}

export async function saveImage(bytes, target) {
  target = resolve(target);
  await mkdir(dirname(target), { recursive: true });
  const ext = extname(target);
  const stem = target.slice(0, -ext.length);
  for (let index = 0; index < 10000; index++) {
    const path = index === 0 ? target : `${stem}-${index + 1}${ext}`;
    let file;
    try { file = await open(path, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { await file.writeFile(bytes); }
    catch (error) { await file.close(); await unlink(path); throw error; }
    await file.close();
    return path;
  }
  throw new Error('输出文件重名过多，请指定不同路径。');
}

export async function runtime(command, values, { log = console.log, configOptions, network } = {}) {
  if (command === 'help') return log(HELP);
  const readOnly = ['config', 'models'].includes(command) || values['dry-run'];
  const config = await readConfig({ ...configOptions, requireKey: !readOnly });
  if (command === 'config') return log(JSON.stringify(publicConfig(config), null, 2));
  if (command === 'models') return log(JSON.stringify(MODELS.map((m) => ({
    ...m, enabled: config.enabledModels.includes(m.id), default: m.id === config.defaultModel,
  })), null, 2));
  if (command === 'doctor') {
    const result = await checkModels(config, network);
    log(JSON.stringify({ models: result, note: '模型列表不能证明生成权限；部分兼容服务不提供完整列表。' }, null, 2));
    return;
  }
  const seconds = Number(values.timeout ?? 180);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error('timeout 必须在 1–3600 秒之间。');
  let jobs;
  if (command === 'generate-batch') {
    if (!values.input) throw new Error('generate-batch 需要 --input JSONL 文件。');
    const lines = (await readFile(resolve(values.input), 'utf8')).split(/\r?\n/);
    jobs = lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      let job;
      try { job = JSON.parse(line); } catch { throw new Error(`JSONL 第 ${index + 1} 行不是有效 JSON。`); }
      const keys = ['prompt', 'model', 'n', 'size', 'quality', 'output_format', 'background', 'image', 'mask', 'out'];
      if (!job || Array.isArray(job) || typeof job !== 'object' || Object.keys(job).some((k) => !keys.includes(k))) throw new Error(`JSONL 第 ${index + 1} 行包含无效任务字段。`);
      return [validateJob(job, config)];
    });
    if (!jobs.length) throw new Error('JSONL 文件没有任务。');
  } else {
    const job = {
      prompt: await promptFrom(values), model: values.model, n: values.n,
      size: values.size, quality: values.quality, output_format: values.format,
      background: values.background, image: values.image, mask: values.mask, out: values.out,
    };
    if (command === 'edit' && !job.image?.length) throw new Error('edit 需要至少一个 --image 本地图片。');
    jobs = [validateJob(job, config)];
  }
  // Validate every batch input before making the first potentially billable request.
  for (const job of jobs) await validateInputs(job);
  if (values['dry-run']) return log(JSON.stringify({ dryRun: true, jobs }, null, 2));
  const outputs = [];
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    try {
      const images = await createImages(job, config, { timeout: seconds * 1000, ...network });
      const name = `linger-${Date.now()}-${randomUUID().slice(0, 8)}.${job.output_format}`;
      const target = job.out ?? resolve(values['out-dir'] ?? 'output/imagegen', name);
      const paths = [];
      for (const bytes of images) {
        const path = await saveImage(bytes, target);
        paths.push(path);
        log(JSON.stringify({ saved: path, model: job.model, job: index + 1 }));
      }
      outputs.push({ paths, model: job.model, prompt: job.prompt });
    } catch (error) {
      throw new Error(`任务 ${index + 1}/${jobs.length} 失败：${error.message} 已输出的文件保留，后续任务未执行。`);
    }
  }
  return outputs;
}
