-- Bubaly :: 0157 Family signals — add the budget-drift kind (R10)
-- ----------------------------------------------------------------------------
-- Widens family_signals.kind (0142) to include 'budget_drift' — the 5th hard
-- signal: a budget category over its cap for the current period (a stronger,
-- dismissable pattern when the prior period was over too). Additive + idempotent:
-- just re-creates the CHECK constraint with the extra allowed value.

alter table public.family_signals
  drop constraint if exists family_signals_kind_check;
alter table public.family_signals
  add constraint family_signals_kind_check
  check (kind in ('ignored_reminder', 'stress_window', 'chore_conflict', 'routine_adherence', 'budget_drift'));
