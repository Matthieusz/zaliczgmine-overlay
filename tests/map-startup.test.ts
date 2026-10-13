import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { loadInitialMap, startupStep } from "../src/map-startup.ts";
import { AccountError, NetworkError } from "../src/user-errors.ts";

for (const visitedAvailable of [true, false]) {
  for (const boundariesAvailable of [true, false]) {
    test(`startup: visited=${visitedAvailable}, boundaries=${boundariesAvailable}`, async () => {
      const outcome = await Effect.runPromise(
        loadInitialMap(
          visitedAvailable
            ? Effect.succeed(new Set(["1"]))
            : Effect.fail(new AccountError({ reason: "missing" })),
          boundariesAvailable
            ? Effect.succeed(["polygon"])
            : Effect.fail(new NetworkError({ reason: "unavailable" })),
        ),
      );

      expect(outcome.status).toBe(
        visitedAvailable && boundariesAvailable
          ? "success"
          : visitedAvailable || boundariesAvailable
            ? "partial"
            : "failure",
      );
      expect(Result.isSuccess(outcome.visited)).toBe(visitedAvailable);
      expect(Result.isSuccess(outcome.boundaries)).toBe(boundariesAvailable);

      if (Result.isSuccess(outcome.visited))
        expect(outcome.visited.success).toEqual(new Set(["1"]));

      if (Result.isSuccess(outcome.boundaries))
        expect(outcome.boundaries.success).toEqual(["polygon"]);
    });
  }
}

test("legacy startup adapter preserves expected errors and does not recover defects", async () => {
  const error = new NetworkError({ reason: "timeout" });
  const result = await Effect.runPromise(Effect.result(startupStep(() => Promise.reject(error))));
  expect(Result.isFailure(result)).toBe(true);
  await expect(
    Effect.runPromise(startupStep(() => Promise.reject(new Error("defect")))),
  ).rejects.toThrow();
});
