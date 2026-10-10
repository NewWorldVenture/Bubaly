// The other family-scoped link columns a member can write and a parent is
// shown as Bubaly's own: `agent_activity.href` (0127), `daily_insights.href`
// (0141), `prep_plan_steps.href` (0131) and the Operating Index's stored
// `suggestions[].href` (0125). Every one of those tables is
// `is_family_member(family_id)` for INSERT and UPDATE, so a child's session can
// PATCH a row's link to https://evil.example, and before this change each
// surface rendered it as an in-app link:
//
//   agent_activity   -> Home "Completed by Bubaly", the brief's "handled", the
//                       Calm inbox, the Agents page
//   operating index  -> the Calm inbox
//   daily_insights   -> the Home insight hero (an extra `kind` with a high
//                       `impact` ranks first)
//   prep_plan_steps  -> the Planning page's step links
//
// The rule is the one sign-in redirects use (lib/auth/redirect `inAppHref`).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergeCompletedByBubaly } from '@/lib/home/today';
import { buildCalmInbox, type CalmItem } from '@/lib/calm/inbox';

const ORIGIN = 'https://www.bubaly.com';
const landsOn = (href: string) => new URL(href, `${ORIGIN}/home`).origin;
const OFF_APP = ['https://evil.example/login', '//evil.example', '/\\evil.example', '/\t/evil.example'];

describe('the attack strings really do leave the app', () => {
  it('each resolves to another origin in a browser', () => {
    for (const href of OFF_APP) expect(landsOn(href), href).not.toBe(ORIGIN);
  });
});

describe('Completed by Bubaly (Home and the brief) never links an activity off the app', () => {
  const activity = (href: string | null) => [{ id: 'act-1', title: 'Booked the plumber', detail: null, href, created_at: '2026-09-05T09:00:00Z', agent: 'home' }];

  it('sends an off-app activity link to the agents page instead', () => {
    for (const href of OFF_APP) {
      const [item] = mergeCompletedByBubaly([], activity(href));
      expect(item.href, href).toBe('/dashboard/agents');
    }
  });

  it('keeps an in-app activity link exactly as written', () => {
    expect(mergeCompletedByBubaly([], activity('/dashboard/home#leak'))[0].href).toBe('/dashboard/home#leak');
    expect(mergeCompletedByBubaly([], activity(null))[0].href).toBe('/dashboard/agents');
  });
});

describe('the Calm inbox never links an item off the app', () => {
  const item = (id: string, href: string | null, severity: CalmItem['severity'] = 'action'): CalmItem =>
    ({ id, source: id.startsWith('foi') ? 'operating_index' : 'agent', title: `Item ${id}`, detail: null, href, severity });

  it('drops an off-app link from an agent or Operating Index item and keeps the item', () => {
    const items = OFF_APP.flatMap((href, i) => [item(`agent:${i}`, href), item(`foi:${i}`, href, 'attention')]);
    const inbox = buildCalmInbox(items, { urgentCap: 50, todayCap: 50 });
    const shown = [...inbox.needsYou, ...inbox.today];
    expect(shown).toHaveLength(items.length);
    for (const it of shown) expect(it.href, it.id).toBeNull();
  });

  it('keeps an in-app link, and leaves an item without one untouched', () => {
    const inbox = buildCalmInbox([item('agent:a', '/dashboard/agents'), { id: 'r', source: 'reminder', title: 'Pick up', severity: 'action' }]);
    expect(inbox.needsYou.find((i) => i.id === 'agent:a')?.href).toBe('/dashboard/agents');
    expect(inbox.needsYou.find((i) => i.id === 'r')).toEqual({ id: 'r', source: 'reminder', title: 'Pick up', severity: 'action' });
  });
});

describe('the component render sites go through the same rule', () => {
  // These three map a stored row straight into a link inside a component, with
  // no pure seam to call. Pinned at the line that turns the row into an href.
  const SITES: { file: string; raw: string; guarded: string; column: string }[] = [
    { file: 'components/modules/agents-module.tsx', column: 'agent_activity.href', raw: 'arr.push(a);', guarded: 'arr.push({ ...a, href: inAppHref(a.href) });' },
    { file: 'components/dashboard/ai-home-dashboard.tsx', column: 'daily_insights.href', raw: "href: r.href ?? '/dashboard'", guarded: "href: inAppHref(r.href) ?? '/dashboard'" },
    { file: 'components/modules/planning-module.tsx', column: 'prep_plan_steps.href', raw: "href={s.href ?? '#'}", guarded: "href={inAppHref(s.href) ?? '#'}" },
  ];

  for (const site of SITES) {
    it(`${site.file} renders ${site.column} through inAppHref`, () => {
      const src = readFileSync(site.file, 'utf8');
      expect(src, `${site.file} still renders ${site.column} raw`).not.toContain(site.raw);
      expect(src).toContain(site.guarded);
      expect(src).toContain("import { inAppHref } from '@/lib/auth/redirect';");
    });
  }
});
