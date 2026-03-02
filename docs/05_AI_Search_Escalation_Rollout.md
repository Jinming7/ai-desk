# AI Search Escalation Rollout Plan

## Feature Flags
- `FEATURE_KB_GROUNDED_SEARCH`
- `FEATURE_QUICK_TICKET`
- `FEATURE_DEEP_RETRIEVAL`

## Staged Rollout
1. Stage A: Enable `FEATURE_KB_GROUNDED_SEARCH` for 10% traffic and verify retrieval quality.
2. Stage B: Enable `FEATURE_QUICK_TICKET` for unresolved responses and monitor escalation creation errors.
3. Stage C: Enable `FEATURE_DEEP_RETRIEVAL` and monitor resolved-by-AI vs ticket-created ratios.
4. Stage D: Ramp to 100% after 24h of stable metrics.

## Operational Metrics (24h)
- KB hit rate
- Citation coverage
- Fallback rate
- Escalation volume
- Auto-resolve rate
- Ticket creation rate

## Alert Thresholds
- Fallback rate > 40% for 30 min.
- Escalation creation failure rate > 5% for 15 min.
- Auto-resolve rate drops below 20% for 60 min.
- Deep retrieval timeout ratio > 10% for 30 min.

## Brand Consistency Check (Frontend)
- Uses design tokens from `03_Frontend_Design_Standards_Figma.md`.
- Keeps ONES + `|` + product logo structure via `BrandLogoUsage`.
- Keeps light gradient background and Plus Jakarta Sans typography.
