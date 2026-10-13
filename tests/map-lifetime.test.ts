import { expect, test } from "bun:test";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { awaitMapReady } from "../src/map-lifetime.ts";

test("readiness returns the discovered map", async () => {
  const map = { id: "map" };
  expect(await Effect.runPromise(awaitMapReady(Effect.succeed(map), "discovery"))).toBe(map);
});

test("style readiness fails after bounded retries", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* awaitMapReady(Effect.succeed(null), "style").pipe(
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("60 seconds");
      const result = yield* Fiber.join(fiber);
      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) expect(result.failure.stage).toBe("style");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
