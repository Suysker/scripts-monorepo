# YFSP Unlocker 🚀

> **面向 YFSP 站点的 Tampermonkey 增强脚本：解锁清晰度/弹幕样式/倍速 UI，自动隐藏常见广告遮罩，减少页面打断。**

![License](https://img.shields.io/github/license/Suysker/js-scripts-monorepo?style=flat-square) ![Scope](https://img.shields.io/badge/Scope-YFSP-blue?style=flat-square) ![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-red?style=flat-square)

---

## 📁 仓库位置（Monorepo）

- [Monorepo 根目录](../)
- [当前项目目录](./)
- [GitHub 仓库](https://github.com/Suysker/js-scripts-monorepo)

脚本文件：`yfsp-unlocker.js`

脚本源码地址（Raw）：
`https://raw.githubusercontent.com/Suysker/js-scripts-monorepo/main/yfsp/yfsp-unlocker.js`

Issues 入口：
`https://github.com/Suysker/js-scripts-monorepo/issues`

---

## 🌟 主要功能

- **清晰度 UI 解锁**：把清晰度选项的前端锁定状态解除，避免按钮不可点。
- **倍速 UI 解锁**：放开倍速相关的前端限制，减少点了无反应的情况。
- **弹幕样式解锁**：解除颜色/样式类前端 VIP 锁定标记。
- **播放流程兜底**：当高码率条目缺少有效播放地址时，尽量回填可用地址，降低“卡在切换中”的概率。
- **广告遮罩清理**：自动隐藏常见广告 iframe、弹层和遮罩，页面更干净。
- **请求层补丁**：对 `fetch` / `XMLHttpRequest` 的关键返回做前端修正，减少 UI 权限短路。

---

## ⚠️ 已知限制

- 这是前端增强脚本，不会绕过服务端真实权限校验。
- 如果服务端没有下发高码率真实流地址，脚本无法凭空生成该地址。

---

## 📥 安装方式

1. 安装浏览器扩展 **Tampermonkey**（或兼容脚本管理器）。
2. 打开 `yfsp/yfsp-unlocker.js`，点击 **Raw** 安装。
3. 访问匹配站点页面并刷新，脚本会自动生效。

当前匹配域名：
- `*.yfsp.tv`
- `*.dudupro.com`

---

## 🧭 使用说明

- 脚本默认自动运行，不需要额外菜单操作。
- 建议先清空页面缓存并刷新一次，再验证清晰度/倍速入口状态。
- 如果页面结构改版，可能需要更新脚本版本。

---

## ❓FAQ

**Q: 为什么清晰度按钮可点了，但依然切不到最高画质？**
A: 常见原因是服务端没有返回该画质的真实播放地址，这是服务端权限限制。

**Q: 会影响站点正常播放吗？**
A: 脚本只针对部分接口和 UI 做补丁。若遇到异常，先临时停用脚本并刷新页面对比。

**Q: 支持哪些浏览器？**
A: 支持主流 Chromium / Firefox 系浏览器，只要能运行 Tampermonkey 即可。

---

## 📄 许可协议

本项目遵循 [MIT License](../LICENSE)。

---

## 🤝 反馈与贡献

- 提交 Issue：`https://github.com/Suysker/js-scripts-monorepo/issues`
- 提交 PR：`https://github.com/Suysker/js-scripts-monorepo/pulls`
