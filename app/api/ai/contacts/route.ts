import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured } from '@/lib/ai/provider';
import { resolveProvider } from '@/lib/ai/provider';
import { analyzeContacts, buildContactsPrompt, parseContactsResponse } from '@/lib/contacts/ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: contacts } = await supabase
      .from('family_contacts')
      .select('name, category, is_emergency, phone, email')
      .eq('family_id', familyId)
      .limit(200);

    if (!contacts || contacts.length === 0) {
      return NextResponse.json({ error: 'No contacts to analyze' }, { status: 400 });
    }

    const analysis = analyzeContacts(contacts);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildContactsPrompt(contacts);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseContactsResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Contacts AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze contacts' }, { status: 500 });
  }
}
