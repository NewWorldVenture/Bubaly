import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const documentsView = readFileSync('components/modules/documents-module.tsx', 'utf8');
const messages = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

describe('documents import action contract', () => {
  it('does not expose disconnected cloud-provider actions', () => {
    expect(documentsView).not.toContain('Add from Google Drive');
    expect(documentsView).not.toContain('Add from Dropbox');
    expect(documentsView).not.toContain('function comingSoon');

    // The action labels are catalogue keys now, so the English literals above
    // cannot occur in the component. A provider re-added as a key has to fail
    // too: by its name, by the list of actions, and by what the keys say.
    expect(documentsView).not.toMatch(/google\s*drive|dropbox/i);
    const actionKeys = [...documentsView.matchAll(/label: tr\('(documentsModule\.action\.[^']+)'\)/g)].map((m) => m[1]);
    expect(actionKeys).toEqual([
      'documentsModule.action.uploadFiles',
      'documentsModule.action.createNewFolder',
      'documentsModule.action.scanDocument',
    ]);
    const renderedKeys = [...documentsView.matchAll(/\btr\('([^']+)'/g)].map((m) => m[1]);
    expect(renderedKeys.length).toBeGreaterThan(actionKeys.length);
    for (const key of renderedKeys) {
      expect(messages[key] ?? '', `${key} must not word a cloud-provider action`).not.toMatch(/google\s*drive|dropbox/i);
    }
  });

  it('keeps the supported local document actions available', () => {
    // Worded from the catalogue (audit C1-S9-120); the three actions stay.
    expect(documentsView).toContain("label: tr('documentsModule.action.uploadFiles')");
    expect(documentsView).toContain("label: tr('documentsModule.action.createNewFolder')");
    expect(documentsView).toContain("label: tr('documentsModule.action.scanDocument')");
  });
});
