import { expect, test } from "bun:test";
import { Effect } from "effect";
import { restoreGpx } from "../src/restore-gpx.ts";
import { InvalidGpx } from "../src/user-errors.ts";

test("restoration retains valid tracks around malformed records and invalid GPX", async () => {
  const restored: string[] = [];

  const outcome = await Effect.runPromise(
    restoreGpx(
      [{ text: "first" }, null, { text: 42 }, { text: "bad" }, { text: "last" }],
      (text) => {
        if (text === "bad") throw new InvalidGpx({ reason: "malformed" });
        restored.push(text);
      },
    ),
  );

  expect(restored).toEqual(["first", "last"]);
  expect(outcome.skipped).toBe(3);
});

test("absent saved tracks remain an empty restoration", async () => {
  const outcome = await Effect.runPromise(
    restoreGpx(undefined, () => {
      throw new Error("must not restore");
    }),
  );

  expect(outcome.skipped).toBe(0);
});

test("unexpected parser defects stop restoration instead of being skipped", async () => {
  const restored: string[] = [];
  await expect(
    Effect.runPromise(
      restoreGpx([{ text: "defect" }, { text: "later" }], (text) => {
        restored.push(text);
        throw new Error("parser defect");
      }),
    ),
  ).rejects.toThrow("parser defect");
  expect(restored).toEqual(["defect"]);
});
