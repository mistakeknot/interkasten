import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, statSync, lstatSync } from "fs";
import { basename, join, extname, resolve } from "path";
import { execFileSync } from "child_process";
import type { DaemonContext } from "../context.js";
import { listProjects, lookupByPath } from "../../sync/entity-map.js";

/**
 * Raw filesystem and git signals for a project.
 * Agent interprets these to propose tiers, tags, status, etc.
 */
export interface ProjectSignals {
  loc: number;
  has_beads: boolean;
  has_git: boolean;
  has_plugin_json: boolean;
  has_go_mod: boolean;
  has_cargo_toml: boolean;
  has_pyproject: boolean;
  has_package_json: boolean;
  has_dockerfile: boolean;
  has_readme: boolean;
  has_src: boolean;
  has_tests: boolean;
  md_count: number;
  manifest_type: string | null;
  last_commit_days: number | null;
  commit_count: number;
  existing_docs: string[];
  file_count: number;
  directory_structure: string[];
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go",
  ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".cs",
  ".rb", ".php", ".lua", ".zig", ".ex", ".exs",
]);

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "__pycache__", "target",
  "build", ".next", "venv", ".venv", "vendor", ".beads",
]);

export function registerSignalsTools(server: McpServer, ctx: DaemonContext): void {
  server.tool(
    "interkasten_gather_signals",
    "Gather filesystem and git signals for a project. Returns raw data for the agent to interpret — does NOT classify or recommend.",
    {
      project: z.string().describe("Project name or absolute path"),
    },
    async ({ project: projectInput }) => {
      // Resolve project path
      let projectPath = projectInput;

      if (!existsSync(projectPath)) {
        // Try as project name against registered projects
        if (ctx.db) {
          const projects = listProjects(ctx.db);
          const match = projects.find((p) => basename(p.localPath) === projectInput);
          if (match) {
            projectPath = match.localPath;
          }
        }
      }

      if (!existsSync(projectPath)) {
        return {
          content: [{
            type: "text" as const,
            text: `Path does not exist: ${projectPath}`,
          }],
          isError: true,
        };
      }

      const signals = gatherProjectSignals(projectPath);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(signals, null, 2),
        }],
      };
    }
  );

  server.tool(
    "interkasten_scan_files",
    "Scan a project directory for files matching a glob pattern. Returns file list with metadata. Does not decide which files matter — that's the agent's job.",
    {
      project: z.string().describe("Project name or absolute path"),
      pattern: z
        .string()
        .optional()
        .default("**/*.md")
        .describe("File extension filter (e.g., '.md', '.ts'). Default: '.md'"),
      include_size: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include file sizes in bytes"),
    },
    async ({ project: projectInput, pattern, include_size }) => {
      let projectPath = projectInput;

      if (!existsSync(projectPath)) {
        if (ctx.db) {
          const projects = listProjects(ctx.db);
          const match = projects.find((p) => basename(p.localPath) === projectInput);
          if (match) projectPath = match.localPath;
        }
      }

      if (!existsSync(projectPath)) {
        return {
          content: [{
            type: "text" as const,
            text: `Path does not exist: ${projectPath}`,
          }],
          isError: true,
        };
      }

      // Extract extension from pattern (supports "**/*.md" or ".md" or "md")
      const ext = pattern.startsWith(".")
        ? pattern
        : pattern.includes("*.")
          ? "." + pattern.split("*.").pop()
          : "." + pattern;

      const files = scanFiles(projectPath, ext, include_size);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            project: projectPath,
            pattern: ext,
            count: files.length,
            files,
          }, null, 2),
        }],
      };
    }
  );
}

/**
 * Gather all project signals from the filesystem.
 */
