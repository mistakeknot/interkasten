import { watch, type FSWatcher } from "chokidar";
import { relative, extname } from "path";
import { EventEmitter } from "events";

export interface FileChangeEvent {
  type: "add" | "change" | "unlink";
  path: string;
  timestamp: Date;
}

export interface WatcherOptions {
  projectsDir: string;
  debounceMs?: number;
  ignorePatterns?: string[];
}

/**
 * Filesystem watcher for the projects directory.
 * Watches for .md file changes, debounces rapid events,
 * and emits normalized change events.
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly projectsDir: string;
  private readonly ignorePatterns: string[];

  constructor(options: WatcherOptions) {
    super();
    this.projectsDir = options.projectsDir;
    this.debounceMs = options.debounceMs ?? 2000;
    this.ignorePatterns = options.ignorePatterns ?? [
      "*.swp",
      "*.tmp",
      ".git/**",
      "node_modules/**",
      ".mutagen/**",
      ".mutagen-*",
      "**/.claude/**",
      "**/.codex/**",
      "**/target/**",
      "**/.venv/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
    ];
  }

  /**
   * Start watching the projects directory.
   */
  start(): void {
    this.watcher = watch(this.projectsDir, {
      ignored: this.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      depth: 3,
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 500,
      },
    });

    this.watcher.on("add", (path) => this.handleEvent("add", path));
    this.watcher.on("change", (path) => this.handleEvent("change", path));
    this.watcher.on("unlink", (path) => this.handleEvent("unlink", path));
    this.watcher.on("error", (err) => this.emit("error", err));
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private handleEvent(type: "add" | "change" | "unlink", path: string): void {
    // Only watch markdown files
    if (extname(path) !== ".md") return;

    // Debounce: reset timer for this path
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);

      const event: FileChangeEvent = {
        type,
        path,
        timestamp: new Date(),
      };
      this.emit("file-change", event);
    }, this.debounceMs);

    this.debounceTimers.set(path, timer);
  }
}
