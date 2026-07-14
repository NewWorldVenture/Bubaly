import 'server-only';

/** Require a durable sync row before the engine reports a state transition. */
export function requireSyncWrite<T>(data: T | null | undefined, error: unknown, operation: string): T {
  if (error || data == null) throw new Error(`Sync ${operation} failed`);
  return data;
}
