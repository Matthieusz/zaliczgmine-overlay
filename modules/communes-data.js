import { AccountError } from "../src/user-errors.ts";

(function (app) {
  "use strict";

  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("communes-data");

  const polygonsByRequest = new Map();
  const pendingPolygonRequests = new Map();
  let activePolygonRequest = null;
  const { zoom: zoomConfig } = app.config;
  const { fetchResource, getStorage, setStorage } = app.modules.extensionBridge;

  const api = globalThis.createZaliczGmineApi(fetchResource);

  async function loadVisitedCommunesFromApi(userId) {
    const data = await api.getVisitedCommunes(userId, "pl");

    const communesIds = new Set(data.items.map((item) => String(item.id)));
    log.debug("Visited communes loaded", { count: communesIds.size });
    app.state.visitedCommunesIds = communesIds;
    app.state.visitedCommunesSource = "api";
    app.state.userId = String(userId);
    app.state.username = data.user?.username || null;
    setStorage({ visitedCommunesCount: data.count });

    // update only if name is stillthe same as selected account.
    const storage = await getStorage(["zaliczGmineUserId"]);

    if (String(storage.zaliczGmineUserId) === String(userId) && data.user?.username) {
      setStorage({ zaliczGmineUsername: data.user.username });
    }

    return communesIds;
  }

  async function loadVisitedCommunes() {
    const storage = await getStorage(["zaliczGmineUserId"]);

    return reloadVisitedCommunes(storage.zaliczGmineUserId);
  }

  async function reloadVisitedCommunes(userId) {
    const normalizedId = userId ? String(userId).trim() : "";

    // only numeric user ID
    if (!/^\d+$/.test(normalizedId)) {
      throw new AccountError({ reason: normalizedId ? "invalid" : "missing" });
    }

    return loadVisitedCommunesFromApi(normalizedId);
  }

  function getApiZoomForMapZoom(mapZoom) {
    const zoom = Number.isFinite(mapZoom) ? mapZoom : zoomConfig.minApiZoom;

    if (zoom <= zoomConfig.globalMaxMapZoom) {
      return zoomConfig.minApiZoom;
    }

    const roundedZoom =
      zoom > zoomConfig.minApiZoom
        ? Math.max(zoomConfig.minApiZoom + 1, Math.floor(zoom))
        : zoomConfig.minApiZoom;

    return Math.max(zoomConfig.minApiZoom, Math.min(zoomConfig.maxApiZoom, roundedZoom));
  }

  function getGridPrecision(apiZoom) {
    if (apiZoom <= 9) return 1;

    if (apiZoom <= 11) return 2;

    if (apiZoom <= 13) return 3;

    return 4;
  }

  function roundToGrid(value, precision) {
    const factor = 10 ** precision;

    return Math.round(value * factor) / factor;
  }

  function normalizeBounds(bounds) {
    const north = bounds.getNorth();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const latPadding = (north - south) * zoomConfig.boundsPaddingRatio;
    const lngPadding = (east - west) * zoomConfig.boundsPaddingRatio;

    return {
      north: north + latPadding,
      east: east + lngPadding,
      south: south - latPadding,
      west: west - lngPadding,
    };
  }

  function getCacheBounds(bounds, apiZoom) {
    const precision = getGridPrecision(apiZoom);

    return {
      north: Number(roundToGrid(bounds.north, precision).toFixed(precision)),
      east: Number(roundToGrid(bounds.east, precision).toFixed(precision)),
      south: Number(roundToGrid(bounds.south, precision).toFixed(precision)),
      west: Number(roundToGrid(bounds.west, precision).toFixed(precision)),
    };
  }

  function getPolygonRequestForMap(map) {
    const apiZoom = getApiZoomForMapZoom(map.getZoom());

    if (apiZoom <= zoomConfig.globalMaxMapZoom) {
      return {
        apiZoom: zoomConfig.minApiZoom,
        cacheKey: `polygons:${zoomConfig.minApiZoom}`,
      };
    }

    const viewport = map.getBounds();
    const activeBounds = activePolygonRequest?.bounds;

    // The fetched area includes padding. Keep it until the visible viewport
    // leaves that area, instead of fetching another overlapping set per pan.
    if (
      app.state.polygons &&
      activePolygonRequest &&
      activePolygonRequest.cacheKey === app.state.polygonsKey &&
      activePolygonRequest.apiZoom === apiZoom &&
      activeBounds &&
      viewport.getNorth() <= activeBounds.north &&
      viewport.getEast() <= activeBounds.east &&
      viewport.getSouth() >= activeBounds.south &&
      viewport.getWest() >= activeBounds.west
    ) {
      return activePolygonRequest;
    }

    const bounds = normalizeBounds(viewport);
    const cacheBounds = getCacheBounds(bounds, apiZoom);

    return {
      apiZoom,
      bounds: cacheBounds,
      cacheKey: `polygons:${apiZoom}:${cacheBounds.north}:${cacheBounds.east}:${cacheBounds.south}:${cacheBounds.west}`,
    };
  }

  function rememberPolygons(cacheKey, polygons) {
    if (polygonsByRequest.has(cacheKey)) {
      polygonsByRequest.delete(cacheKey);
    }

    polygonsByRequest.set(cacheKey, polygons);

    let attempts = 0;
    const maxAttempts = polygonsByRequest.size + 2;

    while (polygonsByRequest.size > zoomConfig.maxCachedRequests && attempts++ < maxAttempts) {
      const oldestKey = polygonsByRequest.keys().next().value;

      if (
        oldestKey === cacheKey ||
        oldestKey === app.state.polygonsKey ||
        oldestKey === `polygons:${zoomConfig.minApiZoom}`
      ) {
        const oldestPolygons = polygonsByRequest.get(oldestKey);
        polygonsByRequest.delete(oldestKey);
        polygonsByRequest.set(oldestKey, oldestPolygons);
        continue;
      }

      polygonsByRequest.delete(oldestKey);
    }
  }

  async function fetchPolygons(request) {
    if (polygonsByRequest.has(request.cacheKey)) {
      log.debug("Using cached communes", { apiZoom: request.apiZoom });
      const cachedPolygons = polygonsByRequest.get(request.cacheKey);
      rememberPolygons(request.cacheKey, cachedPolygons);

      return cachedPolygons;
    }

    if (pendingPolygonRequests.has(request.cacheKey)) {
      log.debug("Sharing in-flight commune request", { apiZoom: request.apiZoom });

      // Share the same error handling as the original caller.
      return pendingPolygonRequests.get(request.cacheKey).catch(() => null);
    }

    try {
      const pendingRequest = api
        .getPolygons(request.apiZoom, "pl", request.bounds)
        .then((items) => {
          rememberPolygons(request.cacheKey, items);
          log.debug(`Fetched ${items.length} communes at zoom=${request.apiZoom}`);

          return items;
        });

      pendingPolygonRequests.set(request.cacheKey, pendingRequest);

      return await pendingRequest;
    } catch (error) {
      log.error(`Could not fetch communes at zoom=${request.apiZoom}:`, error);

      return null;
    } finally {
      pendingPolygonRequests.delete(request.cacheKey);
    }
  }

  async function fetchRoutePolygons(lines) {
    const { apiZoom, boundsGridSize } = app.config.routeAnalysis;

    let north = -Infinity,
      east = -Infinity,
      south = Infinity,
      west = Infinity;

    for (const line of lines) {
      for (const [lng, lat] of line) {
        north = Math.max(north, lat);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        west = Math.min(west, lng);
      }
    }

    if (!Number.isFinite(north)) return [];

    // Round outwards with a small margin: never cut off a route endpoint.
    // Nearby route edits share the existing request cache and in-flight fetch.
    const lower = (value) => (Math.floor(value / boundsGridSize) - 1) * boundsGridSize;
    const upper = (value) => (Math.ceil(value / boundsGridSize) + 1) * boundsGridSize;

    const bounds = {
      north: Math.min(90, upper(north)),
      east: Math.min(180, upper(east)),
      south: Math.max(-90, lower(south)),
      west: Math.max(-180, lower(west)),
    };

    const polygons = await fetchPolygons({
      apiZoom,
      bounds,
      cacheKey: `route-polygons:${apiZoom}:${bounds.north}:${bounds.east}:${bounds.south}:${bounds.west}`,
    });

    if (!polygons) throw new Error(t("communes.boundariesError"));

    return polygons;
  }

  function activatePolygons(request, polygons) {
    log.debug("Activating commune boundaries", {
      apiZoom: request.apiZoom,
      count: polygons.length,
    });
    activePolygonRequest = request;
    app.state.polygonsKey = request.cacheKey;
    app.state.polygons = polygons;
  }

  function convertToGeoJSON(items, filterVisited = null) {
    const features = [];

    for (const item of items) {
      try {
        const visited = app.state.visitedCommunesIds.has(String(item.i));

        if (filterVisited !== null && visited !== filterVisited) continue;

        const geometry = globalThis.ZaliczGmineCommunesGeometry.toGeoJSON(item);

        if (!geometry) throw new Error(t("communes.invalidGeometry"));

        features.push({
          type: "Feature",
          properties: {
            id: item.i,
            name: item.n,
            visited,
          },
          geometry,
        });
      } catch {
        log.warn(`Skipped invalid polygon for commune ${item.i}`);
      }
    }

    return { type: "FeatureCollection", features };
  }

  app.modules.communesData = {
    loadVisitedCommunes,
    reloadVisitedCommunes,
    getApiZoomForMapZoom,
    getPolygonRequestForMap,
    fetchPolygons,
    fetchRoutePolygons,
    activatePolygons,
    convertToGeoJSON,
  };
})(window.ZaliczGmine);
