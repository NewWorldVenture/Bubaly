// lib/social/ai.ts
// Real AI content generation for the studio, using the project's provider-agnostic
// LLM interface (lib/ai/provider.ts → OpenAI / ChatGPT). Each call returns
// structured text; the server action persists the request+response into
// social_ai_generations so history is auditable. No output is published here.
import 'server-only';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import type { ServiceScope } from '@/lib/services/types';
import { PROVIDERS, type SocialPlatform } from './capabilities';
import { type AiGenerationKind } from './ai-kinds';

export { AI_GENERATION_KINDS, AI_KIND_LABELS, type AiGenerationKind } from './ai-kinds';

export type AiGenerateInput = {
  kind: AiGenerationKind;
  topic: string;
  platform?: SocialPlatform | null;
  tone?: string;
  /** Existing draft/source content for rewrite/repurpose/alt_text. */
  source?: string;
};

export type AiGenerateResult = {
  kind: AiGenerationKind;
  text: string;
  model: string;
};

function instructionFor(input: AiGenerateInput): string {
  const platform = input.platform ? PROVIDERS[input.platform] : null;
  const limit = platform ? ` Keep within ${platform.charLimit} characters for ${platform.label}.` : '';
  const tone = input.tone ? ` Tone: ${input.tone}.` : '';
  const src = input.source ? `\n\nSource content:\n"""${input.source}"""` : '';
  const topic = input.topic ? `Topic: ${input.topic}.` : '';

  switch (input.kind) {
    case 'ideas':
      return `Generate 8 concrete social post ideas. ${topic}${tone} Return a numbered list, one idea per line.`;
    case 'caption':
      return `Write a compelling social caption.${limit}${tone} ${topic}${src} Return only the caption.`;
    case 'hashtags':
      return `Suggest 12 relevant, non-spammy hashtags. ${topic}${src} Return them space-separated, each starting with #.`;
    case 'rewrite':
      return `Rewrite the source content as a native ${platform?.label ?? 'social'} post.${limit}${tone}${src} Return only the rewritten post.`;
    case 'video_script':
      return `Write a 30–45 second short-form video script (hook, 3 beats, CTA). ${topic}${tone} Use labeled sections.`;
    case 'video_outline':
      return `Write a long-form (8–12 min) video outline with sections and key talking points. ${topic}${tone}`;
    case 'audio_script':
      return `Write a 3–5 minute podcast/audio segment script with an intro hook and outro CTA. ${topic}${tone}`;
    case 'image_prompt':
      return `Write a detailed text-to-image generation prompt (subject, style, lighting, composition, aspect ratio). ${topic} Return only the prompt.`;
    case 'carousel':
      return `Create a 6-slide carousel. For each slide give a short headline and 1–2 line body. ${topic}${tone} Label slides 1–6.`;
    case 'ad_copy':
      return `Write 3 ad-copy variants (headline + primary text + CTA). ${topic}${tone}${src}`;
    case 'cta':
      return `Write 5 distinct calls-to-action. ${topic}${tone} Return a numbered list.`;
    case 'alt_text':
      return `Write concise, descriptive alt text (max 125 chars) for accessibility.${src} Return only the alt text.`;
    case 'repurpose':
      return `Repurpose the source content into 5 social posts across platforms (label each with its platform).${tone}${src}`;
    case 'ten_variants':
      return `Turn this idea into 10 platform-native posts (X, Instagram, LinkedIn, Facebook, TikTok caption, YouTube description, Pinterest, Threads, Reddit, and a generic one). ${topic}${tone} Label each with its platform and respect each platform's style.`;
    default:
      return `${topic}${tone}${src}`;
  }
}

/**
 * Run a generation. Throws if no AI key is configured so the caller can surface
 * an honest "AI not configured" state rather than returning fabricated text.
 */
export async function generate(scope: ServiceScope, input: AiGenerateInput): Promise<AiGenerateResult> {
  if (!(await isAIConfigured())) {
    throw new Error('AI is not configured: set OPENAI_API_KEY to enable content generation.');
  }
  const system =
    'You are a senior social media strategist and copywriter for a family-focused brand. ' +
    'Write clear, on-brand, platform-appropriate content. Never invent statistics or fake engagement. ' +
    'Return only the requested content with no preamble.';

  // This one throws on failure rather than swallowing, so the wrapper's own
  // catch records it and re-raises unchanged — the route already writes its
  // `social_ai_logs` error row and answers honestly.
  return withAiRequest(
    scope,
    { feature: `social.${input.kind}`, text: (input.topic ?? input.kind).slice(0, 200) },
    async (obs) => {
      const provider = await resolveProvider();
      const completion = await provider.complete({
        system,
        messages: [{ role: 'user', content: instructionFor(input) }],
        tools: [],
      });
      obs.used(provider.model, completion.usage);
      return { kind: input.kind, text: completion.text.trim(), model: provider.model };
    },
  );
}
