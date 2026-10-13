import { cp, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Only ship extension files; never expose source tooling or node_modules.
const assets = [
  "manifest.json",
  "_locales",
  "assets",
  "popup/popup.html",
  "THIRD_PARTY_LICENSES.txt",
];

const scripts = [
  "i18n.js",
  "logger.js",
  "message-protocol.js",
  "config.js",
  "content-script.js",
  "map-app.js",
  "popup/popup.js",
  ...Array.from(new Bun.Glob("modules/*.js").scanSync(".")),
  "lib/togeojson.js",
];

await mkdir("dist", { recursive: true });

for (const path of assets) {
  await cp(path, join("dist", path), { recursive: true });
}

const bundledScripts = [
  "modules/map-finder.js",
  "modules/planned-route.js",
  "modules/zaliczgmine-api.js",
  "modules/extension-bridge.js",
  "modules/communes-data.js",
  "modules/gpx.js",
  "map-app.js",
  "content-script.js",
  "popup/popup.js",
];

for (const path of scripts) {
  if (bundledScripts.includes(path)) continue;

  const output = join("dist", path);
  await mkdir(dirname(output), { recursive: true });
  await cp(path, output);
}

for (const path of ["src/background.ts", ...bundledScripts]) {
  const output = path === "src/background.ts" ? "background.js" : path;

  const result = await Bun.build({
    entrypoints: [path],
    outdir: join("dist", dirname(output)),
    naming: basename(output),
    target: "browser",
    format: "iife",
    minify: true,
    sourcemap: "external",
  });

  if (!result.success) throw new AggregateError(result.logs, `Could not build ${path}`);
}
