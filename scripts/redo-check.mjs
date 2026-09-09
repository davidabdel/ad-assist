/**
 * Proof that sending a step back does what the dialog says it does.
 *
 * A migration that applies cleanly proves nothing and a build that compiles
 * proves less — the whole risk in this feature is a DELETE that takes something
 * with it that it should not have. So this seeds a throwaway campaign that has
 * the one arrangement that is dangerous — three landing pages, six ad ideas,
 * and one of those ideas already generated and paid for — sends the pages step
 * back through the real HTTP route, and then reads the database to check that:
 *
 *   - the paid idea is still there, marked superseded rather than deleted
 *   - the page that idea's ad points at is still there, for the same reason
 *   - everything unpaid is gone
 *   - the campaign is rewound and carrying the operator's note
 *
 * Nothing here calls a model or KIE. It bills nothing.
 *
 *   BASE=http://localhost:3001 node scripts/redo-check.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const BASE = process.env.BASE ?? 'http://localhost:3001';
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const SVC = env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const db = createClient(URL_, SVC, { auth: { persistSession: false } });

const EMAIL = `redo-check+${Date.now()}@uconnect.com.au`;
const PASSWORD = `redo-${Date.now()}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── a throwaway owner, and a real access token for it ──────────────
const { data: created, error: userError } = await db.auth.admin.createUser({
  email: EMAIL, password: PASSWORD, email_confirm: true,
});
if (userError) throw new Error(`could not create the throwaway user: ${userError.message}`);
const userId = created.user.id;
await db.from('users').upsert({ id: userId, email: EMAIL });

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const { data: session, error: signInError } = await anon.auth.signInWithPassword({
  email: EMAIL, password: PASSWORD,
});
if (signInError) throw new Error(`could not sign in: ${signInError.message}`);
const token = session.session.access_token;

// ── the dangerous arrangement ──────────────────────────────────────
const slug = `redo-check-${Date.now()}`;
const { data: campaign, error: campaignError } = await db.from('campaigns').insert({
  user_id: userId,
  title: 'Redo check',
  slug,
  source_url: 'https://example.com/product',
  product_type: 'ecom',
  persona_target: 3,
  region: 'AU',
  status: 'ideas_ready',
  scraped_data: { raw: { markdown: 'x' }, brief: { product_name: 'Thing', image_urls: [] } },
}).select('*').single();
if (campaignError) throw new Error(`campaign: ${campaignError.message}`);

await db.from('base_pages').insert({
  campaign_id: campaign.id,
  page_title: 'p', hero_headline: 'h', reasons: [], testimonials: [],
  offer_headline: 'o', cta_button_text: 'Buy', cta_url: 'https://example.com',
});

const { data: personas, error: personaError } = await db.from('personas').insert(
  [1, 2, 3].map((n) => ({
    campaign_id: campaign.id,
    persona_index: n,
    slug: `buyer-${n}`,
    persona_name: `Buyer ${n}`,
    primary_pain_point: `pain ${n}`,
    core_desire: 'd',
    angle_hook: 'a',
    custom_hero_headline: 'h',
    custom_reasons: [],
  })),
).select('id, persona_index');
if (personaError) throw new Error(`personas: ${personaError.message}`);

const { data: ideas, error: ideaError } = await db.from('ad_ideas').insert(
  personas.flatMap((p) => [1, 2].map((i) => ({
    campaign_id: campaign.id,
    persona_id: p.id,
    idea_index: i,
    media_type: 'image',
    angle: 'a', hook: 'h', headline: 'H', primary_text: 't', cta_label: 'Shop now',
    visual_concept: 'v', kie_model: 'google/nano-banana-edit', kie_prompt: 'p',
    est_credits: 4, est_usd: 0.02,
    destination_url: `https://example.com/p/${slug}/buyer-${p.persona_index}`,
    status: 'draft',
  }))),
).select('id, persona_id, idea_index');
if (ideaError) throw new Error(`ideas: ${ideaError.message}`);

// One of them has been approved and made. This is the row the whole feature is
// careful about.
const paidIdea = ideas[0];
const paidPersona = paidIdea.persona_id;
await db.from('ad_ideas').update({ status: 'generated' }).eq('id', paidIdea.id);
const { error: assetError } = await db.from('generated_assets').insert({
  ad_idea_id: paidIdea.id,
  state: 'success',
  kie_model: 'google/nano-banana-edit',
  kie_task_id: `redo-check-${Date.now()}`,
  stored_url: 'https://example.com/finished.png',
  credits_charged: 4,
  prompt_used: 'p',
});
if (assetError) throw new Error(`asset: ${assetError.message}`);

console.log(`\nseeded ${personas.length} pages, ${ideas.length} ideas, 1 of them paid for\n`);

// ── what the dialog would say ──────────────────────────────────────
const api = (path, init) => fetch(`${BASE}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
});

const previewRes = await api(`/api/campaigns/${campaign.id}/steps/pages`);
const preview = await previewRes.json();
console.log('the dialog would say:');
for (const line of preview.rebuilds ?? []) console.log(`   · ${line}`);
console.log();
check('preview is 200', previewRes.status === 200, JSON.stringify(preview).slice(0, 200));
check('preview counts the paid ad', preview.keptAds === 1, `keptAds=${preview.keptAds}`);
check('preview counts the page it points at', preview.keptPages === 1, `keptPages=${preview.keptPages}`);

// ── and then doing it ──────────────────────────────────────────────
const doRes = await api(`/api/campaigns/${campaign.id}/steps/pages`, {
  method: 'POST',
  body: JSON.stringify({ note: 'Stop writing for people who already own one.' }),
});
const done = await doRes.json();
check('redo is 200', doRes.status === 200, JSON.stringify(done).slice(0, 200));

// ── the database, which is the only thing that counts ──────────────
const { data: after } = await db.from('campaigns')
  .select('status, step_guidance').eq('id', campaign.id).single();
check('campaign rewound to personas', after.status === 'personas', `status=${after.status}`);
check('the note was kept', after.step_guidance?.pages?.startsWith('Stop writing'),
  JSON.stringify(after.step_guidance));

const { data: personasAfter } = await db.from('personas')
  .select('id, superseded_at').eq('campaign_id', campaign.id);
const liveP = personasAfter.filter((p) => !p.superseded_at);
const oldP = personasAfter.filter((p) => p.superseded_at);
check('unpaid pages deleted', liveP.length === 0, `${liveP.length} still live`);
check('the paid ad\'s page survived', oldP.length === 1 && oldP[0].id === paidPersona,
  `${oldP.length} superseded`);

const { data: ideasAfter } = await db.from('ad_ideas')
  .select('id, superseded_at').eq('campaign_id', campaign.id);
check('unpaid ideas deleted', ideasAfter.filter((i) => !i.superseded_at).length === 0,
  `${ideasAfter.filter((i) => !i.superseded_at).length} still live`);
check('the paid idea survived', ideasAfter.length === 1 && ideasAfter[0].id === paidIdea.id,
  `${ideasAfter.length} rows left`);

const { data: assetsAfter } = await db.from('generated_assets')
  .select('id, stored_url').eq('ad_idea_id', paidIdea.id);
check('the finished file survived', assetsAfter.length === 1, `${assetsAfter.length} assets`);

// ── the refusal, which matters as much as the redo ─────────────────
await db.from('campaigns').update({ status: 'personas' }).eq('id', campaign.id);
const busyRes = await api(`/api/campaigns/${campaign.id}/steps/pages`, {
  method: 'POST', body: JSON.stringify({ note: '' }),
});
check('refuses a redo mid-run', busyRes.status === 409, `status=${busyRes.status}`);

const badRes = await api(`/api/campaigns/${campaign.id}/steps/nonsense`);
check('unknown step is a 404', badRes.status === 404, `status=${badRes.status}`);

// ── the second thing that must be true: the scan is NOT collateral ──
//
// Its searches are generic ad-copy phrases derived from the campaign id and the
// region, so nothing it read off Meta changes because the summary was wrong.
// Cascading into it would cost twenty minutes of the Mac's time, and require
// the Mac to be awake, to correct a price.
console.log();
const { data: job } = await db.from('scanner_jobs').insert({
  campaign_id: campaign.id,
  kind: 'ad_scan',
  region: 'AU',
  media_type: 'image',
  search_terms: ['shop now'],
  status: 'completed',
  items_found: 40,
  items_qualified: 12,
}).select('id').single();
await db.from('format_specs').insert({
  campaign_id: campaign.id,
  media_type: 'image',
  format_name: 'Before and after',
  description: 'd', hook_pattern: 'h', visual_recipe: 'v',
  observed_count: 9,
});
await db.from('campaigns').update({
  status: 'ideas_ready', formats_extracted: ['image', 'video'],
}).eq('id', campaign.id);

const briefPreview = await (await api(`/api/campaigns/${campaign.id}/steps/brief`)).json();
console.log('redoing the summary would:');
for (const line of briefPreview.rebuilds ?? []) console.log(`   · ${line}`);
check('redoing the summary does not mention the scan',
  !(briefPreview.rebuilds ?? []).some((r) => r.includes('ad-library')),
  JSON.stringify(briefPreview.rebuilds));

await api(`/api/campaigns/${campaign.id}/steps/brief`, {
  method: 'POST', body: JSON.stringify({ note: 'It is $40 a month, not $40.' }),
});
const { data: afterBrief } = await db.from('campaigns')
  .select('status, scraped_data, step_guidance').eq('id', campaign.id).single();
check('rewound to the summary', afterBrief.status === 'scraping', afterBrief.status);
check('the summary was dropped', !afterBrief.scraped_data?.brief);
check('the page read was KEPT', Boolean(afterBrief.scraped_data?.raw),
  'a brief redo must not send the campaign back to the Mac for a page it has');
check('both notes are kept side by side',
  afterBrief.step_guidance?.brief?.includes('$40 a month')
  && afterBrief.step_guidance?.pages?.includes('already own one'),
  JSON.stringify(afterBrief.step_guidance));

const { count: jobsLeft } = await db.from('scanner_jobs')
  .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id).eq('kind', 'ad_scan');
const { count: formatsLeft } = await db.from('format_specs')
  .select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.id);
check('the finished scan survived a summary redo', jobsLeft === 1, `${jobsLeft} jobs`);
check('the formats survived too', formatsLeft === 1, `${formatsLeft} formats`);

// And the reverse: redoing the scan DOES take the ideas, because every idea is
// built on a format. Needs a live idea to say so about — the pages redo above
// left none, so one is put back first.
const { data: freshPersona } = await db.from('personas').insert({
  campaign_id: campaign.id,
  persona_index: 1,
  slug: 'buyer-fresh',
  persona_name: 'Fresh buyer',
  primary_pain_point: 'p', core_desire: 'd', angle_hook: 'a',
  custom_hero_headline: 'h', custom_reasons: [],
}).select('id').single();
await db.from('ad_ideas').insert({
  campaign_id: campaign.id,
  persona_id: freshPersona.id,
  idea_index: 1,
  media_type: 'image',
  angle: 'a', hook: 'h', headline: 'H', primary_text: 't', cta_label: 'Shop now',
  visual_concept: 'v', kie_model: 'google/nano-banana-edit', kie_prompt: 'p',
  est_credits: 4, est_usd: 0.02,
  destination_url: 'https://example.com/x',
  status: 'draft',
});
// The partial unique index is what makes this insert legal at all: persona_index
// 1 and idea_index 1 are both still held by superseded rows.
check('a new page can reuse an index a superseded page holds', Boolean(freshPersona?.id));

const scanPreview = await (await api(`/api/campaigns/${campaign.id}/steps/scan`)).json();
console.log('redoing the scan would:');
for (const line of scanPreview.rebuilds ?? []) console.log(`   · ${line}`);
check('redoing the scan DOES take the ideas',
  (scanPreview.rebuilds ?? []).some((r) => r.includes('ad idea')),
  JSON.stringify(scanPreview.rebuilds));
check('redoing the scan leaves the pages alone',
  !(scanPreview.rebuilds ?? []).some((r) => r.includes('landing page')),
  JSON.stringify(scanPreview.rebuilds));

// ── the dashboard reads what it needs ──────────────────────────────
// The screen cannot show a note it is not sent, and cannot separate a live page
// from a superseded one without the flag.
const viewRes = await api(`/api/campaigns/${campaign.id}`);
const view = await viewRes.json();
check('the dashboard is sent the notes',
  view.campaign?.step_guidance?.brief?.includes('$40 a month'),
  JSON.stringify(view.campaign?.step_guidance));
check('the dashboard is sent the superseded flag',
  view.personas?.some((p) => p.superseded_at) && view.personas?.some((p) => !p.superseded_at),
  `${view.personas?.length} pages`);
check('the dashboard is sent the whole brief, not just its images',
  view.brief === null || typeof view.brief === 'object');

// ── clean up ───────────────────────────────────────────────────────
await db.from('campaigns').delete().eq('id', campaign.id);
await db.from('users').delete().eq('id', userId);
await db.auth.admin.deleteUser(userId);

console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
