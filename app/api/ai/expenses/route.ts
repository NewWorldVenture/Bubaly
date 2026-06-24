import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeExpenses, buildExpensesPrompt, parseExpensesResponse } from '@/lib/finance/expenses-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: expenses } = await supabase
      .from('expense_splits')
      .select('description, total_cents, category, spent_on')
      .eq('family_id', familyId)
      .order('spent_on', { ascending: false })
      .limit(100);

    if (!expenses || expenses.length === 0) {
      return NextResponse.json({ error: 'No expenses to analyze' }, { status: 400 });
    }

    const analysis = analyzeExpenses(expenses);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildExpensesPrompt(expenses);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseExpensesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Expenses AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze expenses' }, { status: 500 });
  }
}
