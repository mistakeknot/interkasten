import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import {
  loadConfig,
  deepMerge,
  findProjectConfig,
  setConfigValue,
  PROJECT_CONFIG_FILE,
} from "../../src/config/loader.js";

describe("Config Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `interkasten-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("returns defaults when config file is missing", () => {
    const config = loadConfig({
      configPath: resolve(tempDir, "nonexistent.yaml"),
      skipProjectConfig: true,
    });
    expect(config.sync.poll_interval).toBe(60);
    expect(config.sync.conflict_strategy).toBe("three-way-merge");
    expect(config.watcher.debounce_ms).toBe(500);
    expect(config.pagent.max_dag_depth).toBe(10);
  });

  it("loads and merges partial config", () => {
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      `
sync:
  poll_interval: 30
  batch_size: 5
watcher:
  debounce_ms: 200
`,
    );

    const config = loadConfig({ configPath, skipProjectConfig: true });
    expect(config.sync.poll_interval).toBe(30);
    expect(config.sync.batch_size).toBe(5);
    expect(config.watcher.debounce_ms).toBe(200);
    // Defaults still applied for unset values
    expect(config.sync.conflict_strategy).toBe("three-way-merge");
    expect(config.sync.max_queue_size).toBe(1000);
  });

  it("resolves environment variables", () => {
    process.env.TEST_PROJECTS_DIR = "/test/projects";
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(configPath, `projects_dir: "\${TEST_PROJECTS_DIR}"`);

    const config = loadConfig({ configPath, skipProjectConfig: true });
    expect(config.projects_dir).toBe("/test/projects");

    delete process.env.TEST_PROJECTS_DIR;
  });

  it("resolves env vars with defaults", () => {
    delete process.env.MISSING_VAR;
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      `projects_dir: "\${MISSING_VAR:-/fallback/path}"`,
    );

    const config = loadConfig({ configPath, skipProjectConfig: true });
    expect(config.projects_dir).toBe("/fallback/path");
  });

  it("rejects invalid config values", () => {
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      `
sync:
  conflict_strategy: "invalid-strategy"
`,
    );

    expect(() => loadConfig({ configPath, skipProjectConfig: true })).toThrow();
  });

  it("handles empty config file", () => {
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(configPath, "");

    const config = loadConfig({ configPath, skipProjectConfig: true });
    expect(config.sync.poll_interval).toBe(60);
  });
});

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const base = { a: 1, b: 2 };
    const override = { b: 3, c: 4 };
    expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep merges nested objects", () => {
    const base = { sync: { poll_interval: 60, batch_size: 10 } };
    const override = { sync: { poll_interval: 30 } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ sync: { poll_interval: 30, batch_size: 10 } });
  });

  it("replaces arrays (no concatenation)", () => {
    const base = { markers: [".git", ".beads"] };
    const override = { markers: [".hg"] };
    expect(deepMerge(base, override)).toEqual({ markers: [".hg"] });
  });

  it("override null replaces object", () => {
    const base = { notion: { workspace_id: "abc" } };
    const override = { notion: null };
    expect(deepMerge(base, override as any)).toEqual({ notion: null });
  });

  it("handles empty override", () => {
    const base = { a: 1, b: { c: 2 } };
    expect(deepMerge(base, {})).toEqual({ a: 1, b: { c: 2 } });
  });

  it("merges token maps additively", () => {
    const base = { notion: { tokens: { work: "tok1" } } };
    const override = { notion: { tokens: { personal: "tok2" } } };
    const result = deepMerge(base, override);
    expect(result).toEqual({
      notion: { tokens: { work: "tok1", personal: "tok2" } },
    });
  });
});

