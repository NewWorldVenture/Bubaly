// Find the boundary for GitHub Actions cron catch-up.
//
// Normally the previous successful scheduled run is the boundary. If no
// scheduled run has ever succeeded, follow the Actions API's Link pagination
// through the complete 24-hour history. If older history exists, it is already
// beyond the catch-up cap, so use the 24-hour floor rather than paging through
// years of equivalent runs. The dispatcher calls each due idempotent sweep
// once; it does not replay one request per historical workflow run.

import { CATCH_UP_MAX_MINUTES } from './cron-dispatch.mjs';

const WORKFLOW_FILE = 'cron-dispatch.yml';
const PAGE_SIZE = 100;

function validTimestamp(value, nowMs) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds > nowMs) return null;
  return new Date(milliseconds).toISOString();
}

function timestampForRun(run, nowMs) {
  // `created_at` predates `run_started_at`, so it is a conservative boundary
  // if Actions has not recorded a start yet. Over-catching is safe; skipping
  // an unknown interval is not.
  return validTimestamp(run.run_started_at, nowMs) ?? validTimestamp(run.created_at, nowMs);
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const [, href, attributes] of linkHeader.matchAll(/<([^>]+)>\s*;\s*([^,]+)/g)) {
    const relation = /(?:^|;)\s*rel\s*=\s*"?([^";]+)"?/i.exec(attributes)?.[1];
    if (relation?.split(/\s+/).includes('next')) return href;
  }
  return null;
}

function workflowRunsFrom(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.workflow_runs) || !Number.isInteger(body.total_count) || body.total_count < 0) {
    throw new Error('Actions API returned an unexpected workflow-run list.');
  }
  return body.workflow_runs;
}

function workflowRunsUrl({ repo, status, created, apiBaseUrl, perPage = PAGE_SIZE }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('REPO must be an owner/repository slug.');
  }
  const url = new URL(`/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs`, apiBaseUrl);
  url.searchParams.set('event', 'schedule');
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('sort', 'created');
  url.searchParams.set('direction', 'desc');
  if (status) url.searchParams.set('status', status);
  if (created) url.searchParams.set('created', created);
  return url;
}

