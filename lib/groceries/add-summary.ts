// One line for what a grocery add actually did — including the half that used to
// be invisible.
//
// `addItems` returns `{ added, skipped }`, where `skipped` is the items already
// on the list under `normalizeName`. Before §7 the UI could not distinguish the
// cases: a raw insert always "succeeded", so typing "Milk" when milk was there
// produced a second line and a cheerful confirmation.
//
// A plain module rather than an export of the action file: everything a
// `'use server'` file exports becomes a callable endpoint, and a pure string
// function has no business being a network round trip. Shared so the three
// surfaces that add groceries cannot drift into three phrasings of one event —
// in particular the case that matters, "everything you added was already there".
export type GroceryAddOutcome = { added: number; skipped: string[] };

const plural = (n: number) => (n === 1 ? 'item' : 'items');

export function describeGroceryAdd(result: GroceryAddOutcome): string {
  const { added, skipped } = result;
  if (added === 0 && skipped.length > 0) {
    return skipped.length === 1
      ? `${skipped[0]} is already on your list`
      : `All ${skipped.length} ${plural(skipped.length)} were already on your list`;
  }
  if (skipped.length > 0) {
    return `Added ${added} ${plural(added)} · ${skipped.length} already on your list`;
  }
  return `Added ${added} ${plural(added)} to your grocery list`;
}

/** Whether the outcome is worth a warning tone rather than a success one. */
export function groceryAddWasNoOp(result: GroceryAddOutcome): boolean {
  return result.added === 0 && result.skipped.length > 0;
}
