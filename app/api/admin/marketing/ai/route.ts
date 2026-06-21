import { NextRequest, NextResponse } from 'next/server';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { getProvider } from '@/lib/ai/provider';
import { getMarketingCustomers, summarizeCustomers } from '@/lib/marketing/customers';
import { fmtMoney } from '@/lib/utils/format';

export const runtime = 'nodejs';

type Task =
  | 'analyze' | 'campaign_plan' | 'seo_plan' | 'aeo_plan' | 'content_calendar'
  | 'email_draft' | 'sms_draft' | 'ad_copy' | 'landing_copy' | 'next_actions';

const TASKS: Record<Task, string> = {
  analyze: 'Analyze the customer base and growth. Summarize who the customers are, the biggest opportunities, and the top 3 risks. Be specific and reference the numbers provided.',
  campaign_plan: 'Produce a concrete marketing campaign plan: objective, target segment, channel mix, key messages, a 4-step schedule, and the 2-3 KPIs to watch. Ground it in the data provided.',
  seo_plan: 'Produce an SEO plan for Bubaly: priority topics/keywords (clearly labeled as suggestions), on-page recommendations for the existing pages, and a 30-day task list. Do not invent rankings, volumes, or backlinks.',
  aeo_plan: 'Produce an Answer Engine Optimization plan: the top customer questions to answer, the entity/FAQ structure, and structured-answer recommendations for ChatGPT/Perplexity/AI Overviews. No invented AI-engine rankings.',
  content_calendar: 'Produce a 4-week content calendar (blog, social, email) with titles, formats, and the funnel stage each piece targets.',
  email_draft: 'Draft a marketing email: subject line, preview text, and a concise, warm body with one clear CTA. Tailor it to the audience implied by the request.',
  sms_draft: 'Draft 2-3 compliant marketing SMS variants (<=160 chars each) with a clear CTA and an opt-out note.',
  ad_copy: 'Draft paid-ad copy: 3 headline variants (<=30 chars), 2 primary-text variants, and 1 description. Note the platform if specified.',
  landing_copy: 'Draft landing-page copy: hero headline, subhead, 3 benefit bullets, social-proof line (generic, not fabricated), and a CTA.',
  next_actions: 'Recommend the single best next action and the next 4 prioritized actions, each with the expected impact, grounded in the data.',
};

export async function POST(req: NextRequest) {
  try {
    const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
    const { task, input } = (await req.json()) as { task: Task; input?: string };
    if (!task || !TASKS[task]) return NextResponse.json({ error: 'Unknown task' }, { status: 400 });

    // Grounding context — real marketing data only.
    const customers = await getMarketingCustomers(supabase);
    const m = summarizeCustomers(customers);
    const [{ data: segments }, { data: campaigns }] = await Promise.all([
      supabase.from('marketing_segments').select('name, rules').is('deleted_at', null).limit(25),
      supabase.from('marketing_campaigns').select('name, channel, status').is('deleted_at', null).limit(25),
    ]);

    const context = [
      `Product: Bubaly — an AI family operating system (calendar, chores, meals, school, health, documents, AI assistant).`,
      `Pricing: one Family plan, $9.99/mo or $95.99/yr.`,
      `Customers: ${m.total} total, ${m.paying} paying, ${m.newThisMonth} new this month, ${m.lapsed} lapsed/churned.`,
      `Lifecycle: new ${m.byLifecycle.new}, active ${m.byLifecycle.active}, lapsed ${m.byLifecycle.lapsed}, churned ${m.byLifecycle.churned}, free ${m.byLifecycle.free}.`,
      `Est. MRR ${fmtMoney(m.estMrrCents)}, est. lifetime value ${fmtMoney(m.estLtvCents)}.`,
      `Existing segments: ${(segments ?? []).map((s) => s.name).join(', ') || 'none'}.`,
      `Existing campaigns: ${(campaigns ?? []).map((c) => `${c.name} (${c.channel}/${c.status})`).join(', ') || 'none'}.`,
    ].join('\n');

    const system = `You are a world-class marketing strategist embedded in the Bubaly admin. ${TASKS[task]}

Use ONLY the real data provided as grounding. Never fabricate metrics, rankings, testimonials, or press. When you suggest keywords or audience sizes you cannot verify, label them clearly as estimates/suggestions. Respond in clean Markdown, concise and immediately usable.`;

    const userMsg = `DATA:\n${context}\n\n${input ? `REQUEST: ${input}` : 'Use the data above.'}`;

    const completion = await getProvider().complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });

    await logMarketingAudit(supabase, { actorId, actorEmail, action: `ai:${task}`, resource: 'marketing_ai', metadata: { input: input?.slice(0, 200) ?? null } });

    return NextResponse.json({ text: completion.text });
  } catch (err) {
    console.error('Marketing AI error:', err);
    const msg = err instanceof Error && err.message.includes('Forbidden') ? 'Forbidden' : 'Could not generate. Check that ANTHROPIC_API_KEY is set.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
