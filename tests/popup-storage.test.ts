import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Effect } from "effect";
import type { fetchRuntimeJson } from "../src/runtime-fetch.ts";
import type { ChromeRuntimeApi } from "../src/chrome-runtime.ts";
import type { ChromeStorageApi } from "../src/chrome-storage.ts";
import type { ChromeTabsApi } from "../src/chrome-tabs.ts";

type Values = Parameters<ChromeStorageApi["local"]["set"]>[0];

type ChangeListener = Parameters<ChromeStorageApi["onChanged"]["addListener"]>[0];

type ApiFetch = (url: string) => Promise<Effect.Success<ReturnType<typeof fetchRuntimeJson>>>;

interface TabState {
  available: boolean;
  fail: boolean;
  hold: boolean;
  reply: unknown;
}

class PopupElement {
  value = "";
  textContent = "";
  title = "";
  hidden = false;
  className = "";
  readonly style = { display: "", whiteSpace: "" };
  readonly classList = { add() {}, remove() {} };
  readonly children: Array<PopupElement> = [];
  readonly handlers = new Map<string, (event: Event) => void | Promise<void>>();
  addEventListener(type: string, handler: (event: Event) => void | Promise<void>) {
    this.handlers.set(type, handler);
  }
  appendChild(child: PopupElement) {
    this.children.push(child);
  }
  async trigger(type: string) {
    await this.handlers.get(type)?.(new Event(type));
  }
}

