import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { Option, Schema } from "effect";
import type { ChromeRuntimeApi } from "../src/chrome-runtime.ts";
import { apiFailure, failureReply } from "../src/user-errors.ts";

const Command = Schema.Struct({
  type: Schema.Literal("ZALICZGMINE_COMMAND"),
  requestId: Schema.String,
  action: Schema.optional(Schema.Unknown),
  data: Schema.optional(Schema.Unknown),
});

async function loadContent(supported: boolean) {
  const bundle = await Bun.build({
    entrypoints: ["content-script.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle content script");

  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const runtimeListeners = new Set<Parameters<ChromeRuntimeApi["onMessage"]["addListener"]>[0]>();
  const requests: Array<Parameters<ChromeRuntimeApi["sendMessage"]>[0]> = [];
  const pending: Array<() => void> = [];
  const posts: unknown[] = [];
  let initialized = () => {};

  let onCommand: ((command: typeof Command.Type) => void) | undefined;
  let lastError: chrome.runtime.LastError | undefined;
  let errorReads = 0;
  let fail = false;

  const ready = new Promise<void>((resolve) => {
    initialized = resolve;
  });

  const location = {
    origin: "https://www.komoot.com",
    pathname: supported ? "/plan" : "/unsupported",
  };

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
      posts.push(input);
      const command = Schema.decodeUnknownOption(Command)(input);

      if (Option.isSome(command)) onCommand?.(command.value);
    },
  };

  const sendPage = <Input>(data: Input, sameOrigin = true) => {
    for (const listener of listeners.get("message") ?? []) {
      runInNewContext("listener({ source: page, origin, data })", {
        listener,
        page,
        origin: sameOrigin ? location.origin : "https://other.test",
        data,
      });
    }
  };

  runInNewContext(await bundle.outputs[0].text(), {
    window: page,
    location,
    document: {
      createElement: () => ({}),
      head: { appendChild: (script: { onload: () => void }) => script.onload() },
    },
    chrome: {
      storage: { local: { get: () => Promise.resolve({ language: "pl" }) } },
      runtime: {
        get lastError() {
          errorReads++;

          return lastError;
        },
        getURL: (src: string) => "chrome-extension://test/" + src,
        sendMessage(
          request: Parameters<ChromeRuntimeApi["sendMessage"]>[0],
          callback: Parameters<ChromeRuntimeApi["sendMessage"]>[1],
        ) {
          requests.push(request);
          pending.push(() => {
            lastError = fail ? { message: "private runtime error" } : undefined;
            callback(fail ? undefined : { success: true, data: { opaque: 42 } });
            lastError = undefined;
          });
        },
        onMessage: {
          addListener: (listener: Parameters<ChromeRuntimeApi["onMessage"]["addListener"]>[0]) =>
            void runtimeListeners.add(listener),
          removeListener: (
            listener: Parameters<ChromeRuntimeApi["onMessage"]["removeListener"]>[0],
          ) => void runtimeListeners.delete(listener),
        },
      },
    },
    ZaliczGmineLogger: {
      create: () => ({
        debug(message: string) {
          if (message === "Page scripts loaded") initialized();
        },
        error() {},
        warn() {},
      }),
    },
    ZaliczGmineMessageProtocol: {
      MESSAGE: {
        FETCH: "ZALICZGMINE_FETCH",
        FETCH_REQUEST: "ZALICZGMINE_FETCH_REQUEST",
        FETCH_RESPONSE: "ZALICZGMINE_FETCH_RESPONSE",
      },
    },
    ZaliczGmineSites: { isSupportedPage: () => supported },
    ZaliczGmineI18n: {
      language: "pl",
      setLanguage() {
        if (!supported) initialized();
      },
    },
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    setInterval: () => 0,
  });
  await ready;

  return {
    posts,
    requests,
    pending,
    runtimeListeners,
    listeners,
    sendPage,
    get errorReads() {
      return errorReads;
    },
    fail() {
      fail = true;
    },
    nextCommand() {
      return new Promise<typeof Command.Type>((resolve) => {
        onCommand = resolve;
      });
    },
    command<Input>(input: Input) {
      const listener = [...runtimeListeners][0];

      if (!listener) throw new Error("Runtime listener missing");

      const replies: unknown[] = [];
      let respond = <Reply>(_reply: Reply): void => {};

      const reply = new Promise<unknown>((resolve) => {
        respond = resolve;
      });

      const keepOpen = listener(input, {}, <Output>(output: Output) => {
        replies.push(output);
        respond(output);
      });

      return { keepOpen, replies, reply };
    },
    unload() {
      for (const handler of listeners.get("unload") ?? []) handler(new MessageEvent("unload"));
    },
  };
}

