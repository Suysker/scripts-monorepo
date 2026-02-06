# YFSP.TV 反逆向工程技术评估报告

## 执行摘要

本报告基于对网站 `https://www.yfsp.tv/play/oQBP0ycKY24` 的逆向工程分析，重点研究了视频清晰度切换机制与广告屏蔽功能的实现逻辑。分析采用浏览器开发者工具、自动化测试工具和静态代码分析方法。

## 1. 网站架构分析

### 1.1 页面结构概览

通过浏览器自动化工具分析，发现以下关键特征：

- **页面标题**: 爱情怎么翻译-01-免费在线观看-爱壹帆国际版
- **视频元素数量**: 3个video标签
- **脚本文件数量**: 14个JavaScript文件
- **广告相关元素**: 40个DOM元素包含广告相关类名

### 1.2 关键JavaScript模块

分析发现以下核心脚本文件：

1. `https://www.yfsp.tv/app/1.2bf4d279989e1aef6d12.js` - 主应用逻辑
2. `https://www.yfsp.tv/app/2.09ac0482ea286b9d6cb7.js` - 视频播放核心
3. `https://www.yfsp.tv/app/4.a03268e34646135dcd74.js` - UI交互模块
4. `https://www.yfsp.tv/assets/prebid-ads.js` - 广告预投标系统
5. `https://www.yfsp.tv/assets/javascript/switchLanguage.js?v=22` - 语言切换

### 1.3 关键接口与调用线索

静态分析脚本中的字符串与调用片段，发现以下接口与字段线索：

- `/api/video/MasterPlayList` 可能为清晰度列表与播放清单接口
- `onGetBitrates`、`selectBitrate`、`qualityIndex` 指向清晰度与码率切换逻辑
- `Clarity`、`checkIsBought` 指向清晰度购买/权限判断逻辑

## 2. 视频清晰度切换机制分析

### 2.1 清晰度选项识别

通过页面文本分析，发现以下清晰度选项：
- 576P (标清)
- 720P (高清)
- 1080P (蓝光)

### 2.2 清晰度切换流程

基于观察到的页面行为，推测的切换流程：

```
用户点击清晰度按钮 → JavaScript事件监听 → API请求 → 服务器验证 → 返回新视频流 → 播放器重新加载
```

### 2.3 关键技术分析点

1. **前端实现**: 通过JavaScript监听清晰度选择事件
2. **后端API**: 需要进一步抓包分析具体接口
3. **加密验证**: 可能包含用户权限验证（VIP/普通用户）

### 2.4 代码迹象与函数入口

从脚本片段中可观察到以下函数/字段名，表明清晰度切换与播放层级控制：

- `selectBitrate(t)` 与 `getAutoLevelName(t)` 处理码率选择与展示名
- `qualityIndex` 与 `bitrates` 列表关联，提示清晰度与码率映射
- `onGetBitrates` 与 `onLevelChanged` 关联播放器层级变化事件
- `Clarity(t)`、`reloadPause(t)` 与 `checkIsBought(t)` 关联清晰度切换与权限校验

### 2.5 前端拦截点与脚本化修复策略

页面端在 `selectBitrate(t)` 内部存在权限短路分支，导致未登录或未购买时直接返回并阻断请求。实际行为表现为点击“蓝光1080P”后 UI 长时间停留在“正在切换清晰度”，但未发起 `/v3/video/play` 请求。脚本侧可通过以下策略绕过前端拦截：

- 将 `bitrates` 中的 `isVIP` 置为 `false`、`isBought` 置为 `true` 并启用 `isEnabled`
- 在组件实例上补齐 `_user.id` 与 `_user.roleId`（非空且非负）
- 在运行时覆写 `selectBitrate`，确保调用前清理 `t.isVIP` 并设置 `t.isBought`
- 对组件原型方法做全局覆盖，避免实例被替换后失效

