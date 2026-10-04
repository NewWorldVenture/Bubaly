import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

const migration = readFileSync('supabase/migrations/0475_meal_plan_slot_writes_are_atomic.sql', 'utf8');
const probe = readFileSync('docs/audit/listing-status-machine-check.sql', 'utf8');
const expectedFunctionSha256 = '1bbe55de480b5da025755f4a3e41bfba1a89d784c50329d6b63594641e1adb5f';
const exactReplayBranch = compact(`
  if v_claimed = 0 then
    select * into v_receipt from public.meal_plan_write_receipts
      where family_id = p_family_id and actor_id = v_actor and request_id = p_request_id;
    if not found or v_receipt.operation <> 'replace' or v_receipt.payload_hash <> v_hash or v_receipt.result is null then
      raise exception 'Meal-plan request ID was already used for a different or incomplete request' using errcode = '22023';
    end if;
    return jsonb_set(v_receipt.result, '{replayed}', 'true'::jsonb, true);
  end if;
`);

function compact(source: string) {
  return source.replace(/--[^\n]*/g, '').replace(/[\s]+/g, '').toLowerCase();
}

function functionSha256(source: string) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function replayBranch(source: string) {
  const start = source.indexOf('ifv_claimed=0then');
  const returnToken = "returnjsonb_set(v_receipt.result,'{replayed}','true'::jsonb,true);";
  const returnAt = source.indexOf(returnToken, start);
  const endAt = source.indexOf('endif;', returnAt + returnToken.length);
  if (start < 0 || returnAt < 0 || endAt < 0) return '';
  return source.slice(start, endAt + 'endif;'.length);
}

describe('meal-plan replay exception in the listing status probe', () => {
  it('accepts only the exact receipt-read, validation, and return branch', () => {
    const functionSql = migration.match(
      /create or replace function public\.meal_plan_replace_slots\([\s\S]*?\n\$\$;/i,
    )?.[0];
    const body = functionSql?.match(/\bas\s+\$\$([\s\S]*?)\$\$;/i)?.[1];
    const expected = probe.match(/meal_replace_replay_expected\s*:=\s*\$meal_replay\$([\s\S]*?)\$meal_replay\$/i)?.[1];

    expect(body).toBeTruthy();
    expect(expected).toBeTruthy();
    expect(functionSha256(body!)).toBe(expectedFunctionSha256);
    expect(probe).toMatch(
      /encode\(sha256\(convert_to\(meal_replace_raw_src,\s*'UTF8'\)\),\s*'hex'\)\s*=\s*'1bbe55de480b5da025755f4a3e41bfba1a89d784c50329d6b63594641e1adb5f'/i,
    );
    const liveBranch = replayBranch(compact(body!));
    const whitelistedBranch = compact(expected!);
    const compactFunction = compact(body!);
    const replayWhere = 'wherefamily_id=p_family_idandactor_id=v_actorandrequest_id=p_request_id';
    const receiptUpdate = 'updatepublic.meal_plan_write_receiptssetresult=v_result';
    const scopedReceiptUpdate = `${receiptUpdate}${replayWhere};`;

    expect(whitelistedBranch).toBe(exactReplayBranch);
    expect(liveBranch).toBe(whitelistedBranch);
    expect(probe).toMatch(/meal_replace_replay_branch\s*=\s*meal_replace_replay_expected/i);
    const receiptUpdateAt = at(compactFunction, receiptUpdate);
    expect(at(compactFunction, replayWhere)).toBeLessThan(receiptUpdateAt);
    expect(at(compactFunction.slice(receiptUpdateAt), replayWhere)).toBeGreaterThan(0);
    expect(probe).toContain(`position('${scopedReceiptUpdate}' in meal_replace_compact) > 0`);
    expect(compactFunction).toContain(scopedReceiptUpdate);

    const wrongRequestPredicate = compactFunction.replace(
      scopedReceiptUpdate,
      `${receiptUpdate}wherefamily_id=p_family_idandactor_id=v_actorandrequest_id=p_other_request_id;`,
    );
    expect(wrongRequestPredicate).not.toContain(scopedReceiptUpdate);

    const returnToken = "returnjsonb_set(v_receipt.result,'{replayed}','true'::jsonb,true);";
    for (const injectedCall of ['v_result:=public.some_mutator();', 'v_result:=some_mutator();']) {
      const mutatedBranch = replayBranch(compact(body!).replace(returnToken, `${injectedCall}${returnToken}`));
      expect(mutatedBranch).not.toBe(whitelistedBranch);
    }

    const claimMarker = '  insert into public.meal_plan_write_receipts';
    expect(body).toContain(claimMarker);
    for (const injectedStatement of ['perform some_mutator(p_family_id);', 'call some_mutator(p_family_id);']) {
      const mutatedBody = body!.replace(claimMarker, `  ${injectedStatement}\n${claimMarker}`);
      expect(functionSha256(mutatedBody)).not.toBe(expectedFunctionSha256);
    }

    for (const [original, replacement] of [
      ["'meal-plan-slot:'", "'MEAL-PLAN-SLOT:'"],
      ["'meal-plan-slot:'", "'meal-plan- slot:'"],
    ] as const) {
      expect(body).toContain(original);
      expect(functionSha256(body!.replace(original, replacement))).not.toBe(expectedFunctionSha256);
    }
  });
});
