import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

function callback(
  file: string,
  owner: string,
  name: string,
  env: Record<string, unknown>,
) {
  const ast = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const component = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === owner,
  ) as ts.FunctionDeclaration;
  const handler = component.body?.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (!handler) throw new Error(`Missing ${owner}.${name}`);
  const js = ts.transpileModule(
    `function factory(env:any) {const {${Object.keys(env).join(",")}}=env;${handler.getText(ast)};return ${name};}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return new Function(`${js};return factory;`)()(env) as (
    arg: unknown,
  ) => Promise<void>;
}
const cases = [
  ["components/finance/bills-view.tsx", "BillModal", "submit", "setSaving"],
  [
    "components/modules/billing-module.tsx",
    "AddBillModal",
    "submit",
    "setSaving",
  ],
  [
    "components/dashboard/calendar-sync-panel.tsx",
    "CalendarSyncWorkspace",
    "add",
    "setAdding",
  ],
  [
    "components/dashboard/calendar-sync-panel.tsx",
    "CalendarSyncWorkspace",
    "sync",
    "setSyncing",
  ],
] as const;
for (const [file, owner, handler, pending] of cases)
  describe(`${owner}.${handler}`, () => {
    function setup(work: Promise<unknown>) {
      const instance = { current: true };
      const env = {
        alive: { current: true },
        instance,
        isCurrent: () => instance.current,
        inFlight: { current: false },
        syncRequest: { current: 0 },
        setSaving: vi.fn(),
        setAdding: vi.fn(),
        setSyncing: vi.fn(),
        toastError: vi.fn(),
        success: vi.fn(),
        onClose: vi.fn(),
        onDone: vi.fn(),
        reset: vi.fn(),
        closeModal: vi.fn(),
        t: (key: string) => key,
        tr: (key: string) => key,
        familyId: "family",
        userId: "user",
        name: "Synthetic",
        amount: "10",
        dueDate: "2026-10-15",
        isRecurring: false,
        recurrence: "monthly",
        anchorDay: "",
        category: "Other",
        needsDay: false,
        v: {
          name: "Synthetic",
          amount: "10",
          due_date: "2026-10-15",
          is_recurring: false,
          autopay: false,
          recurrence: null,
          category: "Other",
        },
        url: "https://synthetic.invalid/feed",
        writeBillPatch: () => work,
        addCalendarFeed: () => work,
        syncCalendarFeed: () => work,
        createClient: () => ({}),
        isMissingBillDueDay: () => false,
        describeDbError: () => "db-error",
        feedAddedMessage: () => "feed-added",
      };
      return {
        env,
        run: callback(file, owner, handler, env),
        arg: handler === "sync" ? { id: "feed" } : { preventDefault: vi.fn() },
      };
    }
    it("reports a rejected promise and releases pending without success", async () => {
      const b = setup(Promise.reject(new Error("synthetic rejection")));
      await b.run(b.arg);
      expect(b.env.toastError).toHaveBeenCalledWith(
        "errors.thatChangeWasNotSaved",
      );
      expect(b.env[pending].mock.calls).toEqual([
        [handler === "sync" ? "feed" : true],
        [handler === "sync" ? null : false],
      ]);
      expect(b.env.success).not.toHaveBeenCalled();
      expect(b.env.onClose).not.toHaveBeenCalled();
    });
    it("ignores a late rejection after the owner unmounts", async () => {
      let reject!: (error: Error) => void;
      const b = setup(
        new Promise((_, fail) => {
          reject = fail;
        }),
      );
      const running = b.run(b.arg);
      b.env.alive.current = false;
      reject(new Error("late synthetic rejection"));
      await running;
      expect(b.env.toastError).not.toHaveBeenCalled();
      expect(b.env[pending]).toHaveBeenCalledTimes(1);
      expect(b.env.success).not.toHaveBeenCalled();
    });
    it("ignores a late success after the owner unmounts", async () => {
      let resolve!: (value: unknown) => void;
      const b = setup(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const running = b.run(b.arg);
      b.env.alive.current = false;
      resolve(
        handler === "submit" ? { error: null } : { ok: true, imported: 2 },
      );
      await running;
      expect(b.env.success).not.toHaveBeenCalled();
      expect(b.env.onClose).not.toHaveBeenCalled();
      expect(b.env.closeModal).not.toHaveBeenCalled();
      expect(b.env[pending]).toHaveBeenCalledTimes(1);
    });
    if (handler === "submit")
      it("ignores a retired instance before passive unmount cleanup", async () => {
        let resolve!: (value: unknown) => void;
        const b = setup(new Promise((done) => { resolve = done; }));
        const running = b.run(b.arg);
        b.env.instance.current = false;
        expect(b.env.alive.current).toBe(true);
        resolve({ error: null }); await running;
        expect(b.env.success).not.toHaveBeenCalled();
        expect(b.env.toastError).not.toHaveBeenCalled();
        expect(b.env.onClose).not.toHaveBeenCalled();
        expect(b.env.onDone).not.toHaveBeenCalled();
        expect(b.env[pending]).toHaveBeenCalledTimes(1);
        expect(b.env.inFlight.current).toBe(false);
      });
    it("preserves success and cleanup for a current owner", async () => {
      const b = setup(
        Promise.resolve(
          handler === "submit" ? { error: null } : { ok: true, imported: 2 },
        ),
      );
      await b.run(b.arg);
      expect(b.env.success).toHaveBeenCalledOnce();
      expect(b.env.toastError).not.toHaveBeenCalled();
      expect(b.env[pending]).toHaveBeenLastCalledWith(
        handler === "sync" ? null : false,
      );
    });
    if (handler === "sync")
      it("does not clear a newer sync request when the old one rejects", async () => {
        let reject!: (error: Error) => void;
        const b = setup(
          new Promise((_, fail) => {
            reject = fail;
          }),
        );
        const running = b.run(b.arg);
        b.env.syncRequest.current++;
        reject(new Error("old sync"));
        await running;
        expect(b.env.toastError).not.toHaveBeenCalled();
        expect(b.env.setSyncing.mock.calls).toEqual([["feed"]]);
      });
  });
