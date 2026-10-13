import { Context, Effect, Layer, Schema } from "effect";
import { NetworkError, apiFailure } from "./user-errors.ts";

const Command = Schema.Struct({
  action: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

const Tabs = Schema.Array(Schema.Struct({ id: Schema.optionalKey(Schema.Int) }));

/** Native tabs capability; callbacks are parsed inside the adapter, never trusted as domain data. */
export interface ChromeTabsApi {
  /** Queries the active tab in the current window; completion cannot be cancelled. */
  query(
    query: { readonly active: true; readonly currentWindow: true },
    callback: (tabs: typeof Tabs.Type) => void,
  ): void;
  /** Sends the existing action/data envelope; replies remain opaque to this transport. */
  sendMessage(
    id: number,
    message: typeof Command.Type,
    callback: <Reply>(reply: Reply) => void,
  ): void;
}

function makeChromeTabs(api: ChromeTabsApi, runtime: Pick<typeof chrome.runtime, "lastError">) {
  /** Sends a parsed command to the first active tab; missing tabs/API failures are NetworkError(unavailable). */
  const sendCommand = Effect.fn("ChromeTabs.sendCommand")(function* <Input>(input: Input) {
    const command = yield* Schema.decodeUnknownEffect(Command)(input).pipe(
      Effect.mapError(() => apiFailure("INVALID_REQUEST")),
    );

    const result = yield* Effect.callback<unknown, NetworkError>((resume) => {
      try {
        api.query({ active: true, currentWindow: true }, (tabs) => {
          // Consume callback-local lastError even if the requesting popup has closed.
          const error = runtime.lastError;
          resume(
            error ? Effect.fail(new NetworkError({ reason: "unavailable" })) : Effect.succeed(tabs),
          );
        });
      } catch {
        resume(Effect.fail(new NetworkError({ reason: "unavailable" })));
      }
    });

    const tabs = yield* Schema.decodeUnknownEffect(Tabs)(result).pipe(
      Effect.mapError(() => new NetworkError({ reason: "unavailable" })),
    );

    const id = tabs[0]?.id;

    if (id === undefined) return yield* new NetworkError({ reason: "unavailable" });

    return yield* Effect.callback<unknown, NetworkError>((resume) => {
      try {
        api.sendMessage(id, command, (reply) => {
          const error = runtime.lastError;
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

  return { sendCommand };
}

/** Popup command transport; interruption stops consumers, not messages already submitted to Chrome. */
export class ChromeTabs extends Context.Service<ChromeTabs, ReturnType<typeof makeChromeTabs>>()(
  "ChromeTabs",
) {}

/** Installs lazy tab messaging without querying tabs or sending commands during layer acquisition. */
export function chromeTabsLayer(
  api: ChromeTabsApi,
  runtime: Pick<typeof chrome.runtime, "lastError">,
) {
  return Layer.effect(
    ChromeTabs,
    Effect.sync(() => makeChromeTabs(api, runtime)),
  );
}
