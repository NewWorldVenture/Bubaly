// Shown when a page rendered with some of its reads missing.
//
// The alternative — bailing to an error state — was worse for the reader and is
// what several of these pages used to do: one unavailable table cost the whole
// page. But rendering silently is worse still, and on an oversight page it is
// dangerous: "0 flagged transactions" because the read failed looks exactly
// like "0 flagged transactions" because there are none. A zero that means
// "we could not check" must never be mistaken for an all-clear.
//
// So the page renders, and this says plainly which reads are missing. It names
// them individually rather than saying "something failed", because on
// production the answer is usually a specific table that the migration ledger
// has not reached.
export function PartialReadBanner({ title, failures }: { title: string; failures: readonly string[] }) {
  if (failures.length === 0) return null;
  return (
    <div role="status" className="rounded-xl border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-danger/90">
        {failures.map((failure) => <li key={failure}>{failure}</li>)}
      </ul>
    </div>
  );
}
