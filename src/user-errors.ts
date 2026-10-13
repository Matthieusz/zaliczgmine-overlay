import { Match, Option, Schema } from "effect";

/** Request could not reach the API, read its body, or complete in time. */
export class NetworkError extends Schema.TaggedError<NetworkError>()("NetworkError", {
  reason: Schema.Literals(["unavailable", "timeout"]),
}) {}

/** API rejected a request. Provider text and payloads are never user-facing. */
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  reason: Schema.Literals(["invalidRequest", "unsupportedCountry", "userNotFound", "other"]),
  http: Schema.optionalKey(Schema.Int),
}) {}

/** Successful API response failed JSON or endpoint-specific schema decoding. */
export class InvalidApiData extends Schema.TaggedError<InvalidApiData>()("InvalidApiData", {}) {}

/** A workflow requires an account that is absent or has an invalid identifier. */
export class AccountError extends Schema.TaggedError<AccountError>()("AccountError", {
  reason: Schema.Literals(["missing", "invalid"]),
}) {}

/** Planner map is absent or its style is not ready for an operation. */
export class MapNotReady extends Schema.TaggedError<MapNotReady>()("MapNotReady", {}) {}

/** GPX input is empty, malformed, or contains no usable route/track. */
export class InvalidGpx extends Schema.TaggedError<InvalidGpx>()("InvalidGpx", {
  reason: Schema.Literals(["empty", "malformed", "noTrack"]),
}) {}

/** Browser storage failed to read, write, or remove extension settings/tracks. */
export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.Literals(["read", "write", "remove"]),
}) {}

/** Closed expected-failure vocabulary; defects and cancellation are not members. */
export const UserError = Schema.Union([
  NetworkError,
  ApiError,
  InvalidApiData,
  AccountError,
  MapNotReady,
  InvalidGpx,
  StorageError,
]);

/** Expected failures accepted by the safe presentation projection. */
export type UserError = typeof UserError.Type;

/** Allowlisted transport/presentation keys; unknown strings never reach the translator. */
export const ErrorMessageKey = Schema.Literals([
  "api.fetchError",
  "extension.noResponse",
  "api.invalidRequest",
  "api.unsupportedCountry",
  "api.userNotFound",
  "api.error",
  "api.invalidResponse",
  "account.selectInExtension",
  "account.invalidId",
  "map.connectionError",
  "gpx.noTrack",
  "gpx.invalidFile",
  "storage.error",
  "extension.unexpectedError",
  "extension.unsupportedPage",
  "extension.unknownAction",
]);

/** Safe key decoded at a message boundary. */
export function remoteErrorMessageKey<Input>(input: Input) {
  return Option.getOrElse(
    Schema.decodeUnknownOption(ErrorMessageKey)(input),
    () => "extension.unexpectedError",
  );
}

/** UI entry-boundary projection; unknown exceptions remain defects, not expected errors. */
export function failureReply<Input>(input: Input) {
  const parsed = Schema.decodeUnknownOption(UserError)(input);

  if (Option.isNone(parsed)) return { success: false as const, error: "extension.unexpectedError" };

  return {
    success: false as const,
    error: userErrorMessageKey(parsed.value),
    failure: Schema.encodeSync(UserError)(parsed.value),
  };
}

/** Reconstructs only decoded expected failures; a remote defect stays an ordinary exception. */
export function remoteFailure<Input>(input: Input) {
  const reply = Schema.decodeUnknownOption(Schema.Struct({ failure: UserError }))(input);

  return Option.isSome(reply) ? reply.value.failure : new Error("Remote operation failed");
}

/** Maps allowlisted provider codes without retaining arbitrary text or codes. */
export function apiFailure<Code>(code: Code, http?: number) {
  const parsed = Schema.decodeUnknownOption(
    Schema.Literals(["INVALID_REQUEST", "INVALID_COUNTRY", "USER_NOT_FOUND"]),
  )(code);

  const reason = Option.isNone(parsed)
    ? "other"
    : Match.value(parsed.value).pipe(
        Match.when("INVALID_REQUEST", () => "invalidRequest" as const),
        Match.when("INVALID_COUNTRY", () => "unsupportedCountry" as const),
        Match.when("USER_NOT_FOUND", () => "userNotFound" as const),
        Match.exhaustive,
      );

  return new ApiError(http === undefined ? { reason } : { reason, http });
}

/** Returns only trusted localization keys, never exception or provider text. */
export function userErrorMessageKey(error: UserError) {
  return Match.value(error).pipe(
    Match.tag("NetworkError", ({ reason }) =>
      reason === "timeout" ? "extension.noResponse" : "api.fetchError",
    ),
    Match.tag("ApiError", ({ reason }) =>
      Match.value(reason).pipe(
        Match.when("invalidRequest", () => "api.invalidRequest"),
        Match.when("unsupportedCountry", () => "api.unsupportedCountry"),
        Match.when("userNotFound", () => "api.userNotFound"),
        Match.when("other", () => "api.error"),
        Match.exhaustive,
      ),
    ),
    Match.tag("InvalidApiData", () => "api.invalidResponse"),
    Match.tag("AccountError", ({ reason }) =>
      reason === "missing" ? "account.selectInExtension" : "account.invalidId",
    ),
    Match.tag("MapNotReady", () => "map.connectionError"),
    Match.tag("InvalidGpx", ({ reason }) =>
      reason === "noTrack" ? "gpx.noTrack" : "gpx.invalidFile",
    ),
    Match.tag("StorageError", () => "storage.error"),
    Match.exhaustive,
  );
}
