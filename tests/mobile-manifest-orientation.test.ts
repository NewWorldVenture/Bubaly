import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';

// M-025: the PWA manifest locked the installed app to portrait, so iPads /
// Android tablets couldn't rotate — and the /display kitchen-wall kiosk (a
// landscape-tablet surface, with M-014 landscape safe-area support shipped)
// would render sideways when launched from the installed app. Orientation must
// stay 'any'; pinch-zoom must stay enabled app-wide (no user-scalable lock).
describe('PWA manifest orientation (M-025)', () => {
  it('allows rotation (orientation: any) with standalone display', () => {
    const m = manifest();
    expect(m.orientation).toBe('any');
    expect(m.display).toBe('standalone');
  });

  it('keeps the installable identity intact (icons + start_url + scope)', () => {
    const m = manifest();
    expect(m.start_url).toBe('/dashboard');
    expect(m.scope).toBe('/');
    expect((m.icons ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
