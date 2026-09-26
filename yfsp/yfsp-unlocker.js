// ==UserScript==
// @name         YFSP.TV Unlocker
// @namespace    http://tampermonkey.net/
// @version      1.10.0
// @description  Uses the Windows client's playback endpoint, maps available HLS qualities, shows actual resolution and tunes VOD buffering. Adds click-to-toggle and container fullscreen.
// @author       YFSP Analyst
// @match        *://*.yfsp.tv/*
// @match        *://*.yifan.tv/*
// @match        *://*.iyf.tv/*
// @match        *://*.aiyifan.tv/*
// @match        *://*.dudupro.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepage     https://github.com/Suysker/scripts-monorepo/tree/main/yfsp
// @supportURL   https://github.com/Suysker/scripts-monorepo/issues
// ==/UserScript==

(function() {
    'use strict';

    const VIP_LEVEL = 99;
    const DEFAULT_USER_ID = 1;
    const DEFAULT_ROLE_ID = 1;
    const MIN_LEVEL = 2;
    const BOOTSTRAP_INTERVAL_MS = 2000;
    const CLICK_TOGGLE_DELAY_MS = 250;
    const MIN_CLICK_TOGGLE_VIDEO_EDGE_PX = 120;
    const FULLSCREEN_CONTROL_REVEAL_MS = 2500;
    const FULLSCREEN_TARGET_ATTRIBUTE = 'data-yfsp-fullscreen-target';
    const FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE = 'data-yfsp-controls-visible';
    const PLAYER_CONTAINER_SELECTOR = 'aa-videoplayer, vg-player#main-player, .video-container';

    const MATCH_USER = [/\/api\/payment\/getPaymentInfo/i, /\/api\/user\/info/i];
    const MATCH_PLAY = [/\/v3\/video\/play/i, /\/v3\/video\/detail/i];
    const STYLE_ID = 'yfsp-unlocker-style';
    const STYLE_TEXT = String.raw`
iframe[src*="google"],
iframe[src*="doubleclick"],
:is(aa-videoplayer, .video-container) :is(.ad, .ads, [data-ad-slot]),
.use-coin-box,
#coin-or-upgrade-to-skip-ad,
#dn_iframe {
    display: none !important;
}

.quality-btn {
    opacity: 1 !important;
    pointer-events: auto !important;
}

[${FULLSCREEN_TARGET_ATTRIBUTE}]:fullscreen,
[${FULLSCREEN_TARGET_ATTRIBUTE}]:-webkit-full-screen {
    display: block !important;
    width: 100vw !important;
    height: 100vh !important;
    min-width: 100vw !important;
    min-height: 100vh !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #000 !important;
    overflow: hidden !important;
    position: relative !important;
    inset: 0 !important;
}

[${FULLSCREEN_TARGET_ATTRIBUTE}]:fullscreen::backdrop,
[${FULLSCREEN_TARGET_ATTRIBUTE}]:-webkit-full-screen::backdrop {
    background: #000 !important;
}

[${FULLSCREEN_TARGET_ATTRIBUTE}]:fullscreen :is(vg-player, .video-container, .video-box),
[${FULLSCREEN_TARGET_ATTRIBUTE}]:-webkit-full-screen :is(vg-player, .video-container, .video-box) {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    min-height: 100% !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
    padding: 0 !important;
    position: relative !important;
    background: #000 !important;
    overflow: hidden !important;
}

[${FULLSCREEN_TARGET_ATTRIBUTE}]:fullscreen video,
[${FULLSCREEN_TARGET_ATTRIBUTE}]:-webkit-full-screen video {
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    max-height: none !important;
    object-fit: contain !important;
    background: #000 !important;
    filter: none !important;
    opacity: 1 !important;
}

[${FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE}]:fullscreen :is(vg-controls, vg-scrub-bar, vg-quality-selector),
[${FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE}]:-webkit-full-screen :is(vg-controls, vg-scrub-bar, vg-quality-selector) {
    visibility: visible !important;
    opacity: 1 !important;
    z-index: 2147483646 !important;
}
`;

    const normalizeUrl = (input) => {
        try {
            if (input && typeof input === 'object' && input.url) input = input.url;
        } catch (e) {}

        if (typeof input !== 'string') {
            try {
                input = String(input);
            } catch (e) {
                return '';
            }
        }

        try {
            return new URL(input, location.href).toString();
        } catch (e) {
            return input;
        }
    };

    const shouldMatch = (url, patterns) => patterns.some((pattern) => pattern.test(url));

    const getPlaybackRequestUrl = (input, method = 'GET') => {
        if (String(method).toUpperCase() !== 'GET' || !readPreference('yfsp.clientPlayback', true)) return input;
        try {
            const url = new URL(input, location.href);
            // Windows 3.1.5: APIV3_ENDPOINT + GetHost + defaultApp.injectJSON.
            // Route only this read-only API, not account/payment/other requests.
            if (url.protocol !== 'https:' || url.pathname !== '/v3/video/play' ||
                !/^m10\.(yfsp\.tv|iyf\.tv|yifan\.tv|aiyifan\.tv|dudupro\.com)$/.test(url.hostname)) return input;
            url.hostname = 'app-m10.tripdata.app';
            return url.href;
        } catch (error) { return input; }
    };

    const hasPlayablePath = (item) => {
        const path = item?.path;
        const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
        return nonempty(path) || (path && typeof path === 'object' &&
            (nonempty(path.result) || nonempty(path.dashResult))) || false;
    };
    const readPreference = (key, fallback) => {
        try {
            const value = typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
            return typeof value === 'boolean' ? value : fallback;
        } catch (e) { return fallback; }
    };
    const CLIENT_PROFILE = Object.freeze({
        isApp: 1,
        package: 'com.iiff.www',
        appVersion: '3.1.5',
        system: 'WINDOWS',
        deviceInfo: ''
    });
    const CLIENT_DEVICE_KEY = 'yfsp.clientDevice';
    const isValidClientDevice = (value) => value && typeof value === 'object' &&
        typeof value.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.uuid) &&
        Number.isSafeInteger(value.start) && value.start > 0;

    const installClientIdentity = () => {
        if (!readPreference('yfsp.clientIdentity', true)) return;
        try {
            // Match the desktop bridge's extra_data entry point. Keep the device
            // identity in userscript storage, never import an ID from page storage.
            if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
            let device = GM_getValue(CLIENT_DEVICE_KEY, null);
            if (!isValidClientDevice(device)) {
                device = { uuid: crypto.randomUUID(), start: Date.now() };
                GM_setValue(CLIENT_DEVICE_KEY, device);
            }
            const root = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const profile = { uuid: device.uuid, start: device.start, ...CLIENT_PROFILE };
            // Firefox needs page-readable objects when crossing the sandbox boundary.
            const payload = typeof cloneInto === 'function' ? cloneInto(profile, root) : profile;
            const existing = root.extra_data;
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                Object.assign(existing, payload);
            } else {
                root.extra_data = payload;
            }
        } catch (error) {
            console.log('[YFSP Unlocker] Client identity could not be installed:', error);
        }
    };
    let playbackNotice = '';
    let playbackNoticeUntil = 0;
    let playbackPanel = null;
    let bufferState = null;

    const showPlaybackNotice = (message) => {
        playbackNotice = message;
        playbackNoticeUntil = Date.now() + 8000;
        updatePlaybackExperience();
    };

    const getBufferedSeconds = (video) => {
        for (let index = 0; index < video.buffered.length; index++) {
            if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
                return Math.max(0, video.buffered.end(index) - video.currentTime);
            }
        }
        return 0;
    };

    const getVideoHls = (video) => {
        const context = video?.__ngContext__;
        if (!Array.isArray(context)) return null;
        const directive = context.find((entry) => entry?.hls?.media === video && entry.hls.config);
        return directive?.hls || null;
    };

    // A quality menu entry is not itself a playable source. Match the actual
    // manifest labels, never assume the menu order equals the HLS level order.
    const resolveStandardQualityRoute = (item, player, hls) => {
        if (!item) return { kind: 'delegate' };
        if (Number(item.bitrate) > 1080) return { kind: hasPlayablePath(item) ? 'source' : 'unavailable' };
        if (player?.isMasterEnabled && !player.hasError) {
            if (!hls?.levels?.length) return { kind: 'pending' };
            const matches = hls.levels.flatMap((level, index) => {
                const label = String(level.name || level.attrs?.NAME || '').trim();
                return /^(576|720|1080)p?$/i.test(label) && Number(label.replace(/p$/i, '')) === Number(item.bitrate) ? [index] : [];
            });
            if (matches.length === 1) return { kind: 'master', index: matches[0] };
            if (hasPlayablePath(item)) return { kind: 'source' };
            const known = hls.levels.every(level => /^(576|720|1080)p?$/i.test(String(level.name || level.attrs?.NAME || '').trim()));
            return { kind: matches.length || !known ? 'delegate' : 'unavailable' };
        }
        if (hasPlayablePath(item)) return { kind: 'source' };
        return { kind: player && !player.hasError && !hls?.levels?.length ? 'pending' : 'unavailable' };
    };

    const restoreBufferConfig = () => {
        if (!bufferState) return;
        const { config, original, applied } = bufferState;
        for (const key of Object.keys(applied)) {
            // Do not roll back a later change made by the site or StreamBoost.
            if (config[key] === applied[key]) config[key] = original[key];
        }
        bufferState = null;
    };

    const tuneVodBuffer = (hls, enabled) => {
        const details = hls?.latestLevelDetails || hls?.levels?.[hls.currentLevel]?.details;
        const allowed = enabled && details?.live === false && !navigator.connection?.saveData;
        if (bufferState && (bufferState.hls !== hls || !allowed)) restoreBufferConfig();
        if (!allowed || !hls?.config) return false;
        if (bufferState?.hls === hls) return true;
        const config = hls.config;
        const keys = ['maxBufferLength', 'maxMaxBufferLength', 'maxBufferSize'];
        if (!keys.every((key) => Number.isFinite(config[key]) && config[key] >= 0)) return false;
        const lowMemory = Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) < 4;
        const target = lowMemory ? 45 : 90;
        const original = Object.fromEntries(keys.map((key) => [key, config[key]]));
        const applied = {
            maxBufferLength: Math.max(config.maxBufferLength, target),
            maxMaxBufferLength: Math.max(config.maxMaxBufferLength, config.maxBufferLength, target),
            maxBufferSize: Math.max(config.maxBufferSize, (lowMemory ? 64 : 128) * 1024 * 1024)
        };
        Object.assign(config, applied);
        bufferState = { hls, config, original, applied };
        return true;
    };

    const updatePlaybackExperience = () => {
        const video = findMainVideoElement();
        const hls = getVideoHls(video);
        const optimized = tuneVodBuffer(hls, readPreference('yfsp.bufferBoost', true));
        const showInfo = readPreference('yfsp.showPlaybackInfo', false);
        const notice = Date.now() < playbackNoticeUntil ? playbackNotice : '';
        const container = video && findFullscreenContainer(video);
        if (!container || (!showInfo && !notice)) {
            if (playbackPanel) playbackPanel.remove();
            playbackPanel = null;
            return;
        }
        if (!playbackPanel) {
            playbackPanel = document.createElement('div');
            playbackPanel.setAttribute('data-yfsp-playback-info', '');
            playbackPanel.style.cssText = 'position:absolute;top:12px;left:12px;z-index:2147483646;max-width:85%;padding:8px 12px;border-radius:6px;background:rgba(0,0,0,.78);color:#fff;font:12px/1.7 sans-serif;white-space:pre-line;pointer-events:none;text-align:left;';
        }
        if (playbackPanel.parentNode !== container) container.appendChild(playbackPanel);
        const resolution = video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '等待视频元数据';
        const state = video.error ? `播放错误 ${video.error.code}` : video.paused ? '已暂停' : video.readyState < 3 ? '缓冲中' : '播放中';
        const text = [
            showInfo ? `实际分辨率：${resolution}\n已缓冲：${getBufferedSeconds(video).toFixed(1)} 秒 · ${state}\n${optimized ? '点播缓冲优化已启用' : '使用播放器原有缓冲策略'}` : '',
            notice
        ].filter(Boolean).join('\n');
        if (playbackPanel.textContent !== text) playbackPanel.textContent = text;
    };

    const installPlaybackMenus = () => {
        if (typeof GM_registerMenuCommand !== 'function' || typeof GM_setValue !== 'function') return;
        const toggle = (key, fallback) => {
            const enabled = !readPreference(key, fallback);
            GM_setValue(key, enabled);
            showPlaybackNotice(`${key === 'yfsp.bufferBoost' ? '点播缓冲优化' : '播放状态显示'}：${enabled ? '开启' : '关闭'}`);
        };
        GM_registerMenuCommand('开启／关闭点播缓冲优化', () => toggle('yfsp.bufferBoost', true));
        GM_registerMenuCommand('显示／隐藏实际画质与缓冲状态', () => toggle('yfsp.showPlaybackInfo', false));
        GM_registerMenuCommand('开启／关闭客户端标识（刷新生效）', () => {
            const enabled = !readPreference('yfsp.clientIdentity', true);
            GM_setValue('yfsp.clientIdentity', enabled);
            showPlaybackNotice(`客户端标识：${enabled ? '开启' : '关闭'}，刷新页面后生效。`);
        });
        GM_registerMenuCommand('开启／关闭客户端播放接口（刷新生效）', () => {
            const enabled = !readPreference('yfsp.clientPlayback', true);
            GM_setValue('yfsp.clientPlayback', enabled);
            showPlaybackNotice(`客户端播放接口：${enabled ? '开启' : '关闭'}，刷新页面后生效。`);
        });
        GM_registerMenuCommand('开启／关闭每日自动签到', () => {
            GM_setValue('yfsp.autoCheckIn', !readPreference('yfsp.autoCheckIn', true));
        });
    };

    // Compatibility is local to UI components. Never mutate the account service,
    // its observable state, HTTP credentials or the server's response objects.
    const compatibilityUsers = new WeakMap();
    const compatibilitySources = new WeakMap();
    const compatibilityServices = new WeakMap();
    const compatibilityServiceSources = new WeakMap();
    const guestUser = Object.freeze({});
    const patchUserState = (user) => {
        const source = compatibilitySources.get(user) || (user && typeof user === 'object' ? user : guestUser);
        const view = compatibilityUsers.get(source) || {};
        Object.assign(view, source, { id: source.id || DEFAULT_USER_ID,
            roleId: source.roleId > 0 ? source.roleId : DEFAULT_ROLE_ID,
            level: Math.max(Number(source.level) || 0, MIN_LEVEL), isVip: true, vipLevel: VIP_LEVEL });
        // JSON consumers retain the real identity rather than the presentation copy.
        if (!compatibilityUsers.has(source)) Object.defineProperty(view, 'toJSON', { value: () => source });
        compatibilityUsers.set(source, view);
        compatibilitySources.set(view, source);
        return view;
    };

    const patchServiceUser = (target) => {
        if (!target || typeof target !== 'object') return;
        const service = target._userService;
        if (!service || typeof service !== 'object') return;
        if (!compatibilityServices.has(service)) {
            const bound = new Map();
            const view = new Proxy(service, { get(real, key) {
                if (key === 'user') return patchUserState(real.user);
                const value = Reflect.get(real, key, real);
                if (typeof value !== 'function') return value;
                if (!bound.has(value)) bound.set(value, value.bind(real));
                return bound.get(value);
            } });
            compatibilityServices.set(service, view);
            compatibilityServices.set(view, view);
            compatibilityServiceSources.set(view, service);
        }
        target._userService = compatibilityServices.get(service);
    };

    const patchServiceUserState = (target) => {
        // The shared observable is deliberately kept real; patch only its consumer.
        patchServiceUser(target);
    };

    const patchUser = (json) => json;
    const patchPlay = (json) => json;

    const checkInMemory = new Map();
    const checkInPending = new Set();
    let nextCheckInScan = 0;
    const checkInStored = (key) => {
        try {
            const value = (typeof GM_getValue === 'function' ? GM_getValue(key, null) : null) ?? checkInMemory.get(key);
            if (!value || typeof value !== 'object') return undefined;
            if (key.endsWith('.lease')) return Number.isFinite(value.until) && value.until <= Date.now() + 60000 ? value : undefined;
            return Number.isFinite(value.nextCheck) && value.nextCheck <= Date.now() + 172800000 && typeof value.confirmed === 'boolean' ? value : undefined;
        }
        catch { return checkInMemory.get(key); }
    };
    const saveCheckIn = (key, value) => {
        checkInMemory.set(key, value);
        while (checkInMemory.size > 64) checkInMemory.delete(checkInMemory.keys().next().value);
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch {}
    };
    const signInValue = (observable) => new Promise((resolve, reject) => {
        let settled = false, subscription;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            subscription?.unsubscribe?.();
            error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('check-in timeout')), 12000);
        try {
            subscription = observable.subscribe({ next: value => finish(null, value),
                error: error => finish(error), complete: () => finish(new Error('empty check-in response')) });
            if (settled) subscription?.unsubscribe?.();
        } catch (error) { finish(error); }
    });
    const getCheckInContext = (component) => {
        const service = component?.signInService;
        const users = compatibilityServiceSources.get(component?._userService) || component?._userService;
        const user = compatibilitySources.get(users?.user) || users?.user;
        const helper = service?.httpClientHelper;
        if (!(Number(user?.id) > 0) || Number(helper?.token?.uid) !== Number(user.id) ||
            typeof helper.token.token !== 'string' || !helper.token.token ||
            typeof helper.globalHandler !== 'function' ||
            typeof service?.getSignInData !== 'function' || typeof service?.signInSubmit !== 'function') return null;
        return { service, users, helper, uid: Number(user.id), token: helper.token.token };
    };
    const runDailyCheckIn = async (component) => {
        if (!readPreference('yfsp.autoCheckIn', true)) return;
        const context = getCheckInContext(component);
        if (!context) return;
        const { service, users, helper, uid, token } = context;
        const key = `yfsp.checkIn.${location.hostname}.${uid}`;
        if (checkInPending.has(key) || Number(checkInStored(key)?.nextCheck) > Date.now()) return;
        checkInPending.add(key);
        const stillCurrent = () => {
            const current = getCheckInContext(component);
            return readPreference('yfsp.autoCheckIn', true) && current?.uid === uid && current.token === token;
        };
        const work = async () => {
            if (!stillCurrent() || Number(checkInStored(key)?.nextCheck) > Date.now()) return;
            saveCheckIn(key, { nextCheck: Date.now() + 30 * 60 * 1000, confirmed: false });
            // Reuse native routes, payload and signing, but suppress dialogs only
            // for this background receiver. Never alter the shared helper.
            const quietHelper = new Proxy(helper, { get(target, name, receiver) {
                if (name === 'globalHandler') return data => data?.code === 0;
                return Reflect.get(target, name, receiver);
            } });
            const quietService = Object.create(service, { httpClientHelper: { value: quietHelper } });
            const readStatus = async () => {
                const response = await signInValue(service.getSignInData.call(quietService, uid));
                const status = Array.isArray(response) ? response[0] : null;
                if (!status || ![0, 1].includes(status.bonus_status)) throw new Error('unknown check-in status');
                return status;
            };
            try {
                let status = await readStatus();
                if (!stillCurrent()) return;
                let reward;
                if (status.bonus_status === 0) {
                    const response = await signInValue(service.signInSubmit.call(quietService));
                    if (!stillCurrent()) return;
                    reward = Array.isArray(response) ? response[0] : null;
                    status = await readStatus();
                }
                if (!stillCurrent() || status.bonus_status !== 1) return;
                const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
                const seconds = Number(status.sign_after);
                const nextCheck = Number.isFinite(seconds) && seconds > 0 ?
                    Date.now() + Math.min(seconds, 172800) * 1000 : midnight.getTime();
                saveCheckIn(key, { nextCheck, confirmed: true });
                service.setNewState?.(status);
                service.afterSigned?.(true);
                if (reward && typeof users.updateUserData === 'function') {
                    const update = {};
                    for (const [field, source] of Object.entries({ dnCoins: 'gold', experience: 'experience',
                        level: 'currentLevel', expToNextLevel: 'nextLevel' })) {
                        if (Number.isFinite(reward[source])) update[field] = reward[source];
                    }
                    if (Object.keys(update).length) users.updateUserData(update);
                }
            } catch { /* Quiet failure; no account data in logs. */ }
        };
        try {
            if (navigator.locks?.request) {
                await navigator.locks.request(key, { ifAvailable: true }, lock => lock ? work() : undefined);
            } else {
                // Best-effort cross-tab lease when Web Locks is unavailable.
                const leaseKey = `${key}.lease`;
                if (Number(checkInStored(leaseKey)?.until) > Date.now()) return;
                const owner = crypto.randomUUID();
                saveCheckIn(leaseKey, { owner, until: Date.now() + 60000 });
                await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 150));
                if (checkInStored(leaseKey)?.owner !== owner) return;
                try { await work(); }
                finally { if (checkInStored(leaseKey)?.owner === owner) saveCheckIn(leaseKey, { until: 0 }); }
            }
        } catch { /* Feature failures must not interrupt playback. */ }
        finally { checkInPending.delete(key); }
    };
    const autoCheckIn = () => {
        if (Date.now() < nextCheckInScan || !readPreference('yfsp.autoCheckIn', true)) return;
        nextCheckInScan = Date.now() + 15000;
        const component = findAngularComponent('app-dn-menu', entry => entry?.signInService && entry?._userService);
        if (component) void runDailyCheckIn(component);
    };

    const unlockList = (list) => {
        if (!Array.isArray(list)) return;

        list.forEach((item) => {
            if (!item || typeof item !== 'object') return;
            if ('vipFunction' in item) item.vipFunction = false;
            if ('isDisabled' in item) item.isDisabled = false;
            if ('disabled' in item) item.disabled = false;
            if ('isLocked' in item) item.isLocked = false;
            if ('lock' in item) item.lock = false;
        });
    };

    // Route requests only. Preserve the original Response/XHR body and metadata.
    const hookFetch = (root) => {
        if (!root || root.__yfsp_fetch_hooked || typeof root.fetch !== 'function') return;
        const original = root.fetch;
        root.fetch = function(input, init) {
            const url = normalizeUrl(input);
            const routed = getPlaybackRequestUrl(url, init?.method || input?.method || 'GET');
            if (routed !== url) input = typeof root.Request === 'function' && input instanceof root.Request ? new root.Request(routed, input) : routed;
            return original.call(this, input, init);
        };
        root.__yfsp_fetch_hooked = true;
    };
    const hookXhr = (root) => {
        const proto = root?.XMLHttpRequest?.prototype;
        if (!proto || proto.__yfsp_patched) return;
        const original = proto.open;
        proto.open = function(method, url, ...rest) {
            return original.call(this, method, getPlaybackRequestUrl(normalizeUrl(url), method), ...rest);
        };
        proto.__yfsp_patched = true;
        root.__yfsp_xhr_hooked = true;
    };

    const ensureStyle = () => {
        if (document.getElementById(STYLE_ID)) return;
        const parent = document.head || document.documentElement;
        if (!parent) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.append(STYLE_TEXT);

        parent.appendChild(style);
    };

    const applyGlobals = (root) => {
        try {
            Object.defineProperty(root, 'isAdsBlocked', { get: () => false, configurable: true });
        } catch (e) {}
    };

    const hideAds = () => {
        const dialog = document.getElementById('coin-or-upgrade-to-skip-ad');
        if (dialog) dialog.style.display = 'none';

        const dnIframe = document.getElementById('dn_iframe');
        if (dnIframe) dnIframe.style.display = 'none';

        // Login, playback errors and source availability dialogs must stay visible.
    };

    let refreshTimer = null;
    const scheduleRefresh = () => {
        if (refreshTimer !== null) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; refreshDynamicFeatures(); }, 100);
    };
    const observeDom = () => {
        if (window.__yfsp_observer || !document.documentElement) return;
        const selector = 'aa-videoplayer,vg-quality-selector,app-dn-menu,app-danmu-input,app-comment-box,.emoji-box,video,#dn_iframe,#coin-or-upgrade-to-skip-ad';
        const observer = new MutationObserver(records => {
            if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
                node.nodeType === 1 && (node.matches?.(selector) || node.querySelector?.(selector))))) scheduleRefresh();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__yfsp_observer = observer;
    };

    const isVisibleCandidateVideo = (video) => {
        if (!video || video.tagName !== 'VIDEO') return false;
        const computed = getComputedStyle(video);
        if (computed.display === 'none' || computed.visibility === 'hidden') return false;

        const rect = video.getBoundingClientRect();
        if (rect.width < MIN_CLICK_TOGGLE_VIDEO_EDGE_PX || rect.height < MIN_CLICK_TOGGLE_VIDEO_EDGE_PX) return false;
        return true;
    };

    const findMainVideoElement = () => {
        const direct = document.getElementById('video_player');
        if (isVisibleCandidateVideo(direct)) return direct;

        const root =
            document.querySelector('aa-videoplayer') ||
            document.querySelector('vg-player#main-player') ||
            document.querySelector('.video-container') ||
            document;

        const candidates = Array.from(root.querySelectorAll('video')).filter(isVisibleCandidateVideo);
        if (!candidates.length) return null;

        let best = null;
        let bestArea = 0;
        candidates.forEach((video) => {
            const rect = video.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > bestArea) {
                bestArea = area;
                best = video;
            }
        });

        return best;
    };

    const findFullscreenContainer = (video) => {
        if (!video || typeof video.closest !== 'function') return null;

        const candidates = [
            video.closest('vg-player#main-player'),
            video.closest('aa-videoplayer'),
            video.closest('.video-container'),
            video.closest(PLAYER_CONTAINER_SELECTOR),
            video.parentElement
        ];

        return (
            candidates.find(
                (element) =>
                    element &&
                    element.nodeType === Node.ELEMENT_NODE &&
                    element.isConnected &&
                    element !== document.documentElement &&
                    element !== document.body &&
                    element.contains(video)
            ) || null
        );
    };

    const shouldIgnoreToggleClickTarget = (target) => {
        if (!target || typeof target.closest !== 'function') return false;

        return Boolean(
            target.closest(
                [
                    'vg-controls',
                    'vg-scrub-bar',
                    'vg-quality-selector',
                    'button',
                    'a',
                    'input',
                    'textarea',
                    'select',
                    '[role="button"]',
                    '[role="slider"]',
                    '[contenteditable="true"]'
                ].join(', ')
            )
        );
    };

    const installClickToggle = () => {
        if (window.__yfsp_click_toggle_installed) return;
        window.__yfsp_click_toggle_installed = true;

        let timer = null;

        const cancelPendingToggle = () => {
            if (!timer) return;
            clearTimeout(timer);
            timer = null;
        };
        window.addEventListener('pagehide', cancelPendingToggle);

        document.addEventListener(
            'dblclick',
            () => {
                cancelPendingToggle();
            },
            true
        );

        document.addEventListener(
            'click',
            (event) => {
                try {
                    if (!event || event.defaultPrevented) return;
                    if (event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    if (!event.target || typeof event.target.closest !== 'function') return;
                    if (!event.target.closest(PLAYER_CONTAINER_SELECTOR)) return;
                    if (shouldIgnoreToggleClickTarget(event.target)) return;

                    // Suppress click-to-toggle when the user double clicks (e.g., fullscreen), matching typical players.
                    if (event.detail && event.detail > 1) {
                        cancelPendingToggle();
                        return;
                    }

                    const video = findMainVideoElement();
                    if (!video) return;
                    const pausedBeforeClick = video.paused;

                    cancelPendingToggle();
                    timer = setTimeout(() => {
                        timer = null;
                        if (!video.isConnected) return;

                        // If the site already handled this click, don't toggle again.
                        if (video.paused !== pausedBeforeClick) return;

                        if (video.paused) {
                            const promise = video.play();
                            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
                        } else {
                            video.pause();
                        }
                    }, CLICK_TOGGLE_DELAY_MS);
                } catch (e) {}
            },
            true
        );
    };

    const requestFullscreenSafe = (element) => {
        if (!element) return false;

        const request =
            element.requestFullscreen ||
            element.webkitRequestFullscreen ||
            element.msRequestFullscreen ||
            element.mozRequestFullScreen ||
            element.webkitRequestFullScreen;

        if (typeof request !== 'function') return false;

        try {
            const promise = request.call(element);
            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    };

    const exitFullscreenSafe = () => {
        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen || document.mozCancelFullScreen;
        if (typeof exit !== 'function') return false;

        try {
            const promise = exit.call(document);
            if (promise && typeof promise.catch === 'function') promise.catch(() => {});
            return true;
        } catch (e) {
            return false;
        }
    };

    const getFullscreenElement = () =>
        document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || document.mozFullScreenElement || null;

    const getFullscreenPlayerContainer = () => {
        const element = getFullscreenElement();
        return element && typeof element.matches === 'function' && element.matches(PLAYER_CONTAINER_SELECTOR) ? element : null;
    };

    const installFullscreenControlReveal = () => {
        if (window.__yfsp_fullscreen_control_reveal_installed) return;
        window.__yfsp_fullscreen_control_reveal_installed = true;

        let revealTimer = null;

        const clearRevealTimer = () => {
            if (!revealTimer) return;
            clearTimeout(revealTimer);
            revealTimer = null;
        };

        const clearFullscreenMarkers = () => {
            clearRevealTimer();
            document.querySelectorAll(`[${FULLSCREEN_TARGET_ATTRIBUTE}], [${FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE}]`).forEach((element) => {
                element.removeAttribute(FULLSCREEN_TARGET_ATTRIBUTE);
                element.removeAttribute(FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE);
            });
        };

        const revealControls = () => {
            const container = getFullscreenPlayerContainer();
            if (!container) return;

            container.setAttribute(FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE, '');
            clearRevealTimer();
            revealTimer = setTimeout(() => {
                container.removeAttribute(FULLSCREEN_CONTROL_VISIBLE_ATTRIBUTE);
                revealTimer = null;
            }, FULLSCREEN_CONTROL_REVEAL_MS);
        };

        const syncFullscreenState = () => {
            if (getFullscreenPlayerContainer()) {
                revealControls();
                return;
            }

            clearFullscreenMarkers();
        };

        ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach((eventName) => {
            document.addEventListener(eventName, syncFullscreenState, true);
        });

        ['fullscreenerror', 'webkitfullscreenerror', 'mozfullscreenerror', 'MSFullscreenError'].forEach((eventName) => {
            document.addEventListener(eventName, clearFullscreenMarkers, true);
        });

        ['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach((eventName) => {
            document.addEventListener(eventName, revealControls, true);
        });
    };

    const installContainerFullscreenHijack = () => {
        if (window.__yfsp_container_fullscreen_installed) return;
        window.__yfsp_container_fullscreen_installed = true;

        const isFullscreenToggleTarget = (target) => {
            if (!target || typeof target.closest !== 'function') return false;

            // The site uses <vg-fullscreen> with a div[role=button][aria-label=fullscreen].
            if (target.closest('vg-fullscreen')) return true;
            const roleButton = target.closest('[role="button"][aria-label="fullscreen"]');
            return Boolean(roleButton);
        };

        document.addEventListener(
            'click',
            (event) => {
                try {
                    if (!event || !event.isTrusted) return;
                    if (event.button !== 0) return;
                    if (!isFullscreenToggleTarget(event.target)) return;

                    const video = findMainVideoElement();
                    if (!video) return;
                    const container = findFullscreenContainer(video);
                    if (!container) return;

                    // Fullscreen the player container so site danmu and controls stay in the fullscreen tree.
                    if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        exitFullscreenSafe();
                        return;
                    }

                    container.setAttribute(FULLSCREEN_TARGET_ATTRIBUTE, '');
                    const ok = requestFullscreenSafe(container);
                    if (!ok) {
                        container.removeAttribute(FULLSCREEN_TARGET_ATTRIBUTE);
                        return;
                    }

                    event.preventDefault();
                    event.stopImmediatePropagation();
                } catch (e) {}
            },
            true
        );
    };

    const componentRegistry = new Map();
    const featureStatus = new Map();
    const findAngularComponent = (selector, matcher) => {
        const element = document.querySelector(selector);
        if (!element || !Array.isArray(element.__ngContext__)) { componentRegistry.delete(selector); return null; }
        const context = element.__ngContext__;
        const previous = componentRegistry.get(selector);
        if (previous?.element === element && context.includes(previous.component) && matcher(previous.component)) return previous.component;
        const component = context.find(matcher) || null;
        if (component) componentRegistry.set(selector, { element, component });
        else componentRegistry.delete(selector);
        return component;
    };

    const interstitialSchedulers = new WeakSet();
    const adNoticeTimes = new WeakMap();
    const notifyAdSkipped = (component) => {
        if (typeof component.filterAllAds !== 'function' || typeof component.api?.showInfo !== 'function') return;
        const nativeSource = Function.prototype.toString.call(component.filterAllAds);
        if (!nativeSource.includes('.boughtVideo') || !nativeSource.includes('.stopPlay()')) return;
        const now = Date.now();
        if (adNoticeTimes.has(component) && now - adNoticeTimes.get(component) < 8000) return;
        adNoticeTimes.set(component, now);
        // Reuse the site's own message, markup and duration via filterAllAds.
        // The real stopPlay is handled separately: calling it for a prevented ad
        // could restore an old movie position. No purchase callback is invoked.
        const receiver = Object.create(component, {
            pgmp: { value: { stopPlay() {} } },
            api: { value: new Proxy(component.api, { get(api, key) {
                if (key === 'showInfo') return (message, ...args) =>
                    api.showInfo(typeof message === 'string' ? message.replace('{0}', '0') : message, ...args);
                return Reflect.get(api, key, api);
            } }) }
        });
        component.filterAllAds.call(receiver);
    };
    const patchInterstitialAds = (component) => {
        const scheduler = component?.pgmp;
        // Identified pgmp interface from the site's interstitial state machine.
        // stopPlay emits ShouldBackToPlay, restoring the saved movie and position.
        if (!scheduler || typeof scheduler.startPlay !== 'function' ||
            typeof scheduler.stopPlay !== 'function' || typeof scheduler.needToShow !== 'function' ||
            typeof scheduler.invokeList !== 'function') return 'unsupported';
        if (!interstitialSchedulers.has(scheduler)) {
            scheduler.startPlay = function(ad) {
                if (ad) notifyAdSkipped(component);
            }; // Prevent subsequent ad countdowns, but acknowledge real skips.
            interstitialSchedulers.add(scheduler);
        }
        if (scheduler.isPlayingAds === true || component.isPlayingAds === true) {
            scheduler.stopPlay();
            notifyAdSkipped(component);
        }
        // Do not invoke skipAd/filterCallback: those paths can submit a coin payment.
    };

    const patchPlayerComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        patchServiceUser(component);
        if (component._user) component._user = patchUserState(component._user);
        patchInterstitialAds(component);

        if (!component.__yfsp_patched) {
            patchServiceUser(component);
            if (component._user) component._user = patchUserState(component._user);

            if (typeof component.changeBitrateIfPossible === 'function') {
                const originalChange = component.changeBitrateIfPossible;
                component.changeBitrateIfPossible = function() {
                    return originalChange.apply(this, arguments);
                };
            }

            component.__yfsp_patched = true;
        }

        const playerProto = Object.getPrototypeOf(component);

        if (playerProto && typeof playerProto.checkIfNeedToggle === 'function' && !playerProto.__yfsp_speed_patched) {
            playerProto.checkIfNeedToggle = function() {
                return true;
            };
            playerProto.__yfsp_speed_patched = true;
        }

        if (playerProto && typeof playerProto.checkIfNeedToggleCallback === 'function' && !playerProto.__yfsp_speed_cb_patched) {
            playerProto.checkIfNeedToggleCallback = function() {
                return true;
            };
            playerProto.__yfsp_speed_cb_patched = true;
        }

        [component.speedList, component.rateList, component.playbackRateList, component.playbackRates, component.speedOptions].forEach(unlockList);

        if (playerProto && !playerProto.__yfsp_speed_methods_patched) {
            Object.getOwnPropertyNames(playerProto).forEach((name) => {
                if (!['changePlaybackRate','setPlaybackRate','changeSpeed','selectSpeed','selectRate'].includes(name)) return;

                const fn = playerProto[name];
                if (typeof fn !== 'function') return;
                if (playerProto[`__yfsp_${name}_patched`]) return;

                playerProto[name] = function() {
                    try {
                        if (this._user) this._user = patchUserState(this._user);
                        patchServiceUser(this);
                        patchServiceUserState(this);
                    } catch (e) {}
                    return fn.apply(this, arguments);
                };

                playerProto[`__yfsp_${name}_patched`] = true;
            });
            playerProto.__yfsp_speed_methods_patched = true;
        }

        if (typeof component.checkIfNeedToggleCallback === 'function' && !component.__yfsp_callback_installed) {
            component.__yfsp_callback_installed = true;
            component.checkIfNeedToggleCallback = function() {
                return true;
            };
        }

        // The player clears isSwitching when decoding changes. A timer must not
        // clear it merely because unrelated loading flags happen to be absent.
    };

    const syncQualityUser = (component) => {
        const service = compatibilityServiceSources.get(component._userService) || component._userService;
        const user = service && 'user' in service ? service.user : component._user;
        const real = compatibilitySources.get(user) || user;
        const loggedIn = Number(real?.id) > 0;
        component._user = loggedIn ? real : patchUserState(real);
        return loggedIn;
    };

    const patchQualitySelectorComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        syncQualityUser(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.selectBitrate !== 'function' || proto.__yfsp_select_patched) return;

        const originalSelect = proto.selectBitrate;
        const hasClientOnlyGate = Function.prototype.toString.call(originalSelect).includes('4k-ask-app-download-dialog');
        proto.selectBitrate = function(item) {
            // Resolve the real account every click, including login/logout while
            // this component is alive. A UI compatibility role is not ownership.
            const loggedIn = syncQualityUser(this);
            if (!loggedIn && item && this.bitrateSelected?.key !== item.key) {
                const player = findAngularComponent('aa-videoplayer',
                    entry => entry && typeof entry.onSelectBitrate === 'function');
                const route = resolveStandardQualityRoute(item, player, getVideoHls(findMainVideoElement()));
                if (route.kind === 'pending') {
                    showPlaybackNotice('正在读取播放列表，已保留原画质，请稍后重试。');
                    return;
                }
                if (route.kind === 'delegate' && !hasPlayablePath(item)) {
                    showPlaybackNotice('暂时无法确认此清晰度对应的播放地址，已保留原画质。可稍后重试或选择其他清晰度。');
                    return;
                }
                if (route.kind !== 'master' && route.kind !== 'source' && !hasPlayablePath(item)) {
                    showPlaybackNotice('当前清晰度没有可用的播放地址，已保留原画质。可尝试其他清晰度，或登录后重试。');
                    return;
                }
                if (route.kind === 'master') item.qualityIndex = route.index;
            }
            if (readPreference('yfsp.playbackOnly', false) && Number(item?.bitrate) > 1080) {
                return originalSelect.call(this, item);
            }
            if (hasClientOnlyGate && Number(item?.bitrate) <= 1080) {
                const needsAccountFlow = item.isVIP && (!this._user?.id ||
                    (!item.isBought && this._user?.roleId === 0));
                if (!needsAccountFlow && this.bitrateSelected?.key !== item.key) {
                    const player = findAngularComponent('aa-videoplayer',
                        entry => entry && typeof entry.onSelectBitrate === 'function');
                    const route = resolveStandardQualityRoute(item, player, getVideoHls(findMainVideoElement()));
                    if (route.kind === 'pending') {
                        showPlaybackNotice('正在读取播放列表，已保留原画质，请稍后重试。');
                        return;
                    }
                    if (route.kind === 'unavailable') {
                        showPlaybackNotice('当前播放列表没有此画质的层级，也未返回独立源；保留正在播放的画质。');
                        return;
                    }
                    if (route.kind === 'master') item.qualityIndex = route.index;
                    if (this._utility && Number.isFinite(this.API?.currentTime)) {
                        this._utility.preLoadPlaySecond = this.API.currentTime;
                    }
                }
                return originalSelect.call(this, item);
            }
            // Null paths may trigger login, purchase or manifest-level selection.
            // Only adapt the known desktop-only gate; delegate other choices intact.
            if (hasClientOnlyGate && Number(item?.bitrate) > 1080 &&
                typeof this?.onBitrateChange?.emit === 'function') {
                if (item.key != null && this.bitrateSelected?.key === item.key) return;
                if (item.isVIP && !this._user?.id) {
                    if (typeof this._userService?.showLoginDialog !== 'function') return originalSelect.call(this, item);
                    if (this.fsAPI?.isFullscreen) this.fsAPI.toggleFullscreen();
                    return this._userService.showLoginDialog(true);
                }
                if (item.isVIP && !item.isBought && this._user && this._user.roleId === 0) {
                    if (typeof this._purchaseRequiredDialogService?.setState !== 'function' ||
                        typeof this._dnDialogService?.open !== 'function') return originalSelect.call(this, item);
                    if (this.fsAPI?.isFullscreen) this.fsAPI.toggleFullscreen();
                    this._purchaseRequiredDialogService.setState({
                        price: this.gold, mediaId: item.key, isShortDrama: this.isShortDrama
                    });
                    return this._dnDialogService.open('purchase-required', {
                        'purchase-required-price': this.gold, 'media-id': item.key,
                        isLive: this.isLive, isShortDrama: this.isShortDrama
                    });
                }
                if (!hasPlayablePath(item)) {
                    showPlaybackNotice('当前未返回此画质的独立源；保留正在播放的画质。');
                    return;
                }
                // Keep the actual source/key and the normal player event chain.
                // This removes only the desktop-app prompt, not server checks.
                if (this._utility && Number.isFinite(this.API?.currentTime)) {
                    this._utility.preLoadPlaySecond = this.API.currentTime;
                }
                this.bitrateSelected = item;
                this.onBitrateChange.emit(item);
                this.isActive = this.isOpen = false;
                this.openList?.unsubscribe?.();
                this.hiddenApi?.releaseControls?.();
                showPlaybackNotice('已请求切换高清源；实际画质以视频分辨率为准。');
                return;
            }
            return originalSelect.call(this, item);
        };

        proto.__yfsp_select_patched = true;
        console.log('[YFSP Unlocker] Angular component patched: selectBitrate hooked');
    };

    const patchDanmuComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        component.user = patchUserState(component.user);
        patchServiceUser(component);

        [component.typeList, component.colorList, component.styleList, component.fontList, component.speedList].forEach(unlockList);
        if ('includeAvatarVip' in component) component.includeAvatarVip = false;
        if ('includeLocationVip' in component) component.includeLocationVip = false;
        if ('includeAvatarLock' in component) component.includeAvatarLock = false;
        if ('includeLocationLock' in component) component.includeLocationLock = false;
        if ('avatarVipFunction' in component) component.avatarVipFunction = false;
        if ('locationVipFunction' in component) component.locationVipFunction = false;

        if (component.danmuFacade && typeof component.danmuFacade === 'object' && !component.danmuFacade.__yfsp_patched) {
            if (typeof component.danmuFacade.updateUserSettings === 'function') {
                const originalUpdate = component.danmuFacade.updateUserSettings;
                component.danmuFacade.updateUserSettings = function() {
                    try {
                        if (component.user) component.user = patchUserState(component.user);
                        patchServiceUser(component);
                    } catch (e) {}
                    return originalUpdate.apply(this, arguments);
                };
            }
            component.danmuFacade.__yfsp_patched = true;
        }

        const proto = Object.getPrototypeOf(component);
        if (!proto) return;

        if (typeof proto.selectColor === 'function' && !proto.__yfsp_danmu_color_patched) {
            const originalSelectColor = proto.selectColor;
            proto.selectColor = function(item) {
                try {
                    this.user = patchUserState(this.user);
                    patchServiceUser(this);

                    if (item && typeof item === 'object' && this.danmuFacade && typeof this.danmuFacade.setOutputColor === 'function') {
                        this.danmuFacade.setOutputColor(item.value);
                        this.currentColor = item.value;
                        if (typeof this.onFontChanged === 'function') this.onFontChanged();
                        return;
                    }
                } catch (e) {}
                return originalSelectColor.call(this, item);
            };
            proto.__yfsp_danmu_color_patched = true;
        }

        if (typeof proto.selectType === 'function' && !proto.__yfsp_danmu_type_patched) {
            const originalSelectType = proto.selectType;
            proto.selectType = function(item) {
                try {
                    this.user = patchUserState(this.user);
                    patchServiceUser(this);
                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;

                    if (item && typeof item === 'object' && this.danmuFacade && typeof this.danmuFacade.setOutputType === 'function') {
                        this.danmuFacade.setOutputType(item.value);
                        this.currentType = item.value;
                        if (typeof this.onFontChanged === 'function') this.onFontChanged();
                        return;
                    }
                } catch (e) {}
                return originalSelectType.call(this, item);
            };
            proto.__yfsp_danmu_type_patched = true;
        }

        if (typeof proto.toggleIncludeAvatar === 'function' && !proto.__yfsp_danmu_avatar_patched) {
            const originalToggleAvatar = proto.toggleIncludeAvatar;
            proto.toggleIncludeAvatar = function() {
                try {
                    this.user = patchUserState(this.user);
                    patchServiceUser(this);
                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;
                    this.includeAvatar = !this.includeAvatar;
                    if (this.danmuFacade && typeof this.danmuFacade.updateUserSettings === 'function') {
                        this.danmuFacade.updateUserSettings({
                            includeAvatar: this.includeAvatar,
                            includeLocation: this.includeLocation
                        });
                        return;
                    }
                } catch (e) {}
                return originalToggleAvatar.call(this);
            };
            proto.__yfsp_danmu_avatar_patched = true;
        }

        if (typeof proto.toggleIncludeLocation === 'function' && !proto.__yfsp_danmu_location_patched) {
            const originalToggleLocation = proto.toggleIncludeLocation;
            proto.toggleIncludeLocation = function() {
                try {
                    this.user = patchUserState(this.user);
                    patchServiceUser(this);
                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;
                    this.includeLocation = !this.includeLocation;
                    if (this.danmuFacade && typeof this.danmuFacade.updateUserSettings === 'function') {
                        this.danmuFacade.updateUserSettings({
                            includeAvatar: this.includeAvatar,
                            includeLocation: this.includeLocation
                        });
                        return;
                    }
                } catch (e) {}
                return originalToggleLocation.call(this);
            };
            proto.__yfsp_danmu_location_patched = true;
        }
    };

    const patchCommentComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        component.user = patchUserState(component.user);
        patchServiceUser(component);
        patchServiceUserState(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.openVotingCreatorDialog !== 'function' || proto.__yfsp_vote_patched) return;

        const originalOpenVote = proto.openVotingCreatorDialog;
        proto.openVotingCreatorDialog = function() {
            try {
                if (this.user) this.user = patchUserState(this.user);
                patchServiceUser(this);
                this.showVotingCreator = true;
                return;
            } catch (e) {}
            return originalOpenVote.call(this);
        };

        proto.__yfsp_vote_patched = true;
    };

    const patchEmojiComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        component.user = patchUserState(component.user);
        patchServiceUser(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.canNotUseVipEmoj !== 'function' || proto.__yfsp_vip_emoji_patched) return;

        proto.canNotUseVipEmoj = function() {
            return false;
        };
        proto.__yfsp_vip_emoji_patched = true;
    };

    const runFeature = (name, work) => {
        try {
            const result = work();
            featureStatus.set(name, result === false ? 'waiting' : result === 'unsupported' ? 'unsupported' : 'installed');
        }
        catch { featureStatus.set(name, 'failed'); }
    };
    const hookAngular = () => {
        const install = (name, selector, matcher, patch) => runFeature(name, () => {
            const component = findAngularComponent(selector, matcher);
            if (!component) return false;
            return patch(component);
        });
        install('ads', 'aa-videoplayer', entry => entry?.pgmp, patchInterstitialAds);
        install('quality', 'vg-quality-selector', entry => typeof entry?.selectBitrate === 'function', patchQualitySelectorComponent);
        if (readPreference('yfsp.playbackOnly', false)) return;
        install('player', 'aa-videoplayer', entry => entry?.playerMediaListService, patchPlayerComponent);
        install('danmu', 'app-danmu-input', entry => entry?.typeList && entry.colorList && entry.danmuFacade, patchDanmuComponent);
        install('comment', 'app-comment-box', entry => entry?._commentService && entry._emojiPickerService, patchCommentComponent);
        install('emoji', '.emoji-box', entry => entry?._permission && entry.emojiSets, patchEmojiComponent);
    };
    const refreshDynamicFeatures = () => {
        runFeature('style', () => { ensureStyle(); hideAds(); });
        hookAngular();
        runFeature('check-in', autoCheckIn);
        runFeature('playback-status', updatePlaybackExperience);
    };
    const bootstrap = () => {
        for (const root of new Set([window, typeof unsafeWindow !== 'undefined' ? unsafeWindow : window])) {
            hookFetch(root); hookXhr(root); applyGlobals(root);
        }
        observeDom(); installClickToggle(); installFullscreenControlReveal(); installContainerFullscreenHijack();
        refreshDynamicFeatures();
    };
    let bootstrapTimer = null;
    const startRuntime = () => {
        bootstrap();
        if (bootstrapTimer === null) bootstrapTimer = setInterval(refreshDynamicFeatures, BOOTSTRAP_INTERVAL_MS);
    };
    const stopRuntime = () => {
        clearInterval(bootstrapTimer); clearTimeout(refreshTimer);
        bootstrapTimer = refreshTimer = null;
        window.__yfsp_observer?.disconnect(); window.__yfsp_observer = null;
        componentRegistry.clear(); restoreBufferConfig();
    };



    installClientIdentity();
    installPlaybackMenus();
    startRuntime();
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    window.addEventListener('pagehide', stopRuntime);
    window.addEventListener('pageshow', startRuntime);
})();
