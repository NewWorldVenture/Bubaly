import 'server-only';
import { getTranslations } from '@/lib/i18n/server';
import { effectiveLength } from '../content';
import { isXId, loadXAccessToken, loadScheduledXAccessToken, XBoundaryError } from '../account-tokens';
import { ScheduledPublishError } from '../scheduled-authority';
import { xJsonRequest } from '../x-oauth';
import type { ConnectorPublishInput, ConnectorPublishOutput } from '../connectors';

export async function publishX(input: ConnectorPublishInput): Promise<ConnectorPublishOutput> {
  const t = await getTranslations();
  const fail = (errorCode: string, key: string): ConnectorPublishOutput => ({ ok: false, status: 'failed', errorCode, errorMessage: t(key) });
  const unknown = (): ConnectorPublishOutput => ({ ok: false, status: 'publishing', errorCode: 'confirmation_unknown', errorMessage: t('socialX.publishUnknown') });
  if (!input.familyId || !input.accountId || !input.userId || input.platform !== 'x' || !isXId(input.providerAccountId)) return fail('account_unavailable', 'socialX.reconnectRequired');
  if (!['text', 'link'].includes(input.kind ?? '') || !Array.isArray(input.mediaUrls) || input.mediaUrls.length) return fail('unsupported_content', 'socialX.unsupportedContent');
  if (typeof input.body !== 'string' || input.body.length > 100_000 || (input.link != null && typeof input.link !== 'string')) return fail('invalid_content', 'socialX.invalidContent');
  const link = input.link?.trim();
  if (input.kind === 'link' && !link) return fail('invalid_content', 'socialX.invalidContent');
  if (link) {
    try { const url = new URL(link); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s/.test(link) || link.length > 4096) throw new Error(); }
    catch { return fail('invalid_content', 'socialX.invalidContent'); }
  }
  const text = [input.body.trim(), link].filter(Boolean).join('\n');
  if (!text || effectiveLength(text, 'x') > 280) return fail('invalid_content', 'socialX.invalidContent');
  let accessToken: string;
  try { accessToken = input.scheduledClaim ? await loadScheduledXAccessToken(input)
    : await loadXAccessToken({ familyId: input.familyId, userId: input.userId }, input.accountId, input.providerAccountId); }
  catch (error) { return fail('account_unavailable', error instanceof XBoundaryError || error instanceof ScheduledPublishError ? error.key : 'socialX.permissionDenied'); }
  // No retries after dispatch: a missing/malformed/late response is not proof of rejection.
  try {
    const response = await xJsonRequest('https://api.x.com/2/tweets', { method: 'POST', signal: input.signal, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (response.status === 408) return unknown();
    if (response.status >= 400 && response.status < 500) return fail(response.status === 429 ? 'rate_limited' : response.status === 401 ? 'reconnect_required' : 'provider_rejected', response.status === 401 ? 'socialX.reconnectRequired' : 'socialX.publishRejected');
    const body = response.body as { data?: { id?: unknown } } | null;
    if (response.status !== 201 || !isXId(body?.data?.id)) return unknown();
    return { ok: true, status: 'published', providerObjectId: body.data.id, permalinkUrl: `https://x.com/i/status/${body.data.id}`, raw: { id: body.data.id } };
  } catch { return unknown(); }
}
