import { z } from "zod";

// Project detection configuration
export const ProjectDetectionSchema = z.object({
  markers: z.array(z.string()).default([".git", ".beads"]),
  exclude: z.array(z.string()).default(["node_modules", ".cache", "vendor"]),
  max_depth: z.number().int().min(1).max(10).default(2),
});

// Notion connection configuration
export const NotionDatabasesSchema = z.object({
  projects: z.string().nullable().default(null),
  research_inbox: z.string().nullable().default(null),
  pagent_workflows: z.string().nullable().default(null),
});

export const NotionSchema = z.object({
  workspace_id: z.string().nullable().default(null),
  databases: NotionDatabasesSchema.default({}),
});

// Backoff configuration
export const BackoffSchema = z.object({
  initial_delay_ms: z.number().int().min(100).default(1000),
  max_delay_ms: z.number().int().min(1000).default(32000),
  circuit_breaker_threshold: z.number().int().min(1).default(10),
  circuit_breaker_check_interval: z.number().int().min(10).default(60),
});

// Sync engine configuration
export const SyncSchema = z.object({
  poll_interval: z.number().int().min(10).default(60),
  batch_size: z.number().int().min(1).default(10),
  max_queue_size: z.number().int().min(10).default(1000),
  conflict_strategy: z
    .enum(["three-way-merge", "local-wins", "notion-wins", "conflict-file", "ask"])
    .default("three-way-merge"),
  backoff: BackoffSchema.default({}),
  tunnel: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.string().default("cloudflared"),
    })
    .default({}),
});

// Watcher configuration
export const WatcherSchema = z.object({
  debounce_ms: z.number().int().min(100).default(500),
  ignore_patterns: z
    .array(z.string())
    .default(["*.swp", "*.tmp", ".git/objects/**", "node_modules/**"]),
});

// Document generation model assignments
export const DocModelsSchema = z.object({
  prd_writer: z.string().default("opus"),
  doc_writer: z.string().default("opus"),
  roadmap_builder: z.string().default("sonnet"),
  changelog_writer: z.string().default("sonnet"),
  research_classifier: z.string().default("haiku"),
  doc_refresher: z.string().default("haiku"),
  content_fetcher: z.string().default("haiku"),
});

export const DocsSchema = z.object({
  default_tier: z.enum(["T1", "T2"]).default("T2"),
  auto_promote_threshold: z.number().int().min(1).default(3),
  models: DocModelsSchema.default({}),
});

// Milestone threshold schema
const ThresholdSchema = z.record(z.string(), z.number());

const MilestoneSchema = z.union([
  z.object({ trigger: z.string() }),
  z.object({
    threshold: ThresholdSchema,
    mode: z.enum(["all", "any"]).default("all"),
  }),
]);

// Milestone definitions
export const MilestonesSchema = z.record(z.string(), MilestoneSchema).default({
  skeleton_prd: { trigger: "project_detected" },
  full_prd: { threshold: { commits: 5 } },
  issues_db: { trigger: "first_beads_issue" },
  roadmap: { threshold: { commits: 10, beads_closed: 5 }, mode: "any" as const },
  architecture: { trigger: "dependency_file_detected" },
  adr_suggest: { threshold: { file_churn_ratio: 0.4 } },
  changelog: { trigger: "git_tag_detected" },
  full_suite: { threshold: { commits: 50, beads_closed: 20 }, mode: "any" as const },
});

// Schedule configuration
const ScheduleEntrySchema = z.object({
  cron: z.string(),
  scope: z.string(),
});

export const SchedulesSchema = z
  .record(z.string(), ScheduleEntrySchema)
  .default({
    staleness_check: { cron: "0 9 * * *", scope: "all_projects" },
    full_refresh: { cron: "0 9 * * 1", scope: "stale_docs_only" },
  });

// Pagent engine configuration
export const PagentSchema = z.object({
  max_concurrent_workflows: z.number().int().min(1).default(5),
  max_dag_depth: z.number().int().min(1).default(10),
  max_fan_out: z.number().int().min(1).default(20),
  default_timeout_per_node: z.number().int().min(10).default(120),
  default_timeout_per_workflow: z.number().int().min(60).default(600),
  default_error_policy: z.enum(["stop", "retry", "skip", "fallback"]).default("stop"),
});

// Beads integration configuration
export const BeadsSchema = z.object({
  track_operations: z.boolean().default(true),
  auto_close: z.boolean().default(true),
  priority: z.number().int().min(0).max(4).default(4),
});

// Root configuration schema
export const ConfigSchema = z.object({
  projects_dir: z.string().default("~/projects"),
  project_detection: ProjectDetectionSchema.default({}),
  notion: NotionSchema.default({}),
  sync: SyncSchema.default({}),
  watcher: WatcherSchema.default({}),
  docs: DocsSchema.default({}),
  milestones: MilestonesSchema,
  schedules: SchedulesSchema,
  pagent: PagentSchema.default({}),
  beads: BeadsSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type NotionConfig = z.infer<typeof NotionSchema>;
export type SyncConfig = z.infer<typeof SyncSchema>;
export type WatcherConfig = z.infer<typeof WatcherSchema>;
export type PagentConfig = z.infer<typeof PagentSchema>;
