import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutomaticCaptureCard } from '@/components/metrics/automatic-capture-card';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import type { AutomaticCaptureResult } from '@/lib/metric/automatic-capture-server';

const state = vi.hoisted(() => ({ locale: 'en-US' as LocaleCode }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: async () => ({ locale: localeOrDefault(state.locale), messages: getMessages(state.locale) }) }));
const known: AutomaticCaptureResult = { ok: true, data: { since: '2026-09-02T12:00:00Z', until: '2026-09-09T12:00:00Z', total: 4, automatic: 1, unknown: 3, minimumPercent: 25 } };
async function render(result: AutomaticCaptureResult) {
  return renderToStaticMarkup(await AutomaticCaptureCard({ result }));
}

describe('verified automatic capture card', () => {
  it.each(['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const)('shows the lower bound, unknowns and visible methodology in %s', async (locale) => {
    state.locale = locale;
    const html = await render(known);
    const messages = getMessages(locale);
    expect(html).toContain(messages['automaticCapture.title']);
    expect(html).toContain(translate(messages, 'automaticCapture.minimumShare', { percent: 25 }));
    expect(html).toContain(translate(messages, 'automaticCapture.unknown', { unknown: 3 }));
    expect(html).toContain(messages['automaticCapture.methodology']);
  });

  it('separates an outage, no data and a measured zero', async () => {
    state.locale = 'en-US';
    const unavailable = await render({ ok: false });
    expect(unavailable).toContain('Capture share is unavailable');
    expect(unavailable).not.toContain('At least 0%');
    expect(unavailable).toContain('href="/dashboard/intelligence"');
    expect(unavailable).toContain(getMessages('en-US')['timeSaved.tryAgain']);
    const noData: AutomaticCaptureResult = { ok: true, data: { ...known.data, total: 0, automatic: 0, unknown: 0, minimumPercent: null } };
    expect(await render(noData)).toContain('No supported records were created');
    expect(await render(noData)).not.toContain('At least 0%');
    expect(await render({ ok: true, data: { ...known.data, automatic: 0, unknown: 4, minimumPercent: 0 } })).toContain('At least 0%');
  });

  it('uses the chosen locale for the fractional minimum', async () => {
    state.locale = 'fr-FR';
    expect(await render({ ok: true, data: { ...known.data, total: 3, automatic: 1, unknown: 2, minimumPercent: 33.3 } })).toContain('33,3%');
  });
});
