import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { verifyUnsubToken } from '@/lib/marketing/unsubscribe';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

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

  await supabase.from('marketing_suppressions').upsert({ email: clean, reason: 'unsubscribe' });
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
