/**
 * DeepSeek Harness (dsh) installation support for the Linger Image Gen wizard.
 *
 * A dsh plugin is an npm package that declares `dsh.bundle.patch`; the dsh CLI
 * installs it into one *profile* with `dsh plugin --profile <name> add <spec>`,
 * which forwards to pnpm inside `~/.dsh/profiles/<name>` and then adds the
 * package to `dsh.profile.bundles`. This module locates the CLI and the
 * profiles, picks a sensible default, and reports what happened without ever
 * rewriting a profile by hand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** npm package name; the same package also carries the Codex plugin surface. */
export const PACKAGE = 'linger-image-gen';

/** Profile used when nothing else can be determined. */
export const DEFAULT_PROFILE = 'web';

/**
 * Resolve the dsh CLI entry script.
 *
 * Mirrors the resolution order of the shipped `dsh-web-run.sh` supervisor so
 * the wizard activates the same installation the running app uses: an explicit
 * `DSH_BIN`, the pinned runtime installed by install.sh, an npx cache entry,
 * then a `dsh` executable on PATH.
 *
 * @param environment - environment to read `DSH_BIN` and `HOME` from.
 * @returns the command to spawn, or undefined when dsh is not installed.
 */
export function resolveDsh(environment = process.env) {
  const home = environment.HOME || homedir();
  const explicit = environment.DSH_BIN;
  if (explicit && existsSync(explicit)) return { command: process.execPath, prefix: [explicit], kind: 'env' };
  const pinned = join(home, '.local', 'share', 'deepseek-harness', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (existsSync(pinned)) return { command: process.execPath, prefix: [pinned], kind: 'pinned' };
  const cacheRoot = join(home, '.npm', '_npx');
  if (existsSync(cacheRoot)) {
    let entries = [];
    try { entries = readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(cacheRoot, entry.name)); }
    catch { entries = []; }
    const candidates = entries
      .map((directory) => join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return { command: process.execPath, prefix: [candidates[0]], kind: 'npx-cache' };
  }
  for (const directory of (environment.PATH ?? '').split(':').filter(Boolean)) {
    const path = join(directory, 'dsh');
    if (existsSync(path)) return { command: path, prefix: [], kind: 'path' };
  }
  return undefined;
}

/**
 * Read the dsh home that holds the profile directory.
 * @param environment - environment to read `DSH_HOME` and `HOME` from.
 * @returns the absolute dsh home path.
 */
export function dshHome(environment = process.env) {
  return environment.DSH_HOME || join(environment.HOME || homedir(), '.dsh');
}

/**
 * List every profile that already has a manifest.
 * @param options - `home` (dsh home) override.
 * @returns profile names with their installed state, most recently used first.
 */
export function listProfiles({ home = dshHome() } = {}) {
  const root = join(home, 'profiles');
  if (!existsSync(root)) return [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const manifest = join(directory, 'package.json');
    if (!existsSync(manifest)) continue;
    let data;
    let modified;
    try {
      data = JSON.parse(readFileSync(manifest, 'utf8'));
      modified = statSync(manifest).mtimeMs;
    } catch { continue; }
    profiles.push({
      name: entry.name,
      directory,
      manifest,
      installed: Boolean(data.dependencies?.[PACKAGE]),
      bundles: Array.isArray(data.dsh?.profile?.bundles) ? data.dsh.profile.bundles : [],
      modified,
    });
  }
  return profiles.sort((a, b) => b.modified - a.modified);
}

/**
 * Choose the profile to install into.
 *
 * An explicit request always wins. Otherwise prefer `web` (the shipped GUI
 * profile), then the profile that already carries the plugin, then the most
 * recently used profile.
 * @param request - `profile` from the command line, when given.
 * @param profiles - the discovered profiles.
 * @param environment - environment read for `DSH_PROFILE`.
 * @returns the chosen profile name.
 */
export function chooseProfile(request, profiles, environment = process.env) {
  const explicit = request ?? environment.DSH_PROFILE;
  if (explicit) return explicit;
  if (profiles.some((profile) => profile.name === DEFAULT_PROFILE)) return DEFAULT_PROFILE;
  const installed = profiles.find((profile) => profile.installed);
  if (installed) return installed.name;
  if (profiles.length) return profiles[0].name;
  return DEFAULT_PROFILE;
}

/**
 * Install the plugin package into one dsh profile through the dsh CLI.
 * @param config - the validated Linger configuration; the caller writes it first.
 * @param options - `profile`, `spec`, CLI resolution, spawn, and home overrides.
 * @returns the profile name, the exact command, and the activation outcome.
 */
export async function installDsh(config, {
  profile, spec = PACKAGE, environment = process.env,
  dsh: dshCli, run = spawnSync,
  profiles, home = dshHome(environment),
} = {}) {
  const resolved = profile ?? chooseProfile(undefined, profiles ?? listProfiles({ home }), environment);
  const target = join(home, 'profiles', resolved);
  const args = ['plugin', '--profile', resolved, 'add', spec];
  // `dsh: undefined` means "detect it"; `dsh: null` means "there is none".
  const dsh = dshCli === undefined ? resolveDsh(environment) : dshCli;
  if (!dsh) {
    return { profile: resolved, directory: target, args, activated: false, activation: 'missing-dsh' };
  }
  const result = run(dsh.command, [...dsh.prefix, ...args], {
    encoding: 'utf8', timeout: 900000, shell: false, env: { ...environment },
  });
  const activation = result.error?.code === 'ENOENT' ? 'missing-dsh' : result.status === 0 ? 'installed' : 'failed';
  return {
    profile: resolved, directory: target, args, activated: activation === 'installed',
    activation, status: result.status,
    // dsh and pnpm both report on stderr; keep the tail only, and never echo
    // anything that might carry a credential.
    detail: typeof result.stderr === 'string' && result.stderr.trim()
      ? result.stderr.trim().split('\n').slice(-3).join('\n')
      : undefined,
  };
}

/** The manual command a user can run when the wizard cannot activate a profile. */
export function manualCommand(profile) {
  return `dsh plugin --profile ${profile} add ${PACKAGE}`;
}
