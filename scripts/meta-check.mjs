/**
 * Proof that the payloads `src/lib/meta.ts` builds are ones Meta accepts.
 *
 * This is a network check against the real Marketing API, because the thing
 * being tested is not our code — it is whether Meta agrees with our reading of
 * its schema. An assertion that `createAdSet` produces the object we intended
 * would have passed on every one of the shapes that turned out to be wrong.
 *
 * WHAT IT SPENDS: nothing. Every create here is sent with `validate_only`, which
 * runs Meta's full server-side validation and returns success without writing
 * anything to the account. No campaign, no ad set, no creative and no ad comes
 * out of this, so it cannot be seen in Ads Manager and cannot be charged for.
 *
 * WHY AN AD SET IS HARDER THAN THE REST: an ad set has to name a campaign, and a
 * validated campaign has no id. So the ad set and the ad are rehearsed against
 * ids passed in on the command line — run it once with none to check the
 * campaign and the creative, and again with a real paused campaign's id to
 * check the two objects that hang off one.
 *
 *   node scripts/meta-check.mjs
 *   node scripts/meta-check.mjs --campaign 120xxxxxxxxxxx --adset 120xxxxxxxxxxx
 *
 * Reads META_ACCESS_TOKEN from the environment or .env.local.
 */
import { readFileSync } from 'node:fs';

const GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// ─── environment ──────────────────────────────────────────────────────────
function envFromFile() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* the environment is allowed to be the only source */ }
}
envFromFile();

const TOKEN = process.env.META_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('META_ACCESS_TOKEN is not set, in the environment or in .env.local.');
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const GIVEN_CAMPAIGN = argOf('campaign');
const GIVEN_ADSET = argOf('adset');

// ─── the one call ─────────────────────────────────────────────────────────
async function post(path, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  // Both flags, together. `validate_only` is what stops the write; the other is
  // what some endpoints read instead, and sending both means one endpoint
  // quietly ignoring one of them cannot turn a rehearsal into a real object.
  body.set('validate_only', 'true');
  body.set('execute_only_if_valid', 'false');
  body.set('access_token', TOKEN);

  const res = await fetch(`${GRAPH}/${path}`, { method: 'POST', body });
  return { status: res.status, json: await res.json() };
}

async function get(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  return res.json();
}

let failures = 0;
function check(name, { status, json }) {
  const err = json?.error;
  const ok = !err && status < 400;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    const detail = [err?.error_user_title, err?.error_user_msg].filter(Boolean).join(' — ');
    console.log(`  FAIL ${name}`);
    console.log(`         ${err?.message ?? `HTTP ${status}`}`);
    if (detail) console.log(`         ${detail}`);
    if (err?.error_subcode) console.log(`         subcode ${err.error_subcode}`);
  }
  return ok;
}

// ─── pick the accounts to rehearse against ────────────────────────────────
console.log(`\nGraph ${GRAPH_VERSION} — every create below is validate_only and writes nothing.\n`);

const accounts = (await get('me/adaccounts', {
  fields: 'id,name,account_status,currency,funding_source_details',
  limit: '50',
})).data ?? [];

const funded = accounts.filter((a) => a.funding_source_details && a.account_status === 1);
if (!funded.length) {
  console.error('No ad account with a payment method. Nothing can be rehearsed.');
  process.exit(1);
}

// The creative is the only object that needs a Page, and the Page has to be one
// THIS ad account may advertise as. So find an account that has both rather
// than assuming the funded one does — that mismatch is the failure this whole
// check exists to catch early.
let withPage = null;
for (const a of funded) {
  const pages = (await get(`${a.id}/promote_pages`, { fields: 'id,name' })).data ?? [];
  if (pages.length) { withPage = { account: a, page: pages[0] }; break; }
}

const acct = (withPage?.account ?? funded[0]).id;
console.log(`ad account   ${acct}  (${(withPage?.account ?? funded[0]).name})`);
console.log(`page         ${withPage ? `${withPage.page.id} (${withPage.page.name})` : 'none — creative checks will be skipped'}`);
console.log('');

// ─── campaign ─────────────────────────────────────────────────────────────
console.log('campaign');
check('a traffic campaign, paused, budget on the ad sets', await post(`${acct}/campaigns`, {
  name: 'AdToCart check — traffic',
  objective: 'OUTCOME_TRAFFIC',
  status: 'PAUSED',
  special_ad_categories: [],
  is_adset_budget_sharing_enabled: false,
}));
const noSharingFlag = await post(`${acct}/campaigns`, {
  name: 'AdToCart check — no budget anywhere',
  objective: 'OUTCOME_TRAFFIC',
  status: 'PAUSED',
  special_ad_categories: [],
});
console.log(`  ${noSharingFlag.json?.error ? 'ok  ' : 'FAIL'} a campaign with no budget and no sharing answer is refused`);
if (!noSharingFlag.json?.error) failures += 1;
check('a sales campaign carrying the budget itself', await post(`${acct}/campaigns`, {
  name: 'AdToCart check — sales, CBO',
  objective: 'OUTCOME_SALES',
  status: 'PAUSED',
  special_ad_categories: [],
  daily_budget: 2000,
}));
const noCategories = await post(`${acct}/campaigns`, {
  name: 'AdToCart check — missing declaration',
  objective: 'OUTCOME_TRAFFIC',
  status: 'PAUSED',
});
console.log(`  ${noCategories.json?.error ? 'ok  ' : 'FAIL'} omitting special_ad_categories is refused`);
if (!noCategories.json?.error) failures += 1;

