import { expect, test } from "bun:test";
import { runInContext, createContext } from "node:vm";

interface Collection {
  type: string;
  features: { properties: { id: number } }[];
}

interface Source {
  data: Collection;
  setData: (data: Collection) => void;
}

interface Layer {
  id: string;
  layout: { visibility?: string };
  paint: { "line-opacity"?: number };
}

interface Polygon {
  i: number;
  n: string;
  c: string;
}

interface Request {
  apiZoom: number;
  cacheKey: string;
  bounds?: { north: number; east: number; south: number; west: number };
}

interface ViewportMap {
  getZoom: () => number;
  getBounds: () => {
    getNorth: () => number;
    getEast: () => number;
    getSouth: () => number;
    getWest: () => number;
  };
}

interface Overlay {
  state: {
    polygons: Polygon[];
    polygonsKey?: string;
    visitedCommunesIds: Set<string>;
    communesVisible: boolean;
    map?: ViewportMap;
  };
  modules: {
    extensionBridge: { getStorage: () => Promise<object> };
    communesData?: {
      getPolygonRequestForMap: (map: ViewportMap) => Request;
      activatePolygons: (request: Request, polygons: Polygon[]) => void;
    };
    mapLayers?: {
      addCommunesLayers: () => void;
      setupStyleChangeObserver: () => void;
      toggleLayers: (visible: boolean, refresh: boolean) => void;
      refreshCommunesStyles: () => void;
      refreshCommunesForCurrentZoom: () => Promise<void>;
    };
    gpx?: {
      renderGpx: () => void;
      loadStoredGpx: () => Promise<object>;
      setGpx: (text: string, name: string, id: string) => void;
      removeGpx: (id?: string) => void;
    };
  };
}

async function fixture() {
  const uploads: { id: string; features: number }[] = [];
  const mutations: string[] = [];
  const scheduledDelays: number[] = [];
  const sources = new Map<string, Source>();
  const layers = new Map<string, Layer>();
  const listeners = new Map<string, (() => void | Promise<void>)[]>();
  let zoom = 10;
  let viewport = { north: 51, east: 20, south: 50, west: 19 };
  let loaded = true;
  let polygonResponse: Promise<Polygon[]> | undefined;

  const map = {
    getSource: (id: string) => sources.get(id),
    addSource(id: string, options: { data: Collection }) {
      uploads.push({ id, features: options.data.features.length });
      sources.set(id, {
        data: options.data,
        setData(data) {
          uploads.push({ id, features: data.features.length });
          this.data = data;
        },
      });
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => layers.get(id),
    addLayer(layer: Layer) {
      layers.set(layer.id, layer);
      mutations.push("addLayer");
    },
    removeLayer: (id: string) => layers.delete(id),
    getStyle: () => ({ layers: [...layers.values()] }),
    getZoom: () => zoom,
    getBounds: () => ({
      getNorth: () => viewport.north,
      getEast: () => viewport.east,
      getSouth: () => viewport.south,
      getWest: () => viewport.west,
    }),
    isStyleLoaded: () => loaded,
    setLayoutProperty(id: string, _property: string, value: string) {
      const layer = layers.get(id);

      if (!layer) throw new Error("Missing layer");
      layer.layout.visibility = value;
      mutations.push("layout");
    },
    setPaintProperty(id: string, _property: string, value: number) {
      const layer = layers.get(id);

      if (!layer) throw new Error("Missing layer");
      layer.paint["line-opacity"] = value;
      mutations.push("paint");
    },
    on(event: string, listener: () => void | Promise<void>) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  };

  const app: Overlay = {
    state: {
      map,
      polygons: [],
      visitedCommunesIds: new Set(["1"]),
      communesVisible: true,
    },
    modules: {
      extensionBridge: {
        getStorage: async () => ({
          zaliczGmineGpxList: [
            { text: "track", name: "one", id: "1" },
            { text: "track", name: "two", id: "2" },
            { text: "track", name: "three", id: "3" },
          ],
        }),
      },
    },
  };

  const context = createContext({
    TextEncoder,
    TextDecoder,
    AbortController,
    queueMicrotask,
    clearTimeout,
    window: { ZaliczGmine: app },
    document: { getElementById: () => null },
    ZaliczGmineI18n: { t: (key: string) => key },
    ZaliczGmineLogger: { create: () => ({ debug() {}, warn() {}, error() {} }) },
    createZaliczGmineApi: () => ({
      getPolygons() {
        if (!polygonResponse) throw new Error("Unexpected polygon request");

        return polygonResponse;
      },
    }),
    DOMParser: class {
      parseFromString() {
        return { querySelector: () => null };
      }
    },
    toGeoJSON: {
      gpx: () => ({
        features: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [19, 50],
                [20, 51],
              ],
            },
          },
        ],
      }),
    },
    setTimeout(callback: () => void, delay: number) {
      scheduledDelays.push(delay);

      return setTimeout(callback, delay);
    },
  });

  runInContext(await Bun.file("config.js").text(), context);
  // Keep the real configuration while supplying a controlled map and storage adapter.
  runInContext("Object.assign(window.ZaliczGmine, { config: ZaliczGmine.config })", context);

  for (const path of [
    "modules/communes-geometry.js",
    "modules/communes-data.js",
    "modules/gpx.js",
    "modules/map-layers.js",
  ]) {
    const bundle = await Bun.build({ entrypoints: [path], target: "browser", format: "iife" });

    if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle overlay");

    runInContext(await bundle.outputs[0].text(), context);
  }

  const data = app.modules.communesData;
  const rendering = app.modules.mapLayers;
  const gpx = app.modules.gpx;

  if (!data || !rendering || !gpx) throw new Error("Overlay modules did not install");

  app.state.polygons = [1, 2].map((i) => ({
    i,
    n: `Commune ${i}`,
    c: JSON.stringify([
      [50, 19],
      [50, 20],
      [51, 20],
      [51, 19],
    ]),
  }));

  return {
    app,
    map,
    data,
    rendering,
    gpx,
    sources,
    layers,
    uploads,
    mutations,
    scheduledDelays,
    usePolygonResponse: (response: Promise<Polygon[]>) => {
      polygonResponse = response;
    },
    setZoom: (value: number) => {
      zoom = value;
    },
    setViewport: (value: typeof viewport) => {
      viewport = value;
    },
    setLoaded: (value: boolean) => {
      loaded = value;
    },
    async styleEvent(event = "styledata") {
      for (const listener of listeners.get(event) ?? []) await listener();
    },
  };
}

