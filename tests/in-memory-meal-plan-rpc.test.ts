import { describe, expect, it } from "vitest";
import { createInMemorySupabase } from "./helpers/in-memory-supabase";

const FAMILY = "family-one";
const OTHER = "family-two";
const ACTOR = "parent-user";

function fixture(role: string = "parent", isActive = true) {
  const db = createInMemorySupabase({ userId: ACTOR });
  db.seed("family_members", [
    {
      id: "parent",
      family_id: FAMILY,
      user_id: ACTOR,
      role,
      is_active: isActive,
    },
  ]);
  db.seed("meals", [
    { id: "meal-new", family_id: FAMILY, name: "New meal" },
    { id: "meal-private", family_id: OTHER, name: "Private meal" },
  ]);
  db.seed("meal_plans", [
    {
      id: "replace-this",
      family_id: FAMILY,
      meal_id: "meal-new",
      plan_date: "2026-09-07",
      meal_type: "dinner",
    },
    {
      id: "keep-this",
      family_id: FAMILY,
      meal_id: "meal-new",
      plan_date: "2026-09-08",
      meal_type: "lunch",
    },
    {
      id: "other-family",
      family_id: OTHER,
      meal_id: "meal-private",
      plan_date: "2026-09-07",
      meal_type: "dinner",
    },
  ]);
  return db;
}

const replace = (overrides: Record<string, unknown> = {}) => ({
  p_family_id: FAMILY,
  p_request_id: "replace-request",
  p_entries: [
    { meal_id: "meal-new", plan_date: "2026-09-07", meal_type: "dinner" },
  ],
  ...overrides,
});

