# Watch Phase — Drift Baseline Setup

## Purpose

After generating or confirming docs exist, establish interwatch baseline confidence scores. This creates the reference point for future drift detection.

## Steps

For each Product and Tool project (skip Inactive):

1. Invoke `interwatch:doc-watch` with the project path
2. This scans all existing docs and computes:
   - Content hash baselines
   - Confidence scores (how well docs match current code)
   - Staleness indicators

## Baseline Expectations

- **Freshly generated docs**: Should score 90%+ confidence (they were just created from current code)
- **Pre-existing docs**: May score lower if code has drifted since last doc update
- **Missing docs**: Skipped (nothing to baseline)

## Error Handling

- If interwatch skill is not available (plugin not installed), skip this phase entirely
- Log which projects got baselines and which were skipped
- Report any projects with pre-existing docs scoring below 50% — these may need manual review

## Output

For each project, record:
- Number of docs baselined
- Average confidence score
- Any docs flagged as stale (below 50%)
