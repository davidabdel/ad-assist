import { timingSafeEqual } from 'node:crypto';
import { serviceClient } from '@/lib/supabase';
import { advance } from '@/lib/pipeline/advance';

export const dynamic = 'force-dynamic';
/**
 * Long enough to carry a campaign through several units in one visit. A single
 * unit's ceiling is a five-persona batch at about seventy seconds, so this is
 * three or four of them — and the budget below stops well short of it so the
 * driver lock is always released properly rather than by expiry.
 */
export const maxDuration = 300;

/**
 * Drive every campaign that has somewhere to go, from the server.
 *
 * THIS EXISTS BECAUSE THE ENGINE WAS IN THE BROWSER. `advance()` does one unit
 * per call and something has to keep calling it; until now that something was
 * the open tab. Lock a phone and the tab freezes mid-wait — no error, no
 * warning — and the run stops until somebody looks at the screen again. David
 * hit it on a phone on 2026-09-10, twice in one evening: a campaign with its
 * pages written sat still for an hour, and a scan that had finished sat unnoticed
 * because nothing asked whether it had.
 *
 * Nothing about the pipeline needed a browser. Every unit is idempotent, and
 * `campaigns.status` plus what rows exist IS the progress — there is no
 * in-memory state anywhere. So the tab is now one driver among two rather than
 * the only one, and neither can stop the other: `advance()` takes a per-campaign
 * lock, so a tick that arrives mid-unit reports "waiting" and leaves.
 *
 * WHAT POKES IT. Vercel's own scheduler is the obvious answer and is closed to
 * us: this project is on the Hobby plan, where a cron job fires once a DAY. So
 * the poker is the Mac-side worker (`scanner/src/worker.js`), which polls every
 * few seconds anyway and is already compulsory for the ad-library scan — the
 * engine moves from the phone to the machine that was already load-bearing,
 * rather than to a new dependency. On Pro this becomes a `vercel.json` cron
 * against this same path and nothing else changes, which is why the auth below
 * accepts Vercel's own header format.
 *
 * IT DOES NOT SKIP THE APPROVAL GATE. A campaign at `base_review` with its page
 * already written is left alone, exactly as a tab would leave it. The tick
 * writes pages; a person still approves them.
 */

/**
 * Every status `advance()` can move forward from. Not a list of "busy" states —
 * `scanning` sits here waiting on the Mac and does nothing for minutes at a
 * time, and it has to be visited anyway, because noticing the scan FINISHED is
 * itself a unit of work that only happens when somebody asks.
 */
const DRIVABLE = [
  'pending', 'scraping', 'base_review', 'images', 'personas',
  'pages_built', 'scanning', 'extracting', 'writing_ideas',
  // Finished, and here anyway. A campaign that reached `ideas_ready` before the
  // generated pictures existed is sitting on ads that can never be made, and
  // `advance()` heals it by rewinding to `writing_ideas` — but only if something
  // visits. Every finished campaign with nothing to heal is filtered out below,
  // so this costs one query per tick rather than a visit per campaign.
  'ideas_ready',
];

/**
 * Stop starting new units after this. Short of `maxDuration` on purpose: a
 * function killed at its ceiling never runs its `finally`, so it leaves the
 * driver lock held until the five-minute expiry, and the screen spends those
 * five minutes reporting that something else is working on the campaign.
 */
const BUDGET_MS = 200_000;

/** How many campaigns one visit will touch. Single-operator; this is headroom. */
const MAX_CAMPAIGNS = 5;

