import { describe, it, expect } from 'vitest';
import { isOverUploadLimit, MAX_UPLOAD_BYTES, UPLOAD_LIMIT_LABEL, buildFamilyPath } from '@/lib/storage/documents';

describe('upload limit guard', () => {
  it('rejects files over the ceiling, accepts at/under', () => {
    expect(isOverUploadLimit(MAX_UPLOAD_BYTES + 1)).toBe(true);
    expect(isOverUploadLimit(MAX_UPLOAD_BYTES)).toBe(false);
    expect(isOverUploadLimit(0)).toBe(false);
  });
  it('is 25 MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(UPLOAD_LIMIT_LABEL).toBe('25 MB');
  });
});

describe('buildFamilyPath stays inside the family folder', () => {
  it('prefixes family_id/folder and sanitizes the name', () => {
    const p = buildFamilyPath('fam-1', 'general', 'my report!.pdf');
    expect(p.startsWith('fam-1/general/')).toBe(true);
    expect(p).toMatch(/my_report_\.pdf$/);
  });
});
