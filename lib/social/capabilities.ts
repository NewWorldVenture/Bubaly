// lib/social/capabilities.ts
//
// The honest, single source of truth for what each social platform can ACTUALLY
// do through its public API, and what it requires to go live. The UI reads this
// to show real "Supported / Requires setup / Not supported" states instead of
// pretending. The DB seed in 0024_social_command_center.sql mirrors this exactly
// (social_providers.capabilities). If you change one, change both.
//
// Ground rules encoded here (do NOT "upgrade" a flag without a real, shipping API
// AND configured app credentials):
//   - Live publishing/feed access for every platform requires a registered
//     developer app (client id/secret), OAuth scopes, and — for Meta, TikTok,
//     LinkedIn — app review/approval. Until those env credentials exist, the
//     connector reports `requires_setup`, never a fake "connected/published".
//   - Instagram & Threads publishing is only available for Business/Creator
//     accounts via the Facebook Graph API.
//   - TikTok content posting is gated behind the Content Posting API allowlist.
//   - X (Twitter) write access requires a paid API tier.
//   - Reddit requires an OAuth script/web app; no business review needed.

export type SocialPlatform =
  | 'x'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'threads'
  | 'reddit';

export const PLATFORMS: SocialPlatform[] = [
  'x', 'facebook', 'instagram', 'linkedin', 'tiktok',
  'youtube', 'pinterest', 'threads', 'reddit',
];

export type AuthMethod = 'oauth2' | 'oauth1a' | 'api_key' | 'app_password';

/** A single capability dimension: do we have it, how, and what limits/caveats. */
export type SocialCapability = {
  supported: boolean;
  /** Plain-language caveat shown in the UI when a capability is limited or off. */
  limitation?: string;
};

export type AccountType = 'page' | 'profile' | 'business' | 'creator' | 'channel' | 'board' | 'subreddit';

export type MediaSupport = {
  image: boolean;
  video: boolean;
  audio: boolean;
  /** Multi-image / multi-video posts. */
  carousel: boolean;
  /** Max images per post (0 = images unsupported). */
  maxImages: number;
  /** Max single-file size in megabytes (best-effort public limit). */
  maxFileMb: number;
  formats: string[];
};

export type ProviderDefinition = {
  platform: SocialPlatform;
  label: string;
  /** Lucide-free brand color for chips/badges. */
  brandColor: string;
  auth: AuthMethod;
  accountTypes: AccountType[];
  /** Reading the account's own recent posts into the unified feed. */
  feed: SocialCapability;
  /** Creating posts on the platform. */
  posting: SocialCapability;
  /** Native API scheduling. We ALWAYS support internal scheduling regardless; this
   *  flag is whether the platform itself accepts a scheduled-publish time. */
  nativeScheduling: SocialCapability;
  media: MediaSupport;
  analytics: SocialCapability;
  /** Comments / mentions / DMs surfaced in the unified inbox. */
  inbox: SocialCapability;
  /** Hard character limit for the caption/body (the smallest practical cap). */
  charLimit: number;
  /** Whether the platform supports @mentions resolved via API. */
  mentions: boolean;
  /** Whether the platform supports native polls via API. */
  polls: boolean;
  /** Whether the platform supports hashtags meaningfully. */
  hashtags: boolean;
  /** OAuth scopes (or the equivalent permission set) required for full function. */
  requiredScopes: string[];
  /** Env var names whose presence flips this provider from `requires_setup` to
   *  connectable. Read server-side only; never shipped to the client. */
  credentialEnv: string[];
  /** Whether using this provider's live API needs platform app review/approval. */
  needsAppReview: boolean;
  docsUrl: string;
};

const noImages = { image: false, maxImages: 0 };

