/**
 * The Linger Image Gen tools for the DeepSeek Harness plugin.
 *
 * Tool definitions are plain objects carrying raw JSON Schema in the harness's
 * enforced subset, and this module imports nothing from `@deepseek-ai/*`: the
 * host validates the schema at registration and validates model arguments
 * before dispatch, so the plugin needs no copy of the harness's tool kit and
 * therefore cannot end up comparing against a second, mismatched instance of
 * it. `test/dsh.test.mjs` checks every schema here with the harness's own
 * validator when a dsh installation is present.
 */
import { resolve } from 'node:path';
import { MODELS, readConfig } from '../skills/linger-image-gen/scripts/lib/config.mjs';
import { checkModels, createImages, validateInputs, validateJob } from '../skills/linger-image-gen/scripts/lib/api.mjs';
import { saveImage } from '../skills/linger-image-gen/scripts/lib/runtime.mjs';

/** Model-facing tool name for generation and editing. */
export const GENERATE_TOOL = 'linger_image_gen';

/** Model-facing tool name for the credential-free connectivity check. */
export const DOCTOR_TOOL = 'linger_image_doctor';

/** Serialized, bounded summary of the fixed models this plugin can drive. */
export const MODEL_CATALOG = MODELS.map((model) => ({ id: model.id, alias: model.alias, name: model.name }));

const MODEL_IDS = MODELS.map((model) => model.id);
const MODEL_ALIASES = MODELS.map((model) => model.alias);
const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const FORMATS = ['png', 'jpeg', 'webp'];
const BACKGROUNDS = ['auto', 'opaque', 'transparent'];

const MODEL_DESCRIPTION = `Model to use. Omit to use the configured default. ${MODELS.map((model) => `"${model.alias}" or ${model.id} for ${model.name}`).join('; ')}. A disabled model is refused rather than substituted.`;

/**
 * Parameter schema for the generation/editing tool.
 *
 * A complete JSON Schema node: the registry projects `parameters` verbatim onto
 * the model-facing tool schema, so the object root is declared here exactly as
 * the harness's own `parameterSchemaSpecToJsonSchema` would render it.
 */
export const GENERATE_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    mode: {
      type: 'string', enum: ['generate', 'edit'],
      description: 'generate creates a new image from the prompt alone; edit changes an existing local image and requires image (and optionally mask).',
    },
    prompt: {
      type: 'string',
      description: 'What to generate or how to change the image. Multiline prompts are allowed.',
    },
    model: {
      type: 'string', enum: [...MODEL_ALIASES, ...MODEL_IDS],
      description: MODEL_DESCRIPTION,
    },
    image: {
      type: 'array', items: { type: 'string' },
      description: 'Local PNG/JPEG/WebP files (max 50 MB each). Required in edit mode; in generate mode they are reference images sent through the image-edit endpoint.',
    },
    mask: {
      type: 'string',
      description: 'PNG mask with an alpha channel selecting the editable region. Requires image. Only meaningful in edit mode.',
    },
    n: {
      type: 'integer', default: 1,
      description: 'Number of images to produce for this prompt, 1-10. Each is saved to a separate numbered file.',
    },
    size: {
      type: 'string',
      description: 'Output size: "auto" or WIDTHxHEIGHT (for example 1024x1024). Both edges must be multiples of 16, the long edge at most 3840, aspect ratio between 1:3 and 3:1.',
    },
    quality: {
      type: 'string', enum: QUALITIES,
      description: 'Render quality passed to the API. Service support varies; nothing is downgraded automatically.',
    },
    format: {
      type: 'string', enum: FORMATS, default: 'png',
      description: 'Saved image format. A transparent background requires png or webp.',
    },
    background: {
      type: 'string', enum: BACKGROUNDS,
      description: 'transparent requests an alpha background; it requires png or webp output.',
    },
    out: {
      type: 'string',
      description: 'Destination file path. Relative paths resolve against the session working directory. Omit to write output/imagegen/<generated-name>.<format>; an existing file is never overwritten and receives a numeric suffix instead.',
    },
    cwd: {
      type: 'string',
      description: 'Absolute base directory used to resolve relative image, mask and out paths for this call. Defaults to the session working directory.',
    },
  },
  required: ['mode', 'prompt'],
});

