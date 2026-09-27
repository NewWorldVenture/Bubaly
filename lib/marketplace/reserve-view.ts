// lib/marketplace/reserve-view.ts — read an auction's reserve facts on either
// side of migration 0452.
//
// 0452 (SEC-016) revokes client SELECT on `reserve_cents` and adds two stored
// generated columns, `has_reserve` and `reserve_met`, for the only two facts the
// UI shows. The application ships ahead of its migrations — nothing from 0318 on
// has reached production yet (docs/PENDING_PROD_MIGRATIONS.md) — so every client
// read of those facts has to work against BOTH schemas:
//
//   before 0452   has_reserve / reserve_met do not exist  -> 42703;  reserve_cents readable
//   after 0452    reserve_cents is not selectable          -> 42501;  the two columns readable
//
// A read therefore asks for the two columns first, and only when Postgres says
// one of THOSE columns does not exist does it read again with `reserve_cents` and
// derive the same two facts with `reserveMet()`, the rule the generated column
// mirrors. Every other error goes back to the caller unchanged, so a refusal or a
// dropped connection is never mistaken for an old schema. Once 0452 is applied
// everywhere the fallback is unreachable and this module can be removed.
import { reserveMet } from './auction';

/** The two columns 0452 adds, exactly as a read's column list must name them. */
export const RESERVE_VIEW_COLUMNS = 'has_reserve, reserve_met';

type ReadError = { code?: string; message: string } | null;
type ReadResult<T> = { data: T | null; error: ReadError };
type LegacyRow = { reserve_cents?: number | null; current_bid_cents?: number | null; bid_count?: number | null };

/** True only for "column does not exist" naming one of 0452's two columns. */
export function isReserveViewMissing(error: ReadError): boolean {
  return error?.code === '42703' && /\b(has_reserve|reserve_met)\b/.test(error.message);
}

/** A pre-0397 row, with the figure replaced by the two facts the UI shows. */
export function deriveReserveView<R extends LegacyRow>(
  row: R,
): Omit<R, 'reserve_cents'> & { has_reserve: boolean; reserve_met: boolean } {
  const { reserve_cents: reserve = null, ...rest } = row;
  return {
    ...rest,
    has_reserve: reserve !== null,
    reserve_met: reserveMet({
      reserveCents: reserve,
      currentBidCents: row.current_bid_cents ?? 0,
      bidCount: row.bid_count ?? 0,
    }),
  };
}

/**
 * Run a `marketplace_listings` read that names RESERVE_VIEW_COLUMNS, falling
 * back to the pre-0397 column when the database does not have them yet.
 * `run` receives the column list to select and returns the query's result.
 */
export async function readWithReserveView<T>(
  columns: string,
  run: (columns: string) => PromiseLike<ReadResult<unknown>>,
): Promise<ReadResult<T>> {
  if (!columns.includes(RESERVE_VIEW_COLUMNS)) {
    throw new Error('readWithReserveView: the column list does not name the reserve view');
  }
  const current = await run(columns);
  if (!isReserveViewMissing(current.error)) return current as ReadResult<T>;

  // The derivation needs the price and the bid count; ask for them if the
  // caller did not.
  let legacy = columns.replace(RESERVE_VIEW_COLUMNS, 'reserve_cents');
  for (const column of ['current_bid_cents', 'bid_count']) {
    if (!new RegExp(`\\b${column}\\b`).test(legacy)) legacy += `, ${column}`;
  }
  const previous = await run(legacy);
  if (previous.error || previous.data == null) return previous as ReadResult<T>;
  const data = Array.isArray(previous.data)
    ? previous.data.map((row) => deriveReserveView(row as LegacyRow))
    : deriveReserveView(previous.data as LegacyRow);
  return { data: data as T, error: null };
}
