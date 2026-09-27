import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, defaultSocialRoleForMember } from '@/lib/social/roles';

// Batch B6b of the page audit submitted every form on the signed-in pages with
// ordinary values. These are the forms that answered with a 500 and the
// section's error page, or with a request for a page that does not exist,
// when the person had done nothing wrong or nothing the page had told them not
// to do.
const read = (f: string) => readFileSync(f, 'utf8');

describe('a form a page offers can be submitted', () => {
  it('social settings: the role controls are live only for a caller who may grant roles', () => {
    // A parent's default social role is admin, which may change settings but
    // not access (0348). The page enabled "Set" on manage_settings; the action
    // requires manage_access and threw.
    expect(ROLE_PERMISSIONS[defaultSocialRoleForMember('parent')]).toContain('manage_settings');
    expect(ROLE_PERMISSIONS[defaultSocialRoleForMember('parent')]).not.toContain('manage_access');
    const page = read('app/(app)/dashboard/social/settings/page.tsx');
    const actions = read('app/(app)/dashboard/social/actions.ts');
    const grant = actions.slice(actions.indexOf('export async function grantAccessAction'));
    expect(grant).toMatch(/requireSocialPermission\(fid, 'manage_access'\)/);
    expect(page).toContain("const canManageAccess = access?.can('manage_access') ?? false;");
    const form = page.slice(page.indexOf('action={grantAccessAction}'), page.indexOf('</form>', page.indexOf('action={grantAccessAction}')));
    expect(form).toContain('disabled={!canManageAccess}');
    expect(form).not.toContain('disabled={!canManage}');
  });

  it('marketing automation: a new workflow starts with an action ticked', () => {
    // The action throws on an empty action list, which lands on the error page.
    const page = read('app/(app)/admin/marketing/automation/page.tsx');
    expect(page).toMatch(/name="actions" value=\{a\} defaultChecked=\{i === 0\}/);
  });

  it('media library and marketing video: a URL field is a URL field', () => {
    // Both actions throw on a value they refuse; the browser now refuses it first.
    expect(read('app/(app)/dashboard/social/media-library/page.tsx')).toMatch(/<input name="url" type="url" pattern="https\?:\/\/\.\+"/);
    // The video action takes YouTube or Vimeo only (lib/marketing/video.ts).
    const pattern = /<input name="url" type="url" pattern="([^"]+)"/.exec(read('app/(app)/admin/marketing/video/page.tsx'))?.[1];
    expect(pattern).toBeDefined();
    const accepts = (url: string) => new RegExp(`^(?:${pattern})$`, 'v').test(url);
    expect(accepts('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(accepts('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(accepts('https://player.vimeo.com/video/123456')).toBe(true);
    expect(accepts('https://example.com/video')).toBe(false);
    expect(accepts('https://evilyoutube.com/watch')).toBe(false);
  });

  it('recipes: a photo is drawn only from an http(s) URL', () => {
    // "Audit 6" typed as the photo became <img src="Audit 6">, a request for
    // /dashboard/Audit%206 that answered 404 on every render of the card.
    const src = read('components/modules/recipes-module.tsx');
    expect(src).not.toMatch(/<img src=\{(recipe|viewing)\.photo_url\}/);
    expect(src.match(/<img src=\{safeWebLink\((recipe|viewing)\.photo_url\) \?\? undefined\}/g)).toHaveLength(2);
    expect(src).toMatch(/name="photo_url" type="url"/);
    expect(src).toMatch(/name="source_url" type="url"/);
  });
});
