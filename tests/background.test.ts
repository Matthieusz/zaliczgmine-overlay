import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { FetchReply, FetchTransport } from "../src/fetch-resource.ts";
import { apiFailure, failureReply } from "../src/user-errors.ts";

// MV3 listeners return whether Chrome should keep the response channel open.
type RuntimeListener = (
  ...args: Parameters<Parameters<typeof chrome.runtime.onMessage.addListener>[0]>
) => boolean;

async function loadBackground(transport: FetchTransport) {
  const bundle = await Bun.build({
    entrypoints: ["src/background.ts"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle background");

  let listener: RuntimeListener | undefined;

  runInNewContext(await bundle.outputs[0].text(), {
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback: RuntimeListener) {
            listener = callback;
          },
        },
      },
    },
    fetch: (url: string, init: { signal: AbortSignal }) => transport(url, init.signal),
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });

  if (!listener) throw new Error("Background did not register a listener");

  return listener;
}

test("background ignores unrelated and non-object messages", async () => {
  let called = false;

  const listener = await loadBackground(async () => {
    called = true;

    return new Response();
  });

  const replies: FetchReply[] = [];

  for (const message of [null, 42, "fetch", {}, { type: "other" }]) {
    expect(listener(message, {}, (reply: FetchReply) => replies.push(reply))).toBe(false);
  }

  expect(replies).toEqual([]);
  expect(called).toBe(false);
});

test("background rejects malformed fetch messages before network I/O", async () => {
  let called = false;

  const listener = await loadBackground(async () => {
    called = true;

    return new Response();
  });

  const replies: FetchReply[] = [];

  expect(
    listener({ type: "ZALICZGMINE_FETCH", url: 42 }, {}, (reply: FetchReply) =>
      replies.push(reply),
    ),
  ).toBe(false);
  expect(replies).toEqual([failureReply(apiFailure("INVALID_REQUEST"))]);
  expect(called).toBe(false);
});

test("background keeps Chrome's response channel open for a parsed fetch", async () => {
  const listener = await loadBackground(async () => Response.json({ ok: true }));

  const reply = await new Promise<FetchReply>((resolve) => {
    expect(
      listener({ type: "ZALICZGMINE_FETCH", url: "https://tickmyride.com/api/" }, {}, resolve),
    ).toBe(true);
  });

  expect(reply).toEqual({ success: true, data: { ok: true } });
});

test("background defects respond once with the existing safe unexpected-failure reply", async () => {
  const listener = await loadBackground(async () => {
    throw new Error("private transport defect");
  });

  const replies: FetchReply[] = [];

  const reply = await new Promise<FetchReply>((resolve) => {
    expect(
      listener({ type: "ZALICZGMINE_FETCH", url: "x" }, {}, (response: FetchReply) => {
        replies.push(response);
        resolve(response);
      }),
    ).toBe(true);
  });

  expect(reply).toEqual(failureReply(undefined));
  expect(replies).toHaveLength(1);
});
