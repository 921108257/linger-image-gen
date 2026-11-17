/**
 * Builds the skill the DeepSeek Harness plugin contributes.
 *
 * `skills/linger-image-gen/SKILL.md` stays the single source of truth shared
 * with the Codex plugin manifest; this module strips its YAML frontmatter and
 * prepends DSH-specific paths and tool guidance to the unchanged shared body.
 *
 * The contribution is a provider rather than a direct `ctx.skills.register()`:
 * a provider's loaded definition is validated on the same path as every other
 * discovered skill and carries its own source label, which is what the catalog
 * and the loader read back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Kebab-case skill name contributed on `ctx.skills`. */
export const SKILL_NAME = 'linger-image-gen';

/** Provider name registered on the skill registry. */
export const PROVIDER_NAME = 'linger-image-gen';

/** Absolute path of the installed package root (the skill's resource base). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Absolute path of the bundled CLI inside the installed package. */
export const CLI_PATH = fileURLToPath(new URL('skills/linger-image-gen/scripts/linger-image-gen.mjs', new URL('../', import.meta.url)));

const SKILL_FILE = new URL('skills/linger-image-gen/SKILL.md', new URL('../', import.meta.url));

/** Source bucket for a skill contributed by an installed plugin. */
const SOURCE = 'runtime';

/** Invocation policy: both the model catalog and the `/` menu may surface it. */
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true });

/** Where the plugin's native tools come from, appended for the DSH surface only. */
const NATIVE_TOOLS = [
  '## Native tools',
  '',
  'This plugin also registers `linger_image_gen` and `linger_image_doctor`. Prefer',
  '`linger_image_gen` for ordinary single-request generation or editing: it takes the',
  'prompt directly, needs no shell quoting, and returns the absolute saved paths.',
  '`linger_image_doctor` performs the credential-free `GET /models` check.',
  '',
  'Use the CLI below when you need JSONL batches, a prompt file, or flags the tool',
  'does not expose. Both routes share the same configuration file and the same',
  'no-overwrite save behavior, so mixing them is safe.',
  '',
].join('\n');

/**
 * Split one SKILL.md into its frontmatter values and body.
 * @param text - the raw file contents.
 * @returns the parsed `name`/`description` and the trimmed body.
 */
export function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${SKILL_NAME}: SKILL.md is missing its YAML frontmatter block.`);
  const front = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (entry) front[entry[1]] = entry[2].trim();
  }
  if (!front.name || !front.description) throw new Error(`${SKILL_NAME}: SKILL.md frontmatter needs name and description.`);
  if (front.name !== SKILL_NAME) throw new Error(`${SKILL_NAME}: SKILL.md declares the skill name "${front.name}".`);
  return { name: front.name, description: front.description, body: match[2].trim() };
}

/**
 * Load and tailor the bundled skill.
 * @param options - `cliPath` and `packageRoot` overrides, used by tests to
 *   render the body for a different install location.
 * @returns the registration fields and the instruction body.
 */
export function createSkill({ cliPath = CLI_PATH, packageRoot = PACKAGE_ROOT, readFile = readFileSync } = {}) {
  const source = readFile(SKILL_FILE, 'utf8');
  const { name, description, body } = parseSkillFile(source);
  const cli = cliPath.startsWith('/') ? cliPath : `./${cliPath}`;
  const content = [
    '## Running in DeepSeek Harness',
    '',
    `This skill ships inside the \`linger-image-gen\` plugin installed in your DSH profile. Its base directory is \`${packageRoot}\` and the bundled CLI entry is \`${cli}\`.`,
    '',
    NATIVE_TOOLS,
    body,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { name, description, content, cli, resourceBase: Object.freeze({ kind: 'directory', path: packageRoot }) };
}

/**
 * Build the skill provider the plugin registers.
 *
 * `get` re-reads the body so an updated package is picked up on the next load
 * without a host restart, matching the filesystem provider's behavior.
 * @param options - forwarded to {@link createSkill}; tests use it to render the
 *   body for a different install location.
 * @returns a provider accepted by `ctx.skills.registerProvider()`.
 */
export function createSkillProvider(options) {
  const skill = createSkill(options);
  const definition = () => ({
    name: skill.name,
    description: skill.description,
    invocation: { ...INVOCATION },
    provider: PROVIDER_NAME,
    source: SOURCE,
    resourceBase: skill.resourceBase,
  });
  return {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([{ ...definition(), rank: 0, locator: skill.name }]),
    get: () => Promise.resolve({ ...definition(), content: createSkill(options).content }),
  };
}
