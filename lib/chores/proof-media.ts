// lib/chores/proof-media.ts — what chore proof may be, and where it lives.
//
// Proof media goes straight from the child's browser to the private
// `chore-proof` bucket (0376 lets a member write only their own folder, a
// manager any folder in the family), and submitProofAction receives only the
// paths. It used to receive the files themselves, and a server action's body is
// capped at 1 MB by default (next.config sets no serverActions.bodySizeLimit),
// so an ordinary phone photo — and every video — was refused with a 413 before
// the action ran, despite the 50 MB the action itself allowed.
//
// Shared by the form (which checks before uploading) and the action (which
// checks what Storage actually holds), so the two cannot drift.

export const PROOF_BUCKET = 'chore-proof';
export const MAX_PROOF_FILES = 4;
export const MAX_PROOF_BYTES = 50 * 1024 * 1024;

/**
 * The media a proof may be. Raster images and ordinary phone video only: no
 * SVG, HTML or XML, which a browser would run as a page when a parent opens the
 * signed URL (SEC-002 R1).
 */
export const PROOF_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm',
]);

/** Image types the AI reviewer reads; others are kept for the parent only. */
export const VISION_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** Largest image handed to the reviewer; a larger one still goes to the parent. */
export const MAX_VISION_BYTES = 5 * 1024 * 1024;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A storage-safe file name: the last 100 characters, anything odd replaced. */
export function proofFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-100);
  return safe || 'proof';
}

/** A random v4 UUID for an object name, without assuming crypto.randomUUID (older iOS Safari lacks it). */
export function newProofObjectId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `<family>/<member>/<uuid>-<name>`, the layout 0376's write policy reads. */
export function proofObjectPath(familyId: string, memberId: string, id: string, name: string): string {
  return `${familyId}/${memberId}/${id}-${proofFileName(name)}`;
}

/** True only for a path this assignment's proof may use: that member's folder, one object, no traversal. */
export function isProofPathFor(path: unknown, familyId: string, memberId: string): path is string {
  if (typeof path !== 'string' || path.length > 400) return false;
  const prefix = `${familyId}/${memberId}/`;
  if (!path.startsWith(prefix)) return false;
  return new RegExp(`^${UUID}-[A-Za-z0-9._-]{1,100}$`).test(path.slice(prefix.length))
    && !path.slice(prefix.length).includes('..');
}

/** Why a chosen file cannot be proof, or null when it can. */
export function proofFileProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!PROOF_MEDIA_TYPES.has(file.type)) return 'type';
  if (file.size <= 0 || file.size > MAX_PROOF_BYTES) return 'size';
  return null;
}
