import 'server-only';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { requireSocialPermission } from './access';
import { decryptSecret, encryptSecret } from '@/lib/sync/crypto';
import type { Tables } from '@/lib/database.types';
import { authorizeScheduledToken, scheduleSignal } from './scheduled-authority';
import type { ConnectorPublishInput } from './connectors';

export class XBoundaryError extends Error {
  constructor(public readonly key: string) { super(key); }
}
export function xFailure(key = 'storageUnavailable'): never { throw new XBoundaryError(`socialX.${key}`); }
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
export const isXId = (id: unknown): id is string => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id);
type Account = Tables<'social_accounts'>;
type Token = Tables<'social_account_tokens'>;
type Db = ReturnType<typeof createServiceClient>;
export type XActor = { familyId: string; userId: string };
export type XFlow = XActor & { accountId: string; state: string; verifier: string; redirectUri: string; issuedAt: number; expiresAt: number; revision: string };
export type XGrant = { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
type Envelope = XGrant & { version: 1; accountId: string; familyId: string; platform: 'x'; providerAccountId: string };
function meta(row: Token | Account): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
}

/** The public provider boundary requires the current request's active family and actor. */
export async function requireXActor(actor: XActor, permission: 'connect_accounts' | 'publish_posts'): Promise<void> {
  const ctx = await requireUserContext();
  if (ctx.user.id !== actor.userId || ctx.active.familyId !== actor.familyId) xFailure('permissionDenied');
  const access = await requireSocialPermission(actor.familyId, permission);
  if (access.userId !== actor.userId) xFailure('permissionDenied');
}

async function tokenRow(db: Db, actor: XActor, accountId: string, signal?: AbortSignal): Promise<Token | null> {
  // account_id has a nonunique index. Never select an arbitrary credential row.
  const result = await db.from('social_account_tokens').select('*', { count: 'exact' }).eq('account_id', accountId).limit(2).abortSignal(scheduleSignal(signal));
  if (result.error || !result.data || typeof result.count !== 'number' || result.count !== result.data.length || result.count > 1) xFailure();
  const row = result.data[0] ?? null;
  if (row && (row.id !== accountId || row.family_id !== actor.familyId || row.platform !== 'x')) xFailure();
  return row;
}

async function accountRow(db: Db, actor: XActor, accountId: string, signal?: AbortSignal): Promise<Account> {
  const result = await db.from('social_accounts').select('*').eq('id', accountId).eq('family_id', actor.familyId).eq('platform', 'x').abortSignal(scheduleSignal(signal)).single();
  if (result.error || !result.data) xFailure();
  return result.data;
}

export async function createXReceipt(flow: XFlow, stateHash: string): Promise<void> {
  await requireXActor(flow, 'connect_accounts');
  const db = createServiceClient();
  const account = await db.from('social_accounts').insert({
    id: flow.accountId, family_id: flow.familyId, user_id: flow.userId, platform: 'x', status: 'pending',
    display_name: 'X', created_by: flow.userId, metadata: { x_flow: flow.revision },
  }).select('id').single();
  if (account.error || !account.data) xFailure();
  const token = await db.from('social_account_tokens').insert({
    id: flow.accountId, account_id: flow.accountId, family_id: flow.familyId, platform: 'x', created_by: flow.userId,
    metadata: { x_state: 'authorizing', x_revision: flow.revision, x_state_hash: stateHash, x_actor: flow.userId },
  }).select('id').single();
  if (token.error || !token.data) xFailure();
}

async function activeFlowAccount(db: Db, flow: XFlow): Promise<Account> {
  if (!Number.isFinite(flow.expiresAt) || flow.expiresAt <= Date.now()) xFailure('callbackInvalid');
  const row = await accountRow(db, flow, flow.accountId);
  if (row.user_id !== flow.userId || row.status !== 'pending' || row.deleted_at || meta(row).x_flow !== flow.revision) xFailure('callbackInvalid');
  return row;
}

export async function claimXReceipt(flow: XFlow, stateHash: string): Promise<void> {
  await requireXActor(flow, 'connect_accounts');
  const db = createServiceClient();
  await activeFlowAccount(db, flow);
  const row = await tokenRow(db, flow, flow.accountId);
  if (!row || row.provider_account_id || meta(row).x_actor !== flow.userId) xFailure('callbackInvalid');
  const receipt = { x_state: 'authorizing', x_revision: flow.revision, x_state_hash: stateHash, x_actor: flow.userId };
  const claimed = await db.from('social_account_tokens').update({ metadata: { ...receipt, x_state: 'exchanging' } })
    .eq('id', row.id).contains('metadata', receipt).select('id').single();
  if (claimed.error || !claimed.data) xFailure('callbackInvalid');
  await activeFlowAccount(db, flow);
}

