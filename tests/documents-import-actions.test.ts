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
    // Worded from the catalogue (audit C1-S9-120); the three actions stay.
    expect(documentsView).toContain("label: tr('documentsModule.action.uploadFiles')");
    expect(documentsView).toContain("label: tr('documentsModule.action.createNewFolder')");
    expect(documentsView).toContain("label: tr('documentsModule.action.scanDocument')");
  });
});