test("hidden visited communes are not converted or uploaded", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  expect(f.uploads).toEqual([{ id: "zaliczgmine-unvisited-source", features: 1 }]);
  expect(f.sources.get("zaliczgmine-unvisited-source")?.data.features[0]?.properties.id).toBe(2);
});

test("50 unchanged style events cause no uploads or style mutations", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.gpx.renderGpx();
  f.rendering.setupStyleChangeObserver();
  f.uploads.length = f.mutations.length = 0;

  for (let i = 0; i < 50; i++) await f.styleEvent();
  expect(f.uploads).toHaveLength(0);
  expect(f.mutations).toHaveLength(0);
});

test("style replacement restores polygon and GPX layers with current visibility", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.gpx.setGpx("track", "one", "1");
  f.rendering.toggleLayers(false, false);
  f.rendering.setupStyleChangeObserver();
  f.layers.clear();
  f.sources.clear();
  await f.styleEvent();
  expect(f.layers.size).toBe(4);
  expect(f.layers.get("zaliczgmine-communes")?.layout.visibility).toBe("none");
  expect(f.sources.get("zaliczgmine-gpx-source")?.data.features).toHaveLength(1);
});

test("incomplete styles do not spawn polling jobs or uploads", async () => {
  const f = await fixture();
  f.rendering.setupStyleChangeObserver();
  f.setLoaded(false);
  const pending = f.styleEvent();
  f.setLoaded(true);
  await pending;
  expect(f.uploads).toHaveLength(0);
  expect(f.scheduledDelays).toHaveLength(0);
});

test("idle restores overlays when the style only becomes ready after its last styledata event", async () => {
  const f = await fixture();
  f.rendering.setupStyleChangeObserver();
  f.setLoaded(false);
  await f.styleEvent();
  expect(f.uploads).toHaveLength(0);
  f.setLoaded(true);
  await f.styleEvent("idle");
  expect(f.layers.size).toBe(4);
});

test("missing GPX layers are restored without uploading unchanged tracks", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.gpx.setGpx("track", "one", "1");
  f.rendering.setupStyleChangeObserver();
  f.layers.delete("zaliczgmine-gpx-line");
  f.uploads.length = 0;
  await f.styleEvent();
  expect(f.layers.has("zaliczgmine-gpx-line")).toBe(true);
  expect(f.uploads).toHaveLength(0);
});

