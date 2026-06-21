// lib/social/content.ts
//
// Pure, dependency-free content helpers shared by the Content Studio UI, the
// server actions that create posts, and the publish pipeline. Kept pure so the
// rules are unit-tested without a database or network (see tests/social-*.test.ts).

import { PROVIDERS, type SocialPlatform } from './capabilities';

export type PostKind =
  | 'text' | 'image' | 'video' | 'audio' | 'short'
  | 'carousel' | 'thread' | 'poll' | 'link' | 'announcement';

export const POST_KINDS: PostKind[] = [
  'text', 'image', 'video', 'audio', 'short',
  'carousel', 'thread', 'poll', 'link', 'announcement',
];

export type PostStatus =
  | 'draft' | 'scheduled' | 'publishing' | 'published'
  | 'partially_published' | 'failed' | 'canceled';

export type TargetStatus =
  | 'pending' | 'publishing' | 'published' | 'failed' | 'skipped' | 'canceled';

/** A draft as seen by validation: caption + intended media + target platforms. */
export type DraftContent = {
  kind: PostKind;
  body: string;
  link?: string | null;
  imageCount?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  isPoll?: boolean;
};

export type ValidationSeverity = 'error' | 'warning';

export type ValidationIssue = {
  platform: SocialPlatform;
  severity: ValidationSeverity;
  message: string;
};

/** X/Twitter weights URLs as 23 chars regardless of length. Approximate the
 *  visible length the same way across platforms for a consistent counter. */
const TWITTER_URL_WEIGHT = 23;
const URL_RE = /https?:\/\/[^\s]+/g;

/** Effective character count for a platform, accounting for URL weighting on X. */
export function effectiveLength(body: string, platform: SocialPlatform): number {
  if (platform === 'x') {
    const urls = body.match(URL_RE) ?? [];
    const stripped = body.replace(URL_RE, '');
    return [...stripped].length + urls.length * TWITTER_URL_WEIGHT;
  }
  return [...body].length;
}

/** Remaining characters for a platform (negative when over the limit). */
export function charsRemaining(body: string, platform: SocialPlatform): number {
  return PROVIDERS[platform].charLimit - effectiveLength(body, platform);
}