async function loadPopup() {
  const bundle = await Bun.build({
    entrypoints: ["popup/popup.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle popup");

  const elements = new Map<string, PopupElement>();
  const listeners = new Set<ChangeListener>();
  const windowListeners = new Map<string, () => void>();
  const failures = { language: false, account: false, gpx: false };
  const runtimeRequests: Array<Parameters<ChromeRuntimeApi["sendMessage"]>[0]> = [];
  const runtimeCallbacks: Array<Parameters<ChromeRuntimeApi["sendMessage"]>[1]> = [];
  const tabQueries: Array<Parameters<ChromeTabsApi["query"]>[0]> = [];

  const tabMessages: Array<{ id: number; message: Parameters<ChromeTabsApi["sendMessage"]>[1] }> =
    [];

  const tabCallbacks: Array<() => void> = [];
  const tab: TabState = { available: true, fail: false, hold: false, reply: { connected: false } };
  let apiFetch: ApiFetch | undefined;
  let runtimeErrorReads = 0;

  const state = {
    language: "pl",
    zaliczGmineUserId: "42",
    zaliczGmineUsername: "Rider",
    zaliczGmineGpxList: [],
  };

  let lastError: chrome.runtime.LastError | undefined;
  let start = () => {};

  let opened = () => {};

  let removed = () => {};

  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });

  const closed = new Promise<void>((resolve) => {
    removed = resolve;
  });

  const element = (id: string) => {
    let node = elements.get(id);

    if (!node) {
      node = new PopupElement();
      elements.set(id, node);
    }

    return node;
  };

  const toggle = element("toggleBtn");
  // Initialization is complete once the last command button is wired.
  toggle.addEventListener = (type, handler) => {
    toggle.handlers.set(type, handler);
    opened();
  };

  runInNewContext(await bundle.outputs[0].text(), {
    document: {
      documentElement: { lang: "" },
      getElementById: element,
      querySelector: element,
      querySelectorAll: () => [],
      createElement: () => new PopupElement(),
      addEventListener(_type: string, handler: () => void) {
        start = handler;
      },
    },
    window: {
      addEventListener(type: string, handler: () => void) {
        windowListeners.set(type, handler);
      },
      removeEventListener(type: string) {
        windowListeners.delete(type);
      },
    },
    chrome: {
      storage: {
        local: {
          get(
            _keys: Parameters<ChromeStorageApi["local"]["get"]>[0],
            callback?: (values: Values) => void,
          ) {
            if (callback) callback(state);
            else return Promise.resolve(state);
          },
          set(values: Values, callback?: () => void) {
            if (!callback && failures.language)
              return Promise.reject(new Error("private language error"));
            const failed = values.zaliczGmineUserId ? failures.account : failures.gpx;

            if (!failed) Object.assign(state, values);
            lastError = failed ? { message: "private save error" } : undefined;
            callback?.();
            lastError = undefined;

            return Promise.resolve();
          },
          remove(_keys: string[], callback: () => void) {
            lastError = failures.gpx ? { message: "private remove error" } : undefined;
            callback();
            lastError = undefined;
          },
        },
        onChanged: {
          addListener(listener: ChangeListener) {
            listeners.add(listener);
          },
          removeListener(listener: ChangeListener) {
            listeners.delete(listener);
            removed();
          },
        },
      },
      runtime: {
        get lastError() {
          runtimeErrorReads++;

          return lastError;
        },
        sendMessage(
          request: Parameters<ChromeRuntimeApi["sendMessage"]>[0],
          callback: Parameters<ChromeRuntimeApi["sendMessage"]>[1],
        ) {
          runtimeRequests.push(request);
          runtimeCallbacks.push(callback);
        },
      },
      tabs: {
        query(
          query: Parameters<ChromeTabsApi["query"]>[0],
          callback: Parameters<ChromeTabsApi["query"]>[1],
        ) {
          tabQueries.push(query);
          callback(tab.available ? [{ id: 1 }] : []);
        },
        sendMessage(
          id: number,
          message: Parameters<ChromeTabsApi["sendMessage"]>[1],
          callback: Parameters<ChromeTabsApi["sendMessage"]>[2],
        ) {
          tabMessages.push({ id, message });

          const complete = () => {
            lastError = tab.fail ? { message: "private tab error" } : undefined;
            callback(tab.reply);
            lastError = undefined;
          };

          if (tab.hold) tabCallbacks.push(complete);
          else complete();
        },
      },
    },
    ZaliczGmineI18n: {
      language: "pl",
      messages: { pl: {}, en: {} },
      t: (key: string) => key,
      brand: () => "Brand",
      setLanguage() {},
    },
    ZaliczGmineLogger: { create: () => ({ debug() {}, warn() {} }) },
    ZaliczGmineMessageProtocol: {
      ACTION: {
        GET_STATUS: "getStatus",
        TOGGLE_COMMUNES: "toggleCommunes",
        RELOAD_COMMUNES: "reloadVisitedCommunes",
        REMOVE_GPX: "removeGpx",
      },
    },
    createZaliczGmineApi: (fetchResource: ApiFetch) => {
      apiFetch = fetchResource;

      return { searchUsers: () => Promise.resolve([{ id: 84, username: "New rider" }]) };
    },
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout: () => 0,
    clearTimeout,
    queueMicrotask,
    console,
  });
  start();
  await ready;

  return {
    element,
    listeners,
    failures,
    state,
    runtimeRequests,
    tabQueries,
    tabMessages,
    tabCallbacks,
    tab,
    setTabReply<Input>(input: Input) {
      tab.reply = input;
    },
    get runtimeErrorReads() {
      return runtimeErrorReads;
    },
    fetch(url: string) {
      if (!apiFetch) throw new Error("Popup API transport missing");

      return apiFetch(url);
    },
    completeRuntime<Input>(reply: Input, failed = false) {
      lastError = failed ? { message: "private runtime error" } : undefined;

      for (const callback of runtimeCallbacks.splice(0)) callback(reply);
      lastError = undefined;
    },
    unload: async () => {
      windowListeners.get("unload")?.();
      await closed;
    },
  };
}

test("popup refreshes the account only for local account changes and removes its listener on unload", async () => {
  const popup = await loadPopup();

  try {
    expect(popup.listeners.size).toBe(1);
    expect(popup.element("selectedUser").textContent).toBe("account.selected");
    popup.state.zaliczGmineUserId = "";

    for (const listener of popup.listeners)
      listener({ zaliczGmineUserId: { newValue: "" } }, "sync");
    expect(popup.element("selectedUser").textContent).toBe("account.selected");

    for (const listener of popup.listeners) listener({ language: { newValue: "en" } }, "local");
    expect(popup.element("selectedUser").textContent).toBe("account.selected");

    for (const listener of popup.listeners)
      listener({ zaliczGmineUserId: { oldValue: "42" } }, "local");
    expect(popup.element("selectedUser").textContent).toBe("account.noneSelected");
  } finally {
    await popup.unload();
  }

  expect(popup.listeners.size).toBe(0);
});

