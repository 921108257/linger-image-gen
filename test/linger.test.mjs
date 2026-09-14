import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { MODELS, normalizeBaseApi, validateConfig, saveConfig, readConfig, publicConfig } from '../skills/linger-image-gen/scripts/lib/config.mjs';
import { createImages, validateJob, checkModels } from '../skills/linger-image-gen/scripts/lib/api.mjs';
import { runtime, parseCommand, saveImage } from '../skills/linger-image-gen/scripts/lib/runtime.mjs';
import { installPlugin } from '../src/installer.mjs';
import { collectConfig } from '../src/cli.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0mQAAAAASUVORK5CYII=', 'base64');
const baseConfig = () => ({ version: 1, baseApi: 'https://example.com/v1', apiKey: 'test-secret-do-not-log', enabledModels: MODELS.map((m) => m.id), defaultModel: MODELS[0].id });

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'linger-test-'));
  t.after(() => rm(path, { force: true, recursive: true }));
  return path;
}

async function server(t, handler) {
  const srv = createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500); res.end(error.message);
  }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('normalizes API roots and rejects credentials, full endpoints, and non-http schemes', () => {
  assert.equal(normalizeBaseApi('https://example.com/'), 'https://example.com/v1');
  assert.equal(normalizeBaseApi('https://example.com/custom/v1/'), 'https://example.com/custom/v1');
  for (const url of ['file:///tmp/test', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com/v1/images/generations']) {
    assert.throws(() => normalizeBaseApi(url));
  }
});

test('only the two exact fixed IDs may be enabled; default must be enabled', () => {
  for (const enabledModels of [[], ['custom'], ['flare'], [MODELS[0].id, 'custom']]) {
    assert.throws(() => validateConfig({ ...baseConfig(), enabledModels }));
  }
  assert.throws(() => validateConfig({ ...baseConfig(), enabledModels: [MODELS[1].id] }));
  const config = { ...baseConfig(), enabledModels: [MODELS[0].id] };
  assert.throws(() => validateJob({ prompt: 'hello', model: 'sunburst' }, config), /未启用/);
  assert.throws(() => validateJob({ prompt: 'hello', model: 'custom' }, config), /不能自定义/);
});

test('config is private, redacted, and environment overrides are validated', async (t) => {
  const path = join(await temporary(t), 'config.json');
  await saveConfig(baseConfig(), path);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const read = await readConfig({ path, env: { BASE_API: 'https://other.example', API_KEY: 'override' } });
  assert.equal(read.baseApi, 'https://other.example/v1');
  assert.equal(read.apiKey, 'override');
  assert.ok(!JSON.stringify(publicConfig(read)).includes('override'));
  await assert.rejects(() => readConfig({ path, env: { API_KEY: 'bad\nheader' } }), /控制字符/);
});

test('wizard exposes a multi-select of only fixed IDs and selects a default', async () => {
  let choices;
  const config = await collectConfig(baseConfig(), {
    input: async () => 'https://gateway.example', password: async () => '',
    checkbox: async (options) => { choices = options.choices; assert.notEqual(options.validate([]), true); return [MODELS[1].id]; },
    select: async () => { throw new Error('Single selected model should become default'); },
  });
  assert.deepEqual(choices.map((c) => c.value), MODELS.map((m) => m.id));
  assert.equal(config.defaultModel, MODELS[1].id);
  assert.equal(config.apiKey, baseConfig().apiKey);
  const both = await collectConfig(baseConfig(), {
    input: async () => 'https://gateway.example', password: async () => 'new-key',
    checkbox: async () => MODELS.map((m) => m.id),
    select: async (options) => { assert.equal(options.choices.length, 2); return MODELS[1].id; },
  });
  assert.equal(both.defaultModel, MODELS[1].id);
});

test('installer creates a self-contained plugin and registers/activates the personal marketplace', async (t) => {
  const home = await temporary(t);
  const configFile = join(home, 'config', 'config.json');
  let command;
  const result = await installPlugin(baseConfig(), { home, configFile, runCodex: (args) => { command = args; return { status: 0 }; } });
  assert.equal(result.activated, true);
  assert.deepEqual(command, ['plugin', 'add', 'linger-image-gen@personal']);
  const marketplace = JSON.parse(await readFile(result.marketplaceFile, 'utf8'));
  assert.equal(marketplace.plugins[0].source.path, './plugins/linger-image-gen');
  assert.equal(marketplace.plugins[0].policy.authentication, 'ON_INSTALL');
  const files = await readdir(result.destination);
  assert.deepEqual(files.sort(), ['.codex-plugin', 'skills']);
  const script = join(result.destination, 'skills/linger-image-gen/scripts/linger-image-gen.mjs');
  const run = spawnSync(process.execPath, [script, 'models'], { env: { ...process.env, LINGER_IMAGE_GEN_CONFIG: configFile }, encoding: 'utf8', cwd: tmpdir() });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(MODELS[1].id));
  assert.ok(!run.stdout.includes(baseConfig().apiKey));
});

