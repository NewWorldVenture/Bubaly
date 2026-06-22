import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { searchAllProviders } from '@/lib/recipes/providers';

export const runtime = 'nodejs';

// Server-side recipe discovery search. Provider API keys never reach the client;
// all external calls happen here. Auth-gated + rate-limited.
export async function GET(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const limit = rateLimit(`recipes:${ctx.user.id || clientIp(req.headers)}`, { limit: 30, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ error: 'Slow down a moment and try again.' }, { status: 429 });

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ recipes: [] });

  try {
    const recipes = await searchAllProviders(q, { limit: 24 });
    // Strip raw payloads from the search response (kept only on save).
    return NextResponse.json({ recipes: recipes.map(({ raw: _raw, ...r }) => r) });
  } catch (err) {
    console.error('Recipe search error:', err);
    return NextResponse.json({ error: 'Recipe search is temporarily unavailable.' }, { status: 502 });
  }
}
