# Discuz Forum Filter + Black/White List

> **用于目标 Discuz 论坛的油猴脚本：过滤发帖（可开关），并支持黑名单/白名单双名单过滤。**

## 仓库位置

- Monorepo 根目录：[`../`](../)
- 当前目录：[`./`](./)
- 脚本文件：`syysj-filter.js`

Raw 安装地址：
`https://raw.githubusercontent.com/Suysker/scripts-monorepo/main/discuz-forum-filter/syysj-filter.js`

## 功能说明

- 支持页面：
  - 论坛列表页：`forum.php?mod=forumdisplay`
  - 帖子详情页：`forum.php?mod=viewthread`
  - 个人空间页：`home.php?mod=space&uid=...`
- 男性过滤（默认开启“过滤男性”）：
  - 主题分类 tag 命中男性关键词（当前：`小哥自拍`、`男宝宝自拍`）会隐藏；
  - 或者发帖用户悬浮卡片命中 `card_gender_1`（男性）也会隐藏；
  - 判定逻辑是 **或（OR）**；
  - `card_gender_2`（女性）与 `card_gender_0`（保密/未知）不会仅因性别被隐藏。
- 性别背景色标识（默认启用）：
  - 仅在 `forumdisplay`（帖子浏览列表）上，主题行背景色会按性别显示；
  - 颜色映射与悬浮卡片一致：`card_gender_1 -> 蓝`，`card_gender_2 -> 粉`，`card_gender_0 -> 灰`；
  - 首次遇到某个 `uid` 时会异步读取性别，拿到后自动刷新背景色。
- 双名单机制：
  - 黑名单：自动隐藏该用户帖子。
  - 白名单：强制保留该用户帖子。
  - 优先级：**白名单 > 黑名单 > 男性过滤**。
  - 黑白名单互斥：加入一边会自动从另一边移除。
- 入口位置（不再在列表用户名后放按钮）：
  - 个人资料悬浮窗（hover card）
  - 个人空间页动作区
  - 帖子详情页头像区（`pls cl favatar`）
  - 黑名单/白名单按钮分别带图标：`⛔`、`⭐`
- 顶部管理条（`forumdisplay`）：
  - 切换“过滤男性：开/关”
  - 管理黑名单
  - 管理白名单
  - 显示可见/隐藏统计
- 数据持久化：
  - 黑/白名单和“过滤男性”状态存储在 Tampermonkey 脚本存储（`GM_setValue`）。
  - 用户 `uid -> card_gender(0/1/2)` 会做本地缓存，减少重复请求悬浮卡片接口。
  - 性别预取使用低并发队列，且同一 `uid` 在单次页面会话只预取一次，避免影响悬浮卡片正常弹出。
  - 脚本采用事件驱动（MutationObserver + pageshow）进行重应用，不再使用固定轮询定时器。
  - 开启 Tampermonkey 同步后，可跨浏览器/设备同步这些数据。

## 行为变更（v1.3.0）

- 从“仅看女性（女性 tag 或性别验证）”改为“过滤男性（男性 tag 或 `card_gender_1`）”。
- 这是一个行为层面的 breaking change：未知性别用户现在默认会保留显示，而不是被过滤。

## 代码清理（v1.3.1）

- 不改变功能行为，仅做结构精简：
  - 删除未使用状态字段；
  - 抽取统一可见性判定逻辑，减少重复分支；
  - 删除重复启动路径，保留事件驱动触发。

## 显示修复（v1.3.2）

- 修复 `forumdisplay` 上当置顶帖被过滤或隐藏后，`separatorline` 仍然占位，导致主题列表表头下方出现空白分隔带的问题。

## 域名隐匿（v1.4.0）

- 脚本元数据改为宽路径匹配：`*://*/main/forum.php*`、`*://*/main/home.php*`。
- 启动时会对当前主机名做规范化哈希校验，只在哈希白名单命中时继续运行。
- 目录名改为中性名称 `discuz-forum-filter`，减少仓库路径暴露。
- 这样脚本源码与目录路径里都不再出现目标站点完整域名，但脚本仍然只会在目标站点页面生效。

## 安装方式

1. 安装 Tampermonkey（或兼容脚本管理器）。
2. 打开并安装脚本：
   `https://raw.githubusercontent.com/Suysker/scripts-monorepo/main/discuz-forum-filter/syysj-filter.js`
3. 打开论坛页面并刷新。

## 使用方式

1. 在悬浮资料卡、个人空间页、或帖子页头像区点击“加入黑名单/加入白名单”。
2. 在 `forumdisplay` 顶部工具条可打开“管理黑名单/管理白名单”，按序号移除，或输入 `all` 清空。
3. 临时关闭男性过滤时，点击“过滤男性：开/关”切换。

## 手动验证清单

可用以下页面做验证（示例路径）：

- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=302`
- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=47`
- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=293`
- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=489`
- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=490`
- 论坛列表：`https://<目标站点>/main/forum.php?mod=forumdisplay&fid=296`
- 帖子详情：`https://<目标站点>/main/forum.php?mod=viewthread&tid=326372`
- 个人空间：`https://<目标站点>/main/home.php?mod=space&uid=380825`

预期结果：

1. `forumdisplay` 上“过滤男性”开启时，命中 `小哥自拍` 标签的帖子会被隐藏。
2. `forumdisplay` 上“过滤男性”开启时，作者悬浮卡片为 `card_gender_1` 的帖子会被隐藏。
3. `forumdisplay` 上“过滤男性”开启时，`card_gender_2/card_gender_0` 或暂未读取到性别的帖子默认保留显示。
4. `viewthread` 上“过滤男性”开启时，男性作者楼层（`card_gender_1`）会隐藏。
5. `forumdisplay` 上已识别性别的主题行会出现对应背景色（男蓝/女粉/未知灰）。
6. `viewthread` 帖子详情页不改背景色（保持站点原样）。
7. 将某用户加入黑名单后：其列表主题和帖子页楼层会隐藏。
8. 将同一用户加入白名单后：该用户不再因黑名单/男性过滤被隐藏。
9. 黑白名单入口出现在悬浮资料卡、个人空间、帖子头像区，而不是列表用户名后。
10. 刷新页面后名单状态保持不变，且已读取过的用户性别会命中缓存。
11. `forumdisplay` 上如果置顶帖都被隐藏，主题表头下方不应再保留空白分隔带。
12. 目标站点页面会正常执行脚本；非目标站点即使路径匹配 `/main/forum.php` 或 `/main/home.php`，也会因主机名哈希不匹配而立即退出。

## 已知限制

- 男性性别判定依赖悬浮卡片接口返回中的 `card_gender_*`，站点改版后可能需调整解析逻辑。
- 过滤是异步生效：首次遇到某个 `uid` 时会先显示，性别抓取完成后再自动刷新隐藏。
- 脚本不会绕过论坛本身的权限控制（未登录/权限不足内容仍不可见）。
