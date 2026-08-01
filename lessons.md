# Engineering Lessons

## Userscript configuration scope and page-runtime bridges

- Root-cause pattern: a userscript that matches many websites used webpage `localStorage` as a bridge between its privileged sandbox and injected page code. Because Web Storage is isolated by exact origin, settings described as global silently became per-protocol, per-host, and per-port; cross-origin player frames read a different copy. Page code could also tamper with the values.
- Preventive rule: configuration whose product scope is “this installed userscript” must have one privileged userscript-storage source of truth, such as `GM_getValue` / `GM_setValue`. Injected page code receives a minimal, validated, read-only snapshot and must not read or mirror persistent configuration through page-owned storage.
- Migration rule: never promote values from an arbitrary matched page's storage into privileged global storage. When users cannot meaningfully reconcile conflicting per-origin values, omit migration UI entirely, ignore the legacy source, and start from one canonical global default.
- Consistency rule: define defaults, field names, ranges, and parsing once, then reuse that schema for the configuration UI, persisted-record normalization, and runtime snapshot. Keep global enable, per-host policy, and per-page resource limits as separate concepts and label their scopes precisely.
- Concurrency rule: one object write prevents partial field saves but is not a cross-tab transaction. Every menu or UI save must re-read the latest global record and patch only the fields it owns; after any blocking prompt, re-read again and carry forward only the exact user-confirmed intent. This prevents a stale page or confirmation window from rolling back unrelated master, Debug, runtime, or host-policy changes.
- Injection rule: a marker on the page's `window` is page-controlled and must not be a trusted kill switch. Deduplicate documents and iframe listeners in the privileged userscript realm, keep page-runtime installation idempotent, and assign one injection owner per document: matched HTTP(S) frames inject themselves, while the parent handles only inherited documents that cannot self-match.
- Validation rule: scope-sensitive persistence needs a multi-origin test, not only a syntax check or same-page refresh. Execute the real userscript with independent fake page stores and a shared fake GM store, then verify cross-origin settings, iframe payload snapshots, global and per-host policy, failure paths, and that page storage cannot override normal runtime.

Captured while correcting StreamBoost's configuration scope in July 2026. See `.agent/execplans/streamboost-global-settings.md` and `StreamBoost/tests/config-scope.test.cjs`.

## Player fullscreen ownership and layout state

- Root-cause pattern: fullscreening an outer wrapper can preserve the visible player subtree but bypass the player's own fullscreen state. YFSP only applies its `native-fullscreen` layout to `vg-player`; fullscreening `aa-videoplayer` therefore required brittle height overrides and could leave the controls or video in the upper part of the screen.
- Preventive rule: choose the smallest fullscreen owner that still contains the video, overlays, danmu, and controls. Prefer the component that owns the site's fullscreen state, and keep outer wrappers only as structural fallbacks.
- State-marker rule: do not make fullscreen recovery depend on a custom class surviving on a framework-owned component. Identify the active player from `document.fullscreenElement` and its semantic selector, and use dedicated `data-*` attributes for temporary styling state when the framework rewrites the component's class set.
- Validation rule: test more than the fullscreen root dimensions. Confirm the site's fullscreen-state class, the video and overlay rectangles, control placement at the viewport edge, aspect-ratio controls, and that the rendered media remains the original `<video>` element for driver features such as NVIDIA VSR.

Captured while correcting YFSP container fullscreen behavior in August 2026. See `yfsp/yfsp-unlocker.js` and `yfsp/README.md`.
