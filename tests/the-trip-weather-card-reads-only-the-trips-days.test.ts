// The trip overview's weather card chose its empty state from EVERY cached
// snapshot and its advice from the snapshots inside the trip. A trip whose only
// cached days were a week it is not away on — a forecast cached while it was
// beyond the horizon, or before its dates moved — therefore said "Looks
// pleasant — no alerts." about weather it had none of, even when that other
// week carried a heat warning. The Weather tab already filtered first and said
// "No forecast yet"; the card now reads the same in-trip days for both.
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { getMessages } from '@/lib/i18n/messages';
import { TripWeatherGlance } from '@/components/vacations/trip-overview';
import { renderTranslated } from './helpers/render-translated';

const EN = getMessages('en-US') as Record<string, string>;
const day = (forecast_date: string, over: Partial<{ temp_high_c: number; temp_low_c: number; precip_prob: number; weather_code: number }> = {}) => ({
  forecast_date, temp_high_c: 22, temp_low_c: 14, precip_prob: 5, weather_code: 1, ...over,
});
const render = (weather: ReturnType<typeof day>[], startDate: string | null, endDate: string | null) =>
  renderTranslated(createElement(TripWeatherGlance, { weather, startDate, endDate }));

describe('the overview weather card', () => {
  it('a trip whose only snapshots are another week says there is no forecast yet — not "Looks pleasant"', () => {
    const html = render([day('2026-10-01', { temp_high_c: 39, temp_low_c: 27 }), day('2026-10-02', { temp_high_c: 40 })], '2026-11-01', '2026-11-05');
    expect(html).toContain(EN['tripOverview.noForecastYetFetchOneOn']);
    expect(html).not.toContain(EN['tripOverview.looksPleasantNoAlerts']);
  });

  it('mild days inside the trip are "Looks pleasant"', () => {
    const html = render([day('2026-11-02'), day('2026-10-01', { temp_high_c: 40 })], '2026-11-01', '2026-11-05');
    expect(html).toContain(EN['tripOverview.looksPleasantNoAlerts']);
    expect(html).not.toContain(EN['tripOverview.noForecastYetFetchOneOn']);
  });

  it('advice comes only from the days inside the trip', () => {
    const html = render([day('2026-11-02', { precip_prob: 90, weather_code: 63 }), day('2026-10-01', { temp_high_c: 40 })], '2026-11-01', '2026-11-05');
    expect(html).toContain('Rain likely');
    expect(html).not.toContain(EN['tripOverview.looksPleasantNoAlerts']);
    expect(html.toLowerCase()).not.toContain('heat');
  });

  it('an undated trip keeps every snapshot, as the Weather tab does', () => {
    expect(render([day('2026-10-01')], null, null)).toContain(EN['tripOverview.looksPleasantNoAlerts']);
    expect(render([], null, null)).toContain(EN['tripOverview.noForecastYetFetchOneOn']);
  });
});
