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
| `as` | who is asking — `parent` (the default), `adult`, `teen`, `child` |
| `expectNoToolCalls` | tools that must not reach the `ai_tool_calls` ledger |
| `expectError` | for a `refused` outcome: the sentence the person is given back |

`outcome` may also be `refused`: nothing was planned and `submitRequest`
answers with an error. That is not a harness failure — it is what a teen
asking about the family's money is supposed to get, and `expectError` pins the
wording so the refusal stays one a person can act on.

## What makes a prohibition real

Two rules, both enforced by ratchets in `../runner.test.ts`:

1. **Every name must resolve in the registry.** For a while nine of ten
   scenarios forbade `finances.createTransaction`, `finances.transfer`,
   `documents.share` and `tasks.deleteTodo` — none of which exist. The
   validator drops off-catalogue steps before the plan is persisted, so those
   assertions could never fail. `getTool` now has to find every name.
2. **Every scenario must forbid at least one tool that WRITES.** A prohibition
   on a read (`documents.readDocument`) is a real privacy assertion and worth
   keeping, but the safety half exists for the thing a family would find in
   the morning.
3. **Every scenario must forbid at least one tool its intent is offered.**
   The same trap one level up: `toolsForIntent` narrows the catalogue per
   intent, and a step naming a real tool outside it is dropped as
   `off_catalogue` before the plan is persisted — just like a tool that does
   not exist. A scenario whose prohibitions are all out-of-catalogue is only
   guarding `INTENT_TOOL_DOMAINS`. Guard that too (widening a catalogue is how
   the planner gets reach), but at least one prohibition has to be something
   the planner could have reached for and did not.

Prohibitions are checked on two surfaces, and neither replaces the other. The
**plan** must not contain the tool — that catches a planner or validator that
widens. The **`ai_tool_calls` ledger** must not contain it either — the gate
reserves that row only after deciding, so a row there means the tool really
ran, which catches a call made without a plan step naming it and is the only
way to prove a step parked for approval did not execute anyway.

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
