import { expect, test } from '@playwright/test';

// Review 5372934636 on #709: an unavailable search index must read as
// unavailable, not as "no articles found", and a later interaction must be
// able to load it. The real /blog page and typeahead; only the index request
// is answered by the test (first a 503, then a one-article index).
const RETRY_AFTER_MS = 5_000;
const ARTICLE = { slug: 'probe-bedtime-routines', title: 'Probe: bedtime routines that stick', excerpt: 'A synthetic index entry.', category: 'Parenting' };

test('the blog typeahead says the index is unavailable, then recovers on a later interaction', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/blog/search-index', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' }, body: JSON.stringify({ error: 'unavailable' }) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ARTICLE]) });
    }
  });

  await page.goto('/blog', { waitUntil: 'domcontentloaded' });
  const box = page.getByPlaceholder('Search articles...');
  await box.fill('bedtime');

  const status = page.getByRole('status').filter({ hasText: 'Search isn’t available right now' });
  await expect(status).toBeVisible();
  await expect(page.getByText('No articles found for')).toHaveCount(0);

  // Typing through the outage does not send a request per keystroke.
  await box.press('End');
  await box.type('s');
  await box.press('Backspace');
  expect(requests).toBe(1);

  // A later keystroke retries. A trailing space keeps the query ("bedtime"
  // after trimming) matching the probe title.
  await page.waitForTimeout(RETRY_AFTER_MS + 200);
  await box.type(' ');
  await expect(page.getByRole('link', { name: /Probe: bedtime routines that stick/ })).toBeVisible();
  expect(requests).toBe(2);
});