// ─── ad set ───────────────────────────────────────────────────────────────
console.log('\nad set');
if (!GIVEN_CAMPAIGN) {
  console.log('  skip  needs --campaign <id> of a real paused campaign');
} else {
  const targeting = {
    geo_locations: { countries: ['AU'] },
    age_min: 25,
    age_max: 65,
  };
  const startTime = new Date(Date.now() + 86_400_000).toISOString();

  check('daily budget, link clicks, Australia, 25-65', await post(`${acct}/adsets`, {
    name: 'AdToCart check — adset',
    campaign_id: GIVEN_CAMPAIGN,
    status: 'PAUSED',
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LANDING_PAGE_VIEWS',
    daily_budget: 2000,
    targeting,
    start_time: startTime,
  }));

  const cities = (await get('search', {
    type: 'adgeolocation', location_types: '["city"]', q: 'Sydney', country_code: 'AU', limit: '3',
  })).data ?? [];
  console.log(`  ${cities.length ? 'ok  ' : 'FAIL'} the city index answers for Sydney${cities[0] ? ` (${cities[0].key} ${cities[0].name})` : ''}`);
  if (!cities.length) failures += 1;

  if (cities[0]) {
    check('a city with a radius instead of a country', await post(`${acct}/adsets`, {
      name: 'AdToCart check — adset, city radius',
      campaign_id: GIVEN_CAMPAIGN,
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LANDING_PAGE_VIEWS',
      daily_budget: 2000,
      targeting: {
        geo_locations: {
          cities: [{ key: cities[0].key, radius: 25, distance_unit: 'kilometer' }],
        },
        age_min: 25,
        age_max: 65,
      },
      start_time: startTime,
    }));
  }
}

// ─── creative ─────────────────────────────────────────────────────────────
console.log('\ncreative');
if (!withPage) {
  console.log('  skip  no ad account with a Page attached');
} else {
  const page = withPage.page.id;
  const link = 'https://ad-assist.vercel.app/p/example/example-persona';

  // A hash that does not exist. The point is to find out WHICH complaint comes
  // back: "image hash not found" means the rest of the object parsed, which is
  // what is being checked here. Anything else means the shape is wrong.
  const r = await post(`${withPage.account.id}/adcreatives`, {
    name: 'AdToCart check — image creative',
    object_story_spec: {
      page_id: page,
      link_data: {
        image_hash: '0000000000000000000000000000000f',
        link,
        message: 'Body copy that the persona reads first.',
        name: 'The headline',
        description: 'The description under it.',
        call_to_action: { type: 'LEARN_MORE', value: { link } },
      },
    },
    degrees_of_freedom_spec: {
      creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_OUT' } },
    },
  });
  // The one refusal that is not about the payload at all.
  //
  // A creative is the first object in the chain that makes a Page post, and a
  // Page post cannot be made by an app still in Development mode — no matter
  // whose ad account, whose Page, or how correct the creative is. Confirmed
  // across three ad accounts and three Pages. Campaigns and ad sets are happy
  // in Development, which is exactly why this has to be checked here and not
  // assumed from a campaign call that succeeded.
  //
  // The fix is not in this repo: switch the app to Live in the Meta dashboard.
  if (r.json?.error?.error_subcode === 1885183) {
    failures += 1;
    console.log('  FAIL the app is in Development mode, so no creative can be made');
    console.log('         Switch the AdToCart app to Live in the Meta dashboard.');
    console.log('         Everything above this line passes in Development; nothing below it can.');
  } else {
    const msg = `${r.json?.error?.message ?? ''} ${r.json?.error?.error_user_msg ?? ''}`.toLowerCase();
    const onlyTheHash = !r.json?.error || msg.includes('image') || msg.includes('hash');
    console.log(`  ${onlyTheHash ? 'ok  ' : 'FAIL'} the image creative parses (only the fake hash is objected to)`);
    if (!onlyTheHash) {
      failures += 1;
      console.log(`         ${r.json?.error?.message}`);
      console.log(`         ${r.json?.error?.error_user_msg ?? ''}`);
    }
  }

  const bad = await post(`${withPage.account.id}/adcreatives`, {
    name: 'AdToCart check — wrong page',
    object_story_spec: {
      page_id: '999999999999999',
      link_data: {
        image_hash: '0000000000000000000000000000000f',
        link,
        message: 'x',
        name: 'x',
        call_to_action: { type: 'LEARN_MORE', value: { link } },
      },
    },
  });
  console.log(`  ${bad.json?.error ? 'ok  ' : 'FAIL'} a Page this account cannot advertise as is refused`);
  if (!bad.json?.error) failures += 1;
}

// ─── ad ───────────────────────────────────────────────────────────────────
console.log('\nad');
if (!GIVEN_ADSET) {
  console.log('  skip  needs --adset <id> of a real paused ad set');
} else {
  check('an ad joining a creative to an ad set, paused', await post(`${acct}/ads`, {
    name: 'AdToCart check — ad',
    adset_id: GIVEN_ADSET,
    creative: { creative_id: argOf('creative') ?? '0' },
    status: 'PAUSED',
  }));
}

console.log(`\n${failures ? `${failures} failed` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
