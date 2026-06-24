import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getOpenAIKey } from '@/lib/ai/settings';
import { cleanTranscript, isValidAudioUpload } from '@/lib/ai/voice';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Speech-to-text for "talk to AI". Accepts a recorded audio blob (multipart),
// forwards it to OpenAI's transcription endpoint, and returns the text. The key
// never leaves the server. Honest 503 when OpenAI isn't configured — no faked
// transcript is ever returned.
export async function POST(req: NextRequest) {
  try {
    // Auth: only signed-in family members may transcribe.
    await requireUserContext();
    const supabase = await createServer();
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Voice isn’t configured. Add an OpenAI key in Admin → AI Engine.' },
        { status: 503 },
      );
    }

    const form = await req.formData();
    const file = form.get('audio');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'No audio provided' }, { status: 400 });
    }
    const check = isValidAudioUpload(file.size, file.type);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const filename = (file as File).name || 'speech.webm';

    const upstream = new FormData();
    upstream.append('file', file, filename);
    upstream.append('model', model);
    upstream.append('response_format', 'json');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: upstream,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('OpenAI transcription error', res.status, detail);
      const msg = res.status === 429
        ? 'The AI engine is busy. Please try again in a moment.'
        : 'Could not transcribe that recording. Please try again.';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    const data = (await res.json()) as { text?: string };
    const text = cleanTranscript(data.text ?? '');
    if (!text) {
      return NextResponse.json({ error: 'I couldn’t hear anything. Try again.' }, { status: 422 });
    }
    return NextResponse.json({ text });
  } catch (err) {
    console.error('Transcription route error', err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
