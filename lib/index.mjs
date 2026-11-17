/**
 * Linger Image Gen — DeepSeek Harness (dsh) host plugin.
 *
 * One loader row from `cordis.patch.yml` mounts this module. It contributes:
 *  1. the `linger-image-gen` skill, embedded from the packaged `SKILL.md`;
 *  2. the `linger_image_gen` tool for generation and editing;
 *  3. the `linger_image_doctor` connectivity check.
 *
 * The package has no runtime dependency beyond the Node.js standard library,
 * so one package serves both the Codex plugin surface and every DSH profile,
 * and nothing here can drift against a second copy of the harness's tool kit.
 * @module linger-image-gen
 */
import { isAbsolute, resolve } from 'node:path';
import { Config } from './config.mjs';
import { createSkillProvider, PACKAGE_ROOT } from './skill-content.mjs';
import { MODEL_CATALOG, createDoctorTool, createGenerateTool, loadConfig } from './image-tools.mjs';

export { Config };

/** Cordis plugin name used by loader diagnostics. */
export const name = 'linger-image-gen';

/** Services this plugin contributes to. */
export const inject = ['skills', 'tools'];

/**
 * Read the session working directory a tool call runs under.
 * @param exec - the tool execution context.
 * @returns the absolute session cwd, or undefined when the session has none.
 */
function sessionRoot(exec) {
  return exec?.agent?.session?.header?.cwd;
}

/**
 * Resolve a possibly relative plugin-row path against the calling session.
 * @param value - configured path, when present.
 * @param cwd - the session working directory, when known.
 * @returns the resolved path, or undefined when unset.
 */
function sessionPath(value, cwd) {
  if (value === undefined) return undefined;
  if (isAbsolute(value)) return value;
  return cwd === undefined ? resolve(value) : resolve(cwd, value);
}

/**
 * Register the embedded skill and the two native tools.
 * @param ctx - the plugin context providing `skills` and `tools`.
 * @param config - the validated plugin-row configuration.
 */
export function apply(ctx, config = {}) {
  ctx.skills.registerProvider(() => createSkillProvider());

  // Configuration is read per call so a `configure` run takes effect without a
  // dsh restart, and so the secret never lands in plugin state.
  const load = () => loadConfig({
    ...(config.configFile ? { path: config.configFile } : {}),
    env: { ...process.env, ...config.environment },
  });

  ctx.tools.register(createGenerateTool(async (exec) => {
    const cwd = sessionRoot(exec);
    return {
      config: await load(),
      cwd,
      outputDir: sessionPath(config.outputDir ?? 'output/imagegen', cwd),
    };
  }));

  ctx.tools.register(createDoctorTool(load));
}

/** Fixed model ids this plugin can drive, for diagnostics and tests. */
export const models = MODEL_CATALOG;

/** Install root of this plugin inside the profile, for diagnostics. */
export const root = PACKAGE_ROOT;
