import { Effect, Match, Schema } from "effect";

/** Existing runtime wire request. JSON stays unknown until an API-specific decoder handles it. */
export const FetchRequest = Schema.Struct({
  type: Schema.Literal("ZALICZGMINE_FETCH"),
  url: Schema.String,
  responseType: Schema.optionalKey(Schema.Literals(["json", "text"])),
});

/** Parsed runtime request; omitted responseType means JSON, matching the original protocol. */
export interface FetchRequest extends Schema.Schema.Type<typeof FetchRequest> {}

/** Expected transport failure. Only message/code/http are projected onto the runtime wire. */
export class FetchError extends Schema.TaggedError<FetchError>()("FetchError", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.String),
  http: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const ProviderError = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
});

interface FetchFailureReply {
  success: false;
  error: string;
  code?: string;
  http?: number;
}

/** Wire response consumed by the content-script and popup. Never serialize causes. */
export type FetchReply =
  | { readonly success: true; readonly data: unknown }
  | Readonly<FetchFailureReply>;

/** Browser transport seam. Effect supplies the signal and aborts on interruption or timeout. */
export type FetchTransport = (url: string, signal: AbortSignal) => Promise<Response>;

/** Executes a browser HTTP request without retries; propagates typed HTTP/network/body failures. */
export const fetchResource = Effect.fn("Background.fetchResource")(function* (
  request: FetchRequest,
  transport: FetchTransport,
) {
  const signal = yield* Effect.abortSignal;

  const response = yield* Effect.tryPromise({
    try: () => transport(request.url, signal),
    catch: (cause) => new FetchError({ message: "Could not fetch data", cause }),
  });

  if (request.responseType === "text") {
    if (!response.ok)
      return yield* new FetchError({ message: `HTTP ${response.status}`, http: response.status });

    return yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new FetchError({ message: "Could not read response", cause }),
    });
  }

  const data: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      new FetchError({
        message: response.ok ? "Invalid API response" : `HTTP ${response.status}`,
        http: response.status,
        cause,
      }),
  });

  if (!response.ok) {
    const provider = yield* Schema.decodeUnknownEffect(ProviderError)(data).pipe(
      Effect.orElseSucceed((): Schema.Schema.Type<typeof ProviderError> => ({})),
    );

    return yield* new FetchError({
      ...provider,
      message: provider.message || `HTTP ${response.status}`,
      http: response.status,
    });
  }

  return data;
}, Effect.scoped);

/** Executes a parsed runtime request and projects expected failures onto the existing wire contract. */
export const handleFetch = Effect.fn("Background.handleFetch")(
  (request: FetchRequest, transport: FetchTransport) =>
    fetchResource(request, transport).pipe(
      Effect.timeout("30 seconds"),
      Effect.match({
        onSuccess: (data): FetchReply => ({ success: true, data }),
        onFailure: (error): FetchReply =>
          Match.value(error).pipe(
            Match.tag("TimeoutError", (): FetchReply => ({ success: false, error: "Timeout" })),
            Match.tag("FetchError", (failure): FetchReply => {
              const reply: FetchFailureReply = {
                success: false,
                error: failure.message,
              };

              if (failure.code !== undefined) reply.code = failure.code;

              if (failure.http !== undefined) reply.http = failure.http;

              return reply;
            }),
            Match.exhaustive,
          ),
      }),
    ),
);
