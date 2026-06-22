// lib/marketing/assets.ts — pure helpers for the marketing Asset Library (DAM).
// Kind inference, byte formatting, tag parsing, storage-path building and grouping.
// No server-only imports so it's unit-testable in isolation.

export const ASSET_KINDS = ['image', 'video', 'document', 'brand'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export function isAssetKind(v: string | null | undefined): v is AssetKind {
  return !!v && (ASSET_KINDS as readonly string[]).includes(v);
}

/** Infer a kind from a MIME type. `brand` can't be inferred — the caller sets it. */
export function assetKindFromMime(mime: string | null | undefined): AssetKind {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

export function isImageMime(mime: string | null | undefined): boolean {
  return (mime ?? '').toLowerCase().startsWith('image/');
}

/** Human-readable byte size (e.g. "2.4MB"). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const num = i === 0 || n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
  return `${num}${units[i]}`;
}

/** Parse a comma/newline-separated tag string into a clean, de-duped, kebab list. */
export function parseTags(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** Sanitise a filename for use inside a storage object path. */
export function sanitizeAssetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_').replace(/_+/g, '_').slice(-120) || 'asset';
}

/** Kind-partitioned storage path: {kind}/{id}-{safe filename}. The id keeps it
 *  collision-free; the kind prefix keeps the bucket browsable. */
export function buildAssetPath(kind: AssetKind, id: string, fileName: string): string {
  return `${kind}/${id}-${sanitizeAssetName(fileName)}`;
}

/** Group assets by kind for the admin gallery (stable kind order). */
export function assetsByKind<T extends { kind: string }>(assets: T[]): Record<AssetKind, T[]> {
  const out: Record<AssetKind, T[]> = { image: [], video: [], document: [], brand: [] };
  for (const a of assets) if (isAssetKind(a.kind)) out[a.kind].push(a);
  return out;
}
