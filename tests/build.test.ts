import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";

const Manifest = Schema.Struct({
  background: Schema.Struct({ service_worker: Schema.String }),
  content_scripts: Schema.Array(Schema.Struct({ js: Schema.Array(Schema.String) })),
  web_accessible_resources: Schema.Array(Schema.Struct({ resources: Schema.Array(Schema.String) })),
  action: Schema.Struct({ default_popup: Schema.String }),
});

// Run after bun run build to verify Chrome can resolve every manifest and popup script.
test.skipIf(!existsSync("dist/manifest.json"))(
  "built extension contains every declared script and resource",
  async () => {
    const input: unknown = await Bun.file("dist/manifest.json").json();
    const manifest = await Effect.runPromise(Schema.decodeUnknownEffect(Manifest)(input));

    const scripts: string[] = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((entry) => entry.js),
      ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
      manifest.action.default_popup,
      "THIRD_PARTY_LICENSES.txt",
      "_locales/en/messages.json",
      "_locales/pl/messages.json",
    ];

    for (const script of scripts) expect(existsSync(join("dist", script))).toBe(true);
    const popup = await Bun.file("dist/popup/popup.html").text();

    for (const match of popup.matchAll(/<script src="([^"]+)"/g)) {
      const path = match[1];

      if (path === undefined) throw new Error("Missing script path");
      expect(existsSync(join("dist/popup", path))).toBe(true);
    }
  },
);
