export type AlbumInsights = {
  totalPhotos: number;
  totalAlbums: number;
  emptyAlbums: number;
  summary: string;
};

export interface AlbumLike {
  id: string;
  title: string;
  photo_count: number;
}

export function analyzeAlbums(albums: readonly AlbumLike[], totalPhotos: number): AlbumInsights {
  const emptyAlbums = albums.filter((a) => a.photo_count === 0).length;

  const parts: string[] = [];
  parts.push(`${totalPhotos} photo${totalPhotos === 1 ? '' : 's'}`);
  parts.push(`${albums.length} album${albums.length === 1 ? '' : 's'}`);
  if (emptyAlbums > 0) parts.push(`${emptyAlbums} empty`);

  return {
    totalPhotos,
    totalAlbums: albums.length,
    emptyAlbums,
    summary: parts.join(' · '),
  };
}

export function buildPhotosPrompt(albums: readonly AlbumLike[], totalPhotos: number): { system: string; user: string } {
  const system = `You are the Bubaly family photos assistant. Analyze the family's photo albums and suggest improvements. Return STRUCTURED JSON only — no markdown, no code fences, no commentary.

Use exactly this shape:
{
  "suggestions": ["specific, actionable suggestion for organizing photos"],
  "albumIdeas": ["idea for a new album based on what's missing"],
  "organizationTip": "one short tip for better photo management"
}

Rules:
- suggestions: max 4 practical suggestions based on the current album structure
- albumIdeas: max 3 album ideas most families find useful (e.g. "School Year 2026", "Holidays", "Sports & Activities")
- organizationTip: one concrete tip
- Never reference specific photos since you can't see them. Only suggest organizational improvements.`;

  const summary = albums.map((a) => `"${a.title}" (${a.photo_count} photos)`).join('\n');
  const user = `The family has ${totalPhotos} photos across ${albums.length} albums:\n\n${summary}\n\nReturn the JSON now.`;
  return { system, user };
}

export type PhotosAIResponse = {
  suggestions: string[];
  albumIdeas: string[];
  organizationTip: string;
};

export function parsePhotosResponse(raw: string): PhotosAIResponse {
  const empty: PhotosAIResponse = { suggestions: [], albumIdeas: [], organizationTip: '' };
  if (!raw || typeof raw !== 'string') return empty;

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      suggestions: Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      albumIdeas: Array.isArray(parsed.albumIdeas)
        ? parsed.albumIdeas.filter((s): s is string => typeof s === 'string').slice(0, 3)
        : [],
      organizationTip: typeof parsed.organizationTip === 'string' ? parsed.organizationTip : '',
    };
  } catch {
    return empty;
  }
}
