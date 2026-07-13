import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

export const runtime = 'nodejs';

// GIF search proxy for the Messages GIF picker. The Giphy key stays server-side
// (never ships to the client); signed-in users only. Honest key-gating: without
// GIPHY_API_KEY the route answers 503 and the picker shows "not configured"
// instead of a dead "coming soon" toast — same pattern as Maps/Stripe/Issuing.
type GifResult = { id: string; title: string; previewUrl: string; url: string; width: number; height: number };

export async function GET(req: NextRequest) {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const limited = await enforceRequestRateLimit(supabase, `gif-search:${auth.user.id}`, { limit: 60 });
  if (!limited.ok) return NextResponse.json(
    { error: 'Too many GIF searches. Please try again shortly.' },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const key = process.env.GIPHY_API_KEY;
  if (!key) return NextResponse.json({ error: 'GIF search isn’t configured yet.' }, { status: 503 });

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
  const endpoint = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=24&rating=pg`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=24&rating=pg`;

  try {
    const res = await fetchExternal(endpoint, { next: { revalidate: 60 } }, 10_000);
    if (!res.ok) return NextResponse.json({ error: 'GIF search failed.' }, { status: 502 });
    const json = await readBoundedResponseJson<{ data?: Array<{ id: string; title?: string; images?: Record<string, { url?: string; width?: string; height?: string }> }> }>(res, 2 * 1024 * 1024);
    const gifs: GifResult[] = (json.data ?? []).flatMap((g) => {
      const preview = g.images?.fixed_width_small ?? g.images?.fixed_width;
      const full = g.images?.fixed_width ?? g.images?.original;
      if (!preview?.url || !full?.url) return [];
      return [{
        id: g.id, title: g.title ?? 'GIF', previewUrl: preview.url, url: full.url,
        width: Number(full.width ?? 200), height: Number(full.height ?? 200),
      }];
    });
    return NextResponse.json({ gifs });
  } catch {
    return NextResponse.json({ error: 'GIF search failed.' }, { status: 502 });
  }
}
