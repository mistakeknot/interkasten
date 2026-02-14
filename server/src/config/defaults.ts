import { type Config, ConfigSchema } from "./schema.js";

/**
 * Generate a complete config with all defaults filled in.
 * Passing an empty object produces a valid config with every field set.
 */
export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}

/**
 * Default YAML config template written during init.
 */
export const DEFAULT_CONFIG_YAML = `# Interkasten configuration
# See docs/PRD-MVP.md §11 for full reference

# Project discovery
projects_dir: "~/projects"
project_detection:
  markers: [".git", ".beads"]
  exclude: ["node_modules", ".cache", "vendor"]
  max_depth: 2

# Notion connection (token from $INTERKASTEN_NOTION_TOKEN env var)
notion:
  workspace_id: null
  databases:
    projects: null
    research_inbox: null
    pagent_workflows: null

# Sync engine
sync:
  poll_interval: 60
  batch_size: 10
  max_queue_size: 1000
  conflict_strategy: "three-way-merge"
  backoff:
    initial_delay_ms: 1000
    max_delay_ms: 32000
    circuit_breaker_threshold: 10
    circuit_breaker_check_interval: 60
  tunnel:
    enabled: false
    provider: "cloudflared"

# Filesystem watcher
watcher:
  debounce_ms: 500
  ignore_patterns: ["*.swp", "*.tmp", ".git/objects/**", "node_modules/**"]

# Document generation
docs:
  default_tier: "T2"
  auto_promote_threshold: 3
  models:
    prd_writer: "opus"
    doc_writer: "opus"
    roadmap_builder: "sonnet"
    changelog_writer: "sonnet"
    research_classifier: "haiku"
    doc_refresher: "haiku"
    content_fetcher: "haiku"

# Pagent engine
pagent:
  max_concurrent_workflows: 5
  max_dag_depth: 10
  max_fan_out: 20
  default_timeout_per_node: 120
  default_timeout_per_workflow: 600
  default_error_policy: "stop"
`;
