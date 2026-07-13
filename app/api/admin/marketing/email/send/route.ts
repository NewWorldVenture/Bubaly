import { NextRequest, NextResponse } from 'next/server';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { sendEmailCampaign, resolveRecipients } from '@/lib/marketing/send';

export const runtime = 'nodejs';

// GET ?id= → recipient preview count (no send). POST { id } → real send.
export async function GET(req: NextRequest) {
  try {
    const { supabase } = await requireMarketingAdmin();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    const { data: c } = await supabase.from('marketing_email_campaigns').select('segment_id').eq('id', id).maybeSingle();
    if (!c) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const recipients = await resolveRecipients(supabase, c);
    return NextResponse.json({ recipients: recipients.length });
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { id } = (boundedBody.value ?? {}) as { id?: string };
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const { sent } = await sendEmailCampaign(supabase, id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_email_campaign', resourceId: id, metadata: { sent } });
    return NextResponse.json({ sent });
  } catch (err) {
    console.error('Marketing email send failed:', err);
    const forbidden = err instanceof Error && err.message.includes('Forbidden');
    return NextResponse.json({ error: forbidden ? 'Forbidden' : 'Could not send campaign.' }, { status: forbidden ? 403 : 400 });
  }
}
