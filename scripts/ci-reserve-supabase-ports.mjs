// CI-only prevention, not a startup retry or evidence of who owned an old port.
// CLI 2.109.1 defaults: shadow/API/DB/Studio/Mailpit/SMTP/POP3/analytics/pooler.
// Keep the complete default block, edge inspector and disposable app port out
// of Linux ephemeral allocation. Explicit foreign binds remain possible and
// must fail startup; this guard never kills a process or retries that failure.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PORTS = Object.freeze([3107, 8083, ...Array.from({ length: 10 }, (_, i) => 54320 + i)]);
const RESERVED = '/proc/sys/net/ipv4/ip_local_reserved_ports';
const SOCKETS = ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6'];
function requireThat(ok, code) { if (!ok) throw new Error(code); }

export function parseRanges(value) {
  requireThat(typeof value === 'string', 'INVALID_RESERVATIONS');
  const result = new Set();
  if (!value.trim()) return result;
  for (const item of value.trim().split(',')) {
    requireThat(/^\d+(?:-\d+)?$/.test(item), 'INVALID_RESERVATIONS');
    const [start, end = start] = item.split('-').map(Number);
    requireThat(start >= 1 && end <= 65535 && start <= end, 'INVALID_RESERVATIONS');
    for (let port = start; port <= end; port++) result.add(port);
  }
  return result;
}

export function formatRanges(ports) {
  const sorted = [...ports].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i];
    let last = first;
    while (sorted[i + 1] === last + 1) last = sorted[++i];
    ranges.push(first === last ? String(first) : `${first}-${last}`);
  }
  return ranges.join(',');
}

export function assertNoOwnedPortSockets(source) {
  const lines = source.trim().split(/\r?\n/);
  requireThat(lines.length > 0 && /\blocal_address\b/.test(lines.shift()), 'INVALID_SOCKET_TABLE');
  for (const line of lines) {
    const local = line.trim().split(/\s+/)[1];
    requireThat(/^[0-9A-Fa-f]{8}(?:[0-9A-Fa-f]{24})?:[0-9A-Fa-f]{4}$/.test(local ?? ''), 'INVALID_SOCKET_TABLE');
    requireThat(!PORTS.includes(Number.parseInt(local.split(':')[1], 16)), 'PORT_ALREADY_IN_USE');
  }
}

export function assertCI(env, platform, uid) {
  requireThat(platform === 'linux' && Number.isInteger(uid) && uid > 0, 'REFUSE_NON_RUNNER_CONTROLLER');
  requireThat(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' &&
    env.GITHUB_REPOSITORY === 'NewWorldVenture/Bubaly' && env.GITHUB_JOB === 'e2e' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux' &&
    /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'REFUSE_NON_HOSTED_E2E');
  // CLI's Viper binding can override TOML ports via SUPABASE_*_PORT.
  // No values (potential connection credentials) enter diagnostics.
  requireThat(!Object.keys(env).some(key => /^SUPABASE_(?:.*_)?PORT$/.test(key)) &&
    !Object.hasOwn(env, 'DOCKER_HOST') && !Object.hasOwn(env, 'DOCKER_CONTEXT'), 'REFUSE_CONNECTION_OVERRIDE');
}

// Reject later config overrides instead of quietly reserving the wrong ports.
// This reads the small tracked TOML without loading npm dependencies. It does
// not rewrite that file, disable services, or change any public/default URL.
export function assertFixedConfig(source) {
  const expected = { 'api.port': 54321, 'db.port': 54322, 'db.shadow_port': 54320,
    'db.pooler.port': 54329, 'studio.port': 54323, 'inbucket.port': 54324,
    'inbucket.smtp_port': 54325, 'inbucket.pop3_port': 54326,
    'local_smtp.port': 54324, 'local_smtp.smtp_port': 54325, 'local_smtp.pop3_port': 54326,
    'analytics.port': 54327, 'edge_runtime.inspector_port': 8083 };
  let section = '';
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const match = /^\[([a-z_.]+)\]$/.exec(line);
      requireThat(match, 'UNSUPPORTED_CONFIG_SECTION');
      section = match[1];
    } else {
      // Deliberately accept only this tracked config's canonical bare keys.
      // Quoted Unicode escapes and dotted quoted keys can spell "port" too;
      // refusing those forms avoids pretending this scanner is a TOML parser.
      const assignment = /^([a-z_][a-z0-9_]*)\s*=/.exec(line);
      requireThat(assignment, 'UNSUPPORTED_CONFIG_KEY');
      if (/^(?:port|[a-z_]+_port)$/.test(assignment[1])) {
        const match = /^([a-z_]*port)\s*=\s*(\d+)$/.exec(line);
        requireThat(match && expected[`${section}.${match[1]}`] === Number(match[2]), 'UNRESERVED_CONFIG_PORT');
      }
    }
  }
}

// All effects are injected so tests exercise the actual orchestration without
// touching sysctl, opening sockets, invoking sudo, or starting a native stack.
export function reservePorts({ env, platform, uid, read, apply }) {
  assertCI(env, platform, uid);
  assertFixedConfig(read('supabase/config.toml'));
  const before = formatRanges(parseRanges(read(RESERVED)));
  for (const file of SOCKETS) assertNoOwnedPortSockets(read(file));
  const combined = new Set([...parseRanges(before), ...PORTS]);
  const desired = formatRanges(combined);
  requireThat(formatRanges(parseRanges(read(RESERVED))) === before, 'RESERVATIONS_CHANGED_BEFORE_WRITE');
  if (desired !== before) apply(desired);
  requireThat(formatRanges(parseRanges(read(RESERVED))) === desired, 'RESERVATION_READBACK_MISMATCH');
  for (const file of SOCKETS) assertNoOwnedPortSockets(read(file));
  return { protectedPorts: PORTS.length, existingReservationsPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = reservePorts({ env: process.env, platform: process.platform, uid: process.getuid?.(),
      read: file => readFileSync(file, 'utf8'),
      apply: value => {
        const out = spawnSync('/usr/bin/sudo', ['-n', '--', '/usr/sbin/sysctl', '-w',
          `net.ipv4.ip_local_reserved_ports=${value}`], {
          encoding: 'utf8', timeout: 10000, maxBuffer: 128000,
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
        });
        requireThat(!out.error && out.status === 0 && out.signal === null, 'RESERVATION_WRITE_FAILED');
      } });
    console.log(`PASS CI fixed ports reserved (${result.protectedPorts}); existing reservations preserved`);
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'CI_PORT_GUARD_FAILED');
    process.exitCode = 1;
  }
}
