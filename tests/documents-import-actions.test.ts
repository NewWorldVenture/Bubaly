import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const documentsView = readFileSync('components/modules/documents-module.tsx', 'utf8');

describe('documents import action contract', () => {
  it('does not expose disconnected cloud-provider actions', () => {
    expect(documentsView).not.toContain('Add from Google Drive');
    expect(documentsView).not.toContain('Add from Dropbox');
    expect(documentsView).not.toContain('function comingSoon');
  });

  it('keeps the supported local document actions available', () => {
    expect(documentsView).toContain("label: 'Upload Files'");
    expect(documentsView).toContain("label: 'Create New Folder'");
    expect(documentsView).toContain("label: 'Scan Document'");
  });
});
