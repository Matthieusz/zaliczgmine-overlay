(function (global) {
  "use strict";

  const config = {
    layerIds: {
      routeFill: "zaliczgmine-route-fill",
      routeOutline: "zaliczgmine-route-outline",
      unvisitedFill: "zaliczgmine-communes",
      unvisitedOutline: "zaliczgmine-communes-outline",
      visitedFill: "zaliczgmine-visited",
      visitedOutline: "zaliczgmine-visited-outline",
      gpxCasing: "zaliczgmine-gpx-casing",
      gpxLine: "zaliczgmine-gpx-line",
    },
    sourceIds: {
      route: "zaliczgmine-route-source",
      unvisited: "zaliczgmine-unvisited-source",
      visited: "zaliczgmine-visited-source",
      gpx: "zaliczgmine-gpx-source",
    },
    zoom: {
      minApiZoom: 7,
      globalMaxMapZoom: 8,
      maxApiZoom: 18,
      maxCachedRequests: 40,
      boundsPaddingRatio: 0.35,
      lowZoomOutlineMaxZoom: 8,
      debounceMs: 250,
    },
    routeAnalysis: {
      apiZoom: 18,
      boundsGridSize: 0.01,
    },
    styles: {
      routeFill: { "fill-color": "#228be6", "fill-opacity": 0.22 },
      routeOutline: { "line-color": "#1971c2", "line-width": 2, "line-opacity": 0.85 },
      unvisitedFill: {
        "fill-color": "#ff6b6b",
        "fill-opacity": 0.15,
      },
      unvisitedOutline: {
        "line-color": "#ff6b6b",
        "line-width": 2,
        "line-opacity": 0.8,
      },
      visitedFill: {
        "fill-color": "#51cf66",
        "fill-opacity": 0.1,
      },
      visitedOutline: {
        "line-color": "#2f9e44",
        "line-width": 2,
        "line-opacity": 0.2,
      },
      gpxCasing: {
        "line-color": "#ffffff",
        "line-width": 7,
        "line-opacity": 0.9,
      },
      gpxLine: {
        "line-color": "#1c7ed6",
        "line-width": 4,
        "line-opacity": 0.95,
      },
    },
  };

  const state = {
    map: null,
    communesVisible: true,
    polygons: null,
    routeCommunesIds: new Set(),
    polygonsKey: null,
    userId: null,
    username: null,
    visitedCommunesSource: "none",
    visitedCommunesIds: new Set(),
  };

  global.ZaliczGmine = {
    config,
    state,
    modules: {},
  };
})(globalThis);
