import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import YAML from "yaml";
import { type Config, ConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG_YAML } from "./defaults.js";

const INTERKASTEN_DIR = resolve(homedir(), ".interkasten");
const DEFAULT_CONFIG_PATH = resolve(INTERKASTEN_DIR, "config.yaml");

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
 * Load configuration from YAML file, merge with defaults, validate.
 */
export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? process.env.INTERKASTEN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

  let rawConfig: Record<string, unknown> = {};

  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(content);
    if (parsed && typeof parsed === "object") {
      rawConfig = parsed as Record<string, unknown>;
    }
  }

  // Resolve environment variables
  const resolved = resolveEnvVars(rawConfig) as Record<string, unknown>;

  // Expand ~ in projects_dir
  if (typeof resolved.projects_dir === "string") {
    resolved.projects_dir = expandHome(resolved.projects_dir);
  }

  // Validate and merge with defaults
  const config = ConfigSchema.parse(resolved);

  // Ensure projects_dir is expanded in the final config
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

/**
 * Write a config value to the YAML file.
 * Reads existing config, updates the key path, writes back.
 */
export function setConfigValue(keyPath: string, value: unknown): Config {
  const filePath = process.env.INTERKASTEN_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

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

  return loadConfig(filePath);
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
