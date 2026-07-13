import { enforceRequestRateLimit, type RequestRateLimitOptions } from '@/lib/server/request-rate-limit';

/** Apply the local guard and the shared Postgres guard before paid AI work. */
export async function enforceAIRateLimit(
  ...args: Parameters<typeof enforceRequestRateLimit>
): ReturnType<typeof enforceRequestRateLimit> {
  return enforceRequestRateLimit(...args);
}

export type AIRateLimitOptions = RequestRateLimitOptions;
