// lib/social/ai-kinds.ts
// Client-safe AI generation kinds + labels. Kept separate from lib/social/ai.ts
// (which is server-only) so client components — the Content Studio — can render
// the menu without pulling the server LLM code into the browser bundle.

export type AiGenerationKind =
  | 'ideas'
  | 'caption'
  | 'hashtags'
  | 'rewrite'
  | 'video_script'
  | 'video_outline'
  | 'audio_script'
  | 'image_prompt'
  | 'carousel'
  | 'ad_copy'
  | 'cta'
  | 'alt_text'
  | 'repurpose'
  | 'ten_variants';

export const AI_GENERATION_KINDS: AiGenerationKind[] = [
  'ideas', 'caption', 'hashtags', 'rewrite', 'video_script', 'video_outline',
  'audio_script', 'image_prompt', 'carousel', 'ad_copy', 'cta', 'alt_text',
  'repurpose', 'ten_variants',
];

export const AI_KIND_LABELS: Record<AiGenerationKind, string> = {
  ideas: 'Post ideas',
  caption: 'Caption',
  hashtags: 'Hashtags',
  rewrite: 'Rewrite for platform',
  video_script: 'Short-form video script',
  video_outline: 'Long-form video outline',
  audio_script: 'Podcast / audio script',
  image_prompt: 'Image prompt',
  carousel: 'Carousel slides',
  ad_copy: 'Ad copy',
  cta: 'Call-to-action',
  alt_text: 'Alt text',
  repurpose: 'Repurpose content',
  ten_variants: '10 platform-native posts',
};
