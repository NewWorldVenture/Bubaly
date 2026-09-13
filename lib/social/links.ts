/** Social content links are external web URLs, including when read from storage. */
export function safeSocialLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