export function extractHashtags(body: string): string[] {
  const matches = body.match(/(?:^|\s)#([\p{L}0-9_]+)/gu) ?? [];
  const tags = matches.map((m) => m.trim().replace(/^#/, '').toLowerCase());
  return Array.from(new Set(tags));
}

export function extractMentions(body: string): string[] {
  const matches = body.match(/(?:^|\s)@([\p{L}0-9_.]+)/gu) ?? [];
  const handles = matches.map((m) => m.trim().replace(/^@/, ''));
  return Array.from(new Set(handles));
}

/**
 * Validate a draft against ONE platform's real capabilities. Returns hard errors
 * (block publish to that platform) and soft warnings (publish allowed, user
 * informed). Mirrors lib/social/capabilities.ts so the studio never offers
 * something the platform can't do.
 */
export function validateForPlatform(draft: DraftContent, platform: SocialPlatform): ValidationIssue[] {
  const def = PROVIDERS[platform];
  const issues: ValidationIssue[] = [];
  const err = (message: string) => issues.push({ platform, severity: 'error', message });
  const warn = (message: string) => issues.push({ platform, severity: 'warning', message });

  const images = draft.imageCount ?? 0;
  const len = effectiveLength(draft.body, platform);

  // Character limit.
  if (len > def.charLimit) {
    err(`Caption is ${len - def.charLimit} characters over the ${def.charLimit} limit for ${def.label}.`);
  }

  // Posting capability at all.
  if (!def.posting.supported) {
    err(`${def.label} does not support publishing via API.`);
  }

  // Media checks.
  if (images > 0 && !def.media.image) {
    err(`${def.label} does not accept image posts.`);
  }
  if (images > def.media.maxImages) {
    err(`${def.label} allows at most ${def.media.maxImages} image(s); draft has ${images}.`);
  }
  if (draft.hasVideo && !def.media.video) {
    err(`${def.label} does not accept video posts.`);
  }
  if (draft.hasAudio && !def.media.audio) {
    warn(`${def.label} has no audio post type; audio will be skipped or needs a video wrapper.`);
  }
  if ((draft.kind === 'carousel') && !def.media.carousel) {
    err(`${def.label} does not support carousels.`);
  }
  if (draft.kind === 'video' && images === 0 && !draft.hasVideo) {
    warn('Video post selected but no video attached.');
  }

  // Platform-specific media requirements.
  if (platform === 'tiktok' && !draft.hasVideo) {
    err('TikTok requires a video.');
  }
  if (platform === 'youtube' && !draft.hasVideo) {
    err('YouTube requires a video upload.');
  }
  if (platform === 'instagram' && images === 0 && !draft.hasVideo) {
    err('Instagram requires at least one image or video.');
  }
  if (platform === 'pinterest' && images === 0 && !draft.hasVideo) {
    err('Pinterest pins require an image or video.');
  }

  // Polls.
  if (draft.isPoll && !def.polls) {
    err(`${def.label} does not support polls via API.`);
  }

  // Empty content with no media.
  if (draft.body.trim().length === 0 && images === 0 && !draft.hasVideo && !draft.hasAudio) {
    err('Post is empty — add text or media.');
  }

  // Soft: hashtags on a platform that ignores them.
  if (!def.hashtags && extractHashtags(draft.body).length > 0) {
    warn(`${def.label} does not use hashtags; they will read as literal text.`);
  }

  return issues;
}

export function validateForPlatforms(draft: DraftContent, platforms: SocialPlatform[]): ValidationIssue[] {
  return platforms.flatMap((p) => validateForPlatform(draft, p));
}

export function hasBlockingErrors(issues: ValidationIssue[], platform?: SocialPlatform): boolean {
  return issues.some(
    (i) => i.severity === 'error' && (platform ? i.platform === platform : true),
  );
}

/**
 * The publish state machine. Given per-target outcomes, derive the parent post's
 * status. Used after a publish job runs so the post never claims "published"
 * unless at least one target actually confirmed, and reflects partial success.
 */
export function derivePostStatus(targetStatuses: TargetStatus[]): PostStatus {
  if (targetStatuses.length === 0) return 'draft';
  const published = targetStatuses.filter((s) => s === 'published').length;
  const failed = targetStatuses.filter((s) => s === 'failed').length;
  const active = targetStatuses.filter((s) => s === 'publishing' || s === 'pending').length;

  if (active > 0) return 'publishing';
  if (published > 0 && failed > 0) return 'partially_published';
  if (published > 0 && failed === 0) return 'published';
  if (failed > 0 && published === 0) return 'failed';
  if (targetStatuses.every((s) => s === 'canceled')) return 'canceled';
  return 'draft';
}

/** Legal status transitions for a post (UI gating + server guard). */
const POST_TRANSITIONS: Record<PostStatus, PostStatus[]> = {
  draft: ['scheduled', 'publishing', 'canceled'],
  scheduled: ['publishing', 'draft', 'canceled'],
  publishing: ['published', 'partially_published', 'failed'],
  partially_published: ['publishing', 'published', 'canceled'],
  published: [],
  failed: ['publishing', 'draft', 'canceled'],
  canceled: ['draft'],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return POST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Recommended aspect ratio guidance per platform for the studio preview. */
export const ASPECT_GUIDANCE: Record<SocialPlatform, string> = {
  x: '16:9 or 1:1 — landscape and square read best in-timeline.',
  facebook: '1.91:1 link images, 1:1 or 4:5 photos.',
  instagram: '4:5 portrait for feed, 9:16 for Reels.',
  linkedin: '1.91:1 or 1:1; 1200×627 for link previews.',
  tiktok: '9:16 vertical, full-screen.',
  youtube: '16:9 for standard, 9:16 for Shorts.',
  pinterest: '2:3 vertical pins perform best.',
  threads: '1:1 or 4:5; 9:16 for video.',
  reddit: 'No strict ratio; 16:9 or 1:1 preview thumbnails.',
};
