# /next — Capture all remaining work and approve in safe tranches

Run after a merge, audit, or completed investigation. Capture everything tabled, rank it,
separate agent work from founder-only actions, and present a complete plan. Never invent
work and never drop a finding because implementation is large or tedious.

## 1. Capture read-only

Tag every item by origin:

- `◆ this-session` — surfaced or deferred in this conversation/change;
- `◇ carried-over` — existing backlog, tracker, PR, memory, or roadmap.

Inspect, where available:

- the just-completed diff, PR, proof block, NOT-verified items, and deferred follow-ups;
- this session's explicit "later", out-of-scope, risks, and decisions;
- open issues and PRs;
- the latest `/disposition` table;
- durable project memory and current roadmap/next-step docs;
- TODO/FIXME/HACK markers in the touched area.

Do not confuse `/dispose` cleanup with `/disposition` audit findings.

## 2. Rank

For each item assess origin, customer leverage, urgency/blocking, dependency order, risk,
reversibility, real recurring cost, and user-perceptible performance impact. At equal
leverage, rank `◆ this-session` above `◇ carried-over`, and offense above defense unless
production, security, data integrity, or CI is on fire.

Engineering effort alone is not a reason to omit or defer worthwhile work. Size still
matters for sequencing and reviewability, not product value.

## 3. Assign ownership

- **Agent — code:** implementation, tests, docs, PR, CI.
- **Agent — computer use:** reachable dashboard/settings work. Keep it in a tranche until
  an actual login, passkey, 2FA, secret, billing, or account-owner wall appears.
- **Founder-only:** real-world/legal decisions, unavailable credentials, billing/plan
  authority, OAuth consent, DNS ownership, passkey/2FA, or a material product decision.

## 4. Form tranches

Group by dependency, risk, rollback, and file overlap:

- Batch independent low-risk reversible work when one PR remains coherent.
- Gate a tranche only if it contains a product decision (the user-visible test in
  `~/.claude/CLAUDE.md` §1) or a hard stop (real-money spend, destroying or irreversibly
  changing production data with no restore path, a platform-forced approval). Isolate
  each gated item.
- Technical-only risk-area items (auth/permissions, data model/migrations, billing/spend
  code, hub nodes, share-link auth) go in normal tranches, marked as getting the
  independent risk-area review before merge.
- Sequence dependencies. Mark truly independent, disjoint tranches as parallel-safe.
- Never run concurrent tranches against the same checkout, branch, or overlapping files.

## 5. Present the complete plan

```markdown
## Next — after <completed work> (<date>)
◆ = this session · ◇ = carried over

▶ **Tranche 1 — <name>** [LOW RISK · S|M|L] → <delivery unit>
- ◆ <item> — <origin/status> [+ INDEPENDENT REVIEW if a risk area]

⚠ **Tranche 2 — <name>** [PRODUCT DECISION | NEEDS YOUR GO · isolated]
- ◇ <item> — <plain-language question: what the user experiences under A vs B, or what
  will happen; Recommended: ...>

⇉ **Parallel:** <independent tranches or none>

**Founder-only**
- ◆|◇ <item> — <exact authority/action required>

**Not yet durable**
- <items that need tracker/memory capture>

→ One `approve` authorizes all ▶ tranches in the stated sequence. Each ⚠ tranche
still stops for its product answer or "go".
```

Every captured item must land in a tranche, Founder-only, Not-yet-durable, or an explicit
rejected/deferred record with reason.

## 6. On approval

One approval authorizes every ▶ tranche: execute each end to end using the normal
build → `/proof` → git/CI/deploy → production proof → `/dispose` lifecycle, making and
logging technical decisions (independent review in risk areas). ⚠ tranches still require
their plain-language product answer or hard-stop "go". After the approved batch drains,
rerun `/next` to present—not auto-start—the newly remaining work.

Run the approved ▶ tranches in this session, in sequence, while it is under ~400k of
context; each one finishes its own tail (`/ship` Phase 7). Past ~400k, hand the remaining
tranches to a continuation session (`/ship` cost controls). Its packet is a standalone
brief: the tranches' items and origins, accepted decisions, exact paths and issue/PR
numbers, required gates, and the line that the user approved these tranches. One build
session runs at a time; run tranches in parallel only when they are marked parallel-safe
and the user asks for parallel. A ⚠ tranche runs after its answer or "go".

Under `/ship` this command is not invoked: its Phase 7 applies the capture and tranche
rules here, builds the shipment's own follow-ups without presenting, and offers the
older backlog as chips. Typed by hand, `/next` presents and waits.

If nothing remains, say so plainly and show which sources were checked.
