import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { parseFormFields, validateSubmission, submissionEmail, submissionName } from '@/lib/marketing/forms';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';

export const runtime = 'nodejs';

/**
 * Public marketing-form submission endpoint. Marketing tables have no client RLS
 * policies, so the form is read and the submission written with the service role.
 * Only active, non-deleted forms accept submissions. On success it fires any
 * active `form_submitted` automation workflow (best-effort, deduped per submission).
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const limit = rateLimit(`form:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many submissions. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  let body: { formId?: unknown; values?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
  const values = (body.values && typeof body.values === 'object') ? body.values as Record<string, unknown> : {};
  if (!formId) return NextResponse.json({ error: 'formId is required' }, { status: 422 });

  const supabase = createServiceClient();
  const { data: form } = await supabase
    .from('marketing_forms')
    .select('id, name, fields')
    .eq('id', formId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (!form) return NextResponse.json({ error: 'This form is no longer available.' }, { status: 404 });

  const fields = parseFormFields(form.fields);
  if (fields.length === 0) return NextResponse.json({ error: 'This form has no fields.' }, { status: 422 });

  const { ok, errors, cleaned } = validateSubmission(fields, values);
  if (!ok) return NextResponse.json({ error: 'Validation failed', fields: errors }, { status: 422 });

  const email = submissionEmail(fields, cleaned);
  const { data: inserted, error } = await supabase
    .from('marketing_form_submissions')
    .insert({ form_id: form.id, email, data: cleaned as never, source: 'public-form' })
    .select('id')
    .single();
  if (error || !inserted) {
    return NextResponse.json({ error: 'We couldn’t record your submission. Please try again.' }, { status: 500 });
  }

  // Fire any event-driven "form_submitted" automation workflows in real time.
  // Best-effort: never block the visitor on marketing automation.
  try {
    await fireAutomationEvent(createServiceClient(), {
      trigger: 'form_submitted',
      email,
      name: submissionName(fields, cleaned),
      subjectKey: eventSubjectKey('form_submitted', [form.id, inserted.id]),
      context: { source: 'marketing-form', formId: form.id, formName: form.name },
    });
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true });
}
