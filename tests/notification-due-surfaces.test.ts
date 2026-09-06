import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// "Deferred" has to mean deferred on every surface, or it means nothing.
//
// A notification can be scheduled ahead: `notify()` accepts an explicit
// `sendAt`, and the AI's `notifications.notify` tool advertises it to the model
// as "Earliest delivery, ISO 8601". Four surfaces read the table, and they were
// not agreed:
//
//   deliverNotificationEmails  filtered send_at   ✓ (lib/server/notification-emails.ts)
//   listUnread                 filtered send_at   ✓ but has NO caller — the
//                                                   service function is used
//                                                   only by its own tests
//   dispatchPendingPushes      did not            ✗ fixed alongside this
//   the bell + the module      did not            ✗ fixed here
//
// So the two surfaces a family actually looks at showed — and counted — a
// notice scheduled for 8am tomorrow, tonight. This asserts the filter is on the
// query itself rather than applied after the read, because the bell uses
// `head: true` and never receives rows to filter.

const SURFACES: [string, string][] = [
  ['components/app/notification-bell.tsx', 'the unread badge'],
  ['components/modules/notifications-module.tsx', 'the notifications list'],
];

describe('every in-app notification surface reads only what is due', () => {
  it.each(SURFACES)('%s filters on send_at', (file) => {
    const source = readFileSync(file, 'utf8');
    // A fixed window rather than a brace scan: the bell's own select carries
    // `{ count: 'exact', head: true }`, so cutting at the first `}` ends the
    // slice before the filters. Both query chains are well inside 600 chars.
    const start = source.indexOf("from('notifications')");
    const body = source.slice(start, start + 600);
    expect(body, `${file} must not count or show a notification before it is due`)
      .toMatch(/\.lte\('send_at',/);
  });

  it('the server-side delivery paths agree with them', () => {
    // Named individually rather than globbed: a new delivery path should have
    // to be added here deliberately, which is the moment to ask whether it
    // needs the filter too.
    expect(readFileSync('lib/server/push.ts', 'utf8')).toMatch(/\.lte\('send_at',/);
    expect(readFileSync('lib/server/notification-emails.ts', 'utf8')).toMatch(/\.lte\('send_at', nowIso\)/);
    expect(readFileSync('lib/services/notifications/index.ts', 'utf8')).toMatch(/\.lte\('send_at', nowIso\)/);
  });

  it('the bell counts on the server rather than filtering rows it never fetched', () => {
    // `head: true` means no rows come back, so a `.filter()` after the await
    // would silently do nothing. The guard has to be part of the query.
    const bell = readFileSync('components/app/notification-bell.tsx', 'utf8');
    expect(bell).toContain("{ count: 'exact', head: true }");
    expect(bell.indexOf(".lte('send_at'")).toBeGreaterThan(bell.indexOf("from('notifications')"));
  });
});