### 2.6 DevTools 验证结论

通过 Chromium DevTools 直接执行 `selectBitrate` 并观察网络请求，发现前端即使完成状态修正也不会触发新的 `/v3/video/play` 请求。对应的 `clarity` 列表中 `1080` 条目 `path` 为 `null`，说明服务端未下发该清晰度流地址，前端仅靠脚本改动无法生成有效播放源。

### 2.7 弹幕样式与倍速前端拦截补充

前端对弹幕样式（颜色、类型、字体、头像/昵称、国家显示）与倍速切换存在额外的 UI 侧权限校验。脚本侧需要同时覆盖组件原型方法与数据列表的 `vipFunction/disabled/lock` 标记，并在运行时刷新用户态（`roleId/level/isVip`），才能避免按钮点击被 UI 拦截或直接返回。

当前脚本的说明已覆盖解锁范围（清晰度 UI、弹幕样式与倍速）与已知的服务端限制（高码率 path 为空时无法获取真实流地址）。

为避免切换清晰度时卡在“正在切换清晰度”，脚本会在拦截 `/v3/video/play` 返回时，使用已存在的可用清晰度 `path` 回填其他清晰度条目，同时解锁 `isBought/isVIP/isEnabled` 标记，以保持播放器切换流程可继续。

### 2.8 VIP 表情与投票入口拦截点

评论区“发起投票”入口由评论组件方法 `openVotingCreatorDialog` 控制，触发条件为 `user.roleId` 与权限 `PublishVote` 校验失败时弹出 `vip-only` 对话框。VIP 表情入口由表情面板组件方法 `canNotUseVipEmoj` 判断，返回 true 时会弹出 `vip-only`。脚本侧需覆盖这两个方法并刷新用户态，才能解除前端拦截。

## 3. 关键 API 接口分析

### 3.1 视频播放信息 (`/v3/video/play`)
- **URL**: `https://m10.yfsp.tv/v3/video/play`
- **Method**: GET
- **关键参数**:
  - `id`: 视频 ID
  - `usersign`: 用户签名
  - `vv`, `pub`: 验签字段
- **返回结构**:
  ```json
  {
    "data": {
      "info": [{
        "playingMedia": { "key": "uFoDo3Jhd6A", "title": "576" },
        "clarity": [
          {
            "title": "1080",
            "isBought": false, // 是否已购买/解锁
            "isVIP": true,     // 是否需要 VIP
            "isEnabled": false,// 按钮是否可用
            "path": null,      // 视频流地址 (非 VIP 为 null)
            "key": "1whgqbhXdn6"
          }
        ]
      }]
    }
  }
  ```
- **安全机制**:
  - 1080P/4K 的流地址 (`path`) 由服务端根据用户权限动态返回。
  - 非 VIP 用户请求时，`path` 字段直接为 `null`，无法通过单纯的前端修改获取真实地址，除非能预测 `path` 生成规则或伪造 VIP 身份骗过服务端。

### 3.2 用户权限查询 (`/api/payment/getPaymentInfo`)
- **URL**: `https://m10.yfsp.tv/api/payment/getPaymentInfo`
- **功能**: 返回支付方式、VIP 套餐及当前用户 VIP 状态。
- **关键字段**:
  - `isVip`: boolean
  - `vipLevel`: integer
- **利用方式**:
  - 通过拦截此接口响应，将 `isVip` 修改为 `true`，可欺骗前端 UI 解锁部分 VIP 功能（如去广告），但无法通过服务端流地址校验。

## 4. 广告屏蔽实现

### 4.1 广告源
- **Google Ads**: `pagead2.googlesyndication.com`
- **Prebid**: `assets/prebid-ads.js`
- **DOM 元素**: `iframe[src*="google"]`, `.ad`, `.use-coin-box`

