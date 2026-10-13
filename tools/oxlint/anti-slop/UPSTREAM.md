# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (Dillon Mulroy)
- Verified source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Installed from the local `install-anti-slop` skill's `assets/anti-slop/` bundle.
- Generic plugin: `tools/oxlint/anti-slop/index.ts`
- Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

Every bundled source file was compared byte-for-byte against `src/` at the commit above. No production differences were found. Upstream test files are not included in the skill bundle and were not copied. The root MIT license was copied from the verified upstream checkout. This provenance file is the only other addition; no rules were modified.

The nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` are retained verbatim; preserve both when updating. These plugins are development tooling and are not shipped in the extension build.

Both generic and Effect-specific rules are enabled at error severity. Package/path-alias service-constructor imports remain outside the Effect plugin's current analysis; relative project imports are covered.
