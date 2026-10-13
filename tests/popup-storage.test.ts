import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { ChromeStorageApi } from "../src/chrome-storage.ts";

type Values = Parameters<ChromeStorageApi["local"]["set"]>[0];

type ChangeListener = Parameters<ChromeStorageApi["onChanged"]["addListener"]>[0];

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
          return lastError;
        },
      },
      tabs: {
        query(_query: chrome.tabs.QueryInfo, callback: (tabs: Array<{ id: number }>) => void) {
          callback([{ id: 1 }]);
        },
        sendMessage(
          _id: number,
          _message: Values,
          callback: (response: { connected: false }) => void,
        ) {
          callback({ connected: false });
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
        RELOAD_COMMUNES: "reloadVisitedCommunes",
        REMOVE_GPX: "removeGpx",
      },
    },
    createZaliczGmineApi: () => ({
      searchUsers: () => Promise.resolve([{ id: 84, username: "New rider" }]),
    }),
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
