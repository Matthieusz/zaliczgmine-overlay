# Project instructions

This is a Chromium Manifest V3 map-overlay extension for Komoot and VeloPlanner.

- Use Bun (`bun install`, `bun run check`, `bun run build`).
- Oxlint enables Dillon Mulroy's generic and Effect anti-slop rules; Oxfmt owns formatting. Use `bun run lint`, `bun run lint:fix`, `bun run format`, and `bun run format:check`.
- Keep lint/format checks passing. Do not suppress rules to hide findings or mix semantic changes into formatting-only cleanup.
- Vendored rules live in `tools/oxlint/anti-slop/`; retain their licenses and provenance. Upgrade `oxlint` and `@oxlint/plugins` together at the same exact version.
- Load `dist/` as the unpacked extension; never hand-edit generated files.
- New application code belongs in `src/` and must pass strict TypeScript checks.
- Existing JavaScript UI/map adapters remain during the incremental migration and are not yet typechecked. Map discovery and route observation are bundled for Effect Schema imports; the other JavaScript is copied into `dist/`.
- Preserve message names, stored settings, localization, and planner behavior when migrating.
- Keep geometry pure. Decode unknown values at boundaries with Schema, model expected failures with `Schema.TaggedError`, and use `Effect.gen` / named `Effect.fn` workflows.
- The TypeScript 7 compiler is patched by `@effect/tsgo`; `prepare` reapplies this on installation.
- Never create commits or push unless explicitly requested.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.
<!-- effect-solutions:end -->

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation details when documentation isn't enough.
The installed `effect` package is authoritative when the reference checkout or CLI guides differ from its APIs.
