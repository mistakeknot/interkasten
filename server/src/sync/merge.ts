import { diff3Merge } from "node-diff3";

export interface ConflictRegion {
  baseStart: number;
  baseEnd: number;
  localContent: string;
  remoteContent: string;
}

export interface MergeResult {
  merged: string;
  hasConflicts: boolean;
  conflicts: ConflictRegion[];
}

export type ConflictStrategy = "local-wins" | "notion-wins" | "three-way-merge" | "conflict-file";

/**
 * Three-way merge using node-diff3.
 *
 * @param base - Common ancestor content
 * @param local - Local version
 * @param remote - Notion version
 * @param conflictFallback - Strategy for overlapping changes
 */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
  conflictFallback: ConflictStrategy = "three-way-merge",
): MergeResult {
  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  const result = diff3Merge(localLines, baseLines, remoteLines);

  const mergedLines: string[] = [];
  const conflicts: ConflictRegion[] = [];
  let lineCounter = 0;

  for (const chunk of result) {
    if ("ok" in chunk && chunk.ok) {
      mergedLines.push(...chunk.ok);
      lineCounter += chunk.ok.length;
    } else if ("conflict" in chunk && chunk.conflict) {
      const conflict: ConflictRegion = {
        baseStart: lineCounter,
        baseEnd: lineCounter + (chunk.conflict.o?.length ?? 0),
        localContent: chunk.conflict.a.join("\n"),
        remoteContent: chunk.conflict.b.join("\n"),
      };
      conflicts.push(conflict);

      switch (conflictFallback) {
        case "local-wins":
          mergedLines.push(...chunk.conflict.a);
          break;
        case "notion-wins":
          mergedLines.push(...chunk.conflict.b);
          break;
        case "three-way-merge":
        case "conflict-file":
        default:
          // local-wins as ultimate fallback within three-way-merge
          mergedLines.push(...chunk.conflict.a);
          break;
      }
      lineCounter += chunk.conflict.a.length;
    }
  }

  return {
    merged: mergedLines.join("\n"),
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Generate a .conflict file with both versions (Syncthing-style).
 */
export function formatConflictFile(
  localContent: string,
  remoteContent: string,
  filePath: string,
): string {
  return [
    `# Sync Conflict: ${filePath}`,
    `# Detected: ${new Date().toISOString()}`,
    `# Resolve by keeping one version and deleting this file.`,
    "",
    "## Local Version",
    "",
    localContent,
    "",
    "## Notion Version",
    "",
    remoteContent,
  ].join("\n");
}