/** Parameter schema for the connectivity check tool: no arguments. */
export const DOCTOR_PARAMETERS = Object.freeze({ type: 'object', properties: {} });

/** Canonical output schema of the generation/editing tool. */
export const IMAGES_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the saved images, in request order.' },
    count: { type: 'integer' },
    model: { type: 'string', description: 'Fixed model id that produced the images.' },
    prompt: { type: 'string' },
  },
  required: ['images', 'count', 'model', 'prompt'],
});

/** Canonical output schema of the connectivity check tool. */
export const DOCTOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    models: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, listed: { type: 'boolean' } },
        required: ['id', 'listed'],
      },
    },
    note: { type: 'string' },
  },
  required: ['models', 'note'],
});

const DOCTOR_NOTE = 'GET /models only proves the endpoint answered; it does not prove generation permission.';

/** Prefix of the argument-validation error the harness expects from a tool. */
const ARGS_ERROR = '工具参数无效';

const GENERATE_DESCRIPTION = [
  `Generate or edit a raster image with the user-configured Linger API, using the fixed models ${MODELS.map((model) => `${model.name} (${model.id})`).join(', ')}.`,
  'Use mode "generate" for a new image from the prompt, and mode "edit" to change an existing local image.',
  'Images are saved as real files and the absolute paths are returned; they are never overwritten.',
  'Requests are billable and are never retried automatically, so confirm an error before repeating a call.',
].join(' ');

const DOCTOR_DESCRIPTION = 'Check the configured Linger API endpoint and report whether each enabled model appears in its /models listing. Sends no generation request and costs nothing.';

/**
 * Validate model arguments against the declared parameter schema.
 *
 * The harness validates too; doing it here as well keeps a malformed call from
 * reaching the API layer, and gives the model a message naming the field it got
 * wrong instead of a network-shaped failure.
 * @param input - parsed tool arguments.
 * @returns the validated arguments.
 */
export function validateArguments(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${ARGS_ERROR}：参数必须是对象。`);
  }
  const allowed = Object.keys(GENERATE_PARAMETERS.properties);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${ARGS_ERROR}：未知字段 ${unknown.join('、')}。`);
  for (const field of GENERATE_PARAMETERS.required) {
    if (input[field] === undefined) throw new Error(`${ARGS_ERROR}：缺少必填字段 ${field}。`);
  }
  if (input.mode !== 'generate' && input.mode !== 'edit') throw new Error(`${ARGS_ERROR}：mode 只能是 generate 或 edit。`);
  return input;
}

/**
 * Render one successful call as the model-facing text block.
 * @param args - validated tool arguments.
 * @param value - the tool's canonical output value.
 * @returns one text content block.
 */
