(function (global) {
  "use strict";

  const sites = [
    {
      id: "komoot",
      routeSourceId: "komoot_tour",
      matchesHost: (host) => host.includes("komoot."),
      matchesRoute: (path) =>
        /^\/tour\/[^/]+\/edit(?:\/|$)/.test(path) || /^\/plan(?:\/|$)/.test(path),
      controlsContainer: () => document.querySelector(".maplibregl-ctrl-top-left"),
    },
    {
      id: "veloplanner",
      routeSourceId: "route-arrows",
      matchesHost: (host) => host == "veloplanner.com",
      // https://veloplanner.com/pl/plan#map=6.69/51.739/19.625
      // https://veloplanner.com/pl/user-routes/168777/edit#map=6.65/53.938/19.628
      matchesRoute: (path) =>
        /^\/plan(?:\/|$)/.test(path) || /^\/user-routes\/\d+\/edit(?:\/|$)/.test(path),
      controlsContainer: () => {
        const parent = document.querySelector(".flex.flex-row.gap-3.items-end.relative");

        return parent?.querySelector(".flex.flex-row.gap-3") || parent;
      },
    },
  ];

  function getCurrentSite() {
    return sites.find((site) => site.matchesHost(location.hostname) || null);
  }

  function isSupportedPage(location) {
    const site = getCurrentSite(location);

    if (!site) return false;

    const path = location.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, "");

    return site.matchesRoute(path);
  }

  global.ZaliczGmineSites = {
    getCurrentSite,
    isSupportedPage,
  };
})(globalThis);
