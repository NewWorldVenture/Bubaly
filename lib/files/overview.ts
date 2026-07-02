// lib/files/overview.ts
// Pure, deterministic helpers for the Files hub sub-pages (Cloud Storage / Secure
// Vault / Shared Files). Filtering by view, search, category grouping, byte
// formatting, and a storage summary — all pure transforms of already-fetched
// `documents` rows so they are unit-tested directly and shared across the pages.

export type FileView = 'cloud' | 'vault' | 'shared';

export type DocLike = {
  id: string;
  title: string;
  category: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  is_secure: boolean;
  is_favorite: boolean;
  created_at: string;
};

export const VIEW_META: Record<FileView, { title: string; description: string; folder: string }> = {
  cloud: { title: 'Cloud Storage', description: 'Every file your family has stored, in one place.', folder: 'cloud' },
  vault: { title: 'Secure Vault', description: 'Encrypted, private files only members can open.', folder: 'vault' },
  shared: { title: 'Shared Files', description: 'Files shared with the whole family.', folder: 'shared' },
};

/** Which documents belong to a given view. Cloud = all; Vault = secure; Shared = non-secure. */
export function filterByView(docs: DocLike[], view: FileView): DocLike[] {
  if (view === 'vault') return docs.filter((d) => d.is_secure);
  if (view === 'shared') return docs.filter((d) => !d.is_secure);
  return docs;
}

/** Case-insensitive search over title + category. Empty query returns all. */
export function searchDocs(docs: DocLike[], query: string): DocLike[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  return docs.filter((d) => d.title.toLowerCase().includes(q) || (d.category ?? '').toLowerCase().includes(q));
}

export type SortKey = 'recent' | 'name' | 'size';

export function sortDocs(docs: DocLike[], key: SortKey): DocLike[] {
  const copy = [...docs];
  if (key === 'name') return copy.sort((a, b) => a.title.localeCompare(b.title));
  if (key === 'size') return copy.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
  return copy.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export type Folder = { name: string; count: number; bytes: number };

/** Group docs into folders by category (default "General"), sorted by count. */
export function groupByCategory(docs: DocLike[]): Folder[] {
  const by = new Map<string, Folder>();
  for (const d of docs) {
    const name = d.category?.trim() || 'General';
    const f = by.get(name) ?? { name, count: 0, bytes: 0 };
    f.count += 1;
    f.bytes += d.size_bytes ?? 0;
    by.set(name, f);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Human-readable byte size (1024-based), e.g. 2.4 MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
}

export type StorageSummary = { files: number; bytes: number; secure: number; shared: number };

export function storageSummary(docs: DocLike[]): StorageSummary {
  return docs.reduce<StorageSummary>((acc, d) => {
    acc.files += 1;
    acc.bytes += d.size_bytes ?? 0;
    if (d.is_secure) acc.secure += 1; else acc.shared += 1;
    return acc;
  }, { files: 0, bytes: 0, secure: 0, shared: 0 });
}

// Coarse file-kind from a MIME type, for choosing an icon + accent color.
export type FileKind = 'image' | 'pdf' | 'doc' | 'sheet' | 'video' | 'audio' | 'archive' | 'file';

export function fileKind(mime: string | null | undefined, title = ''): FileKind {
  const m = (mime ?? '').toLowerCase();
  const ext = title.toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  if (m.includes('pdf') || ext === 'pdf') return 'pdf';
  if (m.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  if (m.includes('spreadsheet') || m.includes('excel') || ['csv', 'xls', 'xlsx'].includes(ext)) return 'sheet';
  if (m.includes('word') || m.includes('document') || ['doc', 'docx', 'txt', 'rtf'].includes(ext)) return 'doc';
  if (m.includes('zip') || m.includes('compressed') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  return 'file';
}
