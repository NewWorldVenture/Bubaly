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
