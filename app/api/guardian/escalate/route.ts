// app/api/guardian/escalate/route.ts
// Emergency escalation endpoint — the internal HTTP face of
// lib/guardian/escalate.ts, which the inbound SMS, WhatsApp and screening flows
// also call directly. Notifies every manager (parent + adult) via push + SMS +
// attempted outbound call.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { guardianEscalationSchema } from '@/lib/guardian/escalation';
import { escalateGuardianEmergency } from '@/lib/guardian/escalate';
import { bearerMatches } from '@/lib/server/secret-compare';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  // Internal only — verify with shared secret. Fail CLOSED: this endpoint can
  // blast SMS + outbound calls to every parent, so an unset secret must mean
  // "disabled", never "open". (CRON_SECRET is the deploy-wide fallback.)
  const secret = process.env.GUARDIAN_INTERNAL_SECRET || process.env.CRON_SECRET;
  if (!bearerMatches(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: tr('escalate.unauthorized') }, { status: 401 });
  }

  const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid JSON' }, { status: 400 });
  const parsed = guardianEscalationSchema.safeParse(boundedBody.value);
  if (!parsed.success) return NextResponse.json({ error: tr('escalate.invalidEscalationPayload') }, { status: 400 });

  const outcome = await escalateGuardianEmergency(createServiceClient(), parsed.data);
  switch (outcome.kind) {
    // The claim could not be written, so nothing here has been recorded. A 200
    // would tell the caller this succeeded and it would never retry; a 503
    // asks it to come back. Silence is the one answer that loses the event.
    case 'claim_unavailable': return NextResponse.json({ error: 'Escalation claim unavailable' }, { status: 503 });
    case 'duplicate': return NextResponse.json({ ok: true, duplicate: true });
    case 'read_failed':
    case 'record_failed': return NextResponse.json({ error: tr('escalate.unableToProcessEscalation') }, { status: 500 });
    // Nobody was reached by SMS or call. Not `ok`: the claim was given back so
    // the caller's retry is processed rather than answered as a duplicate.
    case 'undelivered': return NextResponse.json({ ok: false, delivered: false, pushSent: outcome.pushSent, notifiedCount: 0 }, { status: 503 });
    case 'delivered': {
      const { pushSent, smsSent, callAttempted, notifiedCount } = outcome;
      return NextResponse.json({ ok: true, pushSent, smsSent, callAttempted, notifiedCount });
    }
  }
}
