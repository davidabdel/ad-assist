#!/bin/zsh
# End-to-end proof that the pipeline actually runs: create a throwaway owner,
# create a campaign from a REAL product URL, let the Mac-side worker scrape it in
# Chrome, then advance until the 20 persona pages exist — against the live
# database and the live Anthropic API.
#
#   ./scripts/smoke-pipeline.sh            # run it (BILLS the Anthropic key)
#   ./scripts/smoke-pipeline.sh --cleanup  # delete the throwaway rows and user
#
# Needs `npm run dev` serving on $BASE (default localhost:3000) and `npm start`
# running in scanner/ so the ingest job gets claimed.
#
# A migration that applies cleanly proves nothing, and a build that compiles
# proves less. This calls every stage for real.

set -e
cd "$(dirname "$0")/.."

BASE="${BASE:-http://localhost:3000}"
EMAIL="smoke+adassist@uconnect.com.au"
PASSWORD="smoke-$(date +%s)-adassist"
PRODUCT="https://www.allbirds.com.au/products/tree-runner-mens-navy-night-white-sole"

URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
SVC=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)

if [[ "$1" == "--cleanup" ]]; then
  uid=$(curl -s "$URL/auth/v1/admin/users?page=1&per_page=200" \
    -H "apikey: $SVC" -H "Authorization: Bearer $SVC" \
    | EMAIL="$EMAIL" python3 -c "
import json,os,sys
users = json.load(sys.stdin).get('users', [])
print(next((u['id'] for u in users if u['email']==os.environ['EMAIL']), ''))")
  if [[ -n "$uid" ]]; then
    # auth.users cascades to public.users, which cascades to campaigns and every
    # child table under them. One delete, nothing orphaned.
    curl -s -X DELETE "$URL/auth/v1/admin/users/$uid" \
      -H "apikey: $SVC" -H "Authorization: Bearer $SVC" > /dev/null
    echo "deleted throwaway user $uid (campaigns cascade)"
  else
    echo "no throwaway user to delete"
  fi
  exit 0
fi

echo "── owner ─────────────────────────────────────────────"
curl -s -X POST "$URL/auth/v1/admin/users" \
  -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"email_confirm\":true}" > /dev/null

TOKEN=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))')
[[ -n "$TOKEN" ]] || { echo "could not sign in as the throwaway owner"; exit 1 }
echo "signed in as $EMAIL"

echo "\n── campaign ──────────────────────────────────────────"
BODY=$(PRODUCT="$PRODUCT" python3 -c 'import json,os;print(json.dumps({
  "title": "Smoke Test Tree Runners",
  "source_url": os.environ["PRODUCT"],
  "current_offer": "Free shipping + 30-day wear test",
  "checkout_url": "https://www.allbirds.com.au/cart",
}))')
CREATE=$(curl -s -X POST "$BASE/api/campaigns" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY")
CID=$(print -r -- "$CREATE" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("campaign",{}).get("id",""))')
[[ -n "$CID" ]] || { echo "create failed: $CREATE"; exit 1 }
echo "campaign $CID"

echo "\n── advance ───────────────────────────────────────────"
for i in {1..40}; do
  OUT=$(curl -s -X POST "$BASE/api/campaigns/$CID/advance" -H "Authorization: Bearer $TOKEN")
  set +e
  print -r -- "$OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d:
    print('  ERROR:', d['error']); sys.exit(2)
print(f\"  [{d['status']}] {d['did']}\")
for n in (d.get('notes') or []): print(f'      · {n}')
sys.exit(3 if d['terminal'] else (4 if d['waiting'] else 0))
"
  rc=$?
  set -e
  [[ $rc == 2 ]] && exit 1
  # terminal covers both outcomes: 20 pages built, or failed and needing a human.
  [[ $rc == 3 ]] && break
  # 4 means the next move belongs to the worker — back off instead of spinning.
  [[ $rc == 4 ]] && sleep 8
done

echo "\n── result ────────────────────────────────────────────"
curl -s "$BASE/api/campaigns/$CID" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('status   :', d['campaign']['status'])
print('base page:', (d['base_page'] or {}).get('hero_headline'))
b=d.get('brief') or {}
print('brief    :', b.get('product_name'), '|', len(b.get('features',[])), 'features |',
      len(b.get('review_snippets',[])), 'real review quotes')
for g in b.get('gaps', []): print('   gap  :', g)
print('personas :', len(d['personas']))
for p in d['personas']:
    print(f\"  {p['persona_index']:>2}. {p['persona_name']:<32} {p['url']}\")
"
echo "\nCAMPAIGN_ID=$CID"
echo "run with --cleanup to remove the throwaway owner and everything it owns."
