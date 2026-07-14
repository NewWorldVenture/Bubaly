import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('social account and workspace action boundaries', () => {
  it('checks and sanitizes account connection and disconnect writes', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain("describeActionError(error, 'Could not start the account connection.')");
    expect(source).toContain("const { data, error } = await supabase\n    .from('social_accounts')");
    expect(source).toContain(".select('id')\n    .single()");
    expect(source).toContain("describeActionError(error, 'Could not disconnect that account.')");
  });

  it('checks inbox resolution persistence before revalidation', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain(".from('social_comments')");
    expect(source).toContain(".update({ status: 'resolved', updated_by: userId })");
    expect(source).toContain("describeActionError(error, 'Could not resolve that comment.')");
  });

  it('validates media input and checks the media row before success', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain("const mediaKinds = ['image', 'video', 'audio', 'document', 'thumbnail'] as const");
    expect(source).toContain("if (!['http:', 'https:'].includes(parsedUrl.protocol))");
    expect(source).toContain(".from('social_media_library').insert({");
    expect(source).toContain("describeActionError(error, 'Could not save that media asset.')");
  });

  it('checks workspace settings persistence and bounds user input', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain("default_timezone.length > 80");
    expect(source).toContain("signature.length > 300");
    expect(source).toContain(".from('social_settings').upsert(");
    expect(source).toContain("describeActionError(error, 'Could not save social settings.')");
  });

  it('requires manage-access and an active family member for role grants', () => {
    const source = readFileSync('app/(app)/dashboard/social/actions.ts', 'utf8');

    expect(source).toContain("requireSocialPermission(fid, 'manage_access')");
    expect(source).toContain('isSocialRole(role)');
    expect(source).toContain(".from('family_members')");
    expect(source).toContain(".eq('is_active', true)");
    expect(source).toContain(".from('social_access_permissions').upsert(");
    expect(source).toContain("describeActionError(error, 'Could not update social access.')");
  });
});
