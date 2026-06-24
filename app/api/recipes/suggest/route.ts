import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { resolveProvider } from '@/lib/ai/provider';
import { buildSuggestPrompt, parseSuggestions, type VaultRecipeLite } from '@/lib/recipes/suggest';

export const runtime = 'nodejs';

// "What can we make tonight?" — AI picks from the family's saved vault only, so
// every suggestion is actually cookable. Optional free-text constraint.
export async function POST(req: NextRequest) {
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const limit = rateLimit(`recipe-suggest:${ctx.user.id || clientIp(req.headers)}`, { limit: 15, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ error: 'Slow down a moment and try again.' }, { status: 429 });

  const { constraint } = await req.json().catch(() => ({})) as { constraint?: string };

  const supabase = await createServer();
  const { data: recipes } = await supabase
    .from('family_recipes')
    .select('id, name, cuisine, category, tags, ingredients, photo_url')
    .eq('family_id', ctx.active.familyId)
    .order('is_favorite', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(80);

  if (!recipes || recipes.length === 0) {
    return NextResponse.json({ picks: [], empty: true });
  }

  const lite: VaultRecipeLite[] = recipes.map((r) => ({
    id: r.id, name: r.name, cuisine: r.cuisine, category: r.category, tags: r.tags,
    ingredients: (r.ingredients as unknown as { name: string }[]) ?? [],
  }));

  let picks;
  try {
    const prompt = buildSuggestPrompt(lite, constraint);
    const provider = await resolveProvider();
    const completion = await provider.complete({ system: prompt.system, messages: [{ role: 'user', content: prompt.user }], tools: [], maxTokens: 600 });
    picks = parseSuggestions(completion.text, recipes.map((r) => r.id));
  } catch (err) {
    console.error('Recipe suggest error:', err);
    return NextResponse.json({ error: 'AI is temporarily unavailable.' }, { status: 502 });
  }

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const results = picks.map((p) => {
    const r = byId.get(p.id)!;
    return { id: r.id, name: r.name, cuisine: r.cuisine, category: r.category, photoUrl: r.photo_url, reason: p.reason };
  });
  return NextResponse.json({ picks: results });
}
