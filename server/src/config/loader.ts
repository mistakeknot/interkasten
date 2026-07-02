import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve, sep } from "path";
import { homedir } from "os";
import YAML from "yaml";
import { type Config, ConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG_YAML } from "./defaults.js";

const INTERKASTEN_DIR = resolve(homedir(), ".interkasten");
const DEFAULT_CONFIG_PATH = resolve(INTERKASTEN_DIR, "config.yaml");
const PROJECT_CONFIG_FILENAME = ".interkasten.yaml";

/**
 * Resolve environment variable references in string values.
 * Supports ${ENV_VAR} and ${ENV_VAR:-default} syntax.
 */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [varName, defaultValue] = expr.split(":-");
      const envValue = process.env[varName!.trim()];
      if (envValue !== undefined) return envValue;
      if (defaultValue !== undefined) return defaultValue;
      return "";
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Expand ~ to home directory in path strings.
 */
function expandHome(configPath: string): string {
  if (configPath.startsWith("~/")) {
    return resolve(homedir(), configPath.slice(2));
  }
  return configPath;
}

/**
 * Deep merge two plain objects. `override` values win on conflicts.
 * Arrays are replaced (not concatenated) — simpler, more predictable semantics.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideVal] of Object.entries(override)) {
    const baseVal = result[key];

    if (
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      // Both are plain objects — recurse
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      // Primitive, array, or type mismatch — override wins
      result[key] = overrideVal;
    }
  }

  return result;
}

/**
 * Walk up from `startDir` looking for `.interkasten.yaml`.
 * Stops at filesystem root or home directory (whichever comes first).
 * Returns the full path if found, undefined otherwise.
 */
export function findProjectConfig(startDir?: string): string | undefined {
  let dir = resolve(startDir ?? process.cwd());
  const home = homedir();
  const root = resolve(sep);

  while (true) {
    const candidate = resolve(dir, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    // Stop at home dir or filesystem root
    if (dir === home || dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  return undefined;
}

/**
 * Read and parse a YAML config file. Returns empty object if missing/empty.
 */
function readYamlConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(content);
  if (parsed && typeof parsed === "object") {
    return parsed as Record<string, unknown>;
  }
  return {};
}

export interface LoadConfigOptions {
  /** Explicit path to the global config file. */
  configPath?: string;
  /** Directory to start searching for `.interkasten.yaml`. Defaults to CWD. */
  projectDir?: string;
  /** Skip project-level config discovery. */
  skipProjectConfig?: boolean;
}

/**
 * Load configuration with project-level override support.
 *
 * Resolution chain:
 *   1. Built-in defaults (Zod schema defaults)
 *   2. Global config: ~/.interkasten/config.yaml (or INTERKASTEN_CONFIG_PATH)
 *   3. Project config: nearest .interkasten.yaml walking up from projectDir/CWD
 *
 * Project config deep-merges over global config. Zod validates the merged result.
 */
export function loadConfig(configPathOrOpts?: string | LoadConfigOptions): Config {
  // Support legacy string signature and new options object
  let globalPath: string;
  let projectDir: string | undefined;
  let skipProject = false;

  if (typeof configPathOrOpts === "string") {
    globalPath = configPathOrOpts;
  } else if (configPathOrOpts && typeof configPathOrOpts === "object") {
    globalPath = configPathOrOpts.configPath
      ?? process.env.INTERKASTEN_CONFIG_PATH
      ?? DEFAULT_CONFIG_PATH;
    projectDir = configPathOrOpts.projectDir;
    skipProject = configPathOrOpts.skipProjectConfig ?? false;
  } else {
    globalPath = process.env.INTERKASTEN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  }

  // 1. Load global config
  const globalRaw = readYamlConfig(globalPath);

  // 2. Find and load project config
  let projectRaw: Record<string, unknown> = {};
  let projectConfigPath: string | undefined;
  if (!skipProject) {
    projectConfigPath = findProjectConfig(projectDir);
    if (projectConfigPath) {
      projectRaw = readYamlConfig(projectConfigPath);
    }
  }

  // 3. Deep merge: project overrides global
  const merged = Object.keys(projectRaw).length > 0
    ? deepMerge(globalRaw, projectRaw)
    : globalRaw;

  // 4. Resolve environment variables
  const resolved = resolveEnvVars(merged) as Record<string, unknown>;

  // 5. Expand ~ in projects_dir
  if (typeof resolved.projects_dir === "string") {
    resolved.projects_dir = expandHome(resolved.projects_dir);
  }

  // 6. Validate and fill defaults
  const config = ConfigSchema.parse(resolved);
  config.projects_dir = expandHome(config.projects_dir);

  return config;
}

/**
 * Get the interkasten directory path, creating it if needed.
 */
export function getinterkastenDir(): string {
  if (!existsSync(INTERKASTEN_DIR)) {
    mkdirSync(INTERKASTEN_DIR, { recursive: true });
  }
  return INTERKASTEN_DIR;
}

export type ConfigScope = "global" | "project";

/**
 * Write a config value to the YAML file.
 *
 * @param keyPath - Dot-separated config key (e.g., "sync.poll_interval")
 * @param value - Value to set
 * @param scope - "global" writes to ~/.interkasten/config.yaml,
 *                "project" writes to nearest .interkasten.yaml (creates in CWD if none exists)
 */
export function setConfigValue(
  keyPath: string,
  value: unknown,
  scope: ConfigScope = "global",
): Config {
  let filePath: string;

  if (scope === "project") {
    // Find existing project config or create in CWD
    filePath = findProjectConfig() ?? resolve(process.cwd(), PROJECT_CONFIG_FILENAME);
  } else {
    filePath = process.env.INTERKASTEN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  }

  let rawConfig: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (parsed && typeof parsed === "object") {
      rawConfig = parsed as Record<string, unknown>;
    }
  }

  // Navigate and set the key path (e.g., "sync.poll_interval")
  const keys = keyPath.split(".");
  let current: Record<string, unknown> = rawConfig;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;

  // Ensure directory exists
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filePath, YAML.stringify(rawConfig, { lineWidth: 120 }), "utf-8");

  // Reload merged config (so project + global are both reflected)
  return loadConfig();
}

/**
 * Ensure config file exists, writing defaults if not.
 */
export function ensureConfigFile(): string {
  const filePath = process.env.INTERKASTEN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(filePath)) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, DEFAULT_CONFIG_YAML, "utf-8");
  }
  return filePath;
}

/** Exposed for testing. */
export const PROJECT_CONFIG_FILE = PROJECT_CONFIG_FILENAME;
