import { describe, expect, it } from 'vitest';
import { readUiSource } from './helpers/i18n-source';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';

const mod = readUiSource('components/modules/calendar-module.tsx');

// The Connect Outlook control on /dashboard/calendar.
//
// "Works 100% of the time" is mostly a question of what happens in the states
// that are NOT the happy path, because the happy path needs a registered Entra
// app that most deployments do not have yet. The states are:
//
//   probe unanswered   → render nothing (never a button that might be wrong)
//   not connected      → Connect Outlook → /api/sync/microsoft/auth
//   connected          → a link to the account page, not another Connect
//   not configured     → still Connect, because /auth redirects to the setup
//                        page with an explanation rather than erroring
//
// The last one is the interesting one: the link is safe to click even when the
// server holds no Microsoft credentials, so the control never has to be hidden
// or disabled, and can never become a dead end.
describe('Connect Outlook button', () => {
  // Compared by HREF, not by label. "Connect Google" also appears in a comment
  // earlier in this file, and matching that instead made the first version of
  // this test pass on prose while the buttons were in the wrong order.
  it('sits to the LEFT of Connect Google', () => {
    const outlook = mod.indexOf('href="/api/sync/microsoft/auth"');
    const google = mod.indexOf('href="/api/google/calendar/auth"');
    expect(outlook).toBeGreaterThan(-1);
    expect(google).toBeGreaterThan(-1);
    expect(outlook).toBeLessThan(google);
  });

  it('points at the provider-generic auth route', () => {
    expect(mod).toContain('href="/api/sync/microsoft/auth"');
  });

  it('is a plain link, so it cannot get stuck in a pressed state', () => {
    const start = mod.indexOf('href="/api/sync/microsoft/auth"');
    const anchor = mod.slice(start - 200, start + 400);
    expect(anchor).toContain('<a');
    expect(anchor).not.toContain('onClick');
    expect(anchor).not.toContain('disabled');
  });

  it('renders the Connect control only while NOT connected', () => {
    expect(mod).toContain('outlookStatus?.connected === false');
  });

  it('swaps to the account link once connected, never a second Connect', () => {
    expect(mod).toContain('outlookStatus?.connected === true');
    expect(mod).toContain('href="/dashboard/sync/accounts/microsoft"');
    expect(mod).toContain('Outlook connected');
  });

  it('renders nothing until the probe answers — no flash of the wrong control', () => {
    // `?.` on a null initial state means both branches are false while loading.
    expect(mod).toContain('const [outlookStatus, setOutlookStatus] = useState<{ configured: boolean; connected: boolean } | null>(null)');
  });

  it('still offers Connect when the server has no Microsoft credentials', () => {
    // configured:false must NOT gate the button — only `connected` does. If a
    // deployment without an Entra app hid the control, the setup page it links
    // to would be unreachable from the calendar, which is where people look.
    const start = mod.indexOf('outlookStatus?.connected === false');
    const branch = mod.slice(start, start + 600);
    expect(branch).not.toContain('configured &&');
    expect(branch).not.toContain('configured ===');
    // …and it explains itself on hover instead. Asserted through the catalogue
    // rather than the rendered source: the two titles sit in a ternary, which
    // readUiSource deliberately leaves alone, and a bare key assertion would
    // pass even if the catalogue entry were blank.
    expect(mod).toContain("tr('calendar.connectOutlookSetupTitle')");
    expect(mod).toContain("tr('calendar.connectOutlookTitle')");
    expect(SOURCE_MESSAGES['calendar.connectOutlookSetupTitle']).toMatch(/set up|configur/i);
    expect(SOURCE_MESSAGES['calendar.connectOutlookTitle']).toMatch(/Outlook/);
  });

  it('degrades to a usable control when the status probe itself fails', () => {
    // The catch settles to not-connected so the Connect link renders; the
    // alternative (leaving it null) would hide the button on a transient blip.
    expect(mod).toContain('.catch(() => setOutlookStatus({ configured: true, connected: false }))');
  });

  it('probes Outlook independently of Google', () => {
    // Two separate fetches, not one combined call: a Google outage must not
    // decide what the Outlook control says, or vice versa.
    expect(mod).toContain("fetch('/api/sync/microsoft/status')");
    expect(mod).toContain("fetch('/api/google/calendar/sync')");
    expect(mod).not.toMatch(/Promise\.all\(\[[^\]]*microsoft\/status/);
  });

  it('carries its own brand mark, not the Google one', () => {
    expect(mod).toContain('function OutlookGlyph');
    const start = mod.indexOf('href="/api/sync/microsoft/auth"');
    expect(mod.slice(start, start + 400)).toContain('<OutlookGlyph />');
  });
});
