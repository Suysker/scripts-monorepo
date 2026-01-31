// ==UserScript==
// @name         YFSP.TV VIP & AdBlock Unlocker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Unlock 1080P/4K UI & Block Ads for YFSP.TV
// @author       YFSP Analyst
// @match        *://*.yfsp.tv/*
// @match        *://*.dudupro.com/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    const MATCH_USER = [/\/api\/payment\/getPaymentInfo/i, /\/api\/user\/info/i];
    const MATCH_PLAY = [/\/v3\/video\/play/i, /\/v3\/video\/detail/i];

    const shouldMatch = (url, list) => list.some(r => r.test(url));

    const patchUser = (json) => {
        if (!json || !json.data) return json;
        json.data.isVip = true;
        json.data.vipLevel = 99;
        if (Array.isArray(json.data.info)) {
            json.data.info.forEach(info => {
                if (info && typeof info === 'object') {
                    info.isVip = true;
                    info.vipLevel = 99;
                }
            });
        }
        return json;
    };

    const patchPlay = (json) => {
        if (!json?.data?.info?.[0]?.clarity) return json;
        json.data.info[0].clarity.forEach(c => {
            if (!c) return;
            c.isBought = true;
            c.isVIP = false;
            c.isEnabled = true;
        });
        return json;
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
            let url = args[0];
            if (typeof url !== 'string') url = url.toString();
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
        const OriginalXHR = root.XMLHttpRequest;
        if (!OriginalXHR) return;
        function WrappedXHR() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;
            const originalSend = xhr.send;
            let requestUrl = '';
            xhr.open = function(method, url, ...rest) {
                requestUrl = url ? url.toString() : '';
                return originalOpen.call(this, method, url, ...rest);
            };
            xhr.send = function(...sendArgs) {
                this.addEventListener('readystatechange', function() {
                    if (this.readyState !== 4) return;
                    if (!requestUrl) return;
                    if (!(shouldMatch(requestUrl, MATCH_USER) || shouldMatch(requestUrl, MATCH_PLAY))) return;
                    try {
                        const text = this.responseText;
                        if (!text || text[0] !== '{') return;
                        let json = JSON.parse(text);
                        json = shouldMatch(requestUrl, MATCH_USER) ? patchUser(json) : patchPlay(json);
                        Object.defineProperty(this, 'responseText', { value: JSON.stringify(json) });
                        Object.defineProperty(this, 'response', { value: JSON.stringify(json) });
                    } catch (e) {}
                }, false);
                return originalSend.apply(this, sendArgs);
            };
            return xhr;
        }
        root.XMLHttpRequest = WrappedXHR;
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
    };

    bootstrap();
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    setInterval(bootstrap, 2000);

})();
