import { Effect, Schedule, Schema } from "effect";

/** Readiness did not arrive within the bounded discovery policy. */
export class MapReadinessError extends Schema.TaggedError<MapReadinessError>()(
  "MapReadinessError",
  { stage: Schema.Literals(["discovery", "style"]) },
) {}

/** Polls an idempotent readiness probe, with a bounded, interruptible schedule. */
export const awaitMapReady = Effect.fn("MapLifetime.awaitReady")(function* <A>(
  probe: Effect.Effect<A | null>,
  stage: "discovery" | "style",
) {
  return yield* probe.pipe(
    Effect.flatMap((value) =>
      value === null ? Effect.fail(new MapReadinessError({ stage })) : Effect.succeed(value),
    ),
    Effect.retry(Schedule.spaced("500 millis").pipe(Schedule.upTo({ times: 119 }))),
  );
});