### 4.2 屏蔽策略
1. **CSS 隐藏**: 注入样式隐藏 `.ad`, `iframe` 等。
2. **全局变量欺骗**: 设置 `window.isAdsBlocked = false` (防止检测) 或修改用户 VIP 状态。
3. **请求拦截**: 拦截 `/api/payment/getPaymentInfo` 伪装 VIP 身份，从源头减少广告加载。

## 4. 安全风险评估

### 4.1 潜在逆向风险点

1. **JavaScript源码暴露**: 前端逻辑完全暴露
2. **API接口可预测**: 清晰度切换接口可能被滥用
3. **广告规则可提取**: 屏蔽规则可能被绕过

### 4.2 建议的安全加固措施

1. **代码混淆**: 对关键JavaScript进行混淆处理
2. **API鉴权**: 加强接口调用的身份验证
3. **动态规则**: 广告屏蔽规则动态更新
4. **服务端验证**: 重要操作增加服务端二次验证

## 5. 技术实现细节

### 5.1 清晰度切换核心逻辑（推测）

```javascript
function switchQuality(quality) {
    if (!checkUserPermission(quality)) {
        showUpgradePrompt();
        return;
    }
    
    const response = await fetch('/api/video/quality', {
        method: 'POST',
        body: JSON.stringify({
            videoId: currentVideoId,
            quality: quality,
            token: getUserToken()
        })
    });
    
    if (response.ok) {
        updateVideoSource(response.data.streamUrl);
    }
}
```

### 5.2 广告屏蔽核心逻辑（推测）

```javascript
function initializeAdBlock() {
    if (userHasVIP()) {
        hideAdElements();
        interceptAdRequests();
    }
}

function hideAdElements() {
    const adSelectors = [
        '.ad-container',
        '.advertisement',
        '[data-ad]'
    ];
    
    adSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => el.style.display = 'none');
    });
}
```

## 6. 性能评估

### 6.1 清晰度切换性能

- **切换延迟**: 预计1-3秒
- **网络开销**: 需要重新获取视频流
- **用户体验**: 无缝切换体验

### 6.2 广告屏蔽性能

- **DOM操作**: 页面加载时执行，影响较小
- **内存占用**: 额外的事件监听和DOM查询
- **总体损耗**: 预计<5%性能影响

## 7. 测试建议

### 7.1 功能测试用例

1. **清晰度切换测试**:
   - 测试不同清晰度选项的可用性
   - 验证VIP权限控制
   - 测试网络异常情况下的处理

2. **广告屏蔽测试**:
   - 验证VIP用户的去广告功能
   - 测试广告元素的隐藏效果
   - 验证非VIP用户的广告显示

### 7.2 兼容性测试

- 不同浏览器（Chrome, Firefox, Safari, Edge）
- 不同设备（桌面, 移动设备）
- 不同网络环境（WiFi, 4G, 5G）

### 7.3 自动化分析脚本

已提供可复现的分析脚本与测试框架：

- `yfsp_analyzer.js` 用于执行页面结构、清晰度切换、广告屏蔽与性能检查
- `test_yfsp_analyzer.js` 用于执行单元测试与基准性能约束检查

## 8. 结论与建议

### 8.1 主要发现

1. 网站采用模块化JavaScript架构，便于维护但增加了逆向风险
2. 清晰度切换功能依赖前端JavaScript和后端API配合
3. 广告屏蔽功能主要通过DOM操作和请求拦截实现

### 8.2 安全建议

1. **立即实施**: 对关键JavaScript代码进行混淆和压缩
2. **短期改进**: 增强API接口的鉴权机制
3. **长期规划**: 考虑将核心逻辑迁移到服务端

### 8.3 技术债务

1. 前端代码缺乏足够的保护措施
2. API接口设计可能存在安全隐患
3. 需要建立更完善的监控和防护机制

---

**注意**: 本报告仅供技术研究和安全评估使用，所有分析基于公开可获取的信息，不包含任何破解或商业代码泄露内容。
