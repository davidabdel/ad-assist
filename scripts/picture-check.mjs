/**
 * Proof that an ad with no photograph now gets a picture, and that getting one
 * costs what the row says it costs.
 *
 * WHY THIS EXISTS RATHER THAN A READ OF THE DIFF. This feature touches the one
 * file in the app that spends money, and its three shapes are easy to confuse
 * on paper and expensive to confuse in production:
 *
 *   a static WITH a photograph   → the EDITING model, holding their photo
 *   a static with NONE           → the DRAWING model, holding nothing
 *   a video with NONE            → a 9:16 still first, then the video from it
 *
 * Sending the second of those to the editing model is not a crash. It is a
 * charge, and a picture of an invented product in an ad for a real one. So this
 * stands a recorder where KIE goes, drives the real HTTP routes, and reads what
 * was actually asked for.
 *
 * NOTHING HERE BILLS. The app is started with KIE_BASE_URL pointing at this
 * script's own server, so every createTask lands in a list instead of at KIE.
 *
 *   node scripts/picture-check.mjs            # starts its own recorder on 3099
 *
 * with the app running as:
 *
 *   KIE_BASE_URL=http://127.0.0.1:3099 npm run dev -- -p 3007
 *   BASE=http://localhost:3007 node scripts/picture-check.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const BASE = process.env.BASE ?? 'http://localhost:3007';
const KIE_PORT = Number(process.env.KIE_PORT ?? 3099);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const db = createClient(URL_, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(URL_, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── the recorder that stands where KIE goes ────────────────────────
//
// It answers the two calls the app makes — createTask and recordInfo — and
// keeps every submit so the assertions can read what was asked for. `outcome`
// is what the next recordInfo says about a task, which is how a frame is made
// to fail on purpose.
const submits = [];
const outcome = new Map();
// A one-pixel PNG. storeResult fetches the finished file and puts it in our own
// bucket, so the result URL has to serve real bytes or a success looks like a
// storage failure.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const kie = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${KIE_PORT}`);
  if (url.pathname === '/file.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PIXEL);
    return;
  }
  if (url.pathname === '/api/v1/jobs/createTask') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const taskId = `t${submits.length + 1}-${Date.now()}`;
      submits.push({ taskId, ...parsed });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 200, msg: 'success', data: { taskId } }));
    });
    return;
  }
  if (url.pathname === '/api/v1/jobs/recordInfo') {
    const taskId = url.searchParams.get('taskId');
    const state = outcome.get(taskId) ?? 'generating';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 200,
      msg: 'success',
      data: state === 'success'
        ? {
          state: 'success',
          resultJson: JSON.stringify({
            resultUrls: [`http://127.0.0.1:${KIE_PORT}/file.png`],
          }),
          creditsConsumed: 4,
        }
        : state === 'fail'
          ? { state: 'fail', failMsg: 'the recorder was told to fail this one' }
          : { state: 'generating' },
    }));
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => kie.listen(KIE_PORT, '127.0.0.1', r));

// Refuse to run against the real thing. Everything below assumes a submit is
// free, and it is only free because of this.
const probe = await fetch(`${BASE}/api/campaigns`).catch(() => null);
if (!probe) {
  console.error(`nothing is listening on ${BASE}. Start it with:\n`
    + `  KIE_BASE_URL=http://127.0.0.1:${KIE_PORT} npm run dev -- -p 3007`);
  process.exit(1);
}

// ── a throwaway owner ──────────────────────────────────────────────
const EMAIL = `picture-check+${Date.now()}@uconnect.com.au`;
const PASSWORD = `pic-${Date.now()}`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email: EMAIL, password: PASSWORD, email_confirm: true,
});
if (userError) throw new Error(`could not create the throwaway user: ${userError.message}`);
const userId = created.user.id;
await db.from('users').upsert({ id: userId, email: EMAIL });
const { data: session } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
const token = session.session.access_token;
const api = (path, init) => fetch(`${BASE}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
});

// ── a campaign with one of each shape ──────────────────────────────
const slug = `picture-check-${Date.now()}`;
const { data: campaign, error: campaignError } = await db.from('campaigns').insert({
  user_id: userId,
  title: 'Picture check',
  slug,
  source_url: 'https://example.com/product',
  product_type: 'ecom',
  persona_target: 3,
  region: 'AU',
  status: 'ideas_ready',
  scraped_data: {
    raw: { markdown: 'x' },
    brief: {
      brand_name: 'Example', product_name: 'Thing', one_line_summary: 'A thing.', image_urls: [],
    },
  },
}).select('*').single();
if (campaignError) throw new Error(`campaign: ${campaignError.message}`);

const { data: personas } = await db.from('personas').insert([{
  campaign_id: campaign.id,
  persona_index: 1,
  slug: 'buyer-1',
  persona_name: 'Buyer 1',
  primary_pain_point: 'pain',
  core_desire: 'desire',
  angle_hook: 'a',
  custom_hero_headline: 'h',
  custom_reasons: [],
}]).select('id');
const personaId = personas[0].id;

const SCENE = 'A kitchen bench at seven in the morning, low winter light through the window, '
  + 'hands wiping a spill with a cloth, shot at 35mm from just above the surface.';

const seed = (n, over) => ({
  campaign_id: campaign.id,
  persona_id: personaId,
  idea_index: n,
  media_type: 'image',
  angle: 'a', hook: 'h', headline: `Headline ${n}`, primary_text: 't', cta_label: 'Shop now',
  visual_concept: 'v',
  kie_model: 'google/nano-banana-edit',
  kie_prompt: 'p',
  est_credits: 4, est_usd: 0.02,
  destination_url: `https://example.com/p/${slug}/buyer-1`,
  status: 'draft',
  ...over,
});

// Three ideas is the table's ceiling per buyer, so the four shapes need two
// buyers. The second one exists only to carry the frame-failure case.
const { data: personas2 } = await db.from('personas').insert([{
  campaign_id: campaign.id,
  persona_index: 2,
  slug: 'buyer-2',
  persona_name: 'Buyer 2',
  primary_pain_point: 'pain',
  core_desire: 'desire',
  angle_hook: 'a',
  custom_hero_headline: 'h',
  custom_reasons: [],
}]).select('id');

const { data: ideas, error: ideaError } = await db.from('ad_ideas').insert([
  // 1. a static with one of their photographs. Must not change. The photograph
  // is served by the recorder because the app reads the bytes itself before
  // handing anything to KIE — a URL that does not resolve is refused, correctly,
  // and would prove nothing about which model the ad went to.
  seed(1, { source_image_url: `http://127.0.0.1:${KIE_PORT}/file.png` }),
  // 2. a static with none. The scene IS its instruction.
  seed(2, {
    kie_model: 'google/nano-banana', kie_prompt: SCENE, generated_image_prompt: SCENE,
  }),
  // 3. a video with none. Its instruction is the move; the frame is its own field.
  seed(3, {
    media_type: 'video',
    kie_model: 'bytedance/seedance-2-fast',
    kie_prompt: 'The camera pushes slowly in over the bench.',
    generated_image_prompt: SCENE,
    video_storyboard: { beats: [], seconds: 10 },
    est_credits: 252, est_usd: 1.26,
  }),
  // 4. the same, on the second buyer, to be failed on purpose.
  {
    ...seed(1, {
      media_type: 'video',
      kie_model: 'bytedance/seedance-2-fast',
      kie_prompt: 'The camera pushes slowly in over the bench.',
      generated_image_prompt: SCENE,
      video_storyboard: { beats: [], seconds: 10 },
      est_credits: 252, est_usd: 1.26,
    }),
    persona_id: personas2[0].id,
  },
]).select('id, idea_index, media_type, persona_id').order('idea_index');
if (ideaError) throw new Error(`ideas: ${ideaError.message}`);

const withPhoto = ideas.find((i) => i.idea_index === 1 && i.persona_id === personaId);
const drawn = ideas.find((i) => i.idea_index === 2);
const framed = ideas.find((i) => i.idea_index === 3);
const doomed = ideas.find((i) => i.persona_id === personas2[0].id);

console.log(`\nseeded 4 ideas on ${slug}\n`);

const spendFor = async () => {
  const { data } = await db.from('spend_log')
    .select('id, asset_id, credits, usd, note').eq('campaign_id', campaign.id);
  return data ?? [];
};
const assetsFor = async (ideaId) => {
  const { data } = await db.from('generated_assets')
    .select('id, role, kie_model, state, kie_task_id, prompt_used, pending_spend_id')
    .eq('ad_idea_id', ideaId).order('created_at');
  return data ?? [];
};

// ── 1. the shape that must not have changed ────────────────────────
console.log('a static built on one of their photographs');
const r1 = await api(`/api/campaigns/${campaign.id}/ideas/${withPhoto.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b1 = await r1.json();
check('approve is 200', r1.status === 200, JSON.stringify(b1).slice(0, 180));
const s1 = submits.find((s) => s.taskId === b1.taskId);
check('went to the EDITING model', s1?.model === 'google/nano-banana-edit', s1?.model);
check('was handed their photograph', Array.isArray(s1?.input?.image_urls)
  && s1.input.image_urls.length === 1, JSON.stringify(s1?.input?.image_urls));
check('4:5, the shape a feed static is posted in', s1?.input?.aspect_ratio === '4:5',
  s1?.input?.aspect_ratio);

// ── 2. a static with no photograph ─────────────────────────────────
console.log('\na static with no photograph');
const r2 = await api(`/api/campaigns/${campaign.id}/ideas/${drawn.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b2 = await r2.json();
check('approve is 200', r2.status === 200, JSON.stringify(b2).slice(0, 180));
const s2 = submits.find((s) => s.taskId === b2.taskId);
check('went to the DRAWING model', s2?.model === 'google/nano-banana', s2?.model);
check('was handed no photograph', s2?.input?.image_urls === undefined,
  JSON.stringify(s2?.input?.image_urls));
check('was handed the scene', s2?.input?.prompt === SCENE, (s2?.input?.prompt ?? '').slice(0, 60));
check('4:5', s2?.input?.aspect_ratio === '4:5', s2?.input?.aspect_ratio);
const a2 = await assetsFor(drawn.id);
check('recorded as the ad itself, not a step', a2.length === 1 && a2[0].role === 'ad',
  JSON.stringify(a2.map((a) => a.role)));

// ── 3. a video with no photograph: the frame, then the video ───────
console.log('\na video with no photograph');
const r3 = await api(`/api/campaigns/${campaign.id}/ideas/${framed.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b3 = await r3.json();
check('approve is 200', r3.status === 200, JSON.stringify(b3).slice(0, 180));
const s3 = submits.find((s) => s.taskId === b3.taskId);
check('the FRAME was submitted, not the video', s3?.model === 'google/nano-banana', s3?.model);
check('the frame is 9:16, the shape the video will be', s3?.input?.aspect_ratio === '9:16',
  s3?.input?.aspect_ratio);
check('the frame was handed the scene, not the camera move',
  s3?.input?.prompt === SCENE, (s3?.input?.prompt ?? '').slice(0, 60));
const a3 = await assetsFor(framed.id);
check('recorded as a first frame', a3.length === 1 && a3[0].role === 'first_frame',
  JSON.stringify(a3.map((a) => a.role)));

const spend3 = (await spendFor()).filter((s) => /frame|video/.test(s.note ?? ''));
const frameLine = spend3.find((s) => s.note.includes('opening frame'));
const videoLine = spend3.find((s) => s.note.includes('· video ·'));
check('both charges were reserved at the click', !!frameLine && !!videoLine,
  JSON.stringify(spend3.map((s) => `${s.credits}cr ${s.note}`)));
check('the frame reserved 4 credits', frameLine?.credits === 4, `${frameLine?.credits}`);
check('the video reserved the rest', videoLine?.credits === 248, `${videoLine?.credits}`);
check('the video reservation is held against the frame',
  a3[0]?.pending_spend_id === videoLine?.id, `${a3[0]?.pending_spend_id}`);

// The frame lands. This is the half of the approval that happens without anyone
// clicking anything.
outcome.set(a3[0].kie_task_id, 'success');
const p3 = await api(`/api/campaigns/${campaign.id}/assets`, { method: 'POST' });
check('polling is 200', p3.status === 200, JSON.stringify(await p3.clone().json()).slice(0, 160));

const after3 = await assetsFor(framed.id);
const videoAsset = after3.find((a) => a.role === 'ad');
check('the video was submitted once the frame existed', !!videoAsset,
  JSON.stringify(after3.map((a) => `${a.role}:${a.state}`)));
check('the video went to the video model', videoAsset?.kie_model === 'bytedance/seedance-2-fast',
  videoAsset?.kie_model);
const s3v = submits.find((s) => s.taskId === videoAsset?.kie_task_id);
check('the video opens on the frame that was just made',
  typeof s3v?.input?.first_frame_url === 'string' && s3v.input.first_frame_url.includes('/storage/'),
  s3v?.input?.first_frame_url);
check('the video was handed the camera move, not the scene',
  s3v?.input?.prompt?.startsWith('The camera pushes'), (s3v?.input?.prompt ?? '').slice(0, 40));

const { data: framedRow } = await db.from('ad_ideas')
  .select('status, source_image_url, source_image_generated').eq('id', framed.id).single();
check('the made picture is on the row', !!framedRow.source_image_url, framedRow.source_image_url);
check('and is labelled as made rather than photographed',
  framedRow.source_image_generated === true, `${framedRow.source_image_generated}`);
check('the ad is still being made, not called finished',
  framedRow.status === 'generating', framedRow.status);

const spendAfter3 = await spendFor();
check('the video reservation now points at the video',
  spendAfter3.find((s) => s.id === videoLine.id)?.asset_id === videoAsset?.id,
  `${spendAfter3.find((s) => s.id === videoLine.id)?.asset_id}`);

// ── 4. the frame fails, so the video is never bought ───────────────
console.log('\na video whose opening picture fails');
const r4 = await api(`/api/campaigns/${campaign.id}/ideas/${doomed.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b4 = await r4.json();
check('approve is 200', r4.status === 200, JSON.stringify(b4).slice(0, 180));
const a4 = await assetsFor(doomed.id);
const doomedSpend = (await spendFor()).filter((s) => s.asset_id === a4[0].id
  || s.id === a4[0].pending_spend_id);
check('two reservations were taken', doomedSpend.length === 2,
  `${doomedSpend.length}`);

outcome.set(a4[0].kie_task_id, 'fail');
const before = submits.length;
await api(`/api/campaigns/${campaign.id}/assets`, { method: 'POST' });

const a4after = await assetsFor(doomed.id);
check('no video was submitted', submits.length === before, `${submits.length - before} extra`);
check('nothing else was recorded against it', a4after.length === 1,
  JSON.stringify(a4after.map((a) => a.role)));
const spend4 = (await spendFor()).filter((s) => s.asset_id === a4[0].id
  || s.id === a4[0].pending_spend_id);
check('BOTH reservations came back', spend4.length === 0,
  JSON.stringify(spend4.map((s) => s.note)));
const { data: doomedRow } = await db.from('ad_ideas')
  .select('status, rejected_reason').eq('id', doomed.id).single();
check('the row says what happened', doomedRow.status === 'failed'
  && /opens on could not be made/.test(doomedRow.rejected_reason ?? ''),
  `${doomedRow.status}: ${(doomedRow.rejected_reason ?? '').slice(0, 90)}`);

// ── 5. the ceiling still stops all of it ───────────────────────────
console.log('\nthe ceiling');
await db.from('settings').upsert({ user_id: userId, campaign_spend_ceiling: 0.01 });
const { data: ceilingIdea } = await db.from('ad_ideas').insert(seed(2, {
  persona_id: personas2[0].id,
  media_type: 'video',
  kie_model: 'bytedance/seedance-2-fast',
  kie_prompt: 'move',
  generated_image_prompt: SCENE,
  video_storyboard: { beats: [], seconds: 10 },
  est_credits: 252, est_usd: 1.26,
})).select('id').single();
const beforeCeiling = submits.length;
const r5 = await api(`/api/campaigns/${campaign.id}/ideas/${ceilingIdea.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b5 = await r5.json();
check('refused', r5.status === 409, `${r5.status}`);
check('and said why', /ceiling/i.test(b5.error ?? ''), (b5.error ?? '').slice(0, 90));
check('nothing was submitted', submits.length === beforeCeiling,
  `${submits.length - beforeCeiling} extra`);
const { data: ceilingRow } = await db.from('ad_ideas')
  .select('status').eq('id', ceilingIdea.id).single();
check('the row is back where it was', ceilingRow.status === 'draft', ceilingRow.status);

// ── 6. and a row with nothing at all still refuses ─────────────────
console.log('\na video with neither a photograph nor a picture');
await db.from('settings').upsert({ user_id: userId, campaign_spend_ceiling: 150 });
const { data: emptyIdea } = await db.from('ad_ideas').insert(seed(3, {
  persona_id: personas2[0].id,
  media_type: 'video',
  kie_model: 'bytedance/seedance-2-fast',
  kie_prompt: 'move',
  video_storyboard: { beats: [], seconds: 10 },
  est_credits: 252, est_usd: 1.26,
})).select('id').single();
const beforeEmpty = submits.length;
const r6 = await api(`/api/campaigns/${campaign.id}/ideas/${emptyIdea.id}`, {
  method: 'POST', body: JSON.stringify({ action: 'approve' }),
});
const b6 = await r6.json();
check('refused', r6.status === 409, `${r6.status}`);
check('nothing was submitted', submits.length === beforeEmpty,
  `${submits.length - beforeEmpty} extra`);
check('and it reads as an instruction, not a stack trace',
  /nothing for the shot to move through/.test(b6.error ?? ''), (b6.error ?? '').slice(0, 100));

// ── clean up. Every row here is throwaway. ─────────────────────────
await db.from('campaigns').delete().eq('id', campaign.id);
await db.from('settings').delete().eq('user_id', userId);
await db.from('users').delete().eq('id', userId);
await db.auth.admin.deleteUser(userId);
kie.close();

console.log(`\n${failures ? `${failures} FAILED` : 'all good'} · `
  + `${submits.length} submits recorded, none of them real\n`);
process.exit(failures ? 1 : 0);
