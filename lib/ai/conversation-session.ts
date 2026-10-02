import { parseAssistantStreamEvent, type AssistantStreamEvent } from '@/lib/ai/result-cards';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Never adopt the old, unscoped key: it can belong to another signed-in person. */
export function assistantConversationKey(userId: string, familyId: string): string {
  return `assistant-conv-id:${userId}:${familyId}`;
}

export function readAssistantConversation(storage: Pick<Storage, 'getItem'> | null, key: string): string | null {
  try {
    const value = storage?.getItem(key);
    return value && UUID.test(value) ? value : null;
  } catch { return null; }
}

export function rememberAssistantConversation(storage: Pick<Storage, 'setItem'> | null, key: string, id: string): void {
  try { storage?.setItem(key, id); } catch { /* Private browsing must not disable chat. */ }
}

/** Newest-first database windows become chronological transcripts. Both rows of
 * a saved turn can have the same transaction timestamp, so the user's question
 * precedes its answer even if the UUID tie-breaker sorted them the other way. */
export function chronologicalMessages<T extends { created_at?: string; role: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (!a.created_at || !b.created_at) return 0;
    return a.created_at.localeCompare(b.created_at)
      || Number(a.role === 'assistant') - Number(b.role === 'assistant');
  });
}

/** One owner/thread epoch. Invalidating aborts pending transports and also guards
 * asynchronous callbacks from transports that ignored abort, including queued
 * React state updaters and speech completion. */
export class AssistantConversationActivity {
  private generation = 0;
  private active = true;
  private requests = new Set<AbortController>();

  activate() { this.active = true; }
  current() { return this.active; }
  begin() {
    const generation = this.generation;
    const controller = new AbortController();
    this.requests.add(controller);
    return {
      controller,
      current: () => this.active && generation === this.generation && !controller.signal.aborted,
      finish: () => this.requests.delete(controller),
    };
  }
  invalidate() {
    this.generation += 1;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
  dispose() { this.active = false; this.invalidate(); }
}

/** SSE accepts CRLF, multiline data fields, split UTF-8 and a final frame
 * without a blank line. Transport success still requires an explicit done. */
export async function consumeAssistantStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: AssistantStreamEvent) => void,
  signal?: AbortSignal,
): Promise<{ completed: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const frame = (text: string) => {
    if (signal?.aborted) return;
    const data = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }
    const event = parseAssistantStreamEvent(raw);
    if (!event) return;
    if (event.type === 'done') completed = true;
    onEvent(event);
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) return { completed: false };
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return { completed: false };
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let delimiter: RegExpExecArray | null;
      while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, delimiter.index));
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
      }
      if (done) { if (buffer.trim()) frame(buffer); break; }
    }
    return { completed };
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
