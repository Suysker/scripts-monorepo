// ==UserScript==
// @name         黄金左右键
// @description  按住"→"键倍速播放，按住"←"键减速播放，松开恢复原来的倍速，轻松追剧，看视频更灵活，还能快进/跳过大部分网站的广告！~ 支持用户单独配置倍速和秒数，并可根据根域名启用或禁用脚本
// @icon         https://image.suysker.xyz/i/2023/10/09/artworks-QOnSW1HR08BDMoe9-GJTeew-t500x500.webp
// @namespace    http://tampermonkey.net/
// @version      1.2.1
// @author       Suysker
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @homepage     https://github.com/Suysker/scripts-monorepo/tree/main/Golden-Left-Right
// @supportURL   https://github.com/Suysker/scripts-monorepo/issues
// ==/UserScript==

(function () {
    'use strict';

    // -------------------- Configuration Constants --------------------
    const DEFAULT_RATE = 2;                // 默认倍速
    const DEFAULT_TIME = 5;                // 默认秒数
    const DEFAULT_RL_TIME = 180;           // 左右同时按下秒数
    const DOMAIN_BLOCK_LIST_KEY = "blockedDomains"; // 存储禁用的根域名列表的键名
    const GLOBAL_ENABLE_KEY = 'globalEnabled';
    const SETTING_PLAYBACK_RATE_KEY = 'playbackRate';
    const SETTING_CHANGE_TIME_KEY = 'changeTime';
    const SETTING_BOTH_KEYS_TIME_KEY = 'bothKeysJumpTime';
    const GLR_CFG_MODAL_ID = 'glr-config-modal';
    const GLR_CFG_STYLE_ID = 'glr-config-style';
    const VIDEO_REGISTRY_REFRESH_DELAY_MS = 100;

    // -------------------- State Variables --------------------
    let keyboardEventsRegistered = false;  // 确保键盘事件只注册一次
    const debug = false;                   // 控制日志的输出，正式环境关闭

    const state = {
        playbackRate: DEFAULT_RATE,        // 播放倍速
        changeTime: DEFAULT_TIME,          // 快进/回退秒数
        bothKeysJumpTime: DEFAULT_RL_TIME, // 左右同时按下快进秒数
        pageVideo: null,
        lastPlayedVideo: null,             // 记录上一个播放过的视频（通过 play 事件更新）
        originalPlaybackRate: 1,           // 存储原来的播放速度
        rightKeyDownCount: 0,              // 追踪右键按下次数
        leftKeyDownCount: 0                // 追踪左键按下次数
    };

    const videoRegistry = {
        candidates: [],
        initializedVideos: new WeakSet(),
        lastPlayedVideo: null,
        dirty: true,
        refreshScheduled: false,
        observedRootCount: 0,
        scanCount: 0
    };

    const videoRootObserver = {
        observer: null,
        running: false
    };

    // -------------------- Utility Functions --------------------

    /**
     * Logs messages to the console if debugging is enabled.
     * @param  {...any} args - The messages or objects to log.
     */
    const log = (...args) => {
        if (debug) {
            console.log('[黄金左右键]', ...args);
        }
    };

    /**
     * Loads a setting from GM storage with a default value.
     * @param {string} key - The key of the setting.
     * @param {*} defaultValue - The default value if the setting is not found.
     * @returns {Promise<*>} - The loaded value.
     */
    const loadSetting = async (key, defaultValue) => {
        const value = await GM_getValue(key, defaultValue);
        return value !== undefined ? value : defaultValue;
    };

    /**
     * Saves a setting to GM storage.
     * @param {string} key - The key of the setting.
     * @param {*} value - The value to save.
     */
    const saveSetting = async (key, value) => {
        await GM_setValue(key, value);
    };

    const readBoolSetting = async (key, defaultValue) => {
        const raw = await loadSetting(key, defaultValue);
        return raw === true || raw === 1 || raw === '1';
    };

    const CONFIG_FIELDS = Object.freeze([
        { group: '倍速控制', key: SETTING_PLAYBACK_RATE_KEY, stateKey: 'playbackRate', label: '按住右键的加速倍速', def: DEFAULT_RATE, min: 1, max: 16, step: 0.1 },
        { group: '单键跳转', key: SETTING_CHANGE_TIME_KEY, stateKey: 'changeTime', label: '松开左右键跳转秒数', def: DEFAULT_TIME, min: 0.5, max: 120, step: 0.5 },
        { group: '组合键动作', key: SETTING_BOTH_KEYS_TIME_KEY, stateKey: 'bothKeysJumpTime', label: '左右同时按下快进秒数', def: DEFAULT_RL_TIME, min: 10, max: 1800, step: 5 }
    ]);

    const getStepDigits = (step) => {
        const text = String(step || 1);
        const index = text.indexOf('.');
        return index >= 0 ? (text.length - index - 1) : 0;
    };

    const clampNumber = (value, min, max) => {
        return Math.min(max, Math.max(min, value));
    };

    const normalizeFieldNumber = (value, field) => {
        const step = Number(field.step) || 1;
        const digits = getStepDigits(step);
        const base = Number.isFinite(Number(value)) ? Number(value) : field.def;
        const clamped = clampNumber(base, field.min, field.max);
        const snapped = Math.round(clamped / step) * step;
        const fixed = Number(snapped.toFixed(digits));
        return clampNumber(fixed, field.min, field.max);
    };

    const formatFieldNumber = (value, field) => {
        const digits = getStepDigits(field.step);
        if (digits === 0) return String(Math.round(value));
        return Number(value).toFixed(digits).replace(/\.?0+$/, '');
    };

    const readConfigFieldValue = async (field) => {
        const raw = await loadSetting(field.key, field.def);
        const normalized = normalizeFieldNumber(raw, field);
        state[field.stateKey] = normalized;
        return normalized;
    };

    const setDefaultControlValue = (field, control) => {
        const normalized = normalizeFieldNumber(field.def, field);
        const formatted = formatFieldNumber(normalized, field);
        control.range.value = formatted;
        control.num.value = formatted;
    };

    const saveConfigFieldValue = async (field, control) => {
        const raw = String(control.num.value || '').trim();
        if (!raw) throw new Error(`${field.label} 不能为空`);
        const num = Number(raw);
        if (!Number.isFinite(num)) throw new Error(`${field.label} 必须是数字`);
        const normalized = normalizeFieldNumber(num, field);
        const formatted = formatFieldNumber(normalized, field);
        control.range.value = formatted;
        control.num.value = formatted;
        await saveSetting(field.key, normalized);
        state[field.stateKey] = normalized;
    };

    const ensureConfigStyle = () => {
        if (document.getElementById(GLR_CFG_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = GLR_CFG_STYLE_ID;
        style.textContent = `#${GLR_CFG_MODAL_ID}{position:fixed;inset:0;z-index:2147483647;background:radial-gradient(1200px 520px at 8% -6%,rgba(255,212,229,.38),transparent 66%),radial-gradient(980px 520px at 100% 100%,rgba(233,232,236,.44),transparent 67%),rgba(245,240,243,.74);display:flex;align-items:center;justify-content:center;font:12px/1.3 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#4a4350}#${GLR_CFG_MODAL_ID} .panel{width:min(1080px,96vw);max-height:min(92vh,760px);display:grid;grid-template-rows:auto auto;gap:10px;padding:14px;border-radius:20px;border:1px solid #f0d6e2;background:linear-gradient(145deg,rgba(255,255,255,.96),rgba(244,238,242,.95));box-shadow:0 16px 40px rgba(104,88,99,.22),inset 0 1px 0 rgba(255,255,255,.9)}#${GLR_CFG_MODAL_ID} h2{margin:0;font-size:22px;color:#544a56}#${GLR_CFG_MODAL_ID} .head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}#${GLR_CFG_MODAL_ID} .hint{margin:4px 0 0;color:#7b6f7c}#${GLR_CFG_MODAL_ID} .sections{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:8px}#${GLR_CFG_MODAL_ID} .group{background:linear-gradient(150deg,rgba(255,255,255,.98),rgba(247,242,245,.96));border:1px solid #ecdde6;border-radius:12px;padding:8px}#${GLR_CFG_MODAL_ID} .group h3{margin:0 0 6px;font-size:13px;color:#5f5462}#${GLR_CFG_MODAL_ID} .group-grid{display:grid;grid-template-columns:1fr;gap:6px}#${GLR_CFG_MODAL_ID} .field{background:#fff;border:1px solid #efe4eb;border-radius:10px;padding:7px;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}#${GLR_CFG_MODAL_ID} .title{font-size:11px;color:#5f5463;margin-bottom:5px}#${GLR_CFG_MODAL_ID} .num{display:grid;grid-template-columns:1fr 92px;gap:6px;align-items:center}#${GLR_CFG_MODAL_ID} input[type=number]{width:100%;box-sizing:border-box;border:1px solid #dcced7;border-radius:7px;padding:5px 6px;font-size:12px;color:#4a4150;background:#fefcfd;text-align:center}#${GLR_CFG_MODAL_ID} input[type=range]{width:100%;accent-color:#d88cae}#${GLR_CFG_MODAL_ID} .actions{display:flex;justify-content:flex-end;gap:8px}#${GLR_CFG_MODAL_ID} .head .actions{margin-left:auto}#${GLR_CFG_MODAL_ID} button{border:1px solid #dccad5;border-radius:9px;padding:7px 12px;cursor:pointer;font-weight:700;color:#5d4f60;background:#faf6f8}#${GLR_CFG_MODAL_ID} button.primary{background:linear-gradient(135deg,#f7d2e3,#f2bad4);border-color:#de9dbe;color:#4f3c49}`;
        (document.head || document.documentElement).appendChild(style);
    };

    const openConfigPanel = async () => {
        if (!document.body) {
            alert('页面尚未加载完成，请稍后重试。');
            return;
        }
        ensureConfigStyle();
        document.getElementById(GLR_CFG_MODAL_ID)?.remove();

        const modal = document.createElement('div');
        modal.id = GLR_CFG_MODAL_ID;
        modal.innerHTML = '<div class="panel"><div class="head"><div><h2>⚙️ 黄金左右键 参数配置</h2><p class="hint">调整倍速与跳转参数，保存后立即生效，无需刷新。</p></div><div class="actions"><button data-act="close">关闭</button><button data-act="reset">恢复默认</button><button class="primary" data-act="save">保存配置</button></div></div><div class="sections" data-zone="sections"></div></div>';

        const sectionsZone = modal.querySelector('[data-zone="sections"]');
        const groups = new Map();
        const controls = new Map();

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
            row.innerHTML = `<div class="title">${field.label}</div><div class="num"><input type="range" min="${field.min}" max="${field.max}" step="${field.step}"><input type="number" min="${field.min}" max="${field.max}" step="${field.step}"></div>`;
            const range = row.querySelector('input[type="range"]');
            const num = row.querySelector('input[type="number"]');
            const value = await readConfigFieldValue(field);
            const formatted = formatFieldNumber(value, field);
            range.value = formatted;
            num.value = formatted;
            range.addEventListener('input', () => { num.value = range.value; });
            num.addEventListener('input', () => {
                const v = Number(num.value);
                if (Number.isFinite(v)) range.value = formatFieldNumber(normalizeFieldNumber(v, field), field);
            });

            groupGrid.appendChild(row);
            controls.set(field.key, { range, num });
        }

        const close = () => modal.remove();
        modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
        modal.querySelector('[data-act="close"]').addEventListener('click', close);
        modal.querySelector('[data-act="reset"]').addEventListener('click', () => {
            for (const field of CONFIG_FIELDS) {
                setDefaultControlValue(field, controls.get(field.key));
            }
        });
        modal.querySelector('[data-act="save"]').addEventListener('click', async () => {
            try {
                for (const field of CONFIG_FIELDS) {
                    await saveConfigFieldValue(field, controls.get(field.key));
                }
                alert('配置已保存，已立即生效。');
                close();
            } catch (error) {
                alert(`保存失败：${error?.message || error}`);
            }
        });
        document.body.appendChild(modal);
    };

    /**
     * Retrieves the root domain of the current website.
     * @returns {string} - The root domain (e.g., example.com).
     */
    const getLegacyRootDomain = () => {
        const hostname = location.hostname;
        const domainParts = hostname.split('.');

        // Handle special cases like localhost or IP addresses
        if (domainParts.length <= 1) {
            return hostname;
        }

        // If the last part is a country code top-level domain (ccTLD), consider three parts
        const ccTLDs = ['uk', 'jp', 'cn', 'au', 'nz', 'br', 'fr', 'de', 'kr', 'in', 'ru'];
        const lastPart = domainParts[domainParts.length - 1];

        if (ccTLDs.includes(lastPart) && domainParts.length >= 3) {
            return domainParts.slice(-3).join('.');
        } else {
            return domainParts.slice(-2).join('.');
        }
    };

    /**
     * Checks if the current domain is blocked.
     * @returns {Promise<boolean>} - True if blocked, else false.
     */
    // Explicit offline site grouping; unknown multi-label suffixes remain exact-host.
    const getRootDomain = () => {
        const host = location.hostname.toLowerCase().replace(/\.+$/, '');
        if (host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.')) return host;
        const parts = host.split('.');
        const suffix = parts.slice(-2).join('.');
        const grouped = new Set(['co.uk','org.uk','ac.uk','com.cn','net.cn','org.cn','gov.cn','com.au','net.au','org.au','co.jp','ne.jp','co.nz','co.kr','co.in','com.br']);
        if (grouped.has(suffix)) return parts.slice(-3).join('.');
        const single = new Set(['com','net','org','tv','io','app','dev','xyz','cn','de','fr','ru','info','me','online']);
        return single.has(parts.at(-1)) ? suffix : host;
    };
    const readBlockedDomains = async () => {
        const stored = await loadSetting(DOMAIN_BLOCK_LIST_KEY, []);
        return Array.isArray(stored) ? stored.filter(x => typeof x === 'string') : [];
    };

    const isDomainBlocked = async () => {
        const blockedDomains = await readBlockedDomains();
        const currentDomain = getRootDomain();
        return blockedDomains.includes(currentDomain) || blockedDomains.includes(getLegacyRootDomain());
    };

    const isGlobalEnabled = () => readBoolSetting(GLOBAL_ENABLE_KEY, true);

    /**
     * Toggles the current domain's blocked status.
     */
    const toggleCurrentDomain = async () => {
        const blockedDomains = await readBlockedDomains();
        const currentDomain = getRootDomain();
        const index = blockedDomains.findIndex(rule => rule === currentDomain || rule === getLegacyRootDomain());
        let isNowBlocked = false;

        if (index === -1) {
            blockedDomains.push(currentDomain);
            await saveSetting(DOMAIN_BLOCK_LIST_KEY, blockedDomains);
            alert(`已禁用黄金左右键脚本在此网站 (${currentDomain})`);
            isNowBlocked = true;
        } else {
            for (let i = blockedDomains.length - 1; i >= 0; i--) {
                if ([currentDomain, getLegacyRootDomain()].includes(blockedDomains[i])) blockedDomains.splice(i, 1);
            }
            await saveSetting(DOMAIN_BLOCK_LIST_KEY, blockedDomains);
            alert(`已启用黄金左右键脚本在此网站 (${currentDomain})`);
            isNowBlocked = false;
        }

        const globalEnabled = await isGlobalEnabled();
        handleKeyboardEvents(globalEnabled && !isNowBlocked); // 根据全局+站点状态立即启用/禁用键盘事件
    };

    const toggleGlobalStatus = async () => {
        const current = await isGlobalEnabled();
        const next = !current;
        await saveSetting(GLOBAL_ENABLE_KEY, next);
        const domainBlocked = await isDomainBlocked();
        handleKeyboardEvents(next && !domainBlocked);
        alert(`已${next ? '启用' : '停用'}全局状态`);
    };

    /**
     * Checks if any input-related element (except safe ones) is currently focused.
     * @returns {boolean} - True if an input is focused, else false.
     */
    const isInputFocused = (event) => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return [active, ...(event?.composedPath?.() || [])].some(el => {
            if (!el?.tagName) return false;
            if (el.closest?.('#' + GLR_CFG_MODAL_ID) || el.isContentEditable) return true;
            const tag = el.tagName.toLowerCase();
            return tag === 'textarea' || tag === 'select' ||
                (tag === 'input' && !['range','button','submit','reset','image'].includes(el.type));
        });
    };

    /**
     * Determines if a video element is visible within the viewport.
     * @param {HTMLVideoElement} video - The video element to check.
     * @returns {boolean} - True if visible, else false.
     */
    let geometrySnapshot = null;
    const isVideoVisible = (video) => {
        if (!video || !video.isConnected) return false;

        const cached = geometrySnapshot?.get(video);
        const style = cached?.style || window.getComputedStyle(video);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        const rect = cached?.rect || video.getBoundingClientRect();
        geometrySnapshot?.set(video, {style, rect});
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < viewportHeight &&
            rect.left < viewportWidth
        );
    };

    /**
     * Determines if a video is currently playing.
     * @param {HTMLVideoElement} video - The video element to check.
     * @returns {boolean} - True if playing, else false.
     */
    const isVideoPlaying = (video) => {
        return video && !video.paused && video.currentTime > 0;
    };

    const isSearchableVideoRoot = (node) => {
        return node && (
            node.nodeType === Node.DOCUMENT_NODE ||
            node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
            node.nodeType === Node.ELEMENT_NODE
        );
    };

    const isVideoElement = (node) => {
        return node && node.nodeType === Node.ELEMENT_NODE && (node.tagName || '').toLowerCase() === 'video';
    };

    const getRootDocument = (root) => {
        if (root && root.nodeType === Node.DOCUMENT_NODE) return root;
        return root?.ownerDocument || document;
    };

    const visitLightDomElements = (root, visitor) => {
        if (!isSearchableVideoRoot(root)) return;

        if (root.nodeType === Node.ELEMENT_NODE) {
            visitor(root);
        }

        const walker = getRootDocument(root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let element = walker.nextNode();
        while (element) {
            visitor(element);
            element = walker.nextNode();
        }
    };

    const visitElementsDeep = (root, visitor) => {
        const roots = [root];
        const visitedRoots = new WeakSet();

        while (roots.length > 0) {
            const currentRoot = roots.pop();
            if (!isSearchableVideoRoot(currentRoot) || visitedRoots.has(currentRoot)) continue;
            visitedRoots.add(currentRoot);

            visitLightDomElements(currentRoot, (element) => {
                visitor(element, currentRoot);
                if (element.shadowRoot) {
                    roots.push(element.shadowRoot);
                }
            });
        }
    };

    const addVideoCandidate = (videos, seenVideos, video) => {
        if (!isVideoElement(video) || seenVideos.has(video)) return;
        seenVideos.add(video);
        videos.push(video);
    };

    /**
     * Finds video elements in normal DOM and open Shadow DOM roots.
     * @param {Node} root - The root node to search within.
     * @returns {HTMLVideoElement[]} - Array of found video elements.
     */
    const collectVideosDeep = (root = document) => {
        const videos = [];
        const seenVideos = new WeakSet();

        visitElementsDeep(root, (element) => {
            addVideoCandidate(videos, seenVideos, element);
        });

        return videos;
    };

    const collectOpenShadowRootsDeep = (root = document) => {
        const shadowRoots = [];
        const seenRoots = new WeakSet();

        visitElementsDeep(root, (element) => {
            if (!element.shadowRoot || seenRoots.has(element.shadowRoot)) return;
            seenRoots.add(element.shadowRoot);
            shadowRoots.push(element.shadowRoot);
        });

        return shadowRoots;
    };

    const markVideoRegistryDirty = (reason) => {
        videoRegistry.dirty = true;
        log('视频注册表已标记为 dirty:', reason);
    };

    const getVideoArea = (video) => {
        const rect = geometrySnapshot?.get(video)?.rect || video.getBoundingClientRect();
        return rect.width * rect.height;
    };

    const getLargestVisibleVideo = (videos) => {
        let bestVideo = null;
        let bestArea = 0;

        videos.forEach(video => {
            if (!isVideoVisible(video)) return;
            const area = getVideoArea(video);
            if (area > bestArea) {
                bestArea = area;
                bestVideo = video;
            }
        });

        return bestVideo;
    };

    const pruneDisconnectedVideos = () => {
        videoRegistry.candidates = videoRegistry.candidates.filter(video => video.isConnected);
        for (const [video, handler] of ownedPlayListeners) if (!video.isConnected) {
            video.removeEventListener('play', handler);
            ownedPlayListeners.delete(video);
            videoRegistry.initializedVideos.delete(video);
        }

        if (videoRegistry.lastPlayedVideo && !videoRegistry.lastPlayedVideo.isConnected) {
            videoRegistry.lastPlayedVideo = null;
        }
        if (state.lastPlayedVideo && !state.lastPlayedVideo.isConnected) {
            state.lastPlayedVideo = null;
        }
        if (state.pageVideo && !state.pageVideo.isConnected) {
            state.pageVideo = null;
        }
    };

    const ownedPlayListeners = new Map();
    const registerVideo = (video) => {
        if (!isVideoElement(video) || videoRegistry.initializedVideos.has(video)) return;

        videoRegistry.initializedVideos.add(video);
        const onPlay = () => {
            if (!videoRootObserver.running) return;
            videoRegistry.lastPlayedVideo = video;
            state.lastPlayedVideo = video; // 保持原状态字段，避免扩大状态迁移范围
            log('更新 lastPlayedVideo: 当前播放的视频', video);
        };
        video.addEventListener('play', onPlay);
        ownedPlayListeners.set(video, onPlay);
    };

    const shadowRoots = new Set();
    const pendingRoots = new Set();
    let registryTimer = null, discoveryTimer = null;
    const scanVideoSubtree = (root, full = false) => {
        const candidates = full ? new Set() : new Set(videoRegistry.candidates);
        if (full) shadowRoots.clear();
        visitElementsDeep(root, element => {
            if (isVideoElement(element)) { registerVideo(element); candidates.add(element); }
            if (element.shadowRoot) shadowRoots.add(element.shadowRoot);
        });
        videoRegistry.candidates = [...candidates].filter(video => video.isConnected);
    };
    const refreshVideoRegistry = (root = document) => {
        scanVideoSubtree(root, root === document);
        videoRegistry.dirty = false;
        videoRegistry.scanCount++;
        pruneDisconnectedVideos();
        return videoRegistry.candidates;
    };

    const chooseBestVideo = () => {
        if (videoRegistry.dirty) {
            refreshVideoRegistry(document);
        } else {
            pruneDisconnectedVideos();
        }

        const candidates = videoRegistry.candidates;
        const lastPlayedVideo = videoRegistry.lastPlayedVideo || state.lastPlayedVideo;
        if (lastPlayedVideo && isVideoVisible(lastPlayedVideo)) {
            log('lastPlayedVideo 存在且可见');
            return lastPlayedVideo;
        }

        const visiblePlayingVideo = candidates.find(video => isVideoVisible(video) && isVideoPlaying(video));
        if (visiblePlayingVideo) {
            log('找到可见且正在播放的视频:', visiblePlayingVideo);
            return visiblePlayingVideo;
        }

        const playingVideo = candidates.find(isVideoPlaying);
        if (playingVideo) {
            log('找到其他正在播放的视频:', playingVideo);
            return playingVideo;
        }

        const visibleVideo = getLargestVisibleVideo(candidates);
        if (visibleVideo) {
            log('找到可见视频:', visibleVideo);
            return visibleVideo;
        }

        log('未找到合适的视频');
        return null;
    };

    const getBestVideo = () => {
        geometrySnapshot = new Map();
        try { return chooseBestVideo(); } finally { geometrySnapshot = null; }
    };

    const rebuildObservedVideoRoots = () => {
        const observer = videoRootObserver.observer;
        if (!observer || !videoRootObserver.running) return;
        observer.disconnect();
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
        for (const root of shadowRoots) {
            if (!root.host.isConnected) { shadowRoots.delete(root); continue; }
            observer.observe(root, { childList: true, subtree: true });
        }
        videoRegistry.observedRootCount = shadowRoots.size + 1;
    };
    const scheduleVideoRegistryRefresh = () => {
        if (registryTimer !== null) return;
        registryTimer = window.setTimeout(() => {
            registryTimer = null;
            if (!videoRootObserver.running) return;
            for (const root of pendingRoots) if (root.isConnected) scanVideoSubtree(root);
            pendingRoots.clear();
            pruneDisconnectedVideos();
            if (gesture && !gesture.video.isConnected) finishGesture();
            rebuildObservedVideoRoots();
        }, VIDEO_REGISTRY_REFRESH_DELAY_MS);
    };
    const handleVideoRootMutations = mutations => {
        let changed = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Plain leaf text/barrage nodes cannot contain videos or shadow roots.
                if (isVideoElement(node) || node.shadowRoot || node.childElementCount || node.tagName.includes('-')) {
                    pendingRoots.add(node); changed = true;
                }
            }
            if (mutation.removedNodes.length) changed = true;
        }
        if (changed) scheduleVideoRegistryRefresh();
    };
    const startVideoRootObserver = () => {
        if (videoRootObserver.running) return;
        videoRootObserver.observer ||= new MutationObserver(handleVideoRootMutations);
        videoRootObserver.running = true;
        refreshVideoRegistry();
        rebuildObservedVideoRoots();
        // Discover shadow roots attached later to existing hosts; no keyboard-path scan.
        discoveryTimer = window.setInterval(() => {
            if (document.hidden) return;
            refreshVideoRegistry(); rebuildObservedVideoRoots();
        }, 15000);
    };
    const stopVideoRootObserver = () => {
        videoRootObserver.running = false;
        videoRootObserver.observer?.disconnect();
        clearTimeout(registryTimer); clearInterval(discoveryTimer);
        registryTimer = discoveryTimer = null;
        pendingRoots.clear(); shadowRoots.clear();
        for (const [video, handler] of ownedPlayListeners) {
            video.removeEventListener('play', handler);
            videoRegistry.initializedVideos.delete(video);
        }
        ownedPlayListeners.clear();
        videoRegistry.candidates = [];
        videoRegistry.lastPlayedVideo = state.lastPlayedVideo = state.pageVideo = null;
        videoRegistry.dirty = true;
    };

    /**
     * Caches all video elements currently present on the page.
     */
    const cacheAllVideos = () => {
        const allVideos = refreshVideoRegistry(document);
        log('缓存所有视频:', allVideos);
    };

    /**
     * Determines the optimal video element to control.
     * @returns {Promise<HTMLVideoElement|null>} - The selected video element or null.
     */
    const getOptimalPageVideo = () => {
        return getBestVideo();
    };

    /**
     * Checks and updates the current page video.
     * @returns {Promise<boolean>} - True if a video is found, else false.
     */
    const checkPageVideo = () => {
        state.pageVideo = getOptimalPageVideo();
        if (!state.pageVideo) {
            log('未找到符合条件的视频');
            return false;
        }
        return true;
    };

    /**
     * Sets the tabIndex of all progress bars to control focus behavior.
     */
    // One delegated focus handler, owned by the enabled runtime.
    const onProgressFocus = event => {
        if (isInputFocused(event)) finishGesture();
        const el = event.composedPath?.()[0] || event.target;
        if (el?.closest?.('#' + GLR_CFG_MODAL_ID)) return;
        if (el?.matches?.('input[type="range"][class*="slider"], input[type="range"][class*="progress"], input[type="range"][role="slider"]') || el?.closest?.('.yzmplayer-controller')) {
            if (checkPageVideo()) el.blur?.();
        }
    };
    let gesture = null;
    const restoreGestureRate = () => {
        if (!gesture?.rateChanged) return;
        try { if (gesture.video.playbackRate === gesture.appliedRate) gesture.video.playbackRate = gesture.originalRate; } catch {}
        gesture.rateChanged = false;
    };
    const finishGesture = () => { restoreGestureRate(); gesture = null; };
    const seekBy = (video, seconds) => {
        try {
            if (!Number.isFinite(video.currentTime)) return;
            let target = Math.max(0, video.currentTime + seconds);
            if (Number.isFinite(video.duration)) target = Math.min(target, video.duration);
            else if (video.seekable?.length) {
                const ranges = video.seekable;
                target = Math.max(ranges.start(0), Math.min(target, ranges.end(ranges.length - 1)));
                for (let i = 0; i < ranges.length - 1; i++) {
                    if (target > ranges.end(i) && target < ranges.start(i + 1)) target = seconds > 0 ? ranges.start(i + 1) : ranges.end(i);
                }
            } else return;
            video.currentTime = target;
        } catch {}
    };
    const consumeKey = e => { e.preventDefault(); e.stopPropagation(); };
    const onKeyDown = e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.code)) return;
        if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || isInputFocused(e)) { finishGesture(); return; }
        if (gesture && !gesture.video.isConnected) finishGesture();
        if (!gesture) {
            if (e.repeat || !checkPageVideo()) return;
            gesture = { video: state.pageVideo, keys: new Set(), repeated: false, comboConsumed: false, rateChanged: false };
        }
        consumeKey(e);
        const repeated = gesture.keys.has(e.code);
        gesture.keys.add(e.code);
        if (gesture.comboConsumed) return;
        if (gesture.keys.size === 2) {
            restoreGestureRate();
            gesture.comboConsumed = true;
            seekBy(gesture.video, state.bothKeysJumpTime);
        } else if (repeated) {
            gesture.repeated = true;
            if (!gesture.rateChanged && isVideoPlaying(gesture.video)) {
                gesture.originalRate = gesture.video.playbackRate;
                gesture.appliedRate = e.code === 'ArrowRight' ? state.playbackRate : 1 / state.playbackRate;
                try { gesture.video.playbackRate = gesture.appliedRate; gesture.rateChanged = true; } catch {}
            }
        }
    };
    const onKeyUp = e => {
        if (!gesture?.keys.has(e.code)) return;
        consumeKey(e);
        if (!gesture.video.isConnected || isInputFocused(e)) { finishGesture(); return; }
        if (!gesture.comboConsumed && !gesture.repeated) seekBy(gesture.video, e.code === 'ArrowRight' ? state.changeTime : -state.changeTime);
        restoreGestureRate();
        gesture.keys.delete(e.code);
        if (!gesture.keys.size) finishGesture();
    };
    const onVisibility = () => { if (document.hidden) finishGesture(); };
    const onPageHide = () => handleKeyboardEvents(false);
    const handleKeyboardEvents = enable => {
        if (enable === keyboardEventsRegistered) return;
        keyboardEventsRegistered = enable;
        const method = enable ? 'addEventListener' : 'removeEventListener';
        document[method]('keydown', onKeyDown, true);
        document[method]('keyup', onKeyUp, true);
        document[method]('focusin', onProgressFocus, true);
        document[method]('visibilitychange', onVisibility);
        window[method]('blur', finishGesture);
        window[method]('pagehide', onPageHide);
        if (enable) startVideoRootObserver();
        else { finishGesture(); stopVideoRootObserver(); }
    };



    // -------------------- Initialization --------------------

    /**
     * Initializes the userscript by setting up event listeners and observers.
     */
    const init = async () => {
        try {
            state.playbackRate = normalizeFieldNumber(await loadSetting(SETTING_PLAYBACK_RATE_KEY, DEFAULT_RATE), CONFIG_FIELDS[0]);
            state.changeTime = normalizeFieldNumber(await loadSetting(SETTING_CHANGE_TIME_KEY, DEFAULT_TIME), CONFIG_FIELDS[1]);
            state.bothKeysJumpTime = normalizeFieldNumber(await loadSetting(SETTING_BOTH_KEYS_TIME_KEY, DEFAULT_RL_TIME), CONFIG_FIELDS[2]);
            
            const [globalEnabled, isBlocked] = await Promise.all([
                isGlobalEnabled(),
                isDomainBlocked()
            ]);
            handleKeyboardEvents(globalEnabled && !isBlocked);

            // Register menu commands
            if (typeof GM_registerMenuCommand === 'function' && window.top === window) {
                const currentDomain = getRootDomain();
                GM_registerMenuCommand(
                    globalEnabled
                        ? '🔌 全局状态（当前：启用）'
                        : '🔌 全局状态（当前：停用）',
                    toggleGlobalStatus
                );
                GM_registerMenuCommand(
                    isBlocked
                        ? `✅ 在此站点启用（当前：停用 @ ${currentDomain})`
                        : `⛔ 在此站点停用（当前：启用 @ ${currentDomain})`,
                    toggleCurrentDomain
                );
                GM_registerMenuCommand('⚙️ 打开参数配置页', () => {
                    openConfigPanel().catch((error) => {
                        alert(`打开配置页失败：${error?.message || error}`);
                    });
                });
            }

            // Runtime resources are installed only while enabled.
        } catch (error) {
            console.error('初始化脚本时发生错误:', error);
        }
    };

    // Execute the initialization
    window.addEventListener('pageshow', async () => {
        try { handleKeyboardEvents(await isGlobalEnabled() && !await isDomainBlocked()); } catch {}
    });
    init();
})();
