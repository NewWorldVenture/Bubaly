// lib/ai/prefill.ts — how a question reaches the AI Assistant from somewhere
// else in the app.
//
// TWO DOORS, AND ONLY ONE SENDS.
//
// `?q=` is a URL, and a URL is something anyone can write: an email, a text, a
// family message, a calendar location, a QR code. The assistant used to SEND a
// `?q=` question the moment it opened, as the signed-in member's own request,
// to a turn that can delete events and message the family — so a link a teen
// (or a stranger) wrote ran with a parent's authority in one tap. A `?q=`
// question is now only put in the draft box, with a note saying where it came
// from, and goes nowhere until the member presses Send.
//
// The app's own hand-offs — the home Ask bar, the header search, Quick Capture
// — still send on arrival. They go through `stageAssistantHandoff`, which puts
// the question in this tab's sessionStorage under a one-time nonce and puts
// only the nonce in the URL. A link from outside can carry a nonce, but it
// cannot write this origin's sessionStorage, so it cannot make anything send.

/** sessionStorage key for the one pending hand-off. */
export const ASSISTANT_HANDOFF_KEY = 'bubaly:assistant-handoff';
/** The URL parameter carrying the hand-off's nonce. */
export const ASSISTANT_HANDOFF_PARAM = 'handoff';
/** A hand-off is for the navigation that staged it, not for later. */
export const ASSISTANT_HANDOFF_TTL_MS = 2 * 60_000;
const MAX_QUESTION_CHARS = 1000;

type HandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StagedHandoff = { nonce: string; text: string; at: number };

/**
 * Extract a prefill question from a URL query string. Returns the trimmed `q`
 * value (capped to `max` chars), or null when absent/blank. Accepts the search
 * string with or without a leading "?". A question read this way is a DRAFT:
 * never send it without the member pressing Send.
 */
export function parsePrefillQuery(search: string, max = MAX_QUESTION_CHARS): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const q = params.get('q');
  if (!q) return null;
  const trimmed = q.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Build an assistant link that `parsePrefillQuery` will read back — a link
 * that fills the draft box and sends nothing. Returns just the base path when
 * the question is blank.
 */
export function buildAssistantUrl(question: string, base = '/dashboard/assistant'): string {
  const q = question.trim();
  return q ? `${base}?q=${encodeURIComponent(q)}` : base;
}

function defaultNonce(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function browserStorage(): HandoffStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Stage a question the assistant will SEND when it opens, and return the URL to
 * navigate to. Only the app's own code can call this (it writes this tab's
 * sessionStorage). When storage is unavailable the question still arrives, as a
 * draft (`buildAssistantUrl`), so nothing is lost — it just waits for Send.
 */
export function stageAssistantHandoff(
  question: string,
  opts: { storage?: HandoffStorage | null; base?: string; now?: number; nonce?: string } = {},
): string {
  const base = opts.base ?? '/dashboard/assistant';
  const text = question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!text) return base;
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const nonce = opts.nonce ?? defaultNonce();
  try {
    if (!storage) throw new Error('no storage');
    const staged: StagedHandoff = { nonce, text, at: opts.now ?? Date.now() };
    storage.setItem(ASSISTANT_HANDOFF_KEY, JSON.stringify(staged));
  } catch {
    return buildAssistantUrl(text, base);
  }
  return `${base}?${ASSISTANT_HANDOFF_PARAM}=${encodeURIComponent(nonce)}`;
}

/**
 * The staged question this URL names, or null. It must be in this tab's
 * storage, under the nonce the URL carries, and recent. Reading does not
 * consume it (a StrictMode probe mount reads and then goes away);
 * `clearAssistantHandoff` does, once the question is actually sent.
 */
export function readAssistantHandoff(storage: HandoffStorage | null, search: string, now = Date.now()): string | null {
  if (!storage || !search) return null;
  const nonce = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(ASSISTANT_HANDOFF_PARAM);
  if (!nonce) return null;
  let staged: Partial<StagedHandoff> | null = null;
  try {
    staged = JSON.parse(storage.getItem(ASSISTANT_HANDOFF_KEY) ?? 'null') as Partial<StagedHandoff> | null;
  } catch {
    return null;
  }
  if (!staged || staged.nonce !== nonce || typeof staged.text !== 'string' || typeof staged.at !== 'number') return null;
  if (now - staged.at > ASSISTANT_HANDOFF_TTL_MS || staged.at - now > ASSISTANT_HANDOFF_TTL_MS) return null;
  const text = staged.text.trim().slice(0, MAX_QUESTION_CHARS);
  return text || null;
}

/** Forget the staged question, so it is sent at most once. */
export function clearAssistantHandoff(storage: HandoffStorage | null): void {
  try { storage?.removeItem(ASSISTANT_HANDOFF_KEY); } catch { /* Storage denied: nothing was staged in it. */ }
}
