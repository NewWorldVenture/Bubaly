import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { readFileSync } from 'node:fs';

const installButton = readUiSource('components/appstore/install-button.tsx');
const appStorePage = readUiSource('app/(app)/dashboard/app-store/page.tsx');

describe('app store availability contract', () => {
  it('uses explicit unavailable copy for catalog entries that cannot be installed', () => {
    expect(installButton).toContain('Unavailable');
    expect(installButton).not.toContain('Coming soon');
    expect(appStorePage).toContain("available={app.status !== 'coming_soon'}");
  });
});
