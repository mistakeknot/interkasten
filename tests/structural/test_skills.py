"""Tests for skill structure."""

from pathlib import Path

import pytest

from helpers import parse_frontmatter


SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / "skills"
SKILL_DIRS = sorted(
    d for d in SKILLS_DIR.iterdir()
    if d.is_dir() and (d / "SKILL.md").exists()
) if SKILLS_DIR.is_dir() else []


def test_skill_count(skills_dir):
    """Total skill count matches expected value."""
    expected = {"doctor", "layout", "onboard", "webhook-setup"}
    assert skills_dir.is_dir(), "skills/ directory is missing"
    found = {
        d.name for d in skills_dir.iterdir()
        if d.is_dir() and (d / "SKILL.md").exists()
    }
    assert found == expected, (
        f"Skills changed. missing: {sorted(expected - found)}, "
        f"unexpected: {sorted(found - expected)}"
    )


@pytest.mark.parametrize("skill_dir", SKILL_DIRS, ids=lambda p: p.name)
def test_skill_has_frontmatter(skill_dir):
    """Each SKILL.md has valid YAML frontmatter with 'name' and 'description'."""
    fm, _ = parse_frontmatter(skill_dir / "SKILL.md")
    assert fm is not None, f"{skill_dir.name}/SKILL.md has no frontmatter"
    assert "description" in fm, f"{skill_dir.name}/SKILL.md frontmatter missing 'description'"
