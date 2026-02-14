# Research: Markdown-Notion Block Conversion Libraries (TypeScript/JavaScript)

**Date:** 2026-02-14
**Purpose:** Evaluate whether TypeScript libraries can handle Markdown<->Notion block conversion for the Interkasten MCP server, or whether we need Go-based conversion (go-notion-md-sync).

---

## Executive Summary

The TypeScript/JavaScript ecosystem has **mature, high-adoption libraries** for both directions of Markdown-Notion conversion. The combination of **@tryfabric/martian** (Markdown -> Notion blocks, ~101K weekly downloads) and **notion-to-md** (Notion blocks -> Markdown, ~131K weekly downloads) covers our needs. The official Notion API still does NOT accept raw markdown -- it requires JSON block structures -- but the official Notion MCP server has introduced a "Notion-flavored Markdown" approach that handles conversion server-side for its hosted MCP. We do NOT need Go for the conversion layer; TypeScript libraries are sufficient. We only need custom sync state management logic.

---

## 1. @tryfabric/martian -- Markdown to Notion Blocks

### Package Details
| Field | Value |
|-------|-------|
| **npm package** | `@tryfabric/martian` |
| **Latest version** | 1.2.4 |
| **Last published** | ~May 2022 (4 years ago) |
| **Weekly downloads** | ~101,004 |
| **GitHub stars** | 524 |
| **License** | MIT |
| **Language** | TypeScript (99.9%) |
| **Commits** | 127 |

### What It Does
Converts Markdown (including GitHub Flavored Markdown) into Notion API-compatible block objects and rich text objects. Uses `unified` to parse Markdown into an AST, then converts the AST into Notion block structures.

### API
```typescript
import { markdownToBlocks, markdownToRichText } from '@tryfabric/martian';

// Convert markdown string to array of Notion blocks
const blocks = markdownToBlocks('# Hello World\n\nThis is **bold** text.');

// Convert markdown string to Notion rich text array
const richText = markdownToRichText('This is **bold** text.');
```

