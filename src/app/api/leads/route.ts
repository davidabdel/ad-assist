import { z } from 'zod';
import { serviceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * THE ONLY UNAUTHENTICATED WRITE IN THE APP.
 *
 * It has to be: the person filling this in is a stranger who arrived from an
 * ad. So it is deliberately narrow — one table, four fields, and every one of
 * them length-capped both here and in the schema.
 *
 * Why a route rather than an anon-callable RPC: 0005 closed the anon write
 * surface on purpose, and the anon key ships in the browser on every public
 * page. Writing through the service role behind this check means the rules
 * cannot be bypassed by calling PostgREST directly with the same key.
 *
 * campaign_id is checked against a real campaign before anything is written, so
 * a made-up id gets a 404 rather than an orphan row, and persona_id is only
 * accepted when it genuinely belongs to that campaign — which is what makes
 * "which page produced this enquiry" trustworthy rather than decorative.
 */

const LeadSchema = z.object({
  campaign_id: z.string().uuid(),
  persona_id: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  /** Honeypot. Never filled by a person, because a person cannot see it. */
  website: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = LeadSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { error: 'Please check the name and phone number, then try again.' },
        { status: 400 },
      );
    }
    const input = parsed.data;

    // Answer 200 to the bot. Telling it what tripped the trap is how the next
    // one gets past it, and the seller never sees the row either way.
    if (input.website?.trim()) return Response.json({ ok: true });

    const db = serviceClient();
    const { data: campaign, error: lookupError } = await db.from('campaigns')
      .select('id').eq('id', input.campaign_id).maybeSingle();
    if (lookupError) return Response.json({ error: lookupError.message }, { status: 500 });
    if (!campaign) return Response.json({ error: 'That page is no longer live.' }, { status: 404 });

    let personaId: string | null = null;
    if (input.persona_id) {
      const { data: persona } = await db.from('personas')
        .select('id').eq('id', input.persona_id).eq('campaign_id', input.campaign_id).maybeSingle();
      // A mismatch is dropped rather than rejected: the enquiry is real and
      // losing it over a stale page id would be the wrong trade.
      personaId = persona?.id ?? null;
    }

    const { error } = await db.from('leads').insert({
      campaign_id: input.campaign_id,
      persona_id: personaId,
      name: input.name,
      phone: input.phone,
      email: input.email ?? null,
      message: input.message ?? null,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 400) || null,
    });
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true }, { status: 201 });
  } catch {
    return Response.json({ error: 'That did not send. Try again.' }, { status: 500 });
  }
}
