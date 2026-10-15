#!/usr/bin/env bash
# Runs a command against this checkout's own local Supabase stack.
#
#   ./stack.sh                         # print this checkout's stack name and ports
#   ./stack.sh supabase start --workdir ..
#
# The main checkout uses supabase/config.toml as written (project "carenest", ports 553xx).
# A linked git worktree gets its own stack: project "carenest-<worktree dir>" (its own Docker
# containers and volumes, so `db reset` here never touches another checkout's data) and every
# port shifted by SLOT*100. SLOT comes from the worktree name; set CARENEST_STACK_SLOT (0-40) to
# pick one by hand, e.g. when two worktree names land on the same slot and `start` reports a
# port already in use. The Supabase CLI reads SUPABASE_<SECTION>_<KEY> env vars over config.toml.
set -euo pipefail
cd "$(dirname "$0")"

top=$(git rev-parse --show-toplevel)
if [ -n "${CARENEST_STACK_SLOT:-}" ]; then
  slot=$CARENEST_STACK_SLOT
elif [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  # ponytail: 40 slots from a name hash; a clash fails loudly on `start`, never shares data.
  slot=$(( $(basename "$top" | cksum | cut -d' ' -f1) % 40 + 1 ))
else
  slot=0
fi
[[ $slot =~ ^[0-9]+$ ]] && [ "$slot" -le 40 ] || { echo "CARENEST_STACK_SLOT must be 0-40" >&2; exit 1; }

if [ "$slot" -gt 0 ]; then
  off=$(( slot * 100 ))
  export SUPABASE_PROJECT_ID
  SUPABASE_PROJECT_ID=$(basename "$top" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-')
  [[ $SUPABASE_PROJECT_ID == carenest* ]] || SUPABASE_PROJECT_ID="carenest-$SUPABASE_PROJECT_ID"
  export SUPABASE_API_PORT=$(( 55321 + off ))
  export SUPABASE_DB_PORT=$(( 55322 + off ))
  export SUPABASE_DB_SHADOW_PORT=$(( 55320 + off ))
  export SUPABASE_DB_POOLER_PORT=$(( 55329 + off ))
  export SUPABASE_STUDIO_PORT=$(( 55323 + off ))
  export SUPABASE_LOCAL_SMTP_PORT=$(( 55324 + off ))
  export SUPABASE_ANALYTICS_PORT=$(( 55327 + off ))
  export SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT=$(( 58083 + off ))
fi

if [ $# -eq 0 ]; then
  api=${SUPABASE_API_PORT:-55321}
  echo "Stack: ${SUPABASE_PROJECT_ID:-carenest} (slot $slot)"
  echo "API $api, Postgres ${SUPABASE_DB_PORT:-55322}, Studio ${SUPABASE_STUDIO_PORT:-55323}, Mailpit ${SUPABASE_LOCAL_SMTP_PORT:-55324}"
  if [ "$slot" -gt 0 ]; then
    echo "Site: serve this checkout on its own port and open it once with ?supabasePort=$api"
  fi
  exit 0
fi
exec "$@"
