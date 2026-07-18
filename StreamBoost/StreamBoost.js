// ==UserScript==
// @name         流媒体加速缓冲
// @namespace    streamboost
// @icon         https://image.suysker.xyz/i/2023/10/09/artworks-QOnSW1HR08BDMoe9-GJTeew-t500x500.webp
// @namespace    http://tampermonkey.net/
// @version      1.2.0
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
    { group: '预取并发', type: 'number', key: 'prefetchAhead', label: '预取前瞻片段数', def: 12, min: 0, max: 60, step: 1 },
    { group: '预取并发', type: 'number', key: 'maxConcurrentPrefetches', label: '页面总预取并发上限', def: 4, min: 1, max: 16, step: 1 },
    { group: '预取并发', type: 'number', key: 'maxConcurrentPrefetchesPerOrigin', label: '单资源 Origin 并发上限', def: 4, min: 1, max: 16, step: 1 },
    { group: '预取并发', type: 'number', key: 'inflightReuseWaitMs', label: '在途复用等待（ms）', def: 500, min: 0, max: 10000, step: 50 },
    { group: '缓冲与内存', type: 'number', key: 'forwardBufferSeconds', label: 'HLS 前向目标（至少，秒）', def: DEFAULT_FORWARD_BUFFER_SEC, min: 60, max: 3600, step: 30 },
    { group: '缓冲与内存', type: 'number', key: 'backBufferSeconds', label: '回看目标（至少，秒）', def: 180, min: 0, max: 1800, step: 30 },
    { group: '缓冲与内存', type: 'number', key: 'maxBufferSeconds', label: '最大缓冲目标（至少，秒）', def: 1800, min: 120, max: 7200, step: 60 },
    { group: '缓冲与内存', type: 'number', key: 'maxMemoryMb', label: 'LRU 上限 / MSE 目标（MB）', def: DEFAULT_MAX_MEM_MB, min: 16, max: 512, step: 8 },
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
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-act="close"]').addEventListener('click', close);
    modal.querySelector('[data-act="reset"]').addEventListener('click', () => {
      for (const field of CONFIG_FIELDS) setFieldControlValue(field, controls.get(field.key), field.def);
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
    const ACTIVE_MARKER = 'streamboost@1.2.0';
    try {
      const firstActivation = window.__HLS_BIGBUF_ACTIVE__ !== ACTIVE_MARKER;
      window.__HLS_BIGBUF_ACTIVE__ = ACTIVE_MARKER;
      if (firstActivation && DEBUG) console.log('[HLS BigBuffer] payload start', location.href, window === window.top ? 'top' : 'iframe');
      if (firstActivation) console.info('[HLS BigBuffer] 已激活', location.href, window === window.top ? 'top' : 'iframe');
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
    const FAIL_TTL_MS      = 45000;
    const ORIGIN_BAN_MS    = 10 * 60 * 1000;
    const originFailCount  = new Map();
    const originBanUntil   = new Map();
    const MAX_MEM_MB = RUNTIME_CONFIG.maxMemoryMb;
    const MAX_MEM_BYTES = MAX_MEM_MB * 1024 * 1024;
    const MIN_MSE_BUFFER_BYTES = 60 * 1000 * 1000;
    const MSE_BUFFER_BYTES = Math.max(MIN_MSE_BUFFER_BYTES, MAX_MEM_BYTES);
    const log  = (...a)=>{ if (DEBUG) console.log('[HLS BigBuffer]', ...a); };
    const warn = (...a)=>{ console.warn('[HLS BigBuffer]', ...a); };
    function enforceMinNumber(value, minimum) {
      const num = Number(value);
      return Number.isFinite(num) ? Math.max(num, minimum) : minimum;
    }
    function buildHlsBufferConfig(baseConfig = {}) {
      return {
        maxBufferLength: enforceMinNumber(baseConfig.maxBufferLength, FORWARD_BUFFER_SEC),
        maxMaxBufferLength: enforceMinNumber(baseConfig.maxMaxBufferLength, MAX_MAX_BUFFER_SEC),
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
    const prebuf = new Map();
    let prebufBytes = 0;
    function lruGet(url){
      const stored = prebuf.get(url);
      if (!stored) return null;
      if (isDetached(stored) || abSize(stored) === 0) { // 极少见：被外界转移/损坏
        prebuf.delete(url);
        return null;
      }
      prebuf.delete(url); prebuf.set(url, stored);
      return cloneAB(stored);
    }
    function lruSet(url, buf){
      const copy = cloneAB(buf);
      const size = abSize(copy);
      if (!size || size > MAX_MEM_BYTES) return;
      if (prebuf.has(url)) {
        prebufBytes -= (abSize(prebuf.get(url)) || 0);
        prebuf.delete(url);
      }
      prebuf.set(url, copy);
      prebufBytes += size;
      while (prebufBytes > MAX_MEM_BYTES && prebuf.size) {
        const [k, v] = prebuf.entries().next().value;
        prebuf.delete(k); prebufBytes -= (abSize(v) || 0);
      }
    }
    function lruHas(url){ return prebuf.has(url); }
    const inflightMap  = new Map(); // url -> Promise<ArrayBuffer|null>
    const inflightMeta = new Map(); // url -> { controller, level, sn, url, startedAt, origin }
    const recentFailMap= new Map();
    const floorSN      = new Map();
    const originSlots  = new Map(); // origin -> n
    function clearOriginPenalty(origin){
      if (!origin) return;
      originFailCount.delete(origin);
      originBanUntil.delete(origin);
    }
    function clearUrlPenalty(url){
      if (!url) return;
      recentFailMap.delete(url);
    }
    function takeOriginSlot(origin) {
      const cap = PREFETCH_CONC_PER_ORIGIN;
      const n = originSlots.get(origin) || 0;
      if (n >= cap) { if (DEBUG) log('slot denied', origin, n, '/', cap); return false; }
      originSlots.set(origin, n + 1);
      if (DEBUG) log('slot taken', origin, (n + 1), '/', cap, 'totalInflight=', inflightMap.size + 1);
      return true;
    }
    function releaseOriginSlot(origin) {
      const n = originSlots.get(origin) || 0;
      if (n <= 1) originSlots.delete(origin); else originSlots.set(origin, n - 1);
      if (DEBUG) log('slot released', origin, Math.max(0, n - 1));
    }
    class CacheFirstFragLoader {
      constructor(cfg){
        const Hls = window.HlsOriginal || window.Hls || window.__HlsOriginal;
        const BaseLoader = Hls?.DefaultConfig?.loader;
        this.inner = BaseLoader ? new BaseLoader(cfg) : null;
        this._resetStats();
      }
      _resetStats(){
        const now = performance.now();
        this.stats = {
          aborted:false, loaded:0, total:0, retry:0, chunkCount:0, bwEstimate:0,
          loading:{ start: now, first:0, end:0 },
          parsing:{ start:0, end:0 },
          buffering:{ start:0, first:0, end:0 },
          trequest: now, tfirst:0, tload:0
        };
      }
      _markLoaded(byteLen){
        const now = performance.now();
        const s = this.stats;
        s.loaded = byteLen|0; s.total = byteLen|0;
        if (!s.loading.first) s.loading.first = now;
        s.loading.end = now;
        if (!s.tfirst) s.tfirst = now;
        s.tload = now;
      }
      load(context, config, callbacks){
        this.context = context; this.config = config; this.callbacks = callbacks;
        this._resetStats();
        try { context.loader = this; } catch {}
        const url = context?.url;
        const isFrag = (context?.type === 'fragment') || !!context?.frag;
        const self = this;
        function goInner(){
          if (self.inner?.load) {
            if (!self.inner.stats) self.inner.stats = self.stats;
            return self.inner.load(context, config, callbacks);
          }
          if (url) {
            const ctrl = Native.AC ? new Native.AC() : new AbortController();
            const timer = setTimeout(()=>ctrl.abort(), config?.timeout || 20000);
            (Native.Fetch || fetch)(url, { mode:'cors', credentials:'omit', signal: ctrl.signal })
              .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status)))
              .then(buf => {
                const out = cloneAB(buf); // 交付副本，避免后续复用同一引用
                if (!out || abSize(out) === 0) throw new Error('buffer-clone-empty');
                self.stats.chunkCount += 1;
                self._markLoaded(abSize(out));
                if (ENABLE_MEMCACHE && isFrag) lruSet(url, buf);
                callbacks.onSuccess({ url, data: out }, self.stats, context, null);
              })
              .catch(err => callbacks.onError?.({ code: 0, text: String(err) }, context, null))
              .finally(()=> clearTimeout(timer));
          }
        }
        if (isFrag && url) {
          const hit = lruGet(url);
          if (hit && abSize(hit) > 0) {
            this.stats.chunkCount += 1;
            this._markLoaded(abSize(hit));
            if (typeof callbacks.onProgress === 'function') callbacks.onProgress(this.stats, context, hit, null);
            callbacks.onSuccess({ url, data: hit }, this.stats, context, null);
            if (DEBUG) log('fLoader cache hit', url, abSize(hit), 'bytes');
            return;
          }
        }
        const p = (isFrag && url) ? inflightMap.get(url) : null;
        if (p) {
          let done = false;
          const timer = setTimeout(() => { if (!done) goInner(); }, WAIT_INFLIGHT_MS);
          p.then(buf => {
            if (done) return;
            clearTimeout(timer);
            if (buf) {
              const out = cloneAB(buf);
              if (!out || abSize(out) === 0) { goInner(); return; }
              this.stats.chunkCount += 1;
              this._markLoaded(abSize(out));
              if (ENABLE_MEMCACHE && isFrag) lruSet(url, buf);
              callbacks.onSuccess({ url, data: out }, this.stats, context, null);
              done = true;
              if (DEBUG) log('fLoader merged in-flight prefetch', url, abSize(out), 'bytes');
            } else {
              goInner();
            }
          }).catch(() => { if (!done) { clearTimeout(timer); goInner(); }});
          return;
        }
        goInner();
      }
      abort(ctx){ if (this.stats) this.stats.aborted = true; try { this.inner?.abort?.(ctx); } catch {} }
      destroy(){ try { this.inner?.destroy?.(); } catch {} }
    }
    function absUrlForFrag(details, frag){
      let u = frag && (frag.url || frag.relurl);
      if (!u) return '';
      if (frag.url) return frag.url;
      const base = (details && (details.baseurl || details.baseURI || details.baseuri)) || '';
      try { return new URL(frag.relurl, base).href; } catch { return frag.relurl || ''; }
    }
    function abortStaleInflight(level, floor){
      let aborted = 0;
      inflightMeta.forEach((meta, url) => {
        if (meta.level === level && typeof meta.sn === 'number' && meta.sn < floor) {
          try { meta.controller && meta.controller.abort(); } catch {}
          inflightMeta.delete(url);
          inflightMap.delete(url);
          aborted++;
        }
      });
      if (aborted && DEBUG) log('abort stale inflight', 'level=', level, 'floor=', floor, 'aborted=', aborted);
    }
    function prefetchWithXHR(hls, details, nf, url, origin){
      if (originBanUntil.get(origin) > performance.now()) { if (DEBUG) log('origin banned, skip XHR', origin); return null; }
      if (!takeOriginSlot(origin)) return null;
      const xhr = new Native.XHR();
      let cleaned = false;
      let timer = null;
      const timeoutMs = (hls?.config?.fragLoadTimeout) || PREFETCH_TIMEOUT_MS;
      const controller = { abort(){ try{ xhr.abort(); }catch{} } };
      inflightMeta.set(url, { controller, level: nf.level, sn: nf.sn, url, startedAt: performance.now(), origin });
      const p = new Promise((resolve) => {
        try {
          xhr.open('GET', url, true);
          xhr.responseType = 'arraybuffer';
          try { hls?.config?.xhrSetup && hls.config.xhrSetup(xhr, url); } catch {}
          xhr.timeout = timeoutMs;
          xhr.onload = function(){
            releaseOriginSlot(origin);
            cleanup();
            const ok = (xhr.status >= 200 && xhr.status < 300);
            if (!ok || !(xhr.response instanceof ArrayBuffer)) {
              bumpFail(origin);
              resolve(null);
              return;
            }
            originFailCount.set(origin, 0);
            const buf = xhr.response;
            if (ENABLE_MEMCACHE) lruSet(url, buf);
            if (DEBUG) log('prefetch XHR ok', url, abSize(buf), 'bytes');
            resolve(buf); // 注意：消费者侧会 clone
          };
          xhr.onerror = function(){
            releaseOriginSlot(origin);
            cleanup(); bumpFail(origin); resolve(null);
          };
          xhr.ontimeout = function(){
            releaseOriginSlot(origin);
            cleanup(); bumpFail(origin); resolve(null);
          };
          xhr.onabort = function(){
            releaseOriginSlot(origin);
            cleanup(); resolve(null);
          };
          xhr.send();
          timer = setTimeout(()=>{ try{ xhr.abort(); }catch{} }, timeoutMs + 500);
        } catch {
          releaseOriginSlot(origin);
          cleanup(); resolve(null);
        }
        function cleanup(){
          if (cleaned) return;
          cleaned = true;
          try{ xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null; }catch{}
          if (timer) { clearTimeout(timer); timer = null; }
        }
        function bumpFail(origin){
          const fc = (originFailCount.get(origin) || 0) + 1;
          originFailCount.set(origin, fc);
          if (fc >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
        }
      }).finally(()=>{ inflightMeta.delete(url); inflightMap.delete(url); });
      inflightMap.set(url, p);
      return p;
    }
    function prefetchWithHlsLoader(hls, details, nf, url, origin) {
      const Hls = window.HlsOriginal || window.Hls || window.__HlsOriginal;
      const BaseLoader = Hls?.DefaultConfig?.loader;
      if (!BaseLoader) return null;
      if (originBanUntil.get(origin) > performance.now()) { if (DEBUG) log('origin banned, skip HlsLoader', origin); return null; }
      if (!takeOriginSlot(origin)) return null;
      const loader = new BaseLoader(hls?.config || {});
      const controller = { abort(){ try { loader.abort?.(); } catch {} } };
      const ctx = { url, responseType:'arraybuffer', type:'fragment', frag:nf };
      const timeoutMs = hls?.config?.fragLoadTimeout || PREFETCH_TIMEOUT_MS;
      let timer = null;
      const p = new Promise((resolve) => {
        try {
          loader.load(ctx, hls?.config || {}, {
            onSuccess: (resp, stats, context) => {
              releaseOriginSlot(origin);
              clearTimeout(timer);
              originFailCount.set(origin, 0);
              const buf = resp && resp.data instanceof ArrayBuffer ? resp.data : null;
              if (buf && ENABLE_MEMCACHE) lruSet(url, buf);
              resolve(buf); // 消费侧 clone
            },
            onError: () => {
              releaseOriginSlot(origin);
              clearTimeout(timer);
              const fc = (originFailCount.get(origin) || 0) + 1;
              originFailCount.set(origin, fc);
              if (fc >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
              resolve(null);
            },
            onTimeout: () => {
              releaseOriginSlot(origin);
              clearTimeout(timer);
              const fc = (originFailCount.get(origin) || 0) + 1;
              originFailCount.set(origin, fc);
              if (fc >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
              resolve(null);
            },
            onProgress: ()=>{}
          });
          timer = setTimeout(()=>{ try{ loader.abort?.(); }catch{} }, timeoutMs);
        } catch {
          releaseOriginSlot(origin);
          clearTimeout(timer);
          resolve(null);
        }
      }).finally(()=>{ try{ loader.destroy?.(); }catch{}; inflightMeta.delete(url); inflightMap.delete(url); });
      inflightMeta.set(url, { controller, level: nf.level, sn: nf.sn, url, startedAt: performance.now(), origin });
      inflightMap.set(url, p);
      return p;
    }
    function prefetchWithFetch(details, nf, url, origin){
      if (originBanUntil.get(origin) > performance.now()) { if (DEBUG) log('origin banned, skip fetch', origin); return null; }
      if (!takeOriginSlot(origin)) return null;
      const controller = Native.AC ? new Native.AC() : new AbortController();
      const opts = { mode:'cors', credentials:'omit', signal: controller.signal };
      const timeout = setTimeout(()=> controller.abort(), PREFETCH_TIMEOUT_MS);
      const p = (Native.Fetch || fetch)(url, opts)
        .then(r => r.ok ? r.arrayBuffer() : null)
        .then(buf => {
          releaseOriginSlot(origin);
          if (buf) {
            originFailCount.set(origin, 0);
            if (ENABLE_MEMCACHE) lruSet(url, buf);
            if (DEBUG) log('prefetch fetch ok', url, abSize(buf), 'bytes');
          } else {
            const fc = (originFailCount.get(origin) || 0) + 1;
            originFailCount.set(origin, fc);
            if (fc >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
          }
          return buf; // 消费侧 clone
        })
        .catch(() => {
          releaseOriginSlot(origin);
          const fc = (originFailCount.get(origin) || 0) + 1;
          originFailCount.set(origin, fc);
          if (fc >= 2) originBanUntil.set(origin, performance.now() + ORIGIN_BAN_MS);
          return null;
        })
        .finally(() => { clearTimeout(timeout); inflightMeta.delete(url); inflightMap.delete(url); });
      inflightMap.set(url, p);
      inflightMeta.set(url, { controller, level: nf.level, sn: nf.sn, url, startedAt: performance.now(), origin });
      return p;
    }
    (function setupPrefetcher(){
      if (!ENABLE_PREFETCH) return;
      function prefetchFrag(hls, details, nf){
        const url = absUrlForFrag(details, nf);
        if (!url) return null;
        const origin = (()=>{ try { return new URL(url).origin; } catch { return ''; } })();
        if (lruHas(url)) { if (DEBUG) log('prefetch skip: LRU has', url); return inflightMap.get(url) || null; }
        if (inflightMap.has(url)) return inflightMap.get(url);
        const lastFail = recentFailMap.get(url);
        if (lastFail && (performance.now() - lastFail < FAIL_TTL_MS)) {
          if (DEBUG) log('prefetch skip: recent fail', url);
          return null;
        }
        if (inflightMap.size >= PREFETCH_CONC_GLOBAL) return null;
        const chain =
          PREFETCH_STRATEGY === 'hls-xhr-fetch' ? [
            () => prefetchWithHlsLoader(hls, details, nf, url, origin),
            () => prefetchWithXHR(hls, details, nf, url, origin),
            () => prefetchWithFetch(details, nf, url, origin)
          ] :
          PREFETCH_STRATEGY === 'hls-only' ? [
            () => prefetchWithHlsLoader(hls, details, nf, url, origin)
          ] :
          PREFETCH_STRATEGY === 'xhr-only' ? [
            () => prefetchWithXHR(hls, details, nf, url, origin)
          ] :
          PREFETCH_STRATEGY === 'fetch-only' ? [
            () => prefetchWithFetch(details, nf, url, origin)
          ] :
          PREFETCH_STRATEGY === 'fetch-xhr-hls' ? [
            () => prefetchWithFetch(details, nf, url, origin),
            () => prefetchWithXHR(hls, details, nf, url, origin),
            () => prefetchWithHlsLoader(hls, details, nf, url, origin)
          ] : [
            () => prefetchWithXHR(hls, details, nf, url, origin),
            () => prefetchWithHlsLoader(hls, details, nf, url, origin),
            () => prefetchWithFetch(details, nf, url, origin)
          ];
        let p = null;
        for (const fn of chain) {
          p = fn();
          if (p) break;
        }
        p?.then(buf => { if (!buf) recentFailMap.set(url, performance.now()); })
          .finally(()=>{ inflightMeta.delete(url); inflightMap.delete(url); });
        return p;
      }
      function attach(hls){
        const Ev = hls.constructor?.Events || {};
        function scheduleAheadFromFrag(frag){
          try {
            if (!frag) return;
            const t = frag.type || 'video';
            if (t !== 'main' && t !== 'video') return;
            const level = frag.level;
            const S = frag.sn;
            floorSN.set(level, S);
            abortStaleInflight(level, S);
            const details = hls.levels && hls.levels[level] && hls.levels[level].details;
            if (!details || !Array.isArray(details.fragments)) return;
            let idx = details.fragments.findIndex(f => f.sn === S);
            if (idx < 0) {
              idx = 0;
              for (let i = 0; i < details.fragments.length; i++) {
                if ((details.fragments[i].sn|0) >= (S|0)) { idx = i; break; }
              }
            }
            for (let k = 1; k <= PREFETCH_AHEAD; k++) {
              const nf = details.fragments[idx + k];
              if (!nf) break;
              const floor = floorSN.get(nf.level ?? level) ?? S;
              if (typeof nf.sn === 'number' && nf.sn < floor) continue;
              prefetchFrag(hls, details, nf);
            }
          } catch (e) { if (DEBUG) log('scheduleAheadFromFrag error', e); }
        }
        hls.on(Ev.FRAG_LOADING, (_evt, data) => { scheduleAheadFromFrag(data && data.frag); });
        hls.on(Ev.FRAG_LOADED,  (_evt, data) => {
          const frag = data && data.frag;
          scheduleAheadFromFrag(frag);
          try {
            const url = frag && (frag.url || frag._url);
            if (url) {
              clearUrlPenalty(url);
              const origin = new URL(url, location.href).origin;
              clearOriginPenalty(origin);
            }
          } catch {}
        });
        log('prefetcher attached (XHR→HlsLoader→fetch; ahead=', PREFETCH_AHEAD, ', global=', PREFETCH_CONC_GLOBAL, ', perOrigin=', PREFETCH_CONC_PER_ORIGIN, ', wait=', WAIT_INFLIGHT_MS, 'ms)');
      }
      window.__HLS_BIGBUF_ATTACH_PREFETCH__ = attach;
    })();
    function isCtor(v){ return typeof v === 'function'; }
    function protectGlobal(name, value){
      try { delete window[name]; } catch {}
      Object.defineProperty(window, name, { value, writable:false, configurable:true, enumerable:false });
    }
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
        window.HlsOriginal = window.__HlsOriginal = OriginalHls;
        try {
          if (OriginalHls.DefaultConfig) Object.assign(OriginalHls.DefaultConfig, buildHlsBufferConfig(OriginalHls.DefaultConfig));
          log('DefaultConfig applied', OriginalHls.DefaultConfig);
        } catch(e){ log('DefaultConfig assign failed (frozen?)', e); }
        class PatchedHls extends OriginalHls {
          constructor(userConfig = {}){
            if (!userConfig || typeof userConfig !== 'object') userConfig = {};
            const enforced = Object.assign({}, userConfig, buildHlsBufferConfig(userConfig));
            if (ENABLE_MEMCACHE) {
              const UserLoader = userConfig.fLoader || userConfig.loader;
              if (UserLoader) {
                class CustomFragLoader extends CacheFirstFragLoader {
                  constructor(cfg) {
                    super(cfg);
                    try { this.inner = new UserLoader(cfg); } catch(e) { log('CustomFragLoader init failed', e); }
                  }
                }
                enforced.fLoader = CustomFragLoader;
                log('Wrapped custom loader for compatibility', UserLoader);
              } else {
                enforced.fLoader = CacheFirstFragLoader;
              }
            }
            super(enforced);
            window.__HLS_BIGBUF_LAST__ = this;
            try {
              this.on(OriginalHls.Events.LEVEL_LOADED, (_evt, data) => {
                const isLive = !!data?.details?.live;
                if (!isLive) {
                  const c = this.config;
                  Object.assign(c, buildHlsBufferConfig(c));
                  log('LEVEL_LOADED → ensured on-demand HLS buffer targets', {
                    maxBufferLength: c.maxBufferLength,
                    maxMaxBufferLength: c.maxMaxBufferLength,
                    maxBufferSize: c.maxBufferSize,
                    backBufferLength: c.backBufferLength,
                    startFragPrefetch: c.startFragPrefetch
                  });
                } else {
                  log('LEVEL_LOADED (live) → HLS buffer targets remain active; live-sync settings unchanged');
                }
              });
            } catch {}
            try {
              if (ENABLE_PREFETCH && typeof window.__HLS_BIGBUF_ATTACH_PREFETCH__ === 'function') {
                window.__HLS_BIGBUF_ATTACH_PREFETCH__(this);
              }
            } catch {}
            log('Hls instance created with config', this.config, 'prefetch=', ENABLE_PREFETCH, 'memcache=', ENABLE_MEMCACHE);
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
        return PatchedHls;
      }catch(e){
        warn('patchHlsClass failed', e);
        return OriginalHls;
      }
    }
    function armSetterOnce(){
      if ('Hls' in window && isCtor(window.Hls)) {
        const Patched = patchHlsClass(window.Hls);
        protectGlobal('Hls', Patched);
        log('Patched existing window.Hls immediately');
        return;
      }
      let armed = true;
      Object.defineProperty(window, 'Hls', {
        configurable: true,
        enumerable: false,
        get(){ return undefined; },
        set(v){
          if(!armed) return;
          armed = false;
          if (!isCtor(v)) { log('window.Hls set but not a constructor, skip patch'); protectGlobal('Hls', v); return; }
          const Patched = patchHlsClass(v);
          protectGlobal('Hls', Patched);
          log('Intercepted and replaced window.Hls');
        }
      });
      if (window === window.top) log('Setter hook armed (page/iframe context, waiting for window.Hls)');
      if (window === window.top) setTimeout(()=>{
        if(!window.Hls || (window.Hls && !window.Hls.__HLS_BIGBUF_PATCHED__)){
          const hints = {
            hasVideoJS: !!window.videojs,
            hasDashJS: !!(window.dashjs || window.MediaPlayer),
            nativeHLS: (function(){
              try{
                const v=document.createElement('video');
                const t1=v.canPlayType('application/vnd.apple.mpegurl');
                const t2=v.canPlayType('application/x-mpegURL');
                return (t1==='probably'||t1==='maybe'||t2==='probably'||t2==='maybe');
              }catch{ return false; }
            })()
          };
          console.warn('[HLS BigBuffer] 顶层未检测到 Hls（播放器在跨域 iframe 内时属于正常情况；若已看到 iframe 的“已激活”提示可忽略）。诊断：', hints);
        }
      }, 8000);
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
