import { describe, it, expect } from 'vitest';
import {
  filterByView, searchDocs, sortDocs, groupByCategory, formatBytes, storageSummary, fileKind,
  type DocLike,
} from '@/lib/files/overview';

function doc(over: Partial<DocLike>): DocLike {
  return { id: Math.random().toString(36), title: 'File', category: null, mime_type: null, size_bytes: 0, is_secure: false, is_favorite: false, created_at: '2026-05-01T00:00:00Z', ...over };
}

describe('filterByView', () => {
  const docs = [doc({ is_secure: true }), doc({ is_secure: false }), doc({ is_secure: false })];
  it('cloud = all, vault = secure, shared = non-secure', () => {
    expect(filterByView(docs, 'cloud')).toHaveLength(3);
    expect(filterByView(docs, 'vault')).toHaveLength(1);
    expect(filterByView(docs, 'shared')).toHaveLength(2);
  });
});

describe('searchDocs', () => {
  const docs = [doc({ title: 'Passport.pdf', category: 'Travel' }), doc({ title: 'Lease', category: 'Housing' })];
  it('matches title or category, case-insensitive; empty = all', () => {
    expect(searchDocs(docs, 'pass').map((d) => d.title)).toEqual(['Passport.pdf']);
    expect(searchDocs(docs, 'housing')).toHaveLength(1);
    expect(searchDocs(docs, '')).toHaveLength(2);
  });
});

describe('sortDocs', () => {
  const docs = [
    doc({ title: 'B', size_bytes: 10, created_at: '2026-05-01T00:00:00Z' }),
    doc({ title: 'A', size_bytes: 30, created_at: '2026-05-03T00:00:00Z' }),
    doc({ title: 'C', size_bytes: 20, created_at: '2026-05-02T00:00:00Z' }),
  ];
  it('recent = newest first', () => { expect(sortDocs(docs, 'recent').map((d) => d.title)).toEqual(['A', 'C', 'B']); });
  it('name = A→Z', () => { expect(sortDocs(docs, 'name').map((d) => d.title)).toEqual(['A', 'B', 'C']); });
  it('size = largest first', () => { expect(sortDocs(docs, 'size').map((d) => d.title)).toEqual(['A', 'C', 'B']); });
});

describe('groupByCategory', () => {
  it('buckets by category with counts + bytes, default General', () => {
    const folders = groupByCategory([
      doc({ category: 'Travel', size_bytes: 100 }),
      doc({ category: 'Travel', size_bytes: 200 }),
      doc({ category: null, size_bytes: 50 }),
    ]);
    expect(folders[0]).toMatchObject({ name: 'Travel', count: 2, bytes: 300 });
    expect(folders.find((f) => f.name === 'General')).toMatchObject({ count: 1, bytes: 50 });
  });
});

describe('formatBytes', () => {
  it('formats 1024-based sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_517_000)).toBe('2.4 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('storageSummary', () => {
  it('totals files/bytes/secure/shared', () => {
    const s = storageSummary([doc({ is_secure: true, size_bytes: 100 }), doc({ is_secure: false, size_bytes: 200 })]);
    expect(s).toEqual({ files: 2, bytes: 300, secure: 1, shared: 1 });
  });
});

describe('fileKind', () => {
  it('classifies by mime then extension', () => {
    expect(fileKind('image/png')).toBe('image');
    expect(fileKind(null, 'photo.jpg')).toBe('image');
    expect(fileKind('application/pdf')).toBe('pdf');
    expect(fileKind(null, 'sheet.xlsx')).toBe('sheet');
    expect(fileKind(null, 'notes.docx')).toBe('doc');
    expect(fileKind(null, 'clip.mp4')).toBe('video');
    expect(fileKind(null, 'backup.zip')).toBe('archive');
    expect(fileKind(null, 'unknown.xyz')).toBe('file');
  });
});
