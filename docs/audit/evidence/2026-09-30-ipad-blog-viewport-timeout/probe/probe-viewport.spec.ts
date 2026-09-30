import fs from 'node:fs';
import { test } from '@playwright/test';

// Timing probe for the iPad /blog setViewportSize timeout. It asserts nothing:
// it records where the time goes (navigation, renderer round trip, each
// resize, the next frame, long tasks) so the phases can be compared.
const ROUTES = (process.env.PROBE_ROUTES ?? '/blog').split(',');
const WIDTHS = [320, 390, 768, 1024];
const OUT = process.env.PROBE_OUT!;

for (const path of ROUTES) {
  test(`probe ${path}`, async ({ page }, info) => {
    const t0 = Date.now();
    const events: Array<Record<string, unknown>> = [];
    const mark = (name: string, extra: Record<string, unknown> = {}) => events.push({ t: Date.now() - t0, name, ...extra });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mark('framenavigated', { url: new URL(frame.url()).pathname }); });
    page.on('domcontentloaded', () => mark('dcl'));
    page.on('load', () => mark('load'));
    page.on('crash', () => mark('crash'));
    let inflight = 0;
    page.on('request', () => { inflight += 1; });
    page.on('requestfinished', () => { inflight -= 1; });
    page.on('requestfailed', request => { inflight -= 1; mark('requestfailed', { url: new URL(request.url()).pathname.slice(0, 80), error: request.failure()?.errorText }); });
    await page.addInitScript(() => {
      const w = window as unknown as { __long: number[][] };
      w.__long = [];
      try {
        new PerformanceObserver(list => { for (const e of list.getEntries()) w.__long.push([Math.round(e.startTime), Math.round(e.duration)]); })
          .observe({ type: 'longtask', buffered: true });
      } catch { /* not supported */ }
    });
    const g0 = Date.now();
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    mark('goto', { ms: Date.now() - g0, status: response?.status() });
    for (const width of WIDTHS) {
      const p0 = Date.now(); await page.evaluate(() => 0); const ping = Date.now() - p0;
      const s0 = Date.now(); await page.setViewportSize({ width, height: 844 }); const resize = Date.now() - s0;
      const r0 = Date.now(); await page.evaluate(() => new Promise(requestAnimationFrame)); const raf = Date.now() - r0;
      const state = await page.evaluate(() => ({ ready: document.readyState, nodes: document.getElementsByTagName('*').length,
        long: (window as unknown as { __long: number[][] }).__long.length, imgs: document.images.length,
        imgsPending: Array.from(document.images).filter(i => !i.complete).length }));
      mark('width', { width, ping, resize, raf, inflight, ...state });
    }
    const long = await page.evaluate(() => (window as unknown as { __long: number[][] }).__long);
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), bytes: n.transferSize };
    });
    fs.appendFileSync(OUT, JSON.stringify({ project: info.project.name, path, repeat: info.repeatEachIndex, retry: info.retry, total: Date.now() - t0, nav, long, events }) + '\n');
  });
}
