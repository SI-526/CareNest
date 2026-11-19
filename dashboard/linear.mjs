// Stories and their acceptance criteria, from Linear.
//
// With LINEAR_API_KEY set (a personal API key, or the CI secret), issues come live from the
// Linear API. Without it they come from linear-snapshot.json, so the dashboard still builds.
//
//   LINEAR_API_KEY=lin_api_... node dashboard/linear.mjs --write-snapshot   # refresh the snapshot
//   node dashboard/linear.mjs                                                # print parsed stories
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEAM_KEY = process.env.LINEAR_TEAM_KEY || "SI";
const SNAPSHOT = fileURLToPath(new URL("./linear-snapshot.json", import.meta.url));

const QUERY = `query Issues($team: String!, $after: String) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $team } } }) {
    nodes {
      identifier title url description updatedAt completedAt
      state { name type }
      assignee { displayName name }
      project { name }
      parent { identifier }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function fetchLive(apiKey) {
  const issues = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query: QUERY, variables: { team: TEAM_KEY, after } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) {
      throw new Error(`Linear API ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
    }
    const { nodes, pageInfo } = body.data.issues;
    for (const n of nodes) {
      issues.push({
        id: n.identifier,
        title: n.title,
        url: n.url,
        status: n.state?.name ?? "",
        statusType: n.state?.type ?? "",
        assignee: n.assignee?.displayName || n.assignee?.name || null,
        project: n.project?.name ?? null,
        parent: n.parent?.identifier ?? null,
        updatedAt: n.updatedAt,
        completedAt: n.completedAt ?? null,
        description: n.description ?? "",
      });
    }
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  issues.sort((a, b) => issueNumber(a.id) - issueNumber(b.id));
  return { source: "live", fetchedAt: new Date().toISOString(), issues };
}

const issueNumber = (id) => Number(String(id).split("-")[1]) || 0;

/** Issues from Linear when a key is available, else the committed snapshot. */
export async function loadIssues({ apiKey = process.env.LINEAR_API_KEY } = {}) {
  if (apiKey) {
    try {
      return await fetchLive(apiKey);
    } catch (err) {
      console.warn(`Linear fetch failed, using the snapshot: ${err.message}`);
    }
  }
  return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
}

// ---------------------------------------------------------------------------------------------
// Acceptance criteria. Stories write them a few ways:
//   "## Acceptance Criteria", "**Acceptance Criteria:**", "Acceptance Criteria:"
// followed by a bullet list. Each top-level bullet is one criterion; nested bullets are its
// details. A bullet that only completes the one before it ("Expected System Behavior: ...",
// "Error message: ...") is folded into that criterion, so "User Action 1" and its expected
// behaviour count as one criterion whether or not they were indented.

const FOLLOW_ON = /^(expected (system )?behaviou?r|expected behaviou?r\/message|error message)\b/i;
const SECTION_END = /^(designs?|prototype|figma prototype|related epic|dev feasibility|definition)\b/i;

export function cleanInline(text) {
  return text
    .replace(/<linear-comment[^>]*>([\s\S]*?)<\/linear-comment>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\(<?[^)>]*>?\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:])/g, "$1$2")
    .replace(/\\([\[\]()*_])/g, "$1")
    .replace(/[\u2028\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAcceptanceCriteria(description) {
  if (!description) return [];
  const lines = description.replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /acceptance criteria/i.test(l) && !/^\s*[*-]\s/.test(l));
  if (start < 0) return [];
  const criteria = [];
  for (const raw of lines.slice(start + 1)) {
    if (!raw.trim()) continue;
    const bullet = raw.match(/^(\s*)[*-]\s+(.*)$/);
    const text = cleanInline(bullet ? bullet[2] : raw);
    if (/^#{1,6}\s/.test(raw.trim()) || SECTION_END.test(text)) break;
    if (!bullet) {
      // A non-bullet line ends the list unless it continues the previous bullet's text.
      if (/^\s{2,}/.test(raw) && criteria.length && text) {
        const last = criteria.at(-1);
        if (last.details.length) last.details[last.details.length - 1] += ` ${text}`;
        else last.text += ` ${text}`;
        continue;
      }
      break;
    }
    if (!text) continue;
    const nested = bullet[1].length >= 2;
    if (!nested && FOLLOW_ON.test(text) && criteria.length) {
      criteria.at(-1).details.push(text);
    } else if (nested && criteria.length) {
      criteria.at(-1).details.push(text);
    } else {
      criteria.push({ n: criteria.length + 1, text, details: [] });
    }
  }
  return criteria;
}

/** Issues that have acceptance criteria, with the criteria parsed out. */
export function storiesFrom(issues) {
  return issues
    .map((issue) => ({ ...issue, criteria: parseAcceptanceCriteria(issue.description) }))
    .filter((s) => s.criteria.length)
    .map(({ description, ...story }) => story);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await loadIssues();
  if (process.argv.includes("--write-snapshot")) {
    if (data.source !== "live") throw new Error("Set LINEAR_API_KEY to refresh the snapshot.");
    // Keep only the Acceptance Criteria part of each description: it is all the dashboard reads.
    for (const issue of data.issues) {
      const d = issue.description || "";
      const at = d.search(/^.*acceptance criteria.*$/im);
      issue.description = at >= 0 ? d.slice(at) : "";
    }
    writeFileSync(SNAPSHOT, JSON.stringify({ ...data, source: "snapshot" }, null, 1) + "\n");
    console.log(`Wrote ${data.issues.length} issues to ${SNAPSHOT}`);
  } else {
    for (const s of storiesFrom(data.issues)) {
      console.log(`\n${s.id} ${s.title} [${s.status}]`);
      for (const c of s.criteria) {
        console.log(`  AC${c.n} ${c.text}`);
        for (const d of c.details) console.log(`       - ${d}`);
      }
    }
  }
}
