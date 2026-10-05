import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class FleetCliError extends Error {
  constructor(code) { super(code); this.name = 'FleetCliError'; this.code = code; }
}

export const FLEET_CLI_USAGE = [
  'claude-fleet submit <alias> <requestKey>',
  'claude-fleet continue <alias> <requestKey> <previousJobId>',
  'claude-fleet status|result|cancel <jobId>',
  'claude-fleet list|pause|resume|stop|tick',
  'Set CLAUDE_FLEET_MANAGER_URL to the HTTPS manager endpoint and CLAUDE_FLEET_MANAGER_SECRET in the environment.',
].join('\n');

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9_:/.-]{0,255}$/;

export function parseFleetCommand(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new FleetCliError('invalid_arguments');
  const [action, ...values] = args;
  if (action === '--help' && values.length === 0) return { action: 'help' };
  if (['list', 'pause', 'resume', 'stop', 'tick'].includes(action) && values.length === 0) return { action };
  if (['status', 'result', 'cancel'].includes(action) && values.length === 1 && ID.test(values[0])) {
    return { action, jobId: values[0] };
  }
  if (action === 'submit' && values.length === 2 && ALIAS.test(values[0]) && REQUEST_KEY.test(values[1])) {
    return { action, alias: values[0], requestKey: values[1] };
  }
  if (action === 'continue' && values.length === 3 && ALIAS.test(values[0]) && REQUEST_KEY.test(values[1]) && ID.test(values[2])) {
    return { action, alias: values[0], requestKey: values[1], previousJobId: values[2] };
  }
  throw new FleetCliError('invalid_arguments');
}

/** An explicitly supplied public endpoint; no URL credentials, redirects or local targets. */
export function validateFleetRemoteUrl(raw, protocols = ['https:']) {
  if (typeof raw !== 'string' || raw !== raw.trim() || /[\u0000-\u0020\u007f\\]/.test(raw)) throw new FleetCliError('invalid_remote_url');
  let url;
  try { url = new URL(raw); } catch { throw new FleetCliError('invalid_remote_url'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !host.includes('.') || isIP(host) || host.startsWith('[') || /(^|\.)(localhost|local|internal|invalid)$/.test(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) {
    throw new FleetCliError('invalid_remote_url');
  }
  return url.href;
}

const PUBLIC_FIELDS = new Set([
  'job', 'jobs', 'active', 'reused', 'paused', 'result', 'status', 'reason', 'jobId',
  'id', 'alias', 'organizationId', 'workspaceId', 'branch', 'revision', 'mode', 'attempts', 'error',
  'createdAt', 'updatedAt', 'finishedAt', 'sessionId', 'snapshotId', 'sandboxId', 'permissions', 'workerConnection',
]);

function publicOutput(value, secret, depth = 0) {
  if (depth > 5) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value.replaceAll(secret, '[redacted]')
      .replace(/\b(?:sk-ant-|sk_live_|rk_live_|whsec_)[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => publicOutput(item, secret, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => PUBLIC_FIELDS.has(key))
      .map(([key, entry]) => [key, publicOutput(entry, secret, depth + 1)]));
  }
  return null;
}

/** Count streamed bytes before retaining them; the same request deadline covers body reads. */
export async function readFleetResponseBody(body, signal) {
  if (!body || signal.aborted) throw new FleetCliError('invalid_manager_response');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  let finished = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new FleetCliError('invalid_manager_response'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw new FleetCliError('invalid_manager_response');
      if (next.done) { finished = true; return text + decoder.decode(); }
      if (!(next.value instanceof Uint8Array)) throw new FleetCliError('invalid_manager_response');
      bytes += next.value.byteLength;
      if (bytes > 131_072) throw new FleetCliError('invalid_manager_response');
      text += decoder.decode(next.value, { stream: true });
    }
  } catch { throw new FleetCliError('invalid_manager_response'); }
  finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Injectable fetch keeps tests synthetic. This function never prints credentials or raw errors. */
export async function runFleetCli(args, { env = process.env, fetchImpl = fetch } = {}) {
  const command = parseFleetCommand(args);
  if (command.action === 'help') return { usage: FLEET_CLI_USAGE };
  const endpoint = validateFleetRemoteUrl(env.CLAUDE_FLEET_MANAGER_URL);
  const secret = env.CLAUDE_FLEET_MANAGER_SECRET;
  if (typeof secret !== 'string' || !secret || secret !== secret.trim() || /[\r\n\u0000]/.test(secret)) throw new FleetCliError('manager_secret_unconfigured');
  const deadline = AbortSignal.timeout(60_000);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: deadline,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command),
    });
  } catch { throw new FleetCliError('manager_request_failed'); }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new FleetCliError(response.status === 401 ? 'manager_unauthorized' : 'manager_request_rejected');
  }
  let body;
  try {
    const raw = await readFleetResponseBody(response.body, deadline);
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
  } catch { throw new FleetCliError('invalid_manager_response'); }
  return publicOutput(body, secret);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await runFleetCli(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof FleetCliError ? error.code : 'fleet_cli_failed'}\n`);
    process.exitCode = 1;
  }
}
