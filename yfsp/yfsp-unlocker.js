// ==UserScript==
// @name         YFSP.TV Unlocker
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Unlocks quality UI, danmu styles (color/type/font/avatar/location), and playback speed UI. Adds click-to-toggle play/pause. Improves NVIDIA RTX VSR compatibility by removing transparent overlay layers, and (optionally) forcing fullscreen on the <video> element so the driver can detect a clean video plane.
// @author       YFSP Analyst
// @match        *://*.yfsp.tv/*
// @match        *://*.yifan.tv/*
// @match        *://*.iyf.tv/*
// @match        *://*.aiyifan.tv/*
// @match        *://*.dudupro.com/*
// @run-at       document-start
// @grant        unsafeWindow
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
    const VSR_FULLSCREEN_CLASS = 'yfsp-vsr-fullscreen';
    const FORCE_NATIVE_VIDEO_FULLSCREEN = true;

    const MATCH_USER = [/\/api\/payment\/getPaymentInfo/i, /\/api\/user\/info/i];
    const MATCH_PLAY = [/\/v3\/video\/play/i, /\/v3\/video\/detail/i];
    const STYLE_ID = 'yfsp-unlocker-style';

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

    const safeToInt = (value) => {
        if (typeof value === 'number') return value;
        const number = parseInt(String(value), 10);
        return Number.isFinite(number) ? number : 0;
    };

    const patchUserState = (user) => {
        if (!user || typeof user !== 'object') return;

        if (user.id == null) user.id = DEFAULT_USER_ID;
        if (user.roleId == null || user.roleId < 0) user.roleId = DEFAULT_ROLE_ID;
        if (user.level == null || user.level < MIN_LEVEL) user.level = MIN_LEVEL;
        if ('isVip' in user) user.isVip = true;
        if ('vipLevel' in user) user.vipLevel = VIP_LEVEL;
    };

    const patchServiceUser = (target) => {
        if (!target || typeof target !== 'object') return;
        if (target._userService && target._userService.user) patchUserState(target._userService.user);
    };

    const patchServiceUserState = (target) => {
        if (!target || typeof target !== 'object') return;
        if (target._userService && target._userService.userState && target._userService.userState._value) {
            patchUserState(target._userService.userState._value);
        }
    };

    const unlockItemFlags = (item) => {
        if (!item || typeof item !== 'object') return;
        item.isVIP = false;
        item.isBought = true;
        item.isEnabled = true;
        if ('isNav' in item) item.isNav = true;
        if ('isLocked' in item) item.isLocked = false;
        if ('lock' in item) item.lock = false;
    };

    const patchUser = (json) => {
        if (!json || !json.data) return json;

        json.data.isVip = true;
        json.data.vipLevel = VIP_LEVEL;
        patchUserState(json.data);

        if (json.data.user && typeof json.data.user === 'object') {
            patchUserState(json.data.user);
        }

        if (Array.isArray(json.data.info)) {
            json.data.info.forEach((info) => {
                if (!info || typeof info !== 'object') return;
                info.isVip = true;
                info.vipLevel = VIP_LEVEL;
                if ('isVip' in info || 'vipLevel' in info || 'id' in info || 'roleId' in info || 'level' in info) {
                    patchUserState(info);
                }
            });
        }

        return json;
    };

    const patchPlay = (json) => {
        if (!json?.data?.info || !Array.isArray(json.data.info)) return json;

        json.data.info.forEach((info) => {
            if (!info || !Array.isArray(info.clarity)) return;

            let best = null;
            info.clarity.forEach((clarity) => {
                if (!clarity || !clarity.path) return;
                if (!best) {
                    best = clarity;
                    return;
                }

                const currentScore = [safeToInt(clarity.qualityIndex), safeToInt(clarity.bitrate), safeToInt(clarity.title)];
                const bestScore = [safeToInt(best.qualityIndex), safeToInt(best.bitrate), safeToInt(best.title)];

                if (
                    currentScore[0] > bestScore[0] ||
                    (currentScore[0] === bestScore[0] &&
                        (currentScore[1] > bestScore[1] ||
                            (currentScore[1] === bestScore[1] && currentScore[2] > bestScore[2])))
                ) {
                    best = clarity;
                }
            });

            info.clarity.forEach((clarity) => {
                if (!clarity) return;

                clarity.isBought = true;
                clarity.isVIP = false;
                clarity.isEnabled = true;
                if (best && !clarity.path && best.path) clarity.path = best.path;
                if (best && best.key && !clarity.key) clarity.key = best.key;
            });
        });

        return json;
    };

    const patchBitrates = (bitrates) => {
        if (!Array.isArray(bitrates)) return false;

        let changed = false;
        bitrates.forEach((bitrate) => {
            if (!bitrate || typeof bitrate !== 'object') return;

            if (bitrate.isVIP === true || bitrate.isBought === false || bitrate.isEnabled === false) {
                bitrate.isVIP = false;
                bitrate.isBought = true;
                bitrate.isEnabled = true;
                changed = true;
            }

            if ('isNav' in bitrate) bitrate.isNav = true;
            if ('isLocked' in bitrate) bitrate.isLocked = false;
            if ('lock' in bitrate) bitrate.lock = false;
        });

        return changed;
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

    const safeJson = async (response) => {
        try {
            const clone = response.clone();
            return await clone.json();
        } catch (e) {
            return null;
        }
    };

    const rebuildJsonResponse = (response, payload) =>
        new Response(JSON.stringify(payload), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

    const hookFetch = (root) => {
        if (!root || root.__yfsp_fetch_hooked) return;

        const originalFetch = root.fetch;
        if (typeof originalFetch !== 'function') return;

        root.fetch = async function(...args) {
            const requestUrl = normalizeUrl(args[0]);

            if (shouldMatch(requestUrl, MATCH_USER)) {
                const response = await originalFetch.apply(this, args);
                const json = patchUser(await safeJson(response));
                return json ? rebuildJsonResponse(response, json) : response;
            }

            if (shouldMatch(requestUrl, MATCH_PLAY)) {
                const response = await originalFetch.apply(this, args);
                const json = patchPlay(await safeJson(response));
                return json ? rebuildJsonResponse(response, json) : response;
            }

            return originalFetch.apply(this, args);
        };

        root.__yfsp_fetch_hooked = true;
    };

    const hookXhr = (root) => {
        if (!root || root.__yfsp_xhr_hooked) return;

        const proto = root.XMLHttpRequest && root.XMLHttpRequest.prototype;
        if (!proto || proto.__yfsp_patched) return;

        const originalOpen = proto.open;
        const originalSend = proto.send;

        proto.open = function(method, url, ...rest) {
            this.__yfsp_url = normalizeUrl(url);
            return originalOpen.call(this, method, url, ...rest);
        };

        proto.send = function(...sendArgs) {
            const listener = () => {
                if (this.readyState !== 4) return;
                this.removeEventListener('readystatechange', listener);

                const requestUrl = this.__yfsp_url || '';
                if (!requestUrl) return;
                if (!(shouldMatch(requestUrl, MATCH_USER) || shouldMatch(requestUrl, MATCH_PLAY))) return;
                if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json' && this.responseType !== '') return;

                let json = null;
                if (this.responseType === 'json') {
                    if (this.response && typeof this.response === 'object') json = this.response;
                } else {
                    const text = this.responseText;
                    if (!text || text[0] !== '{') return;
                    try {
                        json = JSON.parse(text);
                    } catch (e) {
                        return;
                    }
                }

                json = shouldMatch(requestUrl, MATCH_USER) ? patchUser(json) : patchPlay(json);
                const jsonText = JSON.stringify(json);

                try {
                    Object.defineProperty(this, 'responseText', { configurable: true, get: () => jsonText });
                } catch (e) {}

                try {
                    Object.defineProperty(this, 'response', {
                        configurable: true,
                        get: () => (this.responseType === 'json' ? json : jsonText)
                    });
                } catch (e) {}
            };

            this.addEventListener('readystatechange', listener);
            return originalSend.apply(this, sendArgs);
        };

        proto.__yfsp_patched = true;
        root.__yfsp_xhr_hooked = true;
    };

    const ensureStyle = () => {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            'iframe[src*="google"] { display: none !important; }',
            'iframe[src*="doubleclick"] { display: none !important; }',
            '.ad, .ads, [id*="ad_"], [class*="ad-"] { display: none !important; }',
            '.use-coin-box { display: none !important; }',
            '#coin-or-upgrade-to-skip-ad { display: none !important; }',
            '.dn-dialog-background { display: none !important; }',
            '#dn_iframe { display: none !important; }',
            'vg-quality-selector .vip-label { display: none !important; }',
            '.quality-btn { opacity: 1 !important; pointer-events: auto !important; }',
            // Desktop player UX + NVIDIA RTX VSR compatibility:
            // The site keeps a transparent overlay above <video>, which blocks click-to-pause and may prevent GPU overlay promotion.
            // Only apply on pointer:fine so touch UIs can keep their tap overlays if needed.
            '@media (pointer: fine) {',
            '  aa-videoplayer .vg-overlay-play { display: none !important; }',
            '  aa-videoplayer vg-controls.hide { display: none !important; }',
            '  aa-videoplayer vg-scrub-bar.hide { display: none !important; }',
            '  aa-videoplayer .overlay-logo.hide { display: none !important; }',
            `  .${VSR_FULLSCREEN_CLASS} aa-videoplayer vg-overlay-danmu { display: none !important; }`,
            `  .${VSR_FULLSCREEN_CLASS} aa-videoplayer vg-overlay-subtitle { display: none !important; }`,
            '}'
        ].join('\n');

        (document.head || document.documentElement).appendChild(style);
    };

    const applyGlobals = (root) => {
        try {
            Object.defineProperty(root, 'isVip', { get: () => true, configurable: true });
            Object.defineProperty(root, 'isAdsBlocked', { get: () => false, configurable: true });
            if (root.User && typeof root.User === 'object') root.User.isVip = true;
        } catch (e) {}
    };

    const hideAds = () => {
        const dialog = document.getElementById('coin-or-upgrade-to-skip-ad');
        if (dialog) dialog.style.display = 'none';

        const dnIframe = document.getElementById('dn_iframe');
        if (dnIframe) dnIframe.style.display = 'none';

        const dialogs = document.querySelectorAll('dn-dialog, .dn-dialog-background');
        dialogs.forEach((el) => {
            el.style.display = 'none';
        });
    };

    const observeDom = () => {
        if (window.__yfsp_observer) return;

        const observer = new MutationObserver(() => {
            ensureStyle();
            hideAds();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__yfsp_observer = observer;
    };

    const installFullscreenClassObserver = () => {
        if (window.__yfsp_fullscreen_observer_installed) return;
        window.__yfsp_fullscreen_observer_installed = true;

        const update = () => {
            try {
                const isFullscreen = Boolean(
                    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement
                );
                if (!document.documentElement) return;
                document.documentElement.classList.toggle(VSR_FULLSCREEN_CLASS, isFullscreen);
            } catch (e) {}
        };

        ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach((eventName) => {
            document.addEventListener(eventName, update, true);
        });

        update();
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
                    if (!event.target.closest('aa-videoplayer, vg-player#main-player, .video-container')) return;
                    if (shouldIgnoreToggleClickTarget(event.target)) return;

                    // Suppress click-to-toggle when the user double clicks (e.g., fullscreen), matching typical players.
                    if (event.detail && event.detail > 1) {
                        cancelPendingToggle();
                        return;
                    }

                    cancelPendingToggle();
                    timer = setTimeout(() => {
                        timer = null;
                        const video = findMainVideoElement();
                        if (!video) return;

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

    const installNativeFullscreenHijack = () => {
        if (!FORCE_NATIVE_VIDEO_FULLSCREEN) return;
        if (window.__yfsp_native_fullscreen_installed) return;
        window.__yfsp_native_fullscreen_installed = true;

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

                    // Toggle fullscreen on the <video> element itself to minimize DOM overlays and help driver-side VSR detection.
                    if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
                        event.preventDefault();
                        event.stopImmediatePropagation();
                        exitFullscreenSafe();
                        return;
                    }

                    const ok = requestFullscreenSafe(video);
                    if (!ok) return;

                    event.preventDefault();
                    event.stopImmediatePropagation();
                } catch (e) {}
            },
            true
        );
    };

    const findAngularComponent = (selector, matcher) => {
        const element = document.querySelector(selector);
        if (!element || !element.__ngContext__) return null;

        const context = element.__ngContext__;
        if (!Array.isArray(context)) return null;

        return context.find(matcher) || null;
    };

    const patchPlayerComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        if (!component.__yfsp_patched) {
            patchServiceUser(component);
            if (component._user) patchUserState(component._user);

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
                if (!/speed|rate/i.test(name)) return;

                const fn = playerProto[name];
                if (typeof fn !== 'function') return;
                if (playerProto[`__yfsp_${name}_patched`]) return;

                playerProto[name] = function() {
                    try {
                        if (this._user) patchUserState(this._user);
                        patchServiceUser(this);
                        patchServiceUserState(this);
                    } catch (e) {}
                    return fn.apply(this, arguments);
                };

                playerProto[`__yfsp_${name}_patched`] = true;
            });
            playerProto.__yfsp_speed_methods_patched = true;
        }

        if (typeof component.checkIfNeedToggleCallback === 'function') {
            component.checkIfNeedToggleCallback = function() {
                return true;
            };
        }

        if (
            component.isSwitching === true &&
            component.switching !== true &&
            component.isChanging !== true &&
            component.changeBitrateLoading !== true &&
            component.isLoading !== true &&
            component.loading !== true
        ) {
            component.isSwitching = false;
        }
    };

    const patchQualitySelectorComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        const changed = patchBitrates(component.bitrates);
        if (changed) {
            console.log('[YFSP Unlocker] Angular component patched: bitrates unlocked');
        }

        if (!component._user || typeof component._user !== 'object') {
            component._user = { id: DEFAULT_USER_ID, roleId: DEFAULT_ROLE_ID };
        } else {
            if (component._user.id == null) component._user.id = DEFAULT_USER_ID;
            if (component._user.roleId == null || component._user.roleId < 0) component._user.roleId = DEFAULT_ROLE_ID;
        }

        patchUserState(component._user);
        if ('isVip' in component) component.isVip = true;
        if ('hasVIP' in component) component.hasVIP = true;
        if ('vipLevel' in component) component.vipLevel = VIP_LEVEL;
        patchServiceUser(component);
        patchServiceUserState(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.selectBitrate !== 'function' || proto.__yfsp_select_patched) return;

        const originalSelect = proto.selectBitrate;
        proto.selectBitrate = function(item) {
            try {
                if (item && typeof item === 'object') unlockItemFlags(item);

                if (this && this._user) patchUserState(this._user);
                if (this) {
                    patchServiceUser(this);
                    patchServiceUserState(this);
                }

                if (item && item.path === null) {
                    console.log('[YFSP Unlocker] 1080P/720P path is null (server-side restriction). Cannot switch.');
                    if (this.bitrates) {
                        const fallback = this.bitrates.find(
                            (bitrate) => bitrate.bitrate === 576 || bitrate.label === '576P' || bitrate.qualityIndex === 0
                        );
                        if (fallback && fallback.path) {
                            console.log('[YFSP Unlocker] Spoofing 1080P with 576P source to bypass null path');
                            item.path = fallback.path;
                        }
                    }
                }
            } catch (e) {}
            return originalSelect.call(this, item);
        };

        proto.__yfsp_select_patched = true;
        console.log('[YFSP Unlocker] Angular component patched: selectBitrate hooked');
    };

    const patchDanmuComponent = (component) => {
        if (!component || typeof component !== 'object') return;

        patchUserState(component.user);
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
                        if (component.user) patchUserState(component.user);
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
                    patchUserState(this.user);
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
                    patchUserState(this.user);
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
                    patchUserState(this.user);
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
                    patchUserState(this.user);
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

        patchUserState(component.user);
        patchServiceUser(component);
        patchServiceUserState(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.openVotingCreatorDialog !== 'function' || proto.__yfsp_vote_patched) return;

        const originalOpenVote = proto.openVotingCreatorDialog;
        proto.openVotingCreatorDialog = function() {
            try {
                if (this.user) patchUserState(this.user);
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

        patchUserState(component.user);
        patchServiceUser(component);

        const proto = Object.getPrototypeOf(component);
        if (!proto || typeof proto.canNotUseVipEmoj !== 'function' || proto.__yfsp_vip_emoji_patched) return;

        proto.canNotUseVipEmoj = function() {
            return false;
        };
        proto.__yfsp_vip_emoji_patched = true;
    };

    const hookAngular = () => {
        try {
            const playerComponent = findAngularComponent(
                'aa-videoplayer',
                (entry) => entry && typeof entry === 'object' && entry.playerMediaListService
            );
            if (playerComponent) patchPlayerComponent(playerComponent);

            const qualityComponent = findAngularComponent(
                'vg-quality-selector',
                (entry) => entry && typeof entry === 'object' && entry.bitrates && entry.bitrateSelected
            );
            if (!qualityComponent) return;
            patchQualitySelectorComponent(qualityComponent);

            const danmuComponent = findAngularComponent(
                'app-danmu-input',
                (entry) => entry && typeof entry === 'object' && entry.typeList && entry.colorList && entry.danmuFacade
            );
            if (danmuComponent) patchDanmuComponent(danmuComponent);

            const commentComponent = findAngularComponent(
                'app-comment-box',
                (entry) => entry && typeof entry === 'object' && entry._commentService && entry._emojiPickerService
            );
            if (commentComponent) patchCommentComponent(commentComponent);

            const emojiComponent = findAngularComponent(
                '.emoji-box',
                (entry) => entry && typeof entry === 'object' && entry._permission && entry.emojiSets
            );
            if (emojiComponent) patchEmojiComponent(emojiComponent);
        } catch (e) {
            console.log('[YFSP Unlocker] Angular hook error:', e);
        }
    };

    const bootstrap = () => {
        hookFetch(window);
        hookXhr(window);

        if (typeof unsafeWindow !== 'undefined') {
            hookFetch(unsafeWindow);
            hookXhr(unsafeWindow);
            applyGlobals(unsafeWindow);
        }

        applyGlobals(window);
        ensureStyle();
        hideAds();
        observeDom();
        installFullscreenClassObserver();
        installClickToggle();
        installNativeFullscreenHijack();
        hookAngular();
    };

    bootstrap();
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    setInterval(bootstrap, BOOTSTRAP_INTERVAL_MS);
})();
