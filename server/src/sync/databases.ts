import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { DatabaseSchema, DatabaseProperty } from "./discovery.js";

// Re-export for convenience
export type { DatabaseSchema, DatabaseProperty } from "./discovery.js";

// Property types that support bidirectional sync
const EDITABLE_TYPES = new Set([
  "title", "rich_text", "select", "multi_select",
  "number", "date", "checkbox", "url", "email", "phone_number",
]);

export interface DbRowFrontmatter {
  notion_id: string;
  notion_type: "database_row";
  notion_database_id: string;
  title: string;
  last_synced: string;
  notion_last_edited: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Convert a Notion database row to frontmatter data.
 */
export function rowToFrontmatter(
  row: PageObjectResponse,
  schema: DatabaseSchema,
): DbRowFrontmatter {
  const fm: DbRowFrontmatter = {
    notion_id: row.id,
    notion_type: "database_row",
    notion_database_id: schema.id,
    title: "",
    last_synced: new Date().toISOString(),
    notion_last_edited: row.last_edited_time,
  };

  const rowProps = row.properties as Record<string, any>;

  for (const [name, schemaProp] of Object.entries(schema.properties)) {
    const prop = rowProps[name];
    if (!prop) continue;

    const value = extractPropertyValue(prop, schemaProp.type);
    if (value !== undefined && value !== null && value !== "") {
      const key = sanitizeKey(name);
      if (schemaProp.type === "title") {
        fm.title = String(value);
      } else {
        fm[key] = value;
      }
    }
  }

  return fm;
}

/**
 * Convert frontmatter data back to Notion property format.
 * Only converts editable property types.
 */
export function frontmatterToProperties(
  frontmatter: Record<string, unknown>,
  schema: DatabaseSchema,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [name, schemaProp] of Object.entries(schema.properties)) {
    if (!EDITABLE_TYPES.has(schemaProp.type)) continue;

    const key = sanitizeKey(name);
    const value = schemaProp.type === "title"
      ? frontmatter["title"]
      : frontmatter[key];

    if (value === undefined) continue;

    const notionValue = toNotionProperty(value, schemaProp.type);
    if (notionValue !== undefined) {
      properties[name] = notionValue;
    }
  }

  return properties;
}

/**
 * Generate a markdown table from database rows.
 */
export function generateTableMarkdown(
  rows: PageObjectResponse[],
  schema: DatabaseSchema,
): string {
  const columns = Object.entries(schema.properties)
    .filter(([_, p]) => !["formula", "rollup", "created_by", "last_edited_by", "files"].includes(p.type))
    .sort((a, b) => {
      if (a[1].type === "title") return -1;
      if (b[1].type === "title") return 1;
      return a[0].localeCompare(b[0]);
    });

  if (columns.length === 0) return "";

  const header = "| " + columns.map(([name]) => name).join(" | ") + " |";
  const separator = "| " + columns.map(() => "---").join(" | ") + " |";

  const rowLines = rows.map((row) => {
    const rowProps = row.properties as Record<string, any>;
    const cells = columns.map(([name, schemaProp]) => {
      const prop = rowProps[name];
      if (!prop) return "-";
      const val = extractPropertyValue(prop, schemaProp.type);
      if (val === undefined || val === null || val === "") return "-";
      return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
    });
    return "| " + cells.join(" | ") + " |";
  });

  return [header, separator, ...rowLines].join("\n");
}

/**
 * Extract a value from a Notion property object.
 */
export function extractPropertyValue(
  prop: any,
  type: string,
): string | number | boolean | undefined {
  if (!prop) return undefined;

  switch (type) {
    case "title":
      return prop.title?.map((t: any) => t.plain_text).join("") ?? "";
    case "rich_text":
      return prop.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return prop.multi_select?.map((s: any) => s.name).join(", ") ?? "";
    case "number":
      return prop.number ?? undefined;
    case "date":
      return prop.date?.start ?? "";
    case "checkbox":
      return prop.checkbox ?? false;
    case "url":
      return prop.url ?? "";
    case "email":
      return prop.email ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "status":
      return prop.status?.name ?? "";
    case "people":
      return prop.people?.map((p: any) => p.name ?? p.id).join(", ") ?? "";
    case "relation":
      return prop.relation?.map((r: any) => r.id).join(", ") ?? "";
    case "formula":
      if (prop.formula?.type === "string") return prop.formula.string ?? "";
      if (prop.formula?.type === "number") return prop.formula.number ?? 0;
      if (prop.formula?.type === "boolean") return prop.formula.boolean ?? false;
      if (prop.formula?.type === "date") return prop.formula.date?.start ?? "";
      return "";
    case "rollup":
      if (prop.rollup?.type === "number") return prop.rollup.number ?? 0;
      if (prop.rollup?.type === "array") return `[${prop.rollup.array?.length ?? 0} items]`;
      return "";
    case "created_time":
      return prop.created_time ?? "";
    case "last_edited_time":
      return prop.last_edited_time ?? "";
    case "unique_id":
      return prop.unique_id ? `${prop.unique_id.prefix ?? ""}${prop.unique_id.number ?? ""}` : "";
    default:
      return undefined;
  }
}

/**
 * Convert a frontmatter value to a Notion API property value.
 */
export function toNotionProperty(value: unknown, type: string): unknown {
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    case "select":
      return value ? { select: { name: String(value) } } : { select: null };
    case "multi_select":
      if (typeof value === "string") {
        const names = value.split(",").map((s) => s.trim()).filter(Boolean);
        return { multi_select: names.map((name) => ({ name })) };
      }
      return undefined;
    case "number":
      return { number: typeof value === "number" ? value : parseFloat(String(value)) || null };
    case "date":
      return value ? { date: { start: String(value) } } : { date: null };
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "url":
      return { url: value ? String(value) : null };
    case "email":
      return { email: value ? String(value) : null };
    case "phone_number":
      return { phone_number: value ? String(value) : null };
    default:
      return undefined;
  }
}

/**
 * Sanitize a property name for use as a frontmatter key.
 */
export function sanitizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "");
}

/**
 * Sanitize a title for use as a filename.
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "") // strip emoji
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")  // strip unsafe chars
    .replace(/\s+/g, "-")                    // spaces to hyphens
    .replace(/-+/g, "-")                     // collapse hyphens
    .replace(/(^-|-$)/g, "")                 // trim hyphens
    .trim()
    || "Untitled";
}
