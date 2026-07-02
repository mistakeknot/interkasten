#!/usr/bin/env node
/**
 * Generate tmux session strings from IdeaGUI data.
 *
 * Usage:
 *   node scripts/ideagui-tmux-list.mjs                    # all sessions
 *   node scripts/ideagui-tmux-list.mjs --terminal warp    # filter by terminal
 *   node scripts/ideagui-tmux-list.mjs --project demarch  # filter by project
 *   node scripts/ideagui-tmux-list.mjs --agent codex      # filter by agent
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const DEFAULT_JSON = resolve(process.env.HOME, "projects/transfer/ideagui/ideagui.json");

function toTmuxString(s) {
  const localPrefix = s.sync === "local-only" ? "local" : "";
  const hasDomain = s.domain && s.domain !== "general";

  if (s.pane === "left") {
    return localPrefix + "/" + s.terminal + "//" + s.project +
      (hasDomain ? "///" + s.domain : "") + "@" + s.agent;
  }
  if (s.pane === "right") {
    return localPrefix + "\\" + s.terminal + "\\\\" + s.project +
      (hasDomain ? "\\\\\\\\" + s.domain : "") + "@" + s.agent;
  }
  // No pane — simple format
  return s.terminal + "-" + s.project +
    (hasDomain ? "-" + s.domain : "") + "-" + s.agent;
}

function main() {
  const args = process.argv.slice(2);
  const filters = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) filters[key] = val.toLowerCase();
  }

  const data = JSON.parse(readFileSync(DEFAULT_JSON, "utf-8"));
  let sessions = data.sessions;

  // Apply filters
  for (const [key, val] of Object.entries(filters)) {
    sessions = sessions.filter(s => s[key]?.toLowerCase() === val);
  }

  // Group by terminal
  const grouped = {};
  for (const s of sessions) {
    const t = s.terminal || "unknown";
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(s);
  }

  // Output grouped
  for (const [terminal, group] of Object.entries(grouped).sort()) {
    for (const s of group) {
      console.log(toTmuxString(s));
    }
  }
}

main();
