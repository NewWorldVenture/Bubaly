import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ getSession: vi.fn(), getCookie: vi.fn(), prepare: vi.fn(), verify: vi.fn(), update: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: state.getCookie }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({ auth: { getSession: state.getSession } }) }));
vi.mock('@/lib/auth/recovery-server', () => ({
  RECOVERY_HANDOFF_COOKIE: 'bubaly-recovery-handoff',
  RecoveryError: class extends Error { constructor(public key: string) { super(key); } },
  prepareImplicitRecovery: state.prepare, verifyRecoveryGrant: state.verify, updateRecoveryPassword: state.update,
}));
import { RecoveryError } from '@/lib/auth/recovery-server';
import { consumeRecoveryAction, inspectRecoveryAction, prepareRecoveryAction, saveRecoveryAction } from '@/app/(auth)/auth/recovery/actions';

const identity = { userId: 'user-a', sessionId: 'session-a', email: 'a@example.invalid', expiresAt: 123456 };
const grant = 'synthetic-signed-grant';
const handoff = createHash('sha256').update(grant).digest('hex');
beforeEach(() => {
  vi.resetAllMocks();
  state.getSession.mockResolvedValue({ data: { session: { access_token: 'exact-cookie-token-a' } }, error: null });
  state.getCookie.mockReturnValue({ value: grant });
  state.verify.mockResolvedValue(identity);
  state.prepare.mockResolvedValue({ identity, grant, session: { access_token: 'rotated-a', refresh_token: 'rotated-refresh-a' } });
  state.update.mockResolvedValue({ outcome: 'updated' });
});
afterEach(() => vi.useRealTimers());

describe('recovery action request and session binding', () => {
  it('returns a prepared pair without reading or installing the ambient session', async () => {
    await expect(prepareRecoveryAction('fragment-a', 'refresh-a')).resolves.toMatchObject({ ok: true, identity, grant });
    expect(state.prepare).toHaveBeenCalledWith('fragment-a', 'refresh-a');
    expect(state.getSession).not.toHaveBeenCalled();
  });
  it('does not fall back to a valid ambient session after rejected explicit credentials', async () => {
    state.prepare.mockRejectedValue(new RecoveryError('authRecovery.invalidLink'));
    await expect(prepareRecoveryAction('bad', 'bad')).resolves.toEqual({ ok: false, errorKey: 'authRecovery.invalidLink' });
    expect(state.getSession).not.toHaveBeenCalled();
  });
  it('requires both the callback hash and matching current session before returning the grant', async () => {
    await expect(consumeRecoveryAction(handoff)).resolves.toEqual({ ok: true, identity, grant });
    expect(state.getCookie).toHaveBeenCalledWith('bubaly-recovery-handoff');
    expect(state.verify).toHaveBeenCalledWith(grant, 'exact-cookie-token-a');
  });
  it.each(['', 'x'.repeat(64), '0'.repeat(64), handoff.toUpperCase()])('rejects malformed or unrelated handoff %s without session access', async value => {
    await expect(consumeRecoveryAction(value)).resolves.toMatchObject({ ok: false, errorKey: 'authRecovery.invalidLink' });
    expect(state.getSession).not.toHaveBeenCalled();
    expect(state.verify).not.toHaveBeenCalled();
  });
  it('rejects a missing bridge cookie', async () => {
    state.getCookie.mockReturnValue(undefined);
    await expect(consumeRecoveryAction(handoff)).resolves.toMatchObject({ ok: false, errorKey: 'authRecovery.invalidLink' });
    expect(state.verify).not.toHaveBeenCalled();
  });
  it('never authorizes the preserved account B using account A’s recovery grant', async () => {
    state.getSession.mockResolvedValue({ data: { session: { access_token: 'token-b' } }, error: null });
    state.verify.mockRejectedValue(new RecoveryError('authRecovery.sessionChanged'));
    await expect(consumeRecoveryAction(handoff)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
    expect(state.verify).toHaveBeenCalledWith(grant, 'token-b');
  });
  it('revalidates a persisted grant against the current request', async () => {
    await expect(inspectRecoveryAction(grant)).resolves.toEqual({ ok: true, identity });
    expect(state.verify).toHaveBeenCalledWith(grant, 'exact-cookie-token-a');
  });
  it.each([null, undefined])('rejects an absent session before password mutation', async session => {
    state.getSession.mockResolvedValue({ data: { session }, error: null });
    await expect(saveRecoveryAction(grant, 'new-password')).resolves.toEqual({ outcome: 'failed', errorKey: 'authRecovery.sessionChanged' });
    expect(state.update).not.toHaveBeenCalled();
  });
  it('pins the update to one token read and preserves the helper outcome', async () => {
    state.update.mockResolvedValue({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    await expect(saveRecoveryAction(grant, 'new-password')).resolves.toEqual({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    expect(state.update).toHaveBeenCalledWith(grant, 'exact-cookie-token-a', 'new-password');
    expect(state.getSession).toHaveBeenCalledTimes(1);
  });
  it('reports refresh outages as temporary without implying an account switch', async () => {
    state.getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 503 } });
    await expect(saveRecoveryAction(grant, 'new-password')).resolves.toEqual({ outcome: 'failed', errorKey: 'authRecovery.temporarilyUnavailable' });
    expect(state.update).not.toHaveBeenCalled();
  });
  it('bounds a held session read without issuing a password write later', async () => {
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    state.getSession.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const pending = saveRecoveryAction(grant, 'new-password');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ outcome: 'failed', errorKey: 'authRecovery.temporarilyUnavailable' });
    release({ data: { session: { access_token: 'late-token' } }, error: null });
    await Promise.resolve();
    expect(state.update).not.toHaveBeenCalled();
  });
  it('sanitizes infrastructure failures rather than returning credentials or stack text', async () => {
    state.getSession.mockRejectedValue(new Error('synthetic secret-bearing diagnostic'));
    await expect(inspectRecoveryAction(grant)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.temporarilyUnavailable' });
  });
});