### Supported Block Types (Markdown -> Notion)
- **Text formatting**: bold, italic, strikethrough, inline code, hyperlinks, equations
- **Headers**: H1, H2, H3 (H4+ normalized to H3, matching Notion's limit)
- **Lists**: ordered, unordered, checkboxes (unlimited nesting depth)
- **Code blocks**: with language highlighting
- **Block quotes**: standard blockquotes
- **GFM alerts**: `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` -> Notion callout blocks
- **Callouts**: blockquotes starting with an emoji -> Notion callout blocks
- **Tables**: supported (with optional flag for unsupported mode)
- **Images**: supported with URL validation (external URLs only)
- **Equations**: block and inline math

### Limitations
- **Images**: Inline images are extracted from paragraphs and added as separate blocks (Notion doesn't support inline images). Invalid image URLs are converted to text.
- **Headers**: H4, H5, H6 are all treated as H3 (Notion only supports 3 levels)
- **Tables**: May need an optional flag for full support
- **No toggle blocks**: Standard Markdown has no toggle concept
- **No callout blocks**: Only via GFM alerts or emoji-prefixed blockquotes
- **No colored text**: Markdown has no color support
- **No mentions**: No @-mention support in standard Markdown
- **No synced blocks**: No Markdown equivalent
- **No columns**: No Markdown equivalent
- **Content limits**: By default, truncates content to stay within Notion API limits; configurable via `notionLimits` option

### Maintenance Concern
Last release was ~4 years ago. However, it still has 101K+ weekly downloads, indicating widespread production use. The library is mature and the Markdown -> Notion block mapping hasn't changed significantly since the Notion API stabilized.

### Assessment: GOOD for our use case
Despite being "unmaintained," it's stable, well-tested, widely used, and the underlying problem (Markdown AST -> Notion blocks) hasn't changed. The MCP-mdnotion project (Apache 2.0) uses this as its core dependency, validating its continued viability.

---

## 2. notion-to-md -- Notion Blocks to Markdown

### Package Details
| Field | Value |
|-------|-------|
| **npm package** | `notion-to-md` |
| **Latest version (stable)** | 3.1.9 |
| **Latest version (alpha)** | 4.0.0-alpha.5 |
| **Last published** | ~7-9 months ago |
| **Weekly downloads** | ~131,419 |
| **GitHub stars** | 1,647 |
| **License** | MIT |
| **Dependents** | 97 npm packages |

### What It Does
Converts Notion pages, individual blocks, and lists of blocks into Markdown. Built on top of `@notionhq/client` (official SDK).

### API (v3)
```typescript
import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Convert a full page
const mdblocks = await n2m.pageToMarkdown(pageId);
const mdString = n2m.toMarkdownString(mdblocks);

// Convert specific blocks
const mdblocks = await n2m.blocksToMarkdown(blocks);
```

### Supported Block Types (Notion -> Markdown)
Based on the source code and documentation, v3 supports:
- **paragraph** -> plain text
- **heading_1, heading_2, heading_3** -> `#`, `##`, `###`
- **bulleted_list_item** -> `- item` (with nesting)
- **numbered_list_item** -> `1. item` (with nesting)
- **to_do** -> `- [ ] item` / `- [x] item`
- **toggle** -> converted to details/summary HTML or custom format
- **code** -> fenced code blocks with language
- **image** -> `![alt](url)`
- **video** -> link or embed
- **file** -> link
- **bookmark** -> link
- **callout** -> blockquote with emoji prefix (e.g., `> :bulb: text`)
- **quote** -> `> blockquote`
- **divider** -> `---`
- **table** -> markdown tables
- **table_row** -> table row formatting
- **equation** -> `$$equation$$`
- **embed** -> iframe or link
- **child_page** -> link or separate document
- **child_database** -> table representation (v4)
- **link_preview** -> link
- **synced_block** -> renders the synced content
- **column_list / column** -> sequential rendering (columns flattened)

### Custom Transformers
You can override any block type's rendering:
```typescript
n2m.setCustomTransformer('callout', async (block) => {
  // Custom rendering logic
  return `:::note\n${block.callout.rich_text[0]?.plain_text}\n:::`;
});
```

### v4 Architecture (Alpha)
notion-to-md v4 is a complete rewrite with a modular plugin architecture:
- **Block Fetcher**: Concurrent API retrieval with rate limiting
- **Media Handler**: Configurable strategies (direct URL, download, upload to storage)
- **Renderer Plugin System**: Customizable output plugins for any format (Markdown, MDX, JSX, HTML, LaTeX)
- **Database Support**: Child databases converted to markdown tables
- **Frontmatter**: Notion properties -> YAML frontmatter with value transformations
- **Page References**: Automatic cross-reference handling

### Limitations
- **Toggle blocks**: Converted to HTML `<details>`/`<summary>` tags (not pure Markdown)
- **Callouts**: Converted to blockquotes with emoji (lossy -- loses callout styling/color)
- **Colors**: All text/background colors are lost
- **Mentions**: @-mentions converted to plain text
- **Columns**: Flattened to sequential content (layout lost)
- **Synced blocks**: Content is rendered but sync relationship is lost
- **Database views**: Filters, sorts, and view configurations are lost
- **Rich text annotations**: Color annotations are dropped

### Assessment: GOOD for our use case
Most actively maintained option with highest adoption. Custom transformers let us handle edge cases. v4 will provide even more flexibility when it stabilizes.

---

## 3. @notionhq/client -- Official Notion SDK

### Package Details
| Field | Value |
|-------|-------|
| **npm package** | `@notionhq/client` |
| **Latest version** | 5.9.0 |
| **Last published** | ~2 weeks ago |
| **License** | MIT |

### Markdown Support: NONE
The official SDK does **NOT** handle markdown conversion. It provides:
- Typed interfaces to all Notion API endpoints
- Error handling, pagination, retry logic
- Block CRUD operations (using JSON block structures)
- Database querying
- Page creation/updates

You must use third-party libraries (martian, notion-to-md) to convert between Markdown and Notion's JSON block format.

### Why No Native Markdown?
From Notion's engineering blog (2022): "The biggest problem with Markdown is that it is simply not expressive enough to support the use-cases that users wanted an API to fulfill." Specifically: "No widely-used Markdown implementation supports underlined or colored text, block or inline equations, callout blocks, toggle blocks, or dynamic user and date mentions."

---

## 4. Other Libraries

### @notion-md-converter/core
| Field | Value |
|-------|-------|
| **npm package** | `@notion-md-converter/core` |
| **Latest version** | 0.12.1 |
| **Weekly downloads** | ~3,176 |
| **GitHub stars** | 61 |
| **License** | MIT |
| **Direction** | Notion -> Markdown |

A modular Notion-to-Markdown converter with customizable transformer factories. Includes companion packages for testing (`@notion-md-converter/testing`) and MCP integration (`@notion-md-converter/mcp`). Documentation is primarily in Japanese. Emerging alternative, but lower adoption than notion-to-md.

### @notion-stuff/blocks-markdown-parser
| Field | Value |
|-------|-------|
| **npm package** | `@notion-stuff/blocks-markdown-parser` |
| **Latest version** | 6.0.0 |
| **Weekly downloads** | ~260 |
| **GitHub stars** | 6 |
| **License** | MIT |
| **Direction** | Notion -> Markdown |

Essentially defunct. Last published 4+ years ago. Not recommended.

### @interactive-inc/notion-client
| Field | Value |
|-------|-------|
| **npm package** | `@interactive-inc/notion-client` |
| **Direction** | Bidirectional |

Claims bidirectional conversion via `NotionMarkdown` component. Also provides `NotionTable` for simplified database operations. Limited documentation and lower adoption. Worth monitoring but not proven enough for production use.

### write2notion (web service)
A hosted service for markdown-to-Notion conversion. Not a library; not suitable for embedding.

---

## 5. Official Notion MCP Server's Approach

### Architecture
The official Notion MCP server (`@notionhq/notion-mcp-server`) takes a fundamentally different approach from the raw API:

1. **Notion-Flavored Markdown**: Notion developed an enhanced markdown specification that extends CommonMark to support Notion-specific block types (callouts, columns, databases, page references).
2. **Server-Side Conversion**: The markdown-to-blocks conversion happens on Notion's servers, not in the client.
3. **Token Efficiency**: Markdown representation is more compact than JSON blocks, reducing LLM token consumption.
4. **22 Tools**: Including `notion-create-pages`, `notion-update-page`, `notion-fetch` that accept/return markdown.

### Key Details
- The `create-pages` and `update-page` tools accept markdown content in a `content` field
- The `notion-fetch` tool returns page content as structured markdown
- Automatic parsing: headers, bold, italic, strikethrough, inline code, links
- Up to 100 blocks per request
- The conversion is done **server-side** by Notion's hosted MCP -- the open-source version does NOT include this conversion logic

### What This Means for Us
The official Notion MCP server handles markdown conversion internally, but:
- It's a **hosted service** (not embeddable library code)
- The open-source version (`makenotion/notion-mcp-server`) relies on the hosted API for markdown conversion
- We CANNOT use their conversion code directly
- We still need client-side conversion libraries (martian + notion-to-md) for our own MCP server

### Community MCP Servers with Markdown
- **suekou/mcp-notion-server**: Has `src/markdown/index.ts` with custom Notion->Markdown conversion. Uses `NOTION_MARKDOWN_CONVERSION=true` env var. Marked as experimental -- "may cause issues when trying to edit page content as the original structure is lost in conversion."
- **aia-ops/mcp-mdnotion**: Uses `@tryfabric/martian` for MD->Notion conversion. Single tool: `markdown-to-notion`. Apache 2.0 license.

---

## 6. Does the Notion API Accept Markdown Directly?

**No.** As of February 2026, the Notion API (including the latest version 2025-09-03) does NOT accept markdown directly. All content must be submitted as JSON block structures.

The only exception is the **hosted Notion MCP server**, which accepts markdown in its tool parameters but converts it to blocks server-side before calling the underlying API.

For any custom integration, you must:
1. Parse markdown into Notion block JSON (using martian or similar)
2. Submit those blocks via the standard API
3. When reading, convert Notion block JSON back to markdown (using notion-to-md or similar)

---

## 7. Conversion Fidelity Analysis

### Markdown -> Notion (via @tryfabric/martian)

| Markdown Element | Notion Block | Fidelity |
|-----------------|-------------|----------|
| `# Heading` | heading_1 | Lossless |
| `## Heading` | heading_2 | Lossless |
| `### Heading` | heading_3 | Lossless |
| `#### Heading` | heading_3 | **Lossy** (H4-H6 all become H3) |
| `**bold**` | bold annotation | Lossless |
| `*italic*` | italic annotation | Lossless |
| `~~strike~~` | strikethrough annotation | Lossless |
| `` `code` `` | code annotation | Lossless |
| `[link](url)` | link annotation | Lossless |
| `- list item` | bulleted_list_item | Lossless |
| `1. list item` | numbered_list_item | Lossless |
| `- [ ] todo` | to_do | Lossless |
| ` ```lang ``` ` | code block | Lossless |
| `> quote` | quote block | Lossless |
| `> :emoji: text` | callout block | **Partial** (custom convention) |
| `![](url)` | image block | Lossless (if URL valid) |
| `\| table \|` | table block | Lossless (with flag) |
| `$$ equation $$` | equation block | Lossless |
| `---` | divider | Lossless |

### Notion -> Markdown (via notion-to-md)

| Notion Block | Markdown Output | Fidelity |
|-------------|----------------|----------|
| heading_1/2/3 | `#`/`##`/`###` | Lossless |
| paragraph | plain text | Lossless |
| bulleted_list_item | `- item` | Lossless |
| numbered_list_item | `1. item` | Lossless |
| to_do | `- [ ]`/`- [x]` | Lossless |
| code | fenced code block | Lossless |
| quote | `> blockquote` | Lossless |
| divider | `---` | Lossless |
| image | `![](url)` | Lossless |
| table | markdown table | Lossless |
| equation | `$$equation$$` | Lossless |
| bookmark | `[url](url)` | Lossless |
| callout | `> :emoji: text` | **Lossy** (color/style lost) |
| toggle | `<details>` HTML | **Lossy** (not pure MD) |
| column_list | sequential text | **Lossy** (layout lost) |
| synced_block | rendered content | **Lossy** (sync relation lost) |
| colored text | plain text | **Lossy** (color lost) |
| mentions | plain text | **Lossy** (dynamic link lost) |
| child_database | table or link | **Lossy** (filters/views lost) |
| embed | link/iframe | **Partial** |
| file/video/audio | link | **Partial** |

### Roundtrip Assessment
For **standard Zettelkasten content** (text, headers, lists, code, links, images, blockquotes):
- **Roundtrip fidelity: ~95%+** -- nearly lossless
- Main losses: H4+ headings, text colors, toggle formatting

For **rich Notion content** (callouts, toggles, columns, databases, colored text, mentions):
- **Roundtrip fidelity: ~70-80%** -- structure preserved, styling/metadata lost
- Custom transformers can improve this significantly

---

## 8. Recommendation for Interkasten

### We Do NOT Need go-notion-md-sync for Conversion

The TypeScript ecosystem provides everything needed:

| Need | Solution |
|------|----------|
| Markdown -> Notion blocks | `@tryfabric/martian` |
| Notion blocks -> Markdown | `notion-to-md` (v3 stable, v4 for future) |
| Notion API operations | `@notionhq/client` (official SDK) |
| Custom block handling | `notion-to-md` custom transformers |

### What We DO Need to Build Ourselves

1. **Sync state management**: Tracking what changed on each side since last sync
2. **Conflict resolution**: When both Markdown file and Notion page changed
3. **Notion-specific metadata preservation**: Storing block IDs, colors, toggle state in markdown frontmatter or comments so roundtrip fidelity improves
4. **Batch operations**: Efficient handling of many pages
5. **Rate limiting**: Notion API has 3 req/sec average (180/min)

### Recommended Dependency Stack

```json
{
  "dependencies": {
    "@notionhq/client": "^5.9.0",
    "@tryfabric/martian": "^1.2.4",
    "notion-to-md": "^3.1.9"
  }
}
```

Total additional dependencies: 3 packages (plus their transitive deps). All MIT licensed. All widely adopted.

### Risk Mitigation
- **martian stale?** The Markdown spec and Notion block API are both stable. If martian needs fixes, we can fork/patch or use the MCP-mdnotion fork.
- **notion-to-md v4 breaking?** Stay on v3.x for now; v4 is alpha. Upgrade when stable.
- **Block types we can't roundtrip?** Use custom transformers in notion-to-md to add metadata comments (e.g., `<!-- notion:callout color=blue -->`) that martian can recognize.

---

## Sources

- [@tryfabric/martian - GitHub](https://github.com/tryfabric/martian)
- [@tryfabric/martian - npm](https://www.npmjs.com/package/@tryfabric/martian)
- [notion-to-md - GitHub](https://github.com/souvikinator/notion-to-md)
- [notion-to-md - npm](https://www.npmjs.com/package/notion-to-md)
- [notion-to-md v4 documentation](https://notionconvert.com/docs/v4/)
- [@notionhq/client - GitHub](https://github.com/makenotion/notion-sdk-js)
- [Official Notion MCP Server - GitHub](https://github.com/makenotion/notion-mcp-server)
- [Notion's hosted MCP server: an inside look (blog)](https://www.notion.com/blog/notions-hosted-mcp-server-an-inside-look)
- [Notion MCP Supported Tools](https://developers.notion.com/docs/mcp-supported-tools)
- [Creating the Notion API (blog)](https://www.notion.com/blog/creating-the-notion-api)
- [suekou/mcp-notion-server - GitHub](https://github.com/suekou/mcp-notion-server)
- [aia-ops/mcp-mdnotion - GitHub](https://github.com/aia-ops/mcp-mdnotion)
- [@notion-md-converter/core - npm](https://www.npmjs.com/package/@notion-md-converter/core)
- [@interactive-inc/notion-client - npm](https://www.npmjs.com/package/@interactive-inc/notion-client)
- [npmtrends comparison](https://npmtrends.com/@tryfabric/martian-vs-notion-to-md-vs-@notion-stuff/blocks-markdown-parser-vs-@notion-md-converter/core)
- [Notion API Changelog](https://developers.notion.com/page/changelog)
- [Notion API block reference](https://developers.notion.com/reference/block)
