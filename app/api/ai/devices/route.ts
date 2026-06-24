import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeDevices, buildDevicesPrompt, parseDevicesResponse } from '@/lib/home/devices-ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: devices } = await supabase
      .from('smart_devices')
      .select('name, type, room, status, integration')
      .eq('family_id', familyId)
      .order('room')
      .limit(200);

    if (!devices || devices.length === 0) {
      return NextResponse.json({ error: 'No devices to analyze' }, { status: 400 });
    }

    const analysis = analyzeDevices(devices);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildDevicesPrompt(devices);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parseDevicesResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Devices AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze devices' }, { status: 500 });
  }
}