export const PROVIDERS: Record<SocialPlatform, ProviderDefinition> = {
  x: {
    platform: 'x',
    label: 'X (Twitter)',
    brandColor: '#1d9bf0',
    auth: 'oauth2',
    accountTypes: ['profile'],
    feed: { supported: true, limitation: 'Reads your own recent posts. Home-timeline read access is restricted on lower API tiers.' },
    posting: { supported: true, limitation: 'Posting (tweets) requires the paid X API (Basic tier or above).' },
    nativeScheduling: { supported: false, limitation: 'X has no native scheduled-publish endpoint. We schedule internally and post at the chosen time.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 4, maxFileMb: 512, formats: ['jpg', 'png', 'gif', 'webp', 'mp4'] },
    analytics: { supported: true, limitation: 'Per-post impression/engagement metrics require elevated API access.' },
    inbox: { supported: true, limitation: 'Mentions and replies only; DMs require additional scopes.' },
    charLimit: 280,
    mentions: true,
    polls: true,
    hashtags: true,
    requiredScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    credentialEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    needsAppReview: false,
    docsUrl: 'https://developer.x.com/en/docs',
  },
  facebook: {
    platform: 'facebook',
    label: 'Facebook Pages',
    brandColor: '#1877f2',
    auth: 'oauth2',
    accountTypes: ['page'],
    feed: { supported: true, limitation: 'Reads posts from Pages you manage. Personal-profile feeds are not available via API.' },
    posting: { supported: true },
    nativeScheduling: { supported: true, limitation: 'Pages support native scheduled publishing.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 10, maxFileMb: 4096, formats: ['jpg', 'png', 'gif', 'mp4', 'mov'] },
    analytics: { supported: true },
    inbox: { supported: true, limitation: 'Page comments and Messenger conversations (pages_messaging scope).' },
    charLimit: 63206,
    mentions: false,
    polls: false,
    hashtags: true,
    requiredScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata'],
    credentialEnv: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.facebook.com/docs/pages-api',
  },
  instagram: {
    platform: 'instagram',
    label: 'Instagram Business',
    brandColor: '#e1306c',
    auth: 'oauth2',
    accountTypes: ['business', 'creator'],
    feed: { supported: true, limitation: 'Business/Creator accounts only, linked to a Facebook Page.' },
    posting: { supported: true, limitation: 'Single image/video and carousels via the Content Publishing API (Business/Creator only). Stories are not publishable via API.' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally and publish at the chosen time.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 10, maxFileMb: 100, formats: ['jpg', 'png', 'mp4', 'mov'] },
    analytics: { supported: true, limitation: 'Insights for Business/Creator accounts.' },
    inbox: { supported: true, limitation: 'Comments and mentions; DMs need the Messaging API.' },
    charLimit: 2200,
    mentions: true,
    polls: false,
    hashtags: true,
    requiredScopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_show_list'],
    credentialEnv: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
  },
  linkedin: {
    platform: 'linkedin',
    label: 'LinkedIn',
    brandColor: '#0a66c2',
    auth: 'oauth2',
    accountTypes: ['profile', 'page'],
    feed: { supported: true, limitation: 'Organization (Page) posts via Community Management API. Personal-profile feed read is limited.' },
    posting: { supported: true, limitation: 'Member posts via w_member_social; Organization posts require admin + w_organization_social.' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 9, maxFileMb: 200, formats: ['jpg', 'png', 'gif', 'mp4'] },
    analytics: { supported: true, limitation: 'Organization analytics via the Community Management API.' },
    inbox: { supported: false, limitation: 'No general comment/DM read API for third parties.' },
    charLimit: 3000,
    mentions: true,
    polls: false,
    hashtags: true,
    requiredScopes: ['w_member_social', 'r_liteprofile', 'r_organization_social', 'w_organization_social'],
    credentialEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/',
  },
  tiktok: {
    platform: 'tiktok',
    label: 'TikTok',
    brandColor: '#ff0050',
    auth: 'oauth2',
    accountTypes: ['creator', 'business'],
    feed: { supported: true, limitation: 'Reads your own published videos via the Display API.' },
    posting: { supported: true, limitation: 'Video publishing via the Content Posting API, which requires per-app allowlisting/audit by TikTok.' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally.' },
    media: { video: true, audio: false, carousel: false, ...noImages, maxFileMb: 4096, formats: ['mp4', 'mov', 'webm'] },
    analytics: { supported: true, limitation: 'Video analytics via the Display API with the user.info.stats / video.list scopes.' },
    inbox: { supported: false, limitation: 'No public comment/DM management API.' },
    charLimit: 2200,
    mentions: false,
    polls: false,
    hashtags: true,
    requiredScopes: ['user.info.basic', 'video.list', 'video.publish'],
    credentialEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
  },
  youtube: {
    platform: 'youtube',
    label: 'YouTube',
    brandColor: '#ff0000',
    auth: 'oauth2',
    accountTypes: ['channel'],
    feed: { supported: true, limitation: 'Reads uploads from your channel via the Data API.' },
    posting: { supported: true, limitation: 'Video uploads (incl. Shorts) via the Data API; counts against a daily quota.' },
    nativeScheduling: { supported: true, limitation: 'Supports scheduled publishing via publishAt on private uploads.' },
    media: { image: true, video: true, audio: false, carousel: false, maxImages: 1, maxFileMb: 131072, formats: ['mp4', 'mov', 'avi', 'webm'] },
    analytics: { supported: true, limitation: 'Views/watch-time via the YouTube Analytics API.' },
    inbox: { supported: true, limitation: 'Comment threads via the Data API; no DMs.' },
    charLimit: 5000,
    mentions: false,
    polls: false,
    hashtags: true,
    requiredScopes: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
    credentialEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.google.com/youtube/v3',
  },
  pinterest: {
    platform: 'pinterest',
    label: 'Pinterest',
    brandColor: '#e60023',
    auth: 'oauth2',
    accountTypes: ['business', 'board'],
    feed: { supported: true, limitation: 'Reads pins from your boards (business account).' },
    posting: { supported: true, limitation: 'Creates pins on a board via the v5 API (business account).' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 5, maxFileMb: 2048, formats: ['jpg', 'png', 'mp4'] },
    analytics: { supported: true, limitation: 'Pin/board analytics for business accounts.' },
    inbox: { supported: false, limitation: 'No comment/DM management API.' },
    charLimit: 500,
    mentions: false,
    polls: false,
    hashtags: true,
    requiredScopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'],
    credentialEnv: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/',
  },
  threads: {
    platform: 'threads',
    label: 'Threads',
    brandColor: '#000000',
    auth: 'oauth2',
    accountTypes: ['profile', 'business'],
    feed: { supported: true, limitation: 'Reads your own Threads posts via the Threads API.' },
    posting: { supported: true, limitation: 'Text/image/video posts via the Threads API (Meta app review required).' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 10, maxFileMb: 100, formats: ['jpg', 'png', 'mp4'] },
    analytics: { supported: true, limitation: 'Post insights via the Threads API.' },
    inbox: { supported: true, limitation: 'Replies/mentions via the Threads API; no DMs.' },
    charLimit: 500,
    mentions: true,
    polls: false,
    hashtags: true,
    requiredScopes: ['threads_basic', 'threads_content_publish', 'threads_manage_insights', 'threads_manage_replies'],
    credentialEnv: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
    needsAppReview: true,
    docsUrl: 'https://developers.facebook.com/docs/threads',
  },
  reddit: {
    platform: 'reddit',
    label: 'Reddit',
    brandColor: '#ff4500',
    auth: 'oauth2',
    accountTypes: ['profile', 'subreddit'],
    feed: { supported: true, limitation: 'Reads your submissions and subreddit listings via the Reddit API.' },
    posting: { supported: true, limitation: 'Submits link/text posts to subreddits you can post in.' },
    nativeScheduling: { supported: false, limitation: 'No native scheduled-publish; we schedule internally.' },
    media: { image: true, video: true, audio: false, carousel: true, maxImages: 20, maxFileMb: 1024, formats: ['jpg', 'png', 'gif', 'mp4'] },
    analytics: { supported: false, limitation: 'No post-level analytics API beyond score/comment counts on the post object.' },
    inbox: { supported: true, limitation: 'Inbox messages, comment replies, and mentions via the API.' },
    charLimit: 40000,
    mentions: true,
    polls: false,
    hashtags: false,
    requiredScopes: ['identity', 'read', 'submit', 'history', 'privatemessages'],
    credentialEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    needsAppReview: false,
    docsUrl: 'https://www.reddit.com/dev/api/',
  },
};

export function getProvider(platform: SocialPlatform): ProviderDefinition {
  return PROVIDERS[platform];
}

export function isPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value);
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p, PROVIDERS[p].label]),
) as Record<SocialPlatform, string>;

/**
 * Server-only readiness check. A provider is "configured" when all of its
 * credential env vars are present. Without them, connection flows show a clear
 * `requires_setup` state instead of pretending to connect. NEVER call from the
 * client — it reads process.env.
 */
export function isProviderConfigured(platform: SocialPlatform): boolean {
  const def = PROVIDERS[platform];
  return def.credentialEnv.every((name) => Boolean(process.env[name]));
}

export type ProviderReadiness = 'ready' | 'requires_setup';

export function providerReadiness(platform: SocialPlatform): ProviderReadiness {
  return isProviderConfigured(platform) ? 'ready' : 'requires_setup';
}
