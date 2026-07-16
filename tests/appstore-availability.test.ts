import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const installButton = readFileSync('components/appstore/install-button.tsx', 'utf8');
const appStorePage = readFileSync('app/(app)/dashboard/app-store/page.tsx', 'utf8');

describe('app store availability contract', () => {
  it('uses explicit unavailable copy for catalog entries that cannot be installed', () => {
    expect(installButton).toContain('Unavailable');
    expect(installButton).not.toContain('Coming soon');
    expect(appStorePage).toContain("available={app.status !== 'coming_soon'}");
  });
});