export function gatherProjectSignals(projectPath: string): ProjectSignals {
  const entries = safeReaddir(projectPath);

  // Check for manifest files
  const hasPackageJson = entries.includes("package.json");
  const hasPyproject = entries.includes("pyproject.toml");
  const hasCargoToml = entries.includes("Cargo.toml");
  const hasGoMod = entries.includes("go.mod");

  let manifestType: string | null = null;
  if (hasPackageJson) manifestType = "package.json";
  else if (hasPyproject) manifestType = "pyproject.toml";
  else if (hasCargoToml) manifestType = "Cargo.toml";
  else if (hasGoMod) manifestType = "go.mod";

  // Find existing docs
  const existingDocs = entries
    .filter((e) => e.endsWith(".md") && !e.startsWith("."))
    .sort();

  // Check docs/ subdirectory
  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir)) {
    for (const entry of safeReaddir(docsDir)) {
      if (entry.endsWith(".md")) {
        existingDocs.push(`docs/${entry}`);
      }
    }
  }

  // Top-level directory structure
  const dirStructure = entries
    .filter((e) => {
      if (e.startsWith(".")) return false;
      try {
        return statSync(join(projectPath, e)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => d + "/")
    .sort();

  return {
    loc: countLoc(projectPath),
    has_beads: entries.includes(".beads"),
    has_git: entries.includes(".git"),
    has_plugin_json: existsSync(join(projectPath, ".claude-plugin", "plugin.json")),
    has_go_mod: hasGoMod,
    has_cargo_toml: hasCargoToml,
    has_pyproject: hasPyproject,
    has_package_json: hasPackageJson,
    has_dockerfile:
      entries.includes("Dockerfile") ||
      entries.includes("docker-compose.yml") ||
      entries.includes("docker-compose.yaml"),
    has_readme: entries.includes("README.md") || entries.includes("readme.md"),
    has_src: entries.includes("src") || entries.includes("lib"),
    has_tests:
      entries.includes("tests") ||
      entries.includes("test") ||
      entries.includes("__tests__") ||
      entries.includes("spec"),
    md_count: existingDocs.length,
    manifest_type: manifestType,
    last_commit_days: getLastCommitDays(projectPath),
    commit_count: getCommitCount(projectPath),
    existing_docs: existingDocs,
    file_count: countFiles(projectPath),
    directory_structure: dirStructure,
  };
}

// --- Helpers ---

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function countLoc(dir: string, depth = 0): number {
  if (depth > 10) return 0;

  let count = 0;
  for (const entry of safeReaddir(dir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        count += countLoc(fullPath, depth + 1);
      } else if (stat.isFile() && CODE_EXTENSIONS.has(extname(entry))) {
        // Estimate LOC from file size (~40 bytes per line avg)
        count += Math.ceil(stat.size / 40);
      }
    } catch {
      continue;
    }
  }

  return count;
}

function countFiles(dir: string, depth = 0): number {
  if (depth > 5) return 0;

  let count = 0;
  for (const entry of safeReaddir(dir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        count += countFiles(fullPath, depth + 1);
      } else if (stat.isFile()) {
        count++;
      }
    } catch {
      continue;
    }
  }

  return count;
}

interface ScannedFile {
  path: string;
  name: string;
  relative_path: string;
  size?: number;
}

function scanFiles(
  projectPath: string,
  ext: string,
  includeSize: boolean,
  subdir = "",
  depth = 0
): ScannedFile[] {
  if (depth > 5) return [];

  const results: ScannedFile[] = [];
  const fullDir = subdir ? join(projectPath, subdir) : projectPath;

  for (const entry of safeReaddir(fullDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const fullPath = join(fullDir, entry);
    const relativePath = subdir ? `${subdir}/${entry}` : entry;

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...scanFiles(projectPath, ext, includeSize, relativePath, depth + 1));
      } else if (stat.isFile() && entry.endsWith(ext)) {
        const file: ScannedFile = {
          path: fullPath,
          name: entry,
          relative_path: relativePath,
        };
        if (includeSize) file.size = stat.size;
        results.push(file);
      }
    } catch {
      continue;
    }
  }

  return results;
}

function getLastCommitDays(projectPath: string): number | null {
  if (!existsSync(join(projectPath, ".git"))) return null;

  try {
    const stdout = execFileSync(
      "git",
      ["log", "-1", "--format=%ct"],
      { cwd: projectPath, stdio: "pipe", encoding: "utf-8" }
    ).trim();

    if (!stdout) return null;

    const commitEpoch = parseInt(stdout, 10);
    const nowEpoch = Math.floor(Date.now() / 1000);
    return Math.floor((nowEpoch - commitEpoch) / 86400);
  } catch {
    return null;
  }
}

function getCommitCount(projectPath: string): number {
  if (!existsSync(join(projectPath, ".git"))) return 0;

  try {
    const stdout = execFileSync(
      "git",
      ["rev-list", "--count", "HEAD"],
      { cwd: projectPath, stdio: "pipe", encoding: "utf-8" }
    ).trim();

    return parseInt(stdout, 10) || 0;
  } catch {
    return 0;
  }
}