function authorised(req: Request): boolean {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const offered = match[1].trim();

  // CRON_SECRET first because that is what Vercel Cron sends by itself, so
  // setting it is the whole of switching the poker over. Falling back to the
  // service role key is what lets the Mac worker call this with no new
  // configuration at either end: it already holds that key, and so does Vercel.
  // It is never in the browser bundle, and it already grants far more than this
  // route does.
  const accepted = [process.env.CRON_SECRET, process.env.SUPABASE_SERVICE_ROLE_KEY]
    .filter((s): s is string => Boolean(s));

  return accepted.some((secret) => {
    const a = Buffer.from(offered);
    const b = Buffer.from(secret);
    // timingSafeEqual throws on a length mismatch, which would itself leak the
    // length. Compare the lengths separately and always run the comparison.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

type Driven = {
  id: string;
  title: string;
  from: string;
  to: string;
  /** How many units this visit got through. */
  units: number;
  /** Why it stopped: the run is over, the Mac has it, or time ran out. */
  stopped: 'terminal' | 'waiting' | 'budget';
  /** The last thing it said, in the operator's words. */
  last: string;
};

async function tick(only?: string): Promise<Response> {
  const db = serviceClient();
  const startedAt = Date.now();

  let query = db.from('campaigns')
    .select('*').in('status', DRIVABLE);
  // One campaign rather than everything with somewhere to go. Nothing needs
  // this in normal running — the poker has no idea which campaigns exist — but
  // a check that drove every drivable row would drive the real ones, with real
  // model calls, on somebody's real account.
  if (only) query = query.eq('id', only);

  const { data: rows, error } = await query
    // Oldest movement first. A campaign that has been sitting is the one most
    // likely to be the stuck one, and it must not be starved by a busy
    // neighbour that keeps re-sorting itself to the front.
    .order('updated_at', { ascending: true })
    .limit(MAX_CAMPAIGNS);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let candidates = rows ?? [];

  // The approval gate, honoured here rather than discovered a unit later.
  // `advance()` would return terminal for these anyway, but only after a read
  // per campaign per tick — and with the Mac poking every ten seconds, a
  // campaign parked at approval for a week is a lot of nothing.
  const parked = candidates.filter((c) => c.status === 'base_review').map((c) => c.id);
  if (parked.length) {
    const { data: written } = await db.from('base_pages')
      .select('campaign_id').in('campaign_id', parked);
    const waitingOnHim = new Set((written ?? []).map((r) => r.campaign_id as string));
    candidates = candidates.filter((c) => !waitingOnHim.has(c.id));
  }

  // The same idea for finished campaigns. `ideas_ready` is drivable only so that
  // one with unmakeable ads can rewind and fix them; one with nothing to fix
  // would otherwise be read, found terminal and dropped every ten seconds for
  // the rest of its life. Ask once, for all of them, and keep only the ones with
  // an ad that has neither a photograph nor a picture described.
  const finished = candidates.filter((c) => c.status === 'ideas_ready').map((c) => c.id);
  if (finished.length) {
    const { data: unmakeable } = await db.from('ad_ideas')
      .select('campaign_id').in('campaign_id', finished).is('superseded_at', null)
      .is('source_image_url', null).is('generated_image_prompt', null)
      .in('status', ['draft', 'rejected', 'failed']);
    const needsHealing = new Set((unmakeable ?? []).map((r) => r.campaign_id as string));
    candidates = candidates.filter((c) => c.status !== 'ideas_ready' || needsHealing.has(c.id));
  }

  const driven: Driven[] = [];

  for (const campaign of candidates) {
    if (Date.now() - startedAt > BUDGET_MS) break;

    const entry: Driven = {
      id: campaign.id,
      title: campaign.title,
      from: campaign.status,
      to: campaign.status,
      units: 0,
      stopped: 'budget',
      last: '',
    };

    // Units, until this campaign has nowhere to go. `waiting` means the next
    // move belongs to the Mac-side worker or to another driver — either way
    // this visit is done, and the next poke will find out whether it has moved.
    for (;;) {
      let result;
      try {
        result = await advance(campaign);
      } catch (e) {
        // A thrown unit is not a failed campaign — `advance()` records the ones
        // that are. This is the network, the model timing out, a deploy landing
        // mid-call. Leave the row alone and let the next tick try again.
        entry.last = `stopped on an error: ${(e as Error).message}`;
        entry.stopped = 'terminal';
        break;
      }
      entry.units += 1;
      entry.to = result.status;
      entry.last = result.did;

      if (result.terminal) { entry.stopped = 'terminal'; break; }
      if (result.waiting) { entry.stopped = 'waiting'; break; }
      if (Date.now() - startedAt > BUDGET_MS) { entry.stopped = 'budget'; break; }

      // The row is re-read inside advance() under the lock, so the stale status
      // on this object cannot cause a stage to run twice. Kept in step anyway
      // so the loop's own bookkeeping is honest.
      campaign.status = result.status;
    }

    if (entry.units) driven.push(entry);
  }

  return Response.json({
    driven,
    looked_at: candidates.length,
    took_ms: Date.now() - startedAt,
  });
}

export async function POST(req: Request) {
  if (!authorised(req)) return Response.json({ error: 'Not authorised' }, { status: 401 });
  // Optional, and absent in normal running: the worker pokes this with no body
  // at all.
  const body = await req.json().catch(() => null) as { campaign_id?: string } | null;
  return tick(body?.campaign_id);
}

/** Vercel Cron issues a GET. Same work, same secret. */
export async function GET(req: Request) {
  if (!authorised(req)) return Response.json({ error: 'Not authorised' }, { status: 401 });
  return tick();
}
