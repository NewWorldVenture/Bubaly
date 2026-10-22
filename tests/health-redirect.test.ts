import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAuth, probeDatabase, probeServiceRole } from '../lib/health/probe';

const ownedServers: Server[] = [];

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  ownedServers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an owned loopback TCP server');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(ownedServers.splice(0).map(async server => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    expect(server.listening).toBe(false);
    const connections = await new Promise<number>((resolve, reject) => {
      server.getConnections((error, count) => error ? reject(error) : resolve(count));
    });
    expect(connections).toBe(0);
  }));
});

// Record only comparisons, so a regression reports credential forwarding without
// printing even these synthetic keys in test diagnostics.
function observe(request: IncomingMessage, apiKey: string) {
  return {
    method: request.method,
    path: request.url,
    apiKeyMatched: request.headers.apikey === apiKey,
    authorizationPresent: request.headers.authorization !== undefined,
    authorizationMatched: request.headers.authorization === `Bearer ${apiKey}`,
  };
}

describe('health probes refuse redirects with native HTTP', () => {
  const probes = [
    ['database', probeDatabase, '/rest/v1/'],
    ['auth', probeAuth, '/auth/v1/health'],
    ['service-role', probeServiceRole, '/rest/v1/'],
  ] as const;
  const keys = [
    ['opaque', 'sb_secret_synthetic_health_redirect_key', false],
    ['legacy', 'eyJhbGciOiJIUzI1NiJ9.synthetic-health-redirect.signature', true],
  ] as const;

  for (const [label, runProbe, path] of probes) {
    for (const [keyKind, apiKey, hasBearer] of keys) {
      for (const redirect of [false, true]) {
        it(`${label} with ${keyKind} key ${redirect ? 'refuses cross-origin redirect without forwarding credentials' : 'accepts a directly healthy endpoint'}`, async () => {
          expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
          const received: ReturnType<typeof observe>[] = [];
          const forwarded: ReturnType<typeof observe>[] = [];
          const destination = await listen((request, response) => {
            forwarded.push(observe(request, apiKey));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{}');
          });
          const origin = await listen((request, response) => {
            received.push(observe(request, apiKey));
            if (redirect) {
              response.writeHead(302, { Location: `${destination}/captured` });
              response.end();
            } else {
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end('{}');
            }
          });
          expect(new URL(origin).origin).not.toBe(new URL(destination).origin);
          const result = await runProbe(origin, apiKey, 2000);
          expect(received).toEqual([{
            method: 'GET',
            path,
            apiKeyMatched: true,
            authorizationPresent: hasBearer,
            authorizationMatched: hasBearer,
          }]);
          expect(result.latencyMs).toBeTypeOf('number');
          expect(result.latencyMs).toBeGreaterThanOrEqual(0);
          expect(JSON.stringify(result).includes(apiKey)).toBe(false);
          expect.soft(result.ok).toBe(!redirect);
          expect.soft(forwarded).toEqual([]);
        });
      }
    }
  }
});
