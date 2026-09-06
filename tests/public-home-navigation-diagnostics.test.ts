import { EventEmitter } from 'node:events';
import type { Page, Response } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigatePublicHome } from './e2e/helpers/public-home-navigation';

const EVENTS = ['request', 'requestfinished', 'requestfailed', 'response', 'domcontentloaded', 'load'];
const SECRET = 'DO_NOT_LOG_CUSTOMER_DATA';
const PRIVATE_URL = `https://private.invalid/account?token=${SECRET}`;
type Listener = (...args: unknown[]) => void;
type Diagnostic = {
  kind: string;
  navigationElapsedMs: number | null;
  mainDocumentResponse: { atMs: number | null; status: number | null } | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  outstandingByType: Record<string, number>;
  failedByType: Record<string, number>;
  trackingLimit: number;
  untrackedRequests: number;
};

function createPage() {
  const emitter = new EventEmitter();
  const frame = {};
  const stub = {
    goto: vi.fn(async (): Promise<Response | null> => null),
    mainFrame: vi.fn(() => frame),
    on: vi.fn((event: string, listener: Listener) => emitter.on(event, listener)),
    off: vi.fn((event: string, listener: Listener) => emitter.off(event, listener)),
    evaluate: vi.fn(() => { throw new Error('Page evaluation is forbidden'); }),
  };
  return { emitter, frame, stub, page: stub as unknown as Page };
}

function createRequest(type: string, frame: object = {}, navigation = false) {
  return {
    resourceType: vi.fn(() => type),
    isNavigationRequest: vi.fn(() => navigation),
    frame: vi.fn(() => frame),
    url: vi.fn(() => PRIVATE_URL),
    headers: vi.fn(() => ({ authorization: SECRET, cookie: SECRET })),
    postData: vi.fn(() => SECRET),
  };
}

function expectClean(harness: ReturnType<typeof createPage>): void {
  for (const event of EVENTS) expect(harness.emitter.listenerCount(event)).toBe(0);
  expect(harness.stub.off).toHaveBeenCalledTimes(EVENTS.length);
  expect(harness.stub.evaluate).not.toHaveBeenCalled();
}

function readDiagnostic(): { line: string; data: Diagnostic } {
  expect(console.error).toHaveBeenCalledTimes(1);
  const call = vi.mocked(console.error).mock.calls[0];
  expect(call).toHaveLength(1);
  expect(typeof call?.[0]).toBe('string');
  const line = String(call?.[0]);
  expect(line).not.toContain('\n');
  expect(line.length).toBeLessThan(2048);
  return { line, data: JSON.parse(line) as Diagnostic };
}

