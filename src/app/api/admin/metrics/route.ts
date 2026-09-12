import { requireAdmin } from '@/lib/admin';
import { AuthError } from '@/lib/auth';
import { serviceClient } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const p = new URL(req.url).searchParams;
    const sort = p.get('sort') ?? 'newest';
    const days = Number(p.get('days') ?? 30), page = Number(p.get('page') ?? 0), user = p.get('user');
    if (!['newest','cost','mrr'].includes(sort) || ![7,30,90,365].includes(days) || !Number.isInteger(page) || page<0 || page>100000 || (user && !/^[a-f0-9-]{36}$/i.test(user))) return Response.json({ error: 'Invalid filters' }, { status: 400 });
    const { data, error } = await serviceClient().rpc('admin_metrics', { p_days: days, p_search: (p.get('search') ?? '').slice(0,200), p_page: page, p_user: user, p_sort: sort });
    if (error) throw error;
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
  } catch (e) { return Response.json({ error: e instanceof AuthError ? e.message : 'Dashboard data unavailable. Check migrations and database connectivity.' }, { status: e instanceof AuthError ? e.status : 503, headers: { 'Cache-Control': 'no-store' } }); }
}
