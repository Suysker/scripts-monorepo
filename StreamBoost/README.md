# 流媒体加速缓冲 🚀

> **通用流媒体加速缓冲脚本：扩大缓冲、并发预取、内存命中、在途合并、站点级启停，一把梭！**
> 现已深度适配 **HLS.js**，后续可拓展到更多播放器/协议。

![License](https://img.shields.io/github/license/Suysker/scripts-monorepo?style=flat-square) ![Downloads](https://img.shields.io/greasyfork/dt/507274?style=flat-square) ![Version](https://img.shields.io/greasyfork/v/507274?style=flat-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-5.1.1-red.svg?style=popout-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Beta-red.svg?style=popout-square)

---

## 📁 仓库位置（Monorepo）

- [Monorepo 根目录](../)
- [当前项目目录](./)
- [GitHub 仓库](https://github.com/Suysker/scripts-monorepo)

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
2. 打开 `StreamBoost/StreamBoost.js`，点 **Raw** 进行安装（或在 Greasy Fork 页安装）。
3. 刷新含播放器的页面即可体验加速。

脚本源码地址（Raw）：
`https://raw.githubusercontent.com/Suysker/scripts-monorepo/main/StreamBoost/StreamBoost.js`

> 兼容：Chrome / Edge / Firefox（现代版本）。Safari 因扩展限制可能需要额外授权。

---

## ⚙️ 菜单与控制

安装后，在 Tampermonkey 图标的页面菜单里可见：

* `🔌 全局状态（启用/停用）`
* `⛔ / ✅ 在此站点停用/启用`
* `⚙️ 打开参数配置页`
* `🐞 Debug 日志（启用/停用）`

> 切换后通常需要**刷新页面**生效（脚本会弹提示）。

---

## 🛠 可配置参数（localStorage）

建议优先在菜单里的**参数配置页（悬浮可视化表单）**修改，保存后刷新页面即可生效。当前 UI 为淡粉色 / 浅灰色 / 白色风格，提供滑动条、选项按钮和启用/停用按钮，并固定为三栏分组：`预取并发`、`缓冲与内存`、`请求策略+常规开关`。`关闭 / 恢复默认 / 保存配置` 操作按钮位于面板顶部。

### 菜单开关（不在参数页内）

| 键名                     | 说明              | 默认值 |
| ---------------------- | --------------- | --- |
| `HLS_BIGBUF_ENABLE`    | 全局启用开关          | `"1"` |
| `HLS_BIGBUF_DEBUG`     | 调试日志开关          | 空（关闭） |

> 参数配置页包含“常规开关 + 进阶参数”，并按类别分组展示。悬浮层不会对网页背景做模糊处理，面板高度按内容自适应以减少空白。  
> 站点与域名控制（启用/停用）请使用菜单里的 `⛔ / ✅ 在此站点停用/启用`。

### 参数配置页（常规开关）

| 键名                     | 说明              | 默认值 |
| ---------------------- | --------------- | --- |
| `HLS_BIGBUF_PREFETCH`  | 并发预取开关          | `"1"` |
| `HLS_BIGBUF_CACHE`     | fLoader 内存命中开关 | `"1"` |

### 参数配置页（进阶参数）

| 键名                               | 说明                   | 默认值 |
| -------------------------------- | -------------------- | --- |
| `HLS_BIGBUF_PREFETCH_AHEAD`      | 预取前瞻片段数（0-60）        | `12` |
| `HLS_BIGBUF_CONC_GLOBAL`         | 全局并发上限（1-16）         | `4` |
| `HLS_BIGBUF_CONC_PER_ORIGIN`     | 单 Origin 并发上限（1-16）  | `4` |
| `HLS_BIGBUF_PREFETCH_TIMEOUT_MS` | 预取超时毫秒（1000-120000）  | `15000` |
| `HLS_BIGBUF_WAIT_INFLIGHT_MS`    | 在途复用等待毫秒（0-10000）    | `500` |
| `HLS_BIGBUF_PREFETCH_STRATEGY`   | 预取策略                 | `xhr-hls-fetch` |
| `HLS_BIGBUF_VOD_BUFFER_SEC`      | 点播前向缓冲秒（60-3600）     | `180`（低内存设备）或 `600` |
| `HLS_BIGBUF_BACK_BUFFER_SEC`     | 回看缓冲秒（0-1800）        | `180` |
| `HLS_BIGBUF_MAX_MAX_BUFFER_SEC`  | 最大缓冲上限秒数 | `1800` |
| `HLS_BIGBUF_MAX_MEM_MB`          | LRU 内存上限 MB（16-512）  | `64/128/192`（按设备内存） |

### 快速验证（手动）

1. 打开任意 HLS.js 播放页，进入 Tampermonkey 菜单，点击 `⚙️ 打开参数配置页`。
2. 在悬浮配置面板里按分组修改常规开关或进阶参数（如并发预取、内存命中、并发上限、前瞻片段数）并保存。
3. 刷新页面后查看播放体验或 Debug 日志中的参数输出是否变化。

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
  LRU 缓存默认按设备内存自适应上限，超限就逐段淘汰；也可在 `⚙️ 参数配置页` 调整 `HLS_BIGBUF_MAX_MEM_MB`。

---

## 📄 许可协议

本脚本遵循 [MIT License](LICENSE)。

---

## 🤝 反馈与贡献

* 项目地址：
  [Monorepo 根目录](../) / [当前项目目录](./) / [GitHub 仓库](https://github.com/Suysker/scripts-monorepo)
* 提交 Issue / PR：**GitHub Issues / Pull Requests**
* Issues 入口：`https://github.com/Suysker/scripts-monorepo/issues`
* 欢迎提供站点兼容性、复现步骤与优化建议。喜欢就点个 ⭐ Star，感谢支持！

