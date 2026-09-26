import { createElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybookModule } from '@/components/modules/playbook-module';
// Rendered under a LocaleProvider, because the component asks for one.
//
// `translate` no longer falls back to the en-US catalogue — that fallback was a
// static import, and it is why en-US shipped to the browser on 406 of 606 pages
// (PERF-001). It now lives in getMessages, which is where a catalogue belongs.
// These cases were rendering a client component with NO provider and asserting
// its English copy, which passed only on that fallback and mounted the
// component in a way the product never does. Shadowing the import fixes every
// call site at once and changes no assertion.
import { withLocale } from './helpers/render-translated';
const renderToStaticMarkup = (node: Parameters<typeof withLocale>[0]) => renderRaw(withLocale(node));

const { rows } = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family-1', members: [] }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: () => ({ data: rows, loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/app/(app)/dashboard/playbook/playbook-actions', () => ({
  refreshPlaybookAction: vi.fn(), acceptSuggestionAction: vi.fn(), dismissSuggestionAction: vi.fn(),
}));

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-06T03:30:00.000Z'));
  rows.length = 0;
});
afterEach(() => vi.restoreAllMocks());

function render(expires_at: string | null) {
  rows.push({
    id: 'suggestion-1', family_id: 'family-1', member_id: null, category: 'sizes',
    label: 'Shoe size', value: 'US 3', evidence: 'Mentioned at the fitting.',
    confidence: 72, status: 'suggested', expires_at,
  });
  return renderToStaticMarkup(createElement(PlaybookModule));
}

describe('pending memory expiry on the actual review screen', () => {
  it('shows the complete deadline and timezone beside the enabled Save action', () => {
    const html = render('2026-09-07T16:00:00.000Z');
    expect(html).toContain('Stops being true:');
    expect(html).toContain('dateTime="2026-09-07T16:00:00.000Z"');
    expect(html).toContain('Sep 7, 2026');
    expect(html).toContain('4:00:00 PM UTC');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it('marks expired cards and disables acceptance while retaining dismissal', () => {
    const html = render('2026-09-06T03:30:00.000Z');
    expect(html).toContain('Expired:');
    expect(html.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Dismiss"/);
  });

  it('retains the existing review experience for a card with no deadline', () => {
    const html = render(null);
    expect(html).not.toContain('Stops being true:');
    expect(html).not.toContain('Expired:');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it('disables acceptance for a malformed deadline rather than presenting it as permanent', () => {
    const html = render('not a date');
    expect(html).toContain('Invalid expiry.');
    expect(html.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(1);
  });
});
