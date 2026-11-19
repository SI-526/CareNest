# Test dashboard

A web page with CareNest's test results, published to GitHub Pages from the `gh-pages` branch.
It shows:

- whether main is passing, with the latest run's report and a chart of every run on main
- every Linear story that has acceptance criteria, each criterion's status from the latest run on
  main (Passing, Failing, No test yet, Checked by hand, Link out of date), and the tests behind it
- branches in progress (the latest run of each branch that hasn't merged)
- merged branches (each branch's final run before its pull request merged, kept permanently)
- the history of main (full reports for the newest 30 runs)

The `Tests` workflow (`.github/workflows/tests.yml`) runs every unit and database test on every
push, against a local Supabase stack, then publishes. It also rebuilds the page once a day so
story status from Linear stays current, and drops a branch from "in progress" when it's deleted.

## One-time setup

1. **Turn on GitHub Pages.** In the repository's Settings, open Pages, set Source to "Deploy from
   a branch", and pick `gh-pages` and `/ (root)`. The branch appears after the workflow's first
   run. The page is then at `https://si-526.github.io/CareNest/`. (Pages needs a public repository
   or a GitHub plan that includes Pages for private ones.)
2. **Give CI a Linear key (optional, recommended).** In Linear, open Settings, then Security &
   access, and create a personal API key with read access. In GitHub, add it under Settings,
   Secrets and variables, Actions, as a repository secret named `LINEAR_API_KEY`. Without it, the
   page reads stories from `linear-snapshot.json`, which only changes when someone refreshes it.

## Linking tests to acceptance criteria

Stories and their criteria come from Linear: any issue in the SI team whose description has an
"Acceptance Criteria" heading followed by a bullet list. Each top-level bullet is one criterion,
numbered in order (AC1, AC2, ...). "Expected System Behavior" and "Error message" bullets are
folded into the criterion above them.

There are two ways to say a test checks a criterion:

- **In the test's name.** `test("SI-70 AC4: the next activity is shown once one has passed", ...)`
  links that test to SI-70's AC4. Best for new tests written for a story.
- **In `acceptance-map.json`.** For existing tests. Each entry has `match`, a few words from the
  criterion, so that if someone rewrites the story in Linear the link shows as "Link out of date"
  instead of quietly pointing at the wrong criterion.

A criterion with no linked test shows "No test yet". Most of the current tests check the
database and the app's logic, not the screens, so criteria about layout, copy and Figma matching
don't have tests yet.

## Running it locally

From `tests/`, with the local stack running (see the main README):

```sh
node --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=../dashboard/json-reporter.mjs --test-reporter-destination=../.results/all.json \
  "*.test.mjs"
cd ..
node dashboard/build.mjs --site .results/site --results .results/all.json --branch main --sha "$(git rev-parse HEAD)"
```

Then open `.results/site/index.html`. `node dashboard/linear.mjs` prints the stories and criteria
it parsed. With a key, `LINEAR_API_KEY=lin_api_... node dashboard/linear.mjs --write-snapshot`
refreshes the snapshot.

## Files

- `json-reporter.mjs`: a `node --test` reporter that writes every test's file, name and result as JSON
- `linear.mjs`: loads issues from Linear (or the snapshot) and parses acceptance criteria
- `acceptance-map.json`: which existing tests check which criteria
- `build.mjs`: records a run in the site's saved state and writes `index.html` and the run's report
- `publish.sh`: clones `gh-pages`, builds, and pushes, retrying if another run published first
