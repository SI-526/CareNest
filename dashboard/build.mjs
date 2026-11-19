// Builds the CareNest test dashboard: a static site with the latest run on main, the Linear
// stories and which of their acceptance criteria the tests check, branches in progress, merged
// branches and the history of main.
//
// The site directory holds the published files and their state (data/state.json). CI checks
// out the gh-pages branch into it, runs this, and pushes it back.
//
//   # record a test run (CI does this after every push)
//   node dashboard/build.mjs --site site --results results.json --sha <sha> --branch <name> \
//        --message "<commit subject>" [--run-url <url>] [--duration <seconds>] [--pr pr.json]
//   # rebuild the page only (fresh Linear data, no new run)
//   node dashboard/build.mjs --site site
//   # a branch was deleted: drop it from "Branches in progress"
//   node dashboard/build.mjs --site site --delete-branch <name>
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadIssues, storiesFrom } from "./linear.mjs";

const MAIN = "main";
const KEEP_MAIN_REPORTS = 30;
const TIME_ZONE = "America/Detroit";
const REPO_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
  : "https://github.com/SI-526/CareNest";

const { values: args } = parseArgs({
  options: {
    site: { type: "string", default: "site" },
    results: { type: "string" },
    sha: { type: "string" },
    branch: { type: "string" },
    message: { type: "string", default: "" },
    "run-url": { type: "string", default: "" },
    "run-id": { type: "string" },
    duration: { type: "string" },
    pr: { type: "string" },
    "delete-branch": { type: "string" },
    now: { type: "string" },
  },
});

let site, now, state, latestMain, linear, acceptance;

// ---------------------------------------------------------------------------------------------

function countTests(tests) {
  const c = { passed: 0, failed: 0, skipped: 0, total: tests.length };
  for (const t of tests) c[t.status] = (c[t.status] ?? 0) + 1;
  return c;
}

