import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { verifyUnsubToken } from '@/lib/marketing/unsubscribe';

export const runtime = 'nodejs';

function page(title: string, body: string, ok: boolean): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#0a0f1a;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;text-align:center;padding:32px">
<div style="font-size:40px">${ok ? '✓' : '⚠️'}</div>
<h1 style="font-size:20px;margin:16px 0 8px">${title}</h1>
<p style="color:#9ca3af;line-height:1.6">${body}</p>
</div></body></html>`;
  return new NextResponse(html, { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function suppress(email: string, token: string): Promise<NextResponse> {
  const clean = email.trim().toLowerCase();
  if (!clean || !verifyUnsubToken(clean, token)) {
    return page('Invalid link', 'This unsubscribe link is invalid or has expired.', false);
  }
  await createServiceClient().from('marketing_suppressions').upsert({ email: clean, reason: 'unsubscribe' });
  return page('Unsubscribed', `${clean} will no longer receive marketing emails from Bubaly. Account and transactional emails are unaffected.`, true);
}

export async function GET(req: NextRequest) {
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const t = req.nextUrl.searchParams.get('t') ?? '';
  return suppress(e, t);
}

// One-click unsubscribe (RFC 8058: List-Unsubscribe-Post).
export async function POST(req: NextRequest) {
  const e = req.nextUrl.searchParams.get('e') ?? '';
  const t = req.nextUrl.searchParams.get('t') ?? '';
  return suppress(e, t);
}
