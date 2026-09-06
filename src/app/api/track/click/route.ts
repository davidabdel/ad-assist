import { NextResponse } from 'next/server';
import { publicClient } from '@/lib/supabase';

export async function POST(req: Request) {
  try {
    const { personaId } = await req.json();
    if (typeof personaId !== 'string' || !personaId) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    await publicClient().rpc('bump_persona_click', { pid: personaId });
    return NextResponse.json({ ok: true });
  } catch {
    // A failed count must never surface to a buyer mid-funnel.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
