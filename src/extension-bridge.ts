import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";
import type { CommandPage } from "./content-command.ts";
import { NetworkError, StorageError, UserError, remoteFailure } from "./user-errors.ts";

const Envelope = Schema.Struct({
  type: Schema.String,
  requestId: Schema.String,
  error: Schema.optional(Schema.String),
  response: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const FetchSuccess = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.optional(Schema.Unknown),
});

/** Safe bridge diagnostics; payloads and remote error text are never logged. */
export interface BridgeLogger {
  debug(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
  warn(message: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

function makeExtensionBridge(page: CommandPage, log: BridgeLogger, createRequestId: () => string) {
  const request = Effect.fn("ExtensionBridge.request")(function* (
    type: string,
    responseType: string,
    data:
      | { readonly url: string; readonly responseType: "json" | "text" }
      | { readonly keys: unknown },
    timeoutMs: number,
    storage: boolean,
  ) {
    const requestId = yield* Effect.sync(createRequestId);
    yield* Effect.sync(() => log.debug("Sending request", { type, requestId }));
    const response = yield* Deferred.make<typeof Envelope.Type>();

    const listener = (event: MessageEvent) => {
      if (event.source !== page || event.origin !== page.location.origin) return;

      const input: unknown = event.data;
      const reply = Schema.decodeUnknownOption(Envelope)(input);

      if (
        Option.isSome(reply) &&
        reply.value.type === responseType &&
        reply.value.requestId === requestId
      ) {
        Deferred.doneUnsafe(response, Effect.succeed(reply.value));
      }
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => page.addEventListener("message", listener)),
      () => Effect.sync(() => page.removeEventListener("message", listener)),
    );
    yield* Effect.sync(() => page.postMessage({ type, requestId, ...data }, page.location.origin));

    const message = yield* Deferred.await(response).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => log.warn("Request timed out", { type, requestId, timeoutMs }));

            return yield* storage
              ? new StorageError({ operation: "read" })
              : new NetworkError({ reason: "timeout" });
          }),
      }),
    );

    const success = Schema.decodeUnknownOption(FetchSuccess)(message.response);
    yield* Effect.sync(() =>
      log.debug("Extension response", {
        type,
        requestId,
        success: !message.error && (storage || Option.isSome(success)),
      }),
    );

    if (message.error) {
      return yield* storage
        ? new StorageError({ operation: "read" })
        : new NetworkError({ reason: "unavailable" });
    }

    return message;
  }, Effect.scoped);

  const fetchResource = Effect.fn("ExtensionBridge.fetchResource")(function* (
    url: string,
    responseType: "json" | "text" = "json",
  ) {
    const message = yield* request(
      "ZALICZGMINE_FETCH_REQUEST",
      "ZALICZGMINE_FETCH_RESPONSE",
      { url, responseType },
      30000,
      false,
    );

    const success = Schema.decodeUnknownOption(FetchSuccess)(message.response);

    if (Option.isSome(success)) return success.value.data;

    const failure = remoteFailure(message.response);
    const expected = Schema.decodeUnknownOption(UserError)(failure);

    return yield* Option.isSome(expected) ? Effect.fail(expected.value) : Effect.die(failure);
  });

  const getStorage = Effect.fn("ExtensionBridge.getStorage")(function* <Keys>(keys: Keys) {
    const message = yield* request(
      "ZALICZGMINE_STORAGE_GET",
      "ZALICZGMINE_STORAGE_RESPONSE",
      { keys },
      5000,
      true,
    );

    return message.data ?? {};
  });

  return { fetchResource, getStorage };
}

/** Page requests with scoped listeners and bounded waits; malformed or unrelated envelopes are ignored. */
export class ExtensionBridge extends Context.Service<
  ExtensionBridge,
  ReturnType<typeof makeExtensionBridge>
>()("ExtensionBridge") {}

/** Installs page capabilities without registering listeners or sending messages. */
export function extensionBridgeLayer(
  page: CommandPage,
  log: BridgeLogger,
  createRequestId: () => string,
) {
  return Layer.effect(
    ExtensionBridge,
    Effect.sync(() => makeExtensionBridge(page, log, createRequestId)),
  );
}
