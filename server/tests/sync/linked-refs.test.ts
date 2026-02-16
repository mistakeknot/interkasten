import { describe, it, expect } from "vitest";
import { summaryCardToNotionProperties } from "../../src/sync/linked-refs.js";

describe("linked references", () => {
  it("should generate Notion properties from a summary card", () => {
    const card = {
      title: "utils.ts",
      path: "/projects/test/src/utils.ts",
      lastModified: "2026-02-15T10:00:00Z",
      lineCount: 42,
    };
    const props = summaryCardToNotionProperties(card);

    expect(props.Name.title[0].text.content).toBe("utils.ts");
    expect(props.Path.rich_text[0].text.content).toBe("/projects/test/src/utils.ts");
    expect(props["Last Modified"].date.start).toBe("2026-02-15T10:00:00Z");
    expect(props["Line Count"].number).toBe(42);
  });
});
