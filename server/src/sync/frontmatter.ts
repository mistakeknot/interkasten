import matter from "gray-matter";

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed data and body content.
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const result = matter(content);
  return { data: result.data, body: result.content };
}

/**
 * Serialize data as YAML frontmatter prepended to body content.
 */
export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  return matter.stringify(body, data);
}

/**
 * Check whether a string begins with YAML frontmatter delimiters.
 */
export function hasFrontmatter(content: string): boolean {
  return content.trimStart().startsWith("---");
}
