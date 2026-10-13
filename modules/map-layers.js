(function (app) {
  "use strict";

  const { t } = globalThis.ZaliczGmineI18n;
  const log = globalThis.ZaliczGmineLogger.create("map-layers");

  const { layerIds, sourceIds, styles, zoom: zoomConfig } = app.config;
  const SHOW_VISITED_COMMUNES = false;

  const activeCommunesLayerIds = [
    layerIds.unvisitedFill,
    layerIds.unvisitedOutline,
    ...(SHOW_VISITED_COMMUNES ? [layerIds.visitedFill, layerIds.visitedOutline] : []),
  ];

  let latestPolygonRequestId = 0;
  let styleObserverAttached = false;
  let zoomObserverAttached = false;
  let restoringStyle = false;

  const renderedCommunes = new WeakMap();

  function setMapboxSource(sourceId, filterVisited) {
    let source = app.state.map.getSource(sourceId);
    const { polygons, visitedCommunesIds } = app.state;
    const previous = source && renderedCommunes.get(source);

    // Both collections are replaced by communes-data, not mutated in place.
    // Source identity invalidates the snapshot after a planner style reset.
    if (previous?.polygons === polygons && previous.visitedCommunesIds === visitedCommunesIds)
      return;

    const data = app.modules.communesData.convertToGeoJSON(polygons, filterVisited);

    if (source) {
      source.setData(data);
    } else {
      app.state.map.addSource(sourceId, { type: "geojson", data });
      source = app.state.map.getSource(sourceId);
    }

    renderedCommunes.set(source, { polygons, visitedCommunesIds });
  }

  function findInsertBeforeLayer() {
    const style = app.state.map.getStyle();

    if (!style || !style.layers) return null;

    const labelTypes = ["label", "poi", "place", "road-label"];

    const layer = style.layers.find((styleLayer) =>
      labelTypes.some((type) => styleLayer.id.toLowerCase().includes(type)),
    );

    return layer ? layer.id : null;
  }

  function removeLayers() {
    for (const layerId of activeCommunesLayerIds) {
      if (app.state.map.getLayer(layerId)) app.state.map.removeLayer(layerId);
    }
  }

  function allLayersExist() {
    return activeCommunesLayerIds.every((layerId) => app.state.map.getLayer(layerId));
  }

  function shouldShowCommunesOutlines() {
    return app.state.map.getZoom() > zoomConfig.lowZoomOutlineMaxZoom;
  }

  function addLayer(layerConfig, beforeLayer) {
    const layout = {
      visibility: app.state.communesVisible ? "visible" : "none",
    };

    app.state.map.addLayer({ ...layerConfig, layout }, beforeLayer);
  }

  function addCommunesLayers() {
    log.debug("Creating commune layers");

    if (!app.state.map || !app.state.polygons) return;

    const beforeLayer = app.state.map.getLayer(layerIds.routeFill)
      ? layerIds.routeFill
      : findInsertBeforeLayer();

    updateCommunesSources();

    removeLayers();

    addLayer(
      {
        id: layerIds.unvisitedFill,
        type: "fill",
        source: sourceIds.unvisited,
        paint: styles.unvisitedFill,
      },
      beforeLayer,
    );

    addLayer(
      {
        id: layerIds.unvisitedOutline,
        type: "line",
        source: sourceIds.unvisited,
        paint: {
          ...styles.unvisitedOutline,
          "line-opacity": shouldShowCommunesOutlines()
            ? styles.unvisitedOutline["line-opacity"]
            : 0,
        },
      },
      beforeLayer,
    );

    if (SHOW_VISITED_COMMUNES) {
      addLayer(
        {
          id: layerIds.visitedFill,
          type: "fill",
          source: sourceIds.visited,
          paint: styles.visitedFill,
        },
        beforeLayer,
      );

      addLayer(
        {
          id: layerIds.visitedOutline,
          type: "line",
          source: sourceIds.visited,
          paint: styles.visitedOutline,
        },
        beforeLayer,
      );
    }
  }

  function updateCommunesSources() {
    if (!app.state.map || !app.state.polygons) return;

    if (SHOW_VISITED_COMMUNES) {
      setMapboxSource(sourceIds.visited, true);
    }

    setMapboxSource(sourceIds.unvisited, false);
  }

  function refreshCommunesStyles() {
    updateUserSummary();
    app.modules.plannedRoute?.render();

    if (!app.state.map) return;

    if (allLayersExist()) {
      updateCommunesSources();
      toggleLayers(app.state.communesVisible, false);
    }
  }

  async function refreshCommunesForCurrentZoom() {
    if (!app.state.map) return;

    if (!app.state.communesVisible) return;
    updateOutlineVisibility();

    const { getPolygonRequestForMap, fetchPolygons, activatePolygons } = app.modules.communesData;
    const request = getPolygonRequestForMap(app.state.map);
    // Even reuse invalidates a pending result for a viewport we have left.
    const requestId = ++latestPolygonRequestId;

    if (request.cacheKey === app.state.polygonsKey && app.state.polygons) return;
    const polygons = await fetchPolygons(request);

    if (!app.state.communesVisible || !polygons || requestId !== latestPolygonRequestId) return;

    activatePolygons(request, polygons);

    if (allLayersExist()) {
      updateCommunesSources();
      toggleLayers(app.state.communesVisible, false);
    } else {
      addCommunesLayers();
    }
  }

  function toggleLayers(visible, refreshVisibleLayers = true) {
    log.debug("Changing commune visibility", { visible });
    app.state.communesVisible = visible;
    const visibility = visible ? "visible" : "none";

    for (const layerId of activeCommunesLayerIds) {
      if (app.state.map && app.state.map.getLayer(layerId)) {
        app.state.map.setLayoutProperty(layerId, "visibility", visibility);
      }
    }

    updateToggleButton();
    updateOutlineVisibility();
    app.modules.plannedRoute?.setVisible(visible);

    if (visible && refreshVisibleLayers) {
      refreshCommunesForCurrentZoom();
    }
  }

  function updateOutlineVisibility() {
    if (!app.state.map) return;

    const outlineOpacity = shouldShowCommunesOutlines()
      ? styles.unvisitedOutline["line-opacity"]
      : 0;

    if (app.state.map.getLayer(layerIds.unvisitedOutline)) {
      app.state.map.setPaintProperty(layerIds.unvisitedOutline, "line-opacity", outlineOpacity);
    }
  }

  function updateToggleButton() {
    const button = document.getElementById("zaliczgmine-toggle");

    if (!button) return;

    const visible = app.state.communesVisible;
    button.style.background = visible ? "#348b42" : "#b8c0ba";
    button.setAttribute("aria-label", t("communes.boundaries"));
    button.setAttribute("aria-checked", String(visible));
    button.title = visible ? t("communes.hideBoundaries") : t("communes.showBoundaries");
    button.firstElementChild.style.transform = visible ? "translateX(16px)" : "translateX(0)";
  }

  function updateUserSummary() {
    const summary = document.getElementById("zaliczgmine-user-summary");

    if (!summary) return;

    const hasUser = app.state.visitedCommunesSource !== "none";

    const username = hasUser
      ? app.state.username || `ID: ${app.state.userId}`
      : globalThis.ZaliczGmineI18n.brand();

    const count = app.state.visitedCommunesIds.size;
    summary.querySelector("[data-username]").textContent = username;
    summary.querySelector("[data-count]").textContent = hasUser
      ? t("communes.visitedCount", {
          count: count.toLocaleString(globalThis.ZaliczGmineI18n.language),
        })
      : t("account.selectInExtension");
    summary.title = hasUser
      ? t("account.mapSummary", { username, count })
      : globalThis.ZaliczGmineI18n.brand();
  }

  function addToggleButton() {
    const site = globalThis.ZaliczGmineSites.getCurrentSite(location);
    const mapControls = site?.controlsContainer();

    // const mapControls = document.querySelector('.maplibregl-ctrl-top-left, .mapboxgl-ctrl-top-left');
    if (!mapControls || document.getElementById("zaliczgmine-toggle")) return;

    const buttonContainer = document.createElement("div");
    buttonContainer.className = "maplibregl-ctrl";
    buttonContainer.style.cssText = `
      display: flex; align-items: center; gap: 14px;
      box-sizing: border-box; max-width: min(280px, 70vw);
      margin-top: 1rem; padding: 10px 12px;
      border: 1px solid rgba(35, 60, 40, 0.10); border-radius: 12px;
      background: rgba(255, 255, 255, 0.97);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.10);
      pointer-events: auto;
    `;

    const button = document.createElement("button");
    button.id = "zaliczgmine-toggle";
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", t("communes.boundaries"));
    button.style.cssText = `
      position: relative; flex: 0 0 40px; width: 40px; height: 24px;
      min-width: 40px; min-height: 24px; margin: 0; padding: 3px;
      border: 0; border-radius: 999px; cursor: pointer;
      transition: background 150ms ease;
    `;
    const thumb = document.createElement("span");
    thumb.setAttribute("aria-hidden", "true");
    thumb.style.cssText = `
      display: block; width: 18px; height: 18px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      transition: transform 150ms ease; pointer-events: none;
    `;
    button.appendChild(thumb);
    button.addEventListener("focus", () => {
      button.style.outline = "2px solid #246b31";
      button.style.outlineOffset = "3px";
    });
    button.addEventListener("blur", () => {
      button.style.outline = "";
    });
    button.addEventListener("click", () => toggleLayers(!app.state.communesVisible));

    const summary = document.createElement("div");
    summary.id = "zaliczgmine-user-summary";
    summary.setAttribute("role", "status");
    summary.setAttribute("aria-live", "polite");
    summary.style.cssText = `
      min-width: 0; color: #28332b; font: 12px/1.5 Arial, sans-serif;
    `;
    const name = document.createElement("div");
    name.setAttribute("data-username", "");
    name.style.cssText =
      "font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const count = document.createElement("div");
    count.setAttribute("data-count", "");
    count.style.cssText = "font-size: 11px; color: #52705a;";
    summary.appendChild(name);
    summary.appendChild(count);

    buttonContainer.appendChild(summary);
    buttonContainer.appendChild(button);
    mapControls.appendChild(buttonContainer);
    updateToggleButton();
    updateUserSummary();
  }

  async function waitForStyleLoad() {
    if (!app.state.map) return;

    while (!app.state.map.isStyleLoaded()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function setupStyleChangeObserver() {
    if (!app.state.map || styleObserverAttached) return;

    const restoreLayers = () => {
      // Style mutations emit styledata too. Restore only missing layers, and
      // let the next ready event handle loading instead of starting pollers.
      if (restoringStyle || !app.state.map.isStyleLoaded() || !app.state.polygons) return;
      restoringStyle = true;

      try {
        if (!allLayersExist()) addCommunesLayers();
        app.modules.gpx.renderGpx();
      } finally {
        restoringStyle = false;
      }
    };

    styleObserverAttached = true;
    app.state.map.on("styledata", restoreLayers);
    // Sources may finish loading after the last styledata event.
    app.state.map.on("idle", restoreLayers);
  }

  function setupZoomObserver() {
    if (!app.state.map || zoomObserverAttached) return;

    let debounceId = null;

    const scheduleRefresh = () => {
      window.clearTimeout(debounceId);
      debounceId = window.setTimeout(refreshCommunesForCurrentZoom, zoomConfig.debounceMs);
    };

    zoomObserverAttached = true;
    app.state.map.on("zoomend", scheduleRefresh);
    app.state.map.on("moveend", scheduleRefresh);
  }

  function showNotification(message) {
    const existing = document.getElementById("zaliczgmine-notification");

    if (existing) existing.remove();

    const notification = document.createElement("div");
    notification.id = "zaliczgmine-notification";
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #51cf66 0%, #2f9e44 100%);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: 'Segoe UI', sans-serif;
      font-size: 14px;
      z-index: 999999;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
    `;
    document.body.appendChild(notification);
    setTimeout(() => {
      if (notification.parentElement) notification.remove();
    }, 4000);
  }

  app.modules.mapLayers = {
    addCommunesLayers,
    addToggleButton,
    refreshCommunesForCurrentZoom,
    refreshCommunesStyles,
    setupStyleChangeObserver,
    setupZoomObserver,
    showNotification,
    toggleLayers,
    waitForStyleLoad,
  };
})(window.ZaliczGmine);
