import { input, password, checkbox, select, confirm } from '@inquirer/prompts';
import { MODELS, readConfig, normalizeBaseApi, saveConfig, configPath } from '../skills/linger-image-gen/scripts/lib/config.mjs';
import { HELP, parseCommand, runtime } from '../skills/linger-image-gen/scripts/lib/runtime.mjs';
import { installPlugin } from './installer.mjs';

const validate = (fn) => (value) => { try { fn(value); return true; } catch (error) { return error.message; } };

export async function collectConfig(previous, prompts = { input, password, checkbox, select, confirm }) {
  console.log('\nLinger Image Gen\n');
  const baseApi = normalizeBaseApi(await prompts.input({
    message: 'BASE_API 地址（域名自动补 /v1；自定义路径原样保留）',
    default: previous.baseApi,
    validate: validate(normalizeBaseApi),
  }));
  if (baseApi.startsWith('http://') && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseApi).hostname)) {
    const allow = await prompts.confirm({ message: '此 HTTP 地址会明文传输 API Key，是否继续？', default: false });
    if (!allow) throw new Error('已取消，请使用 HTTPS 地址重新配置。');
  }
  const apiKey = (await prompts.password({
    message: previous.apiKey ? 'API_KEY（隐藏输入；留空保留当前密钥）' : 'API_KEY（隐藏输入）',
    mask: '*',
    validate: (value) => (value.trim() || previous.apiKey) ? true : '请输入 API_KEY。',
  })).trim() || previous.apiKey;
  const enabledModels = await prompts.checkbox({
    message: '选择可使用的模型（空格多选，回车确认）',
    required: true,
    choices: MODELS.map((m) => ({ name: m.name, value: m.id, checked: previous.enabledModels.includes(m.id) })),
    validate: (value) => value.length > 0 || '至少选择一个模型。',
  });
  const defaultModel = enabledModels.length === 1 ? enabledModels[0] : await prompts.select({
    message: '默认使用的模型',
    default: enabledModels.includes(previous.defaultModel) ? previous.defaultModel : enabledModels[0],
    choices: MODELS.filter((m) => enabledModels.includes(m.id)).map((m) => ({ name: m.name, value: m.id })),
  });
  return { version: 1, baseApi, apiKey, enabledModels, defaultModel };
}

export async function main(args = process.argv.slice(2)) {
  const { command, values } = parseCommand(args);
  if (command === 'help') return console.log(HELP);
  if (!['install', 'configure'].includes(command)) return runtime(command, values);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('安装向导需要交互终端，请在终端运行 npx linger-image-gen。');
  }
  const previous = await readConfig({ requireKey: false });
  const config = await collectConfig(previous);
  console.log(`\n配置存储于 ${configPath()}（本地文件，API Key 不进入插件包）。`);
  if (command === 'configure') {
    await saveConfig(config);
    console.log('配置已更新，下次调用立即生效。');
    return;
  }
  const result = await installPlugin(config, { skipCodex: values['skip-codex'] });
  console.log(`\n插件文件：${result.destination}\n配置文件：${result.configFile}`);
  if (result.activated) {
    console.log('插件已安装到 Codex。请打开新任务，使用 $linger-image-gen 生成或编辑图片。');
  } else {
    const reason = { skipped: '已跳过 Codex 激活', 'missing-cli': '未找到 Codex CLI', failed: 'Codex 激活失败' }[result.activation];
    console.log(`${reason}；插件文件和 personal marketplace 已就绪。\n请在可用的 Codex CLI 中运行：codex plugin add ${result.selector}\n或从 Codex 插件页安装，再打开新任务。`);
    if (result.activation === 'failed') process.exitCode = 1;
  }
  console.log(`codex://plugins/linger-image-gen?marketplacePath=${encodeURIComponent(result.marketplaceFile)}`);
}
