import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import {
  recordConsentEvents, getConsentState, toConsentCategory,
  type ConsentCategory, type ConsentDecision,
} from '@/lib/marketing/consent';

export const runtime = 'nodejs';

// Public first-party consent write path for the cookie banner / preference
// center. The visitor supplies their anonymous id and a map of category →
// boolean; each is appended as an immutable, timestamped, versioned decision.
// Returns the resolved current state. Service-role — only writes consent rows
// keyed by the anonymous id.
type ConsentBody = {
  anonymousId?: string;
  consents?: Record<string, boolean>;
  source?: string | null;
  gpc?: boolean;
};

export async function POST(req: NextRequest) {
  let body: ConsentBody;
  try { body = (await req.json()) as ConsentBody; }
  catch { return NextResponse.json({ error: 'Bad payload' }, { status: 400 }); }

  const anonymousId = typeof body.anonymousId === 'string' ? body.anonymousId.trim().slice(0, 200) : '';
  if (!anonymousId) return NextResponse.json({ error: 'anonymousId required' }, { status: 400 });

  const decisions: Partial<Record<ConsentCategory, ConsentDecision>> = {};
  for (const [rawKey, rawVal] of Object.entries(body.consents ?? {})) {
    const category = toConsentCategory(rawKey);
    if (category) decisions[category] = rawVal ? 'granted' : 'denied';
  }
  if (Object.keys(decisions).length === 0) {
    return NextResponse.json({ error: 'No valid consent categories' }, { status: 400 });
  }

  const source = typeof body.source === 'string' ? body.source.trim().slice(0, 60) || 'banner' : 'banner';
  const gpc = body.gpc === true;
  const userAgent = req.headers.get('user-agent')?.slice(0, 300) ?? null;

  const supabase = createServiceClient();
  await recordConsentEvents(supabase, { anonymousId, decisions, source, gpc, userAgent });
  const state = await getConsentState(supabase, anonymousId, { gpc });

  return NextResponse.json({ ok: true, state });
}

// Read the current consent state (for hydrating the banner/preference center).
export async function GET(req: NextRequest) {
  const anonymousId = new URL(req.url).searchParams.get('anonymousId')?.trim().slice(0, 200) ?? '';
  if (!anonymousId) return NextResponse.json({ error: 'anonymousId required' }, { status: 400 });
  const gpc = new URL(req.url).searchParams.get('gpc') === '1';
  const supabase = createServiceClient();
  const state = await getConsentState(supabase, anonymousId, { gpc });
  return NextResponse.json({ ok: true, state });
}
