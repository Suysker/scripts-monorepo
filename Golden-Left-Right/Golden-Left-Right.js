// ==UserScript==
// @name         黄金左右键
// @description  按住"→"键倍速播放，按住"←"键减速播放，松开恢复原来的倍速，轻松追剧，看视频更灵活，还能快进/跳过大部分网站的广告！~ 支持用户单独配置倍速和秒数，并可根据根域名启用或禁用脚本
// @icon         https://image.suysker.xyz/i/2023/10/09/artworks-QOnSW1HR08BDMoe9-GJTeew-t500x500.webp
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @author       Suysker
// @match        http://*/*
// @match        https://*/*
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

    // -------------------- State Variables --------------------
    let keyboardEventsRegistered = false;  // 确保键盘事件只注册一次
    const debug = false;                   // 控制日志的输出，正式环境关闭
    let cachedVideos = [];                 // 缓存视频列表

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
        state[field.stateKey] = normalized;
        await saveSetting(field.key, normalized);
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
    const getRootDomain = () => {
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
    const isDomainBlocked = async () => {
        const blockedDomains = await loadSetting(DOMAIN_BLOCK_LIST_KEY, []);
        const currentDomain = getRootDomain();
        return blockedDomains.includes(currentDomain);
    };

    const isGlobalEnabled = () => readBoolSetting(GLOBAL_ENABLE_KEY, true);

    /**
     * Toggles the current domain's blocked status.
     */
    const toggleCurrentDomain = async () => {
        const blockedDomains = await loadSetting(DOMAIN_BLOCK_LIST_KEY, []);
        const currentDomain = getRootDomain();
        const index = blockedDomains.indexOf(currentDomain);
        let isNowBlocked = false;

        if (index === -1) {
            blockedDomains.push(currentDomain);
            await saveSetting(DOMAIN_BLOCK_LIST_KEY, blockedDomains);
            alert(`已禁用黄金左右键脚本在此网站 (${currentDomain})`);
            isNowBlocked = true;
        } else {
            blockedDomains.splice(index, 1);
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
    const isInputFocused = () => {
        const activeElement = document.activeElement;
        if (!activeElement) return false;

        // 1. ContentEditable -> Block
        if (activeElement.isContentEditable) return true;

        const tagName = activeElement.tagName.toLowerCase();

        // 2. Specific tags -> Block (Removed 'button' from blocking)
        if (tagName === 'textarea' || tagName === 'select') return true;

        // 3. Input tag handling
        if (tagName === 'input') {
             // Exception: range is allowed (for seeking)
             if (activeElement.type === 'range') return false;
             
             // Exception: button-like inputs are allowed (don't block hotkeys)
             const buttonTypes = ['button', 'submit', 'reset', 'image'];
             if (buttonTypes.includes(activeElement.type)) return false;

             // All other inputs (text, password, checkbox, radio, etc.) -> Block
             return true;
        }

        return false;
    };

    /**
     * Determines if a video element is visible within the viewport.
     * @param {HTMLVideoElement} video - The video element to check.
     * @returns {boolean} - True if visible, else false.
     */
    const isVideoVisible = (video) => {
        const rect = video.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
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

    /**
     * Adds event listeners to a video element to track playback.
     * @param {HTMLVideoElement} video - The video element.
     */
    const addPlayEventListeners = (video) => {
        video.addEventListener('play', () => {
            state.lastPlayedVideo = video; // 仅在视频播放时更新
            log('更新 lastPlayedVideo: 当前播放的视频', video);
        });

        video.addEventListener('remove', () => {
            removeFromCache([video]);
        });
    };

    /**
     * Initializes event listeners for a list of video elements.
     * @param {HTMLVideoElement[]} videos - Array of video elements.
     */
    const initVideoListeners = (videos) => {
        videos.forEach(video => {
            if (!cachedVideos.includes(video)) {  // 避免重复添加
                cachedVideos.push(video);         // 缓存新视频
                addPlayEventListeners(video);       // 为每个新视频添加监听
            }
        });
    };

    /**
     * Removes video elements from the cache.
     * @param {HTMLVideoElement[]} removedVideos - Array of video elements to remove.
     */
    const removeFromCache = (removedVideos) => {
        cachedVideos = cachedVideos.filter(video => !removedVideos.includes(video));
        log('从缓存中移除视频:', removedVideos);
    };

    /**
     * Finds all video elements within a given node.
     * @param {Node} node - The root node to search within.
     * @returns {HTMLVideoElement[]} - Array of found video elements.
     */
    const findVideosRecursively = (node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return [];
        const videos = [];
        if (node.tagName.toLowerCase() === 'video') {
            videos.push(node);
        }
        videos.push(...node.querySelectorAll('video'));
        return videos;
    };

    /**
     * Caches all video elements currently present on the page.
     */
    const cacheAllVideos = () => {
        const allVideos = Array.from(document.getElementsByTagName('video'));
        initVideoListeners(allVideos);
        log('缓存所有视频:', allVideos);
    };

    /**
     * Determines the optimal video element to control.
     * @returns {Promise<HTMLVideoElement|null>} - The selected video element or null.
     */
    const getOptimalPageVideo = () => {
        // 检查 lastPlayedVideo 是否存在且可见，不检查是否正在播放
        if (state.lastPlayedVideo && isVideoVisible(state.lastPlayedVideo)) {
            log('lastPlayedVideo 存在且可见');
            return state.lastPlayedVideo;
        }

        // 如果 lastPlayedVideo 不存在或不可见，检查是否有其他视频正在播放
        const allVideos = Array.from(document.getElementsByTagName('video'));
        const playingVideo = allVideos.find(isVideoPlaying);
        if (playingVideo) {
            log('找到其他正在播放的视频:', playingVideo);
            return playingVideo;
        }

        // 如果没有合适的视频，返回 null 并记录状态
        log('未找到合适的视频');
        return null;
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
    function configureProgressBars() {
        const configureProgressBar = (progressBar) => {
            // 定义一个内部函数，为传入的元素添加 focus 事件处理
            const disableFocus = (el) => {
                el.addEventListener('focus', () => {
                    if (checkPageVideo()) {
                        el.blur();
                    }
                });
            };

            // 对当前进度条元素及其所有后代元素都进行配置
            disableFocus(progressBar);
            progressBar.querySelectorAll('*').forEach(disableFocus);

            log('已配置进度条:', progressBar);
        };

        // 初始配置页面上已有的进度条
        const progressBars = document.querySelectorAll(
            'input[type="range"][class*="slider"], input[type="range"][class*="progress"], input[type="range"][role="slider"], .yzmplayer-controller'
        );
        progressBars.forEach(configureProgressBar);

        // 监听 DOM 变化，处理新添加的进度条
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const nodes = node.matches('input[type="range"], .yzmplayer-controller')
                            ? [node]
                            : node.querySelectorAll('input[type="range"][class*="slider"], input[type="range"][class*="progress"], input[type="range"][role="slider"], .yzmplayer-controller');
                        nodes.forEach(configureProgressBar);
                    }
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // -------------------- Keyboard Event Handlers --------------------

    /**
     * Registers or unregisters keyboard event listeners.
     * @param {boolean} enable - True to register, false to unregister.
     */
    const handleKeyboardEvents = (enable) => {
        if (enable && !keyboardEventsRegistered) {
            // 将事件监听器绑定到 document 对象，使用 capture 模式，确保优先级更高
            document.addEventListener('keydown', onRightKeyDown, { capture: true });
            document.addEventListener('keydown', onLeftKeyDown, { capture: true });
            document.addEventListener('keyup', onRightKeyUp, { capture: true });
            document.addEventListener('keyup', onLeftKeyUp, { capture: true });
            keyboardEventsRegistered = true;
            log('键盘事件已注册');
        } else if (!enable && keyboardEventsRegistered) {
            document.removeEventListener('keydown', onRightKeyDown, { capture: true });
            document.removeEventListener('keydown', onLeftKeyDown, { capture: true });
            document.removeEventListener('keyup', onRightKeyUp, { capture: true });
            document.removeEventListener('keyup', onLeftKeyUp, { capture: true });
            keyboardEventsRegistered = false;
            log('键盘事件已注销');
        }
    };

    /**
     * Checks if both left and right keys are pressed.
     * @returns {Promise<boolean>} - True if both are pressed and action is taken.
     */
    const checkBothKeysPressed = () => {
        if (state.rightKeyDownCount === 1 && state.leftKeyDownCount === 1 && checkPageVideo()) {
            state.pageVideo.currentTime += state.bothKeysJumpTime;
            log(`同时按下左右键，快进 ${state.bothKeysJumpTime} 秒`);
            // Reset counts to prevent repeated triggering
            state.rightKeyDownCount = 0;
            state.leftKeyDownCount = 0;
            return true; // 表示已处理
        }
        return false;
    };

    /**
     * Handles the right arrow key down event.
     * @param {KeyboardEvent} e - The keyboard event.
     */
    const onRightKeyDown = (e) => {
        if (e.code !== 'ArrowRight' || isInputFocused()) return;
        e.preventDefault();
        e.stopPropagation();
        state.rightKeyDownCount++;

        // 检查是否同时按下左右键
        if (checkBothKeysPressed()) return;

        if (state.rightKeyDownCount === 2 && checkPageVideo() && isVideoPlaying(state.pageVideo)) {
            state.originalPlaybackRate = state.pageVideo.playbackRate;
            state.pageVideo.playbackRate = state.playbackRate;
            log('加速播放中, 倍速: ' + state.playbackRate);
        }
    };

    /**
     * Handles the right arrow key up event.
     * @param {KeyboardEvent} e - The keyboard event.
     */
    const onRightKeyUp = (e) => {
        if (e.code !== 'ArrowRight' || isInputFocused()) return;
        e.preventDefault();
        e.stopPropagation();

        if (state.rightKeyDownCount === 1 && checkPageVideo()) {
            state.pageVideo.currentTime += state.changeTime;
            log('前进 ' + state.changeTime + ' 秒');
        }

        // 恢复原来的倍速
        if (state.pageVideo && state.pageVideo.playbackRate !== state.originalPlaybackRate) {
            state.pageVideo.playbackRate = state.originalPlaybackRate;
            log('恢复原来的倍速: ' + state.originalPlaybackRate);
        }

        state.rightKeyDownCount = 0;
    };

    /**
     * Handles the left arrow key down event.
     * @param {KeyboardEvent} e - The keyboard event.
     */
    const onLeftKeyDown = (e) => {
        if (e.code !== 'ArrowLeft' || isInputFocused()) return;
        e.preventDefault();
        e.stopPropagation();
        state.leftKeyDownCount++;

        // 检查是否同时按下左右键
        if (checkBothKeysPressed()) return;

        if (state.leftKeyDownCount === 2 && checkPageVideo() && isVideoPlaying(state.pageVideo)) {
            state.originalPlaybackRate = state.pageVideo.playbackRate;
            state.pageVideo.playbackRate = 1 / state.playbackRate;
            log('减速播放中, 倍速: ' + state.pageVideo.playbackRate);
        }
    };

    /**
     * Handles the left arrow key up event.
     * @param {KeyboardEvent} e - The keyboard event.
     */
    const onLeftKeyUp = (e) => {
        if (e.code !== 'ArrowLeft' || isInputFocused()) return;
        e.preventDefault();
        e.stopPropagation();

        if (state.leftKeyDownCount === 1 && checkPageVideo()) {
            state.pageVideo.currentTime -= state.changeTime;
            log('回退 ' + state.changeTime + ' 秒');
        }

        // 恢复原来的倍速
        if (state.pageVideo && state.pageVideo.playbackRate !== state.originalPlaybackRate) {
            state.pageVideo.playbackRate = state.originalPlaybackRate;
            log('恢复原来的倍速: ' + state.originalPlaybackRate);
        }

        state.leftKeyDownCount = 0;
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

            // Cache existing videos and set up listeners
            cacheAllVideos();

            // Observe DOM mutations to handle dynamically added or removed videos
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    const addedNodes = Array.from(mutation.addedNodes);
                    addedNodes.forEach(node => {
                        const addedVideos = findVideosRecursively(node); // 查找新增节点中的 video
                        if (addedVideos.length > 0) {
                            initVideoListeners(addedVideos); // 初始化新增视频
                            log('添加新视频:', addedVideos);
                        }
                    });

                    const removedNodes = Array.from(mutation.removedNodes);
                    removedNodes.forEach(node => {
                        const removedVideos = findVideosRecursively(node); // 查找移除节点中的 video
                        if (removedVideos.length > 0) {
                            removeFromCache(removedVideos); // 移除缓存中的视频
                        }
                    });
                });
            });

            observer.observe(document.body, { childList: true, subtree: true });
            log('MutationObserver 已启动');

            // 配置进度条的焦点行为
            configureProgressBars();
        } catch (error) {
            console.error('初始化脚本时发生错误:', error);
        }
    };

    // Execute the initialization
    init();
})();

