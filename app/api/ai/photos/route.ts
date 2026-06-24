import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { isAIConfigured, resolveProvider } from '@/lib/ai/provider';
import { analyzeAlbums, buildPhotosPrompt, parsePhotosResponse } from '@/lib/photos/ai';
import { createServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;

    const supabase = await createServer();
    const { data: albums } = await supabase
      .from('family_albums')
      .select('id, name')
      .eq('family_id', familyId)
      .limit(100);

    const { count: totalPhotos } = await supabase
      .from('family_photos')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', familyId);

    const albumList = (albums ?? []).map((a) => ({ id: a.id, title: a.name, photo_count: 0 }));

    if (albums && albums.length > 0) {
      for (const album of albumList) {
        const { count } = await supabase
          .from('family_photos')
          .select('id', { count: 'exact', head: true })
          .eq('album_id', album.id);
        album.photo_count = count ?? 0;
      }
    }

    const analysis = analyzeAlbums(albumList, totalPhotos ?? 0);

    if (!await isAIConfigured()) {
      return NextResponse.json({ analysis, aiUsed: false });
    }

    const { system, user } = buildPhotosPrompt(albumList, totalPhotos ?? 0);
    const provider = await resolveProvider();
    const completion = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      maxTokens: 600,
    });

    const aiInsights = parsePhotosResponse(completion.text || '');
    return NextResponse.json({ analysis, aiInsights, aiUsed: true });
  } catch (err) {
    console.error('Photos AI error:', err);
    return NextResponse.json({ error: 'Failed to analyze photos' }, { status: 500 });
  }
}
