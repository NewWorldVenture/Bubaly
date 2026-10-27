import { NextRequest, NextResponse } from 'next/server';
import { settleAll } from '@/lib/supabase/settle';
import { getTranslations } from '@/lib/i18n/server';
import { requireMarketingAdmin, logMarketingAudit, isMarketingAuthError, marketingRefusalBody } from '@/lib/marketing/admin';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { CUSTOMER_FAMILY_CEILING, getMarketingCustomersWithError, summarizeCustomers } from '@/lib/marketing/customers';
import { fmtMoney } from '@/lib/utils/format';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { BASIC_MONTHLY_CENTS, BASIC_ANNUAL_CENTS, PLUS_MONTHLY_CENTS, PLUS_ANNUAL_CENTS } from '@/lib/constants/plans';
import { annualSavingsPct } from '@/lib/billing/plans';

export const runtime = 'nodejs';

type Task =
  | 'analyze' | 'campaign_plan' | 'seo_plan' | 'aeo_plan' | 'content_calendar'
  | 'email_draft' | 'sms_draft' | 'ad_copy' | 'landing_copy' | 'next_actions';

/** Segments and campaigns named in the context; one more is read to tell a full list from a prefix. */
const CONTEXT_LIST = 25;

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
  const t = await getTranslations();
  try {
    const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
    // No key: say so before any work, rather than let the provider's throw
    // reach the catch below as a generic failure.
    if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    const limited = await enforceAIRateLimit(supabase, `marketing-ai:${actorId}`, { limit: 20 });
    if (!limited.ok) return NextResponse.json(
      { error: t('ai.tooManyMarketingAiRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const contentLength = Number(req.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 16_000) {
      return NextResponse.json({ error: t('ai.requestIsTooLarge') }, { status: 413 });
    }

    const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: t('ai.requestBodyIsTooLarge') }, { status: 400 });
    const body = (boundedBody.value ?? null) as { task?: unknown; input?: unknown } | null;
    const task = body?.task;
    if (typeof task !== 'string' || !Object.prototype.hasOwnProperty.call(TASKS, task)) {
      return NextResponse.json({ error: t('ai.unknownTask') }, { status: 400 });
    }
    const taskKey = task as Task;
    const input = typeof body?.input === 'string' ? body.input.trim().slice(0, 4_000) || undefined : undefined;

    // Grounding context — real marketing data only. A read that failed is not
    // an empty business: the customer view answers no customers on any error,
    // and "Customers: 0 total ... Est. MRR $0.00", "Existing segments: none"
    // went to a model told to use ONLY this data. So a failed read answers 503
    // and asks the model nothing. A view that stopped at its ceiling is said
    // to be unavailable, never handed over as zero.
    const customerResult = await getMarketingCustomersWithError(supabase);
    const [segmentsResult, campaignsResult] = await settleAll([
      supabase.from('marketing_segments').select('id, name').is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id').limit(CONTEXT_LIST + 1),
      supabase.from('marketing_campaigns').select('id, name, channel, status').is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id').limit(CONTEXT_LIST + 1),
    ]);
    const groundingError = (customerResult.error && !customerResult.truncated ? customerResult.error : null)
      ?? segmentsResult.error ?? campaignsResult.error;
    if (groundingError) {
      console.error('[admin-marketing-ai] grounding read failed', groundingError);
      return NextResponse.json({ error: t('ai.marketingGroundingUnavailable') }, { status: 503 });
    }
    const m = summarizeCustomers(customerResult.customers);
    const segments = segmentsResult.data ?? [];
    const campaigns = campaignsResult.data ?? [];
    const listed = <T,>(rows: T[], render: (row: T) => string, noun: string) => {
      const shown = rows.slice(0, CONTEXT_LIST).map(render).join(', ') || 'none';
      return rows.length > CONTEXT_LIST ? `${shown} (the ${CONTEXT_LIST} newest ${noun}; more exist)` : shown;
    };
    const customerLines = customerResult.truncated
      ? [`Customers: figures unavailable. The platform is larger than the customer view reads (more than ${CUSTOMER_FAMILY_CEILING} families, or more members than it joins), so no customer count, lifecycle split, MRR or LTV is known. Do not estimate them.`]
      : [
        `Customers: ${m.total} total, ${m.paying} paying, ${m.newThisMonth} new this month, ${m.lapsed} lapsed/churned.`,
        `Lifecycle: new ${m.byLifecycle.new}, active ${m.byLifecycle.active}, lapsed ${m.byLifecycle.lapsed}, churned ${m.byLifecycle.churned}, free ${m.byLifecycle.free}.`,
        `Est. MRR ${fmtMoney(m.estMrrCents)}, est. lifetime value ${fmtMoney(m.estLtvCents)}.`,
      ];

    const context = [
      `Product: Bubaly — an AI family operating system (calendar, chores, meals, school, health, documents, AI assistant).`,
      `Pricing (USD): Family Basic ${fmtMoney(BASIC_MONTHLY_CENTS)}/month or ${fmtMoney(BASIC_ANNUAL_CENTS)}/year (${fmtMoney(BASIC_ANNUAL_CENTS / 12)}/month equivalent, billed annually; saves about ${annualSavingsPct(1)}% compared with monthly billing).`,
      `Family+ ${fmtMoney(PLUS_MONTHLY_CENTS)}/month or ${fmtMoney(PLUS_ANNUAL_CENTS)}/year (${fmtMoney(PLUS_ANNUAL_CENTS / 12)}/month equivalent, billed annually; saves about ${annualSavingsPct(2)}% compared with monthly billing).`,
      ...customerLines,
      `Existing segments: ${listed(segments, (s) => s.name, 'segments')}.`,
      `Existing campaigns: ${listed(campaigns, (c) => `${c.name} (${c.channel}/${c.status})`, 'campaigns')}.`,
    ].join('\n');

    const system = `You are a world-class marketing strategist embedded in the Bubaly admin. ${TASKS[taskKey]}

Use ONLY the real data provided as grounding. Never fabricate metrics, rankings, testimonials, or press. When you suggest keywords or audience sizes you cannot verify, label them clearly as estimates/suggestions. Respond in clean Markdown, concise and immediately usable.`;

    const userMsg = `DATA:\n${context}\n\n${input ? `REQUEST: ${input}` : 'Use the data above.'}`;

    const completion = await (await resolveProvider()).complete({ system, messages: [{ role: 'user', content: userMsg }], tools: [] });

    await logMarketingAudit(supabase, { actorId, actorEmail, action: `ai:${taskKey}`, resource: 'marketing_ai', metadata: { input: input?.slice(0, 200) ?? null } });

    return NextResponse.json({ text: completion.text });
  } catch (err) {
    // A refusal is not a fault, and it is not this route's to log as one: the
    // status now travels on the error rather than being read back out of its
    // English, which is why this used to answer 500 with "check that the OpenAI
    // API key is set" to a caller whose only problem was not being an admin.
    if (isMarketingAuthError(err)) {
      return NextResponse.json({ error: marketingRefusalBody(err) }, { status: err.status });
    }
    console.error('Marketing AI error:', err);
    return NextResponse.json({ error: 'Could not generate. Check that the OpenAI API key is set.' }, { status: 500 });
  }
}
