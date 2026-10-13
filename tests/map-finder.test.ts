import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

interface CanvasProbe {
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
  parentElement: null;
  getBoundingClientRect: () => { width: number; height: number };
  owner?: MapProbe | { getCanvas: () => CanvasProbe; getStyle: string };
}

class MapProbe {
  constructor(readonly canvas: CanvasProbe) {}

  getCanvas() {
    return this.canvas;
  }

  getStyle() {}
  getSource() {}
  addSource() {}
  on() {}
  off() {}
}

interface FinderApp {
  state: { map: MapProbe | null };
  modules: { mapFinder?: { findMap: () => Promise<MapProbe | null> } };
}

function makeCanvas(): CanvasProbe {
  return {
    isConnected: true,
    clientWidth: 400,
    clientHeight: 300,
    parentElement: null,
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
  };
}

async function loadFinder(canvas: CanvasProbe) {
  const bundle = await Bun.build({
    entrypoints: ["modules/map-finder.js"],
    target: "browser",
    format: "iife",
  });

  if (!bundle.success || !bundle.outputs[0]) throw new Error("Could not bundle map finder");

  const app: FinderApp = { state: { map: null }, modules: {} };

  runInNewContext(await bundle.outputs[0].text(), {
    window: {
      ZaliczGmine: app,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    },
    document: { getElementsByTagName: () => [canvas] },
    TextEncoder,
    TextDecoder,
  });

  const finder = app.modules.mapFinder;

  if (!finder) throw new Error("Map finder did not install");

  return finder;
}

test("map finder preserves prototype methods and their instance receiver", async () => {
  const canvas = makeCanvas();
  const map = new MapProbe(canvas);
  canvas.owner = map;

  // Traversal must inspect descriptors without evaluating unrelated getters.
  Object.defineProperty(canvas, "unrelated", {
    get: () => {
      throw new Error("Do not read getters");
    },
  });

  const finder = await loadFinder(canvas);

  expect(await finder.findMap()).toBe(map);
});

test.each([{ owner: () => {} }, { owner: [] }])(
  "map finder accepts callable and array-backed owners",
  async ({ owner }) => {
    const canvas = makeCanvas();

    const map = Object.assign(owner, {
      canvas,
      getCanvas: MapProbe.prototype.getCanvas,
      getStyle: MapProbe.prototype.getStyle,
      getSource: MapProbe.prototype.getSource,
      addSource: MapProbe.prototype.addSource,
      on: MapProbe.prototype.on,
      off: MapProbe.prototype.off,
    });

    canvas.owner = map;

    const finder = await loadFinder(canvas);

    expect(await finder.findMap()).toBe(map);
  },
);

test("map finder rejects a partial or non-callable map interface", async () => {
  const canvas = makeCanvas();
  canvas.owner = { getCanvas: () => canvas, getStyle: "not callable" };

  const finder = await loadFinder(canvas);

  expect(await finder.findMap()).toBeNull();
});

test("map finder rejects a map belonging to a different canvas", async () => {
  const canvas = makeCanvas();
  canvas.owner = new MapProbe(makeCanvas());

  const finder = await loadFinder(canvas);

  expect(await finder.findMap()).toBeNull();
});
