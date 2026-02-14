import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, extname } from "path";
import { execFileSync } from "child_process";

// --- Types ---

export type DocTier = "Product" | "Tool" | "Inactive";

export interface TriageSignals {
  loc: number;
  hasBeads: boolean;
  isPlugin: boolean;
  mdCount: number;
  hasManifest: boolean;
  lastCommitDays: number | null;
  commitCount: number;
  hasReadme: boolean;
  hasSrc: boolean;
}

export interface TriageResult {
  tier: DocTier;
  signals: TriageSignals;
  requiredDocs: string[];
}

// --- Constants ---

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go",
]);

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "__pycache__", "target",
  "build", ".next", "venv", ".venv", "vendor",
]);

export const TIER_DOC_REQUIREMENTS: Record<DocTier, readonly string[]> = {
  Product: ["Vision", "PRD", "Roadmap", "AGENTS.md", "CLAUDE.md"],
  Tool: ["AGENTS.md", "CLAUDE.md"],
  Inactive: [],
};

// --- Signal Gathering ---

/**
 * Gather all classification signals from a project directory.
 * All operations are local filesystem + git — no network calls.
 */
export function gatherSignals(projectPath: string): TriageSignals {
  return {
    loc: countLoc(projectPath),
    hasBeads: existsSync(join(projectPath, ".beads")),
    isPlugin: existsSync(join(projectPath, ".claude-plugin", "plugin.json")),
    mdCount: countMarkdownFiles(projectPath),
    hasManifest: hasManifestFile(projectPath),
    lastCommitDays: getLastCommitDays(projectPath),
    commitCount: getCommitCount(projectPath),
    hasReadme: existsSync(join(projectPath, "README.md")),
    hasSrc:
      existsSync(join(projectPath, "src")) ||
      existsSync(join(projectPath, "lib")),
  };
}

// --- Classification ---

/**
 * Classify a project into a doc tier based on its signals.
 * Uses first-match rules: Inactive → Product → Tool (default).
 */
export function classifyProject(signals: TriageSignals): DocTier {
  // INACTIVE checks (first match wins)
  if (!signals.hasManifest && !signals.hasSrc && signals.commitCount < 3) {
    return "Inactive";
  }
  if (
    signals.lastCommitDays !== null &&
    signals.lastCommitDays > 180 &&
    signals.commitCount < 5
  ) {
    return "Inactive";
  }
  if (signals.loc === 0 && signals.mdCount < 2) {
    return "Inactive";
  }

  // PRODUCT checks
  if (signals.loc >= 1000) {
    return "Product";
  }
  if (signals.hasBeads && signals.commitCount >= 10) {
    return "Product";
  }
  if (signals.mdCount >= 5 && signals.hasManifest && signals.hasSrc) {
    return "Product";
  }

  // Default: TOOL
  return "Tool";
}

/**
 * Get the list of required key docs for a given tier.
 */
export function getRequiredDocs(tier: DocTier): readonly string[] {
  return TIER_DOC_REQUIREMENTS[tier];
}

/**
 * Full triage pipeline: gather signals → classify → determine required docs.
 */
export function triageProject(projectPath: string): TriageResult {
  const signals = gatherSignals(projectPath);
  const tier = classifyProject(signals);
  const requiredDocs = [...getRequiredDocs(tier)];
  return { tier, signals, requiredDocs };
}

// --- Helpers ---

/**
 * Count non-blank lines in source code files (recursive, skipping vendor dirs).
 */
function countLoc(dir: string, depth = 0): number {
  if (depth > 10) return 0;

  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      count += countLoc(fullPath, depth + 1);
    } else if (stat.isFile() && CODE_EXTENSIONS.has(extname(entry))) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        count += lines.length;
      } catch {
        // Skip unreadable files
      }
    }
  }

  return count;
}

/**
 * Count markdown files in root and docs/ directory.
 */
function countMarkdownFiles(projectPath: string): number {
  let count = 0;

  // Root-level .md files
  try {
    for (const entry of readdirSync(projectPath)) {
      if (entry.endsWith(".md") && !entry.startsWith(".")) count++;
    }
  } catch {
    // Skip
  }

  // docs/ directory
  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir)) {
    try {
      for (const entry of readdirSync(docsDir)) {
        if (entry.endsWith(".md")) count++;
      }
    } catch {
      // Skip
    }
  }

  return count;
}

/**
 * Check for common manifest files (package.json, pyproject.toml, Cargo.toml).
 */
function hasManifestFile(projectPath: string): boolean {
  const manifests = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  return manifests.some((m) => existsSync(join(projectPath, m)));
}

/**
 * Get days since last git commit (null if not a git repo or no commits).
 */
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

/**
 * Get total commit count (0 if not a git repo).
 */
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
