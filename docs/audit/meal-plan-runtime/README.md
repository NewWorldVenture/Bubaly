# Meal-plan runtime proofs

These two SQL files are **not** boundary probes of the Database job. They need
the isolated synthetic PostgreSQL 17 database that
`.github/workflows/meal-plan-atomic-write-runtime.yml` builds
(`bubaly_meal_plan_atomic_ci`, with `dblink` for the two-session cases), and
each refuses to run anywhere else. They live in their own folder so that
`docs/audit/run-probes.sh` does not glob them and the audit rules over
`docs/audit/*.sql` — a file that raises must end in `-check.sql`; a file that
installs an extension must take its functions back from the client roles — judge
only the probes that job runs. The runtime workflow runs both on every change to
them, to migration 0478 and to the meal-plan service.
