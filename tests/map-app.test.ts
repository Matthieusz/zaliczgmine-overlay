import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { AccountError, NetworkError } from "../src/user-errors.ts";

interface StartupState {
  map: {};
  visitedCommunesIds: Set<string>;
  polygons: string[];
}

async function fixture(boundariesFail = false, visitedFail = false) {
  const bundle = await Bun.build({
    entrypoints: ["map-app.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle map app");

  const notifications: { message: string; retry: (() => Promise<void>) | undefined }[] = [];
  const polygons = ["polygon"];

  const state: StartupState = {
    map: { on() {}, off() {} },
    visitedCommunesIds: new Set(),
    polygons: [],
  };

  let visitedLoads = 0;
  let layersAvailable = false;
  let routeStarted = false;
  let initialized = () => {};

  const ready = new Promise<void>((resolve) => {
    initialized = resolve;
  });

  const noop = () => {};

  const app = {
    state,
    modules: {
      extensionBridge: { getStorage: async () => ({}) },
      communesData: {
        async loadVisitedCommunes() {
          visitedLoads++;

          if (visitedFail) throw new AccountError({ reason: "missing" });
          state.visitedCommunesIds = new Set(["1"]);

          return state.visitedCommunesIds;
        },
        reloadVisitedCommunes: noop,
        async fetchPolygons() {
          if (boundariesFail) throw new NetworkError({ reason: "unavailable" });

          return polygons;
        },
        activatePolygons(_request: { cacheKey: string }, value: string[]) {
          state.polygons = value;
        },
        getPolygonRequestForMap: () => ({ cacheKey: "initial" }),
      },
      gpx: {
        getTracksSummary: () => [],
        loadStoredGpx: async () => {},
        removeGpx: noop,
        renderGpx: noop,
        setGpx: noop,
      },
      mapFinder: { findMap: async () => state.map },
      plannedRoute: {
        start() {
          routeStarted = true;
        },
      },
      mapLayers: {
        addCommunesLayers() {
          layersAvailable = true;
        },
        addToggleButton: noop,
        refreshCommunesStyles: noop,
        setupStyleChangeObserver: noop,
        setupZoomObserver: noop,
        showNotification: (message: string, retry?: () => Promise<void>) =>
          notifications.push({ message, retry }),
        toggleLayers: noop,
        waitForStyleLoad: async () => {},
      },
    },
  };

  runInNewContext(await bundle.outputs[0].text(), {
    AbortController,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    window: { ZaliczGmine: app, addEventListener: noop },
    ZaliczGmineI18n: {
      setLanguage: noop,
      t: (key: string, values?: { error?: string; count?: number }) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
    },
    ZaliczGmineLogger: {
      create: () => ({
        debug: (message: string) => {
          if (message === "Extension ready") initialized();
        },
        error: noop,
      }),
    },
    ZaliczGmineMessageProtocol: { ACTION: {}, MESSAGE: {} },
    setTimeout,
    clearTimeout,
  });

  await ready;

  return {
    state,
    notifications,
    get layersAvailable() {
      return layersAvailable;
    },
    get visitedLoads() {
      return visitedLoads;
    },
    get routeStarted() {
      return routeStarted;
    },
    recover() {
      boundariesFail = visitedFail = false;
    },
  };
}

test("startup success exposes boundaries and loaded guidance without a retry", async () => {
  const f = await fixture();
  expect(f.state.polygons).toEqual(["polygon"]);
  expect(f.state.visitedCommunesIds).toEqual(new Set(["1"]));
  expect(f.layersAvailable).toBe(true);
  expect(f.routeStarted).toBe(true);
  expect(f.notifications).toEqual([
    { message: 'communes.loadedSummary:{"count":1}', retry: undefined },
  ]);
});

test("boundary failure preserves visited data and offers a working retry", async () => {
  const f = await fixture(true);
  expect(f.state.polygons).toEqual([]);
  expect(f.layersAvailable).toBe(false);
  expect(f.state.visitedCommunesIds).toEqual(new Set(["1"]));
  expect(f.notifications[0]?.message).toContain("communes.initialBoundariesError");
  expect(f.notifications[0]?.message).toContain('communes.loadedSummary:{"count":1}');
  const retry = f.notifications[0]?.retry;

  if (!retry) throw new Error("Missing boundary retry");
  f.recover();
  await retry();
  expect(f.state.polygons).toEqual(["polygon"]);
  expect(f.layersAvailable).toBe(true);
  expect(f.visitedLoads).toBe(1);
  expect(f.notifications.at(-1)).toEqual({
    message: 'communes.loadedSummary:{"count":1}',
    retry: undefined,
  });
});

test("visited failure leaves boundaries available and offers account recovery", async () => {
  const f = await fixture(false, true);
  expect(f.state.polygons).toEqual(["polygon"]);
  expect(f.layersAvailable).toBe(true);
  expect(f.state.visitedCommunesIds.size).toBe(0);
  expect(f.notifications[0]?.message).toContain("communes.visitedLoadError");
  const retry = f.notifications[0]?.retry;

  if (!retry) throw new Error("Missing visited retry");
  f.recover();
  await retry();
  expect(f.state.visitedCommunesIds).toEqual(new Set(["1"]));
  expect(f.state.polygons).toEqual(["polygon"]);
  expect(f.notifications.at(-1)?.retry).toBeUndefined();
  expect(f.notifications.at(-1)?.message).toBe('communes.loadedSummary:{"count":1}');
});
