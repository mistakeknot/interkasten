import { execFileSync } from "child_process";
import { relative, resolve } from "path";

/**
 * Run a git command in the given working directory.
 * All output is returned as a trimmed string.
 */
export function runGit(workdir: string, args: string[]): string {
  return execFileSync("git", ["-C", workdir, ...args], {
    encoding: "utf-8",
  }).trim();
}

/**
 * Check if a directory is inside a git work tree.
 */
export function isGitRepo(workdir: string): boolean {
  try {
    runGit(workdir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit hash.
 */
export function getHead(workdir: string): string {
  return runGit(workdir, ["rev-parse", "HEAD"]);
}

/**
 * Fast-forward pull from a remote branch.
 * Throws if a fast-forward is not possible.
 */
export function pullFastForward(
  workdir: string,
  remote: string,
  branch: string,
): void {
  runGit(workdir, ["pull", "--ff-only", remote, branch]);
}

/**
 * Check for any uncommitted changes (staged or unstaged).
 */
export function hasChanges(workdir: string): boolean {
  const status = runGit(workdir, ["status", "--porcelain"]);
  return status.length > 0;
}

/**
 * Stage all changes, commit, and push.
 * Skips if there's nothing to commit after staging.
 */
export function commitAndPush(opts: {
  workdir: string;
  remote: string;
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
}): void {
  runGit(opts.workdir, ["add", "-A"]);

  const status = runGit(opts.workdir, ["status", "--porcelain"]);
  if (!status) return;

  runGit(opts.workdir, [
    "-c",
    `user.name=${opts.authorName}`,
    "-c",
    `user.email=${opts.authorEmail}`,
    "commit",
    "-m",
    opts.message,
  ]);
  runGit(opts.workdir, ["pull", "--ff-only", opts.remote, opts.branch]);
  runGit(opts.workdir, ["push", opts.remote, opts.branch]);
}

/**
 * List files changed between two commits.
 * Returns paths relative to the repo root.
 */
export function changedFilesBetween(
  workdir: string,
  fromCommit: string,
  toCommit: string,
): string[] {
  if (!fromCommit || !toCommit || fromCommit === toCommit) return [];
  const raw = runGit(workdir, [
    "diff",
    "--name-only",
    `${fromCommit}..${toCommit}`,
  ]);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Compute the relative path from workdir to outputDir.
 * Returns null if outputDir is outside workdir (except when equal → ".").
 */
export function outputDirRelativePath(
  workdir: string,
  outputDir: string,
): string | null {
  const rel = relative(resolve(workdir), resolve(outputDir));
  if (rel === "" || rel === ".") return ".";
  if (rel.startsWith("..")) return null;
  return rel;
}
