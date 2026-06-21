import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

    const { conversationId, message } = await req.json() as { conversationId: string; message: string };
    if (!message?.trim()) return NextResponse.json({ error: 'Message is required' }, { status: 400 });

    // Load conversation history
    const { data: history } = await supabase
      .from('ai_messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(40);

    // Load family context
    const [{ data: members }, { data: events }, { data: chores }] = await Promise.all([
      supabase.from('family_members').select('display_name, role').eq('family_id', familyId).eq('is_active', true),
      supabase.from('calendar_events').select('title, starts_at, category').eq('family_id', familyId)
        .gte('starts_at', new Date().toISOString()).order('starts_at').limit(10),
      supabase.from('chore_assignments').select('status').eq('family_id', familyId).in('status', ['todo', 'in_progress']),
    ]);

    const familyContext = [
      `Family: ${ctx.active.family.name}`,
      `Members: ${(members ?? []).map((m) => `${m.display_name} (${m.role})`).join(', ')}`,
      `Upcoming events (next 10): ${(events ?? []).map((e) => `${e.title} on ${e.starts_at.slice(0, 10)}`).join('; ') || 'none'}`,
      `Open chores: ${chores?.length ?? 0}`,
    ].join('\n');

    const messages: Anthropic.MessageParam[] = [
      ...((history ?? []).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))),
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: process.env.AI_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: `You are a helpful family assistant for Bubaly. You help families coordinate schedules, chores, meals, and more.

Current family context:
${familyContext}

Be concise, warm, and practical. When asked to create or plan things, describe what you'd do clearly.`,
      messages,
    });

    const assistantContent = response.content[0].type === 'text' ? response.content[0].text : '';

    // Persist both messages
    await supabase.from('ai_messages').insert([
      { family_id: familyId, conversation_id: conversationId, role: 'user', content: message },
      { family_id: familyId, conversation_id: conversationId, role: 'assistant', content: assistantContent },
    ]);

    return NextResponse.json({ content: assistantContent });
  } catch (err) {
    console.error('AI chat error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