const norm = (s) => s.toLowerCase().replace(/[“”"'’]/g, "").replace(/\s+/g, " ").trim();

function evaluate(stories, map, tests) {
  const byKey = new Map(tests.map((t) => [`${t.file} > ${t.name}`, t]));
  // Tests that name a criterion themselves: "SI-70 AC4: ..."
  const tagged = new Map();
  for (const t of tests) {
    for (const m of t.name.matchAll(/\b(SI-\d+)\s+AC(\d+)\b/g)) {
      const key = `${m[1]}#${m[2]}`;
      tagged.set(key, [...(tagged.get(key) ?? []), `${t.file} > ${t.name}`]);
    }
  }
  // Before the first run on main there are no results, so linked criteria wait instead of failing.
  const haveRun = tests.length > 0;
  const counts = { passing: 0, failing: 0, waiting: 0, none: 0, manual: 0, stale: 0, total: 0 };
  const result = stories.map((story) => {
    const criteria = story.criteria.map((c) => {
      const link = map[story.id]?.[String(c.n)] ?? {};
      const names = [...new Set([...(link.tests ?? []), ...(tagged.get(`${story.id}#${c.n}`) ?? [])])];
      let state = "none";
      let staleNote = null;
      if (link.match && !norm(c.text + " " + c.details.join(" ")).includes(norm(link.match))) {
        state = "stale";
        staleNote = `This criterion changed in Linear since its tests were linked (expected it to mention "${link.match}"). Update dashboard/acceptance-map.json.`;
      }
      const linked = names.map((name) => ({ name, test: byKey.get(name) ?? null }));
      if (state !== "stale") {
        if (linked.length && !haveRun) {
          state = "waiting";
        } else if (linked.length) {
          const statuses = linked.map((l) => l.test?.status ?? "missing");
          if (statuses.some((s) => s === "failed" || s === "missing")) state = "failing";
          else if (statuses.every((s) => s === "skipped")) state = "none";
          else state = "passing";
        } else if (link.manual) {
          state = "manual";
        }
      }
      counts[state]++;
      counts.total++;
      return { ...c, state, linked, manual: link.manual ?? null, note: staleNote ?? link.note ?? null };
    });
    const tested = criteria.filter((c) => ["passing", "failing", "waiting"].includes(c.state)).length;
    const waiting = criteria.some((c) => c.state === "waiting");
    const failing = criteria.filter((c) => c.state === "failing" || c.state === "stale").length;
    return { ...story, criteria, tested, failing, waiting };
  });
  return { stories: result, counts };
}

// ---------------------------------------------------------------------------------------------
// HTML.

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const shortDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" });
const when = (iso) => (iso ? dateFmt.format(new Date(iso)) : "");
const short = (sha) => String(sha ?? "").slice(0, 7);
const commitLink = (sha) => `<a href="${REPO_URL}/commit/${esc(sha)}"><code>${esc(short(sha))}</code></a>`;

function resultWord(c) {
  return c.failed ? "Failed" : "Passed";
}
function countsText(c) {
  const ran = c.total - c.skipped;
  let s = c.failed ? `${c.failed} of ${ran} failed` : `${c.passed} of ${c.total} passed`;
  if (c.skipped) s += `, ${c.skipped} skipped`;
  return s;
}
function resultChip(c) {
  const failed = c.failed > 0;
  return `<span class="chip ${failed ? "chip-failed" : "chip-passed"}">${resultWord(c)}</span>`;
}

const STYLE = `
:root {
  color-scheme: light;
  --page: #f6f6f6; --panel: #ffffff; --band: #fafcff; --well: #f3f4fa;
  --ink: #00324e; --ink-2: #3d4f5c; --ink-3: #5f6b74;
  --rule: #dfe0e9; --rule-strong: #cfd4ea;
  --passed: #397456; --passed-soft: #e7f4eb;
  --failed: #bd0000; --failed-soft: #fff0f1;
  --none: #666666; --none-soft: #eceef5;
  --manual: #6267b5; --manual-soft: #eef0ff;
  --stale: #885c0a; --stale-soft: #fff4df;
  --skipped: #a4abb8; --accent: #6267b5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0f1a21; --panel: #15232c; --band: #1a2a34; --well: #12202a;
    --ink: #e6eef3; --ink-2: #b9c7d0; --ink-3: #93a3ae;
    --rule: #263844; --rule-strong: #35495a;
    --passed: #7fcf9f; --passed-soft: #173528;
    --failed: #ff8f8f; --failed-soft: #3d1b1e;
    --none: #a9b3bb; --none-soft: #1f2f3a;
    --manual: #aab0ff; --manual-soft: #262b4d;
    --stale: #f0c46a; --stale-soft: #3a2e13;
    --skipped: #5d6d78; --accent: #aab0ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.55 "DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; -webkit-text-size-adjust: 100%; }
.page { max-width: 68rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
@media (min-width: 720px) { .page { padding: 2.5rem 2rem 5rem; } }
h1, h2, h3 { font-family: Poppins, "DM Sans", system-ui, sans-serif; line-height: 1.25; }
a { color: inherit; text-decoration-color: var(--rule-strong); text-underline-offset: 0.18em; }
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88em; }
.masthead { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.25rem 1.5rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--rule); }
.masthead h1 { margin: 0; font-size: 1.05rem; font-weight: 600; }
.masthead p { margin: 0; color: var(--ink-3); font-size: 0.9rem; }
section { margin-top: 3.5rem; }
h2 { margin: 0 0 0.35rem; font-size: 1.3rem; font-weight: 600; }
.lede { margin: 0 0 1.25rem; color: var(--ink-2); max-width: 46rem; }
.headline { margin-top: 2rem; }
.headline h2 { font-size: clamp(1.7rem, 4vw, 2.3rem); margin-bottom: 0.4rem; }
.headline .big { margin: 0 0 0.5rem; font-size: 1.1rem; }
.headline .meta { margin: 0 0 1rem; color: var(--ink-3); }
.status-dot { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 50%; margin-right: 0.4em; vertical-align: 0.05em; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
.panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 12px; }
.chart { padding: 1rem 1rem 0.5rem; }
.chart svg { display: block; width: 100%; height: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0 0 0.75rem; padding: 0; list-style: none; font-size: 0.9rem; color: var(--ink-2); }
.swatch { display: inline-block; width: 0.8rem; height: 0.8rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: -0.08em; }
.chip { display: inline-block; padding: 0.05rem 0.55rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
.chip-passed, .chip-passing { background: var(--passed-soft); color: var(--passed); }
.chip-failed, .chip-failing { background: var(--failed-soft); color: var(--failed); }
.chip-none, .chip-skipped, .chip-waiting { background: var(--none-soft); color: var(--none); }
.chip-manual { background: var(--manual-soft); color: var(--manual); }
.chip-stale, .chip-missing { background: var(--stale-soft); color: var(--stale); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th { text-align: left; font-weight: 600; color: var(--ink-3); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
th, td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { white-space: nowrap; }
.muted { color: var(--ink-3); }
.small { font-size: 0.88rem; }
.empty { padding: 1rem 1.25rem; color: var(--ink-2); margin: 0; }
.summary-line { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 0 0 1.25rem; }
.summary-line strong { margin-right: 0.5rem; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1rem; }
.toolbar button { font: inherit; font-size: 0.9rem; padding: 0.3rem 0.85rem; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--panel); color: var(--ink); cursor: pointer; }
.toolbar button[aria-pressed="true"] { background: var(--ink); color: var(--panel); border-color: var(--ink); }
.epic { margin-bottom: 1.25rem; overflow: hidden; }
.epic-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.25rem 1rem; padding: 0.75rem 1rem; background: var(--band); border-bottom: 1px solid var(--rule); }
.epic-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
.epic-head p { margin: 0; color: var(--ink-3); font-size: 0.9rem; }
details.story { border-bottom: 1px solid var(--rule); }
details.story:last-child { border-bottom: 0; }
details.story > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: auto 1fr auto; gap: 0.25rem 0.75rem; align-items: baseline; padding: 0.75rem 1rem; }
details.story > summary::-webkit-details-marker { display: none; }
details.story > summary::before { content: "›"; display: inline-block; width: 0.8rem; color: var(--ink-3); transition: transform 0.15s; }
details.story[open] > summary::before { transform: rotate(90deg); }
.story-title { display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; align-items: baseline; }
.story-title .id { font-weight: 600; white-space: nowrap; }
.story-meta { grid-column: 2 / 4; color: var(--ink-3); font-size: 0.85rem; }
.story-badges { display: flex; flex-wrap: wrap; gap: 0.35rem; justify-content: flex-end; }
@media (max-width: 640px) { details.story > summary { grid-template-columns: auto 1fr; } .story-badges { grid-column: 2; justify-content: flex-start; } .story-meta { grid-column: 2; } }
ol.criteria { list-style: none; margin: 0; padding: 0 1rem 1rem 2.6rem; }
@media (max-width: 640px) { ol.criteria { padding-left: 1rem; } }
ol.criteria > li { display: grid; grid-template-columns: 2.6rem 1fr auto; gap: 0.15rem 0.6rem; padding: 0.7rem 0.85rem; background: var(--well); border-radius: 8px; margin-top: 0.4rem; }
ol.criteria > li > .chip { align-self: start; justify-self: end; }
.ac-n { font-weight: 600; color: var(--ink-3); }
.ac-body p { margin: 0; }
.ac-body ul { margin: 0.25rem 0 0; padding-left: 1.1rem; color: var(--ink-2); font-size: 0.92rem; }
.ac-note { margin-top: 0.4rem !important; font-size: 0.88rem; color: var(--ink-2); font-style: italic; }
.ac-tests { margin: 0.45rem 0 0; padding: 0; list-style: none; font-size: 0.85rem; color: var(--ink-2); }
.ac-tests li { display: flex; gap: 0.5rem; align-items: baseline; padding-top: 0.15rem; }
.ac-tests .file { color: var(--ink-3); white-space: nowrap; }
.tick { flex: none; width: 0.55rem; height: 0.55rem; border-radius: 50%; display: inline-block; transform: translateY(-0.05rem); }
.tick-passed { background: var(--passed); } .tick-failed, .tick-missing { background: var(--failed); } .tick-skipped, .tick-pending { background: var(--skipped); }
@media (max-width: 640px) { ol.criteria > li { grid-template-columns: 2.2rem 1fr; } ol.criteria > li > .chip { grid-column: 2; justify-self: start; } }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 0.88rem; }
.report-file { margin-top: 2rem; }
.report-file h2 { font-size: 1.05rem; }
.err { white-space: pre-wrap; margin: 0.4rem 0 0; padding: 0.6rem 0.75rem; background: var(--failed-soft); color: var(--ink); border-radius: 6px; font: 0.82rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; }
`;

function shell(title, description, body, extraHead = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='9' fill='%236267b5'/%3E%3Cpath d='M5.6 10.4l3 3 5.8-6.6' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600&family=Poppins:wght@500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
${extraHead}
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>
`;
}

function chartSvg(runs) {
  const shown = runs.slice(-KEEP_MAIN_REPORTS);
  if (!shown.length) return "";
  const W = 960, H = 260, left = 44, right = 8, top = 10, bottom = 34;
  const max = Math.max(...shown.map((r) => r.counts.total), 1);
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const y = (v) => top + (H - top - bottom) * (1 - v / yMax);
  const slot = (W - left - right) / shown.length;
  const bw = Math.max(4, Math.min(36, slot * 0.6));
  let grid = "";
  for (let v = 0; v <= yMax; v += step) {
    grid += `<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--rule)" stroke-width="1"/>`;
    grid += `<text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="var(--ink-3)">${v}</text>`;
  }
  const bars = shown.map((r, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const c = r.counts;
    let base = 0;
    const seg = (n, color) => {
      if (!n) return "";
      const y0 = y(base), y1 = y(base + n);
      base += n;
      return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y0 - y1).toFixed(1)}" fill="${color}"/>`;
    };
    const label = `${when(r.testedAt)}: ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped. ${short(r.sha)} ${r.message}`;
    const inner = `<title>${esc(label)}</title>${seg(c.passed, "var(--passed)")}${seg(c.failed, "var(--failed)")}${seg(c.skipped, "var(--skipped)")}`;
    return r.report ? `<a href="${esc(r.report)}" aria-label="${esc(label)}">${inner}</a>` : `<g>${inner}</g>`;
  }).join("");
  const first = shown[0], last = shown.at(-1);
  const axis = `<text x="${left}" y="${H - 10}" font-size="12" fill="var(--ink-3)">${esc(shortDateFmt.format(new Date(first.testedAt)))}</text>`
    + (shown.length > 1 ? `<text x="${W - right}" y="${H - 10}" text-anchor="end" font-size="12" fill="var(--ink-3)">${esc(shortDateFmt.format(new Date(last.testedAt)))}</text>` : "");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tests on main, run by run">${grid}${bars}${axis}</svg>`;
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
}

