import { expect, test } from "bun:test";
import { Effect, Exit, Option, Schema } from "effect";
import {
  AccountError,
  ApiError,
  InvalidApiData,
  InvalidGpx,
  MapNotReady,
  NetworkError,
  StorageError,
  UserError,
  userErrorMessageKey,
  failureReply,
  remoteFailure,
} from "../src/user-errors.ts";
import "../i18n.js";

const cases = [
  [new NetworkError({ reason: "unavailable" }), "api.fetchError"],
  [new NetworkError({ reason: "timeout" }), "extension.noResponse"],
  [new ApiError({ reason: "invalidRequest" }), "api.invalidRequest"],
  [new ApiError({ reason: "unsupportedCountry" }), "api.unsupportedCountry"],
  [new ApiError({ reason: "userNotFound" }), "api.userNotFound"],
  [new ApiError({ reason: "other", http: 500 }), "api.error"],
  [new InvalidApiData({}), "api.invalidResponse"],
  [new AccountError({ reason: "missing" }), "account.selectInExtension"],
  [new AccountError({ reason: "invalid" }), "account.invalidId"],
  [new MapNotReady({}), "map.connectionError"],
  [new InvalidGpx({ reason: "empty" }), "gpx.invalidFile"],
  [new InvalidGpx({ reason: "malformed" }), "gpx.invalidFile"],
  [new InvalidGpx({ reason: "noTrack" }), "gpx.noTrack"],
  [new StorageError({ operation: "read" }), "storage.error"],
  [new StorageError({ operation: "write" }), "storage.error"],
  [new StorageError({ operation: "remove" }), "storage.error"],
] as const;

// Parse the legacy global rather than asserting its runtime shape.
const i18n = Schema.decodeUnknownSync(
  Schema.Struct({
    ZaliczGmineI18n: Schema.Struct({
      messages: Schema.Struct({
        en: Schema.Record(Schema.String, Schema.String),
        pl: Schema.Record(Schema.String, Schema.String),
      }),
    }),
  }),
)(globalThis).ZaliczGmineI18n;

test("every expected variant maps to a translated safe key", () => {
  for (const [error, key] of cases) {
    expect(userErrorMessageKey(error)).toBe(key);
    expect(i18n.messages.en[key]).toBeDefined();
    expect(i18n.messages.pl[key]).toBeDefined();
    expect(Schema.decodeSync(UserError)(error)._tag).toBe(error._tag);
    expect(failureReply(remoteFailure(failureReply(error)))).toEqual(failureReply(error));
  }
});

test("typed recovery does not convert a defect into an expected error", async () => {
  const defect = new Error("private details");

  const program = Effect.sync(() => {
    throw defect;
  }).pipe(Effect.catch(() => Effect.succeed("recovered")));

  expect(Exit.isFailure(await Effect.runPromiseExit(program))).toBe(true);
  expect(Option.isNone(Schema.decodeUnknownOption(UserError)(defect))).toBe(true);
});
