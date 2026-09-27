import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import colors from 'tailwindcss/colors';
import { contrastRatio } from '@/lib/utils/readable-text';

// The signed-in phone crawl (axe, WCAG 2.1 A/AA, serious and critical) found,
// after the shell's own three: selects and inputs with no accessible name
// (select-name, label), icon-only toggle switches and buttons (button-name,
// link-name), tables in scroll boxes a keyboard cannot reach
// (scrollable-region-focusable), links told apart from their sentence by
// colour alone (link-in-text-block), a tablist holding a select, a list whose
// role was replaced, and small text under 4.5:1. Each case below reads the
// source that axe pointed at, so a control that loses its name again fails
// here rather than on the next crawl.

const read = (path: string) => readFileSync(path, 'utf8');

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(dir, f).replaceAll('\\', '/'));
}
const SURFACE = [...sourceFiles('app'), ...sourceFiles('components')];

/** The JSX opening tag starting at `from` (a '<'), with `{…}` balanced. */
function openingTag(src: string, from: number): string {
  let depth = 0;
  for (let i = from + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0 && c === '>') return src.slice(from, i + 1);
  }
  return src.slice(from);
}

/** The opening tag of the nearest `<tag` at or before `index`. */
function enclosingTag(src: string, index: number, tags: string[]): string {
  const starts = tags.map((t) => src.lastIndexOf(`<${t}`, index)).filter((i) => i >= 0);
  expect(starts.length, `no <${tags.join('|')} before offset ${index}`).toBeGreaterThan(0);
  return openingTag(src, Math.max(...starts));
}

/** Named by aria-label / aria-labelledby, or by an id a <label htmlFor> points at. */
function isNamed(src: string, tag: string): boolean {
  if (/\saria-label(ledby)?=/.test(tag)) return true;
  const id = /\sid=(\{[^}]+\}|"[^"]+")/.exec(tag)?.[1];
  return id !== undefined && src.includes(`htmlFor=${id}`);
}