describe("in-memory meal-plan RPC contract (synthetic fixture, not SQL/RLS proof)", () => {
  it("replaces only requested slots in the requested family and replays once", async () => {
    const db = fixture();
    const args = replace();
    const first = await db.rpc("meal_plan_replace_slots", args);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({
      replaced: 1,
      replayed: false,
      planned: [
        expect.objectContaining({
          family_id: FAMILY,
          meal_id: "meal-new",
          plan_date: "2026-09-07",
          meal_type: "dinner",
          created_by: ACTOR,
        }),
      ],
    });
    expect(db.table("meal_plans").map((row) => row.id)).toEqual(
      expect.arrayContaining(["keep-this", "other-family"]),
    );
    expect(
      db
        .table("meal_plans")
        .filter(
          (row) =>
            row.family_id === FAMILY &&
            row.plan_date === "2026-09-07" &&
            row.meal_type === "dinner",
        ),
    ).toHaveLength(1);

    const replay = await db.rpc("meal_plan_replace_slots", args);
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ replayed: true, replaced: 1 });
    expect(
      db
        .table("meal_plans")
        .filter(
          (row) =>
            row.family_id === FAMILY &&
            row.plan_date === "2026-09-07" &&
            row.meal_type === "dinner",
        ),
    ).toHaveLength(1);
  });

  it("rejects changed payloads on the same actor-scoped request key without writing again", async () => {
    const db = fixture();
    expect(
      (await db.rpc("meal_plan_replace_slots", replace())).error,
    ).toBeNull();
    const before = structuredClone(db.table("meal_plans"));
    const changed = await db.rpc(
      "meal_plan_replace_slots",
      replace({
        p_entries: [
          { meal_id: "meal-new", plan_date: "2026-09-08", meal_type: "lunch" },
        ],
      }),
    );
    expect(changed.data).toBeNull();
    expect(changed.error).toMatchObject({ code: "P0001" });
    expect(db.table("meal_plans")).toEqual(before);
  });

  it.each([
    ["foreign family", { p_family_id: OTHER }],
    [
      "foreign meal",
      {
        p_entries: [
          {
            meal_id: "meal-private",
            plan_date: "2026-09-07",
            meal_type: "dinner",
          },
        ],
      },
    ],
    [
      "impossible date",
      {
        p_entries: [
          { meal_id: "meal-new", plan_date: "2026-02-30", meal_type: "dinner" },
        ],
      },
    ],
    [
      "unsupported meal type",
      {
        p_entries: [
          { meal_id: "meal-new", plan_date: "2026-09-07", meal_type: "brunch" },
        ],
      },
    ],
  ])("rejects %s before changing any rows", async (_label, overrides) => {
    const db = fixture();
    const before = structuredClone(db.table("meal_plans"));
    const result = await db.rpc("meal_plan_replace_slots", replace(overrides));
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
    expect(db.table("meal_plans")).toEqual(before);
  });

  it.each([
    ["inactive member", fixture("parent", false)],
    ["guest", fixture("guest")],
  ])("rejects writes from an %s", async (_label, db) => {
    const before = structuredClone(db.table("meal_plans"));
    expect(
      (await db.rpc("meal_plan_replace_slots", replace())).data,
    ).toBeNull();
    expect(db.table("meal_plans")).toEqual(before);
  });

  it("removes only the requested family row and returns a complete replayable receipt", async () => {
    const db = fixture();
    const args = {
      p_family_id: FAMILY,
      p_request_id: "remove-request",
      p_plan_id: "replace-this",
    };
    const first = await db.rpc("meal_plan_remove_slot", args);
    expect(first.error).toBeNull();
    expect(first.data).toEqual({
      id: "replace-this",
      plan_date: "2026-09-07",
      meal_type: "dinner",
      replayed: false,
    });
    expect(db.table("meal_plans").map((row) => row.id)).toEqual(
      expect.arrayContaining(["keep-this", "other-family"]),
    );
    const replay = await db.rpc("meal_plan_remove_slot", args);
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual({
      id: "replace-this",
      plan_date: "2026-09-07",
      meal_type: "dinner",
      replayed: true,
    });

    const before = structuredClone(db.table("meal_plans"));
    const foreign = await db.rpc("meal_plan_remove_slot", {
      ...args,
      p_request_id: "remove-foreign",
      p_plan_id: "other-family",
    });
    expect(foreign.data).toBeNull();
    expect(foreign.error).not.toBeNull();
    expect(db.table("meal_plans")).toEqual(before);
  });

  it("models service-role continuation with an explicit delegated active actor and shared receipts", async () => {
    const db = fixture();
    const service = db.asRole("service_role");
    expect((await service.auth.getUser()).data.user).toBeNull();
    const args = { ...replace(), p_actor_id: ACTOR };
    expect(
      (await service.rpc("meal_plan_replace_slots_for_actor", args)).data,
    ).toMatchObject({ replayed: false });
    expect(
      (await service.rpc("meal_plan_replace_slots_for_actor", args)).data,
    ).toMatchObject({ replayed: true });
    expect(
      db
        .table("meal_plans")
        .filter(
          (row) => row.family_id === FAMILY && row.plan_date === "2026-09-07",
        ),
    ).toHaveLength(1);
  });

  it("keeps authenticated and service-role RPC grants distinct and checks delegated membership", async () => {
    const authenticated = fixture();
    const service = authenticated.asRole("service_role");
    const before = structuredClone(authenticated.table("meal_plans"));

    expect(
      (await service.rpc("meal_plan_replace_slots", replace())).error,
    ).not.toBeNull();
    expect(
      (
        await authenticated.rpc("meal_plan_replace_slots_for_actor", {
          ...replace(),
          p_actor_id: ACTOR,
        })
      ).error,
    ).not.toBeNull();
    expect(
      (await service.rpc("meal_plan_replace_slots_for_actor", replace())).error,
    ).not.toBeNull();
    expect(
      (
        await service.rpc("meal_plan_replace_slots_for_actor", {
          ...replace(),
          p_actor_id: "foreign-user",
        })
      ).error,
    ).not.toBeNull();
    expect(authenticated.table("meal_plans")).toEqual(before);

    for (const db of [fixture("guest"), fixture("parent", false)]) {
      const serviceClient = db.asRole("service_role");
      expect(
        (
          await serviceClient.rpc("meal_plan_replace_slots_for_actor", {
            ...replace(),
            p_actor_id: ACTOR,
          })
        ).error,
      ).not.toBeNull();
    }

    for (const rpc of [
      "meal_plan_replace_slots_internal",
      "meal_plan_remove_slot_internal",
    ]) {
      expect((await authenticated.rpc(rpc, {})).error).toMatchObject({
        code: "42501",
      });
      expect((await service.rpc(rpc, {})).error).toMatchObject({
        code: "42501",
      });
    }
  });
});
