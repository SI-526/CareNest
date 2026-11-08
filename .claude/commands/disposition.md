# /disposition — Turn every finding into a durable decision

Use at the end of an audit, review, security sweep, exploration, or analysis, and as a
mid-session checkpoint before pivoting. This command classifies findings; `/dispose`
performs task-owned cleanup.

## Instructions

1. Collect every distinct finding, observation, risk, inconsistency, and open question
   surfaced in the session, including proactive discoveries.
2. Deduplicate only truly identical findings. Do not hide separate causes or impacts in
   one vague row.
3. Validate the evidence and affected scope before assigning severity.
4. Give every row exactly one disposition:
   - `do-now` — real, valuable, unblocked, and appropriate for the current/next batch;
   - `ticket-later` — real and worth preserving, but blocked by dependency, real spend,
     user-visible performance tradeoff, or a deliberate product priority;
   - `reject` — not real, already handled, duplicate, or cost exceeds value; record why;
   - `needs-human-review` — requires external authority or a material one-way-door choice.
5. Assign `P0` only to active production/security/data-loss incidents, `P1` to material
   correctness or user-impacting regressions, and `P2` to worthwhile non-urgent work.
6. File or update tracker items when project policy authorizes it; otherwise provide
   paste-ready titles and exact evidence.

## Output

```markdown
## Disposition — <topic> (<date>)

| # | Finding | Evidence | Disposition | Priority | Next action | Owner |
|---|---|---|---|---|---|---|
| 1 | <specific finding> | <path/link/observation> | do-now | P0 | <imperative> | agent |
| 2 | <specific finding> | <evidence> | ticket-later | P1 | <issue/dependency> | agent |
| 3 | <specific finding> | <evidence> | reject | — | N/A — <why> | — |
| 4 | <specific finding> | <evidence> | needs-human-review | P1 | <exact decision> | user |

### Do now
- [ ] <P0→P2 actions in dependency order>

### Tickets filed or ready to file
- `<issue title>` — <link or evidence>

### Rejected (recorded so it does not resurface)
- Finding #N — <reason>

### STOP — user decision required
- Finding #N — <question, options, recommendation>
```

Nothing remains only in prose: every finding appears in the table and one terminal
section. Feed unresolved rows into `/next`.
