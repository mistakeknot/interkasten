import { describe, it, expect } from "vitest";
import { parseBeadsOutput, diffBeadsState, mapBeadsToNotionProperties } from "../../src/sync/beads-sync.js";

describe("parseBeadsOutput", () => {
  it("should parse bd list --format=json output", () => {
    const bdOutput = JSON.stringify([
      { id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" },
      { id: "Test-def", title: "Add feature", status: "in_progress", priority: 1, type: "feature" },
    ]);
    const issues = parseBeadsOutput(bdOutput);
    expect(issues).toHaveLength(2);
    expect(issues[0].id).toBe("Test-abc");
  });

  it("should return empty array on invalid JSON", () => {
    expect(parseBeadsOutput("not json")).toEqual([]);
    expect(parseBeadsOutput("")).toEqual([]);
  });
});

describe("diffBeadsState", () => {
  it("should detect new issues", () => {
    const prev = [{ id: "Test-abc", title: "Old", status: "open", priority: 2, type: "bug" }];
    const curr = [
      { id: "Test-abc", title: "Old", status: "open", priority: 2, type: "bug" },
      { id: "Test-def", title: "New", status: "open", priority: 1, type: "feature" },
    ];
    const diff = diffBeadsState(prev, curr);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe("Test-def");
  });

  it("should detect modified issues", () => {
    const prev = [{ id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" }];
    const curr = [{ id: "Test-abc", title: "Fix bug", status: "in_progress", priority: 2, type: "bug" }];
    const diff = diffBeadsState(prev, curr);
    expect(diff.modified).toHaveLength(1);
  });

  it("should detect removed issues", () => {
    const prev = [{ id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" }];
    const diff = diffBeadsState(prev, []);
    expect(diff.removed).toHaveLength(1);
  });

  it("should handle empty states", () => {
    const diff = diffBeadsState([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

describe("mapBeadsToNotionProperties", () => {
  it("should map beads fields to Notion property format", () => {
    const issue = { id: "Test-abc", title: "Fix bug", status: "open", priority: 2, type: "bug" };
    const props = mapBeadsToNotionProperties(issue);
    expect(props.Name.title[0].text.content).toBe("Fix bug");
    expect(props.Status.select.name).toBe("Open");
    expect(props.Priority.select.name).toBe("P2");
    expect(props.Type.select.name).toBe("Bug");
  });

  it("should include optional fields when present", () => {
    const issue = {
      id: "Test-abc",
      title: "Fix bug",
      status: "in_progress",
      priority: 1,
      type: "feature",
      assignee: "claude",
      created: "2026-02-15",
    };
    const props = mapBeadsToNotionProperties(issue);
    expect(props.Assignee.rich_text[0].text.content).toBe("claude");
    expect(props.Created.date.start).toBe("2026-02-15");
  });

  it("should map unknown status values as-is", () => {
    const issue = { id: "Test-abc", title: "X", status: "custom_status", priority: 3, type: "task" };
    const props = mapBeadsToNotionProperties(issue);
    expect(props.Status.select.name).toBe("custom_status");
  });
});
