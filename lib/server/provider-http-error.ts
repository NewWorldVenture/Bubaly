/**
 * A provider answered with an HTTP error. Thrown INSIDE `withAiRequest`, so the
 * request row and the model-usage record say `failed` rather than `completed`:
 * a fetch that resolves with a 500 or a 429 is still a failed model call, and
 * returning the Response out of the observed body recorded it as a success.
 * The route catches it outside and answers with its usual 502.
 */
export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`provider answered HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}
