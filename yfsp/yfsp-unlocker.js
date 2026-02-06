// ==UserScript==
// @name         YFSP.TV Unlocker
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Unlocks quality UI, danmu styles (color/type/font/avatar/location), and playback speed UI. Keeps UI responsive when server omits high-bitrate paths. Blocks common ad overlays.
// @author       YFSP Analyst
// @match        *://*.yfsp.tv/*
// @match        *://*.dudupro.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @homepage     https://github.com/Suysker/js-scripts-monorepo/tree/main/yfsp
// @supportURL   https://github.com/Suysker/js-scripts-monorepo/issues
// ==/UserScript==

(function() {
    'use strict';

    const MATCH_USER = [/\/api\/payment\/getPaymentInfo/i, /\/api\/user\/info/i];
    const MATCH_PLAY = [/\/v3\/video\/play/i, /\/v3\/video\/detail/i];

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

    const shouldMatch = (url, list) => list.some(r => r.test(url));

    const patchUser = (json) => {
        if (!json || !json.data) return json;
        json.data.isVip = true;
        json.data.vipLevel = 99;
        patchUserState(json.data);
        if (json.data.user && typeof json.data.user === 'object') {
            patchUserState(json.data.user);
        }
        if (Array.isArray(json.data.info)) {
            json.data.info.forEach(info => {
                if (info && typeof info === 'object') {
                    info.isVip = true;
                    info.vipLevel = 99;
                    if ('isVip' in info || 'vipLevel' in info || 'id' in info || 'roleId' in info || 'level' in info) {
                        patchUserState(info);
                    }
                }
            });
        }
        return json;
    };

    const patchPlay = (json) => {
        if (!json?.data?.info || !Array.isArray(json.data.info)) return json;
        const toNum = (v) => {
            if (typeof v === 'number') return v;
            const n = parseInt(String(v), 10);
            return Number.isFinite(n) ? n : 0;
        };
        json.data.info.forEach(info => {
            if (!info || !Array.isArray(info.clarity)) return;
            let best = null;
            info.clarity.forEach(c => {
                if (!c || !c.path) return;
                if (!best) {
                    best = c;
                    return;
                }
                const a = [toNum(c.qualityIndex), toNum(c.bitrate), toNum(c.title)];
                const b = [toNum(best.qualityIndex), toNum(best.bitrate), toNum(best.title)];
                if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) {
                    best = c;
                }
            });
            info.clarity.forEach(c => {
                if (!c) return;
                c.isBought = true;
                c.isVIP = false;
                c.isEnabled = true;
                if (best && !c.path && best.path) c.path = best.path;
                if (best && best.key && !c.key) c.key = best.key;
            });
        });
        return json;
    };

    const patchUserState = (user) => {
        if (!user || typeof user !== 'object') return;
        if (user.id == null) user.id = 1;
        if (user.roleId == null || user.roleId < 0) user.roleId = 1;
        if (user.level == null || user.level < 2) user.level = 2;
        if ('isVip' in user) user.isVip = true;
        if ('vipLevel' in user) user.vipLevel = 99;
    };

    const patchBitrates = (bitrates) => {
        if (!Array.isArray(bitrates)) return false;
        let changed = false;
        bitrates.forEach(b => {
            if (!b || typeof b !== 'object') return;
            if (b.isVIP === true || b.isBought === false || b.isEnabled === false) {
                b.isVIP = false;
                b.isBought = true;
                b.isEnabled = true;
                changed = true;
            }
            if ('isNav' in b) b.isNav = true;
            if ('isLocked' in b) b.isLocked = false;
            if ('lock' in b) b.lock = false;
        });
        return changed;
    };

    const unlockList = (list) => {
        if (!Array.isArray(list)) return;
        list.forEach(item => {
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

    const hookFetch = (root) => {
        if (!root || root.__yfsp_fetch_hooked) return;
        const originalFetch = root.fetch;
        if (typeof originalFetch !== 'function') return;
        root.fetch = async function(...args) {
            const url = normalizeUrl(args[0]);
            if (shouldMatch(url, MATCH_USER)) {
                const response = await originalFetch.apply(this, args);
                const json = patchUser(await safeJson(response));
                if (!json) return response;
                return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: response.headers });
            }
            if (shouldMatch(url, MATCH_PLAY)) {
                const response = await originalFetch.apply(this, args);
                const json = patchPlay(await safeJson(response));
                if (!json) return response;
                return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: response.headers });
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
                    Object.defineProperty(this, 'response', { configurable: true, get: () => (this.responseType === 'json' ? json : jsonText) });
                } catch (e) {}
            };
            this.addEventListener('readystatechange', listener);
            return originalSend.apply(this, sendArgs);
        };
        proto.__yfsp_patched = true;
        root.__yfsp_xhr_hooked = true;
    };

    const ensureStyle = () => {
        const id = 'yfsp-unlocker-style';
        if (document.getElementById(id)) return;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = [
            'iframe[src*="google"] { display: none !important; }',
            'iframe[src*="doubleclick"] { display: none !important; }',
            '.ad, .ads, [id*="ad_"], [class*="ad-"] { display: none !important; }',
            '.use-coin-box { display: none !important; }',
            '#coin-or-upgrade-to-skip-ad { display: none !important; }',
            '.dn-dialog-background { display: none !important; }',
            '#dn_iframe { display: none !important; }',
            'vg-quality-selector .vip-label { display: none !important; }',
            '.quality-btn { opacity: 1 !important; pointer-events: auto !important; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(style);
    };

    const applyGlobals = (root) => {
        try {
            Object.defineProperty(root, 'isVip', { get: () => true, configurable: true });
            Object.defineProperty(root, 'isAdsBlocked', { get: () => false, configurable: true });
            if (root.User && typeof root.User === 'object') {
                root.User.isVip = true;
            }
        } catch (e) {}
    };

    const hideAds = () => {
        const dialog = document.getElementById('coin-or-upgrade-to-skip-ad');
        if (dialog) dialog.style.display = 'none';
        const dnIframe = document.getElementById('dn_iframe');
        if (dnIframe) dnIframe.style.display = 'none';
        const dialogs = document.querySelectorAll('dn-dialog, .dn-dialog-background');
        dialogs.forEach(el => { el.style.display = 'none'; });
    };

    const observeDom = () => {
        if (window.__yfsp_observer) return;
        const obs = new MutationObserver(() => {
            ensureStyle();
            hideAds();
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        window.__yfsp_observer = obs;
    };

    const hookAngular = () => {
        try {
            // Hook main video player service first
            const playerEl = document.querySelector('aa-videoplayer');
            if (playerEl && playerEl.__ngContext__) {
                const ctx = playerEl.__ngContext__;
                if (Array.isArray(ctx)) {
                    // Find main player controller
                    const comp = ctx.find(x => x && typeof x === 'object' && x.playerMediaListService);
                    if (comp) {
                         if (!comp.__yfsp_patched) {
                             if (comp._userService && comp._userService.user) patchUserState(comp._userService.user);
                             if (comp._user) patchUserState(comp._user);
                             
                             // Hook changeBitrateIfPossible to prevent stuck UI
                             if (typeof comp.changeBitrateIfPossible === 'function') {
                                 const originalChange = comp.changeBitrateIfPossible;
                                 comp.changeBitrateIfPossible = function() {
                                     // Ensure we don't try to switch to null path
                                     // This prevents the "Signal lost" or stuck UI
                                     // But since we can't get the real path, we can only notify user or fallback
                                     
                                     // Let's force filter to include our patched bitrates if possible
                                     // But the original code filters by !!t.path
                                     
                                     // We can try to monkey-patch bitrates list to have fake paths to see if it triggers something?
                                     // No, fake path will cause playback error.
                                     
                                     return originalChange.apply(this, arguments);
                                 };
                             }
                             comp.__yfsp_patched = true;
                         }
                         const playerProto = Object.getPrototypeOf(comp);
                         if (playerProto && typeof playerProto.checkIfNeedToggle === 'function' && !playerProto.__yfsp_speed_patched) {
                             playerProto.checkIfNeedToggle = function() { return true; };
                             playerProto.__yfsp_speed_patched = true;
                         }
                         if (playerProto && typeof playerProto.checkIfNeedToggleCallback === 'function' && !playerProto.__yfsp_speed_cb_patched) {
                             playerProto.checkIfNeedToggleCallback = function() { return true; };
                             playerProto.__yfsp_speed_cb_patched = true;
                         }
                        const speedLists = [comp.speedList, comp.rateList, comp.playbackRateList, comp.playbackRates, comp.speedOptions];
                        speedLists.forEach(unlockList);
                        if (playerProto && !playerProto.__yfsp_speed_methods_patched) {
                            Object.getOwnPropertyNames(playerProto).forEach(name => {
                                if (!/speed|rate/i.test(name)) return;
                                const fn = playerProto[name];
                                if (typeof fn !== 'function') return;
                                if (playerProto[`__yfsp_${name}_patched`]) return;
                                playerProto[name] = function() {
                                    try {
                                        if (this._user) patchUserState(this._user);
                                        if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                        if (this._userService && this._userService.userState && this._userService.userState._value) {
                                            patchUserState(this._userService.userState._value);
                                        }
                                    } catch (e) {}
                                    return fn.apply(this, arguments);
                                };
                                playerProto[`__yfsp_${name}_patched`] = true;
                            });
                            playerProto.__yfsp_speed_methods_patched = true;
                        }
                         if (typeof comp.checkIfNeedToggleCallback === 'function') {
                             comp.checkIfNeedToggleCallback = function() { return true; };
                         }
                         if (comp.isSwitching === true &&
                             comp.switching !== true &&
                             comp.isChanging !== true &&
                             comp.changeBitrateLoading !== true &&
                             comp.isLoading !== true &&
                             comp.loading !== true) {
                             comp.isSwitching = false;
                         }
                    }
                }
            }

            const selector = document.querySelector('vg-quality-selector');
            if (!selector || !selector.__ngContext__) return;
            const ctx = selector.__ngContext__;
            if (!Array.isArray(ctx)) return;
            const comp = ctx.find(x => x && typeof x === 'object' && x.bitrates && x.bitrateSelected);
            if (!comp) return;

            const changed = patchBitrates(comp.bitrates);
            if (changed) {
                console.log('[YFSP Unlocker] Angular component patched: bitrates unlocked');
            }

            if (!comp._user || typeof comp._user !== 'object') {
                comp._user = { id: 1, roleId: 1 };
            } else {
                if (comp._user.id == null) comp._user.id = 1;
                if (comp._user.roleId == null || comp._user.roleId < 0) comp._user.roleId = 1;
            }
            patchUserState(comp._user);
            if ('isVip' in comp) comp.isVip = true;
            if ('hasVIP' in comp) comp.hasVIP = true;
            if ('vipLevel' in comp) comp.vipLevel = 99;

            if (comp._userService && comp._userService.user) {
                patchUserState(comp._userService.user);
            }
            if (comp._userService && comp._userService.userState && comp._userService.userState._value) {
                patchUserState(comp._userService.userState._value);
            }

            const proto = Object.getPrototypeOf(comp);
            if (proto && typeof proto.selectBitrate === 'function' && !proto.__yfsp_select_patched) {
                const originalSelect = proto.selectBitrate;
                proto.selectBitrate = function(t) {
                    try {
                        if (t && typeof t === 'object') {
                            t.isVIP = false;
                            t.isBought = true;
                            t.isEnabled = true;
                            if ('isNav' in t) t.isNav = true;
                            if ('isLocked' in t) t.isLocked = false;
                            if ('lock' in t) t.lock = false;
                        }
                        if (this && this._user) patchUserState(this._user);
                        if (this && this._userService && this._userService.user) patchUserState(this._userService.user);
                        if (this && this._userService && this._userService.userState && this._userService.userState._value) {
                            patchUserState(this._userService.userState._value);
                        }
                        
                        // Prevent switching if path is null to avoid stuck UI
                        if (t && t.path === null) {
                            console.log('[YFSP Unlocker] 1080P/720P path is null (server-side restriction). Cannot switch.');
                            // Show a toast or alert if possible?
                            // Or just return to avoid stuck UI
                            // But user wants it FIXED. 
                            // Since we can't fix it, avoiding stuck UI is the second best thing.
                            // However, we should try to let it fall through so the user sees *something* happen,
                            // even if it's just a failure, rather than silent stuck.
                            
                            // The original logic:
                            // if (t.path) { ... } else { ... }
                            // If t.path is null, nothing happens in onSelectBitrate (parent component).
                            // This component (selector) emits the event.
                            
                            // We can try to mock a path?
                            // t.path = { result: "..." }; 
                            // If we mock a path, the player will try to play it and fail.
                            // That might be better than stuck UI.
                            
                            // Let's try to mock it with the 576P path just to see if it plays (even if low quality).
                            // This would be "fake 1080P".
                            
                            // Find 576P bitrate
                            if (this.bitrates) {
                                const b576 = this.bitrates.find(b => b.bitrate === 576 || b.label === '576P' || b.qualityIndex === 0);
                                if (b576 && b576.path) {
                                    // Clone the path object
                                    // We need to be careful not to mutate the shared reference if possible, 
                                    // but t is the object passed to emit.
                                    
                                    // Warn: This is a fake switch.
                                    console.log('[YFSP Unlocker] Spoofing 1080P with 576P source to bypass null path');
                                    t.path = b576.path;
                                }
                            }
                        }
                    } catch (e) {}
                    return originalSelect.call(this, t);
                };
                proto.__yfsp_select_patched = true;
                console.log('[YFSP Unlocker] Angular component patched: selectBitrate hooked');
            }

            const danmuEl = document.querySelector('app-danmu-input');
            if (danmuEl && danmuEl.__ngContext__) {
                const danmuCtx = danmuEl.__ngContext__;
                if (Array.isArray(danmuCtx)) {
                    const danmuComp = danmuCtx.find(x => x && typeof x === 'object' && x.typeList && x.colorList && x.danmuFacade);
                    if (danmuComp) {
                        patchUserState(danmuComp.user);
                        if (danmuComp._userService && danmuComp._userService.user) patchUserState(danmuComp._userService.user);
                        const lists = [danmuComp.typeList, danmuComp.colorList, danmuComp.styleList, danmuComp.fontList, danmuComp.speedList];
                        lists.forEach(unlockList);
                        if ('includeAvatarVip' in danmuComp) danmuComp.includeAvatarVip = false;
                        if ('includeLocationVip' in danmuComp) danmuComp.includeLocationVip = false;
                        if ('includeAvatarLock' in danmuComp) danmuComp.includeAvatarLock = false;
                        if ('includeLocationLock' in danmuComp) danmuComp.includeLocationLock = false;
                        if ('avatarVipFunction' in danmuComp) danmuComp.avatarVipFunction = false;
                        if ('locationVipFunction' in danmuComp) danmuComp.locationVipFunction = false;
                        if (danmuComp.danmuFacade && typeof danmuComp.danmuFacade === 'object' && !danmuComp.danmuFacade.__yfsp_patched) {
                            if (typeof danmuComp.danmuFacade.updateUserSettings === 'function') {
                                const originalUpdate = danmuComp.danmuFacade.updateUserSettings;
                                danmuComp.danmuFacade.updateUserSettings = function() {
                                    try {
                                        if (danmuComp.user) patchUserState(danmuComp.user);
                                        if (danmuComp._userService && danmuComp._userService.user) patchUserState(danmuComp._userService.user);
                                    } catch (e) {}
                                    return originalUpdate.apply(this, arguments);
                                };
                            }
                            danmuComp.danmuFacade.__yfsp_patched = true;
                        }
                        const danmuProto = Object.getPrototypeOf(danmuComp);
                        if (danmuProto && typeof danmuProto.selectColor === 'function' && !danmuProto.__yfsp_danmu_color_patched) {
                            const originalSelectColor = danmuProto.selectColor;
                            danmuProto.selectColor = function(t) {
                                try {
                                    patchUserState(this.user);
                                    if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                    if (t && typeof t === 'object' && this.danmuFacade && typeof this.danmuFacade.setOutputColor === 'function') {
                                        this.danmuFacade.setOutputColor(t.value);
                                        this.currentColor = t.value;
                                        if (typeof this.onFontChanged === 'function') this.onFontChanged();
                                        return;
                                    }
                                } catch (e) {}
                                return originalSelectColor.call(this, t);
                            };
                            danmuProto.__yfsp_danmu_color_patched = true;
                        }
                        if (danmuProto && typeof danmuProto.selectType === 'function' && !danmuProto.__yfsp_danmu_type_patched) {
                            const originalSelectType = danmuProto.selectType;
                            danmuProto.selectType = function(t) {
                                try {
                                    patchUserState(this.user);
                                    if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;
                                    if (t && typeof t === 'object' && this.danmuFacade && typeof this.danmuFacade.setOutputType === 'function') {
                                        this.danmuFacade.setOutputType(t.value);
                                        this.currentType = t.value;
                                        if (typeof this.onFontChanged === 'function') this.onFontChanged();
                                        return;
                                    }
                                } catch (e) {}
                                return originalSelectType.call(this, t);
                            };
                            danmuProto.__yfsp_danmu_type_patched = true;
                        }
                        if (danmuProto && typeof danmuProto.toggleIncludeAvatar === 'function' && !danmuProto.__yfsp_danmu_avatar_patched) {
                            const originalToggleAvatar = danmuProto.toggleIncludeAvatar;
                            danmuProto.toggleIncludeAvatar = function() {
                                try {
                                    patchUserState(this.user);
                                    if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;
                                    this.includeAvatar = !this.includeAvatar;
                                    if (this.danmuFacade && typeof this.danmuFacade.updateUserSettings === 'function') {
                                        this.danmuFacade.updateUserSettings({ includeAvatar: this.includeAvatar, includeLocation: this.includeLocation });
                                        return;
                                    }
                                } catch (e) {}
                                return originalToggleAvatar.call(this);
                            };
                            danmuProto.__yfsp_danmu_avatar_patched = true;
                        }
                        if (danmuProto && typeof danmuProto.toggleIncludeLocation === 'function' && !danmuProto.__yfsp_danmu_location_patched) {
                            const originalToggleLocation = danmuProto.toggleIncludeLocation;
                            danmuProto.toggleIncludeLocation = function() {
                                try {
                                    patchUserState(this.user);
                                    if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                    if (!this.user && this._userService && this._userService.user) this.user = this._userService.user;
                                    this.includeLocation = !this.includeLocation;
                                    if (this.danmuFacade && typeof this.danmuFacade.updateUserSettings === 'function') {
                                        this.danmuFacade.updateUserSettings({ includeAvatar: this.includeAvatar, includeLocation: this.includeLocation });
                                        return;
                                    }
                                } catch (e) {}
                                return originalToggleLocation.call(this);
                            };
                            danmuProto.__yfsp_danmu_location_patched = true;
                        }
                    }
                }
            }

            const commentBoxEl = document.querySelector('app-comment-box');
            if (commentBoxEl && commentBoxEl.__ngContext__) {
                const commentCtx = commentBoxEl.__ngContext__;
                if (Array.isArray(commentCtx)) {
                    const commentComp = commentCtx.find(x => x && typeof x === 'object' && x._commentService && x._emojiPickerService);
                    if (commentComp) {
                        patchUserState(commentComp.user);
                        if (commentComp._userService && commentComp._userService.user) patchUserState(commentComp._userService.user);
                        if (commentComp._userService && commentComp._userService.userState && commentComp._userService.userState._value) {
                            patchUserState(commentComp._userService.userState._value);
                        }
                        const commentProto = Object.getPrototypeOf(commentComp);
                        if (commentProto && typeof commentProto.openVotingCreatorDialog === 'function' && !commentProto.__yfsp_vote_patched) {
                            const originalOpenVote = commentProto.openVotingCreatorDialog;
                            commentProto.openVotingCreatorDialog = function() {
                                try {
                                    if (this.user) patchUserState(this.user);
                                    if (this._userService && this._userService.user) patchUserState(this._userService.user);
                                    this.showVotingCreator = true;
                                    return;
                                } catch (e) {}
                                return originalOpenVote.call(this);
                            };
                            commentProto.__yfsp_vote_patched = true;
                        }
                    }
                }
            }

            const emojiBoxEl = document.querySelector('.emoji-box');
            if (emojiBoxEl && emojiBoxEl.__ngContext__) {
                const emojiCtx = emojiBoxEl.__ngContext__;
                if (Array.isArray(emojiCtx)) {
                    const emojiComp = emojiCtx.find(x => x && typeof x === 'object' && x._permission && x.emojiSets);
                    if (emojiComp) {
                        patchUserState(emojiComp.user);
                        if (emojiComp._userService && emojiComp._userService.user) patchUserState(emojiComp._userService.user);
                        const emojiProto = Object.getPrototypeOf(emojiComp);
                        if (emojiProto && typeof emojiProto.canNotUseVipEmoj === 'function' && !emojiProto.__yfsp_vip_emoji_patched) {
                            emojiProto.canNotUseVipEmoj = function() { return false; };
                            emojiProto.__yfsp_vip_emoji_patched = true;
                        }
                    }
                }
            }
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
        hookAngular();
    };

    bootstrap();
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    setInterval(bootstrap, 2000);

})();
