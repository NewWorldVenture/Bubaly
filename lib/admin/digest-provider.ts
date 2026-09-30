// The Resend adapter the delivery engine needs (docs/admin-digest-delivery-contract.md §4).
//
// #692's sendEmail answers only { ok }, which cannot carry a message id or tell a
// payload conflict from a refusal, and it cannot take the engine's abort signal.
// This adapter posts the row's stored bytes VERBATIM under the row's key, honours
// the signal, reads a bounded response and hands status and body to
// classifyResendResponse. A throw (network, abort) settles nothing: the engine
// records it as unknown.
import { classifyResendResponse, type DigestEmailProvider, type ProviderSendResult } from '@/lib/admin/digest-delivery';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';

export const RESEND_EMAILS_ENDPOINT = 'https://api.resend.com/emails';
const MAX_RESPONSE_BYTES = 64 * 1024;

export function createResendDigestProvider(opts: { apiKey: string; fetchImpl?: typeof fetch }): DigestEmailProvider {
  if (typeof opts.apiKey !== 'string' || !opts.apiKey.trim()) {
    throw new TypeError('admin digest: a Resend API key is required; without one nothing can be sent, so nothing is frozen either');
  }
  const apiKey = opts.apiKey;
  return {
    async send({ idempotencyKey, payloadJson, signal }): Promise<ProviderSendResult> {
      const res = await (opts.fetchImpl ?? fetch)(RESEND_EMAILS_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: payloadJson,
        signal,
      });
      const bounded = await readBoundedResponseText(res, MAX_RESPONSE_BYTES);
      let body: unknown = null;
      if (bounded.ok) {
        try { body = JSON.parse(bounded.text); } catch { body = null; }
      } else if (res.body && !res.bodyUsed && !res.body.locked) {
        // Refused on its declared length, unread: release it now rather than leave the connection to
        // the garbage collector. Not awaited: cleanup never becomes an unbounded wait.
        res.body.cancel().catch(() => undefined);
      }
      // An unreadable 2xx has no message id, so it classifies as unknown: never a receipt.
      return classifyResendResponse(res.status, body);
    },
  };
}
