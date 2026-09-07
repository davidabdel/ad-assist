import { z } from 'zod';
import { AuthError, requireOwner } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
import { slugify } from '@/lib/slug';
import { PRODUCT_TYPE_VALUES, spec } from '@/lib/product-type';

export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  product_type: z.enum(PRODUCT_TYPE_VALUES).default('ecom'),
  title: z.string().min(2),
  source_url: z.string().url().optional(),
  raw_input_text: z.string().min(40).optional(),
  source_file_url: z.string().url().optional(),
  uploaded_image_urls: z.array(z.string().url()).max(24).default([]),
  checkout_url: z.string().url().optional(),
  contact_phone: z.string().min(6).max(40).optional(),
  contact_name: z.string().max(120).optional(),
  current_offer: z.string().optional(),
  region: z.enum(['AU', 'US', 'GB', 'ALL']).default('AU'),
  media_split: z.object({ static: z.number(), video: z.number() })
    .default({ static: 2, video: 1 }),
}).refine((v) => v.source_url || v.raw_input_text || v.source_file_url, {
  message: 'Give me a product URL, an uploaded file, or pasted product text',
}).refine(
  // Mirrors the wizard's step 3. Enforced here as well because the wizard is
  // not the only caller — the verification recipe drives these routes directly,
  // and a vehicle campaign with no number is a set of pages with a dead CTA.
  (v) => v.product_type !== 'vehicle' || Boolean(v.contact_phone),
  { message: 'A vehicle or boat campaign needs a contact phone number — that is its call to action' },
).refine(
  (v) => v.product_type !== 'vehicle' || Boolean(v.source_url) || v.uploaded_image_urls.length > 0,
  {
    message: 'A typed vehicle description has no source of photographs. Upload at least one, '
      + 'or point the campaign at the listing page.',
  },
);

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

    const kind = spec(input.product_type);

    const { data, error } = await serviceClient().from('campaigns').insert({
      user_id: owner.id,
      product_type: input.product_type,
      title: input.title,
      slug: await freeSlug(input.title),
      source_url: input.source_url ?? null,
      raw_input_text: input.raw_input_text ?? null,
      source_file_url: input.source_file_url ?? null,
      uploaded_image_urls: input.uploaded_image_urls,
      checkout_url: input.checkout_url ?? null,
      contact_phone: input.contact_phone ?? null,
      contact_name: input.contact_name ?? null,
      current_offer: input.current_offer ?? null,
      region: input.region,
      media_split: input.media_split,
      // Frozen onto the row rather than read from the table at run time: a
      // campaign that is halfway through writing five pages must not silently
      // become a twenty-page campaign because the default moved under it.
      persona_target: kind.personaTarget,
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
      .select('id, title, slug, status, region, source_url, product_type, persona_target, '
        + 'error_message, created_at')
      .eq('user_id', owner.id)
      .order('created_at', { ascending: false });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ campaigns: data });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