const STATE_LABEL = { waiting: "Waiting for a run on main", passing: "Passing", failing: "Failing", none: "No test yet", manual: "Checked by hand", stale: "Link out of date" };

function storySection() {
  const { stories, counts } = acceptance;
  const source = linear.source === "live"
    ? `live from Linear, ${when(linear.fetchedAt)}`
    : `from the Linear snapshot of ${when(linear.fetchedAt)} (CI has no Linear key yet)`;
  const runNote = latestMain
    ? `checked against the latest run on main, ${when(latestMain.run.testedAt)}`
    : "no run on main yet, so no criterion has a result";
  const groups = new Map();
  for (const s of stories) {
    const key = s.project ?? "No project";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  // Sub-issues sit right after their parent story.
  const num = (id) => Number(String(id).split("-")[1]) || 0;
  const ids = new Set(stories.map((s) => s.id));
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const ka = a.parent && ids.has(a.parent) ? num(a.parent) : num(a.id);
      const kb = b.parent && ids.has(b.parent) ? num(b.parent) : num(b.id);
      return ka - kb || (a.parent === b.id) - (b.parent === a.id) || num(a.id) - num(b.id);
    });
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No project") - (b === "No project") || a.localeCompare(b));
  const epics = ordered.map(([project, list]) => {
    const tested = list.reduce((s, x) => s + x.tested, 0);
    const total = list.reduce((s, x) => s + x.criteria.length, 0);
    return `<div class="panel epic">
  <div class="epic-head"><h3>${esc(project)}</h3><p>${list.length} ${list.length === 1 ? "story" : "stories"}, ${tested} of ${total} criteria tested</p></div>
  ${list.map(storyHtml).join("\n")}
</div>`;
  }).join("\n");
  return `<section id="stories" aria-labelledby="stories-h">
  <h2 id="stories-h">Stories</h2>
  <p class="lede">Every Linear issue with acceptance criteria, ${esc(source)}, ${esc(runNote)}. Linear is still where stories are tracked; <code>dashboard/acceptance-map.json</code> links criteria to tests.</p>
  <div class="summary-line">
    <strong>${stories.length} stories, ${counts.total} criteria.</strong>
    ${counts.passing || !counts.waiting ? `<span class="chip chip-passing">${counts.passing} passing</span>` : ""}
    ${counts.failing ? `<span class="chip chip-failing">${counts.failing} failing</span>` : ""}
    ${counts.stale ? `<span class="chip chip-stale">${counts.stale} link out of date</span>` : ""}
    ${counts.waiting ? `<span class="chip chip-waiting">${counts.waiting} with tests, waiting for a run on main</span>` : ""}
    ${counts.manual ? `<span class="chip chip-manual">${counts.manual} checked by hand</span>` : ""}
    <span class="chip chip-none">${counts.none} no test yet</span>
  </div>
  <div class="toolbar" role="group" aria-label="Show stories">
    <button type="button" data-filter="all" aria-pressed="true">All stories</button>
    <button type="button" data-filter="tested" aria-pressed="false">With tests</button>
    <button type="button" data-filter="attention" aria-pressed="false">Needs attention</button>
    <button type="button" data-filter="open" aria-pressed="false">Not done in Linear</button>
  </div>
  ${epics}
</section>`;
}