describe("Project-level config", () => {
  let tempDir: string;
  let globalConfigPath: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `interkasten-project-test-${Date.now()}`);
    mkdirSync(resolve(tempDir, "project", "sub"), { recursive: true });
    globalConfigPath = resolve(tempDir, "global-config.yaml");
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("finds .interkasten.yaml in project root", () => {
    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(projectConfig, "sync:\n  poll_interval: 15\n");

    const found = findProjectConfig(resolve(tempDir, "project"));
    expect(found).toBe(projectConfig);
  });

  it("walks up to find .interkasten.yaml from subdirectory", () => {
    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(projectConfig, "sync:\n  poll_interval: 15\n");

    const found = findProjectConfig(resolve(tempDir, "project", "sub"));
    expect(found).toBe(projectConfig);
  });

  it("returns undefined when no project config exists", () => {
    const found = findProjectConfig(resolve(tempDir, "project"));
    expect(found).toBeUndefined();
  });

  it("project config overrides global config", () => {
    writeFileSync(
      globalConfigPath,
      'sync:\n  poll_interval: 60\n  conflict_strategy: "three-way-merge"\n',
    );

    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(
      projectConfig,
      'sync:\n  poll_interval: 15\n  conflict_strategy: "notion-wins"\n',
    );

    const config = loadConfig({
      configPath: globalConfigPath,
      projectDir: resolve(tempDir, "project"),
    });

    expect(config.sync.poll_interval).toBe(15);
    expect(config.sync.conflict_strategy).toBe("notion-wins");
    // Global defaults still apply for unset values
    expect(config.sync.batch_size).toBe(10);
  });

  it("project tokens merge with global tokens", () => {
    writeFileSync(
      globalConfigPath,
      `notion:\n  tokens:\n    work: "global-work-token"\n`,
    );

    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(
      projectConfig,
      `notion:\n  tokens:\n    personal: "project-personal-token"\n`,
    );

    const config = loadConfig({
      configPath: globalConfigPath,
      projectDir: resolve(tempDir, "project"),
    });

    expect(config.notion.tokens).toEqual({
      work: "global-work-token",
      personal: "project-personal-token",
    });
  });

  it("skipProjectConfig ignores .interkasten.yaml", () => {
    writeFileSync(globalConfigPath, "sync:\n  poll_interval: 60\n");

    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(projectConfig, "sync:\n  poll_interval: 15\n");

    const config = loadConfig({
      configPath: globalConfigPath,
      projectDir: resolve(tempDir, "project"),
      skipProjectConfig: true,
    });

    expect(config.sync.poll_interval).toBe(60);
  });

  it("project config with env vars resolves correctly", () => {
    process.env.TEST_IK_TOKEN = "secret-token-value";

    writeFileSync(globalConfigPath, "");
    const projectConfig = resolve(tempDir, "project", PROJECT_CONFIG_FILE);
    writeFileSync(
      projectConfig,
      `notion:\n  tokens:\n    mytoken: "\${TEST_IK_TOKEN}"\n`,
    );

    const config = loadConfig({
      configPath: globalConfigPath,
      projectDir: resolve(tempDir, "project"),
    });

    expect(config.notion.tokens.mytoken).toBe("secret-token-value");
    delete process.env.TEST_IK_TOKEN;
  });
});

describe("setConfigValue with scope", () => {
  let tempDir: string;
  let origCwd: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `interkasten-setconfig-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("scope=project creates .interkasten.yaml in CWD when none exists", () => {
    const origEnv = process.env.INTERKASTEN_CONFIG_PATH;
    process.env.INTERKASTEN_CONFIG_PATH = resolve(tempDir, "global.yaml");

    setConfigValue("sync.poll_interval", 20, "project");

    const projectConfigPath = resolve(tempDir, PROJECT_CONFIG_FILE);
    expect(existsSync(projectConfigPath)).toBe(true);

    process.env.INTERKASTEN_CONFIG_PATH = origEnv;
  });

  it("scope=project writes to existing .interkasten.yaml", () => {
    const projectConfigPath = resolve(tempDir, PROJECT_CONFIG_FILE);
    writeFileSync(projectConfigPath, "sync:\n  batch_size: 5\n");

    const origEnv = process.env.INTERKASTEN_CONFIG_PATH;
    process.env.INTERKASTEN_CONFIG_PATH = resolve(tempDir, "global.yaml");

    setConfigValue("sync.poll_interval", 20, "project");

    // Re-read the project config file to verify both values
    const raw = readFileSync(projectConfigPath, "utf-8");
    expect(raw).toContain("poll_interval: 20");
    expect(raw).toContain("batch_size: 5");

    process.env.INTERKASTEN_CONFIG_PATH = origEnv;
  });
});