test("account changes update only the visible polygon source", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.uploads.length = 0;
  f.app.state.visitedCommunesIds = new Set(["2"]);
  f.rendering.refreshCommunesStyles();
  expect(f.uploads).toEqual([{ id: "zaliczgmine-unvisited-source", features: 1 }]);
  expect(f.sources.get("zaliczgmine-unvisited-source")?.data.features[0]?.properties.id).toBe(1);
});

test("unchanged commune refreshes do not upload data again", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.uploads.length = 0;

  for (let i = 0; i < 50; i++) f.rendering.refreshCommunesStyles();
  expect(f.uploads).toHaveLength(0);
});

test("missing commune layers are restored without uploading unchanged polygons", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.gpx.renderGpx();
  f.rendering.setupStyleChangeObserver();
  f.layers.delete("zaliczgmine-communes");
  f.uploads.length = 0;

  await f.styleEvent();
  expect(f.layers.has("zaliczgmine-communes")).toBe(true);
  expect(f.uploads).toHaveLength(0);
});

test("replacing polygons or their source invalidates the commune upload cache", async () => {
  const f = await fixture();
  f.rendering.addCommunesLayers();
  f.uploads.length = 0;
  f.app.state.polygons = f.app.state.polygons.filter((item) => item.i === 1);
  f.rendering.refreshCommunesStyles();
  f.rendering.refreshCommunesStyles();
  expect(f.uploads).toEqual([{ id: "zaliczgmine-unvisited-source", features: 0 }]);

  f.sources.clear();
  f.rendering.addCommunesLayers();
  expect(f.uploads).toEqual([
    { id: "zaliczgmine-unvisited-source", features: 0 },
    { id: "zaliczgmine-unvisited-source", features: 0 },
  ]);
});

test("stored GPX tracks are uploaded once as a batch", async () => {
  const f = await fixture();
  await f.gpx.loadStoredGpx();
  expect(f.uploads).toEqual([{ id: "zaliczgmine-gpx-source", features: 3 }]);
});

test("GPX data uploads only when tracks or the source change", async () => {
  const f = await fixture();
  f.gpx.setGpx("track", "one", "1");
  f.gpx.renderGpx();
  f.gpx.setGpx("track", "replacement", "1");
  f.gpx.renderGpx();
  f.gpx.removeGpx("1");
  f.gpx.renderGpx();
  expect(f.uploads.map((upload) => upload.features)).toEqual([1, 1, 0]);
  f.sources.clear();
  f.gpx.renderGpx();
  expect(f.uploads.map((upload) => upload.features)).toEqual([1, 1, 0, 0]);
});

test("returning to active bounds invalidates a pending request for a previous viewport", async () => {
  const f = await fixture();
  const initial = f.data.getPolygonRequestForMap(f.map);
  f.data.activatePolygons(initial, f.app.state.polygons);
  f.rendering.addCommunesLayers();

  const pending = Promise.withResolvers<Polygon[]>();
  f.usePolygonResponse(pending.promise);
  f.setViewport({ north: 52, east: 21, south: 51, west: 20 });
  const refresh = f.rendering.refreshCommunesForCurrentZoom();

  f.setViewport({ north: 51.1, east: 20.1, south: 50.1, west: 19.1 });
  await f.rendering.refreshCommunesForCurrentZoom();
  pending.resolve([]);
  await refresh;

  expect(f.app.state.polygonsKey).toBe(initial.cacheKey);
  expect(f.app.state.polygons).toHaveLength(2);
});

test("small pans reuse fetched padding, but leaving it or changing detail requests new data", async () => {
  const f = await fixture();
  const initial = f.data.getPolygonRequestForMap(f.map);
  f.data.activatePolygons(initial, f.app.state.polygons);
  f.setViewport({ north: 51.1, east: 20.1, south: 50.1, west: 19.1 });
  expect(f.data.getPolygonRequestForMap(f.map).cacheKey).toBe(initial.cacheKey);
  f.setViewport({ north: 52, east: 21, south: 51, west: 20 });
  expect(f.data.getPolygonRequestForMap(f.map).cacheKey).not.toBe(initial.cacheKey);
  f.setZoom(11);
  expect(f.data.getPolygonRequestForMap(f.map).apiZoom).toBe(11);
});
