import { Effect, Option, Result, Schema } from "effect";
import { UserError } from "./user-errors.ts";

/** Adapts legacy promise operations: expected failures are decoded, defects remain defects. */
export const startupStep = Effect.fn("MapStartup.step")(function* <A>(operation: () => Promise<A>) {
  return yield* Effect.tryPromise({
    try: operation,
    catch: (cause) => {
      const parsed = Schema.decodeUnknownOption(UserError)(cause);

      if (Option.isSome(parsed)) return parsed.value;

      throw cause;
    },
  });
});

/** Loads independent startup data without discarding either successful result. */
export const loadInitialMap = Effect.fn("MapStartup.loadInitialMap")(function* <
  Visited,
  Boundaries,
>(visited: Effect.Effect<Visited, UserError>, boundaries: Effect.Effect<Boundaries, UserError>) {
  const visitedResult = yield* Effect.result(visited);
  const boundariesResult = yield* Effect.result(boundaries);

  if (Result.isSuccess(visitedResult) && Result.isSuccess(boundariesResult)) {
    return { status: "success" as const, visited: visitedResult, boundaries: boundariesResult };
  }

  if (Result.isFailure(visitedResult) && Result.isFailure(boundariesResult)) {
    return { status: "failure" as const, visited: visitedResult, boundaries: boundariesResult };
  }

  return { status: "partial" as const, visited: visitedResult, boundaries: boundariesResult };
});
