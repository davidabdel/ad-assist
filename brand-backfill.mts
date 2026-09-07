// One-off: give an existing campaign the brand it was built before we could read one.
import { createClient } from '@supabase/supabase-js';
import { readBrand } from './src/lib/pipeline/brand';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const slug = process.argv[2];
const { data: c, error } = await db.from('campaigns')
  .select('id, slug, source_url, brand').eq('slug', slug).maybeSingle();
if (error || !c) throw new Error(`no campaign ${slug}: ${error?.message}`);
console.log('campaign', c.id, c.source_url, 'brand already set:', Boolean(c.brand));
if (!c.source_url) throw new Error('no source_url on this campaign');

const { brand, branded } = await readBrand(c.source_url);
console.log('branded:', branded, brand.primary, brand.accent, brand.google_fonts, brand.logo_url);
const { error: upErr } = await db.from('campaigns').update({ brand }).eq('id', c.id);
if (upErr) throw new Error(upErr.message);
console.log('written.');

// Prove the RPC serves it, which is the only path the public pages use.
const { data: page, error: rpcErr } = await db.rpc('get_public_page', {
  campaign_slug: slug, persona_slug: null,
});
if (rpcErr) throw new Error(`get_public_page: ${rpcErr.message}`);
console.log('rpc brand:', JSON.stringify((page as Record<string, unknown>).brand)?.slice(0, 220));
