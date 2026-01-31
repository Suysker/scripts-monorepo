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
    };

    bootstrap();
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    setInterval(bootstrap, 2000);

})();
