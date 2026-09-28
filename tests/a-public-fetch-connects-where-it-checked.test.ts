// INTEGRATION-12CA17B49AF2 / -203F25967E6F (127.0.0.1, 192.168.x.x), the
// "Recorded, not fixed: DNS rebinding" note: fetchPublicText validated a
// hostname by resolving it, then fetch() resolved it again, so a zero-TTL DNS
// answer could pass the check with a public address and connect to an internal
// one. The fetch now connects to the address its own check accepted.
//
// Real sockets against a loopback server; DNS is a stub, so the resolver's
// answers (including a rebinding second answer) are exact.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPublicCalendarText, pinnedPublicFetch, type PublicUrlLookup } from '@/lib/server/public-calendar-fetch';

let server: Server | null = null;
let seen: IncomingHttpHeaders[] = [];
async function listen(body: string): Promise<number> {
  seen = [];
  server = createServer((req, res) => { seen.push(req.headers); res.setHeader('content-type', 'text/calendar'); res.end(body); });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}
afterEach(async () => { await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())); server = null; });

const ICS = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';

describe('a public fetch connects where it checked', () => {
  it('refuses a rebinding answer at connection time, after a public answer passed validation', async () => {
    const port = await listen(ICS);
    const answers = [[{ address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }]];
    const calls: string[] = [];
    const rebinding: PublicUrlLookup = async (host) => { calls.push(host); return answers[Math.min(calls.length - 1, 1)]; };
    const result = await fetchPublicCalendarText(`http://rebind.example.test:${port}/feed.ics`, undefined, rebinding);
    expect(result.ok).toBe(false);
    // Resolved twice: once to validate, once for the socket, and the second
    // (internal) answer was refused rather than connected to.
    expect(calls).toEqual(['rebind.example.test', 'rebind.example.test']);
    expect(seen).toEqual([]);
  });

  it('connects to the pinned address while keeping the hostname for Host', async () => {
    const port = await listen(ICS);
    const toLoopback: PublicUrlLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    // The test's address policy admits loopback; production's never does.
    const fetchPinned = pinnedPublicFetch(toLoopback, () => false);
    const response = await fetchPinned(`http://feed.example.test:${port}/feed.ics`, { headers: { Accept: 'text/calendar' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(ICS);
    expect(seen[0]?.host).toBe(`feed.example.test:${port}`);
    expect(seen[0]?.['accept-encoding']).toBe('identity');
  });

  it('refuses a private address with the production policy even when asked directly', async () => {
    const port = await listen(ICS);
    const toLoopback: PublicUrlLookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(pinnedPublicFetch(toLoopback)(`http://feed.example.test:${port}/`, {})).rejects.toThrow(/not public/);
    await expect(pinnedPublicFetch(toLoopback)(`http://192.168.1.10:${port}/`, {})).rejects.toThrow(/not public/);
    expect(seen).toEqual([]);
  });
});
