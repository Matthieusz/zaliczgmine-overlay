import { Effect, Schema } from "effect";
import { InvalidApiData, NetworkError, apiFailure, failureReply } from "./user-errors.ts";

/** Existing runtime request; endpoint adapters decode successful JSON. */
export const FetchRequest = Schema.Struct({
  type: Schema.Literal("ZALICZGMINE_FETCH"),
  url: Schema.String,
  responseType: Schema.optionalKey(Schema.Literals(["json", "text"])),
});

/** Parsed runtime request. */
export interface FetchRequest extends Schema.Schema.Type<typeof FetchRequest> {}

const ProviderError = Schema.Struct({ code: Schema.optionalKey(Schema.String) });

function networkFailure(cause: unknown) {
  if (cause instanceof TypeError) return new NetworkError({ reason: "unavailable" });

  throw cause;
}

/** Wire response contains safe keys and explicit expected-failure DTOs, never causes. */
export type FetchReply =
  | { readonly success: true; readonly data: unknown }
  | ReturnType<typeof failureReply>;

/** Browser transport seam; rejects with browser fetch errors, not application exceptions. */
export type FetchTransport = (url: string, signal: AbortSignal) => Promise<Response>;

/** Fetches without retries. Unexpected transport exceptions remain defects. */
export const fetchResource = Effect.fn("Background.fetchResource")(function* (
  request: FetchRequest,
  transport: FetchTransport,
) {
  const signal = yield* Effect.abortSignal;

  const response = yield* Effect.tryPromise({
    try: () => transport(request.url, signal),
    catch: networkFailure,
  });

  if (!response.ok) {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: networkFailure,
    }).pipe(Effect.mapError(() => apiFailure(undefined, response.status)));

    const provider = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderError))(
      text,
    ).pipe(Effect.orElseSucceed((): Schema.Schema.Type<typeof ProviderError> => ({})));

    return yield* apiFailure(provider.code, response.status);
  }

  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: networkFailure,
  });

  if (request.responseType === "text") return text;

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(() => new InvalidApiData({})),
  );
}, Effect.scoped);

/** Projects typed failures only; defects are handled at the runtime entry boundary. */
export const handleFetch = Effect.fn("Background.handleFetch")(
  (request: FetchRequest, transport: FetchTransport) =>
    fetchResource(request, transport).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", () => Effect.fail(new NetworkError({ reason: "timeout" }))),
      Effect.match({
        onSuccess: (data): FetchReply => ({ success: true, data }),
        onFailure: (error): FetchReply => failureReply(error),
      }),
    ),
);