test("content runtime preserves synchronous unsupported replies and removes the runtime listener on unload", async () => {
  const page = await loadContent(false);
  const command = page.command({ action: "getStatus" });
  expect(command.keepOpen).toBe(false);
  expect(command.replies).toEqual([
    { success: false, connected: false, error: "extension.unsupportedPage" },
  ]);
  page.unload();
  await setImmediate();
  expect(page.runtimeListeners.size).toBe(0);
  expect(page.listeners.get("message")?.size).toBe(0);
});

test("content keeps supported channels open, forwards correlated command replies unchanged, and rejects malformed commands safely", async () => {
  const page = await loadContent(true);

  try {
    const posted = page.nextCommand();
    const command = page.command({ action: "importGpx", data: { id: "track-1", text: "<gpx/>" } });
    expect(command.keepOpen).toBe(true);
    const forwarded = await posted;
    expect(forwarded.action).toBe("importGpx");
    expect(forwarded.data).toEqual({ id: "track-1", text: "<gpx/>" });
    const response = { success: true, extra: { opaque: true } };
    page.sendPage({
      type: "ZALICZGMINE_COMMAND_RESPONSE",
      requestId: forwarded.requestId,
      response,
    });
    expect(await command.reply).toEqual(response);
    expect(command.replies).toEqual([response]);
    expect(page.listeners.get("message")?.size).toBe(1);

    const malformed = page.command(null);
    expect(malformed.keepOpen).toBe(true);
    expect(await malformed.reply).toEqual(failureReply(apiFailure("INVALID_REQUEST")));
  } finally {
    page.unload();
  }
});

test("content fetch preserves request/response envelopes, consumes lastError, and ignores foreign-origin input", async () => {
  const page = await loadContent(false);

  try {
    page.sendPage({ type: "ZALICZGMINE_FETCH_REQUEST", requestId: "foreign", url: "x" }, false);
    expect(page.requests).toEqual([]);
    page.sendPage({
      type: "ZALICZGMINE_FETCH_REQUEST",
      requestId: "fetch-1",
      url: "x",
      responseType: "text",
    });
    expect(page.requests).toEqual([{ type: "ZALICZGMINE_FETCH", url: "x", responseType: "text" }]);

    for (const complete of page.pending.splice(0)) complete();
    expect(page.posts).toEqual([
      {
        type: "ZALICZGMINE_FETCH_RESPONSE",
        requestId: "fetch-1",
        response: { success: true, data: { opaque: 42 } },
        error: undefined,
      },
    ]);
    page.fail();
    page.sendPage({ type: "ZALICZGMINE_FETCH_REQUEST", requestId: "fetch-2", url: "x" });

    for (const complete of page.pending.splice(0)) complete();
    expect(page.posts[1]).toEqual({
      type: "ZALICZGMINE_FETCH_RESPONSE",
      requestId: "fetch-2",
      response: undefined,
      error: "extension.noResponse",
    });
    expect(page.errorReads).toBe(2);
  } finally {
    page.unload();
  }
});

test("content unload interrupts pending fetches and commands and consumes late lastError without posting/responding", async () => {
  const page = await loadContent(true);
  const posted = page.nextCommand();
  const command = page.command({ action: "getStatus" });
  await posted;
  page.sendPage({ type: "ZALICZGMINE_FETCH_REQUEST", requestId: "fetch-1", url: "x" });
  page.fail();
  page.unload();
  await setImmediate();

  for (const complete of page.pending) complete();
  expect(command.replies).toEqual([]);
  expect(page.posts).toHaveLength(1);
  expect(page.runtimeListeners.size).toBe(0);
  expect(page.listeners.get("message")?.size).toBe(0);
  expect(page.errorReads).toBe(1);
});
