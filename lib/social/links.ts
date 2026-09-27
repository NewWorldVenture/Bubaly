import { safeWebLink } from '@/lib/utils/safe-link';

/** Social content links are external web URLs, including when read from storage. */
export function safeSocialLink(value: unknown): string | null {
  return safeWebLink(value);
}
