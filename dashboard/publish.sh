#!/usr/bin/env bash
# Updates the dashboard on the gh-pages branch. CI runs this after the tests; see
# .github/workflows/tests.yml. Everything after the script name is passed to build.mjs.
#
# Several runs can publish at once (two pushes close together), so on a rejected push this
# clones gh-pages again and rebuilds on top of what the other run wrote. build.mjs only adds
# to the saved state, so running it again on a fresh checkout is safe.
set -euo pipefail

# DASHBOARD_REMOTE points at another repository, for trying this out locally.
repo_url="${DASHBOARD_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
here=$(cd "$(dirname "$0")" && pwd)
site="${RUNNER_TEMP:-/tmp}/dashboard-site"

for attempt in 1 2 3 4 5; do
  rm -rf "$site"
  if git ls-remote --exit-code --heads "$repo_url" gh-pages >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch gh-pages "$repo_url" "$site"
  else
    mkdir -p "$site"
    git -C "$site" init --quiet -b gh-pages
    git -C "$site" remote add origin "$repo_url"
  fi

  node "$here/build.mjs" --site "$site" "$@"

  git -C "$site" add -A
  if git -C "$site" diff --cached --quiet; then
    echo "Nothing changed."
    exit 0
  fi
  git -C "$site" -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "Update the test dashboard (${GITHUB_EVENT_NAME:-local} on ${GITHUB_REF_NAME:-local})"
  if git -C "$site" push --quiet origin gh-pages; then
    echo "Published the dashboard."
    exit 0
  fi
  echo "gh-pages moved while this run was building; trying again ($attempt)."
  sleep $((attempt * 5))
done
echo "Could not publish the dashboard after 5 tries." >&2
exit 1