function storyHtml(s) {
  const open = s.statusType !== "completed" && s.statusType !== "canceled";
  const badge = s.failing
    ? `<span class="chip chip-failing">${s.failing} ${s.failing === 1 ? "criterion needs" : "criteria need"} attention</span>`
    : s.waiting
      ? `<span class="chip chip-waiting">${s.tested} of ${s.criteria.length} have tests</span>`
      : s.tested
      ? `<span class="chip chip-passing">${s.tested} of ${s.criteria.length} tested, all passing</span>`
      : `<span class="chip chip-none">No tests yet</span>`;
  const meta = [s.status, s.assignee, s.parent ? `part of ${s.parent}` : null].filter(Boolean).join(" · ");
  return `<details class="story" data-tested="${s.tested > 0}" data-attention="${s.failing > 0}" data-open="${open}"${s.failing ? " open" : ""}>
  <summary>
    <span class="story-title"><a class="id" href="${esc(s.url)}">${esc(s.id)}</a><span>${esc(s.title.replace(/^User Story:\s*/i, ""))}</span></span>
    <span class="story-badges">${badge}</span>
    <span class="story-meta">${esc(meta)}</span>
  </summary>
  <ol class="criteria">
    ${s.criteria.map((c) => criterionHtml(c)).join("\n    ")}
  </ol>
</details>`;
}