/** Claim existing credentials before replacing them; an incomplete callback stays unusable. */
export async function saveXConnection(flow: XFlow, grant: XGrant, identity: { id: string; username: string; name: string }): Promise<string> {
  await requireXActor(flow, 'connect_accounts');
  const db = createServiceClient();
  const pending = await activeFlowAccount(db, flow);
  const receipt = await tokenRow(db, flow, flow.accountId);
  if (!receipt || meta(receipt).x_state !== 'exchanging' || meta(receipt).x_revision !== flow.revision) xFailure('callbackInvalid');
  const matches = await db.from('social_accounts').select('*', { count: 'exact' }).eq('family_id', flow.familyId).eq('platform', 'x').eq('provider_account_id', identity.id).limit(2);
  if (matches.error || !matches.data || typeof matches.count !== 'number' || matches.count !== matches.data.length || matches.count > 1) xFailure();
  const target = matches.data[0] ?? pending;
  if (target.id !== pending.id) {
    // An authorization started before a disconnect cannot undo that disconnect.
    if (target.deleted_at && (!Number.isFinite(Date.parse(target.deleted_at)) || Date.parse(target.deleted_at) >= flow.issuedAt)) xFailure('callbackInvalid');
    const oldToken = await tokenRow(db, flow, target.id);
    if (oldToken) {
      const old = meta(oldToken);
      if (!['ready', 'blocked'].includes(String(old.x_state)) || typeof old.x_revision !== 'string' || oldToken.provider_account_id !== identity.id) xFailure('reconnectRequired');
      if (old.x_state === 'blocked' && (typeof old.x_revoked_at !== 'number' || !Number.isFinite(old.x_revoked_at) || old.x_revoked_at >= flow.issuedAt)) xFailure('callbackInvalid');
      const claim = await db.from('social_account_tokens').update({ metadata: { x_state: 'connecting', x_revision: flow.revision } })
        .eq('id', target.id).contains('metadata', { x_state: old.x_state, x_revision: old.x_revision }).select('id').single();
      if (claim.error || !claim.data) xFailure();
    } else {
      const inserted = await db.from('social_account_tokens').insert({ id: target.id, account_id: target.id, family_id: flow.familyId, platform: 'x', provider_account_id: identity.id,
        metadata: { x_state: 'connecting', x_revision: flow.revision }, created_by: flow.userId }).select('id').single();
      if (inserted.error || !inserted.data) xFailure();
    }
  }
  const accountPatch = { provider_account_id: identity.id, status: 'pending' as const, deleted_at: null,
    metadata: { x_flow: flow.revision }, updated_by: flow.userId };
  let accountWrite = db.from('social_accounts').update(accountPatch).eq('id', target.id).eq('family_id', flow.familyId)
    .eq('status', target.status).eq('updated_at', target.updated_at);
  accountWrite = target.deleted_at ? accountWrite.eq('deleted_at', target.deleted_at) : accountWrite.is('deleted_at', null);
  const claimedAccount = await accountWrite.select('id').single();
  if (claimedAccount.error || !claimedAccount.data) xFailure();

  const envelope: Envelope = { ...grant, version: 1, accountId: target.id, familyId: flow.familyId, platform: 'x', providerAccountId: identity.id };
  // Each ciphertext carries its purpose and full authority binding, preventing transplants.
  const tokenPatch = { provider_account_id: identity.id, access_token_enc: encryptSecret(JSON.stringify({ ...envelope, refreshToken: '' })),
    refresh_token_enc: encryptSecret(JSON.stringify({ ...envelope, accessToken: '' })), token_type: 'bearer', scope: grant.scopes.join(' '),
    expires_at: new Date(grant.expiresAt).toISOString(), updated_by: flow.userId, metadata: { x_state: 'ready', x_revision: flow.revision } };
  const saved = await db.from('social_account_tokens').update(tokenPatch).eq('id', target.id)
    .contains('metadata', { x_state: target.id === pending.id ? 'exchanging' : 'connecting', x_revision: flow.revision }).select('id').single();
  if (saved.error || !saved.data) xFailure();
  if (target.id !== pending.id) {
    const consumed = await db.from('social_account_tokens').update({ metadata: { x_state: 'consumed', x_revision: flow.revision } })
      .eq('id', pending.id).contains('metadata', { x_state: 'exchanging', x_revision: flow.revision }).select('id').single();
    if (consumed.error || !consumed.data) xFailure();
    const retired = await db.from('social_accounts').update({ status: 'disconnected', deleted_at: new Date().toISOString(), updated_by: flow.userId })
      .eq('id', pending.id).eq('status', 'pending').is('deleted_at', null).contains('metadata', { x_flow: flow.revision }).select('id').single();
    if (retired.error || !retired.data) xFailure();
  }
  await requireXActor(flow, 'connect_accounts');
  if (flow.expiresAt <= Date.now() || grant.expiresAt <= Date.now() + 30_000) xFailure('callbackInvalid');
  const connected = await db.from('social_accounts').update({ status: 'connected', health: 'healthy', handle: identity.username,
    display_name: identity.name, profile_url: `https://x.com/${identity.username}`, scopes: grant.scopes,
    last_error: null, updated_by: flow.userId }).eq('id', target.id).eq('family_id', flow.familyId).eq('status', 'pending')
    .is('deleted_at', null).contains('metadata', { x_flow: flow.revision }).select('id').single();
  if (connected.error || !connected.data) xFailure();
  return target.id;
}

