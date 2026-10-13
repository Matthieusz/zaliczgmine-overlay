import { expect, test } from "bun:test";
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
      convertToGeoJSON: () => { type: "FeatureCollection"; features: never[] };
    };
    plannedRoute?: { start: () => void; stop: () => void };
  };
}

async function readRoute(source: PlannerSource) {
  const bundle = await Bun.build({
    entrypoints: ["modules/planned-route.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle route observer");

  let reportLines: (lines: Lines) => void = () => {
    throw new Error("Route observation not ready");
  };

  const lines = new Promise<Lines>((resolve) => {
    reportLines = resolve;
  });

  const overlay = { setData() {} };

  const map = {
    getSource: (id: string) => (id === "planner" ? source : overlay),
    isStyleLoaded: () => true,
    getStyle: () => ({ layers: [] }),
    getLayer: () => true,
    on() {},
    off() {},
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
        fetchRoutePolygons: async (observed) => {
          reportLines(observed);

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
    setTimeout,
    clearTimeout,
  });

  const observer = app.modules.plannedRoute;

  if (!observer) throw new Error("Route observer did not install");

  observer.start();

  try {
    return await lines;
  } finally {
    observer.stop();
  }
}

test("route observer calls the public source reader with its original receiver", async () => {
  const source: PlannerSource = {
    _data: {
      type: "LineString",
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
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
