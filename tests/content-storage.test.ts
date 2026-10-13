import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Schema } from "effect";
import type { ChromeStorageApi } from "../src/chrome-storage.ts";

const Reply = Schema.Struct({
  type: Schema.Literal("ZALICZGMINE_STORAGE_RESPONSE"),
  requestId: Schema.String,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(Schema.String),
});

async function loadContent<Output>(output: Output, failed = false) {
  const bundle = await Bun.build({
    entrypoints: ["content-script.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle content script");

  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const writes: Array<Parameters<ChromeStorageApi["local"]["set"]>[0]> = [];
  const warnings: Array<string> = [];
  let lastError: chrome.runtime.LastError | undefined;
  let onReply: ((reply: typeof Reply.Type) => void) | undefined;
  let initialized = () => {};

  const ready = new Promise<void>((resolve) => {
    initialized = resolve;
  });

  const location = { origin: "https://www.komoot.com", pathname: "/unsupported" };

  const page = {
    location,
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(listener);
      listeners.set(type, callbacks);
    },
    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.get(type)?.delete(listener);
    },
    postMessage<Input>(input: Input, origin: string) {
      expect(origin).toBe(location.origin);
      onReply?.(Schema.decodeUnknownSync(Reply)(input));
    },
  };

  runInNewContext(await bundle.outputs[0].text(), {
    window: page,
    location,
    chrome: {
      storage: {
        local: {
          get(
            _keys: Parameters<ChromeStorageApi["local"]["get"]>[0],
            callback?: (result: Output) => void,
          ) {
            if (!callback) return Promise.resolve({ language: "pl" });
            lastError = failed ? { message: "private storage error" } : undefined;
            callback(output);
            lastError = undefined;
          },
          set(data: Parameters<ChromeStorageApi["local"]["set"]>[0]) {
            writes.push(data);

            return Promise.resolve();
          },
        },
      },
      runtime: {
        get lastError() {
          return lastError;
        },
        onMessage: { addListener() {} },
      },
    },
    ZaliczGmineLogger: {
      create: () => ({ debug() {}, error() {}, warn: (message: string) => warnings.push(message) }),
    },
    ZaliczGmineMessageProtocol: {
      MESSAGE: {
        STORAGE_GET: "ZALICZGMINE_STORAGE_GET",
        STORAGE_SET: "ZALICZGMINE_STORAGE_SET",
        STORAGE_RESPONSE: "ZALICZGMINE_STORAGE_RESPONSE",
      },
    },
    ZaliczGmineSites: { isSupportedPage: () => false },
    ZaliczGmineI18n: { language: "pl", setLanguage: initialized },
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    queueMicrotask,
    console,
  });
  await ready;

  return {
    writes,
    warnings,
    send<Input>(data: Input) {
      for (const handler of listeners.get("message") ?? []) {
        // Enter through the real page event boundary with unknown serialized data.
        runInNewContext("handler({ source: window, origin: window.location.origin, data })", {
          handler,
          window: page,
          data,
        });
      }
    },
    request<Input>(keys: Input) {
      return new Promise<typeof Reply.Type>((resolve) => {
        onReply = resolve;
        this.send({ type: "ZALICZGMINE_STORAGE_GET", requestId: "request-1", keys });
      });
    },
    unload() {
      for (const handler of listeners.get("unload") ?? []) handler(new MessageEvent("unload"));
    },
  };
}

test("content storage preserves the response envelope and resolved language", async () => {
  const page = await loadContent({ zaliczGmineUserId: "42", extra: { opaque: true } });

  try {
    expect(await page.request(["zaliczGmineUserId"])).toEqual({
      type: "ZALICZGMINE_STORAGE_RESPONSE",
      requestId: "request-1",
      data: { zaliczGmineUserId: "42", extra: { opaque: true }, resolvedLanguage: "pl" },
      error: undefined,
    });
    page.send({ type: "ZALICZGMINE_STORAGE_SET", data: { visitedCommunesCount: 7 } });
    expect(page.writes).toEqual([{ visitedCommunesCount: 7 }]);
  } finally {
    page.unload();
  }
});

test("content storage reports Chrome and malformed result failures using the existing key", async () => {
  for (const output of [null, 42, ["invalid"], { language: "pl" }]) {
    const page = await loadContent(output, output !== null && !Array.isArray(output));

    try {
      expect(await page.request(null)).toEqual({
        type: "ZALICZGMINE_STORAGE_RESPONSE",
        requestId: "request-1",
        data: undefined,
        error: "storage.error",
      });
    } finally {
      page.unload();
    }
  }
});

test("content storage rejects malformed page keys/writes without adding a write acknowledgement", async () => {
  const page = await loadContent({ language: "pl" });

  try {
    expect((await page.request(["language", 42])).error).toBe("storage.error");
    page.send({ type: "ZALICZGMINE_STORAGE_SET", data: null });
    expect(page.writes).toEqual([]);
    expect(page.warnings).toEqual(["Storage write failed"]);
  } finally {
    page.unload();
  }
});
