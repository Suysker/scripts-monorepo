# 流媒体加速缓冲 🚀

> **通用流媒体加速缓冲脚本：扩大缓冲、并发预取、内存命中、在途合并、站点级启停，一把梭！**
> 现已深度适配 **HLS.js**，后续可拓展到更多播放器/协议。

![License](https://img.shields.io/github/license/Suysker/Golden-Left-Right?style=flat-square) ![Downloads](https://img.shields.io/greasyfork/dt/507274?style=flat-square) ![Version](https://img.shields.io/greasyfork/v/507274?style=flat-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-5.1.1-red.svg?style=popout-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Beta-red.svg?style=popout-square)

---

## 🐣 这个脚本为什么会诞生？

在线看剧/直播时，很多站点的**缓冲策略非常保守**：只往前拉一小段，稍微网络抖一下就**卡**；有些站点还把 HLS 片段加载做成了**串行**（同时只跑一个请求），遇到高 RTT/限速就雪上加霜。
更糟的是，部分站点自定义了 Loader/XHR，导致**明明 HTTP/2 支持多路复用，却看起来只有一个在下载**；偶发 403/CORS 也会让播放器反复重试、白白等很久。
这些体验都很烦躁，于是就有了 **StreamBoost**：在不侵入页面业务逻辑的前提下，接管片段的**预取与缓存策略**，把能并发的并发起来，把能命中的命中起来，把没必要的在途请求**及时中止**，尽量把“卡顿感”消掉。

---

## 🌟 主要功能

* **并发预取（真正并发）**：对齐 `FRAG_LOADING / FRAG_LOADED` 连续向前预取（默认 12 段）。
  优先 **原生 XHR**（可沿用站点 `xhrSetup`，避免站点自定义 Loader 造成“串行化”）；再回退 **Hls 内置 loader**；最后 **fetch**。
* **在途合并**：播放器要的片段如果**已经在下载**，短暂等待直接复用结果，避免重复请求。
* **内存 LRU 命中（fLoader）**：下载过的片段进入 LRU；命中后直接回填，几乎零延迟。
* **淘汰过时在途**：level/sn 前进时，自动 `abort` 落后的在途下载，省流量也省时间。
* **缓冲增强（VOD）**：放大 `maxBufferLength / maxMaxBufferLength / backBufferLength`，本地资源允许时尽量“多吃一点”，播放更丝滑。
* **按站点启停 + 全局开关**：菜单一键控制；支持 **黑名单 JSON**（含 `*.domain.com` 通配）。
* **同源 iframe 自动注入**：顶层与同源 iframe 一并受益（跨域 iframe 依赖 `@match` 自注入）。
* **调试日志**：打开后关键决策全可见，排查问题更直观。

---

## 📥 安装方式

1. 安装浏览器扩展 **Tampermonkey**（或兼容脚本管理器）。
2. 打开本仓库脚本文件，点 **Raw** 进行安装（或在 Greasy Fork 页安装）。
3. 刷新含播放器的页面即可体验加速。

> 兼容：Chrome / Edge / Firefox（现代版本）。Safari 因扩展限制可能需要额外授权。

---

## ⚙️ 菜单与控制

安装后，在 Tampermonkey 图标的页面菜单里可见：

* `🔌 全局状态（启用/停用）`
* `⛔ / ✅ 在此站点停用/启用`
* `📝 查看/编辑 站点黑名单（JSON）`
* `🐞 Debug 日志（启用/停用）`
* `🚀 并发预取（启用/停用）`
* `🧠 内存命中 fLoader（启用/停用）`

> 切换后通常需要**刷新页面**生效（脚本会弹提示）。

---

## 🛠 可配置参数（localStorage）

除了菜单开关，以下键可直接在控制台持久化设置（刷新后生效）：

| 键名                     | 说明           | 值/默认                          |
| ---------------------- | ------------ | ----------------------------- |
| `HLS_BIGBUF_ENABLE`    | 全局启用         | `"1"`（默认）或空                   |
| `HLS_BIGBUF_PREFETCH`  | 并发预取开关       | `"1"`（默认）或空                   |
| `HLS_BIGBUF_CACHE`     | fLoader 内存命中 | `"1"`（默认）或空                   |
| `HLS_BIGBUF_DEBUG`     | 调试日志         | `"1"` 开                       |
| `HLS_BIGBUF_BLOCKLIST` | 站点黑名单        | `["example.com","*.foo.com"]` |

> 预取片数/并发上限/超时等属于脚本内常量，按需可直接修改脚本。

---

## ✅ 适用范围与限制

* **适用**：采用 **HLS.js** 的站点（含以 video.js 方式集成的 HLS）。
* **限制**：DRM/加密媒体、Safari 原生 HLS（非 MSE/Hls.js）不在接管范围。
* **网络策略**：跨域仍受 CORS 约束；原生 XHR 会遵循站点 `xhrSetup`（可设置 header / `withCredentials`）。

---

## ❓常见问题（FAQ）

* **看起来还是“串行”？**
  有些站点/中间层在 HTTP/2 下会把多请求显示为“挂起”，其实是多路复用；开启 `🐞Debug` 可看到 StreamBoost 的并发占位与在途数量，更准确。
* **403 / CORS 怎么办？**
  预取优先原生 XHR，并把机会交给站点 `xhrSetup`；若资源服务器不允许跨域，仍需 CORS 许可。
* **会不会很占内存？**
  LRU 缓存按设备内存自适应上限（代码内设置），超限就逐段淘汰；也可直接改脚本阈值。

---

## 📄 许可协议

本脚本遵循 [MIT License](LICENSE)。

---

## 🤝 反馈与贡献

* 提交 Issue / PR：**GitHub Issues / Pull Requests**
* 欢迎提供站点兼容性、复现步骤与优化建议。喜欢就点个 ⭐ Star，感谢支持！
