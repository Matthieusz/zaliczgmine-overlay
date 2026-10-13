import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Exit, Fiber } from "effect";
import { ChromeTabs, chromeTabsLayer, type ChromeTabsApi } from "../src/chrome-tabs.ts";
import { NetworkError, apiFailure, failureReply } from "../src/user-errors.ts";

class TabsFake {
  readonly queries: Array<Parameters<ChromeTabsApi["query"]>[0]> = [];
  readonly messages: Array<{ id: number; command: Parameters<ChromeTabsApi["sendMessage"]>[1] }> =
    [];
  readonly pending: Array<() => void> = [];
  tabs: unknown;
  reply: unknown;

  constructor() {
    this.tabs = [{ id: 42 }, { id: 84 }];
    this.reply = { success: true, extra: { opaque: [1, 2] } };
  }
  failure: "query" | "send" | undefined;
  throws: "query" | "send" | undefined;
  hold: "query" | "send" | undefined;
  errorReads = 0;
  private error: chrome.runtime.LastError | undefined;

  private complete(operation: "query" | "send", callback: () => void) {
    if (this.throws === operation) throw new Error("private invocation error");

    const invoke = () => {
      this.error = this.failure === operation ? { message: "private browser error" } : undefined;

      try {
        callback();
      } finally {
        this.error = undefined;
      }
    };

    if (this.hold === operation) this.pending.push(invoke);
    else invoke();
  }

  readonly api: ChromeTabsApi = {
    query: (query, callback) => {
      this.queries.push(query);
      this.complete("query", () =>
        runInNewContext("callback(tabs)", { callback, tabs: this.tabs }),
      );
    },
    sendMessage: (id, command, callback) => {
      this.messages.push({ id, command });
      this.complete("send", () => callback(this.reply));
    },
  };

  get layer() {
    const readError = () => {
      this.errorReads++;

      return this.error;
    };

    return chromeTabsLayer(this.api, {
      get lastError() {
        return readError();
      },
    });
  }
}

const send = <Input>(input: Input) =>
  Effect.gen(function* () {
    const tabs = yield* ChromeTabs;

    return yield* tabs.sendCommand(input);
  });

// Compile the actual native capability against the adapter seam without acquiring it in tests.
const nativeLayer = () => chromeTabsLayer(chrome.tabs, chrome.runtime);

test("tabs layer is lazy and native Chrome capabilities satisfy its narrow interface", async () => {
  expect(nativeLayer).toBeFunction();
  const fake = new TabsFake();
  await Effect.runPromise(Effect.void.pipe(Effect.provide(fake.layer)));
  expect(fake.queries).toEqual([]);
  expect(fake.messages).toEqual([]);
});

test("tab commands preserve active/current-window query, first-tab selection, payloads and opaque replies", async () => {
  const fake = new TabsFake();
  const command = { action: "importGpx", data: { id: "track-1", text: "<gpx/>" } };
  expect(await Effect.runPromise(send(command).pipe(Effect.provide(fake.layer)))).toEqual(
    fake.reply,
  );
  expect(fake.queries).toEqual([{ active: true, currentWindow: true }]);
  expect(fake.messages).toEqual([{ id: 42, command }]);
  expect(fake.errorReads).toBe(2);

  fake.reply = undefined;
  expect(
    await Effect.runPromise(send({ action: "futureAction" }).pipe(Effect.provide(fake.layer))),
  ).toBeUndefined();
  expect(fake.messages[1]).toEqual({ id: 42, command: { action: "futureAction" } });
});

test("missing tabs and malformed query replies fail safely without sending commands", async () => {
  for (const result of [[], [{}], null, 42, [{ id: "42" }]]) {
    const fake = new TabsFake();
    fake.tabs = result;
    expect(
      await Effect.runPromise(
        send({ action: "getStatus" }).pipe(Effect.flip, Effect.provide(fake.layer)),
      ),
    ).toEqual(new NetworkError({ reason: "unavailable" }));
    expect(fake.messages).toEqual([]);
  }
});

test("tab query/message lastError and invocation exceptions become safe typed failures", async () => {
  for (const operation of ["query", "send"] as const) {
    for (const throws of [false, true]) {
      const fake = new TabsFake();
      fake.failure = operation;

      if (throws) fake.throws = operation;

      const error = await Effect.runPromise(
        send({ action: "getStatus" }).pipe(Effect.flip, Effect.provide(fake.layer)),
      );

      expect(error).toEqual(new NetworkError({ reason: "unavailable" }));
      expect(JSON.stringify(failureReply(error))).not.toContain("private");
      expect(fake.errorReads).toBe((operation === "send" ? 1 : 0) + (throws ? 0 : 1));
      expect(fake.messages).toHaveLength(operation === "query" ? 0 : 1);
    }
  }
});

test("malformed command envelopes fail before querying Chrome", async () => {
  const fake = new TabsFake();

  for (const input of [null, {}, { action: 42 }, "getStatus"]) {
    expect(
      await Effect.runPromise(send(input).pipe(Effect.flip, Effect.provide(fake.layer))),
    ).toEqual(apiFailure("INVALID_REQUEST"));
  }

  expect(fake.queries).toEqual([]);
});

test("interruption stops late tab-query/message consumers while consuming callback lastError", async () => {
  for (const operation of ["query", "send"] as const) {
    for (const failed of [false, true]) {
      const fake = new TabsFake();
      fake.hold = operation;
      fake.failure = failed ? operation : undefined;
      let continued = false;
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* send({ action: "getStatus" }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                continued = true;
              }),
            ),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          expect(fake.pending).toHaveLength(1);
          yield* Fiber.interrupt(fiber);

          for (const complete of fake.pending) complete();
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        }).pipe(Effect.provide(fake.layer)),
      );
      expect(continued).toBe(false);
      expect(fake.errorReads).toBe(operation === "query" ? 1 : 2);
      expect(fake.messages).toHaveLength(operation === "query" ? 0 : 1);
    }
  }
});
