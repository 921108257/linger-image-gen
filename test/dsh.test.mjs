import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODELS, saveConfig } from '../skills/linger-image-gen/scripts/lib/config.mjs';
import { createImages } from '../skills/linger-image-gen/scripts/lib/api.mjs';
import * as dsh from '../src/dsh.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0mQAAAAASUVORK5CYII=', 'base64');
const config = () => ({ version: 1, baseApi: 'https://example.com/v1', apiKey: 'test-secret-do-not-log', enabledModels: MODELS.map((m) => m.id), defaultModel: MODELS[0].id });

/**
 * Resolve the DSH packages the host would provide.
 *
 * The plugin resolves `@deepseek-ai/*` from the profile that installed it, so
 * the integration test resolves them the same way and skips when no DSH
 * installation is present instead of failing the suite on a bare checkout.
 */
function dshModules() {
  const packages = {
    tools: '@deepseek-ai/dsh-tools',
    skill: '@deepseek-ai/dsh-skill',
    cordis: '@deepseek-ai/cordis',
    scope: '@deepseek-ai/dsh-scope',
    systemPrompt: '@deepseek-ai/dsh-system-prompt',
  };
  const roots = [
    join(dsh.dshHome(), 'profiles'),
    join(dsh.dshHome(), 'profiles', 'web'),
    join(process.env.HOME ?? '', '.local/share/deepseek-harness/runtime'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const require = createRequire(join(root, 'noop.js'));
      return Object.fromEntries(Object.entries(packages).map(([key, name]) => [key, pathToFileURL(require.resolve(name)).href]));
    } catch { /* try the next root */ }
  }
  return undefined;
}

const modules = dshModules();

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'linger-dsh-'));
  t.after(() => rm(path, { force: true, recursive: true }));
  return path;
}

