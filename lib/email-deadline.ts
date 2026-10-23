// One email provider call, bounded in time.
//
// The Resend SDK (6.x) calls the global fetch with no signal, so a connection
// the provider accepts and never answers waits for undici's default header
// timeout: 300 seconds, the whole of the weekly digest's maxDuration. The crons
// that send in batches (weekly-digest and chore-reminders run eight at once
// under Promise.all and check their budget only between batches) had one hung
// send hold its batch past the budget into the platform's kill: no response,
// and every family after the batch unserved. The marketing automation step
// calls the provider directly and had the same wait.
//
// The send's own arguments stay exactly what they were
// (tests/queued-email-idempotency.test.ts pins them: no options without a key,
// `{ idempotencyKey }` with one), so the deadline is a race rather than an
// abort. Past it the caller is answered `{ error }`, the SDK's own shape for a
// failed send, and moves on; the request the SDK still holds is abandoned with
// the function. A send that timed out may still have been accepted, so it is
// reported as not sent, and a caller that retries it should send under an
// idempotency key, which the provider folds.

/** How long one provider call may take before it is a failed send rather than a held worker. */
export const EMAIL_PROVIDER_DEADLINE_MS = 15_000;

export type EmailDeadlineMiss = { data: null; error: { name: 'provider_timeout'; message: string } };

/** `send`, or `{ error }` once `ms` has passed without an answer. A rejection still rejects. */
export async function withEmailDeadline<T>(send: PromiseLike<T>, ms: number = EMAIL_PROVIDER_DEADLINE_MS): Promise<T | EmailDeadlineMiss> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<EmailDeadlineMiss>((resolve) => {
    timer = setTimeout(() => resolve({
      data: null,
      error: { name: 'provider_timeout', message: `The email provider did not answer within ${ms} ms.` },
    }), ms);
  });
  try {
    return await Promise.race([send, expired]);
  } finally {
    clearTimeout(timer);
  }
}
