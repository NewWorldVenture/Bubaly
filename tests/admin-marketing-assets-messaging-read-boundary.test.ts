import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assets = readFileSync('app/(app)/admin/marketing/assets/page.tsx', 'utf8');
const email = readFileSync('app/(app)/admin/marketing/email/page.tsx', 'utf8');
const sms = readFileSync('app/(app)/admin/marketing/sms/page.tsx', 'utf8');
const social = readFileSync('app/(app)/admin/marketing/social/page.tsx', 'utf8');
const forms = readFileSync('app/(app)/admin/marketing/forms/page.tsx', 'utf8');

describe('admin marketing asset and messaging read boundaries', () => {
  it('preserves database and signed-preview failures in the asset library', () => {
    expect(assets).toContain('assetsError');
    expect(assets).toContain('signedError');
    expect(assets).toContain("console.error('[admin-marketing-assets] asset preview read failed'");
    expect(assets).toContain('Could not load marketing assets from Supabase. Refresh and try again.');
  });

  it('does not turn email and SMS read failures into empty campaign states', () => {
    expect(email).toContain('emailsResult.error ?? segmentsResult.error');
    expect(email).toContain('Could not load marketing email data from Supabase. Refresh and try again.');
    expect(sms).toContain('smsResult.error ?? segmentsResult.error');
    expect(sms).toContain('Could not load marketing SMS data from Supabase. Refresh and try again.');
  });

  it('preserves social post and form submission read failures', () => {
    expect(social).toContain('postsError');
    expect(social).toContain('Could not load marketing social posts from Supabase. Refresh and try again.');
    expect(forms).toContain('formsResult.error ?? submissionsResult.error');
    expect(forms).toContain('Could not load marketing forms from Supabase. Refresh and try again.');
  });
});
