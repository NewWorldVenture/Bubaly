export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-3xl">{title}</h1>
        {description && <p className="mt-0.5 text-xs text-muted sm:mt-1 sm:text-sm">{description}</p>}
      </div>
      {/* Most modules pass their buttons as one `flex` row, and that row did not
          wrap: on a phone Recipes ran 292px past the screen edge. The row
          wraps here, so every header does on a narrow screen. Audit C1-S9-99. */}
      {action && <div className="flex max-w-full shrink-0 flex-wrap gap-2 [&>div]:flex-wrap">{action}</div>}
    </div>
  );
}