async function fetchPage(url, { token, fetchImpl, expectedPath, expectedStatus, expectedCreated, expectedPerPage }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Actions API returned HTTP ${response.status}.`);
  const body = await response.json();
  const runs = workflowRunsFrom(body);
  const next = nextLink(response.headers.get('link'));
  if (next) {
    const nextUrl = new URL(next, url);
    if (nextUrl.origin !== url.origin || nextUrl.pathname !== expectedPath || nextUrl.searchParams.get('event') !== 'schedule' || nextUrl.searchParams.get('per_page') !== String(expectedPerPage) || nextUrl.searchParams.get('status') !== expectedStatus || nextUrl.searchParams.get('created') !== expectedCreated) {
      throw new Error('Actions API returned an unexpected workflow-run pagination link.');
    }
    return { runs, next: nextUrl, totalCount: body.total_count };
  }
  return { runs, next: null, totalCount: body.total_count };
}

async function scanRuns(firstUrl, { token, fetchImpl, status }) {
  const expectedPath = firstUrl.pathname;
  const expectedCreated = firstUrl.searchParams.get('created');
  const expectedPerPage = firstUrl.searchParams.get('per_page');
  const pages = new Set();
  const runs = [];
  let url = firstUrl;
  let totalCount = 0;
  while (url) {
    const key = url.toString();
    if (pages.has(key)) throw new Error('Actions API repeated a workflow-run pagination link.');
    pages.add(key);
    const page = await fetchPage(url, { token, fetchImpl, expectedPath, expectedStatus: status ?? null, expectedCreated, expectedPerPage });
    runs.push(...page.runs);
    totalCount = page.totalCount;
    if (!page.next && runs.length < totalCount) {
      throw new Error('Actions API pagination ended before the reported workflow-run history was complete.');
    }
    url = page.next;
  }
  return { runs, totalCount };
}

/**
 * Returns a safe catch-up boundary or a failed lookup result. The current run
 * is excluded explicitly even though an in-progress run is not a success.
 */
export async function discoverCatchUpBoundary({
  token,
  repo,
  currentRunId,
  fetchImpl = fetch,
  now = new Date(),
  apiBaseUrl = 'https://api.github.com',
}) {
  try {
    if (typeof token !== 'string' || !token.trim()) throw new Error('The workflow token is missing.');
    if (!repo || !currentRunId) throw new Error('The workflow repository or run ID is missing.');
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error('The clock did not provide a valid timestamp.');

    // Success is filtered server-side; the newest successful scheduled tick
    // is on page one. The fallback paginates the full bounded history because
    // it needs the oldest attempt inside the catch-up window.
    const successfulUrl = workflowRunsUrl({ repo, status: 'success', apiBaseUrl });
    const successfulPage = await fetchPage(successfulUrl, {
      token,
      fetchImpl,
      expectedPath: successfulUrl.pathname,
      expectedStatus: 'success',
      expectedCreated: null,
      expectedPerPage: String(PAGE_SIZE),
    });
    const previousSuccess = successfulPage.runs.find((run) => String(run.id) !== String(currentRunId));
    if (!previousSuccess && successfulPage.totalCount > successfulPage.runs.length) {
      throw new Error('Actions API omitted a previous successful scheduled run from its first page.');
    }
    if (previousSuccess) {
      const since = timestampForRun(previousSuccess, nowMs);
      if (!since) throw new Error('The previous successful scheduled run has no usable start time.');
      return { lookup: 'ok', since, source: 'success' };
    }

    const floorMs = nowMs - CATCH_UP_MAX_MINUTES * 60_000;
    const floor = new Date(floorMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // This bounded query contains at most 289 scheduled run records in 24 hours
    // at this workflow's five-minute cadence, including both inclusive edges
    // (manual runs are excluded by event).
    // That stays below the Actions endpoint's 1,000-result search ceiling.
    const recentUrl = workflowRunsUrl({ repo, status: null, created: `>=${floor}`, apiBaseUrl });
    const recent = await scanRuns(recentUrl, { token, fetchImpl, status: null });
    if (recent.totalCount >= 1_000) {
      throw new Error('Actions API reached its 1,000-result search limit for the 24-hour workflow history.');
    }
    const recentRuns = recent.runs.filter((run) => String(run.id) !== String(currentRunId));
    if (recentRuns.length > 0) {
      let oldestRecentMs = Number.POSITIVE_INFINITY;
      for (const run of recentRuns) {
        const timestamp = timestampForRun(run, nowMs);
        if (!timestamp) throw new Error('A previous scheduled run has no usable start or creation time.');
        oldestRecentMs = Math.min(oldestRecentMs, Date.parse(timestamp));
      }

      // An older-created run can be delayed in Actions before it starts. If
      // any scheduled history predates the cap, the exact safe boundary is the
      // 24-hour floor regardless of its later start time.
      const olderUrl = workflowRunsUrl({ repo, status: null, created: `<${floor}`, apiBaseUrl, perPage: 1 });
      const olderPage = await fetchPage(olderUrl, {
        token,
        fetchImpl,
        expectedPath: olderUrl.pathname,
        expectedStatus: null,
        expectedCreated: `<${floor}`,
        expectedPerPage: '1',
      });
      const olderRun = olderPage.runs.find((run) => String(run.id) !== String(currentRunId));
      if (!olderRun && olderPage.totalCount > olderPage.runs.length) {
        throw new Error('Actions API omitted older scheduled history from its first result.');
      }
      if (olderRun) return { lookup: 'ok', since: floor, source: 'history-capped' };
      return { lookup: 'ok', since: new Date(oldestRecentMs).toISOString(), source: 'history' };
    }

    // The 24-hour filter is empty. A small newest-first probe distinguishes a
    // first-ever tick from old history beyond the cap; the latter uses the
    // floor because every older boundary clamps to the same safe window.
    const latestUrl = workflowRunsUrl({ repo, status: null, created: null, apiBaseUrl });
    const latestPage = await fetchPage(latestUrl, {
      token,
      fetchImpl,
      expectedPath: latestUrl.pathname,
      expectedStatus: null,
      expectedCreated: null,
      expectedPerPage: String(PAGE_SIZE),
    });
    const olderRun = latestPage.runs.find((run) => String(run.id) !== String(currentRunId));
    if (!olderRun && latestPage.totalCount > latestPage.runs.length) {
      throw new Error('Actions API omitted prior scheduled history from its newest results.');
    }
    if (olderRun) return { lookup: 'ok', since: floor, source: 'history-capped' };
    return { lookup: 'ok', since: '', source: 'first-run' };
  } catch (error) {
    let safeMessage = String(error instanceof Error ? error.message : error);
    if (typeof token === 'string' && token) safeMessage = safeMessage.split(token).join('[redacted]');
    safeMessage = safeMessage.replace(/[\r\n]+/g, ' ').slice(0, 200);
    return { lookup: 'failed', since: '', source: 'failure', reason: safeMessage || 'Unknown Actions API failure.' };
  }
}

async function main() {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error('GITHUB_OUTPUT is required for this workflow step.');
    process.exitCode = 1;
    return;
  }
  const result = await discoverCatchUpBoundary({
    token: process.env.GH_TOKEN,
    repo: process.env.REPO,
    currentRunId: process.env.RUN_ID,
    apiBaseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(outputFile, `since=${result.since}\nlookup=${result.lookup}\n`, 'utf8');
  if (result.lookup === 'failed') {
    console.error(`The previous-tick lookup failed (${result.reason}); dispatching the fixed five-minute window, and this tick will not be a boundary.`);
  } else if (result.source === 'first-run') {
    console.log('No previous scheduled tick is recorded; this one starts the chain with the fixed five-minute window.');
  } else if (result.source === 'history') {
    console.log(`No scheduled tick has succeeded yet; the oldest recorded one started at ${result.since}; catching up from there.`);
  } else if (result.source === 'history-capped') {
    console.log(`Scheduled history predates the catch-up limit; catching up from the 24-hour floor ${result.since}.`);
  } else {
    console.log(`Previous successful tick started at ${result.since}; catching up from there.`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('cron-run-history.mjs')) {
  await main();
}
