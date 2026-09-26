import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';
import { hrefPath } from '@/lib/sync/providers/apple';

/**
 * Audit C3-S5-07.
 *
 * `dav()` attaches the Apple app-specific password to whatever URL it is
 * handed, and every path it receives originates in XML the REMOTE server
 * returned. All four parsers do normalise through `hrefPath()`, so there was no
 * live path by which an absolute URL reached it — this makes the invariant
 * local to the function that depends on it, rather than resting on four callers
 * continuing to agree.
 */
// Comments blanked: this file's own comments quote `redirect: 'manual'` and the
// path check, and a guard satisfied by the prose explaining it is the defect
// this audit is named for (C4-S5-01).
const src = readFileSync('lib/sync/providers/apple.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('the CalDAV transport refuses anything but a server-relative path', () => {
  it('checks the path before it builds a URL or attaches the credential', () => {
    expect(at(src, "path.startsWith('/')")).toBeLessThan(at(src, 'appleBasicAuth(packed)'));
    // The absolute-URL branch is gone: there is no longer a way to send this
    // credential anywhere but the configured base.
    expect(src).not.toContain("path.startsWith('http') ? path :");
  });

  it('does not follow redirects, and says so when it gets one', () => {
    expect(src).toContain("redirect: 'manual'");
    expect(src).toContain('refusing to follow it');
    expect(at(src, "redirect: 'manual'")).toBeLessThan(at(src, 'res.status >= 300'));
  });
});

describe('hrefPath does not fall through to an unnormalised value', () => {
  it('normalises an absolute href to its path', () => {
    expect(hrefPath('https://caldav.icloud.com/1234/calendars/home/')).toBe('/1234/calendars/home/');
  });

  it('answers "/" for a malformed absolute href instead of returning it', () => {
    // It used to return the input unchanged, handing an absolute-looking string
    // back to a caller that had asked for a path.
    expect(hrefPath('https://')).toBe('/');
    expect(hrefPath('http://[')).toBe('/');
  });

  it('leaves a server-relative href alone', () => {
    expect(hrefPath('  /1234/calendars/home/  ')).toBe('/1234/calendars/home/');
  });
});
