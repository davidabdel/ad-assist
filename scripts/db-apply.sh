#!/bin/zsh
# Apply migrations to the Supabase project over the Management API.
#
# There is no supabase CLI and no psql on this machine, and the service role key
# cannot run DDL (PostgREST only). The Management API's /database/query endpoint
# can, and it takes the same personal access token used for HomeReel.
#
#   ./scripts/db-apply.sh                       # every migration, in order
#   ./scripts/db-apply.sh supabase/migrations/0005_lock_internal_rpcs.sql
#
# Token: $SUPABASE_ACCESS_TOKEN, else ~/.buzz/.secrets/supabase_pat.
# Project ref is read from NEXT_PUBLIC_SUPABASE_URL in .env.local.
#
# Note: curl, not python's urllib — Supabase sits behind Cloudflare and urllib's
# default user-agent gets a 403 "error code: 1010".

set -e
cd "$(dirname "$0")/.."

PAT="${SUPABASE_ACCESS_TOKEN:-$(cat ~/.buzz/.secrets/supabase_pat)}"
REF=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | sed -E 's#.*https://([a-z0-9]+)\.supabase\.co.*#\1#')
[[ -n "$REF" ]] || { echo "could not read project ref from .env.local"; exit 1 }

FILES=("$@")
[[ ${#FILES[@]} -gt 0 ]] || FILES=(supabase/migrations/*.sql)

for f in $FILES; do
  printf '%s ... ' "$f"
  body=$(python3 -c 'import json,sys;print(json.dumps({"query":open(sys.argv[1]).read()}))' "$f")
  out=$(printf '%s' "$body" | curl -s -X POST \
    -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
    --data-binary @- "https://api.supabase.com/v1/projects/$REF/database/query")
  if print -r -- "$out" | grep -q '"message"'; then
    echo "FAILED"; print -r -- "$out"; exit 1
  fi
  echo "ok"
done
