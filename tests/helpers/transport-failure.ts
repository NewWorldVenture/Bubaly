import type { FaultCall, InMemorySupabase } from './in-memory-supabase';

/**
 * The same client, with the chosen queries REJECTING the way a transport
 * failure does (DNS, TCP, TLS, a timed-out fetch): supabase-js resolves
 * `{ data, error }` for everything the database answers and rejects only when
 * the request never completed. Every other query answers from the in-memory
 * database as usual.
 *
 * `fails` names a table, or decides per query from the table and every builder
 * call made on it so far (as `withFaults` does), at the moment it is awaited.
 *
 * A builder's derived thenables reject too: `.maybeSingle()` and `.single()`
 * return a promise rather than the builder, and a wrapper that only proxied the
 * builder itself let those resolve normally, so a bare
 * `await from(t)….maybeSingle()` looked settled when it was not.
 */
export function withTransportFailure<T extends object>(
  client: T,
  fails: string | ((table: string, calls: FaultCall[]) => boolean),
): T {
  const failing = typeof fails === 'string' ? (table: string) => table === fails : fails;
  const rejection = (table: string) => new Error(`CONNECT_TIMEOUT reading ${table}`);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = (target as unknown as InMemorySupabase).from(table);
        const calls: FaultCall[] = [];
        const rejectingThen = (settle: () => PromiseLike<unknown>) =>
          (resolve?: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
            (failing(table, calls) ? Promise.reject(rejection(table)) : Promise.resolve(settle())).then(resolve, reject);
        const proxy: object = new Proxy(builder, {
          get(object, key) {
            if (key === 'then') return rejectingThen(() => object as unknown as PromiseLike<unknown>);
            const value = Reflect.get(object, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              calls.push({ method: String(key), args });
              const result = Reflect.apply(value, object, args);
              if (result === object) return proxy;
              if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                return { then: rejectingThen(() => result as PromiseLike<unknown>) };
              }
              return result;
            };
          },
        });
        return proxy;
      };
    },
  });
}
