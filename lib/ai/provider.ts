// lib/ai/provider.ts — provider-agnostic LLM interface.
// Swap Anthropic / OpenAI / Gemini / local by implementing AIProvider.

export type AITool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIImage = {
  media_type: string;   // e.g. 'image/jpeg', 'image/png'
  data: string;         // base64-encoded image bytes
};

export type AIMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: AIImage[];   // optional vision input (user messages only)
  tool_calls?: { name: string; args: Record<string, unknown> }[];
  tool_results?: { name: string; result: unknown }[];
};

export type AICompletion = {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
};

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  complete(input: {
    system: string;
    messages: AIMessage[];
    tools: AITool[];
  }): Promise<AICompletion>;
}

// --- Anthropic implementation ---
export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  constructor(public model = 'claude-sonnet-4-6', private apiKey = process.env.ANTHROPIC_API_KEY!) {}

  async complete({ system, messages, tools }: {
    system: string; messages: AIMessage[]; tools: AITool[];
  }): Promise<AICompletion> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            // Attach vision blocks when a message carries images (user only).
            if (m.images?.length) {
              return {
                role: m.role,
                content: [
                  ...m.images.map((img) => ({
                    type: 'image' as const,
                    source: { type: 'base64' as const, media_type: img.media_type, data: img.data },
                  })),
                  { type: 'text' as const, text: m.content },
                ],
              };
            }
            return { role: m.role, content: m.content };
          }),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('\n');
    const toolCalls = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'tool_use')
      .map((b: { name: string; input: Record<string, unknown> }) => ({ name: b.name, args: b.input }));
    return { text, toolCalls };
  }
}

export function getProvider(): AIProvider {
  switch (process.env.AI_PROVIDER ?? 'anthropic') {
    case 'anthropic':
      return new AnthropicProvider(process.env.AI_MODEL ?? 'claude-sonnet-4-6');
    // case 'openai':  return new OpenAIProvider(...)
    // case 'gemini':  return new GeminiProvider(...)
    default:
      return new AnthropicProvider();
  }
}
