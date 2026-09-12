// lib/assistant/link-token.ts
//
// Capability tokens that let a voice assistant act for one family member.
//
// This is deliberately NOT the same design as lib/sync/feed-token.ts. A feed
// token grants read access to one calendar's ICS, so storing it in plaintext is
// a reasonable trade for being able to rebuild the URL. An assistant token can
// CAPTURE — it creates tasks, events and shopping items — so the database
// stores only a SHA-256 of it. The token itself is shown once, at creation, and
// is unrecoverable afterwards: a dump of `assistant_links` hands an attacker
// nothing they can replay.
//
// SERVER ONLY.
import 'server-only';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Recognisable prefix, so a leaked string is identifiable as a Bubaly token. */
const PREFIX = 'bub_asst_';
/** Bytes of entropy. 32 is the same strength the ICS feed slugs use. */
const TOKEN_BYTES = 32;
/** How much of the token is stored in clear, purely to label it in the UI. */
const DISPLAY_CHARS = 6;

export type IssuedToken = {
  /** The full secret. Shown to the user once and never stored. */
  token: string;
  /** What goes in the database. */
  tokenHash: string;
  /** A few leading characters, so a person can tell two links apart. */
  tokenPrefix: string;
};

export function issueAssistantToken(): IssuedToken {
  const token = `${PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return {
    token,
    tokenHash: hashAssistantToken(token),
    tokenPrefix: token.slice(0, PREFIX.length + DISPLAY_CHARS),
  };
}

/**
 * The stored form.
 *
 * A plain SHA-256, not a password KDF, and that is the right call here rather
 * than an oversight: the input is 32 bytes of CSPRNG output, so there is no
 * guessable password to slow an attacker down to. Key stretching protects
 * low-entropy secrets; it would only make every lookup slower.
 */
export function hashAssistantToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('base64url');
}

/** Constant-time comparison, so a lookup cannot be turned into an oracle. */
export function assistantTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashAssistantToken(presented));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Shape check before any database work — cheap rejection of obvious junk. */
export function looksLikeAssistantToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(PREFIX)
    && value.length > PREFIX.length + 20
    && value.length < 200;
}

/**
 * The token from an Authorization header or a body field.
 *
 * Assistants differ: Alexa puts the linked account's token in the request body
 * (`session.user.accessToken`), Shortcuts and Home Assistant send a normal
 * bearer header. Accepting both is what makes one endpoint serve all of them.
 */
export function readPresentedToken(authorization: string | null, bodyToken?: unknown): string | null {
  const header = authorization?.trim() ?? '';
  if (/^bearer\s+/i.test(header)) {
    const value = header.replace(/^bearer\s+/i, '').trim();
    if (looksLikeAssistantToken(value)) return value;
  }
  if (looksLikeAssistantToken(bodyToken)) return bodyToken;
  return null;
}

export const ASSISTANT_TOKEN_PREFIX = PREFIX;
