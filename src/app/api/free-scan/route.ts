import { createHmac } from 'node:crypto';
import { cookies } from 'next/headers';
import { ingestProductFromServer } from '@/lib/ingest/cloud';
import { publicUrl } from '@/lib/ingest/public-fetch';
import { serviceClient } from '@/lib/supabase';
import { trustedClientAddress } from '@/lib/client-address';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  const secret = process.env.FREE_SCAN_SECRET;
  if (!secret) return Response.json({ error: 'Free scans are not available yet. Please try again later.' }, { status: 503 });
  if (req.headers.get('origin') !== new URL(req.url).origin) {
    return Response.json({ error: 'Start your scan from this website.' }, { status: 403 });
  }
  let url: string;
  try {
    const text = await req.text();
    if (text.length > 4096) throw new Error('Address too long');
    const body = JSON.parse(text);
    url = publicUrl(body.url).href;
  } catch {
    return Response.json({ error: 'Enter a public product page address.' }, { status: 400 });
  }
  const ip = trustedClientAddress(req);
  if (!ip) return Response.json({ error: 'The scan service is temporarily unavailable.' }, { status: 503 });
  try {
    const key = createHmac('sha256', secret).update(ip).digest('hex');
    const db = serviceClient();
    const { data: allowed, error } = await db.rpc('reserve_free_scan', { p_key: key });
    if (error) throw error;
    if (!allowed) return Response.json({ error: 'The free scan limit has been reached. Please try again tomorrow.' }, { status: 429 });
    const { data: eventRow, error: eventError } = await db.from('product_events').insert({ kind: 'scan_started' }).select('id').single();
    if (eventError) throw eventError;
    const result = await ingestProductFromServer(url);
    if (!result.usable || !result.payload || result.payload.warnings.some(w => w.includes('redirected to the site homepage'))) {
      await db.from('product_events').update({ kind: 'scan_failed' }).eq('id',eventRow.id);
      return Response.json({ error: 'We could not read this product page. Check the link or try another product. Some stores block automated scans.' }, { status: 422 });
    }
    const { data: scan, error: saveError } = await db.from('free_scans')
      .insert({ source_url: url, payload: result.payload }).select('id').single();
    if (saveError) throw saveError;
    await db.from('product_events').update({ kind: 'scan_completed', scan_id: scan.id }).eq('id',eventRow.id);
    (await cookies()).set('adtocart-free-scan', scan.id, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 86400,
    });
    const p = result.payload;
    const s = p.structured;
    return Response.json({
      url, title: typeof s?.product_name === 'string' ? s.product_name.slice(0, 300) : p.page_title ?? 'Your product',
      brand: typeof s?.brand_name === 'string' ? s.brand_name.slice(0, 200) : null,
      price: typeof s?.price === 'number' ? s.price : null,
      currency: typeof s?.currency === 'string' ? s.currency.slice(0, 10) : null,
      imageCount: Array.isArray(s?.images) ? s.images.length : 0,
      reviewCount: p.reviews.length,
      description: p.markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(0, 700),
      warnings: [!p.reviews.length ? 'No readable customer reviews found. We will not invent testimonials.' : null,
        !s ? 'This preview is based on page text. Check the product details before continuing.' : null].filter(Boolean),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'The scan could not finish. Please try again shortly.' }, { status: 503 });
  }
}