async function server(t, handler) {
  const srv = createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => { res.writeHead(500); res.end(error.message); }));
  await new Promise((ready) => srv.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise((ready) => { srv.closeAllConnections(); srv.close(ready); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

/**
 * Load the plugin the way the dsh loader does and capture what it registers.
 * @returns the registered skills, tools, and the plugin's exported shape.
 */
async function loadPlugin() {
  const plugin = await import(pathToFileURL(fileURLToPath(new URL('../lib/index.mjs', import.meta.url))).href);
  const skills = [];
  const tools = [];
  const ctx = {
    skills: { registerProvider: (create) => { skills.push(create({})); return () => {}; } },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
  };
  plugin.apply(ctx, {});
  return { plugin, skills, tools };
}

test('the dsh bundle patch inserts this package exactly once', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const rows = [...patch.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(rows, [pkg.name]);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

test('the plugin module exposes the loader plugin shape without importing dsh at load time', async () => {
  // The host resolves @deepseek-ai/dsh-tools itself; this package must not need
  // it to be present for the Codex surface to keep working.
  const source = await readFile(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /export const name = 'linger-image-gen'/);
  assert.match(source, /export const inject = \['skills', 'tools'\]/);
  assert.match(source, /export function apply\(/);
  const imageTools = await readFile(new URL('../lib/image-tools.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+'@deepseek-ai\//.test(imageTools), 'the tool core must stay free of dsh imports');
});

test('resolveDsh prefers DSH_BIN, then the pinned runtime, then the npx cache', async (t) => {
  const home = await temporary(t);
  assert.equal(dsh.resolveDsh({ HOME: home, PATH: '' }), undefined);
  const pinned = join(home, '.local/share/deepseek-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
  const cached = join(home, '.npm/_npx/abc/node_modules/@deepseek-ai/dsh/lib/bin.js');
  await mkdir(join(home, '.npm/_npx/abc/node_modules/@deepseek-ai/dsh/lib'), { recursive: true });
  await writeFile(cached, '');
  assert.equal(dsh.resolveDsh({ HOME: home, PATH: '' }).kind, 'npx-cache');
  await mkdir(join(pinned, '..'), { recursive: true });
  await writeFile(pinned, '');
  assert.equal(dsh.resolveDsh({ HOME: home, PATH: '' }).kind, 'pinned');
  assert.equal(dsh.resolveDsh({ HOME: home, PATH: '', DSH_BIN: pinned }).kind, 'env');
  assert.equal(dsh.resolveDsh({ HOME: home, PATH: '', DSH_BIN: join(home, 'missing.js') }).kind, 'pinned');
});

test('listProfiles reads manifests and chooseProfile prefers web, then an installed profile', async (t) => {
  const home = await temporary(t);
  await mkdir(join(home, 'profiles/tui'), { recursive: true });
  await mkdir(join(home, 'profiles/other'), { recursive: true });
  await mkdir(join(home, 'profiles/not-a-profile'), { recursive: true });
  await writeFile(join(home, 'profiles/tui/package.json'), JSON.stringify({ dependencies: {} }));
  await writeFile(join(home, 'profiles/other/package.json'), JSON.stringify({ dependencies: { 'linger-image-gen': '^0.2.0' } }));
  const profiles = dsh.listProfiles({ home });
  assert.deepEqual(profiles.map((profile) => profile.name).sort(), ['other', 'tui']);
  assert.equal(profiles.find((profile) => profile.name === 'other').installed, true);
  // No web profile yet: the profile that already carries the plugin wins.
  assert.equal(dsh.chooseProfile(undefined, profiles, {}), 'other');
  assert.equal(dsh.chooseProfile('tui', profiles, {}), 'tui');
  assert.equal(dsh.chooseProfile(undefined, profiles, { DSH_PROFILE: 'tui' }), 'tui');
  assert.equal(dsh.chooseProfile(undefined, [], {}), 'web');
  await mkdir(join(home, 'profiles/web'), { recursive: true });
  await writeFile(join(home, 'profiles/web/package.json'), JSON.stringify({ dependencies: {} }));
  assert.equal(dsh.chooseProfile(undefined, dsh.listProfiles({ home }), {}), 'web');
});

test('installDsh activates through the dsh CLI and reports the exact command', async (t) => {
  const home = await temporary(t);
  let captured;
  const result = await dsh.installDsh(config(), {
    profile: 'web', home,
    dsh: { command: 'node', prefix: ['/dsh/bin.js'], kind: 'pinned' },
    run: (command, args, options) => { captured = { command, args, options }; return { status: 0, stderr: '' }; },
  });
  assert.equal(result.activated, true);
  assert.equal(result.activation, 'installed');
  assert.equal(result.directory, join(home, 'profiles/web'));
  assert.deepEqual(captured.args, ['/dsh/bin.js', 'plugin', '--profile', 'web', 'add', 'linger-image-gen']);
  assert.equal(captured.options.shell, false);
});

test('installDsh reports a missing CLI and a failed install without throwing', async (t) => {
  const home = await temporary(t);
  const missing = await dsh.installDsh(config(), { profile: 'web', home, environment: { HOME: home, PATH: '' } });
  assert.equal(missing.activated, false);
  assert.equal(missing.activation, 'missing-dsh');
  assert.match(dsh.manualCommand('web'), /dsh plugin --profile web add linger-image-gen/);
  const failed = await dsh.installDsh(config(), {
    profile: 'web', home,
    dsh: { command: 'node', prefix: [], kind: 'path' },
    run: () => ({ status: 1, stderr: 'ERR_PNPM_FETCH_404\nsome detail\nlast line\n' }),
  });
  assert.equal(failed.activation, 'failed');
  assert.equal(failed.detail, 'ERR_PNPM_FETCH_404\nsome detail\nlast line');
});

test('installDsh picks the profile itself when none is requested', async (t) => {
  const home = await temporary(t);
  await mkdir(join(home, 'profiles/tui'), { recursive: true });
  await writeFile(join(home, 'profiles/tui/package.json'), JSON.stringify({ dependencies: {} }));
  let args;
  const result = await dsh.installDsh(config(), {
    home, environment: { HOME: home },
    dsh: { command: 'node', prefix: [], kind: 'path' },
    run: (command, argv) => { args = argv; return { status: 0, stderr: '' }; },
  });
  assert.equal(result.profile, 'tui');
  assert.deepEqual(args.slice(0, 3), ['plugin', '--profile', 'tui']);
});

test('tools generate through the configured endpoint into an explicit destination', async (t) => {
  const { runImageJob } = await import('../lib/image-tools.mjs');
  let captured;
  const url = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  const dir = await temporary(t);
  const out = join(dir, 'nested', 'cup.png');
  const value = await runImageJob(
    { mode: 'generate', prompt: 'a white cup', model: 'sunburst-2.6', size: '1024x1024', out },
    { ...config(), baseApi: `${url}/v1` },
  );
  assert.equal(captured.url, '/v1/images/generations');
  assert.equal(captured.body.model, 'gpt-image-2.6-sunburst');
  assert.equal(captured.body.size, '1024x1024');
  assert.deepEqual(value.images, [out]);
  assert.equal(value.count, 1);
  assert.deepEqual(await readFile(out), PNG);
  // A second call must not overwrite the first file.
  const again = await runImageJob({ mode: 'generate', prompt: 'a white cup', out }, { ...config(), baseApi: `${url}/v1` });
  assert.equal(again.images[0], join(dir, 'nested', 'cup-2.png'));
  assert.deepEqual((await readdir(join(dir, 'nested'))).sort(), ['cup-2.png', 'cup.png']);
});

test('tools default to the session working directory and send real edits', async (t) => {
  const { runImageJob } = await import('../lib/image-tools.mjs');
  const dir = await temporary(t);
  const input = join(dir, 'input.png');
  await writeFile(input, PNG);
  let captured;
  const url = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') };
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  const value = await runImageJob(
    { mode: 'edit', prompt: 'make the background white', image: ['input.png'] },
    { ...config(), baseApi: `${url}/v1` },
    { cwd: dir },
  );
  assert.equal(captured.url, '/v1/images/edits');
  assert.match(captured.contentType, /^multipart\/form-data; boundary=/);
  assert.match(captured.body, /name="image\[\]"; filename="input.png"/);
  assert.equal(value.images[0].startsWith(join(dir, 'output', 'imagegen')), true);
  assert.deepEqual(await readFile(value.images[0]), PNG);
});

test('tool argument validation rejects unsafe or contradictory input before any request', async (t) => {
  const { buildJob } = await import('../lib/image-tools.mjs');
  let calls = 0;
  const network = { fetchImpl: async () => { calls++; throw new Error('unexpected request'); } };
  const cases = [
    [{ mode: 'edit', prompt: 'x' }, /edit mode requires/],
    [{ mode: 'generate' }, /prompt must be/],
    [{ mode: 'generate', prompt: 'x', model: 'custom' }, /不能自定义/],
    [{ mode: 'generate', prompt: 'x', n: 11 }, /n 必须是/],
    [{ mode: 'generate', prompt: 'x', format: 'gif' }, /format 必须/],
    [{ mode: 'generate', prompt: 'x', background: 'transparent', format: 'jpeg' }, /透明背景/],
    [{ mode: 'generate', prompt: 'x', out: 'bad\u0000.png' }, /control characters/],
    [{ mode: 'generate', prompt: 'x', size: '100x100' }, /尺寸/],
  ];
  for (const [input, expected] of cases) assert.throws(() => buildJob(input, config()), expected);
  assert.equal(calls, 0);
  // A mask without an image is refused by the shared API core.
  assert.throws(() => buildJob({ mode: 'generate', prompt: 'x', mask: 'm.png' }, config()), /mask 必须/);
  assert.equal(calls, 0);
  assert.equal(network.fetchImpl.constructor.name, 'AsyncFunction');
});

test('cancellation stops an in-flight request and is reported as cancelled', async (t) => {
  const controller = new AbortController();
  const url = await server(t, () => { /* never answers */ });
  const pending = createImages({ prompt: 'test' }, { ...config(), baseApi: `${url}/v1` }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, /已取消/);
});

test('the doctor tool reports model listing without generating', async (t) => {
  const { runDoctor } = await import('../lib/image-tools.mjs');
  const url = await server(t, (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/models');
    res.end(JSON.stringify({ data: [{ id: MODELS[0].id }] }));
  });
  const value = await runDoctor({ ...config(), baseApi: `${url}/v1` });
  assert.deepEqual(value.models, MODELS.map((model, index) => ({ id: model.id, listed: index === 0 })));
  assert.match(value.note, /does not prove generation permission/);
});

test('the embedded skill adds host guidance and keeps the complete shared body', async () => {
  const { createSkill, parseSkillFile, SKILL_NAME, CLI_PATH } = await import('../lib/skill-content.mjs');
  const skill = createSkill();
  const raw = await readFile(new URL('../skills/linger-image-gen/SKILL.md', import.meta.url), 'utf8');
  const { body } = parseSkillFile(raw);
  assert.equal(skill.name, SKILL_NAME);
  assert.equal(skill.cli, CLI_PATH);
  assert.ok(CLI_PATH.endsWith(join('skills', 'linger-image-gen', 'scripts', 'linger-image-gen.mjs')), CLI_PATH);
  assert.ok(skill.description.length > 20);
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(skill.content.endsWith(body), 'host guidance must preserve the full shared body');
  assert.equal(skill.content.includes('{{'), false);
  assert.match(skill.content, /## Running in DeepSeek Harness/);
  assert.match(skill.content, /linger_image_gen/);
  assert.match(skill.content, /## Commands/);
  assert.match(skill.content, new RegExp(CLI_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The shared workflow, prompting rules and output rules stay in their source order.
  assert.match(skill.content, /## Workflow/);
  assert.match(skill.content, /## Output and failure behavior/);
  assert.match(skill.content, /references\/prompting\.md/);
  assert.equal(skill.content.indexOf('## Commands') < skill.content.indexOf('## Output and failure behavior'), true);
  assert.equal((await stat(CLI_PATH)).isFile(), true);
});

test('the same SKILL.md still parses as the Codex skill source', async () => {
  const { parseSkillFile } = await import('../lib/skill-content.mjs');
  const raw = await readFile(new URL('../skills/linger-image-gen/SKILL.md', import.meta.url), 'utf8');
  const parsed = parseSkillFile(raw);
  assert.equal(parsed.name, 'linger-image-gen');
  assert.match(parsed.description, /GPT-Image-2\.6 Sunburst/);
  assert.equal(parsed.body.includes('{{'), false);
  assert.match(parsed.body, /node "<cli>" generate --model sunburst-2\.6/);
  assert.equal(raw.startsWith('---\n'), true);
});

test('the plugin row config validates through the Standard Schema contract cordis uses', async () => {
  const { Config, DEFAULT_OUTPUT_DIR } = await import('../lib/config.mjs');
  const standard = Config['~standard'];
  assert.equal(standard.version, 1);
  assert.equal(typeof standard.validate, 'function');
  assert.deepEqual(standard.validate(undefined).value, { outputDir: DEFAULT_OUTPUT_DIR, environment: {} });
  assert.deepEqual(standard.validate({ outputDir: 'assets' }).value, { outputDir: 'assets', environment: {} });
  const configured = standard.validate({ outputDir: 'assets', configFile: '/tmp/c.json', environment: { BASE_API: 'https://x/v1' } });
  assert.equal(configured.value.outputDir, 'assets');
  assert.equal(configured.value.configFile, '/tmp/c.json');
  assert.equal(configured.value.environment.BASE_API, 'https://x/v1');
  for (const bad of ['nope', 42, [], { outputDir: '' }, { environment: { API_KEY: 1 } }, { nope: true }]) {
    assert.ok(standard.validate(bad).issues?.length, `expected issues for ${JSON.stringify(bad)}`);
  }
  // The returned config must never alias caller state.
  const source = { environment: { API_KEY: 'k' } };
  standard.validate(source).value.environment.API_KEY = 'changed';
  assert.equal(source.environment.API_KEY, 'k');
});

test('the harness resolves the plugin row config with its own cordis runtime', { skip: modules ? false : 'no dsh installation found' }, async () => {
  const { resolveConfig } = await import(modules.cordis);
  const { Config } = await import('../lib/config.mjs');
  const runtime = { Config };
  assert.deepEqual(resolveConfig(runtime, undefined), { outputDir: 'output/imagegen', environment: {} });
  assert.equal(resolveConfig(runtime, { outputDir: 'assets' }).outputDir, 'assets');
  assert.throws(() => resolveConfig(runtime, { outputDir: 5 }), /unknown config field|must be a non-empty string/);
  // A plugin with no schema keeps its raw config untouched.
  assert.deepEqual(resolveConfig({}, { anything: true }), { anything: true });
});

test('the plugin registers one skill and two usable tools', async () => {
  const { skills, tools, plugin } = await loadPlugin();
  assert.equal(plugin.name, 'linger-image-gen');
  assert.deepEqual(plugin.inject, ['skills', 'tools']);
  assert.equal(skills.length, 1);
  assert.equal(tools.length, 2);

  const provider = skills[0];
  assert.equal(provider.name, 'linger-image-gen');
  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'linger-image-gen');
  assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(candidates[0].source, 'runtime');
  assert.equal(candidates[0].provider, 'linger-image-gen');
  assert.equal(candidates[0].resourceBase.kind, 'directory');
  const skill = await provider.get(candidates[0]);
  assert.match(skill.content, /## Running in DeepSeek Harness/);
  assert.match(skill.content, /linger_image_gen/);

  const generate = tools.find((tool) => tool.name === 'linger_image_gen');
  const doctor = tools.find((tool) => tool.name === 'linger_image_doctor');
  assert.ok(generate && doctor);
  // The registry contract: name, description, parameters, output { schema, render }.
  assert.equal(typeof generate.description, 'string');
  assert.deepEqual(generate.parameters.required, ['mode', 'prompt']);
  assert.equal(generate.parameters.properties.mode.enum.length, 2);
  assert.deepEqual(generate.output.schema.required, ['images', 'count', 'model', 'prompt']);
  assert.equal(typeof generate.output.render, 'function');
  assert.equal(typeof generate.execute, 'function');
  assert.equal(generate.timeoutMs, 900000);
  assert.equal(doctor.isConcurrencySafe({}), true);
  assert.equal(generate.name === 'run_code', false, 'the reserved PTC name must never be used');
});

test('registered tool definitions satisfy the harness tool registry', { skip: modules ? false : 'no dsh installation found' }, async () => {
  // Register through the harness's own registry with its real layer storage:
  // the definitions are checked by the production code path (output schema,
  // reserved names, timeout budget, duplicate names) rather than by a
  // reimplementation of it.
  const toolsModule = await import(modules.tools);
  const scopeModule = await import(modules.scope);
  const { tools } = await loadPlugin();
  const runtime = Object.create(toolsModule.ToolRuntime.prototype);
  const layer = { tools: new scopeModule.NamedEntries((name) => new Error(`duplicate "${name}"`)) };
  runtime.ctx = {};
  runtime.layers = { effect: (_ctx, produce) => { produce(layer); return () => {}; } };
  for (const tool of tools) runtime.register(tool);
  assert.deepEqual([...layer.tools.keys()].sort(), ['linger_image_doctor', 'linger_image_gen']);
  // Registering the same name twice is the registry's own duplicate check.
  assert.throws(() => runtime.register(tools[0]), /duplicate "linger_image_gen"/);
  assert.throws(() => runtime.register({ ...tools[0], name: 'run_code' }), /reserved/);

  // The model-facing parameter schema must survive the harness's own
  // JSON Schema enforcement, and arguments must validate against it. The
  // registry projects `parameters` verbatim, so it has to be a complete node.
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    toolsModule.assertObjectJsonSchema(tool.parameters);
    toolsModule.assertSupportedJsonSchema(tool.output.schema);
  }
  assert.deepEqual(toolsModule.validateJsonSchemaValue(tools[0].parameters, { mode: 'generate', prompt: 'x' }, ''), []);
  assert.deepEqual(toolsModule.validateJsonSchemaValue(tools[0].parameters, { mode: 'generate', prompt: 'x', n: 3 }, ''), []);
  for (const model of ['sunburst-2.6', 'gpt-image-2.6-sunburst']) {
    assert.deepEqual(toolsModule.validateJsonSchemaValue(tools[0].parameters, { mode: 'generate', prompt: 'x', model }, ''), []);
  }
  assert.equal(toolsModule.validateJsonSchemaValue(tools[0].parameters, { mode: 'nope', prompt: 'x' }, '').length, 1);
  assert.equal(toolsModule.validateJsonSchemaValue(tools[0].parameters, { prompt: 'x' }, '').length, 1);
  assert.equal(toolsModule.validateJsonSchemaValue(tools[0].parameters, { mode: 'generate', prompt: 7 }, '').length, 1);
});

test('the plugin mounts in a real cordis context and becomes visible to agents', { skip: modules ? false : 'no dsh installation found' }, async () => {
  // The strongest check available without a model: mount the plugin the way the
  // host does — a real cordis Context with the real ToolRuntime and
  // SkillRegistry services — and then read the registry views an agent would see.
  const [{ Context }, toolsModule, skillModule, promptModule] = await Promise.all([
    import(modules.cordis), import(modules.tools), import(modules.skill), import(modules.systemPrompt),
  ]);
  const ctx = new Context();
  // ToolRuntime injects `systemPrompt`, so the prompt service mounts first; a
  // missing dependency would leave `ctx.tools` unregistered.
  await ctx.plugin(promptModule.default);
  await ctx.plugin(toolsModule.ToolRuntime);
  await ctx.plugin(skillModule.SkillRegistry);
  const plugin = await import(pathToFileURL(fileURLToPath(new URL('../lib/index.mjs', import.meta.url))).href);
  await ctx.plugin(plugin, {});

  // Tools: visible, well-formed, and classified for scheduling.
  const names = ctx.tools.schemas().map((schema) => schema.name).sort();
  assert.deepEqual(names, ['linger_image_doctor', 'linger_image_gen']);
  const generate = ctx.tools.schemas().find((schema) => schema.name === 'linger_image_gen');
  assert.equal(generate.parameters.type, 'object');
  assert.deepEqual(generate.parameters.required, ['mode', 'prompt']);
  assert.match(generate.description, /gpt-image-2\.5-sunburst/);
  assert.match(generate.description, /gpt-image-2\.6-sunburst/);
  assert.equal(ctx.tools.executionMode({ name: 'linger_image_doctor', arguments: {} }).kind, 'parallel');
  assert.equal(ctx.tools.executionMode({ name: 'linger_image_gen', arguments: { mode: 'generate', prompt: 'x' } }).kind, 'exclusive');

  // Skills: the embedded skill resolves by name and renders its full body.
  const catalog = await ctx.skills.list({});
  const summary = catalog.find((entry) => entry.name === 'linger-image-gen');
  assert.ok(summary, `the skill must appear in the catalog, saw ${JSON.stringify(catalog.map((entry) => entry.name))}`);
  assert.equal(summary.provider, 'linger-image-gen');
  assert.equal(summary.source, 'runtime');
  assert.equal(summary.invocation.modelInvocable, true);
  const loaded = await ctx.skills.get('linger-image-gen', {});
  assert.match(loaded.content, /## Native tools/);
  assert.match(loaded.content, /linger_image_gen/);

  await ctx.fiber.dispose();
});

test('the registered generate tool runs end to end against the configured API', async (t) => {
  const dir = await temporary(t);
  const configFile = join(dir, 'config.json');
  let captured;
  const url = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await saveConfig({ ...config(), baseApi: `${url}/v1` }, configFile);

  const plugin = await import(pathToFileURL(fileURLToPath(new URL('../lib/index.mjs', import.meta.url))).href);
  const tools = [];
  plugin.apply({
    skills: { registerProvider: () => () => {} },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
  }, { configFile, outputDir: 'imagegen' });

  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: dir } } } };
  const value = await tools[0].execute({ mode: 'generate', prompt: 'a white cup', format: 'png' }, exec);
  assert.equal(captured.url, '/v1/images/generations');
  assert.equal(captured.authorization, `Bearer ${config().apiKey}`);
  assert.equal(value.count, 1);
  assert.equal(value.model, MODELS[0].id);
  assert.equal(value.images[0].startsWith(join(dir, 'imagegen')), true);
  assert.deepEqual(await readFile(value.images[0]), PNG);
  // Rendering is what the model actually reads, and it must not leak the key.
  const rendered = tools[0].output.render({}, value);
  assert.match(rendered[0].text, /Saved 1 image with gpt-image-2\.5-flare/);
  assert.ok(!rendered[0].text.includes(config().apiKey));

  // Malformed arguments are refused before any request is made.
  await assert.rejects(() => tools[0].execute({ mode: 'edit', prompt: 'x' }, exec), /edit mode requires/);
  await assert.rejects(() => tools[0].execute({ mode: 'generate' }, exec), /缺少必填字段 prompt/);
  await assert.rejects(() => tools[0].execute({ mode: 'generate', prompt: 'x', nope: 1 }, exec), /未知字段 nope/);

  // A missing configuration is reported with the fix, not with a stack trace.
  const bare = [];
  plugin.apply({
    skills: { registerProvider: () => () => {} },
    tools: { register: (tool) => { bare.push(tool); return () => {}; } },
  }, { configFile: join(dir, 'absent.json'), environment: {} });
  await assert.rejects(
    () => bare[0].execute({ mode: 'generate', prompt: 'x' }, { ...exec, agent: undefined }),
    /缺少 BASE_API|缺少 API_KEY/,
  );
});

test('the plugin resolves its own imports from a profile that installed it', { skip: modules ? false : 'no dsh installation found' }, async (t) => {
  // A dsh profile reaches packages through the profiles root's node_modules;
  // this reproduces that layout and loads the full module graph, so every
  // relative import inside the package is exercised from an installed location.
  const home = await temporary(t);
  const profile = join(home, 'profiles', 'web');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const installed = join(profile, 'node_modules', 'linger-image-gen');
  await mkdir(installed, { recursive: true });
  await symlink(join(dsh.dshHome(), 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'), 'dir');
  await cp(join(root, 'lib'), join(installed, 'lib'), { recursive: true });
  await cp(join(root, 'skills'), join(installed, 'skills'), { recursive: true });
  const loaded = await import(pathToFileURL(join(installed, 'lib', 'index.mjs')).href);
  assert.equal(loaded.name, 'linger-image-gen');
  assert.deepEqual(loaded.inject, ['skills', 'tools']);
  assert.deepEqual(loaded.models, MODELS);
  const skills = [];
  const tools = [];
  loaded.apply({
    skills: { registerProvider: (create) => { skills.push(create({})); return () => {}; } },
    tools: { register: (tool) => { tools.push(tool); return () => {}; } },
  }, {});
  assert.equal(skills.length, 1);
  assert.deepEqual(tools.map((tool) => tool.name), ['linger_image_gen', 'linger_image_doctor']);
  // The embedded skill must point at the installed location, not the checkout.
  const skill = await skills[0].get();
  assert.match(skill.content, new RegExp(installed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(skill.resourceBase.path, `${installed}/`);
  assert.equal((await stat(join(skill.resourceBase.path, 'skills/linger-image-gen/SKILL.md'))).isFile(), true);
  assert.equal((await stat(join(skill.resourceBase.path, 'skills/linger-image-gen/scripts/linger-image-gen.mjs'))).isFile(), true);
});
