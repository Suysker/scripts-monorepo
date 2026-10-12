# StreamBoost 🚀

[简体中文](README.md) | [English](README.en.md)

> **A streaming userscript with larger buffers, concurrent prefetching, memory caching, request reuse, and per-host controls.**
> For players using **HLS.js**.

![License](https://img.shields.io/github/license/Suysker/scripts-monorepo?style=flat-square) ![Downloads](https://img.shields.io/greasyfork/dt/507274?style=flat-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-red?style=flat-square)

---

## 📁 Repository location (Monorepo)

- [Monorepo root](../)
- [Project directory](./)
- [GitHub repository](https://github.com/Suysker/scripts-monorepo)

---

## 🐣 Why StreamBoost exists

Many sites use **conservative buffering settings** for on-demand video and live streams. They download only a short distance ahead, so even a brief network slowdown can interrupt playback. Some sites also load HLS segments **one at a time**, which makes high latency and rate limits more noticeable.

Custom loaders and XHR handling can make downloads appear sequential even when HTTP/2 supports multiplexing. Occasional 403 or CORS failures can leave the player retrying for a long time.

**StreamBoost** improves segment prefetching and caching while preserving the website's player and page behavior. It downloads concurrently where possible, reuses available data, and cancels requests that are no longer needed to help reduce interruptions.

---

## 🌟 Main features

* **Parallel prefetching**: Keeps downloading toward the configured time target. By default, each batch contains up to 12 segments; another batch follows when it finishes. The script can keep downloading within the target window even when the player temporarily stops filling its own buffer.
  With standard request settings, the selected strategy determines the order in which XHR, the original Loader, and fetch are tried. If a custom Loader or request setup is detected, prefetching uses only the original Loader to preserve the site's authentication and request behavior. Authentication or rate-limit failures do not trigger repeated attempts through other transports.
* **Reuse of requests in progress**: When a segment the player needs is already being downloaded, the player briefly waits for that result instead of making a duplicate request.
* **Reuse of downloaded content**: Normal playback and prefetching share one cache of complete segments. While valid data remains cached, seeking, switching quality and back, or rebinding the player to the video can reuse it and reduce repeated downloads.
  Content near the playback position takes priority. Downloaded copies are kept even after the player has received them, so they can help restore playback after the player clears its buffer. Above the cache reference size, played content and content outside the target window are removed first; complete segments inside the target window can still be cached.
* **Cancellation of outdated prefetches**: Seeking, quality changes, and source changes cancel prefetches that fall outside the new download target, saving bandwidth and time.
* **HLS buffer enhancement**: Raises the player's forward buffer target while preserving larger settings already supplied by the site. If buffer capacity runs out, the player first reduces its target. As playback continues and old content is released, the script cautiously tries to restore it in small steps. Another capacity error increases the waiting period to avoid repeatedly filling the buffer. Existing live synchronization settings are preserved.
* **Global settings**: Parameters, the global switch, and Debug mode are stored in the userscript manager's GM storage and shared by all matching sites in the same script installation.
* **Per-host controls**: Host disable rules are independent of the global switch. A rule applies only to documents whose hostname matches it.
* **Consistent iframe settings**: Top-level pages, same-origin iframes, and cross-origin iframes independently injected through `@match` read the same global configuration.
* **Debug logs**: Inspect cache hits, invalidation reasons, and player buffer state. Recent diagnostic events are kept in a bounded queue and exclude full media URLs and request credentials.

---

## 📥 Installation

1. Install the **Tampermonkey** browser extension or a compatible userscript manager.
2. Open `StreamBoost/StreamBoost.js` and select **Raw** to install it, or install it from Greasy Fork.
3. Refresh a page containing a supported player.

[Install from the raw script](https://raw.githubusercontent.com/Suysker/scripts-monorepo/main/StreamBoost/StreamBoost.js)

> Supported browsers: modern Chrome, Edge, and Firefox. Safari may require additional extension permissions.

---

## ⚙️ Menu and controls

After installation, the Tampermonkey menu for the page provides these commands:

* `🔌 Global status: Enabled` / `🔌 Global status: Disabled`
* `⛔ Disable on this host` / `✅ Remove disable rules for this host`
* `⚙️ Open settings`
* `🐞 Debug logging: Enabled` / `🐞 Debug logging: Disabled`

The global switch, Debug mode, and settings are shared across matching sites and iframes. The current-hostname command changes only the rule for the current document's hostname. Rules ignore the protocol and port, distinguish subdomains, and support IPv4 and IPv6 hostnames. A cross-origin player iframe has its own document hostname, so disabling only the top-level site does not automatically disable that iframe.

> Saving settings or changing a menu switch does not update Hls instances that already exist. Refresh each top-level page or iframe that should use the new settings. Newly opened matching pages read the latest configuration automatically.

---

## 🛠 Global settings (GM storage)

Use **Open settings** to edit parameters in the floating settings panel. The configuration is stored in the userscript manager's GM storage rather than any website's own storage. After saving on site A, site B and both same-origin and cross-origin iframes use the same settings when refreshed.

The panel provides sliders, option buttons, and enable/disable buttons, grouped under `Prefetching`, `Buffering and memory`, and `Requests and switches`. **Reset defaults** resets only the runtime parameters shown in the panel. The global switch and hostname rules remain under their own menu commands. Select **Save global settings** after making changes, then refresh the pages where they should apply.

Menus and the settings panel support Chinese and English. The default follows the browser's primary language: Chinese uses Chinese, and all other languages use English. You can also select **Follow browser**, **中文**, or **English** under **Language / 界面语言**. The language choice is saved with the parameters and takes effect after refreshing. **Reset defaults** keeps your language choice.

### Controls and scope

| Control | Where it is saved | Effect |
| --- | --- | --- |
| Global status | Entire script installation | When disabled, StreamBoost stops injecting into matching sites and iframes after refresh |
| Debug logging | Entire script installation | Enables or disables logs across matching sites and iframes after refresh |
| Settings panel | Entire script installation | All matching sites and iframes read the same parameters |
| Language / 界面语言 | Entire script installation | Menus and settings use the selected browser language, Chinese, or English |
| Enable/disable current hostname | Global hostname rule list | Determines whether matching document hostnames are injected, without changing the global switch |

### Settings panel: general switches

| Setting | Description | Default |
| --- | --- | --- |
| Parallel prefetching | Continues downloading upcoming segments | Enabled |
| Memory cache (fLoader) | Reuses the page context's LRU cache and requests in progress | Enabled |

### Settings panel: advanced parameters

| Setting | Range / description | Default |
| --- | --- | --- |
| Segments per batch (0 disables prefetching) | `0–60`; another batch follows when one finishes, so batch size does not shorten the time target; `0` disables prefetching | `12` |
| Page prefetch concurrency limit | `1–16`; applies independently within each top-level page or iframe context | `4` |
| Per-origin prefetch limit | `1–16`; limits concurrent prefetches to a single segment resource origin | `4` |
| Prefetch timeout (ms) | `1000–120000 ms` | `15000 ms` |
| Wait for an in-flight download (ms) | `0–10000 ms` | `500 ms` |
| Prefetch strategy | Order in which XHR, the Hls Loader, and fetch are tried | `xhr-hls-fetch` |
| Prefetch target (seconds) | `5–7200 seconds`; synchronized with the next two settings; controls how far ahead of the current position to download | `600 seconds` |
| Forward buffer target (seconds) | `5–7200 seconds`; changes also update the other two time targets; used for the player buffer target | `600 seconds` |
| Maximum buffer target (seconds) | `5–7200 seconds`; changes also update the other two time targets; used for the player buffer target | `600 seconds` |
| Back buffer target (minimum seconds) | `0–1800 seconds`; preserves larger values already supplied by the site | `180` |
| Cache reference size (MB; may be exceeded) | `16–512 MB`; above this size, played content and content outside the target window are removed first; content inside the target window can temporarily exceed it; excludes the player buffer and temporary response copies | `64/128/192 MB`, based on reported device memory |
| Player buffer target (MSE, minimum MB) | `16–512 MB`; raises HLS `maxBufferSize` to at least this value, with an internal minimum of `60 MB` | Based on reported device memory; respects saved memory settings |
| Adaptive prefetching (experimental; data saver and live streams) | Repeated failures reduce prefetch concurrency, while successful requests gradually restore it; data-saving mode stops speculative prefetching, and live streams use a shorter prefetch window | Disabled |

**All three time targets default to 600 seconds and stay synchronized.** Changing any one updates the other two to the same number of seconds. The segment count controls only the size of each download batch. The script still tries to fill the target window while playback is paused and stops at the end of the video. Settings that used the original default times become three 600-second values. If you previously customized the times, all three use the largest value that was effectively applied. Live streams download only content available in the current playlist and retain the existing live prefetch policy.

Although settings are saved globally, each page context has its own prefetch queue, request table, and cache. The page prefetch limit and cache reference size are therefore not browser-wide totals across tabs and iframes. When an on-demand player starts, its forward and maximum buffer targets are raised to at least the configured time target, while larger site settings are preserved. Playlist loading restores targets that have been overwritten. If the current video has already encountered a buffer capacity error, the player's reduced setting is kept first. The script tries to restore it gradually only after sustained playback releases old content, and never above the video's initial target. Quality changes and playlist reloads do not bypass the waiting period. A different video is evaluated again. Back buffer and MSE targets are only raised, and live synchronization settings are left intact.

### Quick manual check

1. Open settings on site A, change a parameter such as **Page prefetch concurrency limit** to a recognizable value, save, and refresh.
2. Open an unrelated site B and confirm that its settings panel shows the same value. Refresh an HLS.js playback page and use Debug logs to check the active settings.
3. Refresh the top-level page containing a cross-origin player iframe and confirm that the iframe's StreamBoost Debug logs use the same parameters.
4. Use **Disable on this host** to confirm that only that hostname is skipped. Then use **Global status** to confirm that matching sites and iframes stop injecting after refresh.

---

## ✅ Supported players and limitations

Each player manages its own download tasks. Fullscreen and window-size changes do not actively clear the cache. Seeking or changing quality updates what should be downloaded next while keeping downloaded segments that remain valid. A real source change or resource identity change isolates old data so that another video's cache cannot be used accidentally.

When a standard on-demand player is rebuilt on the same video element, it can reuse cached content confirmed to belong to the same resource for up to 30 seconds. That content still follows the reference-size and cleanup rules. Live streams, players with special request behavior, and resources whose identity cannot be confirmed do not share cached data across instances. Requests that cannot be cached reliably continue through the player's original loader. Disabling the memory cache also stops prefetching; normal playback continues.

Results depend on the site, network, and device. Custom players that change download handling before the script takes control may not be fully recognized, so compatibility cannot be guaranteed. Experimental adaptive prefetching is disabled by default.

* **Supported**: Sites using **HLS.js**, including video.js integrations that use HLS.js.
* **Outside the scope**: DRM/encrypted media and Safari's native HLS playback without MSE/Hls.js.
* **Network policy**: Cross-origin requests are still subject to CORS. Native XHR follows the site's `xhrSetup`, including headers and `withCredentials`.
* **When changes apply**: Existing Hls instances are not updated live. Refresh the relevant page or iframe after saving or switching settings.
* **Configuration sharing**: GM configuration is shared within the same userscript manager installation. It does not automatically sync across browsers, browser profiles, or devices.
* **Configuration source**: Runtime parameters come from the userscript manager's GM storage. Unsaved settings use the global defaults rather than parameters from the website's own storage.
* **Hostname rules**: Current-hostname rules ignore the protocol and port and distinguish subdomains. Manage cross-origin player iframes by their own hostnames, or use the global switch to disable everything.
* **Resource scope**: Concurrency, requests in progress, and the LRU cache are independent in each page context rather than one browser-wide resource pool.

---

## ❓Frequently asked questions (FAQ)

* **Why does buffering stop before 600 seconds even though I selected 600?**
  600 seconds is a download target. Actual progress still depends on the network, available media, and browser memory. The original buffer bar continues to show the player's own buffer. Content downloaded by the script but not yet received by the browser may not appear there; the player can still reuse it later. On a long video, 600 seconds may also occupy only a small part of the progress bar.
* **Why can fullscreen change the buffer bar or briefly interrupt playback?**
  When the player is already using the selected quality and has playable data at the current position, the script ignores a repeated selection of that same quality to avoid unnecessary buffer clearing during fullscreen or window-size changes. Actual quality changes, the first quality selection, source changes, and cases without playable buffered data remain under the player's normal handling.
  Switching to another quality needs the corresponding video data and may briefly interrupt playback. Rebuilt players also need to process cached data again, so every fullscreen operation cannot be guaranteed to be seamless. Downloaded segments still need to be received and processed by the player; the download cache and browser playback buffer are different. A site's attempt to force a reload by selecting the same quality again is also ignored when these healthy-buffer conditions hold.
* **Does downloaded content stay cached forever?**
  No. Above the cache reference size, played content and content outside the current target window are removed first to retain upcoming segments. Complete segments within the target window can temporarily exceed the reference size. Source changes, expired live playlist windows, and leaving the page also remove relevant data. The cache reduces repeated downloads; it is not offline storage.
* **Why do downloads still look sequential?**
  Some sites or intermediaries show multiple HTTP/2 requests as pending even though they are multiplexed. Enable **Debug logging** to inspect StreamBoost's concurrency slots and requests in progress more accurately.
* **What about 403 or CORS errors?**
  Standard requests use the selected prefetch strategy. Sites with a custom Loader or request setup use the original Loader. The resource server must still allow cross-origin requests.
* **Will this use a lot of memory?**
  It uses memory, and high-bitrate video inside the target window can exceed the cache reference size. The script removes played content and content outside the target window first; it does not evict nearby unplayed data to make room for more distant segments. The player's own buffer, network responses, and temporary copies use additional memory. Low browser memory can still limit how much is downloaded. If no capacity setting has been saved, the default is selected from the device's reported memory tier. That information is not a real-time measure of free memory and does not guarantee enough room for the chosen duration. Device detection does not override saved settings. To reduce how much the script downloads ahead, lower any of the three time targets; the other two follow automatically. Larger playback buffer settings supplied by the site are still preserved.
* **Why does saving not immediately change the current video?**
  Hls instances and Loaders that already exist cannot be safely replaced live. New instances read the latest global configuration after the top-level page or relevant iframe is refreshed.
* **How do I switch between English and Chinese?**
  Open settings, choose **English** or **中文** under **Language / 界面语言**, save, and refresh. **Follow browser** uses Chinese when the browser's primary language is Chinese, and English otherwise. Resetting default parameters keeps your language choice.

---

## 📄 License

This script is licensed under the [MIT License](../LICENSE).

---

## 🤝 Feedback and contributions

* Project links:
  [Monorepo root](../) / [Project directory](./) / [GitHub repository](https://github.com/Suysker/scripts-monorepo)
* Submit an issue or pull request through **GitHub Issues / Pull Requests**.
* [Open the issue tracker](https://github.com/Suysker/scripts-monorepo/issues).
* Compatibility reports, reproduction steps, and suggestions are welcome. If StreamBoost helps you, consider giving the repository a ⭐. Thank you for your support!
