/** Read every page before a caller makes a claim about absent household data.
 * The factory must apply family scope and a stable order on each page. */
export async function readAllPages<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ data: T[] | null; error: unknown }> {
  const rows: T[] = [];
  const pageSize = 400;
  for (let from = 0; ;) {
    const page = await read(from, from + pageSize - 1);
    if (page.error) return { data: null, error: page.error };
    if (!page.data) return { data: null, error: new Error('The data page was unavailable') };
    if (page.data.length === 0) return { data: rows, error: null };
    rows.push(...page.data);
    // A server may cap responses below our requested range. Only an empty
    // next page proves exhaustion; advance by the rows actually received.
    from += page.data.length;
  }
}