describe('a filter select on an admin page', () => {
  const bar = read('components/admin/filter-bar.tsx');

  it('requires a label and renders it as the accessible name', () => {
    const fn = bar.slice(bar.indexOf('export function FilterSelect'), bar.indexOf('export function FilterSearchInput'));
    expect(fn).toMatch(/\blabel: string;/);
    expect(fn).not.toMatch(/\blabel\?: string/);
    expect(fn).toContain('aria-label={label}');
  });

  it('is given one at every call site', () => {
    const calls = SURFACE.flatMap((file) => {
      const src = read(file);
      return [...src.matchAll(/<FilterSelect\b/g)].map((m) => ({ file, tag: openingTag(src, m.index!) }));
    });
    // Non-vacuity: the eight admin pages axe named hold eighteen of these.
    expect(calls.length).toBeGreaterThanOrEqual(18);
    const unnamed = calls.filter((c) => !/\slabel=\{/.test(c.tag)).map((c) => `${c.file}: ${c.tag.slice(0, 80)}`);
    expect(unnamed).toEqual([]);
  });
});

describe('a toggle switch', () => {
  // The track is `relative h-6 w-11`; the <button> that owns it (the track
  // itself, or the row that wraps it) is the control.
  const sites = SURFACE.flatMap((file) => {
    const src = read(file);
    return [...src.matchAll(/relative h-6 w-11/g)].map((m) => {
      const start = src.lastIndexOf('<button', m.index!);
      const tag = openingTag(src, start);
      const body = src.slice(start + tag.length, src.indexOf('</button>', start));
      return { file, tag, body };
    });
  });

  it('is found where axe found it (non-vacuity)', () => {
    const files = new Set(sites.map((s) => s.file));
    for (const f of [
      'app/(app)/admin/wallet/admin-wallet-client.tsx',
      'components/modules/profile-module.tsx',
      'components/modules/intelligence-module.tsx',
      'components/modules/locator-module.tsx',
      'components/wallet/wallet-settings-view.tsx',
    ]) expect(files, f).toContain(f);
  });

  it('says it is a switch, whether it is on, and what it switches', () => {
    const bad = sites
      .filter((s) => !(s.tag.includes('role="switch"') && /\saria-checked=\{/.test(s.tag)
        && (/\saria-label=/.test(s.tag) || /\bt\('/.test(s.body))))
      .map((s) => `${s.file}: ${s.tag.slice(0, 100)}`);
    expect(bad).toEqual([]);
  });
});

describe('a form control axe found unnamed', () => {
  // [file, a string inside or just inside the control]. The control is the
  // nearest <select>, <Select>, <input> or <textarea> at or before it.
  const CONTROLS: [string, string][] = [
    ['app/(app)/admin/marketing/ads/page.tsx', 'name="platform"'],
    ['app/(app)/admin/marketing/aeo/page.tsx', "t('adminMarketingAeo.patternOptional')"],
    ['app/(app)/admin/marketing/assets/page.tsx', 'type="file"'],
    ['app/(app)/admin/marketing/competitive/page.tsx', 'name="status" defaultValue="active"'],
    ['app/(app)/admin/marketing/content/page.tsx', 'name="kind"'],
    ['app/(app)/admin/marketing/content/page.tsx', 'name="publish_at"'],
    ['app/(app)/admin/marketing/crm/page.tsx', 'name="lead_status"'],
    ['app/(app)/admin/marketing/crm/page.tsx', 'name="lifecycle_stage"'],
    ['app/(app)/admin/marketing/email/page.tsx', 'name="segment_id"'],
    ['app/(app)/admin/marketing/exit-intent/page.tsx', 'name="status" defaultValue="active"'],
    ['app/(app)/admin/marketing/exit-intent/page.tsx', 'name="mode"'],
    ['app/(app)/admin/marketing/exit-intent/page.tsx', 'name="returning"'],
    ['app/(app)/admin/marketing/personalization/page.tsx', 'name="status" defaultValue="active"'],
    ['app/(app)/admin/marketing/pipeline/page.tsx', 'name="stage"'],
    ['app/(app)/admin/marketing/pipeline/page.tsx', 'name="contact_id"'],
    ['app/(app)/admin/marketing/pipeline/page.tsx', 'name="close_date"'],
    ['app/(app)/admin/marketing/platform/page.tsx', 'name="title" defaultValue={page.title}'],
    ['app/(app)/admin/marketing/platform/page.tsx', 'name="slug" defaultValue={page.slug}'],
    ['app/(app)/admin/marketing/proposals/page.tsx', 'name="status" defaultValue="draft"'],
    ['app/(app)/admin/marketing/proposals/page.tsx', 'name="contact_id"'],
    ['app/(app)/admin/marketing/proposals/page.tsx', 'name="valid_until"'],
    ['app/(app)/admin/marketing/sms/page.tsx', 'name="segment_id"'],
    ['app/(app)/admin/marketing/social/page.tsx', 'name="platform"'],
    ['app/(app)/admin/marketing/social/page.tsx', 'name="scheduled_at"'],
    ['app/(app)/dashboard/social/media-library/page.tsx', "t('dashboardSocialMediaLibrary.image')"],
    ['components/admin/feedback-admin.tsx', "t('feedbackAdmin.allCategories')"],
    ['components/admin/service-descriptions-editor.tsx', 'maxLength={400}'],
    ['components/guardian/contact-list.tsx', "tr('contactList.allTrustLevels')"],
    ['components/knowledge/seed-screen.tsx', 'id="kb-seed-sql"'],
    ['components/marketplace/seed-screen.tsx', 'id="seed-sql"'],
    ['components/modules/behavior-module.tsx', "tr('behavior.allKids')"],
    // The points-period picker sits in the desktop-only right rail (found at 1280 px).
    ['components/modules/chores-module.tsx', 'setPointsWindow(e.target.value'],
    ['components/modules/health-visits-module.tsx', "t('healthVisits.everyone')"],
    ['components/modules/immunizations-module.tsx', "t('immunizations.everyone')"],
    ['components/modules/recipes-module.tsx', "tr('recipes.allCategories')"],
    ['components/modules/reminders-module.tsx', "tr('reminders.allTypes')"],
    ['components/modules/reminders-module.tsx', "tr('reminders.allLists')"],
    ['components/modules/timetable-module.tsx', "t('timetable.allStudents')"],
    ['components/modules/weekend-module.tsx', 'setRadius(Number(e.target.value))'],
    ['components/modules/weekend-module.tsx', 'setDays(Number(e.target.value))'],
    ['components/social/studio-form.tsx', 'setAiKind(e.target.value'],
    ['components/social/studio-form.tsx', "tr('studio.anyPlatform')"],
    ['components/wallet/pay-handle-manager.tsx', "t('payHandleManager.wholeFamily')"],
  ];

  it.each(CONTROLS)('%s: the control holding %s has a name', (file, marker) => {
    const src = read(file);
    const at = src.indexOf(marker);
    expect(at, `${marker} not found in ${file}`).toBeGreaterThanOrEqual(0);
    expect(src.indexOf(marker, at + 1), `${marker} is not unique in ${file}`).toBe(-1);
    const tag = enclosingTag(src, at, ['select', 'Select', 'input', 'textarea']);
    expect(isNamed(src, tag), tag).toBe(true);
  });
});

describe('an icon-only link or button', () => {
  it("names the Guardian pages' back arrow", () => {
    for (const page of ['contacts', 'history', 'rules', 'settings']) {
      const src = read(`app/(app)/guardian/${page}/page.tsx`);
      const tag = openingTag(src, src.indexOf('<a href="/guardian"'));
      expect(tag, page).toMatch(/\saria-label=\{t\('/);
    }
  });

  it("names the recipe finder's back arrow (found by the re-crawl)", () => {
    const src = read('app/(app)/dashboard/recipes/discover/discover-client.tsx');
    const tag = openingTag(src, src.indexOf('<Link href="/dashboard/recipes"'));
    expect(tag).toMatch(/\saria-label=\{t\('/);
  });

  it("names the assistant's New chat button, whose text is hidden on a phone", () => {
    const src = read('components/modules/assistant-module.tsx');
    const tag = enclosingTag(src, src.indexOf('onClick={newChat}'), ['button']);
    expect(tag).toContain("aria-label={t('assistant.newChat')}");
  });
});

describe('a table in a sideways-scrolling box', () => {
  const REGIONS: [string, string][] = [
    ['app/(app)/admin/billing/page.tsx', 'adminBilling.recentSubscriptions'],
    ['app/(app)/admin/marketing/health/page.tsx', 'adminMarketingHealth.customersNeedingAttention'],
    ['app/(app)/admin/sync/page.tsx', 'adminSync.providerCatalog'],
    ['app/(app)/dashboard/social/accounts/page.tsx', 'dashboardSocialAccounts.whatEachPlatformSupports'],
    ['app/(app)/dashboard/sync/page.tsx', 'dashboardSync.whatEachProviderSupports'],
    ['app/(app)/family/permissions/page.tsx', 'familyPermissions.permissionMatrix'],
    // Found by the re-crawl on the build with the first fixes.
    ['app/(app)/dashboard/journeys/page.tsx', 'dashboardJourneys.perJourneyMedians'],
  ];

  it.each(REGIONS)('%s: is a named, focusable region', (file, key) => {
    const src = read(file);
    const at = src.search(new RegExp(String.raw`role="region" tabIndex=\{0\} aria-label=\{(t|tr)\('${key.replace('.', '\\.')}'\)\}`));
    expect(at, `no named region for ${key}`).toBeGreaterThanOrEqual(0);
    const tag = enclosingTag(src, at, ['div']);
    expect(tag).toMatch(/className="[^"]*\bfocus-ring\b[^"]*\boverflow-x-auto\b/);
  });
});

describe('a link inside a sentence', () => {
  const LINKS: [string, string][] = [
    ['app/(app)/admin/billing/page.tsx', 'href="/admin/subscriptions"'],
    ['components/modules/scan-module.tsx', 'href="/dashboard/inbox"'],
    ['components/family/find-phone-view.tsx', "t('findPhone.locationSettings')"],
    ['app/(app)/marketplace/page.tsx', "t('marketplace.postTheFirstItem')"],
    ['app/(app)/marketplace/page.tsx', "t('marketplace.openTheFirstOne')"],
    ['app/(app)/marketplace/creators/page.tsx', "t('marketplaceCreators.openTheFirstOne')"],
    // Empty states the phone sweep did not reach (found by the desktop crawl).
    ['components/modules/calm-module.tsx', "t('calm.familyAssistant')"],
    ['components/wallet/child-detail-view.tsx', "t('childDetail.createOne')"],
  ];

  it.each(LINKS)('%s: the link at %s is underlined, not only coloured', (file, marker) => {
    const src = read(file);
    const tag = enclosingTag(src, src.indexOf(marker), ['Link']);
    const cls = /className="([^"]*)"/.exec(tag)?.[1] ?? '';
    expect(cls.split(/\s+/), tag).toContain('underline');
  });
});

describe("the family display's list tiles", () => {
  // At desktop width a list tile (calendar, chores, grocery…) scrolls inside a
  // fixed-height grid cell; the phone sweep stacks tiles and never saw it.
  it('are named regions the keyboard can reach', () => {
    const src = read('components/display/display-grid.tsx');
    const at = src.indexOf('role="region" tabIndex={0} aria-label={labelOf(tile.widget as WidgetKey)}');
    expect(at, 'no named, focusable region for a list tile').toBeGreaterThanOrEqual(0);
    const tag = enclosingTag(src, at, ['div']);
    expect(tag).toMatch(/className="[^"]*\boverflow-y-auto\b[^"]*\bfocus-ring\b/);
  });

  it('scroll once, at the tile: a list inside a tile is not a second, unreachable scroller', () => {
    // The re-crawl after the fix above still failed on the grocery list and the
    // members row, each an `overflow-y-auto` of its own inside the tile's region.
    const grid = read('components/display/display-grid.tsx');
    const grocery = enclosingTag(grid, grid.indexOf('data.grocery.items.slice'), ['ul']);
    const members = enclosingTag(grid, grid.indexOf('data.members.map((m) => ('), ['div']);
    const handled = read('components/display/handled-today-tile.tsx');
    const handledList = enclosingTag(handled, handled.indexOf('items.map('), ['ul']);
    for (const tag of [grocery, members, handledList]) expect(tag).not.toMatch(/overflow-(y-)?auto/);
  });
});

describe('roles that need particular children', () => {
  it("keeps the watchlist's status tablist to its tabs", () => {
    const src = read('components/modules/watchlist-module.tsx');
    const open = src.indexOf('role="tablist"');
    const inside = src.slice(open, src.indexOf('</div>', open));
    expect(inside).toContain('role="tab"');
    expect(inside).not.toMatch(/<Select\b|<span\b/);
  });

  it("leaves the display self-check's list a list", () => {
    const src = read('components/display/display-self-check.tsx');
    const tag = enclosingTag(src, src.indexOf('SELF_CHECK_IDS.map'), ['ul']);
    expect(tag).not.toContain('role=');
  });
});

describe('small text on a colour', () => {
  it('draws admin initials badges at 4.5:1 or better', () => {
    for (const file of ['app/(app)/admin/admins/page.tsx', 'app/(app)/admin/support-tickets/page.tsx']) {
      const src = read(file);
      const fn = src.slice(src.indexOf('function AvatarInitials'));
      const list = /const colors = \[([^\]]+)\]/.exec(fn)?.[1] ?? '';
      const pairs = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(pairs.length, file).toBe(6);
      expect(fn, file).not.toMatch(/font-bold text-fg \$\{/);
      for (const pair of pairs) {
        const bg = /\bbg-(\w+)-(\d+)\b/.exec(pair);
        const fg = /\btext-(white|black)\b/.exec(pair);
        expect(bg && fg, `${file}: ${pair}`).toBeTruthy();
        const palette = colors as unknown as Record<string, Record<string, string>>;
        const ratio = contrastRatio(fg![1] === 'white' ? '#ffffff' : '#000000', palette[bg![1]][bg![2]]);
        expect(ratio!, `${file}: ${pair}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("draws the Free tier's selected button dark enough for white text", () => {
    const src = read('app/(app)/admin/tier-features/tier-features-client.tsx');
    expect(src).toContain("tier: 'free', icon: Gift, on: 'bg-emerald-700 text-white'");
  });

  it('keeps small muted text at full muted strength where axe measured it', () => {
    const editor = read('components/admin/service-descriptions-editor.tsx');
    expect(editor).not.toMatch(/text-muted\/(60|70)/);
    const scan = read('components/modules/scan-module.tsx');
    expect(scan).toContain("<p className=\"mt-1 text-xs text-muted\">{t('scan.jpgPngWebpOrPdfUp')}</p>");
  });

  it("lifts the family display's faint captions over 4.5:1", () => {
    const clock = read('components/display/ambient-clock.tsx');
    expect(clock).not.toContain('text-sm font-medium text-white/60');
    const grid = read('components/display/display-grid.tsx');
    expect(grid).not.toContain('py-4 text-center text-white/40');
    expect(grid).not.toContain('text-center text-xs text-white/40');
  });
});
