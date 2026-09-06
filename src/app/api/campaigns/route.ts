import { z } from 'zod';
import { AuthError, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { slugify } from '@/lib/slug';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  title: z.string().min(2),
  source_url: z.string().url().optional(),
  raw_input_text: z.string().min(40).optional(),
  checkout_url: z.string().url().optional(),
  current_offer: z.string().optional(),
  region: z.enum(['AU', 'US', 'GB', 'ALL']).default('AU'),
  media_split: z.object({ static: z.number(), video: z.number() })
    .default({ static: 2, video: 1 }),
}).refine((v) => v.source_url || v.raw_input_text, {
  message: 'Give me either a product URL or pasted product text',
});

/** Campaign slugs are global (they are the first path segment of every live page). */
async function freeSlug(title: string): Promise<string> {
  const db = serviceClient();
  const base = slugify(title);
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const { data } = await db.from('campaigns').select('id').eq('slug', candidate).maybeSingle();
    if (!data) return candidate;
  }
  throw new Error(`could not find a free campaign slug for "${title}"`);
}

export async function POST(req: Request) {
  try {
    const owner = await requireOwner(req);
    const parsed = CreateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ error: z.treeifyError(parsed.error) }, { status: 400 });
    }
    const input = parsed.data;

    const { data, error } = await serviceClient().from('campaigns').insert({
      user_id: owner.id,
      title: input.title,
      slug: await freeSlug(input.title),
      source_url: input.source_url ?? null,
      raw_input_text: input.raw_input_text ?? null,
      checkout_url: input.checkout_url ?? null,
      current_offer: input.current_offer ?? null,
      region: input.region,
      media_split: input.media_split,
      status: 'pending',
    }).select().single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({
      campaign: data,
      next: `POST /api/campaigns/${data.id}/advance to start the pipeline`,
    }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const owner = await requireOwner(req);
    const { data, error } = await serviceClient().from('campaigns')
      .select('id, title, slug, status, region, source_url, error_message, created_at')
      .eq('user_id', owner.id)
      .order('created_at', { ascending: false });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ campaigns: data });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
