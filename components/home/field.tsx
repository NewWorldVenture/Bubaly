/** Lightweight labelled field for the Home forms. Wraps its single control in a
 *  <label> so the text is click-associated, while accepting element children
 *  (the UI-kit Field uses a render-prop; this keeps these dense forms readable). */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-medium text-fg">{label}</span>
      {children}
    </label>
  );
}
