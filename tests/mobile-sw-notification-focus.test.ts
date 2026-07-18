import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// M-026: tapping a push notification must focus + navigate an already-open app
// window, not stack a new instance/tab on every tap (the previous handler
// called openWindow unconditionally). openWindow remains only as the fallback
// when no window is open.
const sw = readFileSync('public/sw.js', 'utf8');

describe('SW notification tap focuses the existing window (M-026)', () => {
  it('matches open windows before opening a new one', () => {
    const block = sw.slice(sw.indexOf("addEventListener('notificationclick'"));
    expect(block).toContain("matchAll({ type: 'window', includeUncontrolled: true })");
    expect(block).toContain('win.focus()');
    expect(block).toContain('focused.navigate(target)');
    // openWindow must come AFTER the focus path (fallback only).
    expect(block.indexOf('matchAll')).toBeLessThan(block.indexOf('openWindow'));
  });

  it('still closes the notification and defaults to /dashboard', () => {
    const block = sw.slice(sw.indexOf("addEventListener('notificationclick'"));
    expect(block).toContain('event.notification.close();');
    expect(block).toContain("event.notification.data || '/dashboard'");
  });
});
