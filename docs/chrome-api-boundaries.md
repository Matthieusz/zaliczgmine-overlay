# Chrome API boundaries

## Compatibility inventory

All persistence uses `chrome.storage.local`. No storage keys or message names are renamed by this migration.

| Area                | Callers before migration                          | Existing behavior                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage promises    | `content-script.js`, `popup/popup.js`             | Read `language` before initialization; popup language saves show `language.saveError` on rejection.                                                                                                                                                                                                     |
| Storage callbacks   | `content-script.js`, `popup/popup.js`             | Page reads report `storage.error` for `runtime.lastError`. Popup account saves report `account.saveError` and stop before rendering success or reloading communes. Popup account/GPX reads and GPX writes/removals did not inspect `lastError`.                                                         |
| Storage changes     | `popup/popup.js`                                  | Reload selected account only for `local` changes containing `zaliczGmineUserId` or `zaliczGmineUsername`, including key removal. Remove the listener on popup unload.                                                                                                                                   |
| Runtime send        | `content-script.js`, `modules/zaliczgmine-api.js` | Fetch callbacks consume `runtime.lastError` while it is available. Content replies with `extension.noResponse`; the API adapter creates `NetworkError({ reason: "unavailable" })`.                                                                                                                      |
| Background listener | `src/background.ts`                               | Ignore unrelated messages with `false`; malformed fetch requests respond synchronously with `api.invalidRequest` and return `false`. Valid requests return `true` and respond asynchronously; fetch workflow is bounded to 30 seconds.                                                                  |
| Content listener    | `content-script.js`                               | Unsupported routes respond synchronously with `extension.unsupportedPage` and return `false`. Supported commands return `true`, await injected scripts, forward a correlated page command, and respond or time out after 5 seconds. Remove the per-request page listener on completion/failure/timeout. |
| Tabs                | `popup/popup.js`                                  | Query the active tab in the current window. No tab means callback receives `null`. A tab message `lastError` is logged and also becomes `null`; otherwise forward its response unchanged.                                                                                                               |
| Extension URLs      | `content-script.js`                               | `runtime.getURL` resolves each injected script from the existing ordered `pageScripts` list.                                                                                                                                                                                                            |

### Persisted keys

- `language`: saved preference; recognized locales are `pl` and `en`. Absent, `auto`, or unrecognized preferences use existing browser-language resolution.
- `zaliczGmineUserId`: popup saves the selected user ID as a string.
- `zaliczGmineUsername`: popup saves the selected username; page updates it only when the stored ID still matches the loaded account.
- `zaliczGmineGpxList`: array of `{ id, name, text }` records. Popup treats a non-array value as an empty list; GPX restoration separately parses/skips invalid records. Removing all tracks removes this key.
- `visitedCommunesCount`: written by the page after loading visited communes. The old popup reader is commented out.
- `resolvedLanguage` is added to page storage responses; it is not a persisted key.

Storage reads retain Chrome's string, string-array, defaults-object, and `null` (all keys) forms. The content bridge retains `keys || null`. Storage values are opaque at the transport boundary: parsing a dictionary must not strip unrecognized keys or change nested records. Their owning workflows retain their existing interpretation.

### Message contracts

| Name                           | Payload / reply                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZALICZGMINE_FETCH`            | `{ type, url, responseType?: "json" \| "text" }`; fetch success `{ success: true, data }` or the existing safe failure reply.                   |
| `ZALICZGMINE_FETCH_REQUEST`    | Page request carries `requestId`, `url`, `responseType`.                                                                                        |
| `ZALICZGMINE_FETCH_RESPONSE`   | `{ type, requestId, response, error }`; runtime failure uses `extension.noResponse`.                                                            |
| `ZALICZGMINE_STORAGE_GET`      | `{ type, requestId, keys }`.                                                                                                                    |
| `ZALICZGMINE_STORAGE_RESPONSE` | `{ type, requestId, data, error }`; successful data includes `resolvedLanguage`; failed reads have `data: undefined`, `error: "storage.error"`. |
| `ZALICZGMINE_STORAGE_SET`      | `{ type, data }`; fire-and-forget, with no response or acknowledgement.                                                                         |
| `ZALICZGMINE_COMMAND`          | `{ type, requestId, action, data }`; actions are `getStatus`, `toggleCommunes`, `reloadVisitedCommunes`, `importGpx`, `removeGpx`.              |
| `ZALICZGMINE_COMMAND_RESPONSE` | `{ type, requestId, response }`; forward the command response unchanged.                                                                        |

Page messages are accepted only from the same window and origin. Callback APIs must read `runtime.lastError` inside the callback, including late callbacks after interruption; its presence never becomes an arbitrary user-facing browser error string.

## Storage slice

`src/chrome-storage.ts` owns the small `ChromeStorage` service and its injected Chrome capability layer. Promise methods use `Effect.tryPromise`; callback methods use Effect v4's `Effect.callback` (the v4 equivalent of `Effect.async`). API failures and malformed operation inputs/results become the existing `StorageError` with `read`, `write`, or `remove` operation. Dictionary envelopes are decoded with Schema; malformed change events are ignored.

The change listener is acquired/released in the popup's scope. Popup/content entry workflows own storage fibers through `FiberSet`; unload interrupts those workflows even while the initial language read is pending. Chrome does not expose cancellation for these operations: interruption prevents consumers from continuing, but cannot undo a write already submitted to Chrome.

Existing popup save-failure keys and GPX callback policy remain unchanged. GPX write/remove failures still continue rendering and planner commands, rather than adding a new user-facing failure policy in this migration. Failed legacy popup reads fall back to empty settings/tracks. Page writes still have no acknowledgement; failures are logged without retaining browser error text.

Tests exercise injected storage capabilities and the actual bundled content/popup entrypoints: storage keys/defaults, safe errors, malformed boundaries, late callbacks/promises, scoped listener cleanup, page response envelopes, popup change filtering, and save-failure presentation. Browser-level smoke testing remains necessary with `dist/` loaded as an unpacked extension.

## Next slice

Runtime messaging/listeners, tabs, and extension URL lookup remain unchanged. Migrate those separately, preserving the background/content `sendResponse` and literal `return true` channel lifecycle; do not make Chrome listeners themselves asynchronous functions.
