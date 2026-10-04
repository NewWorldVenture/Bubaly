import { bearerMatches, secretsMatch } from '@/lib/server/secret-compare';
import { openFleetStore } from './repository';
import {
  FleetConfigurationError, fleetDailyBudget, fleetExecutionEnabled,
  fleetMaxConcurrency, fleetWorkerRegistrations, type FleetWorkerRegistration,
} from './runtime-config';
import { cancelFleetJob, fleetJobView, fleetProbePayload, runFleetTick, type FleetSupervisorDependencies } from './service';
import { FleetStoreError, type ClaudeFleetStore } from './store';
import { vercelFleetSupervisor } from './supervisor';
import { claudeWorkerProbeResult } from './worker';

type StoreHandle = { store: ClaudeFleetStore; close(): void };
export type FleetManagerDependencies = {
  openStore?: () => StoreHandle;
  registrations?: () => FleetWorkerRegistration[];
  supervisor?: FleetSupervisorDependencies;
};
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_BODY_BYTES = 8_192;
const PUBLIC_CONFIGURATION_ERRORS = new Set([
  'database_unconfigured', 'invalid_database_url', 'remote_database_required',
  'invalid_concurrency', 'invalid_daily_budget', 'accounts_unconfigured', 'workers_unconfigured',
  'invalid_worker_bindings', 'invalid_worker_alias', 'invalid_worker_branch', 'invalid_worker_revision',
  'invalid_worker_workspace', 'isolated_snapshot_required', 'isolated_credential_required', 'execution_key_unconfigured',
]);
class RequestTooLarge extends Error {}

/** Stop reading once the byte cap is exceeded rather than buffering the full request. */
async function boundedRequestBody(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* response still reports the size limit */ }
        throw new RequestTooLarge();
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}

/** Privileged function/CLI surface. Browser sessions and cron secrets do not grant management rights. */
export async function handleFleetManagerRequest(req: Request, dependencies: FleetManagerDependencies = {}) {
  const secret = process.env.CLAUDE_FLEET_MANAGER_SECRET;
  if (!secret || secretsMatch(secret, process.env.CRON_SECRET) || !bearerMatches(req.headers.get('authorization'), secret)) {
    return response({ error: 'unauthorized' }, 401);
  }
  if (req.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return response({ error: 'json_required' }, 415);
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) return response({ error: 'request_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const raw = await boundedRequestBody(req);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return response({ error: 'invalid_request' }, 400);
    body = parsed as Record<string, unknown>;
  } catch (error) { return response({ error: error instanceof RequestTooLarge ? 'request_too_large' : 'invalid_request' }, error instanceof RequestTooLarge ? 413 : 400); }
  const allowed: Record<string, string[]> = {
    submit: ['action', 'alias', 'requestKey'], continue: ['action', 'alias', 'requestKey', 'previousJobId'],
    status: ['action', 'jobId'], result: ['action', 'jobId'], cancel: ['action', 'jobId'],
    list: ['action'], pause: ['action'], resume: ['action'], stop: ['action'], tick: ['action'],
  };
  if (typeof body.action !== 'string' || !Object.hasOwn(allowed, body.action)
    || Object.keys(body).some((key) => !allowed[body.action as string].includes(key))) return response({ error: 'invalid_request' }, 400);
  const action = body.action;
  if (['status', 'result', 'cancel'].includes(action) && (typeof body.jobId !== 'string' || !ID.test(body.jobId))) {
    return response({ error: 'invalid_job_id' }, 400);
  }
  if (['submit', 'continue'].includes(action) && (typeof body.alias !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(body.alias)
    || typeof body.requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:/.-]{0,255}$/.test(body.requestKey)
    || (action === 'continue' && (typeof body.previousJobId !== 'string' || !ID.test(body.previousJobId))))) {
    return response({ error: 'invalid_request' }, 400);
  }
  if (['submit', 'continue', 'resume', 'tick'].includes(action) && !fleetExecutionEnabled()) {
    return response({ error: 'worker_execution_disabled' }, 503);
  }
  let handle: StoreHandle | undefined;
  try {
    const supervisor = dependencies.supervisor ?? vercelFleetSupervisor;
    handle = (dependencies.openStore ?? openFleetStore)();
    const store = handle.store;
    if (action === 'list') return response({ jobs: (await store.list(100)).map(fleetJobView), paused: await store.isPaused() });
    if (action === 'pause') { await store.setPaused(true); return response({ paused: true }); }
    if (action === 'resume') {
      (dependencies.registrations ?? fleetWorkerRegistrations)();
      fleetMaxConcurrency(); fleetDailyBudget();
      await store.setPaused(false);
      return response({ paused: false });
    }
    if (action === 'stop') {
      await store.setPaused(true);
      await store.cancelQueued();
      const stopped = await Promise.allSettled((await store.listActive()).map((job) => cancelFleetJob(store, job.id, supervisor)));
      if (stopped.some((result) => result.status === 'rejected')) throw new Error('fleet_stop_failed');
      return response({ paused: true, active: (await store.listActive()).map(fleetJobView) });
    }
    if (action === 'tick') return response(await runFleetTick(store, (dependencies.registrations ?? fleetWorkerRegistrations)(),
      fleetMaxConcurrency(), supervisor, req.signal, fleetDailyBudget()));
    if (action === 'submit' || action === 'continue') {
      const alias = (body.alias as string).toUpperCase().replaceAll('-', '_');
      const registration = (dependencies.registrations ?? fleetWorkerRegistrations)().find((entry) => entry.alias === alias);
      if (!registration) return response({ error: 'unknown_account' }, 400);
      const admitted = await store.submit(body.requestKey as string, fleetProbePayload(registration, body.previousJobId as string | undefined));
      return response({ job: fleetJobView(admitted.job), reused: admitted.reused }, admitted.reused ? 200 : 202);
    }
    const job = action === 'cancel' ? await cancelFleetJob(store, body.jobId as string, supervisor) : await store.get(body.jobId as string);
    if (!job) return response({ error: 'not_found' }, 404);
    return response({ job: fleetJobView(job), ...(action === 'result'
      ? { result: job.status === 'succeeded' && job.result === claudeWorkerProbeResult(job.id) ? job.result : null }
      : {}) });
  } catch (error) {
    if (error instanceof FleetConfigurationError && PUBLIC_CONFIGURATION_ERRORS.has(error.code)) return response({ error: error.code }, 503);
    if (error instanceof FleetStoreError) return response({ error: error.code }, error.code === 'invalid_request' ? 400 : error.code === 'schema_uninitialized' ? 503 : 409);
    return response({ error: 'fleet_operation_failed' }, 503);
  } finally {
    try { handle?.close(); } catch { /* a client cleanup diagnostic must not escape the API */ }
  }
}
