/**
 * Configuration schema for the DeepSeek Harness plugin row.
 *
 * Cordis validates a plugin's exported `Config` through the Standard Schema
 * interface (`Config['~standard'].validate`), so this is a self-contained
 * implementation of that interface rather than a `@deepseek-ai/schemastery`
 * import: the package then runs from any DSH installation with no module that
 * has to resolve out of the profile it was installed into.
 *
 * The three fields below are the entire row configuration; everything else the
 * plugin needs comes from the shared Linger configuration file.
 */

/** Default destination directory, relative to the session working directory. */
export const DEFAULT_OUTPUT_DIR = 'output/imagegen';

/**
 * Resolved defaults, applied by the validator below.
 *
 * The two field defaults are declared here once so a reader can see the whole
 * effective row configuration in one place.
 */
const DEFAULT_CONFIG = Object.freeze({ outputDir: DEFAULT_OUTPUT_DIR, environment: {} });

/**
 * Validate a plugin-row `config:` block.
 * @param input - the raw config, possibly undefined.
 * @returns the resolved config and any issue messages, per Standard Schema.
 */
function validateConfigRow(input) {
  const issues = [];
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    return { issues: [{ message: 'linger-image-gen: config must be a mapping', path: [] }] };
  }
  const raw = input ?? {};
  const known = ['outputDir', 'configFile', 'environment'];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) issues.push({ message: `linger-image-gen: unknown config field "${key}"`, path: [key] });
  }
  for (const key of ['outputDir', 'configFile']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) {
      issues.push({ message: `linger-image-gen: ${key} must be a non-empty string`, path: [key] });
    }
  }
  const environment = raw.environment ?? DEFAULT_CONFIG.environment;
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    issues.push({ message: 'linger-image-gen: environment must be a mapping of variable names to string values', path: ['environment'] });
  } else {
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value !== 'string') issues.push({ message: `linger-image-gen: environment.${key} must be a string`, path: ['environment', key] });
    }
  }
  if (issues.length) return { issues };
  return {
    value: {
      ...DEFAULT_CONFIG,
      ...raw,
      environment: { ...environment },
    },
  };
}

/** Plugin-row schema in the Standard Schema shape cordis consumes. */
export const Config = Object.freeze({
  '~standard': Object.freeze({ version: 1, vendor: 'linger-image-gen', validate: validateConfigRow }),
});

export default Config;
