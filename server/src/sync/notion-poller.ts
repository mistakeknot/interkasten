import type { NotionClient } from "./notion-client.js";

/** Maximum pages to fetch per poll cycle (safety valve against infinite pagination) */
const MAX_PAGES = 20;

export interface PageChange {
  pageId: string;
  lastEdited: string;
  title: string;
}

export class NotionPoller {
  private notion: NotionClient;

  constructor(notion: NotionClient) {
    this.notion = notion;
  }

  /**
   * Poll a Notion database for pages updated after `since`.
   * Uses last_edited_time filter for fast-path, paginated with safety limit.
   */
  async pollDatabase(databaseId: string, since: Date): Promise<PageChange[]> {
    const changes: PageChange[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const response: any = await this.notion.call(async () => {
        return this.notion.raw.databases.query({
          database_id: databaseId,
          filter: {
            timestamp: "last_edited_time",
            last_edited_time: { after: since.toISOString() },
          },
          start_cursor: cursor,
          page_size: 100,
        });
      });

      for (const page of response.results) {
        changes.push({
          pageId: page.id,
          lastEdited: page.last_edited_time,
          title: this.extractTitle(page),
        });
      }

      cursor = response.has_more ? response.next_cursor : undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    return changes;
  }

  private extractTitle(page: any): string {
    const props = page.properties || {};
    const nameCol = props.Name || props.name || props.Title || props.title;
    if (nameCol?.title?.[0]?.plain_text) {
      return nameCol.title[0].plain_text;
    }
    return "Untitled";
  }
}