test("popup preserves language and account save failure keys without rendering success", async () => {
  const popup = await loadPopup();

  try {
    popup.failures.language = true;
    popup.element("languageSelect").value = "en";
    await popup.element("languageSelect").trigger("change");
    expect(popup.element("status").textContent).toBe("language.saveError");
    expect(popup.state.language).toBe("pl");

    popup.failures.account = true;
    popup.element("userIdInput").value = "New rider";
    await popup.element("saveUserIdBtn").trigger("click");
    const accountButton = popup.element("userSearchResults").children[0];

    if (!accountButton) throw new Error("Missing account search result");
    await accountButton.trigger("click");
    expect(popup.element("status").textContent).toBe("account.saveError");
    expect(popup.state.zaliczGmineUserId).toBe("42");
    expect(popup.element("userIdInput").value).toBe("New rider");
  } finally {
    await popup.unload();
  }
});

test("popup preserves the legacy GPX removal callback policy on lastError", async () => {
  const popup = await loadPopup();

  try {
    popup.failures.gpx = true;
    await popup.element("removeAllGpxBtn").trigger("click");
    expect(popup.element("status").textContent).toBe("gpx.removedFromStorage");
  } finally {
    await popup.unload();
  }
});

test("popup API calls use the existing runtime fetch payload and return decoded success data", async () => {
  const popup = await loadPopup();

  try {
    const request = popup.fetch("https://example.test/api/");
    expect(popup.runtimeRequests).toEqual([
      { type: "ZALICZGMINE_FETCH", url: "https://example.test/api/", responseType: "json" },
    ]);
    popup.completeRuntime({ success: true, data: { opaque: [1, 2] } });
    expect(await request).toEqual({ opaque: [1, 2] });
  } finally {
    await popup.unload();
  }
});

test("popup tab commands preserve payloads, successful replies, and null fallback presentation", async () => {
  const popup = await loadPopup();

  try {
    expect(popup.tabQueries).toEqual([{ active: true, currentWindow: true }]);
    expect(popup.tabMessages).toEqual([{ id: 1, message: { action: "getStatus" } }]);
    popup.setTabReply({ success: true, visible: true, extra: { opaque: 42 } });
    await popup.element("toggleBtn").trigger("click");
    expect(popup.tabMessages[1]).toEqual({ id: 1, message: { action: "toggleCommunes" } });
    expect(popup.element("toggleBtn").textContent).toBe("communes.hide");
    expect(popup.element("status").textContent).toBe("communes.nowVisible");

    popup.tab.fail = true;
    await popup.element("toggleBtn").trigger("click");
    expect(popup.element("status").textContent).toBe("map.connectionError");
    popup.tab.fail = false;
    popup.tab.available = false;
    const sent = popup.tabMessages.length;
    await popup.element("toggleBtn").trigger("click");
    expect(popup.tabMessages).toHaveLength(sent);
    expect(popup.element("status").textContent).toBe("map.connectionError");
  } finally {
    await popup.unload();
  }
});

test("popup unload prevents late tab replies from updating UI but still consumes lastError", async () => {
  const popup = await loadPopup();
  popup.tab.hold = true;
  popup.tab.fail = true;
  await popup.element("toggleBtn").trigger("click");
  expect(popup.tabCallbacks).toHaveLength(1);
  const reads = popup.runtimeErrorReads;
  const status = popup.element("status").textContent;
  await popup.unload();

  for (const complete of popup.tabCallbacks) complete();
  expect(popup.runtimeErrorReads).toBe(reads + 1);
  expect(popup.element("status").textContent).toBe(status);
});

test("popup unload interrupts runtime requests while late callbacks still consume lastError", async () => {
  const popup = await loadPopup();
  const reads = popup.runtimeErrorReads;
  const request = popup.fetch("https://example.test/api/");

  const settled = request.then(
    () => "success",
    () => "interrupted",
  );

  await popup.unload();
  expect(await settled).toBe("interrupted");
  popup.completeRuntime(undefined, true);
  expect(popup.runtimeErrorReads).toBe(reads + 1);
});
