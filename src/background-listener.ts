import { Effect, FiberSet, Option, Schema } from "effect";
import { ChromeRuntime } from "./chrome-runtime.ts";
import { FetchRequest, handleFetch, type FetchTransport } from "./fetch-resource.ts";
import { apiFailure, failureReply } from "./user-errors.ts";

const FetchMessage = Schema.Struct({ type: FetchRequest.fields.type });

/** Owns the background listener and request fibers; closing its scope interrupts requests. */
export const backgroundLifetime = Effect.fn("Background.lifetime")(function* (
  transport: FetchTransport,
) {
  const runtime = yield* ChromeRuntime;
  const runRequest = yield* FiberSet.makeRuntime();

  yield* runtime.listen((message, respond) => {
    if (Option.isNone(Schema.decodeUnknownOption(FetchMessage)(message))) return false;

    const request = Schema.decodeUnknownOption(FetchRequest)(message);

    if (Option.isNone(request)) {
      respond(failureReply(apiFailure("INVALID_REQUEST")));

      return false;
    }

    // Chrome needs a literal synchronous true, even though the request runs in Effect.
    runRequest(
      handleFetch(request.value, transport).pipe(
        Effect.catchDefect(() => Effect.succeed(failureReply(undefined))),
        Effect.tap((reply) => Effect.sync(() => respond(reply))),
      ),
    );

    return true;
  });

  return yield* Effect.never;
});
