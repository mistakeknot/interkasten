"""Tests for agent structure."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent.parent
AGENTS_DIR = ROOT / "agents"


def test_agent_count():
    """Total agent count matches expected value."""
    agent_files = []
    if AGENTS_DIR.is_dir():
        for subdir in AGENTS_DIR.iterdir():
            if subdir.is_dir():
                agent_files.extend(sorted(subdir.glob("*.md")))
            elif subdir.suffix == ".md" and subdir.name != "README.md":
                agent_files.append(subdir)
    # Also check .claude/agents/ for Claude subagents
    claude_agents = ROOT / ".claude" / "agents"
    if claude_agents.is_dir():
        agent_files.extend(sorted(claude_agents.glob("*.md")))
    # Compare repository-relative paths so a same-named file in another
    # scanned directory is still seen as an addition.
    expected = {
        f"agents/{name}" for name in (
            "architecture.md", "database.md", "design-patterns.md", "mcp-tools.md",
            "skills-hooks.md", "sync-engine.md", "testing-config.md",
        )
    }
    found = {f.relative_to(ROOT).as_posix() for f in agent_files}
    assert found == expected, (
        f"Agent files changed. missing: {sorted(expected - found)}, "
        f"unexpected: {sorted(found - expected)}"
    )
