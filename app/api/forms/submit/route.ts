import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { parseFormFields, validateSubmission, submissionEmail, submissionName } from '@/lib/marketing/forms';
import { firePublicFormSubmitted } from '@/lib/marketing/public-form-automation';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { describeReadError } from '@/lib/supabase/settle';
import { isUuid } from '@/lib/utils/validation';

export const runtime = 'nodejs';
const MAX_FORM_REQUEST_BYTES = 65_536;

/**
 * Public marketing-form submission endpoint. Marketing tables have no client RLS
 * policies, so the form is read and the submission written with the service role.
 * Only active, non-deleted forms accept submissions. On success it fires any
 * active `form_submitted` automation workflow (best-effort, deduped per submission,
 * and at most one mail per inbox a day — see lib/marketing/public-form-automation.ts).
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `form:${ip}`, { limit: 10 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('submit.tooManySubmissionsPleaseTry') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, MAX_FORM_REQUEST_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Invalid request body' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = parsedBody.value && typeof parsedBody.value === 'object'
    ? parsedBody.value as { formId?: unknown; values?: unknown }
    : {};

  const formId = typeof body.formId === 'string' ? body.formId.trim() : '';
  const values = (body.values && typeof body.values === 'object') ? body.values as Record<string, unknown> : {};
  if (!formId) return NextResponse.json({ error: t('submit.formidIsRequired') }, { status: 422 });
  // A form id is a uuid; anything else names no form. Handed to the uuid column
  // it made Postgres refuse (22P02), which read below as a failed read: an
  // error log line and a 503 "temporarily unavailable" for a bad request, from
  // any anonymous caller, ten times a minute per address. Refused as the
  // caller's own malformed input, before any read — the page for the same forms
  // already guards this way (app/(marketing)/f/[id]/page.tsx) — keeping the 404
  // for a well-formed id that names nothing and the 503 for a read that
  // genuinely failed. Audit N11.
  if (!isUuid(formId)) return NextResponse.json({ error: t('submit.thatFormIdIsNotValid') }, { status: 422 });

  // A refused read left the binding null and took the same branch as a row
  // that genuinely is not there, so the caller was told their own form
  // does not exist. "Not found" is a claim about their data; it has to come
  // from an answer, not from the absence of one. Fails closed either way —
  // this changes WHICH closed answer is given, not whether one is. C1-S9-38.
  const { data: form, error: formError } = await supabase
    .from('marketing_forms')
    .select('id, name, fields')
    .eq('id', formId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle();
  if (formError) {
    console.error('[forms/submit] form read failed', { formId, error: describeReadError(formError) });
    return NextResponse.json({ error: t('submit.thisFormIsTemporarilyUnavailable') }, { status: 503 });
  }
  if (!form) return NextResponse.json({ error: t('submit.thisFormIsNoLonger') }, { status: 404 });

  const fields = parseFormFields(form.fields);
  if (fields.length === 0) return NextResponse.json({ error: t('submit.thisFormHasNoFields') }, { status: 422 });

  const { ok, errors, cleaned } = validateSubmission(fields, values);
  if (!ok) return NextResponse.json({ error: t('submit.validationFailed'), fields: errors }, { status: 422 });

  const email = submissionEmail(fields, cleaned);
  const { data: inserted, error } = await supabase
    .from('marketing_form_submissions')
    .insert({ form_id: form.id, email, data: cleaned as never, source: 'public-form' })
    .select('id')
    .single();
  if (error || !inserted) {
    return NextResponse.json({ error: t('submit.weCouldnTRecordYour') }, { status: 500 });
  }

  // Fire any event-driven "form_submitted" automation workflows in real time.
  // Best-effort: never block the visitor on marketing automation. The address
  // is unverified, so the mail is bounded per inbox and carries no text of the
  // caller's (lib/marketing/public-form-automation.ts).
  try {
    await firePublicFormSubmitted({
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
