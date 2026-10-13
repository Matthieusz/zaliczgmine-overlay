import { Effect, Option, Schema } from "effect";
import { ChromeRuntime } from "./chrome-runtime.ts";
import { UserError, remoteFailure } from "./user-errors.ts";

const Success = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.optional(Schema.Unknown),
});

/** Fetches JSON via the background; expected remote failures are decoded, unknown failures remain defects. */
export const fetchRuntimeJson = Effect.fn("Runtime.fetchJson")(function* (url: string) {
  const runtime = yield* ChromeRuntime;
  const reply = yield* runtime.sendFetch({ type: "ZALICZGMINE_FETCH", url, responseType: "json" });
  const success = Schema.decodeUnknownOption(Success)(reply);

  if (Option.isSome(success)) return success.value.data;

  const failure = remoteFailure(reply);
  const expected = Schema.decodeUnknownOption(UserError)(failure);

  return yield* Option.isSome(expected) ? Effect.fail(expected.value) : Effect.die(failure);
});
