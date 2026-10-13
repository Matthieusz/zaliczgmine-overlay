import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";

type Lines = number[][][];

interface RouteData {
  type: "LineString";
  coordinates: number[][];
}

interface PlannerSource {
  getData?: () => Promise<RouteData | undefined>;
  _data?: RouteData;
}

interface Collection {
  type: "FeatureCollection";
  features: never[];
}

interface RouteApp {
  config: {
    layerIds: { routeFill: string; routeOutline: string };
    sourceIds: { route: string };
    styles: { routeFill: {}; routeOutline: {} };
  };
  state: { map: object; communesVisible: boolean; visitedCommunesIds: Set<string> };
  modules: {
    communesData: {
      fetchRoutePolygons: (lines: Lines) => Promise<never[]>;
      convertToGeoJSON: () => Collection;
    };
    plannedRoute?: { start: () => void; stop: () => void };
  };
}

async function fixture(initialSource: PlannerSource) {
  const bundle = await Bun.build({
    entrypoints: ["modules/planned-route.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle route observer");

  const observed: Lines[] = [];
  const uploads: Collection[] = [];
  const listeners = new Map<string, (event: { sourceId?: string }) => void>();
  const timers = new Map<number, () => void>();
  const layers = new Set(["route-fill", "route-outline"]);
  let nextTimer = 0;
  let source: PlannerSource | undefined = initialSource;
  let loaded = true;

  let overlay: { setData: (data: Collection) => void } | undefined = {
    setData: (data) => uploads.push(data),
  };

  const map = {
    getSource: (id: string) => (id === "planner" ? source : overlay),
    addSource(_id: string, options: { data: Collection }) {
      uploads.push(options.data);
      overlay = { setData: (data) => uploads.push(data) };
    },
    isStyleLoaded: () => loaded,
    getStyle: () => ({ layers: [] }),
    getLayer: (id: string) => layers.has(id),
    addLayer: (layer: { id: string }) => layers.add(layer.id),
    on: (event: string, listener: (event: { sourceId?: string }) => void) =>
      listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
  };

  const app: RouteApp = {
    config: {
      layerIds: { routeFill: "route-fill", routeOutline: "route-outline" },
      sourceIds: { route: "overlay" },
      styles: { routeFill: {}, routeOutline: {} },
    },
    state: { map, communesVisible: true, visitedCommunesIds: new Set() },
    modules: {
      communesData: {
        fetchRoutePolygons: async (lines) => {
          observed.push(lines);

          return [];
        },
        convertToGeoJSON: () => ({ type: "FeatureCollection", features: [] }),
      },
    },
  };

  runInNewContext(await bundle.outputs[0].text(), {
    window: { ZaliczGmine: app },
    ZaliczGmineLogger: { create: () => ({ debug() {}, warn() {} }) },
    ZaliczGmineSites: { getCurrentSite: () => ({ routeSourceId: "planner" }) },
    TextEncoder,
    TextDecoder,
    setTimeout(callback: () => void) {
      const id = ++nextTimer;
      timers.set(id, callback);

      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });

  const observer = app.modules.plannedRoute;

  if (!observer) throw new Error("Route observer did not install");

  observer.start();
  // Drain the immediate async reader/fetch without advancing refresh timers.
  await setImmediate();

  return {
    observer,
    observed,
    uploads,
    layers,
    timers,
    emit: (event: string, sourceId?: string) =>
      listeners.get(event)?.(sourceId === undefined ? {} : { sourceId }),
    setSource: (value: PlannerSource | undefined) => {
      source = value;
    },
    setLoaded: (value: boolean) => {
      loaded = value;
    },
    resetOverlay() {
      overlay = undefined;
      layers.clear();
    },
    async flush() {
      const pending = [...timers.values()];
      timers.clear();

      for (const callback of pending) callback();
      await setImmediate();
    },
  };
}

async function readRoute(source: PlannerSource) {
  const f = await fixture(source);

  try {
    return f.observed[0];
  } finally {
    f.observer.stop();
  }
}

function route(x = 1): RouteData {
  return {
    type: "LineString",
    coordinates: [
      [x, 2],
      [3, 4],
    ],
  };
}

test("route observer calls the public source reader with its original receiver", async () => {
  const source: PlannerSource = {
    _data: route(),
    getData() {
      return Promise.resolve(this._data);
    },
  };

  expect(await readRoute(source)).toEqual([
    [
      [1, 2],
      [3, 4],
    ],
  ]);
});

test("route observer retains the legacy source-data fallback", async () => {
  expect(
    await readRoute({
      _data: {
        type: "LineString",
        coordinates: [
          [5, 6],
          [7, 8],
        ],
      },
    }),
  ).toEqual([
    [
      [5, 6],
      [7, 8],
    ],
  ]);
});

test("unchanged style and unrelated source events do not read route data", async () => {
  let reads = 0;

  const f = await fixture({
    getData: async () => {
      reads++;

      return route();
    },
  });

  try {
    f.uploads.length = 0;
    f.layers.clear();

    for (let i = 0; i < 50; i++) {
      f.emit("styledata");
      f.emit("idle");
      f.emit("sourcedata", "overlay");
    }

    expect(f.layers.size).toBe(2);
    expect(f.timers.size).toBe(0);
    expect(reads).toBe(1);
    expect(f.uploads).toHaveLength(0);
  } finally {
    f.observer.stop();
  }
});

test("style replacement reads the new planner source and restores route layers", async () => {
  const f = await fixture({ _data: route() });

  try {
    f.resetOverlay();
    f.setSource({ _data: route(5) });
    f.emit("styledata");
    f.emit("styledata");
    expect(f.timers.size).toBe(1);
    await f.flush();
    expect(f.observed).toEqual([
      [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      [
        [
          [5, 2],
          [3, 4],
        ],
      ],
    ]);
    expect(f.layers.size).toBe(2);
    expect(f.uploads.length).toBeGreaterThan(0);
    f.emit("styledata");
    expect(f.timers.size).toBe(0);
  } finally {
    f.observer.stop();
  }
});

test("idle detects a source replacement when the last style event was not ready", async () => {
  const f = await fixture({ _data: route() });

  try {
    f.resetOverlay();
    f.setSource({ _data: route(5) });
    f.setLoaded(false);
    f.emit("styledata");
    expect(f.timers.size).toBe(0);
    f.setLoaded(true);
    f.emit("idle");
    await f.flush();
    expect(f.observed).toHaveLength(2);
    expect(f.layers.size).toBe(2);
  } finally {
    f.observer.stop();
  }
});

test("planner source events still detect in-place coordinate edits", async () => {
  const data = route();
  const f = await fixture({ _data: data });

  try {
    const point = data.coordinates[0];

    if (!point) throw new Error("Missing route coordinate");
    point[0] = 7;

    for (let i = 0; i < 50; i++) f.emit("sourcedata", "planner");
    expect(f.timers.size).toBe(1);
    await f.flush();
    expect(f.observed).toEqual([
      [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      [
        [
          [7, 2],
          [3, 4],
        ],
      ],
    ]);
  } finally {
    f.observer.stop();
  }
});

test("stopping the observer removes event listeners and pending refreshes", async () => {
  const f = await fixture({ _data: route() });
  f.emit("sourcedata", "planner");
  expect(f.timers.size).toBe(1);
  f.observer.stop();
  f.emit("styledata");
  f.emit("idle");
  f.emit("sourcedata", "planner");
  expect(f.timers.size).toBe(0);
  await f.flush();
  expect(f.observed).toHaveLength(1);
});
