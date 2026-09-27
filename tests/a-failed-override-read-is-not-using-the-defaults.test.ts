// SRV-001 l5 — a service-description read that FAILED is not "all using
// defaults".
//
// /admin/services edits the tooltip every member sees for each service. It
// loaded the overrides with a best-effort helper that returned `{}` for a
// failed read as well as for "nothing overridden", so a failed read drew every
// blurb as the shipped default under "All using defaults", with no CUSTOM
// badge and no Reset button — and a Save from that screen overwrote a
// family-wide custom blurb the editor never saw.
//
// Now the admin page reads strictly and, when the read fails, shows a sentence
// instead of the editor; the tooltip route keeps its best-effort `{}` (a
// missing override there only means "use the default"), and logs the failure.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const h = vi.hoisted(() => ({
  reply: { data: [] as unknown, error: null as unknown } as { data: unknown; error: unknown },
  throws: false,
}));

function client() {
  return {
    from: () => ({
      select: () => ({
        limit: async () => {
          if (h.throws) throw new Error('fetch failed');
          return h.reply;
        },
      }),
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => client() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
// The editor is a client component with its own suite; here it only has to
// show what it was handed.
vi.mock('@/components/admin/service-descriptions-editor', () => ({
  ServiceDescriptionsEditor: ({ overrides }: { overrides: Record<string, string> }) =>
    createElement('div', { 'data-editor': JSON.stringify(overrides) }),
}));

const { readServiceDescriptionOverrides, loadServiceDescriptionOverrides } = await import('@/lib/services/descriptions-server');
const { default: AdminServicesPage } = await import('@/app/(app)/admin/services/page');

const FAILED = { message: 'canceling statement due to statement timeout', code: '57014' };
const ROWS = [
  { service_key: '/dashboard/meals', description: '  Plan dinners together.  ' },
  { service_key: '/dashboard/chores', description: '   ' },
];

beforeEach(() => {
  h.reply = { data: ROWS, error: null };
  h.throws = false;
  vi.restoreAllMocks();
});

describe('readServiceDescriptionOverrides says whether the read worked', () => {
  it('answers the overrides, trimmed, without blank ones', async () => {
    expect(await readServiceDescriptionOverrides(client() as never)).toEqual({ ok: true, overrides: { '/dashboard/meals': 'Plan dinners together.' } });
  });

  it('answers an empty table as an empty map that DID read', async () => {
    h.reply = { data: [], error: null };
    expect(await readServiceDescriptionOverrides(client() as never)).toEqual({ ok: true, overrides: {} });
  });

  it('answers a refused read as a failure, never as {}', async () => {
    h.reply = { data: null, error: FAILED };
    expect(await readServiceDescriptionOverrides(client() as never)).toEqual({ ok: false, error: FAILED });
  });

  it('answers a thrown read as a failure', async () => {
    h.throws = true;
    expect((await readServiceDescriptionOverrides(client() as never)).ok).toBe(false);
  });
});

describe('the tooltips stay best-effort, and say so in the log', () => {
  it('falls back to the shipped defaults on a failed read, and logs it', async () => {
    h.reply = { data: null, error: FAILED };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadServiceDescriptionOverrides(client() as never)).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[service-descriptions] overrides read failed'), FAILED);
  });
});

describe('the admin editor is never drawn over a read that failed', () => {
  it('shows the sentence and no editor when the read fails', async () => {
    h.reply = { data: null, error: FAILED };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderTranslated(await AdminServicesPage());
    expect(EN_US['adminServices.couldNotLoadTheOverrides']).toEqual(expect.any(String));
    expect(html).toContain(EN_US['adminServices.couldNotLoadTheOverrides']);
    expect(html).not.toContain('data-editor');
  });

  it('draws the editor with what was read when the read works', async () => {
    const html = renderTranslated(await AdminServicesPage());
    expect(html).toContain('data-editor');
    expect(html).toContain('Plan dinners together.');
    expect(html).not.toContain(EN_US['adminServices.couldNotLoadTheOverrides']);
  });
});
