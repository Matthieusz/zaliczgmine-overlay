import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Option, Schema } from "effect";
import {
  UserError,
  failureReply,
  remoteFailure,
  remoteErrorMessageKey,
} from "../src/user-errors.ts";

interface Api {
  searchUsers: (query: string) => Promise<object[]>;
}

async function apiFixture<Data>(data: Data, runtimeError?: { message: string }) {
  const bundle = await Bun.build({
    entrypoints: ["modules/zaliczgmine-api.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle API");

  let createApi: (() => Api) | undefined;

  const context = {
    TextEncoder,
    TextDecoder,
    AbortController,
    URLSearchParams,
    ZaliczGmineI18n: { apiBase: "https://example.test/api/" },
    ZaliczGmineLogger: { create: () => ({ debug() {}, error() {} }) },
    ZaliczGmineMessageProtocol: { MESSAGE: { FETCH: "ZALICZGMINE_FETCH" } },
    chrome: {
      runtime: {
        lastError: runtimeError,
        sendMessage(
          _request: { type: string; url: string },
          callback: (reply: { success: true; data: Data }) => void,
        ) {
          callback({ success: true, data });
        },
      },
    },
    set createZaliczGmineApi(value: () => Api) {
      createApi = value;
    },
  };

  runInNewContext(await bundle.outputs[0].text(), context);

  if (!createApi) throw new Error("API did not install");

  return createApi();
}

test("presentation never trusts arbitrary remote error strings or exception messages", () => {
  for (const value of ["private secret", "{brand}", null, {}, "account.saved"]) {
    expect(remoteErrorMessageKey(value)).toBe("extension.unexpectedError");
  }

  expect(remoteErrorMessageKey("api.userNotFound")).toBe("api.userNotFound");
  expect(failureReply(new Error("private secret"))).toEqual({
    success: false,
    error: "extension.unexpectedError",
  });
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(UserError)(remoteFailure({ error: "private secret" })),
    ),
  ).toBe(true);
});

test("API adapter ignores provider messages and unknown provider codes", async () => {
  const api = await apiFixture({ status: "error", code: "SECRET", message: "private secret" });

  try {
    await api.searchUsers("test");
    throw new Error("Expected API failure");
  } catch (cause) {
    expect(failureReply(cause).error).toBe("api.error");
    expect(JSON.stringify(failureReply(cause))).not.toContain("private secret");
  }
});

test("API adapter ignores Chrome runtime exception text", async () => {
  const api = await apiFixture({}, { message: "private Chrome details" });

  try {
    await api.searchUsers("test");
    throw new Error("Expected runtime failure");
  } catch (cause) {
    expect(failureReply(cause).error).toBe("api.fetchError");
    expect(JSON.stringify(failureReply(cause))).not.toContain("private Chrome details");
  }
});
