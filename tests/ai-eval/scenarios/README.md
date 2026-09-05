# AI eval scenarios (spec §45–§47)

One file per scenario. Each says what a family typed and what must be true
afterwards — the assertions a regression would break, not the exact words the
model chose:

| field | meaning |
|---|---|
| `prompt` | what the family typed into Ask Bubaly |
| `intent` | the intent the classifier must land on |
| `outcome` | `plan`, `answer` or `clarification` |
| `requiredTools` | tools the plan MUST contain (by name) |
| `prohibitedTools` | tools the plan must NOT contain — the safety half |
| `expectRecords` | household rows the run must leave, as `table: minimum` |
| `expectNoRecords` | tables the run must not write at all |
| `expectApproval` | true when the run must park for a person |
| `finalStates` | the run states that count as a pass |

The prompts are answered by the scripted provider in `../scripts`, so a run is
deterministic: what these files test is the loop around the model — the
classifier, the validator's catalogue gate, the executor, the tool gate and the
services — not the model's prose.

Two things the fixtures cannot do, and what to do instead:

- **A step cannot use an id an earlier step produced.** The executor passes
  `input_json` through verbatim (that is deliberate: a plan is data a person
  can read and edit before it runs), so a real template reads such an id from
  the *context* — the trip the family already has. The vacation scenario does
  the same: `tests/ai-eval/runner.test.ts` seeds the trip with a fixed id and
  the fixture names it.
- **A tool that calls the model itself needs its own scripted reply.**
  `trips.buildPlan` asks for a `vacation_plan`, so `prepare_vacation.json`
  answers that schema too and matches the text buildPlan sends. Without it the
  workflow's own model step fails and the run honestly reports
  `partially_completed` — which is the behaviour, not a harness bug.
