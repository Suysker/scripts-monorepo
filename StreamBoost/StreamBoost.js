// ==UserScript==
// @name         流媒体加速缓冲
// @namespace    streamboost
// @icon         https://image.suysker.xyz/i/2023/10/09/artworks-QOnSW1HR08BDMoe9-GJTeew-t500x500.webp
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  通用流媒体加速：加大缓冲、并发预取、内存命中、在途合并、按站点启停、修复部分站点自定义 Loader 导致的串行；当前覆盖 HLS.js，后续可扩展至其它播放器/协议。
// @match        *://*/*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @homepage     https://github.com/Suysker/scripts-monorepo/tree/main/StreamBoost
// @supportURL   https://github.com/Suysker/scripts-monorepo/issues
// ==/UserScript==
(() => {
  'use strict';
  const SETTINGS_STORAGE_KEY = 'streamboost.settings';
  const SETTINGS_SCHEMA_VERSION = 1;
  const DEFAULT_DEVICE_MEMORY_GB = 4;
  const deviceMemoryGb = Number.isFinite(Number(navigator.deviceMemory))
    ? Number(navigator.deviceMemory)
    : DEFAULT_DEVICE_MEMORY_GB;
  const DEFAULT_FORWARD_BUFFER_SEC = deviceMemoryGb < 4 ? 180 : 600;
  const DEFAULT_MAX_MEM_MB = deviceMemoryGb >= 8 ? 192 : (deviceMemoryGb >= 4 ? 128 : 64);
  const PREFETCH_STRATEGIES = Object.freeze([
    { value: 'xhr-hls-fetch', label: 'xhr-hls-fetch（推荐）' },
    { value: 'hls-xhr-fetch', label: 'hls-xhr-fetch' },
    { value: 'hls-only', label: 'hls-only' },
    { value: 'xhr-only', label: 'xhr-only' },
    { value: 'fetch-only', label: 'fetch-only' },
    { value: 'fetch-xhr-hls', label: 'fetch-xhr-hls' }
  ]);
  const CONFIG_FIELDS = Object.freeze([
    { group: '预取并发', type: 'number', key: 'prefetchSeconds', label: '预取目标（秒）', def: 120, min: 5, max: 7200, step: 5 },
    { group: '请求策略+常规开关', type: 'bool', key: 'adaptivePrefetch', label: '实验性自适应预取（含省流量/直播策略）', def: false },
    { group: '缓冲与内存', type: 'number', key: 'mseMemoryMb', label: 'MSE 缓冲目标（至少，MB）', def: DEFAULT_MAX_MEM_MB, min: 16, max: 512, step: 8 },
    { group: '预取并发', type: 'number', key: 'prefetchAhead', label: '每批预取片段数（0 为关闭）', def: 12, min: 0, max: 60, step: 1 },
    { group: '预取并发', type: 'number', key: 'maxConcurrentPrefetches', label: '页面总预取并发上限', def: 4, min: 1, max: 16, step: 1 },
    { group: '预取并发', type: 'number', key: 'maxConcurrentPrefetchesPerOrigin', label: '单资源 Origin 并发上限', def: 4, min: 1, max: 16, step: 1 },
    { group: '预取并发', type: 'number', key: 'inflightReuseWaitMs', label: '在途复用等待（ms）', def: 500, min: 0, max: 10000, step: 50 },
    { group: '缓冲与内存', type: 'number', key: 'forwardBufferSeconds', label: '前向目标（秒）', def: DEFAULT_FORWARD_BUFFER_SEC, min: 60, max: 3600, step: 30 },
    { group: '缓冲与内存', type: 'number', key: 'backBufferSeconds', label: '回看目标（至少，秒）', def: 180, min: 0, max: 1800, step: 30 },
    { group: '缓冲与内存', type: 'number', key: 'maxBufferSeconds', label: '最大缓冲目标（秒）', def: 1800, min: 120, max: 7200, step: 60 },
    { group: '缓冲与内存', type: 'number', key: 'maxMemoryMb', label: 'LRU 缓存上限（MB）', def: DEFAULT_MAX_MEM_MB, min: 16, max: 512, step: 8 },
    { group: '请求策略+常规开关', type: 'bool', key: 'prefetchEnabled', label: '并发预取', def: true },
    { group: '请求策略+常规开关', type: 'bool', key: 'memoryCacheEnabled', label: '内存命中 fLoader', def: true },
    { group: '请求策略+常规开关', type: 'number', key: 'prefetchTimeoutMs', label: '预取超时（ms）', def: 15000, min: 1000, max: 120000, step: 500 },
    { group: '请求策略+常规开关', type: 'choice', key: 'prefetchStrategy', label: '预取策略', def: 'xhr-hls-fetch', options: PREFETCH_STRATEGIES }
  ]);
  function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function clampInt(value, min, max) { let out = Number.isFinite(value) ? Math.round(value) : 0; if (Number.isFinite(min)) out = Math.max(min, out); if (Number.isFinite(max)) out = Math.min(max, out); return out; }
  function normalizeFieldValue(value, field) {
    if (field.type === 'bool') {
      if (value == null) return !!field.def;
      return value === true || value === 1 || value === '1';
    }
    if (field.type === 'number') {
      if (value == null || String(value).trim() === '') return field.def;
      const number = Number(value);
      return Number.isFinite(number) ? clampInt(number, field.min, field.max) : field.def;
    }
    if (field.type === 'choice') {
      const allowed = (field.options || []).map(option => option.value);
      return allowed.includes(value) ? value : field.def;
    }
    return field.def;
  }
  function createDefaultRuntimeConfig() {
    return Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, field.def]));
  }
  function normalizeRuntimeConfig(candidate) {
    if (isRecord(candidate) && candidate.mseMemoryMb == null && candidate.maxMemoryMb != null) candidate = {...candidate, mseMemoryMb:candidate.maxMemoryMb};
    const source = isRecord(candidate) ? candidate : {};
    return Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, normalizeFieldValue(source[field.key], field)]));
  }
  function normHost(host) { return String(host || '').trim().toLowerCase().replace(/\.+$/, ''); }
  function normalizeHostPattern(pattern) {
    const raw = String(pattern || '').trim().toLowerCase();
    const wildcard = raw.startsWith('*.');
    const host = normHost(wildcard ? raw.slice(2) : raw);
    if (!host) return '';
    if (host.includes(':')) {
      if (wildcard) return '';
      const bracketed = host.startsWith('[') && host.endsWith(']') ? host : `[${host}]`;
      try {
        const ipv6Host = new URL(`http://${bracketed}/`).hostname;
        return ipv6Host.includes(':') ? ipv6Host.toLowerCase() : '';
      } catch {
        return '';
      }
    }
    if (/\s/.test(host) || host.includes('/') || host.includes('[') || host.includes(']')) return '';
    return wildcard ? `*.${host}` : host;
  }
  function normalizeHostPatterns(patterns) {
    if (!Array.isArray(patterns)) return [];
    return [...new Set(patterns.map(normalizeHostPattern).filter(Boolean))];
  }
  function hostMatches(host, pattern) { host = normHost(host); pattern = normHost(pattern); if (!host || !pattern) return false; if (pattern.startsWith('*.')) { const suf = pattern.slice(2); return host === suf || host.endsWith('.' + suf); } return host === pattern; }
  function createDefaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      globalEnabled: true,
      debugEnabled: false,
      disabledHostPatterns: [],
      runtime: createDefaultRuntimeConfig()
    };
  }
  function normalizeSettings(candidate) {
    const defaults = createDefaultSettings();
    const source = isRecord(candidate) ? candidate : {};
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      globalEnabled: source.globalEnabled == null ? defaults.globalEnabled : normalizeFieldValue(source.globalEnabled, { type: 'bool', def: defaults.globalEnabled }),
      debugEnabled: source.debugEnabled == null ? defaults.debugEnabled : normalizeFieldValue(source.debugEnabled, { type: 'bool', def: defaults.debugEnabled }),
      disabledHostPatterns: normalizeHostPatterns(source.disabledHostPatterns),
      runtime: normalizeRuntimeConfig(source.runtime)
    };
  }
  function assertSupportedSchema(candidate) {
    const version = Number(isRecord(candidate) ? candidate.schemaVersion : 0);
    if (Number.isFinite(version) && version > SETTINGS_SCHEMA_VERSION) {
      throw new Error(`配置版本 ${version} 高于当前脚本支持的版本 ${SETTINGS_SCHEMA_VERSION}`);
    }
  }
  function loadSettings() {
    try {
      const stored = GM_getValue(SETTINGS_STORAGE_KEY, null);
      assertSupportedSchema(stored);
      return normalizeSettings(stored);
    } catch (error) {
      throw new Error(`无法读取脚本全局配置：${error?.message || error}`);
    }
  }
  function saveSettings(candidate) {
    const normalized = normalizeSettings(candidate);
    try {
      assertSupportedSchema(GM_getValue(SETTINGS_STORAGE_KEY, null));
      GM_setValue(SETTINGS_STORAGE_KEY, normalized);
      return normalized;
    } catch (error) {
      throw new Error(`无法写入脚本全局配置：${error?.message || error}`);
    }
  }
  function updateSettings(mutator) {
    const current = loadSettings();
    return saveSettings(mutator(current));
  }
  function updateRuntimeConfig(runtime) {
    const normalizedRuntime = normalizeRuntimeConfig(runtime);
    return updateSettings(current => ({ ...current, runtime: normalizedRuntime }));
  }
  function isHostDisabled(host, settings) {
    return settings.disabledHostPatterns.some(pattern => hostMatches(host, pattern));
  }
  function isBlockedForURL(url, settings, fallbackHost = '') {
    try {
      const host = new URL(url, location.href).hostname || normHost(fallbackHost);
      return !settings.globalEnabled || isHostDisabled(host, settings);
    } catch {
      return !settings.globalEnabled;
    }
  }
  function isBlockedForDoc(doc, settings, fallbackHost = '') { try { return isBlockedForURL(doc?.location?.href || doc?.URL || '', settings, fallbackHost); } catch { return !settings.globalEnabled; } }
  function resolveRuntimeConfig(settings) {
    return Object.freeze({ debugEnabled: settings.debugEnabled, ...settings.runtime });
  }
  function serializeForInlineScript(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }
  function loadBootSettings() {
    try {
      return loadSettings();
    } catch (error) {
      console.warn('[HLS BigBuffer] 配置读取失败，本页为安全起见不注入', error);
      return { ...createDefaultSettings(), globalEnabled: false };
    }
  }
  const SB_CFG_MODAL_ID = 'hls-bigbuf-config-modal';
  const SB_CFG_STYLE_ID = 'hls-bigbuf-config-style';
  function ensureConfigStyle() {
    if (document.getElementById(SB_CFG_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = SB_CFG_STYLE_ID;
    style.textContent = `#${SB_CFG_MODAL_ID}{position:fixed;inset:0;z-index:2147483647;background:radial-gradient(1200px 520px at 8% -6%,rgba(255,212,229,.38),transparent 66%),radial-gradient(980px 520px at 100% 100%,rgba(233,232,236,.44),transparent 67%),rgba(245,240,243,.74);display:flex;align-items:center;justify-content:center;font:12px/1.3 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#4a4350}#${SB_CFG_MODAL_ID} .panel{width:min(1260px,96vw);max-height:min(92vh,760px);display:grid;grid-template-rows:auto auto;gap:10px;padding:14px;border-radius:20px;border:1px solid #f0d6e2;background:linear-gradient(145deg,rgba(255,255,255,.96),rgba(244,238,242,.95));box-shadow:0 16px 40px rgba(104,88,99,.22),inset 0 1px 0 rgba(255,255,255,.9)}#${SB_CFG_MODAL_ID} h2{margin:0;font-size:22px;color:#544a56}#${SB_CFG_MODAL_ID} .head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}#${SB_CFG_MODAL_ID} .hint{margin:4px 0 0;color:#7b6f7c}#${SB_CFG_MODAL_ID} .layout{display:grid;grid-template-columns:1fr;gap:8px}#${SB_CFG_MODAL_ID} .sections{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:8px}#${SB_CFG_MODAL_ID} .group{background:linear-gradient(150deg,rgba(255,255,255,.98),rgba(247,242,245,.96));border:1px solid #ecdde6;border-radius:12px;padding:8px}#${SB_CFG_MODAL_ID} .group h3{margin:0 0 6px;font-size:13px;color:#5f5462}#${SB_CFG_MODAL_ID} .group-grid{display:grid;grid-template-columns:1fr;gap:6px}#${SB_CFG_MODAL_ID} .field{background:#fff;border:1px solid #efe4eb;border-radius:10px;padding:7px;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}#${SB_CFG_MODAL_ID} .title{font-size:11px;color:#5f5463;margin-bottom:5px}#${SB_CFG_MODAL_ID} .num{display:grid;grid-template-columns:1fr 72px;gap:6px;align-items:center}#${SB_CFG_MODAL_ID} input[type=number]{width:100%;box-sizing:border-box;border:1px solid #dcced7;border-radius:7px;padding:5px 6px;font-size:12px;color:#4a4150;background:#fefcfd;text-align:center}#${SB_CFG_MODAL_ID} input[type=range]{width:100%;accent-color:#d88cae}#${SB_CFG_MODAL_ID} .chips{display:flex;gap:5px;flex-wrap:wrap}#${SB_CFG_MODAL_ID} .chip{border:1px solid #dcc6d2;background:#f8f3f6;color:#5f5562;border-radius:999px;padding:4px 7px;cursor:pointer;font-size:11px}#${SB_CFG_MODAL_ID} .chip.on{background:linear-gradient(135deg,#f6cde0,#f2b8d3);border-color:#df99bc;color:#4d3544}#${SB_CFG_MODAL_ID} .actions{display:flex;justify-content:flex-end;gap:8px}#${SB_CFG_MODAL_ID} .head .actions{margin-left:auto}#${SB_CFG_MODAL_ID} button{border:1px solid #dccad5;border-radius:9px;padding:7px 12px;cursor:pointer;font-weight:700;color:#5d4f60;background:#faf6f8}#${SB_CFG_MODAL_ID} button.primary{background:linear-gradient(135deg,#f7d2e3,#f2bad4);border-color:#de9dbe;color:#4f3c49}#${SB_CFG_MODAL_ID} .switch{display:flex;gap:6px;flex-wrap:wrap}#${SB_CFG_MODAL_ID} .switch-btn{border:1px solid #dcc6d2;background:#f8f3f6;color:#5f5562;border-radius:999px;padding:4px 10px;cursor:pointer;font-size:11px}#${SB_CFG_MODAL_ID} .switch-btn.on{background:linear-gradient(135deg,#f6cde0,#f2b8d3);border-color:#df99bc;color:#4d3544}`;
    (document.head || document.documentElement).appendChild(style);
  }
  function setFieldControlValue(field, input, value) {
    if (!input) return;
    const normalized = normalizeFieldValue(value, field);
    if (field.type === 'bool') {
      for (const button of input.buttons) button.classList.toggle('on', button.dataset.value === (normalized ? '1' : '0'));
    } else if (field.type === 'number') {
      input.range.value = String(normalized);
      input.num.value = String(normalized);
    } else {
      for (const button of input.buttons) button.classList.toggle('on', button.dataset.value === normalized);
    }
  }
  function collectFieldControlValue(field, input) {
    if (!input) throw new Error(`缺少配置控件：${field.label}`);
    if (field.type === 'bool') {
      const selected = input.buttons.find(button => button.classList.contains('on'));
      return String(selected?.dataset?.value || '0') === '1';
    }
    if (field.type === 'number') {
      const raw = String(input.num.value || '').trim();
      if (!raw) return field.def;
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new Error(`${field.label} 必须是数字`);
      return clampInt(num, field.min, field.max);
    }
    if (field.type === 'choice') {
      const selected = input.buttons.find(button => button.classList.contains('on'));
      const value = String(selected?.dataset?.value || '').trim();
      const allowed = (field.options || []).map(option => option.value);
      if (!allowed.includes(value)) throw new Error(`${field.label} 取值无效`);
      return value;
    }
    throw new Error('不支持的字段类型');
  }
  function openConfigPanel() {
    if (!document.body) { alert('页面尚未加载完成，请稍后重试。'); return; }
    ensureConfigStyle();
    document.getElementById(SB_CFG_MODAL_ID)?.remove();
    let settings;
    try {
      settings = loadSettings();
    } catch (error) {
      alert(`无法打开配置：${error?.message || error}`);
      return;
    }
    const modal = document.createElement('div');
    modal.id = SB_CFG_MODAL_ID;
    modal.innerHTML = '<div class="panel"><div class="head"><div><h2>⚙️ StreamBoost 全局参数</h2><p class="hint">作用于脚本匹配的所有网站与播放器 iframe；保存后刷新已打开页面生效。</p></div><div class="actions"><button data-act="close">关闭</button><button data-act="reset">恢复默认</button><button class="primary" data-act="save">保存全局配置</button></div></div><div class="layout"><div class="sections" data-zone="sections"></div></div></div>';
    const controls = new Map();
    const sectionsZone = modal.querySelector('[data-zone="sections"]');
    const groups = new Map();
    for (const field of CONFIG_FIELDS) {
      let groupGrid = groups.get(field.group);
      if (!groupGrid) {
        const group = document.createElement('section');
        group.className = 'group';
        group.innerHTML = `<h3>${field.group}</h3><div class="group-grid"></div>`;
        sectionsZone.appendChild(group);
        groupGrid = group.querySelector('.group-grid');
        groups.set(field.group, groupGrid);
      }
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<div class="title">${field.label}</div>`;
      let input = null;
      if (field.type === 'bool') {
        const wrap = document.createElement('div');
        wrap.className = 'switch';
        const buttons = [];
        [
          { value: '1', label: '启用' },
          { value: '0', label: '停用' }
        ].forEach(opt => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'switch-btn';
          btn.textContent = opt.label;
          btn.dataset.value = opt.value;
          btn.addEventListener('click', () => { for (const b of buttons) b.classList.remove('on'); btn.classList.add('on'); });
          buttons.push(btn);
          wrap.appendChild(btn);
        });
        row.appendChild(wrap);
        input = { buttons };
      } else if (field.type === 'number') {
        row.innerHTML += `<div class="num"><input type="range" min="${field.min}" max="${field.max}" step="${field.step || 1}"><input type="number" min="${field.min}" max="${field.max}" step="${field.step || 1}"></div>`;
        const range = row.querySelector('input[type="range"]');
        const num = row.querySelector('input[type="number"]');
        range.addEventListener('input', () => { num.value = range.value; });
        num.addEventListener('input', () => { const v = Number(num.value); if (Number.isFinite(v)) range.value = String(clampInt(v, field.min, field.max)); });
        input = { range, num };
      } else if (field.type === 'choice') {
        const chips = document.createElement('div');
        chips.className = 'chips';
        const buttons = [];
        for (const op of field.options || []) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'chip';
          btn.textContent = op.label;
          btn.dataset.value = op.value;
          btn.addEventListener('click', () => { for (const b of buttons) b.classList.remove('on'); btn.classList.add('on'); });
          buttons.push(btn);
          chips.appendChild(btn);
        }
        row.appendChild(chips);
        input = { buttons };
      }
      setFieldControlValue(field, input, settings.runtime[field.key]);
      groupGrid.appendChild(row);
      controls.set(field.key, input);
    }
    const close = () => modal.remove();
    const targetHint = document.createElement('p');
    targetHint.className = 'hint';
    sectionsZone.prepend(targetHint);
    const updateTargetHint = () => {
      const seconds = Math.max(...['forwardBufferSeconds','prefetchSeconds','maxBufferSeconds'].map(key => {
        const field = CONFIG_FIELDS.find(f => f.key === key);
        return normalizeFieldValue(controls.get(key).num.value, field);
      }));
      targetHint.textContent = '点播提前下载目标：' + seconds + ' 秒。三个时长取最大值，每批片段数不截短总时长；实际下载量受缓存容量和网络限制。';
    };
    modal.addEventListener('input', updateTargetHint);
    updateTargetHint();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-act="close"]').addEventListener('click', close);
    modal.querySelector('[data-act="reset"]').addEventListener('click', () => {
      for (const field of CONFIG_FIELDS) setFieldControlValue(field, controls.get(field.key), field.def);
      updateTargetHint();
    });
    modal.querySelector('[data-act="save"]').addEventListener('click', () => {
      try {
        const runtime = Object.fromEntries(CONFIG_FIELDS.map(field => [
          field.key,
          collectFieldControlValue(field, controls.get(field.key))
        ]));
        updateRuntimeConfig(runtime);
        alert('全局配置已保存；请刷新已打开的播放页面。');
        close();
      } catch (e) {
        alert(`保存失败：${e?.message || e}`);
      }
    });
    document.body.appendChild(modal);
  }
  const bootSettings = loadBootSettings();
  if (typeof GM_registerMenuCommand === 'function' && window.top === window) {
    const host = normHost(location.hostname);
    const siteDisabled = isHostDisabled(host, bootSettings);
    GM_registerMenuCommand(bootSettings.globalEnabled ? '🔌 全局状态（当前：启用）' : '🔌 全局状态（当前：停用）', () => {
      try {
        const updated = updateSettings(current => ({ ...current, globalEnabled: !current.globalEnabled }));
        alert(`已${updated.globalEnabled ? '启用' : '停用'}全局；请刷新已打开页面`);
      } catch (error) {
        alert(`更新失败：${error?.message || error}`);
      }
    });
    GM_registerMenuCommand(siteDisabled ? `✅ 移除当前主机名停用规则（${host}）` : `⛔ 停用当前主机名（${host}）`, () => {
      try {
        const current = loadSettings();
        const matchingRules = current.disabledHostPatterns.filter(pattern => hostMatches(host, pattern));
        if (matchingRules.length) {
          const broadRules = matchingRules.filter(pattern => pattern !== host);
          if (broadRules.length && !confirm(`当前主机名由通配规则 ${broadRules.join('、')} 停用。\n移除后也会影响这些规则覆盖的其他主机名，是否继续？`)) return;
          const confirmedRules = new Set(matchingRules);
          const updated = updateSettings(latest => ({
            ...latest,
            disabledHostPatterns: latest.disabledHostPatterns.filter(pattern => !confirmedRules.has(pattern))
          }));
          const stillDisabled = isHostDisabled(host, updated);
          alert(`已移除确认的当前主机名停用规则：${host}${stillDisabled ? '\n当前主机名仍被其他新规则停用' : ''}${updated.globalEnabled ? '' : '\n全局开关仍处于停用状态'}\n请刷新页面`);
        } else {
          let added = false;
          updateSettings(latest => {
            if (isHostDisabled(host, latest)) return latest;
            added = true;
            return { ...latest, disabledHostPatterns: [...latest.disabledHostPatterns, host] };
          });
          alert(added ? `已停用当前主机名：${host}\n请刷新页面` : `当前主机名已由其他规则停用：${host}\n请刷新页面`);
        }
      } catch (error) {
        alert(`更新失败：${error?.message || error}`);
      }
    });
    GM_registerMenuCommand('⚙️ 打开参数配置页', openConfigPanel);
    GM_registerMenuCommand(
      `🐞 Debug 日志（当前：${bootSettings.debugEnabled ? '启用' : '停用'}）`,
      () => {
        try {
          const updated = updateSettings(current => ({ ...current, debugEnabled: !current.debugEnabled }));
          alert(`已${updated.debugEnabled ? '启用' : '停用'} Debug 日志；请刷新已打开页面`);
        } catch (error) {
          alert(`更新失败：${error?.message || error}`);
        }
      }
    );
  }
  const runtimeConfig = resolveRuntimeConfig(bootSettings);
  const PAYLOAD = `
  (function(RUNTIME_CONFIG){
    'use strict';
    const DEBUG = RUNTIME_CONFIG.debugEnabled === true;
    const ACTIVE_MARKER = 'streamboost@1.4.0';
    try {
      const firstActivation = window.__HLS_BIGBUF_ACTIVE__ !== ACTIVE_MARKER;
      window.__HLS_BIGBUF_ACTIVE__ = ACTIVE_MARKER;
      if (firstActivation && DEBUG) console.log('[HLS BigBuffer] payload start', window === window.top ? 'top' : 'iframe');
      if (firstActivation) console.info('[HLS BigBuffer] 已激活', window === window.top ? 'top' : 'iframe');
    } catch {}
    const Native = (() => {
      let XHR   = window.XMLHttpRequest;
      let Fetch = window.fetch ? window.fetch.bind(window) : null;
      let AC    = window.AbortController;
      try {
        const mark = s => typeof s === 'function' && String(s).includes('[native code]');
        if (!mark(XHR) || (Fetch && !mark(Fetch)) || (AC && !mark(AC))) {
          const ifr = document.createElement('iframe');
          ifr.style.display = 'none';
          document.documentElement.appendChild(ifr);
          const w = ifr.contentWindow;
          if (w) {
            if (!mark(XHR)   && w.XMLHttpRequest) XHR   = w.XMLHttpRequest;
            if (Fetch && !mark(Fetch) && w.fetch) Fetch = w.fetch.bind(w);
            if (!mark(AC)    && w.AbortController) AC   = w.AbortController;
          }
          ifr.remove();
        }
      } catch {}
      return { XHR, Fetch, AC };
    })();
    const ENABLE_PREFETCH = RUNTIME_CONFIG.prefetchEnabled;
    const ENABLE_MEMCACHE = RUNTIME_CONFIG.memoryCacheEnabled;
    const PREFETCH_AHEAD = RUNTIME_CONFIG.prefetchAhead;
    const PREFETCH_CONC_GLOBAL = RUNTIME_CONFIG.maxConcurrentPrefetches;
    const PREFETCH_CONC_PER_ORIGIN = RUNTIME_CONFIG.maxConcurrentPrefetchesPerOrigin;
    const PREFETCH_TIMEOUT_MS = RUNTIME_CONFIG.prefetchTimeoutMs;
    const WAIT_INFLIGHT_MS = RUNTIME_CONFIG.inflightReuseWaitMs;
    const PREFETCH_STRATEGY = RUNTIME_CONFIG.prefetchStrategy;
    const FORWARD_BUFFER_SEC = RUNTIME_CONFIG.forwardBufferSeconds;
    const BACK_BUFFER_SEC = RUNTIME_CONFIG.backBufferSeconds;
    const MAX_MAX_BUFFER_SEC = RUNTIME_CONFIG.maxBufferSeconds;
    const TARGET_SECONDS = Math.max(FORWARD_BUFFER_SEC, RUNTIME_CONFIG.prefetchSeconds, MAX_MAX_BUFFER_SEC);
    const FAIL_TTL_MS      = 45000;
    const ORIGIN_BAN_MS    = 10 * 60 * 1000;
    const originFailCount  = new Map();
    const originBanUntil   = new Map();
    const MAX_MEM_MB = RUNTIME_CONFIG.maxMemoryMb;
    const MAX_MEM_BYTES = MAX_MEM_MB * 1024 * 1024;
    const MIN_MSE_BUFFER_BYTES = 60 * 1000 * 1000;
    const MSE_BUFFER_BYTES = Math.max(MIN_MSE_BUFFER_BYTES, RUNTIME_CONFIG.mseMemoryMb * 1024 * 1024);
    const log  = (...a)=>{ if (DEBUG) console.log('[HLS BigBuffer]', ...a); };
    const warn = (...a)=>{ console.warn('[HLS BigBuffer]', ...a); };
    function enforceMinNumber(value, minimum) {
      const num = Number(value);
      return Number.isFinite(num) ? Math.max(num, minimum) : minimum;
    }
    function buildHlsBufferConfig(baseConfig = {}) {
      return {
        maxBufferLength: enforceMinNumber(baseConfig.maxBufferLength, FORWARD_BUFFER_SEC),
        maxMaxBufferLength: Math.max(enforceMinNumber(baseConfig.maxMaxBufferLength, MAX_MAX_BUFFER_SEC),
          enforceMinNumber(baseConfig.maxBufferLength, FORWARD_BUFFER_SEC)),
        maxBufferSize: enforceMinNumber(baseConfig.maxBufferSize, MSE_BUFFER_BYTES),
        startFragPrefetch: true,
        backBufferLength: enforceMinNumber(baseConfig.backBufferLength, BACK_BUFFER_SEC)
      };
    }
    function cloneAB(input) {
      if (!input) return null;
      if (input instanceof ArrayBuffer) return input.slice(0);
      if (ArrayBuffer.isView(input)) {
        const { buffer, byteOffset, byteLength } = input;
        return buffer.slice(byteOffset, byteOffset + byteLength);
      }
      try { return new Uint8Array(input).buffer.slice(0); } catch { return null; }
    }
    function isDetached(buf) {
      try {
        return (buf instanceof ArrayBuffer) && new Uint8Array(buf).byteLength === 0;
      } catch { return true; }
    }
    function abSize(buf) {
      if (!buf) return 0;
      if (buf instanceof ArrayBuffer) return buf.byteLength || 0;
      if (ArrayBuffer.isView(buf))    return buf.byteLength || 0;
      return 0;
    }
    // Tasks belong to players; completed bytes belong to validated resources.
    const sessions = new Set();
    const prebuf = new Map(), inflightMap = new Map(), recentFailMap = new Map(), originSlots = new Map();
    const retiredByMedia = new WeakMap(), retiredScopes = new Set();
    const RETAIN_MS = 30000, diagnosticEvents = [];
    let prebufBytes = 0, sessionSequence = 0, resourceSequence = 0, pumping = false, pageSuspended = false;
    const metrics = { downloadedBytes: 0, usedBytes: 0, hits: 0, cancelled: 0 };
    function diagnose(reason, session, extra = {}) {
      if (!DEBUG) return;
      diagnosticEvents.push({time:performance.now(),reason,session:session?.id ?? null,...extra});
      if (diagnosticEvents.length > 128) diagnosticEvents.shift();
    }
    function deleteCache(key, reason = 'replaced') {
      const entry = prebuf.get(key);
      if (entry) { prebufBytes -= entry.bytes; prebuf.delete(key); diagnose(reason,null,{bytes:entry.bytes}); }
    }
    function lruGet(key) {
      const entry = prebuf.get(key);
      if (!entry) return null;
      if (isDetached(entry.buffer) || !abSize(entry.buffer)) { deleteCache(key); return null; }
      prebuf.delete(key); prebuf.set(key, entry);
      if (!entry.used) { metrics.usedBytes += entry.bytes; entry.used = true; }
      metrics.hits++;
      diagnose('cache-hit',null,{bytes:entry.bytes});
      return cloneAB(entry.buffer);
    }
    function bufferedResource(session, key) {
      const span = session.bufferedResources.get(key), ranges = session.hls?.media?.buffered;
      if (!span || !ranges) return false;
      // Demuxed timestamps can differ from playlist boundaries by one frame.
      for (let i=0;i<ranges.length;i++) {
        if (ranges.start(i) <= span.start + 0.1 && ranges.end(i) >= span.end - 0.1) return true;
      }
      session.bufferedResources.delete(key);
      return false;
    }
    function protectedCache(key, entry) {
      for (const session of sessions) {
        const w = session.window;
        if (!session.disposed && session.hls?.media && session.scope === entry.scope && w &&
            entry.level === w.level && entry.end > w.start && entry.start < w.end && !bufferedResource(session,key)) return true;
      }
      return false;
    }
    function reservedBytes(except) {
      let bytes = 0;
      for (const entry of inflightMap.values()) if (entry !== except) bytes += entry.reserved;
      return bytes;
    }
    function makeCacheRoom(bytes, except, replacingKey, session, context, commit = false) {
      if (bytes > MAX_MEM_BYTES) return false;
      let needed = prebufBytes - (prebuf.get(replacingKey)?.bytes || 0) + reservedBytes(except) + bytes - MAX_MEM_BYTES;
      if (needed <= 0) return true;
      const candidates=[];
      for (const [key,entry] of prebuf) {
        if (key === replacingKey) continue;
        const farther = session?.scope === entry.scope && context?.frag.level === entry.level && context.frag.start < entry.start;
        if (protectedCache(key,entry) && !farther) continue;
        let rank=1;
        for (const owner of sessions) {
          if (owner.scope !== entry.scope || !owner.window) continue;
          const w=owner.window;
          if (entry.end <= w.start) { rank=0; break; }
          if (entry.level === w.level && entry.start < w.end && entry.end > w.start) rank=bufferedResource(owner,key) ? 2 : 3;
        }
        candidates.push({key,entry,rank});
      }
      candidates.sort((a,b)=>a.rank-b.rank || (a.rank===3 ? b.entry.start-a.entry.start : 0));
      const victims=[];
      for (const candidate of candidates) {
        victims.push(candidate.key); needed-=candidate.entry.bytes;
        if (needed<=0) {
          // Admission only reserves reclaimable space. Failed requests never
          // discard completed resources; successful writes commit atomically.
          if (commit) for (const key of victims) deleteCache(key,'capacity');
          return true;
        }
      }
      return false;
    }
    function lruSet(key, buffer, session, context, pending) {
      const bytes = abSize(buffer);
      if (!ENABLE_MEMCACHE || !bytes || session.disposed) return false;
      if (!makeCacheRoom(bytes,pending,key,session,context)) {
        session.requiredBytes.set(key,{bytes,start:context.frag.start,end:context.frag.start + context.frag.duration});
        diagnose('capacity-blocked',session,{bytes});
        return false;
      }
      const copy = cloneAB(buffer);
      if (!copy) return false;
      makeCacheRoom(bytes,pending,key,session,context,true);
      deleteCache(key);
      const [,playlist,identity] = JSON.parse(key);
      const frag = context.frag;
      prebuf.set(key, { buffer: copy, bytes, scope:session.scope, playlist,identity,used: false,
        level:frag.level,start:frag.start,end:frag.start + frag.duration }); prebufBytes += bytes;
      session.requiredBytes.delete(key);
      return true;
    }
    function fragmentRange(context) {
      const frag = context.frag || context;
      // Hls.js uses 0/0 for a full response, not an empty byte range.
      const fullResponse = context.rangeStart === 0 && context.rangeEnd === 0;
      const start = fullResponse ? frag.byteRangeStartOffset : (context.rangeStart ?? frag.byteRangeStartOffset);
      const end = fullResponse ? frag.byteRangeEndOffset : (context.rangeEnd ?? frag.byteRangeEndOffset);
      if (start == null && end == null) return { start: null, end: null };
      if (Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(end) && end > start) return { start, end };
      return null;
    }
    function completeResponse(context, data, network) {
      const bytes = abSize(data), range = fragmentRange(context), status = network?.status;
      if (!bytes || !range || (status && (status < 200 || status >= 300))) return false;
      if (range.start === null) return status !== 206;
      if (status !== 206 || bytes !== range.end - range.start) return false;
      const contentRange = network?.getResponseHeader?.('Content-Range') || network?.headers?.get?.('Content-Range');
      return !contentRange || contentRange.startsWith('bytes ' + range.start + '-' + (range.end - 1) + '/');
    }
    function fragmentIdentity(frag, url = frag?.url) {
      if (!frag || !url || frag.encrypted) return null;
      const range = fragmentRange(frag), init = frag.initSegment, initRange = init && fragmentRange(init);
      if (!range || (init && (!init.url || !initRange))) return null;
      return JSON.stringify([frag.type || 'main',url,range.start,range.end,frag.sn,frag.cc,
        init ? [init.url,initRange.start,initRange.end] : null]);
    }
    function cancelTasks(session, reason) {
      session.epoch++; session.queue = [];
      session.window = null; session.requiredBytes.clear(); clearTimeout(session.retryTimer);
      for (const entry of inflightMap.values()) if (entry.session === session) entry.cancel();
      diagnose(reason,session);
    }
    function invalidateScope(scope, reason) {
      if (!scope) return;
      clearTimeout(scope.timer); retiredScopes.delete(scope); scope.expires = 0;
      for (const [key,entry] of prebuf) if (entry.scope === scope) deleteCache(key,reason);
      scope.playlists.clear();
    }
    function requestContract(session) {
      const c = session.hls.config;
      return [session.Loader,c.loader,c.xhrSetup,c.fetchSetup,c.progressive];
    }
    function ensureScope(session) {
      if (session.disposed || !session.hls) return null;
      const contract = requestContract(session), source = session.source || session.hls.url;
      if (!source) return null;
      if (!session.scope || session.scope.source !== source || contract.some((v,i)=>v !== session.contract?.[i])) {
        cancelTasks(session,'resource-context-changed');
        session.bufferedResources.clear();
        invalidateScope(session.scope,'resource-context-changed');
        session.catalog.clear(); session.contract = contract;
        session.scope = {id:++resourceSequence,source,playlists:new Map(),expires:0,
          opaque:!!(session.custom || contract[2] || contract[3] || contract[4]),loader:session.Loader};
      }
      const media = session.mediaRef?.deref(), previous = media && retiredByMedia.get(media);
      if (!session.scope.opaque && !session.scope.playlists.size && previous && previous !== session.scope &&
          previous.expires > performance.now() && previous.source === source && previous.loader === session.Loader) {
        clearTimeout(previous.timer); retiredScopes.delete(previous); retiredByMedia.delete(media);
        previous.expires = 0; session.scope = previous;
        diagnose('resource-scope-restored',session);
      }
      return session.scope;
    }
    function confirmPlaylist(session, level, details) {
      if (!ENABLE_MEMCACHE) return null;
      const scope = ensureScope(session);
      if (!scope || !session.mediaRef?.deref() || !details?.url || !Array.isArray(details.fragments)) return null;
      const identities = details.fragments.map(f=>fragmentIdentity(f));
      // Initialization segments also pass through fLoader.
      const members = new Set(identities.filter(Boolean));
      for (const frag of details.fragments) {
        const init = frag.initSegment && fragmentIdentity(frag.initSegment);
        if (init) members.add(init);
      }
      // Hls.js adjusts fragment start/duration after demuxing. The original
      // manifest text and immutable resource descriptors identify a playlist.
      const name = JSON.stringify(['main',details.url]);
      const signature = JSON.stringify([details.m3u8 ?? null,identities]);
      let record = scope.playlists.get(name);
      if (!record || record.live !== !!details.live || (!details.live && record.signature !== signature)) {
        if (record) {
          record.active = false;
          for (const [key,entry] of prebuf) if (entry.scope === scope && entry.playlist === record.id) deleteCache(key,'playlist-changed');
        }
        record = {id:++resourceSequence,live:!!details.live,signature:details.live ? null : signature,members,active:true};
        scope.playlists.set(name,record);
      } else {
        record.members = members;
        if (record.live) {
          for (const [key,entry] of prebuf) {
            if (entry.scope === scope && entry.playlist === record.id && !members.has(entry.identity)) deleteCache(key,'live-window-expired');
          }
        }
      }
      session.catalog.set(level,{details,record});
      session.staleDetails?.delete(details);
      return record;
    }
    function resourceKey(session, context) {
      if (!ENABLE_MEMCACHE || pageSuspended || !ensureScope(session)) return null;
      if (context.part || context.resetIV || (context.headers && Object.keys(context.headers).length) || session.hls.config.progressive) {
        diagnose('unsupported-request-context',session); return null;
      }
      const frag = context.frag, range = fragmentRange(context);
      if (!frag || !['main','video'].includes(frag.type || 'main') || !range || !context.url) return null;
      const details = session.hls.levels?.[frag.level]?.details;
      let known = session.catalog.get(frag.level);
      if (!known || !known.record.active || known.details !== details) {
        // Never infer resource continuity from stale levels during manifest reload.
        if (session.manifestPending || !details || session.staleDetails?.has(details)) { diagnose('playlist-unconfirmed',session); return null; }
        confirmPlaylist(session,frag.level,details); known = session.catalog.get(frag.level);
      }
      const identity = fragmentIdentity(frag,context.url), ownRange = fragmentRange(frag);
      if (!identity || !ownRange || range.start !== ownRange.start || range.end !== ownRange.end || !known?.record.members.has(identity)) return null;
      return JSON.stringify([session.scope.id,known.record.id,identity]);
    }
    function requestKey(session, key) { return JSON.stringify([session.id,key]); }
    function disposeSession(session) {
      if (session.disposed) return;
      cancelTasks(session,'session-destroyed'); session.disposed = true;
      sessions.delete(session); session.detach?.();
      const scope = session.scope, media = (session.mediaRef || session.lastMediaRef)?.deref();
      if (!pageSuspended && media && scope && !scope.opaque && scope.playlists.size &&
          [...scope.playlists.values()].every(p=>!p.live) && [...prebuf.values()].some(e=>e.scope === scope)) {
        const old = retiredByMedia.get(media);
        if (old && old !== scope) invalidateScope(old,'retention-replaced');
        scope.expires = performance.now() + RETAIN_MS;
        retiredByMedia.set(media,scope); retiredScopes.add(scope);
        scope.timer = setTimeout(()=>invalidateScope(scope,'retention-expired'),RETAIN_MS);
      } else invalidateScope(scope,'session-destroyed');
      session.scope = null; session.hls = null; session.mediaRef = null; session.lastMediaRef = null;
      session.catalog.clear(); session.contract = null; session.Loader = null;
      session.detach = null; session.schedule = null;
    }
    function sweepPenalties() {
      const now = performance.now();
      for (const [key, until] of recentFailMap) if (until <= now) recentFailMap.delete(key);
      for (const [origin, until] of originBanUntil) if (until <= now) { originBanUntil.delete(origin); originFailCount.delete(origin); }
      for (const map of [recentFailMap, originBanUntil, originFailCount]) {
        while (map.size > 512) map.delete(map.keys().next().value);
      }
    }
    class CacheFirstFragLoader {
      constructor(cfg, session) {
        this.session = session;
        this.inner = new session.Loader(cfg);
        this.stats = this.inner.stats || {};
        this.generation = 0;
      }
      load(context, config, callbacks) {
        this.abort();
        const generation = ++this.generation;
        this.context = context;
        this.stats.aborted = false;
        let phase = 'waiting', completeProgress = null;
        const key = resourceKey(this.session, context), scope = this.session.scope;
        const demand = {key,generation};
        this.session.demands.set(this,demand);
        const release = () => {
          if (this.session.demands.get(this) === demand) this.session.demands.delete(this);
          this.session.schedule?.();
        };
        this.cancelLoad = () => {
          if (phase === 'done') return;
          phase = 'done'; completeProgress = null;
          release();
          callbacks.onAbort?.(this.stats, context, null);
        };
        const valid = () => generation === this.generation && phase !== 'done';
        const finish = (name, args) => {
          if (!valid()) return;
          if (name === 'onSuccess' && key && scope === this.session.scope && resourceKey(this.session,context) === key) {
            const response = args[0]?.data;
            const data = completeResponse(context,response,args[3]) ? response :
              (response === completeProgress?.original && isDetached(response) ? completeProgress.copy : null);
            if (completeResponse(context,data,args[3])) lruSet(key,data,this.session,context);
          }
          completeProgress = null;
          phase = 'done'; clearTimeout(this.waitTimer);
          release();
          if (this.inner.stats) this.stats = this.inner.stats;
          callbacks[name]?.(...args);
        };
        const deliver = buffer => {
          if (!valid() || phase !== 'waiting') return;
          const now = performance.now();
          Object.assign(this.stats, { aborted: false, loaded: buffer.byteLength, total: buffer.byteLength, retry: 0,
            chunkCount: 1, bwEstimate: 0, loading: { start: now, first: now, end: now },
            parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
            trequest: now, tfirst: now, tload: now });
          phase = 'done'; clearTimeout(this.waitTimer);
          release();
          callbacks.onProgress?.(this.stats, context, cloneAB(buffer), null);
          if (generation === this.generation) callbacks.onSuccess?.({url:context.url, data:buffer}, this.stats, context, null);
        };
        const goInner = () => {
          if (!valid() || phase !== 'waiting') return;
          phase = 'inner'; clearTimeout(this.waitTimer);
          const guarded = { ...callbacks };
          for (const name of ['onSuccess','onError','onTimeout','onAbort']) guarded[name] = (...args) => finish(name, args);
          if (callbacks.onProgress) guarded.onProgress = (...args) => {
            if (!valid()) return;
            const [stats,,data,network] = args;
            // XHR delivers the full buffer to onProgress before onSuccess. The
            // consumer may transfer it; stage a copy, commit only on success.
            if (key && !completeProgress && stats?.loaded === stats?.total &&
                stats.total === abSize(data) && completeResponse(context,data,network)) completeProgress = {original:data,copy:cloneAB(data)};
            callbacks.onProgress?.(...args);
          };
          try { this.inner.load(context, config, guarded); this.stats = this.inner.stats || this.stats; }
          catch (error) { finish('onError', [{code:0,text:String(error)},context,null]); }
        };
        if (key) {
          const hit = lruGet(key);
          if (hit) { deliver(hit); return; }
          diagnose('cache-miss',this.session);
          const pending = inflightMap.get(requestKey(this.session,key));
          if (pending) {
            this.waitTimer = setTimeout(goInner, WAIT_INFLIGHT_MS);
            pending.promise.then(buffer => {
              if (!valid() || phase !== 'waiting') return;
              const copy = buffer && scope === this.session.scope && resourceKey(this.session,context) === key && (lruGet(key) || cloneAB(buffer));
              if (copy) deliver(copy); else goInner();
            }, goInner);
            return;
          }
        }
        goInner();
      }
      abort() {
        this.generation++; clearTimeout(this.waitTimer);
        if (this.stats) this.stats.aborted = true;
        const cancel = this.cancelLoad; this.cancelLoad = null;
        try { this.inner?.abort?.(); } catch {}
        cancel?.();
      }
      destroy() { this.abort(); try { this.inner?.destroy?.(); } catch {} }
      getCacheAge() { return this.inner?.getCacheAge?.() ?? null; }
      getResponseHeader(name) { return this.inner?.getResponseHeader?.(name) ?? null; }
    }
    // A transport always settles, even if an underlying abort emits no callback.
    function runTransport(kind, entry) {
      const { session, context } = entry;
      return new Promise(resolve => {
        let settled = false, handle, timer;
        const done = result => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          entry.stopTransport = null;
          if (kind === 'hls') { try { handle?.destroy?.(); } catch {} }
          resolve(result);
        };
        entry.stopTransport = () => {
          const current = handle;
          done({ cancelled: true });
          try { current?.abort?.(); } catch {}
        };
        timer = setTimeout(() => {
          const current = handle;
          done({ timeout: true });
          try { current?.abort?.(); } catch {}
        }, PREFETCH_TIMEOUT_MS);
        const range = fragmentRange(context);
        const statusResult = (network, buffer) => {
          if (completeResponse(context,buffer,network)) done({ buffer });
          else done({ status:network?.status || 0 });
        };
        try {
          if (kind === 'hls') {
            handle = new session.Loader(session.hls.config);
            const policy = session.hls.config.fragLoadPolicy?.default;
            const loaderConfig = { timeout:PREFETCH_TIMEOUT_MS,maxRetry:0,retryDelay:0,maxRetryDelay:0,
              ...(policy ? {loadPolicy:{...policy,maxTimeToFirstByteMs:PREFETCH_TIMEOUT_MS,maxLoadTimeMs:PREFETCH_TIMEOUT_MS,timeoutRetry:null,errorRetry:null}} : {}) };
            handle.load(context, loaderConfig, {
              onSuccess: (response, stats, ctx, network) => {
                const buffer = response?.data;
                statusResult(network || {status:response?.code},buffer);
              },
              onError: error => done({status:Number(error?.code) || 0}),
              onTimeout: () => done({timeout:true}), onAbort: () => done({cancelled:true})
            });
          } else if (kind === 'xhr') {
            handle = new Native.XHR();
            handle.open('GET', context.url, true); handle.responseType = 'arraybuffer';
            handle.onload = () => statusResult(handle, handle.response);
            handle.onerror = () => done({status:handle.status});
            handle.onabort = () => done({cancelled:true});
            handle.ontimeout = () => done({timeout:true});
            handle.timeout = PREFETCH_TIMEOUT_MS;
            Promise.resolve(session.hls.config.xhrSetup?.(handle, context.url)).then(() => {
              if (settled) return;
              if (range.start !== null) handle.setRequestHeader('Range', 'bytes=' + range.start + '-' + (range.end - 1));
              handle.send();
            }).catch(() => done({status:0}));
          } else {
            handle = new (Native.AC || AbortController)();
            const headers = range.start === null ? {} : {Range:'bytes=' + range.start + '-' + (range.end - 1)};
            (Native.Fetch || fetch)(context.url, {mode:'cors',credentials:'same-origin',headers,signal:handle.signal})
              .then(async response => statusResult(response, response.ok ? await response.arrayBuffer() : null))
              .catch(() => done({status:0}));
          }
        } catch { done({status:0}); }
      });
    }
    function startPrefetch(session, context) {
      const key = resourceKey(session, context), origin = new URL(context.url, location.href).origin;
      const pendingKey = requestKey(session,key);
      if (!key || inflightMap.has(pendingKey) || prebuf.has(key)) return;
      const entry = { session, context, key, origin, epoch:session.epoch, cancelled:false, stopTransport:null,
        reserved:session.requiredBytes.get(key)?.bytes || session.estimate };
      let resolve;
      entry.promise = new Promise(r => { resolve = r; });
      entry.cancel = () => { entry.cancelled = true; entry.stopTransport?.(); };
      inflightMap.set(pendingKey, entry);
      originSlots.set(origin, (originSlots.get(origin) || 0) + 1);
      const started = performance.now();
      (async () => {
        let result = null;
        try {
          // Unknown custom/auth setup must keep the original transport contract.
          const config = session.hls.config;
          const originalOnly = session.custom || config.fetchSetup || config.xhrSetup;
          const chain = originalOnly ? ['hls'] : PREFETCH_STRATEGY.replace('-only','').split('-');
          for (const kind of chain) {
            if (entry.cancelled || entry.epoch !== session.epoch || session.disposed) break;
            const response = await runTransport(kind, entry);
            if (response.buffer) { result = response.buffer; break; }
            if (response.cancelled || [401,403,404,429].includes(response.status)) break;
          }
          if (!entry.cancelled && entry.epoch === session.epoch && !session.disposed && resourceKey(session,context) === key) {
            if (result) {
              metrics.downloadedBytes += result.byteLength;
              const stored = lruSet(key, result, session, context, entry);
              if (!stored && !session.requiredBytes.has(key)) {
                recentFailMap.set(pendingKey,performance.now() + FAIL_TTL_MS);
                diagnose('cache-copy-failed',session);
              }
              originFailCount.delete(origin); originBanUntil.delete(origin);
              session.estimate = Math.max(result.byteLength,session.estimate * 0.75 + result.byteLength * 0.25);
            } else {
              recentFailMap.set(pendingKey, performance.now() + FAIL_TTL_MS);
              const count = (originFailCount.get(origin) || 0) + 1;
              originFailCount.set(origin, count);
              if (count >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
            }
            if (RUNTIME_CONFIG.adaptivePrefetch) {
              const slow = !result || performance.now() - started > (context.frag.duration || 5) * 1000;
              session.badSamples = slow ? session.badSamples + 1 : 0;
              session.goodSamples = slow ? 0 : session.goodSamples + 1;
              if (session.badSamples >= 2) { session.limit = Math.max(1,session.limit - 1); session.badSamples = 0; }
              if (session.goodSamples >= 8) { session.limit = Math.min(PREFETCH_CONC_GLOBAL,session.limit + 1); session.goodSamples = 0; }
            }
          } else { result = null; metrics.cancelled++; }
        } catch {
          result = null; recentFailMap.set(pendingKey,performance.now() + FAIL_TTL_MS);
          diagnose('prefetch-error',session);
        }
        finally {
          if (inflightMap.get(pendingKey) === entry) inflightMap.delete(pendingKey);
          const slots = (originSlots.get(origin) || 1) - 1;
          if (slots) originSlots.set(origin,slots); else originSlots.delete(origin);
          resolve(result); sweepPenalties();
          for (const current of sessions) current.schedule?.();
        }
      })();
    }
    function pumpPrefetch() {
      if (pumping || pageSuspended) return;
      pumping = true;
      try {
        let progress = true;
        while (progress && inflightMap.size < PREFETCH_CONC_GLOBAL) {
          progress = false;
          for (const session of sessions) {
            if (session.disposed || !session.hls?.media || !session.queue.length || inflightMap.size >= PREFETCH_CONC_GLOBAL) continue;
            if (session.demands.size) { session.stopReason = 'playback-request'; continue; }
            if (RUNTIME_CONFIG.adaptivePrefetch && navigator.connection?.saveData) continue;
            const active = [...inflightMap.values()].filter(e => e.session === session).length;
            if (active >= session.limit) continue;
            const context = session.queue[0], key = resourceKey(session,context);
            const pendingKey = requestKey(session,key);
            if (!key || prebuf.has(key) || bufferedResource(session,key) || inflightMap.has(pendingKey)) {
              session.queue.shift(); progress = true; continue;
            }
            const origin = new URL(context.url,location.href).origin;
            if ((originSlots.get(origin) || 0) >= PREFETCH_CONC_PER_ORIGIN) continue;
            const retryAt = Math.max(recentFailMap.get(pendingKey) || 0,originBanUntil.get(origin) || 0);
            if (retryAt > performance.now()) {
              session.stopReason = 'request-backoff';
              clearTimeout(session.retryTimer);
              session.retryTimer = setTimeout(()=>session.schedule?.(),retryAt-performance.now()+1);
              continue;
            }
            if (!makeCacheRoom(session.requiredBytes.get(key)?.bytes || session.estimate,null,null,session,context)) {
              session.stopReason = 'capacity'; continue;
            }
            session.queue.shift(); progress = true; session.stopReason = 'downloading';
            startPrefetch(session,context);
          }
        }
      } finally { pumping = false; }
    }
    function attachPrefetch(hls, session, Ev) {
      sessions.add(session); session.hls = hls;
      const listeners = [];
      const on = (event, fn) => { if (event) { hls.on(event,fn); listeners.push([event,fn]); } };
      let media, scheduled = false;
      const contextFor = frag => {
        let url;
        try { url = frag.url; } catch { return null; }
        const range = fragmentRange(frag);
        if (!url || !range || frag.gap) return null;
        const context = {url,responseType:'arraybuffer',type:'fragment',frag,part:null};
        if (range.start !== null) { context.rangeStart=range.start; context.rangeEnd=range.end; }
        return context;
      };
      const refresh = () => {
        session.queue = [];
        if (session.disposed || !media || pageSuspended) { session.stopReason='detached'; return; }
        if (!ENABLE_PREFETCH || !ENABLE_MEMCACHE || !PREFETCH_AHEAD) { session.stopReason='disabled'; return; }
        if (RUNTIME_CONFIG.adaptivePrefetch && navigator.connection?.saveData) { session.stopReason='save-data'; return; }
        const level = hls.loadLevel >= 0 ? hls.loadLevel : hls.currentLevel;
        const details = hls.levels?.[level]?.details;
        if (session.manifestPending || !Array.isArray(details?.fragments) || session.staleDetails?.has(details)) {
          session.stopReason='playlist-unconfirmed'; return;
        }
        const fragments = details.fragments, start = media.currentTime;
        const horizon = details.live ? (RUNTIME_CONFIG.adaptivePrefetch ? Math.min(12,RUNTIME_CONFIG.prefetchSeconds) : RUNTIME_CONFIG.prefetchSeconds) : TARGET_SECONDS;
        session.targetSeconds = horizon;
        const end = Math.min(start + horizon, fragments.length ? fragments.at(-1).start + fragments.at(-1).duration : start);
        // Confirm the scope before publishing the window: identity changes cancel tasks.
        ensureScope(session);
        session.window = {level,start,end};
        session.stopReason = 'target-covered';
        for (const [key] of session.bufferedResources) bufferedResource(session,key);
        for (const entry of inflightMap.values()) {
          const f = entry.context.frag;
          if (entry.session === session && (f.level !== level || f.start + f.duration <= start || f.start >= end)) entry.cancel();
        }
        for (const [key,required] of session.requiredBytes) {
          const identity = JSON.parse(key)[2];
          if (required.end <= start || required.start >= end || !session.catalog.get(level)?.record.members.has(identity)) session.requiredBytes.delete(key);
        }
        // Fragments are ordered by presentation time. Search the window start,
        // then build only one batch of missing resources, not a second cache.
        let low=0, high=fragments.length;
        while (low<high) {
          const mid=(low+high)>>>1, f=fragments[mid];
          if (f.start+f.duration <= start) low=mid+1; else high=mid;
        }
        for (let i=low;i<fragments.length && fragments[i].start<end;i++) {
          const context = contextFor(fragments[i]);
          if (!context) continue;
          const key = resourceKey(session,context);
          if (!key) { session.stopReason='unsupported-resource'; continue; }
          const cached=prebuf.get(key);
          if (cached) {
            // Hls.js refines the presentation timeline after demuxing. Keep
            // coverage metadata current without changing resource identity.
            cached.start=context.frag.start; cached.end=cached.start+context.frag.duration;
            continue;
          }
          if (bufferedResource(session,key)) continue;
          if (inflightMap.has(requestKey(session,key))) { session.stopReason='downloading'; continue; }
          session.queue.push(context);
          session.stopReason='queued';
          if (session.queue.length >= PREFETCH_AHEAD) break;
        }
        pumpPrefetch();
      };
      session.schedule = () => {
        if (scheduled || session.disposed) return;
        scheduled = true;
        queueMicrotask(() => { scheduled=false; refresh(); });
      };
      const seeking = () => { cancelTasks(session,'seek'); session.schedule(); };
      const unbind = () => {
        media?.removeEventListener('seeking',seeking);
        media?.removeEventListener('timeupdate',session.schedule);
        session.bufferedResources.clear();
      };
      const bindMedia = () => {
        if (media !== hls.media) { unbind(); media = hls.media; }
        if (media) session.lastMediaRef = session.mediaRef = new WeakRef(media);
        ensureScope(session);
        media?.addEventListener('seeking',seeking);
        media?.addEventListener('timeupdate',session.schedule);
        session.schedule();
      };
      on(Ev.MEDIA_ATTACHING,bindMedia); on(Ev.MEDIA_ATTACHED,bindMedia); bindMedia();
      on(Ev.MEDIA_DETACHING,() => {
        unbind(); media=null; session.mediaRef=null; cancelTasks(session,'media-detached');
      });
      on(Ev.MANIFEST_LOADING,(_event,data) => {
        cancelTasks(session,'manifest-loading'); session.source = hls.url || data?.url;
        session.bufferedResources.clear();
        session.staleDetails = new WeakSet([...session.catalog.values()].map(item=>item.details));
        session.manifestPending = true; session.catalog.clear(); ensureScope(session);
      });
      on(Ev.MANIFEST_PARSED,() => { session.manifestPending = false; session.schedule(); });
      on(Ev.LEVEL_LOADED,(_event,data) => {
        session.manifestPending = false; confirmPlaylist(session,data.level,data.details); session.schedule();
      });
      on(Ev.LEVEL_SWITCHING,() => { cancelTasks(session,'level-switch'); session.schedule(); });
      on(Ev.FRAG_BUFFERED,(_event,data) => {
        const context = data?.frag && contextFor(data.frag);
        const key = context && !data.part && resourceKey(session,context);
        if (key) {
          const frag = data.frag, start=frag.start, end=start+frag.duration;
          for (const [other,span] of session.bufferedResources) {
            if (other !== key && span.start < end-0.1 && span.end > start+0.1) session.bufferedResources.delete(other);
          }
          session.bufferedResources.set(key,{start,end,level:frag.level});
          session.requiredBytes.delete(key);
        }
        session.schedule();
      });
      on(Ev.BUFFER_FLUSHING,(_event,data) => {
        for (const [key,span] of session.bufferedResources) {
          if (span.start < data.endOffset && span.end > data.startOffset) session.bufferedResources.delete(key);
        }
      });
      on(Ev.BUFFER_FLUSHED,session.schedule);
      on(Ev.FRAG_LOADING,session.schedule); on(Ev.FRAG_LOADED,session.schedule);
      on(Ev.DESTROYING,() => disposeSession(session));
      session.detach = () => {
        unbind(); media = null; clearTimeout(session.retryTimer);
        for (const [event,fn] of listeners) hls.off?.(event,fn);
        listeners.length = 0;
      };
    }
    window.addEventListener('pagehide', () => {
      pageSuspended = true;
      for (const session of sessions) { cancelTasks(session,'page-hidden'); invalidateScope(session.scope,'page-hidden'); session.catalog.clear(); }
      for (const scope of retiredScopes) invalidateScope(scope,'page-hidden');
    });
    window.addEventListener('pageshow', () => { pageSuspended = false; for (const session of sessions) session.schedule?.(); });
    function mergeRanges(spans) {
      const out=[];
      for (const span of spans.sort((a,b)=>a[0]-b[0])) {
        const last=out.at(-1);
        if (last && span[0] <= last[1]+0.05) last[1]=Math.max(last[1],span[1]);
        else out.push([...span]);
      }
      return out;
    }
    if (DEBUG) window.__STREAMBOOST_DIAGNOSTICS__ = () => ({...metrics,cacheBytes:prebufBytes,reservedBytes:reservedBytes(),activeRequests:inflightMap.size,sessions:sessions.size,
      events:diagnosticEvents.map(e=>({...e})),retainedScopes:retiredScopes.size,
      players:[...sessions].map(s=>{
        const media = s.hls?.media, buffered = media?.buffered;
        const cacheRanges = mergeRanges([...prebuf.values()].filter(e=>e.scope===s.scope && e.level===s.window?.level && Number.isFinite(e.start)).map(e=>[e.start,e.end]));
        const confirmed = [...s.bufferedResources].filter(([key,span])=>span.level===s.window?.level && bufferedResource(s,key)).map(([,span])=>[span.start,span.end]);
        const availableRanges = mergeRanges([...cacheRanges,...confirmed]);
        const time=media?.currentTime ?? 0, continuous=availableRanges.find(r=>r[0]<=time+0.05 && r[1]>time);
        return {id:s.id,taskGeneration:s.epoch,queued:s.queue.length,resource:s.scope?.id ?? null,
          targetSeconds:s.targetSeconds ?? TARGET_SECONDS,window:s.window ? {...s.window} : null,stopReason:s.stopReason,
          cacheRanges,availableRanges,downloadedAheadSeconds:continuous ? continuous[1]-time : 0,
          attached:!!media,currentTime:media?.currentTime ?? null,level:s.hls?.currentLevel ?? null,
          buffered:buffered ? Array.from({length:buffered.length},(_,i)=>[buffered.start(i),buffered.end(i)]) : []};
      })});

    function isCtor(v){ return typeof v === 'function' && !!v.DefaultConfig && !!v.Events; }
    const patchedConstructors = new WeakMap();
    const adapters = [];
    function registerAdapter(adapter){
      if (!adapter || typeof adapter.install !== 'function') return;
      adapters.push(adapter);
    }
    function runAdapters(){
      for (const adapter of adapters) {
        try { adapter.install(); }
        catch (e) { warn('adapter install failed', adapter?.name || 'unknown', e); }
      }
    }
    function patchHlsClass(OriginalHls){
      try{
        if(!OriginalHls || OriginalHls.__HLS_BIGBUF_PATCHED__ || !isCtor(OriginalHls)) return OriginalHls;
        if (patchedConstructors.has(OriginalHls)) return patchedConstructors.get(OriginalHls);
        const initialDefaultLoader = OriginalHls.DefaultConfig.loader;
        try {
          if (OriginalHls.DefaultConfig) Object.assign(OriginalHls.DefaultConfig, buildHlsBufferConfig(OriginalHls.DefaultConfig));
          log('DefaultConfig applied', OriginalHls.DefaultConfig);
        } catch(e){ log('DefaultConfig assign failed (frozen?)', e); }
        class PatchedHls extends OriginalHls {
          constructor(userConfig = {}){
            if (!userConfig || typeof userConfig !== 'object') userConfig = {};
            const enforced = Object.assign({}, userConfig, buildHlsBufferConfig(userConfig));
            const originalConfig = Object.assign({},OriginalHls.DefaultConfig,userConfig);
            const Loader = originalConfig.fLoader || originalConfig.loader;
            const session = {id:++sessionSequence,epoch:0,Loader,custom:!!(originalConfig.fLoader || userConfig.loader ||
              originalConfig.loader !== initialDefaultLoader),catalog:new Map(),
              disposed:false,queue:[],demands:new Map(),bufferedResources:new Map(),requiredBytes:new Map(),estimate:2*1024*1024,limit:PREFETCH_CONC_GLOBAL,badSamples:0,goodSamples:0};
            if (ENABLE_MEMCACHE && typeof Loader === 'function') {
              enforced.fLoader = class extends CacheFirstFragLoader { constructor(cfg) { super(cfg,session); } };
            }
            super(enforced);
            this.__streamboostSession = session;
            attachPrefetch(this,session,OriginalHls.Events);
            window.__HLS_BIGBUF_LAST__ = this;
            log('Hls instance created', {prefetch:ENABLE_PREFETCH,memcache:ENABLE_MEMCACHE});
          }
          destroy() {
            disposeSession(this.__streamboostSession);
            if (window.__HLS_BIGBUF_LAST__ === this) window.__HLS_BIGBUF_LAST__ = null;
            return super.destroy();
          }
        }
        Object.getOwnPropertyNames(OriginalHls).forEach((name)=>{
          if (['length','prototype','name','DefaultConfig'].includes(name)) return;
          try { Object.defineProperty(PatchedHls, name, Object.getOwnPropertyDescriptor(OriginalHls, name)); } catch {}
        });
        Object.defineProperty(PatchedHls, 'DefaultConfig', {
          get(){ return OriginalHls.DefaultConfig; },
          set(v){ OriginalHls.DefaultConfig = v; }
        });
        Object.defineProperty(PatchedHls, '__HLS_BIGBUF_PATCHED__', { value: true });
        log('PatchedHls ready. version=', OriginalHls.version, 'events=', OriginalHls.Events);
        patchedConstructors.set(OriginalHls,PatchedHls);
        return PatchedHls;
      }catch(e){
        warn('patchHlsClass failed', e);
        return OriginalHls;
      }
    }
    function armSetterOnce(){
      const descriptor = Object.getOwnPropertyDescriptor(window,'Hls');
      if (descriptor && (!descriptor.configurable || descriptor.writable === false || descriptor.get || descriptor.set)) {
        if (descriptor.writable && isCtor(window.Hls)) window.Hls = patchHlsClass(window.Hls);
        return;
      }
      let value = window.Hls;
      if (isCtor(value)) value = patchHlsClass(value);
      Object.defineProperty(window,'Hls',{
        configurable:true,enumerable:descriptor?.enumerable ?? true,
        get:()=>value,set:next=>{ value=isCtor(next)?patchHlsClass(next):next; }
      });
    }
    registerAdapter({ name: 'hls', install: armSetterOnce });
    runAdapters();
  })(Object.freeze(${serializeForInlineScript(runtimeConfig)}));
  `;
  const injectedDocuments = new WeakSet();
  function injectInto(doc = document) {
    if (injectedDocuments.has(doc)) return;
    try {
      if (isBlockedForDoc(doc, bootSettings, location.hostname)) {
        if (window.top === window) {
          try { console.log('[HLS BigBuffer] 已在该站点禁用'); } catch {}
        }
        return;
      }
    } catch {}
    if (!doc.documentElement) {
      const onReady = () => {
        doc.removeEventListener('readystatechange', onReady);
        injectInto(doc);
      };
      doc.addEventListener('readystatechange', onReady);
      return;
    }
    try {
      if (typeof GM_addElement === 'function') {
        GM_addElement(doc.documentElement, 'script', { textContent: PAYLOAD });
        injectedDocuments.add(doc);
        return;
      }
    } catch {}
    const s = doc.createElement('script');
    const nonce = doc.querySelector('script[nonce]')?.nonce;
    if (nonce) s.setAttribute('nonce', nonce);
    s.textContent = PAYLOAD;
    (doc.head || doc.documentElement).appendChild(s);
    injectedDocuments.add(doc);
    s.remove();
  }
  injectInto(document);
  function tryInjectIframe(iframe) {
    try {
      const d = iframe.contentDocument;
      if (!d) return;
      const protocol = new URL(d.location?.href || d.URL || '', location.href).protocol;
      if (protocol === 'http:' || protocol === 'https:') return;
      if (isBlockedForDoc(d, bootSettings, location.hostname)) return;
      injectInto(d);
    } catch { /* 跨域 frame: 由该文档自己的 @match 实例注入 */ }
  }
  const watchedIframes = new WeakSet();
  function watchIframe(iframe) {
    if (!iframe || watchedIframes.has(iframe)) return;
    watchedIframes.add(iframe);
    iframe.addEventListener('load', () => tryInjectIframe(iframe));
    tryInjectIframe(iframe);
  }
  function watchIframesIn(node) {
    if (!node) return;
    if (node.tagName === 'IFRAME') watchIframe(node);
    for (const iframe of node.querySelectorAll?.('iframe') || []) watchIframe(iframe);
  }
  function installIframeObserver() {
    if (!document.documentElement) {
      const onReady = () => {
        if (!document.documentElement) return;
        document.removeEventListener('readystatechange', onReady);
        installIframeObserver();
      };
      document.addEventListener('readystatechange', onReady);
      return;
    }
    Array.from(document.getElementsByTagName('iframe')).forEach(watchIframe);
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) watchIframesIn(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  installIframeObserver();
})();