function criterionHtml(c) {
  const details = c.details.length ? `<ul>${c.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "";
  const note = c.note ? `<p class="ac-note">${esc(c.note)}</p>` : "";
  const manual = c.manual ? `<p class="ac-note">${esc(c.manual)}</p>` : "";
  const tests = c.linked.length
    ? `<ul class="ac-tests">${c.linked.map(({ name, test }) => {
      const st = test?.status ?? (c.state === "waiting" ? "pending" : "missing");
      const [file, ...rest] = name.split(" > ");
      const label = st === "missing" ? " (not found in this run)" : "";
      return `<li><span class="tick tick-${st}" aria-hidden="true"></span><span><span class="file">${esc(file.replace(/\.test\.mjs$/, ""))}</span> ${esc(rest.join(" > "))}<span class="muted">${label}</span></span></li>`;
    }).join("")}</ul>`
    : "";
  return `<li><span class="ac-n">AC${c.n}</span><div class="ac-body"><p>${esc(c.text)}</p>${details}${note}${manual}${tests}</div><span class="chip chip-${c.state}">${STATE_LABEL[c.state]}</span></li>`;
}

function indexPage() {
  const mainRuns = state.runs;
  const last = mainRuns.at(-1);
  const headline = last
    ? `<section class="headline" aria-labelledby="status-h">
  <h2 id="status-h"><span class="status-dot" style="background: var(${last.counts.failed ? "--failed" : "--passed"})" aria-hidden="true"></span>Main is ${last.counts.failed ? "failing" : "passing"}.</h2>
  <p class="big">${last.counts.failed
      ? `${last.counts.failed} of ${last.counts.total - last.counts.skipped} tests failed on the latest run.`
      : `All ${last.counts.passed} tests that ran passed on the latest run.`}${last.counts.skipped ? ` ${last.counts.skipped} skipped.` : ""}</p>
  <p class="meta">Commit ${commitLink(last.sha)}, ${esc(last.message)}, tested ${esc(when(last.testedAt))} in ${esc(formatSeconds(last.seconds))}.</p>
  <p class="actions">${last.report ? `<a href="${esc(last.report)}">Open the full report</a>` : ""}${last.runUrl ? `<a href="${esc(last.runUrl)}">See the workflow run</a>` : ""}</p>
</section>`
    : `<section class="headline"><h2>No run on main yet.</h2><p class="big">The first push to main fills this in.</p></section>`;

  const chart = mainRuns.length
    ? `<section aria-labelledby="chart-h">
  <h2 id="chart-h">Tests on main, run by run</h2>
  <p class="lede">Each bar is one run on main, oldest on the left. Select a bar to open its report.</p>
  <div class="panel chart">
    <ul class="legend"><li><span class="swatch" style="background: var(--passed)"></span>Passed</li><li><span class="swatch" style="background: var(--failed)"></span>Failed</li><li><span class="swatch" style="background: var(--skipped)"></span>Skipped</li></ul>
    ${chartSvg(mainRuns)}
  </div>
</section>`
    : "";

  const branchRows = Object.entries(state.branches).sort(([, a], [, b]) => b.testedAt.localeCompare(a.testedAt));
  const branches = `<section aria-labelledby="branches-h">
  <h2 id="branches-h">Branches in progress</h2>
  ${branchRows.length
    ? `<p class="lede">The latest run of each branch that has not merged yet.</p>
  <div class="panel table-wrap"><table>
    <thead><tr><th>Branch</th><th>Latest commit</th><th>Result</th><th>Tests</th><th>Tested</th><th>Report</th></tr></thead>
    <tbody>${branchRows.map(([name, r]) => `<tr><td><a href="${REPO_URL}/tree/${esc(name)}"><code>${esc(name)}</code></a></td><td>${commitLink(r.sha)} <span class="muted">${esc(r.message)}</span></td><td>${resultChip(r.counts)}</td><td class="num">${esc(countsText(r.counts))}</td><td class="num">${esc(when(r.testedAt))}</td><td>${r.report ? `<a href="${esc(r.report)}">Report</a>` : ""}</td></tr>`).join("")}</tbody>
  </table></div>`
    : `<div class="panel"><p class="empty">No branches are being tested right now. A branch shows up here after its first push.</p></div>`}
</section>`;

  const merged = `<section aria-labelledby="merged-h">
  <h2 id="merged-h">Merged branches</h2>
  <p class="lede">Each branch's final run before its pull request merged. These are kept permanently.</p>
  ${state.merged.length
    ? `<div class="panel table-wrap"><table>
    <thead><tr><th>Pull request</th><th>Branch</th><th>Final run</th><th>Tests</th><th>Merged</th><th>Reports</th></tr></thead>
    <tbody>${state.merged.map((m) => `<tr><td><a href="${esc(m.url)}">#${esc(m.pr)}</a> ${esc(m.title)}</td><td><code>${esc(m.branch)}</code></td><td>${m.finalRun ? resultChip(m.finalRun.counts) : '<span class="muted">Not tested</span>'}</td><td class="num">${m.finalRun ? esc(countsText(m.finalRun.counts)) : ""}</td><td class="num">${esc(when(m.mergedAt))}</td><td class="small">${[m.finalRun?.report ? `<a href="${esc(m.finalRun.report)}">Final run</a>` : "", m.mainRun?.report ? `<a href="${esc(m.mainRun.report)}">Main after merge</a>` : ""].filter(Boolean).join(" · ")}</td></tr>`).join("")}</tbody>
  </table></div>`
    : `<div class="panel"><p class="empty">Nothing has merged since the dashboard started.</p></div>`}
</section>`;

  const history = `<section aria-labelledby="history-h">
  <h2 id="history-h">History of main</h2>
  <p class="lede">Every run on main, newest first. Full reports are kept for the newest ${KEEP_MAIN_REPORTS}.</p>
  ${mainRuns.length
    ? `<div class="panel table-wrap"><table>
    <thead><tr><th>Tested</th><th>Commit</th><th>Result</th><th>Tests</th><th>Time</th><th>Report</th></tr></thead>
    <tbody>${[...mainRuns].reverse().map((r) => `<tr><td class="num">${esc(when(r.testedAt))}</td><td>${commitLink(r.sha)} <span class="muted">${esc(r.message)}</span></td><td>${resultChip(r.counts)}</td><td class="num">${esc(countsText(r.counts))}</td><td class="num">${esc(formatSeconds(r.seconds))}</td><td>${r.report ? `<a href="${esc(r.report)}">Open report</a>` : '<span class="muted">Summary only</span>'}</td></tr>`).join("")}</tbody>
  </table></div>`
    : `<div class="panel"><p class="empty">No runs yet.</p></div>`}
</section>`;

  const script = `<script>
(function () {
  var buttons = document.querySelectorAll('[data-filter]');
  function apply(filter) {
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.filter === filter)); });
    document.querySelectorAll('details.story').forEach(function (d) {
      var show = filter === 'all' || d.dataset[filter] === 'true';
      d.hidden = !show;
    });
    document.querySelectorAll('.epic').forEach(function (e) {
      e.hidden = !e.querySelector('details.story:not([hidden])');
    });
  }
  buttons.forEach(function (b) { b.addEventListener('click', function () { apply(b.dataset.filter); }); });
})();
</script>`;

  const body = `<header class="masthead"><h1>CareNest test results</h1><p>Updated ${esc(when(now.toISOString()))}</p></header>
${headline}
${chart}
${storySection()}
${branches}
${merged}
${history}
<footer>The Tests workflow updates this page after every push. Tests run on every branch: the unit tests and the database tests against a local Supabase stack. Stories and acceptance criteria come from Linear.</footer>
${script}`;
  return shell("CareNest test results", "Test results for CareNest: the latest run on main, Linear stories and their acceptance criteria, branches in progress and merged branches.", body);
}

function formatSeconds(s) {
  if (s == null || Number.isNaN(s)) return "";
  if (s < 90) return `${Math.round(s * 10) / 10} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function reportPage(run, tests) {
  const files = new Map();
  for (const t of tests) files.set(t.file, [...(files.get(t.file) ?? []), t]);
  const order = { failed: 0, skipped: 1, passed: 2 };
  const sections = [...files.entries()]
    .sort(([a, x], [b, y]) => (x.some((t) => t.status === "failed") ? 0 : 1) - (y.some((t) => t.status === "failed") ? 0 : 1) || a.localeCompare(b))
    .map(([file, list]) => {
      const c = countTests(list);
      const rows = [...list].sort((a, b) => order[a.status] - order[b.status]).map((t) => `<tr><td><span class="chip chip-${t.status}">${t.status[0].toUpperCase() + t.status.slice(1)}</span></td><td>${esc(t.name)}${t.error ? `<pre class="err">${esc(t.error)}</pre>` : ""}</td><td class="num muted">${t.ms} ms</td></tr>`).join("");
      return `<section class="report-file"><h2><code>${esc(file)}</code> <span class="muted small">${esc(countsText(c))}</span></h2><div class="panel table-wrap"><table><tbody>${rows}</tbody></table></div></section>`;
    }).join("\n");
  const c = run.counts;
  const body = `<header class="masthead"><h1><a href="../index.html">CareNest test results</a> › ${esc(run.branch)}</h1><p>Tested ${esc(when(run.testedAt))}</p></header>
<section class="headline"><h2><span class="status-dot" style="background: var(${c.failed ? "--failed" : "--passed"})" aria-hidden="true"></span>${c.failed ? `${c.failed} failed` : "All passed"}</h2>
<p class="big">${esc(countsText(c))} in ${esc(formatSeconds(run.seconds))}.</p>
<p class="meta">Branch <code>${esc(run.branch)}</code>, commit ${commitLink(run.sha)}, ${esc(run.message)}.</p>
<p class="actions"><a href="../index.html">Back to the dashboard</a>${run.runUrl ? `<a href="${esc(run.runUrl)}">See the workflow run</a>` : ""}</p></section>
${sections}`;
  return shell(`Report ${short(run.sha)}`, `Test report for ${run.branch} at ${short(run.sha)}.`, body);
}

async function main() {
  site = args.site;
  now = args.now ? new Date(args.now) : new Date();
  mkdirSync(join(site, "data"), { recursive: true });
  mkdirSync(join(site, "reports"), { recursive: true });

  const statePath = join(site, "data", "state.json");
  state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { runs: [], branches: {}, merged: [] };

  // ---------------------------------------------------------------------------------------------
  // Record a run.

  if (args.results) {
    const { tests } = JSON.parse(readFileSync(args.results, "utf8"));
    const counts = countTests(tests);
    const branch = args.branch || "local";
    const sha = args.sha || "0000000";
    const id = args["run-id"] || `${now.getTime()}`;
    const run = {
      id,
      sha,
      branch,
      message: args.message.split("\n")[0].slice(0, 200),
      testedAt: now.toISOString(),
      seconds: args.duration ? Number(args.duration) : Math.round(tests.reduce((s, t) => s + t.ms, 0) / 100) / 10,
      counts,
      runUrl: args["run-url"] || null,
      report: `reports/${id}.html`,
    };
    writeFileSync(join(site, run.report), reportPage(run, tests));

    if (branch === MAIN) {
      state.runs = state.runs.filter((r) => r.id !== id);
      state.runs.push(run);
      writeFileSync(join(site, "data", "latest-main.json"), JSON.stringify({ run, tests }) + "\n");
      // A merged pull request: its branch's last run moves to "Merged branches".
      const pr = args.pr && existsSync(args.pr) ? JSON.parse(readFileSync(args.pr, "utf8")) : null;
      if (pr?.number) {
        const head = pr.head?.ref ?? pr.branch;
        const finalRun = state.branches[head] ?? null;
        state.merged = state.merged.filter((m) => m.pr !== pr.number);
        state.merged.unshift({
          pr: pr.number,
          title: pr.title ?? "",
          url: pr.html_url ?? `${REPO_URL}/pull/${pr.number}`,
          branch: head,
          mergedAt: pr.merged_at ?? now.toISOString(),
          finalRun,
          mainRun: { id: run.id, report: run.report },
        });
        delete state.branches[head];
      }
    } else {
      const previous = state.branches[branch];
      state.branches[branch] = run;
      if (previous && previous.report !== run.report) pruneReport(previous.report);
    }
  }

  if (args["delete-branch"]) {
    const gone = state.branches[args["delete-branch"]];
    delete state.branches[args["delete-branch"]];
    if (gone) pruneReport(gone.report);
  }

  // Main keeps a full report for its newest runs; older runs keep their summary only.
  state.runs.sort((a, b) => a.testedAt.localeCompare(b.testedAt));
  for (const old of state.runs.slice(0, -KEEP_MAIN_REPORTS)) {
    if (old.report) {
      pruneReport(old.report);
      old.report = null;
    }
  }

  function pruneReport(report) {
    if (!report) return;
    const kept = state.merged.some((m) => m.finalRun?.report === report || m.mainRun?.report === report)
      || state.runs.some((r) => r.report === report)
      || Object.values(state.branches).some((r) => r.report === report);
    if (!kept) rmSync(join(site, report), { force: true });
  }

  // Report files nothing points at any more (for example, an older branch run).
  const referenced = new Set([
    ...state.runs.map((r) => r.report),
    ...Object.values(state.branches).map((r) => r.report),
    ...state.merged.flatMap((m) => [m.finalRun?.report, m.mainRun?.report]),
  ].filter(Boolean));
  for (const f of readdirSync(join(site, "reports"))) {
    if (!referenced.has(`reports/${f}`)) rmSync(join(site, "reports", f), { force: true });
  }

  writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");

  // ---------------------------------------------------------------------------------------------
  // Stories and acceptance criteria.

  const latestMainPath = join(site, "data", "latest-main.json");
  latestMain = existsSync(latestMainPath) ? JSON.parse(readFileSync(latestMainPath, "utf8")) : null;
  linear = await loadIssues();
  const stories = storiesFrom(linear.issues);
  const acMap = JSON.parse(readFileSync(new URL("./acceptance-map.json", import.meta.url), "utf8"));
  acceptance = evaluate(stories, acMap, latestMain?.tests ?? []);

  writeFileSync(join(site, "index.html"), indexPage());
  writeFileSync(join(site, ".nojekyll"), "");
  console.log(`Built ${join(site, "index.html")}: ${state.runs.length} main runs, ${Object.keys(state.branches).length} branches in progress, ${state.merged.length} merged, ${stories.length} stories (${linear.source} Linear data).`);
}

await main();