test('reinstall preserves marketplace metadata, order, other entries and existing policy', async (t) => {
  const home = await temporary(t);
  const configFile = join(home, 'config.json');
  const path = join(home, '.agents/plugins/marketplace.json');
  await mkdir(join(home, '.agents/plugins'), { recursive: true });
  const existing = {
    name: 'my-personal', interface: { displayName: 'My Plugins' },
    plugins: [{ name: 'other', source: { source: 'local', path: './plugins/other' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }],
  };
  await writeFile(path, JSON.stringify(existing));
  const first = await installPlugin(baseConfig(), { home, configFile, skipCodex: true });
  const registered = await readFile(path, 'utf8');
  const second = await installPlugin({ ...baseConfig(), defaultModel: MODELS[1].id }, { home, configFile, skipCodex: true });
  assert.equal(await readFile(path, 'utf8'), registered);
  assert.equal(second.selector, 'linger-image-gen@my-personal');
  const marketplace = JSON.parse(registered);
  assert.deepEqual(marketplace.plugins[0], existing.plugins[0]);
  assert.deepEqual(marketplace.interface, existing.interface);
  assert.equal(marketplace.plugins.length, 2);
  assert.equal(first.activation, 'skipped');
});

test('invalid marketplace and conflicting source fail before writing credentials', async (t) => {
  for (const data of [{ name: 'bad;cmd', plugins: [] }, { name: 'personal', plugins: [{ name: 'linger-image-gen', source: { source: 'git', path: 'elsewhere' } }] }]) {
    const home = await temporary(t);
    const path = join(home, '.agents/plugins/marketplace.json');
    const configFile = join(home, 'config.json');
    await mkdir(join(home, '.agents/plugins'), { recursive: true });
    await writeFile(path, JSON.stringify(data));
    await assert.rejects(() => installPlugin(baseConfig(), { home, configFile, skipCodex: true }));
    await assert.rejects(() => stat(configFile), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
  }
});

test('activation failure is distinguished from successful plugin installation', async (t) => {
  const home = await temporary(t);
  const result = await installPlugin(baseConfig(), { home, configFile: join(home, 'config.json'), runCodex: () => ({ status: 1 }) });
  assert.equal(result.activated, false);
  assert.equal(result.activation, 'failed');
  assert.ok(await stat(result.destination));
});

test('generation uses the configured endpoint, selected fixed model, and bearer authentication', async (t) => {
  let captured;
  const url = await server(t, async (req, res) => {
    captured = { url: req.url, headers: req.headers, body: JSON.parse(await body(req)) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  const images = await createImages({ prompt: 'test', model: 'sunburst' }, { ...baseConfig(), baseApi: `${url}/custom/v1` });
  assert.deepEqual(images, [PNG]);
  assert.equal(captured.url, '/custom/v1/images/generations');
  assert.equal(captured.headers.authorization, `Bearer ${baseConfig().apiKey}`);
  assert.equal(captured.body.model, MODELS[1].id);
  assert.equal(captured.body.response_format, undefined);
});

test('editing sends real multipart images and mask with content types', async (t) => {
  const dir = await temporary(t);
  const input = join(dir, 'input.png');
  await writeFile(input, PNG);
  let captured;
  const url = await server(t, async (req, res) => {
    captured = { url: req.url, headers: req.headers, body: await body(req) };
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await createImages({ prompt: 'edit', image: [input], mask: input }, { ...baseConfig(), baseApi: `${url}/v1` });
  assert.equal(captured.url, '/v1/images/edits');
  assert.match(captured.headers['content-type'], /multipart\/form-data; boundary=/);
  assert.match(captured.body, /name="image\[\]"; filename="input.png"/);
  assert.match(captured.body, /name="mask"/);
  assert.match(captured.body, /Content-Type: image\/png/);
});

test('URL image responses are downloaded without forwarding credentials', async (t) => {
  let imageAuthorization = 'not-requested';
  const imageHost = await server(t, (req, res) => { imageAuthorization = req.headers.authorization; res.end(PNG); });
  const api = await server(t, (req, res) => { res.end(JSON.stringify({ data: [{ url: `${imageHost}/file.png` }] })); });
  const images = await createImages({ prompt: 'test' }, { ...baseConfig(), baseApi: `${api}/v1` });
  assert.equal(imageAuthorization, undefined);
  assert.deepEqual(images, [PNG]);
});

test('provider errors hide echoed secrets and are never retried', async (t) => {
  let calls = 0;
  const url = await server(t, (req, res) => { calls++; res.writeHead(401); res.end(baseConfig().apiKey); });
  await assert.rejects(() => createImages({ prompt: 'test' }, { ...baseConfig(), baseApi: `${url}/v1` }), (e) => {
    assert.match(e.message, /401/); assert.ok(!e.message.includes(baseConfig().apiKey)); return true;
  });
  assert.equal(calls, 1);
});

test('redirects are rejected without following them', async (t) => {
  let forwarded = false;
  const target = await server(t, (req, res) => { forwarded = true; res.end('{}'); });
  const source = await server(t, (req, res) => { res.writeHead(307, { location: target }); res.end(); });
  await assert.rejects(() => createImages({ prompt: 'test' }, { ...baseConfig(), baseApi: `${source}/v1` }));
  assert.equal(forwarded, false);
});

test('timeout fails without retrying', async (t) => {
  let calls = 0;
  const url = await server(t, () => { calls++; });
  await assert.rejects(() => createImages({ prompt: 'test' }, { ...baseConfig(), baseApi: `${url}/v1` }, { timeout: 30 }), /超时/);
  assert.equal(calls, 1);
});

test('non-image, invalid JSON, and wrong image count responses are rejected', async () => {
  for (const payload of ['html', JSON.stringify({ data: [] }), JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })]) {
    await assert.rejects(() => createImages({ prompt: 'test' }, baseConfig(), { fetchImpl: async () => new Response(payload) }));
  }
});

test('doctor checks only the model endpoint and returns availability for selected models', async (t) => {
  const url = await server(t, (req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/models');
    res.end(JSON.stringify({ data: [{ id: MODELS[0].id }] }));
  });
  assert.deepEqual(await checkModels({ ...baseConfig(), baseApi: `${url}/v1` }), [{ id: MODELS[0].id, listed: true }, { id: MODELS[1].id, listed: false }]);
});

test('image output is non-destructive even for concurrent writes', async (t) => {
  const path = join(await temporary(t), 'image.png');
  await writeFile(path, 'original');
  const saved = await Promise.all([saveImage(PNG, path), saveImage(PNG, path)]);
  assert.equal(new Set(saved).size, 2);
  assert.equal(await readFile(path, 'utf8'), 'original');
  for (const file of saved) assert.deepEqual(await readFile(file), PNG);
});

test('all batch jobs validate before any API requests and dry run needs no secret', async (t) => {
  const dir = await temporary(t);
  const input = join(dir, 'jobs.jsonl');
  const missing = join(dir, 'missing-config.json');
  let calls = 0;
  const network = { fetchImpl: async () => { calls++; throw new Error('unexpected request'); } };
  await writeFile(input, `${JSON.stringify({ prompt: 'ok' })}\n${JSON.stringify({ prompt: 'bad', model: 'custom' })}\n`);
  await assert.rejects(() => runtime('generate-batch', { input, 'dry-run': true }, { configOptions: { path: missing, env: {} }, network }), /不能自定义/);
  await writeFile(input, `${JSON.stringify({ prompt: 'ok' })}\n`);
  let output;
  await runtime('generate-batch', { input, 'dry-run': true }, { configOptions: { path: missing, env: {} }, network, log: (s) => { output = JSON.parse(s); } });
  assert.equal(output.jobs[0].model, MODELS[0].id);
  assert.equal(calls, 0);
});

test('batch stops on error and keeps previously saved images', async (t) => {
  const dir = await temporary(t);
  const configFile = join(dir, 'config.json');
  const input = join(dir, 'jobs.jsonl');
  await saveConfig(baseConfig(), configFile);
  await writeFile(input, ['first', 'second', 'third'].map((prompt) => JSON.stringify({ prompt })).join('\n'));
  let calls = 0;
  const logs = [];
  await assert.rejects(() => runtime('generate-batch', { input, 'out-dir': join(dir, 'output') }, {
    configOptions: { path: configFile, env: {} }, log: (s) => logs.push(JSON.parse(s)),
    network: { fetchImpl: async () => ++calls === 1 ? new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })) : new Response('{}', { status: 429 }) },
  }), /任务 2\/3 失败/);
  assert.equal(calls, 2);
  assert.equal(logs.length, 1);
  assert.deepEqual(await readFile(logs[0].saved), PNG);
});

test('CLI rejects typo options without leaking their values', () => {
  assert.throws(() => parseCommand(['install', '--api-key', 'secret']), (e) => !e.message.includes('secret'));
  assert.throws(() => parseCommand(['generate', '--promt', 'example']));
});
