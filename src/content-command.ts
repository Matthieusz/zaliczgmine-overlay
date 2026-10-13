import { Deferred, Effect, Option, Schema } from "effect";
import { NetworkError, apiFailure } from "./user-errors.ts";

const Command = Schema.Struct({
  action: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
});

const CommandResponse = Schema.Struct({
  type: Schema.Literal("ZALICZGMINE_COMMAND_RESPONSE"),
  requestId: Schema.String,
  response: Schema.optional(Schema.Unknown),
});

/** Page messaging capability; same-window/origin filtering is enforced before response decoding. */
export interface CommandPage {
  readonly location: { readonly origin: string };
  /** Registers the response callback in the command's scope. */
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  /** Removes the exact acquired response callback. */
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  /** Sends the existing command envelope to this page's origin. */
  postMessage<Input>(input: Input, origin: string): void;
}

/** Awaits scripts and one correlated page reply; timeout/interruption removes the response listener. */
export const forwardCommand = Effect.fn("Content.forwardCommand")(
  function* <Input>(
    input: Input,
    scriptsReady: Effect.Effect<void>,
    page: CommandPage,
    requestId: string,
  ) {
    const command = yield* Schema.decodeUnknownEffect(Command)(input).pipe(
      Effect.mapError(() => apiFailure("INVALID_REQUEST")),
    );

    yield* scriptsReady;

    const response = yield* Deferred.make<unknown>();

    const listener = (event: MessageEvent) => {
      if (event.source !== page || event.origin !== page.location.origin) return;

      const input: unknown = event.data;
      const reply = Schema.decodeUnknownOption(CommandResponse)(input);

      if (Option.isSome(reply) && reply.value.requestId === requestId) {
        Deferred.doneUnsafe(response, Effect.succeed(reply.value.response));
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => page.addEventListener("message", listener)),
      () => Effect.sync(() => page.removeEventListener("message", listener)),
    );

    yield* Effect.sync(() =>
      page.postMessage(
        { type: "ZALICZGMINE_COMMAND", requestId, action: command.action, data: command.data },
        page.location.origin,
      ),
    );

    return yield* Deferred.await(response);
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new NetworkError({ reason: "timeout" })),
      }),
    ),
);
