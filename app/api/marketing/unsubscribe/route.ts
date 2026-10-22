import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { verifyUnsubToken } from '@/lib/marketing/unsubscribe';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { canonicalMailbox } from '@/lib/server/canonical-mailbox';

export const runtime = 'nodejs';

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function page(title: string, body: string, ok: boolean, status = ok ? 200 : 400): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0f1a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;text-align:center;padding:32px">
<div style="font-size:40px">${ok ? '✓' : '⚠️'}</div>
<h1 style="font-size:20px;margin:16px 0 8px">${escapeHtml(title)}</h1>
<p style="color:#9ca3af;line-height:1.6">${escapeHtml(body)}</p>
</div></body></html>`;
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function suppress(email: string, token: string, req: NextRequest): Promise<NextResponse> {
  const clean = email.trim().toLowerCase();
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `unsubscribe:${clientIp(req.headers)}`, { limit: 30 });
  if (!limited.ok) {
    const response = page('Please try again later', 'Too many unsubscribe requests were received. Please try again shortly.', false, 429);
    response.headers.set('Retry-After', String(limited.retryAfter));
    return response;
  }

  if (!clean || clean.length > 320 || !/^[0-9a-f]{64}$/i.test(token)) {
    return page('Invalid link', 'This unsubscribe link is invalid or has expired.', false);
  }

  try {
    if (!verifyUnsubToken(clean, token)) {
      return page('Invalid link', 'This unsubscribe link is invalid or has expired.', false);
    }
  } catch {
    return page('Link unavailable', 'The unsubscribe service is not configured yet.', false, 503);
  }

  // This upsert IS the unsubscribe — lib/marketing/send.ts excludes an address
  // only by finding its row here. Its result was discarded while the page below
  // promises, unconditionally and with a tick, that the address "will no longer
  // receive marketing emails". A refused write therefore sent someone away
  // believing they had opted out, and the next campaign mailed them anyway.
  //
  // The rest of this subsystem already treats that write as load-bearing, which
  // is what makes the omission stand out rather than read as house style:
  // send.ts THROWS and abandons the whole send if it cannot read suppressions,
  // and the Resend webhook answers 503 so a bounce or complaint is retried. The
  // only path that did not check was the one where a person is told something.
  //
  // Status matters here beyond the HTML. POST is the RFC 8058 one-click
  // endpoint, and a 2xx is what tells Gmail or Yahoo the opt-out was honoured;
  // answering 200 on a failed write spends the provider's only signal on a
  // promise that was not kept.
  //
  // THE INBOX IS RECORDED TOO. The automation sender looks an address up under
  // its spelling and its canonical inbox (lib/marketing/automation-steps.ts),
  // and this used to store only the spelling that was mailed. So an opt-out
  // clicked in a mail to `victim+news@gmail.com` stopped that spelling and
  // nothing else: a public form could reach the same inbox the next day as
  // `victim@gmail.com` or `victim+other@gmail.com`. The signed link proves
  // control of the inbox the mail was delivered to, which is what the
  // canonical form names, so the opt-out is recorded for it as well. It never
  // relabels a row the inbox already has (a bounce or a complaint stays one).
  const failed = (error: unknown) => {
    console.error('[unsubscribe] suppression write failed', error);
    return page(
      'Unsubscribe not completed',
      'We could not record your request just now, so you may still receive marketing email. Please open this link again in a few minutes.',
      false,
      503,
    );
  };
  const { error } = await supabase.from('marketing_suppressions').upsert({ email: clean, reason: 'unsubscribe' });
  if (error) return failed(error);
  const inbox = canonicalMailbox(clean);
  if (inbox !== clean) {
    // An insert, not an upsert: a row the inbox already has (`email` is the
    // key) answers 23505, which is the outcome this write exists for — and it
    // keeps that row's own reason. Any other error is a failure.
    const { error: inboxError } = await supabase
      .from('marketing_suppressions')
      .insert({ email: inbox, reason: 'unsubscribe' })
      .select('email');
    if (inboxError && inboxError.code !== '23505') return failed(inboxError);
  }
  return page('Unsubscribed', `${clean} will no longer receive marketing emails from Bubaly. Account and transactional emails are unaffected.`, true);
}

export async function GET(req: NextRequest) {
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const t = req.nextUrl.searchParams.get('t') ?? '';
  return suppress(e, t, req);
}

// One-click unsubscribe (RFC 8058: List-Unsubscribe-Post).
export async function POST(req: NextRequest) {
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const t = req.nextUrl.searchParams.get('t') ?? '';
  return suppress(e, t, req);
}
