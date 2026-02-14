import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../../src/config/loader.js";

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
    const config = loadConfig(resolve(tempDir, "nonexistent.yaml"));
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
`
    );

    const config = loadConfig(configPath);
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
    writeFileSync(
      configPath,
      `projects_dir: "\${TEST_PROJECTS_DIR}"`
    );

    const config = loadConfig(configPath);
    expect(config.projects_dir).toBe("/test/projects");

    delete process.env.TEST_PROJECTS_DIR;
  });

  it("resolves env vars with defaults", () => {
    delete process.env.MISSING_VAR;
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      `projects_dir: "\${MISSING_VAR:-/fallback/path}"`
    );

    const config = loadConfig(configPath);
    expect(config.projects_dir).toBe("/fallback/path");
  });

  it("rejects invalid config values", () => {
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(
      configPath,
      `
sync:
  conflict_strategy: "invalid-strategy"
`
    );

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("handles empty config file", () => {
    const configPath = resolve(tempDir, "config.yaml");
    writeFileSync(configPath, "");

    const config = loadConfig(configPath);
    expect(config.sync.poll_interval).toBe(60);
  });
});
