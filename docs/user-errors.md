# User-visible failure scope

`src/user-errors.ts` defines the expected failure vocabulary and its exhaustive,
safe localization-key projection. Render with `t(userErrorMessageKey(error))` in
the current UI language. Do not render `error.message`, causes, API messages,
URLs, account identifiers, GPX content, or stored values.

## Inventory and classification

| Failure                                          | Existing boundary                                                                    | Expected error   | Safe message key                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------ |
| Network rejection, body read failure, timeout    | `src/fetch-resource.ts`, `modules/extension-bridge.js`, `modules/zaliczgmine-api.js` | `NetworkError`   | `api.fetchError`, `extension.noResponse`         |
| HTTP/API rejection                               | `src/fetch-resource.ts`, `modules/zaliczgmine-api.js`                                | `ApiError`       | Allowlisted API key, otherwise `api.error`       |
| Malformed JSON or invalid endpoint data/geometry | `src/fetch-resource.ts`, API/data adapters                                           | `InvalidApiData` | `api.invalidResponse`                            |
| Missing/invalid selected account                 | Account workflow                                                                     | `AccountError`   | `account.selectInExtension`, `account.invalidId` |
| Map absent or style not ready                    | `map-app.js`, map adapters                                                           | `MapNotReady`    | `map.connectionError`                            |
| Empty/malformed GPX or no route/track            | `modules/gpx.js`                                                                     | `InvalidGpx`     | `gpx.invalidFile`, `gpx.noTrack`                 |
| Storage read/write/remove failure                | `content-script.js`, `modules/extension-bridge.js`, `popup/popup.js`                 | `StorageError`   | `storage.error`                                  |

## Boundary policy

- Decode unknown API and persisted inputs with Schema. Map schema failures at
  the owning boundary, not arbitrary exceptions throughout a workflow.
- Translate documented external failures only at the adapter that understands
  them. Keep `Effect.tryPromise` callbacks limited to the external operation;
  avoid wrapping application logic in a blanket recoverable-error conversion.
- Detect interruption/cancellation before classification. Cancellation is not a
  user failure and must not produce a failure notification or retry.
- Bugs, invariant violations, unexpected throws, and unexpected rejected values
  remain defects. Use typed-error recovery for expected failures only. At a UI
  entry boundary, defects may produce a generic safe notification while remaining
  defects for diagnostics; never relabel them as one of these expected errors.
- Project only the tag and explicit safe fields across runtime/page messages;
  decode again on receipt. Never serialize arbitrary causes or provider text.
- Storage writes/removals need acknowledgement before reporting success. The
  current page bridge's fire-and-forget write cannot truthfully report failure.
- Preserve existing message names, storage keys, planner behavior, and language
  selection when integrating this vocabulary.

## Integrated presentation boundaries

Background fetch, API, page bridge, command responses, and popup presentation no
longer forward exception/provider text. Failure replies retain `success` and
`error`, but `error` is now an allowlisted localization key. Expected failures
also include an explicit Schema-encoded `failure` DTO; receivers decode it before
rethrowing. Unknown remote failures remain ordinary exceptions, not fabricated
expected errors. The popup allowlists keys before translating in its own language.

GPX and account validation now use the tagged vocabulary. The background uses
typed network/API/data errors; unexpected transport exceptions remain Effect
defects, with a safe generic response at the runtime entry boundary. Browser
fetch TypeError rejections are classified only around transport/body reads.
Storage reads check Chrome's lastError and expose only a safe storage failure.

Legacy workflows remain JavaScript promise adapters, not fully migrated Effect
services. Endpoint-specific decoding, acknowledged storage writes/removals, and
comprehensive defect diagnostics remain follow-up work. Load `dist/`: adapters
that import the vocabulary now require bundling.
