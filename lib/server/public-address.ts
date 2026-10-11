import 'server-only';
import { BlockList, isIP } from 'node:net';

// The one address policy for every server-side fetch of a URL a user supplied:
// documents, feeds, calendars, link previews, push endpoints, media. Two copies
// of an SSRF guard is two guards that drift, and the one that drifts is always
// the copy — the calendar fetch's own list once let 6to4, Teredo, SIIT and the
// Azure platform endpoint through while this one refused them.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
blocked.addAddress('168.63.129.16', 'ipv4'); // Azure platform endpoint despite its public-looking address.
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

/** True only for an address a server-side fetch may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only ordinary global unicast; this excludes mapped IPv4, NAT64, local and multicast forms.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