export function renderImages(args, value) {
  const lines = [
    `Saved ${value.count} image${value.count === 1 ? '' : 's'} with ${value.model}.`,
    ...value.images.map((path) => `- ${path}`),
  ];
  if (value.prompt) lines.push(`Prompt: ${value.prompt}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Render the connectivity check result.
 * @param _args - validated tool arguments (unused).
 * @param value - the doctor canonical output value.
 * @returns one text content block.
 */
export function renderDoctor(_args, value) {
  const lines = value.models.map((model) => `- ${model.id}: ${model.listed ? 'listed' : 'not listed'}`);
  return [{ type: 'text', text: [...lines, value.note].join('\n') }];
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function endsWithControl(value) {
  return /[\r\n\x00-\x1f\x7f]/.test(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  if (endsWithControl(value)) throw new Error(`${field} must not contain control characters or newlines.`);
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function resolvePath(value, cwd) {
  return cwd === undefined ? resolve(value) : resolve(cwd, value);
}

/**
 * Turn one call's validated arguments into the request the shared API core
 * accepts, applying the documented defaults.
 * @param input - parsed tool arguments.
 * @param config - the effective Linger configuration.
 * @param cwd - base directory for relative paths, when known.
 * @returns a normalized job for `createImages`.
 */
export function buildJob(input, config, cwd) {
  if (!isPlainObject(input)) throw new Error('arguments must be an object.');
  const mode = input.mode;
  if (mode !== 'generate' && mode !== 'edit') throw new Error('mode must be "generate" or "edit".');
  const images = input.image === undefined || input.image === null
    ? []
    : (Array.isArray(input.image) ? input.image : [input.image])
      .map((path, index) => resolvePath(requireString(path, `image[${index}]`), cwd));
  if (mode === 'edit' && images.length === 0) throw new Error('edit mode requires at least one local image.');
  const mask = optionalString(input.mask, 'mask');
  const out = optionalString(input.out, 'out');
  const job = {
    prompt: requireString(input.prompt, 'prompt'),
    mode,
    model: optionalString(input.model, 'model'),
    n: input.n ?? 1,
    size: optionalString(input.size, 'size'),
    quality: optionalString(input.quality, 'quality'),
    output_format: optionalString(input.format, 'format') ?? 'png',
    background: optionalString(input.background, 'background'),
    image: images.length ? images : undefined,
    mask: mask === undefined ? undefined : resolvePath(mask, cwd),
    out: out === undefined ? undefined : resolvePath(out, cwd),
  };
  for (const key of Object.keys(job)) if (job[key] === undefined) delete job[key];
  return validateJob(job, config);
}

/**
 * Generate or edit images and save every returned image without overwriting.
 * @param input - parsed tool arguments.
 * @param config - the effective Linger configuration.
 * @param options - `cwd` for relative paths, `outputDir` for the default
 *   destination, and optional network overrides forwarded to the API core.
 * @returns the canonical tool value.
 */
export async function runImageJob(input, config, { cwd, outputDir, network } = {}) {
  const job = buildJob(input, config, cwd);
  await validateInputs(job);
  const buffers = await createImages(job, config, network ?? {});
  const directory = outputDir ?? (cwd === undefined ? resolve('output/imagegen') : resolve(cwd, 'output/imagegen'));
  const images = [];
  for (const [index, bytes] of buffers.entries()) {
    const target = job.out ?? resolve(directory, `linger-${Date.now()}-${index + 1}.${job.output_format}`);
    images.push(await saveImage(bytes, target));
  }
  return { images, count: images.length, model: job.model, prompt: job.prompt };
}

/**
 * Check the configured endpoint without generating an image.
 * @param config - the effective Linger configuration.
 * @param network - optional network overrides.
 * @returns the canonical doctor value.
 */
export async function runDoctor(config, network) {
  return { models: await checkModels(config, network ?? {}), note: DOCTOR_NOTE };
}

/**
 * Read the effective configuration for one call.
 * @param options - optional config path and environment overrides.
 * @returns the validated configuration, or a message telling the user how to configure it.
 */
export async function loadConfig(options) {
  try {
    return await readConfig(options ?? {});
  } catch (error) {
    if (/缺少 BASE_API|缺少 API_KEY/.test(error.message)) {
      throw new Error(`${error.message} 运行 npx linger-image-gen 或在终端运行 npx linger-image-gen configure 完成配置后重试。`);
    }
    throw error;
  }
}

/**
 * Build the generation/editing tool definition for one plugin instance.
 * @param resolveContext - async provider of `{ config, cwd, outputDir }` for one call.
 * @returns a registry-ready tool definition.
 */
export function createGenerateTool(resolveContext) {
  return {
    name: GENERATE_TOOL,
    description: GENERATE_DESCRIPTION,
    parameters: GENERATE_PARAMETERS,
    output: { schema: IMAGES_SCHEMA, render: renderImages },
    // Billable generation calls run one at a time: sibling parallelism would
    // multiply provider load and rate-limit failures for no user benefit.
    timeoutMs: 900000,
    async execute(args, exec) {
      validateArguments(args);
      const { config, cwd, outputDir } = await resolveContext(exec);
      return runImageJob(args, config, { cwd, outputDir, network: { signal: exec?.signal } });
    },
  };
}

/**
 * Build the connectivity check tool definition for one plugin instance.
 * @param resolveConfig - async provider of the effective configuration.
 * @returns a registry-ready tool definition.
 */
export function createDoctorTool(resolveConfig) {
  return {
    name: DOCTOR_TOOL,
    description: DOCTOR_DESCRIPTION,
    parameters: DOCTOR_PARAMETERS,
    output: { schema: DOCTOR_SCHEMA, render: renderDoctor },
    // A read-only listing costs nothing and never conflicts with a sibling call.
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute() {
      return runDoctor(await resolveConfig());
    },
  };
}

// Prompts always travel as tool arguments and never reach a shell, so no
// prompt-file helper exists here; the bundled CLI covers that workflow.
