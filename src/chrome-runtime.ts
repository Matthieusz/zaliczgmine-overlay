import { Context, Effect, Layer, Schema } from "effect";
import { FetchRequest } from "./fetch-resource.ts";
import { NetworkError, apiFailure } from "./user-errors.ts";

type NativeListener = (
  ...args: Parameters<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>
) => boolean;

/** Synchronous Chrome channel decision; each workflow parses its own incoming message. */
export type RuntimeMessageHandler = <Input>(
  input: Input,
  respond: <Reply>(reply: Reply) => void,
) => boolean;

/** Runtime capability used only at the adapter/composition root. */
export interface ChromeRuntimeApi {
  readonly lastError: chrome.runtime.LastError | undefined;
  /** Callback completion is not cancellable; lastError exists only inside the callback. */
  sendMessage(message: FetchRequest, callback: <Reply>(reply: Reply) => void): void;
  readonly onMessage: {
    /** Registers a synchronous listener, never a promise-returning listener. */
    addListener(listener: NativeListener): void;
    /** Removes the exact registered listener. */
    removeListener(listener: NativeListener): void;
  };
}

function makeChromeRuntime(api: ChromeRuntimeApi) {
  /** Parses a fetch request and sends it; replies stay opaque for their owning workflow. */
  const sendFetch = Effect.fn("ChromeRuntime.sendFetch")(function* <Input>(input: Input) {
    const request = yield* Schema.decodeUnknownEffect(FetchRequest)(input).pipe(
      Effect.mapError(() => apiFailure("INVALID_REQUEST")),
    );

    return yield* Effect.callback<unknown, NetworkError>((resume) => {
      try {
        api.sendMessage(request, (reply) => {
          // Consume even a late callback's lastError after the consumer is interrupted.
          const error = api.lastError;
          resume(
            error
              ? Effect.fail(new NetworkError({ reason: "unavailable" }))
              : Effect.succeed(reply),
          );
        });
      } catch {
        resume(Effect.fail(new NetworkError({ reason: "unavailable" })));
      }
    });
  });

  /** Acquires a scoped synchronous listener; the handler owns response/channel policy. */
  const listen = Effect.fn("ChromeRuntime.listen")((handler: RuntimeMessageHandler) => {
    const listener: NativeListener = (message, _sender, respond) => handler(message, respond);

    return Effect.acquireRelease(
      Effect.sync(() => api.onMessage.addListener(listener)),
      () => Effect.sync(() => api.onMessage.removeListener(listener)),
    );
  });

  return { sendFetch, listen };
}

/** Callback messaging and scoped listeners; no I/O occurs when the capability is installed. */
export class ChromeRuntime extends Context.Service<
  ChromeRuntime,
  ReturnType<typeof makeChromeRuntime>
>()("ChromeRuntime") {}

/** Installs the native runtime capability; interruption cannot retract a submitted Chrome message. */
export function chromeRuntimeLayer(api: ChromeRuntimeApi) {
  return Layer.effect(
    ChromeRuntime,
    Effect.sync(() => makeChromeRuntime(api)),
  );
}
