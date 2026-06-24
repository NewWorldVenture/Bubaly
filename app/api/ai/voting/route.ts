import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzePolls, buildVotingPrompt, parseVotingResponse } from '@/lib/voting/voting-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: polls } = await supabase
      .from('family_polls')
      .select('id, question, kind, status, closes_at')
      .eq('family_id', familyId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (!polls || polls.length === 0) {
      return NextResponse.json({ error: 'No polls to analyze' }, { status: 400 });
    }

    const pollIds = polls.map((p) => p.id);
    const { data: options } = await supabase
      .from('family_poll_options')
      .select('poll_id')
      .in('poll_id', pollIds);
    const { data: votes } = await supabase
      .from('family_poll_votes')
      .select('poll_id')
      .in('poll_id', pollIds);

    const optionCounts = new Map<string, number>();
    const voteCounts = new Map<string, number>();
    for (const o of options ?? []) optionCounts.set(o.poll_id, (optionCounts.get(o.poll_id) ?? 0) + 1);
    for (const v of votes ?? []) voteCounts.set(v.poll_id, (voteCounts.get(v.poll_id) ?? 0) + 1);

    const pollsForAI = polls.map((p) => ({
      question: p.question,
      kind: p.kind,
      status: p.status,
      closes_at: p.closes_at,
      option_count: optionCounts.get(p.id) ?? 0,
      vote_count: voteCounts.get(p.id) ?? 0,
    }));

    const analysis = analyzePolls(pollsForAI);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildVotingPrompt(pollsForAI);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseVotingResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Voting AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze polls' }, { status: 500 });
  }
}
