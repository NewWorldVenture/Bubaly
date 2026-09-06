import type { Page, Request, Response } from '@playwright/test';

const RESOURCE_TYPES = [
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
  'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other',
] as const;
type ResourceType = typeof RESOURCE_TYPES[number];
const TRACKING_LIMIT = 256;

function emptyCounts(): Record<ResourceType, number> {
  return {
    document: 0, stylesheet: 0, image: 0, media: 0, font: 0, script: 0,
    texttrack: 0, xhr: 0, fetch: 0, eventsource: 0, websocket: 0,
    manifest: 0, other: 0,
  };
}

function ignoreDiagnosticError(action: () => void): void {
  try {
    action();
  } catch {
    // Diagnostics must never alter the navigation result or thrown error.
  }
}

function clockTime(): number | null {
  try {
    const value = performance.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Observe the existing default navigation without changing its readiness policy. */
export async function navigatePublicHome(page: Page): Promise<Response | null> {
  const startedAt = clockTime();
  const elapsedMs = (): number | null => {
    const now = clockTime();
    if (startedAt === null || now === null) return null;
    const elapsed = now - startedAt;
    return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null;
  };

  let mainDocumentResponse: { atMs: number | null; status: number | null } | null = null;
  let domContentLoadedMs: number | null = null;
  let loadMs: number | null = null;
  const outstandingByType = emptyCounts();
  const failedByType = emptyCounts();
  // Weak keys do not keep requests alive; the cap also bounds live tracking.
  const trackedRequests = new WeakMap<Request, ResourceType>();
  let trackedOutstanding = 0;
  let untrackedRequests = 0;

  const resourceType = (request: Request): ResourceType => {
    const candidate = request.resourceType();
    return RESOURCE_TYPES.find((type) => type === candidate) ?? 'other';
  };
  const finishRequest = (request: Request): void => {
    const type = trackedRequests.get(request);
    if (type === undefined) return;
    trackedRequests.delete(request);
    outstandingByType[type] -= 1;
    trackedOutstanding -= 1;
  };
  const onRequest = (request: Request): void => {
    ignoreDiagnosticError(() => {
      if (trackedRequests.has(request)) return;
      if (trackedOutstanding >= TRACKING_LIMIT) {
        untrackedRequests = Math.min(untrackedRequests + 1, Number.MAX_SAFE_INTEGER);
        return;
      }
      const type = resourceType(request);
      trackedRequests.set(request, type);
      outstandingByType[type] += 1;
      trackedOutstanding += 1;
    });
  };
  const onRequestFinished = (request: Request): void => {
    ignoreDiagnosticError(() => finishRequest(request));
  };
  const onRequestFailed = (request: Request): void => {
    ignoreDiagnosticError(() => {
      const type = trackedRequests.get(request) ?? resourceType(request);
      failedByType[type] = Math.min(failedByType[type] + 1, Number.MAX_SAFE_INTEGER);
      finishRequest(request);
    });
  };
  const onResponse = (response: Response): void => {
    ignoreDiagnosticError(() => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      const status = response.status();
      mainDocumentResponse = {
        atMs: elapsedMs(),
        status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      };
    });
  };
  const onDomContentLoaded = (): void => {
    ignoreDiagnosticError(() => {
      if (domContentLoadedMs === null) domContentLoadedMs = elapsedMs();
    });
  };
  const onLoad = (): void => {
    ignoreDiagnosticError(() => {
      if (loadMs === null) loadMs = elapsedMs();
    });
  };
  const removeListeners = [
    () => page.off('request', onRequest),
    () => page.off('requestfinished', onRequestFinished),
    () => page.off('requestfailed', onRequestFailed),
    () => page.off('response', onResponse),
    () => page.off('domcontentloaded', onDomContentLoaded),
    () => page.off('load', onLoad),
  ];

  try {
    ignoreDiagnosticError(() => page.on('request', onRequest));
    ignoreDiagnosticError(() => page.on('requestfinished', onRequestFinished));
    ignoreDiagnosticError(() => page.on('requestfailed', onRequestFailed));
    ignoreDiagnosticError(() => page.on('response', onResponse));
    ignoreDiagnosticError(() => page.on('domcontentloaded', onDomContentLoaded));
    ignoreDiagnosticError(() => page.on('load', onLoad));

    try {
      return await page.goto('/');
    } catch (error) {
      ignoreDiagnosticError(() => {
        console.error(JSON.stringify({
          kind: 'public-home-navigation-failure',
          navigationElapsedMs: elapsedMs(),
          mainDocumentResponse,
          domContentLoadedMs,
          loadMs,
          outstandingByType,
          failedByType,
          trackingLimit: TRACKING_LIMIT,
          untrackedRequests,
        }));
      });
      throw error;
    }
  } finally {
    for (const removeListener of removeListeners) ignoreDiagnosticError(removeListener);
  }
}
