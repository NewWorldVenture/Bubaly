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
// `hint` is for the case where the individual reasons are true but useless: when
// Supabase rejects the deployment's key, all twelve reads fail with the same
// opaque string and none of them says what to do. The list still renders — it is
// the evidence — but the hint goes first, because it is the only actionable part.
//
// ── TWO ENTRY SHAPES, AND THE DIFFERENCE IS WHO IS READING (I18N-006) ────────
//
// A failure line has two halves that are not alike. The LABEL is ours — "member
// profiles", "meal plans" — and a family reads it. The DETAIL is whatever
// `describeReadError` pulled out of PostgREST — `relation
// "guardian_member_profiles" does not exist` — and nothing can translate it.
//
// Every caller used to join the two with `${label}: ${detail}` into one string,
// which is why the labels stayed English: translating the first half produces
// "Mitgliederprofile: relation … does not exist", a sentence half in the
// reader's language and half in Postgres's. The audit refused that shape, and
// it was right to — but the fix is to stop building the sentence, not to leave
// the family reading table names.
//
//   { label, detail }  the FAMILY form. `label` comes from the catalogue and is
//                      the page's own prose; `detail` renders as <code>, which
//                      is what says "this part is the machine talking" without
//                      needing a word of any language. There is no colon,
//                      because the colon was the join that made it one sentence.
//   string             the OPERATOR form, English end to end. Only /admin/*
//                      pages use it, and they are unreachable for a parent or a
//                      child — app/(app)/admin/layout.tsx redirects anyone who
//                      is not a super admin. Their diagnostics are evidence for
//                      whoever is holding the pager, and evidence reads better
//                      in one language than in the reader's.
//
// The two shapes are the decision the audit said had to be made, written down in
// the type rather than in a comment: family-facing banners are translated,
// operator banners are deliberately not.
export type ReadFailure = string | { label: string; detail: string };

export function PartialReadBanner({
  title,
  failures,
  hint,
}: {
  title: string;
  failures: readonly ReadFailure[];
  hint?: string;
}) {
  if (failures.length === 0) return null;
  return (
    <div role="status" className="rounded-xl border border-danger/30 bg-danger/10 p-4">
      <p className="text-sm font-semibold text-danger">{title}</p>
      {hint ? <p className="mt-1.5 text-xs font-medium text-danger">{hint}</p> : null}
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-danger/90">
        {failures.map((failure) =>
          typeof failure === 'string' ? (
            <li key={failure}>{failure}</li>
          ) : (
            <li key={failure.label}>
              {failure.label}{' '}
              <code className="break-all font-mono text-[0.95em] opacity-80">{failure.detail}</code>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