export async function loadXAccessToken(actor: XActor, accountId: string, providerAccountId: string): Promise<string> {
  await requireXActor(actor, 'publish_posts');
  return readXAccessToken(actor, accountId, providerAccountId);
}

/** Scheduling validates present credentials without returning tokens or sending. */
export async function assertXCredentials(actor: XActor, accounts: Array<{ accountId: string; providerAccountId: string }>): Promise<void> {
  await requireXActor(actor, 'publish_posts');
  const signal = AbortSignal.timeout(12_000);
  await Promise.all(accounts.map(account => readXAccessToken(actor, account.accountId, account.providerAccountId, signal)));
}

/** A private receipt/claim must authorize the exact payload before token access. */
export async function loadScheduledXAccessToken(input: ConnectorPublishInput): Promise<string> {
  if (!input.scheduledClaim || !input.familyId || !input.userId || !input.accountId || !input.providerAccountId) return xFailure('permissionDenied');
  await authorizeScheduledToken(input, input.scheduledClaim);
  return readXAccessToken({ familyId: input.familyId, userId: input.userId }, input.accountId, input.providerAccountId, input.signal);
}

async function readXAccessToken(actor: XActor, accountId: string, providerAccountId: string, signal?: AbortSignal): Promise<string> {
  const db = createServiceClient();
  const account = await accountRow(db, actor, accountId, signal);
  if (account.status !== 'connected' || account.deleted_at || account.provider_account_id !== providerAccountId) xFailure('reconnectRequired');
  const row = await tokenRow(db, actor, accountId, signal);
  if (!row || row.provider_account_id !== providerAccountId || meta(row).x_state !== 'ready' || !row.access_token_enc) xFailure('reconnectRequired');
  let token: Envelope;
  try { token = JSON.parse(decryptSecret(row.access_token_enc)) as Envelope; } catch { return xFailure(); }
  if (token.version !== 1 || token.platform !== 'x' || token.accountId !== accountId || token.familyId !== actor.familyId || token.providerAccountId !== providerAccountId ||
      typeof token.accessToken !== 'string' || !token.accessToken || token.accessToken.length > 16384 || token.refreshToken !== '' ||
      !Array.isArray(token.scopes) || !X_SCOPES.every((scope) => token.scopes.includes(scope)) ||
      !Number.isFinite(token.expiresAt) || token.expiresAt <= Date.now() + 30_000 || row.expires_at !== new Date(token.expiresAt).toISOString()) xFailure('reconnectRequired');
  return token.accessToken;
}

/** Revoke private authority before the public disconnect; a failed public write stays unusable. */
export async function clearXTokens(actor: XActor, accountId: string): Promise<void> {
  await requireXActor(actor, 'connect_accounts');
  const db = createServiceClient();
  await accountRow(db, actor, accountId);
  // Clear every row, including legacy duplicates, without making them eligible to publish.
  const cleared = await db.from('social_account_tokens').update({ access_token_enc: null, refresh_token_enc: null,
    metadata: { x_state: 'blocked', x_revision: randomUUID(), x_revoked_at: Date.now() }, updated_by: actor.userId })
    .eq('account_id', accountId).eq('family_id', actor.familyId).eq('platform', 'x');
  if (cleared.error) xFailure();
}
