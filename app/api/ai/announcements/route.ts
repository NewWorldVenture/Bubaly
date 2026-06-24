import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeAnnouncements, buildAnnouncementsPrompt, parseAnnouncementsResponse } from '@/lib/announcements/announcements-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: items } = await supabase
      .from('family_announcements')
      .select('title, body, is_pinned, created_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(200);

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No announcements to analyze' }, { status: 400 });
    }

    const analysis = analyzeAnnouncements(items);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildAnnouncementsPrompt(items);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseAnnouncementsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Announcements AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze announcements' }, { status: 500 });
  }
}