describe('public home navigation diagnostics', () => {
  let now = 1000;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([null, { marker: 'same response' } as unknown as Response])(
    'preserves a successful navigation result without logging (%#)',
    async (result) => {
      const harness = createPage();
      harness.stub.goto.mockImplementation(async () => {
        for (const event of EVENTS) expect(harness.emitter.listenerCount(event)).toBe(1);
        return result;
      });

      await expect(navigatePublicHome(harness.page)).resolves.toBe(result);

      expect(harness.stub.goto).toHaveBeenCalledExactlyOnceWith('/');
      expect(console.error).not.toHaveBeenCalled();
      expectClean(harness);
    },
  );

  it.each([false, true])('captures DOMContentLoaded separately from load (%s)', async (emitLoad) => {
    const harness = createPage();
    const failure = new Error(SECRET);
    const documentRequest = createRequest('document', harness.frame, true);
    const script = createRequest('script');
    const image = createRequest('image');
    const unknown = createRequest(PRIVATE_URL);
    const response = {
      request: () => documentRequest,
      status: () => 200,
      url: vi.fn(() => PRIVATE_URL),
      headers: vi.fn(() => ({ authorization: SECRET })),
    };
    harness.stub.goto.mockImplementation(async () => {
      harness.emitter.emit('request', documentRequest);
      harness.emitter.emit('request', script);
      harness.emitter.emit('request', image);
      harness.emitter.emit('request', unknown);
      now = 1010;
      harness.emitter.emit('response', response);
      harness.emitter.emit('requestfinished', documentRequest);
      harness.emitter.emit('response', {
        request: () => createRequest('document', {}, true),
        status: () => 503,
      });
      now = 1020;
      harness.emitter.emit('domcontentloaded');
      now = 1025;
      harness.emitter.emit('domcontentloaded');
      if (emitLoad) {
        now = 1040;
        harness.emitter.emit('load');
        now = 1045;
        harness.emitter.emit('load');
      }
      harness.emitter.emit('requestfailed', image);
      now = 1120;
      throw failure;
    });

    await expect(navigatePublicHome(harness.page)).rejects.toBe(failure);

    expect(harness.stub.goto).toHaveBeenCalledExactlyOnceWith('/');
    const { line, data } = readDiagnostic();
    expect(data.kind).toBe('public-home-navigation-failure');
    expect(data.navigationElapsedMs).toBe(120);
    expect(data.mainDocumentResponse).toEqual({ atMs: 10, status: 200 });
    expect(data.domContentLoadedMs).toBe(20);
    expect(data.loadMs).toBe(emitLoad ? 40 : null);
    expect(data.outstandingByType).toMatchObject({ document: 0, script: 1, image: 0, other: 1 });
    expect(data.failedByType.image).toBe(1);
    expect(data.untrackedRequests).toBe(0);
    expect(Object.keys(data).sort()).toEqual([
      'domContentLoadedMs', 'failedByType', 'kind', 'loadMs', 'mainDocumentResponse',
      'navigationElapsedMs', 'outstandingByType', 'trackingLimit', 'untrackedRequests',
    ].sort());
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(PRIVATE_URL);
    expect(line).not.toMatch(/https?:|authorization|cookie|postData|stack|message/);
    for (const request of [documentRequest, script, image, unknown]) {
      expect(request.url).not.toHaveBeenCalled();
      expect(request.headers).not.toHaveBeenCalled();
      expect(request.postData).not.toHaveBeenCalled();
    }
    expect(response.url).not.toHaveBeenCalled();
    expect(response.headers).not.toHaveBeenCalled();
    expectClean(harness);
  });

  it('bounds outstanding tracking and records overflow without retaining arbitrary labels', async () => {
    const harness = createPage();
    const failure = new Error('timeout');
    harness.stub.goto.mockImplementation(async () => {
      for (let index = 0; index < 300; index += 1) {
        harness.emitter.emit('request', createRequest('script'));
      }
      throw failure;
    });

    await expect(navigatePublicHome(harness.page)).rejects.toBe(failure);

    const { data } = readDiagnostic();
    expect(data.trackingLimit).toBe(256);
    expect(data.outstandingByType.script).toBe(256);
    expect(data.untrackedRequests).toBe(44);
    expect(data.mainDocumentResponse).toBeNull();
    expect(data.domContentLoadedMs).toBeNull();
    expect(data.loadMs).toBeNull();
    expectClean(harness);
  });

  it.each(['collection', 'logging', 'registration', 'cleanup', 'clock'])(
    'preserves the original navigation failure when diagnostics fail during %s',
    async (fault) => {
      const harness = createPage();
      const failure = new Error('original navigation failure');
      if (fault === 'logging') {
        vi.mocked(console.error).mockImplementation(() => { throw new Error('logger unavailable'); });
      }
      if (fault === 'registration') {
        harness.stub.on.mockImplementation((event, listener) => {
          harness.emitter.on(event, listener);
          if (event === 'load') throw new Error('registration failed');
          return harness.emitter;
        });
      }
      if (fault === 'cleanup') {
        harness.stub.off.mockImplementation((event, listener) => {
          harness.emitter.off(event, listener);
          if (event === 'response') throw new Error('cleanup failed');
          return harness.emitter;
        });
      }
      if (fault === 'clock') {
        vi.mocked(performance.now).mockImplementation(() => { throw new Error('clock unavailable'); });
      }
      harness.stub.goto.mockImplementation(async () => {
        if (fault === 'collection') {
          harness.emitter.emit('request', {
            resourceType: () => { throw new Error('request unavailable'); },
          });
        }
        throw failure;
      });

      await expect(navigatePublicHome(harness.page)).rejects.toBe(failure);

      expect(harness.stub.goto).toHaveBeenCalledExactlyOnceWith('/');
      expect(console.error).toHaveBeenCalledTimes(1);
      expectClean(harness);
    },
  );

  it('removes only its own listeners and leaves existing page observers intact', async () => {
    const harness = createPage();
    const existingListener = vi.fn();
    harness.emitter.on('load', existingListener);

    await navigatePublicHome(harness.page);
    harness.emitter.emit('load');

    expect(existingListener).toHaveBeenCalledTimes(1);
    expect(harness.emitter.listeners('load')).toEqual([existingListener]);
    for (const event of EVENTS.filter((name) => name !== 'load')) {
      expect(harness.emitter.listenerCount(event)).toBe(0);
    }
    expect(console.error).not.toHaveBeenCalled();
    expect(harness.stub.evaluate).not.toHaveBeenCalled();
  });
});
