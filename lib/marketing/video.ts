// lib/marketing/video.ts — pure helpers for the Video Marketing pillar.
// Parse YouTube/Vimeo URLs into provider + id, build embed/thumbnail URLs, and
// format durations. No server-only imports so it's unit-testable in isolation.

export const VIDEO_PROVIDERS = ['youtube', 'vimeo', 'upload'] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

export function isVideoProvider(v: string | null | undefined): v is VideoProvider {
  return !!v && (VIDEO_PROVIDERS as readonly string[]).includes(v);
}

export type ParsedVideo = { provider: 'youtube' | 'vimeo'; videoId: string };

/** Detect provider + id from a YouTube or Vimeo URL. Returns null if unrecognised.
 *  Handles youtu.be, watch?v=, /embed/, /shorts/ and vimeo.com / player.vimeo.com. */
export function parseVideoUrl(input: string | null | undefined): ParsedVideo | null {
  const url = (input ?? '').trim();
  if (!url) return null;

  const yt = url.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  );
  if (yt) return { provider: 'youtube', videoId: yt[1] };

  const vimeo = url.match(/(?:vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?|player\.vimeo\.com\/video\/)(\d{6,})/i);
  if (vimeo) return { provider: 'vimeo', videoId: vimeo[1] };

  return null;
}

/** Player embed URL for an external provider. */
export function embedUrl(provider: VideoProvider, videoId: string | null | undefined): string | null {
  if (!videoId) return null;
  if (provider === 'youtube') return `https://www.youtube.com/embed/${videoId}`;
  if (provider === 'vimeo') return `https://player.vimeo.com/video/${videoId}`;
  return null;
}

/** Best-effort thumbnail URL (YouTube only without an API; Vimeo/upload → null). */
export function thumbnailUrl(provider: VideoProvider, videoId: string | null | undefined): string | null {
  if (provider === 'youtube' && videoId) return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  return null;
}

/** Seconds → "m:ss" or "h:mm:ss". */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** Filter to published, non-deleted videos (for public surfaces). */
export function publishedOnly<T extends { status: string; deleted_at?: string | null }>(videos: T[]): T[] {
  return videos.filter((v) => v.status === 'published' && !v.deleted_at);
}
