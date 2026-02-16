import { execFileSync } from "child_process";
import { resolve } from "path";

export interface BeadsIssue {
  id: string;
  title: string;
  status: string;
  priority: number;
  type: string;
  assignee?: string;
  created?: string;
  updated?: string;
  notes?: string;
  dependencies?: string[];
}

export interface BeadsDiff {
  added: BeadsIssue[];
  modified: BeadsIssue[];
  removed: BeadsIssue[];
}

/**
 * Parse JSON output from `bd list --format=json`.
 * Returns empty array on invalid input (never throws).
 */
export function parseBeadsOutput(jsonOutput: string): BeadsIssue[] {
  try {
    const parsed = JSON.parse(jsonOutput);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Fetch beads issues for a project via the `bd` CLI.
 * Uses execFileSync (not execSync) to prevent shell injection.
 */
export function fetchBeadsIssues(projectDir: string): BeadsIssue[] {
  try {
    const output = execFileSync("bd", ["list", "--format=json"], {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
    return parseBeadsOutput(output);
  } catch {
    return [];
  }
}

/**
 * Compute the diff between two snapshots of beads state.
 */
export function diffBeadsState(previous: BeadsIssue[], current: BeadsIssue[]): BeadsDiff {
  const prevMap = new Map(previous.map((i) => [i.id, i]));
  const currMap = new Map(current.map((i) => [i.id, i]));

  const added = current.filter((i) => !prevMap.has(i.id));
  const removed = previous.filter((i) => !currMap.has(i.id));
  const modified = current.filter((i) => {
    const prev = prevMap.get(i.id);
    if (!prev) return false;
    return JSON.stringify(prev) !== JSON.stringify(i);
  });

  return { added, modified, removed };
}

const STATUS_MAP: Record<string, string> = {
  open: "Open",
  in_progress: "In Progress",
  closed: "Done",
  blocked: "Blocked",
};

const TYPE_MAP: Record<string, string> = {
  bug: "Bug",
  feature: "Feature",
  task: "Task",
  epic: "Epic",
};

/**
 * Map a beads issue to Notion database properties.
 */
export function mapBeadsToNotionProperties(issue: BeadsIssue): any {
  return {
    Name: { title: [{ text: { content: issue.title } }] },
    Status: { select: { name: STATUS_MAP[issue.status] || issue.status } },
    Priority: { select: { name: `P${issue.priority}` } },
    Type: { select: { name: TYPE_MAP[issue.type] || issue.type } },
    ...(issue.assignee
      ? { Assignee: { rich_text: [{ text: { content: issue.assignee } }] } }
      : {}),
    ...(issue.created ? { Created: { date: { start: issue.created } } } : {}),
    ...(issue.updated ? { "Last Updated": { date: { start: issue.updated } } } : {}),
  };
}

/**
 * Map Notion properties back to beads update fields.
 */
export function mapNotionToBeadsUpdate(properties: any): Partial<BeadsIssue> {
  const result: Partial<BeadsIssue> = {};

  const status = properties.Status?.select?.name;
  if (status) {
    const rev = Object.entries(STATUS_MAP).find(([, v]) => v === status);
    if (rev) result.status = rev[0];
  }

  const priority = properties.Priority?.select?.name;
  if (priority) {
    const match = priority.match(/P(\d)/);
    if (match) result.priority = parseInt(match[1]);
  }

  return result;
}

/**
 * Update a beads issue via the `bd` CLI.
 * Uses execFileSync (not execSync) to prevent shell injection.
 * Input values are passed as CLI arguments, not interpolated into a shell command.
 */
export function updateBeadsIssue(
  projectDir: string,
  issueId: string,
  updates: Partial<BeadsIssue>,
): void {
  const args = ["update", issueId];
  if (updates.status) args.push(`--status=${updates.status}`);
  if (updates.priority !== undefined) args.push(`--priority=${updates.priority}`);
  if (updates.title) args.push(`--title=${updates.title}`);

  if (args.length > 2) {
    execFileSync("bd", args, {
      cwd: resolve(projectDir),
      encoding: "utf-8",
      timeout: 10000,
    });
  }
}
