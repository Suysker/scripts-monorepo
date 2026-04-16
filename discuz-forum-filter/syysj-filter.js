// ==UserScript==
// @name         syysj-filter
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  Forum non-male filter (male tag OR card gender=male) with blacklist/whitelist controls on profile hover cards, space page, and thread favatar.
// @author       Codex
// @match        *://*/main/forum.php*
// @match        *://*/main/home.php*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @homepage     https://github.com/Suysker/scripts-monorepo/tree/main/discuz-forum-filter
// @supportURL   https://github.com/Suysker/scripts-monorepo/issues
// ==/UserScript==

(function () {
    'use strict';

    const MALE_TAG_KEYWORDS = ['小哥自拍', '男宝宝自拍'];
    const HOST_HASH_ALLOWLIST = new Set(['d5ba6e83']);

    const STORAGE_KEY_BLACKLIST = 'syysj_blacklist_users_v1';
    const STORAGE_KEY_WHITELIST = 'syysj_whitelist_users_v1';
    const STORAGE_KEY_FILTER_MALE = 'syysj_filter_male_mode_v1';
    const STORAGE_KEY_GENDER_MAP = 'syysj_uid_gender_map_v1';

    const STYLE_ID = 'syysj-userlist-style';
    const TOOLBAR_ID = 'syysj-male-filter-toolbar';
    const THREAD_ROW_SELECTOR = 'tbody[id^="normalthread_"], tbody[id^="stickthread_"]';
    const MAX_CONCURRENT_GENDER_FETCH = 8;

    // ====== Auto fill config ======
    const AUTO_FILL_MIN_VISIBLE = 30;   // 过滤后可见数 < 30 时补齐
    const AUTO_FILL_MAX_PAGES = 10;     // 最多再拉 10 页，防止无限拉取
    const AUTO_FILL_DEBOUNCE_MS = 120;  // 防抖：避免 observer 频繁触发

    if (!isAllowedRuntimeHost(location.hostname)) return;

    const pageInfo = detectPage();
    if (!pageInfo.supported) return;

    const state = {
        filterMale: loadBoolean(STORAGE_KEY_FILTER_MALE, true),
        blacklist: loadUserMap(STORAGE_KEY_BLACKLIST),
        whitelist: loadUserMap(STORAGE_KEY_WHITELIST),
        genderMap: loadGenderMap(STORAGE_KEY_GENDER_MAP),
        genderFetchQueue: [],
        pendingGenderUids: new Set(),
        requestedGenderUids: new Set(),
        activeGenderFetches: 0,

        forumApplyQueued: false,
        threadApplyQueued: false,
        installUiQueued: false,
        clickHandlerInstalled: false,
        globalObserverInstalled: false,

        // auto fill
        loadingMore: false,
        autoFillQueued: false,
        autoFillToken: 0,

        loadedThreadKeys: new Set()
    };

    const LIST_META = {
        blacklist: {
            icon: '⛔',
            title: '黑名单',
            addLabel: '加入黑名单',
            removeLabel: '取消黑名单',
            emptyText: '当前黑名单为空。',
            clearConfirm: '确认清空全部黑名单吗？'
        },
        whitelist: {
            icon: '⭐',
            title: '白名单',
            addLabel: '加入白名单',
            removeLabel: '取消白名单',
            emptyText: '当前白名单为空。',
            clearConfirm: '确认清空全部白名单吗？'
        }
    };

    function normalizeHostForHash(hostname) {
        return String(hostname || '')
            .trim()
            .toLowerCase()
            .replace(/\.+$/, '')
            .replace(/^www\./, '');
    }

    function hashHostname(hostname) {
        const normalized = normalizeHostForHash(hostname);
        if (!normalized) return '';

        let hash = 0x811c9dc5;
        for (const ch of normalized) {
            hash ^= ch.codePointAt(0);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }

        return hash.toString(16).padStart(8, '0');
    }

    function isAllowedRuntimeHost(hostname) {
        const hash = hashHostname(hostname);
        return Boolean(hash) && HOST_HASH_ALLOWLIST.has(hash);
    }

    function detectPage() {
        const pathname = location.pathname.toLowerCase();
        const params = new URLSearchParams(location.search);
        const mod = params.get('mod') || '';

        const isForumPhp = pathname.endsWith('/forum.php');
        const isHomePhp = pathname.endsWith('/home.php');

        const isForumDisplay = isForumPhp && mod === 'forumdisplay';
        const isViewThread = isForumPhp && mod === 'viewthread';
        const isSpace = isHomePhp && mod === 'space';

        return {
            params,
            isForumDisplay,
            isViewThread,
            isSpace,
            supported: isForumDisplay || isViewThread || isSpace
        };
    }

    function loadBoolean(key, fallback) {
        try {
            const raw = GM_getValue(key, null);
            if (raw === null || raw === undefined) return fallback;
            return raw === true || raw === '1' || raw === 1;
        } catch {
            return fallback;
        }
    }

    function saveBoolean(key, value) {
        GM_setValue(key, Boolean(value));
    }

    function loadUserMap(key) {
        try {
            const parsed = GM_getValue(key, null);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

            const cleaned = {};
            for (const [entryKey, entry] of Object.entries(parsed)) {
                if (!entryKey || !entry || typeof entry !== 'object') continue;
                cleaned[entryKey] = {
                    uid: typeof entry.uid === 'string' ? entry.uid : '',
                    name: typeof entry.name === 'string' ? entry.name : '',
                    addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now()
                };
            }
            return cleaned;
        } catch {
            return {};
        }
    }

    function saveUserMap(key, value) {
        GM_setValue(key, value);
    }

    function isValidGenderCode(code) {
        return code === 0 || code === 1 || code === 2;
    }

    function loadGenderMap(key) {
        try {
            const parsed = GM_getValue(key, null);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

            const cleaned = {};
            for (const [uid, value] of Object.entries(parsed)) {
                if (!uid || !/^\d+$/.test(uid)) continue;
                const code = Number(value);
                if (isValidGenderCode(code)) cleaned[uid] = code;
            }
            return cleaned;
        } catch {
            return {};
        }
    }

    function saveGenderMap() {
        GM_setValue(STORAGE_KEY_GENDER_MAP, state.genderMap);
    }

    function readGenderCode(uid) {
        if (!uid) return null;
        const code = state.genderMap[uid];
        if (isValidGenderCode(code)) return code;
        return null;
    }

    function writeGenderCode(uid, code) {
        if (!uid) return false;
        if (!isValidGenderCode(code)) return false;
        if (state.genderMap[uid] === code) return false;
        state.genderMap[uid] = code;
        saveGenderMap();
        return true;
    }

    function extractGenderCodeFromText(text) {
        const match = String(text || '').match(/(?:card|post)_gender_(\d)/);
        if (!match) return null;
        const code = Number(match[1]);
        return isValidGenderCode(code) ? code : null;
    }

    function setGenderAttr(node, genderCode) {
        if (!node) return;
        if (isValidGenderCode(genderCode)) node.setAttribute('data-syysj-gender', String(genderCode));
        else node.removeAttribute('data-syysj-gender');
    }

    function buildUserCardRequestUrl(uid) {
        const url = new URL('/main/home.php', location.origin);
        url.searchParams.set('mod', 'space');
        url.searchParams.set('uid', uid);
        url.searchParams.set('ajaxmenu', '1');
        url.searchParams.set('inajax', '1');
        url.searchParams.set('ajaxtarget', `card_syysj_${uid}_menu_content`);
        return url.toString();
    }

    async function fetchGenderCodeByCard(uid) {
        const url = buildUserCardRequestUrl(uid);
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return null;

        const text = await response.text();
        return extractGenderCodeFromText(text);
    }

    function queueGenderFetch(uid) {
        if (!uid) return;
        if (readGenderCode(uid) !== null) return;
        if (state.pendingGenderUids.has(uid)) return;
        if (state.requestedGenderUids.has(uid)) return;

        state.requestedGenderUids.add(uid);
        state.pendingGenderUids.add(uid);
        state.genderFetchQueue.push(uid);
        drainGenderFetchQueue();
    }

    function drainGenderFetchQueue() {
        while (state.activeGenderFetches < MAX_CONCURRENT_GENDER_FETCH && state.genderFetchQueue.length > 0) {
            const uid = state.genderFetchQueue.shift();
            state.activeGenderFetches += 1;

            fetchGenderCodeByCard(uid)
                .then((code) => {
                    if (code !== null) writeGenderCode(uid, code);
                })
                .catch((error) => {
                    console.error('[syysj gender] fetch failed:', uid, error);
                })
                .finally(() => {
                    state.pendingGenderUids.delete(uid);
                    state.activeGenderFetches -= 1;
                    queueApplyCurrentPage();

                    drainGenderFetchQueue();
                });
        }
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
#${TOOLBAR_ID} {
    margin: 8px 0 10px;
    padding: 8px 10px;
    border: 1px solid #d9e8f3;
    border-radius: 6px;
    background: #f8fbff;
}
#${TOOLBAR_ID} .syysj-toolbar-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: #333;
}
#${TOOLBAR_ID} .syysj-btn {
    border: 1px solid #9fbfda;
    background: #fff;
    color: #2f587a;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 12px;
    line-height: 1.4;
    cursor: pointer;
}
#${TOOLBAR_ID} .syysj-btn:hover {
    background: #ecf6ff;
}
#${TOOLBAR_ID} .syysj-stat {
    color: #2f587a;
    font-weight: 600;
}
#${TOOLBAR_ID} .syysj-autofill {
    color: #666;
    font-weight: 500;
    margin-left: 8px;
}

.syysj-userlist-toggle {
    text-decoration: none;
    cursor: pointer;
}
.syysj-userlist-toggle:hover { text-decoration: underline; }
.syysj-userlist-toggle[data-syysj-list-type="blacklist"] { color: #b3002d !important; }
.syysj-userlist-toggle[data-syysj-list-type="whitelist"] { color: #0e7f43 !important; }
.syysj-userlist-toggle.is-active { font-weight: 700; }

.syysj-userlist-inline {
    margin-left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.syysj-userlist-inline .syysj-sep { color: #999; }
.syysj-userlist-li { list-style: none; }
.syysj-userlist-popup {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed #d9d9d9;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

/* 性别背景色（仅 forumdisplay 列表，做轻量浅色渲染） */
tbody[data-syysj-gender="0"] > tr > th,
tbody[data-syysj-gender="0"] > tr > td {
    background-color: rgb(249, 249, 249) !important;
}
tbody[data-syysj-gender="1"] > tr > th,
tbody[data-syysj-gender="1"] > tr > td {
    background-color: rgb(232, 248, 253) !important;
}
tbody[data-syysj-gender="2"] > tr > th,
tbody[data-syysj-gender="2"] > tr > td {
    background-color: rgb(254, 244, 244) !important;
}

/* 可选：让“页内跳转”的页码看起来像正常链接，但语义是 jump */
a.syysj-page-jump {
    cursor: pointer !important;
}
`;
        document.head.appendChild(style);
    }

    function normalizeText(input) {
        return String(input || '').replace(/\s+/g, ' ').trim();
    }

    function extractUidFromHref(href) {
        if (!href) return '';
        const directMatch = href.match(/(?:\?|&)uid=(\d+)/);
        if (directMatch) return directMatch[1];
        const shortMatch = href.match(/^\?(\d+)$/);
        return shortMatch ? shortMatch[1] : '';
    }

    function buildUserKey(uid, name) {
        if (uid) return `uid:${uid}`;
        if (!name) return '';
        return `name:${name.toLowerCase()}`;
    }

    function buildMeta(uid, name) {
        const normalizedUid = normalizeText(uid);
        const normalizedName = normalizeText(name);
        return {
            uid: normalizedUid,
            authorName: normalizedName,
            userKey: buildUserKey(normalizedUid, normalizedName)
        };
    }

    function readMetaFromDataset(dataset) {
        if (!dataset) return null;
        const uid = dataset.syysjUid || '';
        const name = dataset.syysjName || '';
        const meta = buildMeta(uid, name);

        if (!meta.userKey && dataset.syysjUserKey) meta.userKey = dataset.syysjUserKey;
        return meta.userKey ? meta : null;
    }

    function isBlacklisted(meta) {
        return Boolean(meta && meta.userKey && state.blacklist[meta.userKey]);
    }
    function isWhitelisted(meta) {
        return Boolean(meta && meta.userKey && state.whitelist[meta.userKey]);
    }
    function isMaleQualified(meta) {
        return Boolean(meta && (meta.isMaleTag || meta.isMaleGender));
    }

    function evaluateVisibility(meta, maleQualified) {
        const hasUserKey = Boolean(meta && meta.userKey);
        const whitelisted = hasUserKey && isWhitelisted(meta);
        const blacklisted = hasUserKey && isBlacklisted(meta);
        const hideForMaleFilter = state.filterMale && Boolean(maleQualified);
        const shouldHide = !whitelisted && (blacklisted || hideForMaleFilter);
        return { whitelisted, blacklisted, hideForMaleFilter, shouldHide };
    }

    function queueApplyCurrentPage() {
        queueApplyForumDisplay();
        queueApplyViewThread();
    }

    function getUserListEntries(listName) {
        const target = listName === 'whitelist' ? state.whitelist : state.blacklist;
        return Object.entries(target)
            .map(([key, value]) => ({ key, ...value }))
            .sort((l, r) => (r.addedAt || 0) - (l.addedAt || 0));
    }

    function saveAllLists() {
        saveUserMap(STORAGE_KEY_BLACKLIST, state.blacklist);
        saveUserMap(STORAGE_KEY_WHITELIST, state.whitelist);
    }

    function addToList(listName, meta) {
        if (!meta || !meta.userKey) return;

        const target = listName === 'whitelist' ? state.whitelist : state.blacklist;
        const opposite = listName === 'whitelist' ? state.blacklist : state.whitelist;

        target[meta.userKey] = {
            uid: meta.uid || '',
            name: meta.authorName || '',
            addedAt: Date.now()
        };

        if (opposite[meta.userKey]) delete opposite[meta.userKey];
        saveAllLists();
    }

    function removeFromList(listName, meta) {
        if (!meta || !meta.userKey) return;
        const target = listName === 'whitelist' ? state.whitelist : state.blacklist;
        if (!target[meta.userKey]) return;
        delete target[meta.userKey];
        saveAllLists();
    }

    function stopAutoFillSoon() {
        // 令牌 +1：让正在执行的补齐循环尽快停止
        state.autoFillToken += 1;
        setAutoFillStatus('');
    }

    function toggleUserList(listName, meta) {
        if (!meta || !meta.userKey) return;

        if (listName === 'whitelist') {
            if (isWhitelisted(meta)) removeFromList('whitelist', meta);
            else addToList('whitelist', meta);
        } else {
            if (isBlacklisted(meta)) removeFromList('blacklist', meta);
            else addToList('blacklist', meta);
        }

        onUserListsChanged();
    }

    function clearUserList(listName) {
        if (listName === 'whitelist') state.whitelist = {};
        else state.blacklist = {};
        saveAllLists();
        onUserListsChanged();
    }

    function onUserListsChanged() {
        stopAutoFillSoon();
        queueInstallUserControls();
        queueApplyCurrentPage();
    }

    function openUserListManager(listName) {
        const listMeta = LIST_META[listName];
        if (!listMeta) return;

        const entries = getUserListEntries(listName);
        if (entries.length === 0) {
            alert(listMeta.emptyText);
            return;
        }

        const lines = entries.map((entry, i) => {
            const name = entry.name || '(未命名用户)';
            const uidLabel = entry.uid ? ` uid:${entry.uid}` : '';
            return `${i + 1}. ${name}${uidLabel}`;
        });

        const input = prompt(
            `当前${listMeta.title}（${entries.length} 人）：\n${lines.join('\n')}\n\n输入要移除的序号（可用逗号分隔），输入 all 清空全部。`,
            ''
        );
        if (input === null) return;

        const normalized = input.trim().toLowerCase();
        if (!normalized) return;

        if (normalized === 'all') {
            if (confirm(listMeta.clearConfirm)) clearUserList(listName);
            return;
        }

        const indexes = normalized
            .split(/[,\s]+/)
            .map((t) => parseInt(t, 10))
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= entries.length);

        const uniqueIndexes = Array.from(new Set(indexes));
        if (uniqueIndexes.length === 0) {
            alert('未识别到有效序号，未做修改。');
            return;
        }

        const target = listName === 'whitelist' ? state.whitelist : state.blacklist;
        uniqueIndexes.forEach((idx) => {
            const entry = entries[idx - 1];
            if (!entry) return;
            delete target[entry.key];
        });

        saveAllLists();
        onUserListsChanged();
    }

    function ensureGlobalToggleHandler() {
        if (state.clickHandlerInstalled) return;

        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;

            // 1) 处理“分页页内跳转”
            const pageJump = target.closest('a[data-syysj-jump-page]');
            if (pageJump) {
                const pageNo = parseInt(pageJump.getAttribute('data-syysj-jump-page') || '', 10);
                if (Number.isFinite(pageNo)) {
                    event.preventDefault();
                    event.stopPropagation();
                    scrollToMergedPage(pageNo);
                }
                return;
            }

            // 2) 处理 黑/白名单 toggle
            const link = target.closest('a.syysj-userlist-toggle');
            if (!link) return;

            event.preventDefault();
            event.stopPropagation();

            const listName = link.dataset.syysjListType;
            if (!listName || (listName !== 'blacklist' && listName !== 'whitelist')) return;

            const meta = readMetaFromDataset(link.dataset);
            if (!meta) return;

            toggleUserList(listName, meta);
        });

        state.clickHandlerInstalled = true;
    }

    function updateToggleLinkLabel(link) {
        const listName = link.dataset.syysjListType;
        const meta = readMetaFromDataset(link.dataset);
        const listMeta = LIST_META[listName];
        if (!meta || !listName || !listMeta) return;

        const active = listName === 'whitelist' ? isWhitelisted(meta) : isBlacklisted(meta);
        const label = active ? listMeta.removeLabel : listMeta.addLabel;

        link.textContent = `${listMeta.icon} ${label}`;
        link.classList.toggle('is-active', active);
    }

    function configureToggleLink(link, listName, meta) {
        link.href = 'javascript:;';
        link.classList.add('syysj-userlist-toggle');
        link.dataset.syysjListType = listName;
        link.dataset.syysjUid = meta.uid || '';
        link.dataset.syysjName = meta.authorName || '';
        link.dataset.syysjUserKey = meta.userKey || '';
        updateToggleLinkLabel(link);
    }

    function refreshAllToggleLabels() {
        const links = document.querySelectorAll('a.syysj-userlist-toggle[data-syysj-list-type]');
        links.forEach((link) => updateToggleLinkLabel(link));
    }

    function ensureInlineControls(host, meta) {
        if (!host || !meta || !meta.userKey) return;

        let box = host.querySelector(':scope > .syysj-userlist-inline');
        if (!box) {
            box = document.createElement('span');
            box.className = 'syysj-userlist-inline';
            const firstScript = host.querySelector(':scope > script');
            if (firstScript) host.insertBefore(box, firstScript);
            else host.appendChild(box);
        }

        let blackLink = box.querySelector('a[data-syysj-list-type="blacklist"]');
        if (!blackLink) {
            blackLink = document.createElement('a');
            blackLink.className = 'xi2 syysj-userlist-toggle';
            box.appendChild(blackLink);
        }

        let separator = box.querySelector('.syysj-sep');
        if (!separator) {
            separator = document.createElement('span');
            separator.className = 'syysj-sep';
            separator.textContent = '/';
            box.appendChild(separator);
        }

        let whiteLink = box.querySelector('a[data-syysj-list-type="whitelist"]');
        if (!whiteLink) {
            whiteLink = document.createElement('a');
            whiteLink.className = 'xi2 syysj-userlist-toggle';
            box.appendChild(whiteLink);
        }

        configureToggleLink(blackLink, 'blacklist', meta);
        configureToggleLink(whiteLink, 'whitelist', meta);
    }

    function ensureListControls(listNode, meta, classes) {
        if (!listNode || !meta || !meta.userKey) return;

        const classMap = classes || { blacklist: 'syysj-userlist-black', whitelist: 'syysj-userlist-white' };

        let blackLi = listNode.querySelector(`:scope > li.${classMap.blacklist}`);
        if (!blackLi) {
            blackLi = document.createElement('li');
            blackLi.className = `${classMap.blacklist} syysj-userlist-li`;
            listNode.appendChild(blackLi);
        }

        let blackLink = blackLi.querySelector('a.syysj-userlist-toggle');
        if (!blackLink) {
            blackLink = document.createElement('a');
            blackLink.className = 'xi2 syysj-userlist-toggle';
            blackLi.appendChild(blackLink);
        }

        let whiteLi = listNode.querySelector(`:scope > li.${classMap.whitelist}`);
        if (!whiteLi) {
            whiteLi = document.createElement('li');
            whiteLi.className = `${classMap.whitelist} syysj-userlist-li`;
            listNode.appendChild(whiteLi);
        }

        let whiteLink = whiteLi.querySelector('a.syysj-userlist-toggle');
        if (!whiteLink) {
            whiteLink = document.createElement('a');
            whiteLink.className = 'xi2 syysj-userlist-toggle';
            whiteLi.appendChild(whiteLink);
        }

        configureToggleLink(blackLink, 'blacklist', meta);
        configureToggleLink(whiteLink, 'whitelist', meta);
    }

    function readRowMeta(row) {
        if (!row) return null;

        const authorCell = row.querySelector('td.by');
        const authorLink = authorCell ? authorCell.querySelector('cite > a[href*="home.php?mod=space"]') : null;
        const authorName = normalizeText(authorLink ? authorLink.textContent : '');
        const uid = extractUidFromHref(authorLink ? authorLink.getAttribute('href') : '');
        const userKey = buildUserKey(uid, authorName);

        const tagLink = row.querySelector('th em a');
        const tagText = normalizeText(tagLink ? tagLink.textContent : '');
        const isMaleTag = MALE_TAG_KEYWORDS.some((keyword) => tagText.includes(keyword));

        const genderCode = readGenderCode(uid);
        const isMaleGender = genderCode === 1;
        if (uid && genderCode === null) queueGenderFetch(uid);

        return { row, authorName, uid, userKey, tagText, isMaleTag, genderCode, isMaleGender };
    }

    function getThreadRows() {
        return Array.from(document.querySelectorAll(THREAD_ROW_SELECTOR));
    }

    function syncForumSeparatorVisibility(visibleStickyRows, visibleNormalRows) {
        if (!pageInfo.isForumDisplay) return;

        const table = document.getElementById('threadlisttableid');
        if (!table) return;

        const separator = table.querySelector('tbody#separatorline');
        if (!separator) return;

        const shouldShow = visibleStickyRows > 0 && visibleNormalRows > 0;
        separator.style.display = shouldShow ? '' : 'none';
    }

    function ensureToolbar() {
        const threadList = document.getElementById('threadlist');
        if (!threadList || !threadList.parentNode) return null;

        let toolbar = document.getElementById(TOOLBAR_ID);
        if (toolbar) return toolbar;

        toolbar = document.createElement('div');
        toolbar.id = TOOLBAR_ID;
        toolbar.innerHTML = `
<div class="syysj-toolbar-row">
    <button type="button" class="syysj-btn" data-action="toggle-male"></button>
    <button type="button" class="syysj-btn" data-action="manage-blacklist">管理黑名单</button>
    <button type="button" class="syysj-btn" data-action="manage-whitelist">管理白名单</button>
    <span class="syysj-stat" data-role="stats"></span>
    <span class="syysj-autofill" data-role="autofill"></span>
</div>
        `;

        const toggleButton = toolbar.querySelector('[data-action="toggle-male"]');
        const manageBlacklistButton = toolbar.querySelector('[data-action="manage-blacklist"]');
        const manageWhitelistButton = toolbar.querySelector('[data-action="manage-whitelist"]');

        if (toggleButton) {
            toggleButton.addEventListener('click', () => {
                stopAutoFillSoon();
                state.filterMale = !state.filterMale;
                saveBoolean(STORAGE_KEY_FILTER_MALE, state.filterMale);
                queueApplyCurrentPage();
            });
        }
        if (manageBlacklistButton) manageBlacklistButton.addEventListener('click', () => openUserListManager('blacklist'));
        if (manageWhitelistButton) manageWhitelistButton.addEventListener('click', () => openUserListManager('whitelist'));

        threadList.parentNode.insertBefore(toolbar, threadList);
        return toolbar;
    }

    function setAutoFillStatus(text) {
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (!toolbar) return;
        const node = toolbar.querySelector('[data-role="autofill"]');
        if (!node) return;
        node.textContent = text || '';
    }

    function updateToolbar(stats) {
        const toolbar = ensureToolbar();
        if (!toolbar) return;

        const toggleButton = toolbar.querySelector('[data-action="toggle-male"]');
        const statsNode = toolbar.querySelector('[data-role="stats"]');

        if (toggleButton) toggleButton.textContent = state.filterMale ? '过滤男性：开' : '过滤男性：关';

        if (statsNode) {
            const blackCount = Object.keys(state.blacklist).length;
            const whiteCount = Object.keys(state.whitelist).length;
            statsNode.textContent =
                `可见 ${stats.visible}/${stats.total}（白名单保留 ${stats.visibleByWhitelist}） | ` +
                `隐藏 ${stats.hidden}（男性过滤 ${stats.hiddenByMale}，黑名单 ${stats.hiddenByBlacklist}） | ` +
                `黑名单 ${blackCount} 白名单 ${whiteCount}`;
        }
    }

    // -----------------------------
    // Pagination merge helpers
    // -----------------------------

    function getCurrentPageFromLocation() {
        const p = parseInt(pageInfo.params.get('page') || '1', 10);
        return Number.isFinite(p) && p > 0 ? p : 1;
    }

    function getPageNumberFromUrl(url) {
        try {
            const u = new URL(url, location.href);
            const p = parseInt(u.searchParams.get('page') || '1', 10);
            return Number.isFinite(p) && p > 0 ? p : 1;
        } catch {
            return null;
        }
    }

    function scrollToMergedPage(pageNo) {
        if (!pageInfo.isForumDisplay) return;

        const table = document.getElementById('threadlisttableid');
        if (!table) return;

        const node = table.querySelector(`tbody[data-syysj-page="${pageNo}"]`);
        if (!node) return;

        node.scrollIntoView({ behavior: 'smooth', block: 'start' });

        try {
            node.style.outline = '2px solid rgba(47,88,122,0.35)';
            setTimeout(() => (node.style.outline = ''), 900);
        } catch {}
    }

    function patchPagerAfterMerge({ basePage, tailPage, nextUrl, fetchedPages }) {
        if (!pageInfo.isForumDisplay) return;

        // Discuz 通常顶部(#pgt)和底部(#pg)各一个分页；有些模板可能还有别的 .pg
        const pagers = Array.from(document.querySelectorAll('#pgt .pg, #pg .pg, .pg'))
            .filter((pg) => pg && pg.querySelector && (pg.querySelector('strong') || pg.querySelector('a.nxt') || pg.querySelector('a.prev')));

        pagers.forEach((pg) => {
            // 1) 更新“当前页”显示为 tailPage
            const currentStrong = pg.querySelector('strong');
            if (currentStrong) {
                currentStrong.textContent = String(tailPage);
                currentStrong.setAttribute('title', `已合并至第${tailPage}页（起始第${basePage}页，额外合并${fetchedPages}页）`);
            }

            // 2) 避免出现 strong=tailPage 同时还存在一个 a=tailPage 的重复项：删掉/隐藏同号链接
            const numberLinks = Array.from(pg.querySelectorAll('a'))
                .filter((a) => {
                    const n = parseInt((a.textContent || '').trim(), 10);
                    return Number.isFinite(n) && n === tailPage;
                });
            numberLinks.forEach((a) => a.remove());

            // 3) 处理 next
            const nextLinks = pg.querySelectorAll('a.nxt');
            nextLinks.forEach((a) => {
                if (!(a instanceof HTMLAnchorElement)) return;
                if (!nextUrl) {
                    a.removeAttribute('href');
                    a.style.pointerEvents = 'none';
                    a.style.opacity = '0.5';
                    a.textContent = '已到末页';
                } else {
                    a.href = nextUrl;
                    const targetPage = getPageNumberFromUrl(nextUrl);
                    a.textContent = targetPage ? `下一页（第${targetPage}页）` : '下一页';
                    a.style.pointerEvents = '';
                    a.style.opacity = '';
                }
            });

            // 4) 已合并页码：变成“页内跳转”
            Array.from(pg.querySelectorAll('a')).forEach((a) => {
                if (!(a instanceof HTMLAnchorElement)) return;

                // skip nxt/prev 由上面处理
                if (a.classList.contains('nxt')) return;

                const text = (a.textContent || '').trim();
                const n = parseInt(text, 10);
                if (!Number.isFinite(n)) return;

                // 在合并范围内（basePage..tailPage）且不是 tailPage（tailPage 的 a 已删）
                if (n >= basePage && n <= tailPage) {
                    a.href = 'javascript:;';
                    a.setAttribute('data-syysj-jump-page', String(n));
                    a.classList.add('syysj-page-jump');
                    a.setAttribute('title', `页内跳转：第${n}页内容（已合并）`);
                }
            });

            // prev 也改成页内跳转，保证已合并页的导航语义一致。
            const prevLinks = pg.querySelectorAll('a.prev');
            prevLinks.forEach((a) => {
                if (!(a instanceof HTMLAnchorElement)) return;
                if (tailPage > basePage) {
                    const jumpTo = Math.max(basePage, tailPage - 1);
                    a.href = 'javascript:;';
                    a.setAttribute('data-syysj-jump-page', String(jumpTo));
                    a.classList.add('syysj-page-jump');
                    a.setAttribute('title', `页内跳转：第${jumpTo}页内容（已合并）`);
                }
            });
        });
    }

    // -----------------------------
    // Auto fill helpers
    // -----------------------------

    function extractThreadKeyFromTbodyId(id) {
        const text = String(id || '');
        const m = text.match(/(?:normal|stick)thread_(\d+)/);
        if (m) return m[1];
        return text || '';
    }

    function seedLoadedThreadKeys(reset = false) {
        if (reset) state.loadedThreadKeys.clear();
        const rows = getThreadRows();
        rows.forEach((row) => {
            if (!row || row.id === 'separatorline') return;
            const key = extractThreadKeyFromTbodyId(row.id);
            if (key) state.loadedThreadKeys.add(key);
        });
    }

    function tagThreadRowsWithPage(pageNo) {
        // 给当前页面已存在的 thread 行打标：data-syysj-page="pageNo"
        const rows = getThreadRows();
        rows.forEach((row) => {
            if (!row || row.id === 'separatorline') return;
            if (!row.getAttribute('data-syysj-page')) {
                row.setAttribute('data-syysj-page', String(pageNo));
            }
        });
    }

    function findNextPageUrl(docRoot) {
        const nxt =
            docRoot.querySelector('#pgt .pg a.nxt') ||
            docRoot.querySelector('#pg .pg a.nxt') ||
            docRoot.querySelector('.pg a.nxt') ||
            docRoot.querySelector('a.nxt');

        if (!nxt) return null;
        const href = nxt.getAttribute('href');
        if (!href || href.startsWith('javascript')) return null;

        try {
            return new URL(href, location.href).toString();
        } catch {
            return null;
        }
    }

    function stripScripts(root) {
        if (!root) return;
        root.querySelectorAll('script').forEach((s) => s.remove());
    }

    function getThreadAppendRefNode(table) {
        if (!table) return null;

        // 优先：插到最后一个 normalthread 之后
        const normals = table.querySelectorAll('tbody[id^="normalthread_"]');
        if (normals.length) return normals[normals.length - 1].nextSibling;

        // 如果本页刚好没有普通贴：那就插到 separatorline 之后（也就是它的 nextSibling 之前）
        const sep = table.querySelector('tbody#separatorline');
        if (sep) return sep.nextSibling;

        // 兜底：插到最后一个 thread tbody 之后
        const threads = table.querySelectorAll(THREAD_ROW_SELECTOR);
        if (threads.length) return threads[threads.length - 1].nextSibling;

        // 再兜底：append 到末尾
        return null;
    }

    function appendThreadRowsFromDoc(parsedDoc, sourcePageNo) {
        const table = document.getElementById('threadlisttableid');
        if (!table) return 0;

        // ✅ 只合并普通贴，避免 stickthread 反复出现影响结构/排序
        const rows = Array.from(parsedDoc.querySelectorAll('tbody[id^="normalthread_"]'));
        if (rows.length === 0) return 0;

        // ✅ 计算“正确插入点”：永远插到普通贴末尾（或 separator 后）
        const refNode = getThreadAppendRefNode(table);

        let appended = 0;

        for (const row of rows) {
            if (!row || row.id === 'separatorline') continue;

            const key = extractThreadKeyFromTbodyId(row.id);
            if (key && state.loadedThreadKeys.has(key)) continue;

            const cloned = document.importNode(row, true);
            stripScripts(cloned);

            // 给合并进来的行打标：来源页号
            cloned.setAttribute('data-syysj-page', String(sourcePageNo));

            if (refNode) table.insertBefore(cloned, refNode);
            else table.appendChild(cloned);

            if (key) state.loadedThreadKeys.add(key);
            appended += 1;
        }

        return appended;
    }

    async function autoFillToThresholdIfNeeded(currentStats) {
        if (!pageInfo.isForumDisplay) return;
        if (state.loadingMore) return;

        // 只在“确实会减少可见数量”的过滤条件存在时才补齐
        const filteringActive = state.filterMale || Object.keys(state.blacklist).length > 0;
        if (!filteringActive) {
            setAutoFillStatus('');
            return;
        }

        const visibleNow = currentStats?.visible ?? 0;
        if (visibleNow >= AUTO_FILL_MIN_VISIBLE) {
            setAutoFillStatus('');
            return;
        }

        if (state.autoFillQueued) return;
        state.autoFillQueued = true;

        setTimeout(async () => {
            state.autoFillQueued = false;

            const table = document.getElementById('threadlisttableid');
            if (!table) return;

            const myToken = ++state.autoFillToken;
            const basePage = getCurrentPageFromLocation();

            state.loadingMore = true;
            try {
                // 每次开始补齐：重建去重集合 + 给当前页现有行打上 basePage 标记
                seedLoadedThreadKeys(true);
                tagThreadRowsWithPage(basePage);

                let stats = applyForumDisplayFiltering(true);
                if (stats.visible >= AUTO_FILL_MIN_VISIBLE) {
                    setAutoFillStatus('');
                    return;
                }

                let nextUrl = findNextPageUrl(document);
                let fetchedPages = 0;
                let tailPage = basePage;

                while (
                    myToken === state.autoFillToken &&
                    stats.visible < AUTO_FILL_MIN_VISIBLE &&
                    nextUrl &&
                    fetchedPages < AUTO_FILL_MAX_PAGES
                ) {
                    const nextPageNo = getPageNumberFromUrl(nextUrl);
                    // 如果解析不到页号，就按递增猜；但一般 Discuz 都能解析到
                    const sourcePageNo = nextPageNo || (tailPage + 1);

                    setAutoFillStatus(`补充中… ${stats.visible}/${AUTO_FILL_MIN_VISIBLE}（加载第${sourcePageNo}页）`);

                    let resp;
                    try {
                        resp = await fetch(nextUrl, { credentials: 'include' });
                    } catch (e) {
                        console.error('[syysj autofill] fetch error:', e);
                        break;
                    }
                    if (!resp || !resp.ok) break;

                    const html = await resp.text();
                    if (myToken !== state.autoFillToken) break;

                    const parsed = new DOMParser().parseFromString(html, 'text/html');

                    const appended = appendThreadRowsFromDoc(parsed, sourcePageNo);

                    nextUrl = findNextPageUrl(parsed);
                    fetchedPages += 1;
                    tailPage = Math.max(tailPage, sourcePageNo);

                    if (appended === 0) break;

                    stats = applyForumDisplayFiltering(true);
                    queueInstallUserControls();
                }

                // 关键：补齐结束后，进入“合并分页语义”
                // nextUrl 此时代表：第一个尚未合并的下一页（如果存在）
                // tailPage = 已合并到的最后页
                if (tailPage > basePage) {
                    patchPagerAfterMerge({ basePage, tailPage, nextUrl, fetchedPages });
                }

                if (stats.visible >= AUTO_FILL_MIN_VISIBLE) {
                    setAutoFillStatus(`已补齐：${stats.visible}/${AUTO_FILL_MIN_VISIBLE}（合并至第${tailPage}页）`);
                } else if (!nextUrl) {
                    setAutoFillStatus(`无下一页：${stats.visible}/${AUTO_FILL_MIN_VISIBLE}（已到末页）`);
                } else if (fetchedPages >= AUTO_FILL_MAX_PAGES) {
                    setAutoFillStatus(`已达上限：${stats.visible}/${AUTO_FILL_MIN_VISIBLE}（最多+${AUTO_FILL_MAX_PAGES}页）`);
                } else {
                    setAutoFillStatus(`补充结束：${stats.visible}/${AUTO_FILL_MIN_VISIBLE}（合并至第${tailPage}页）`);
                }
            } catch (e) {
                console.error('[syysj autofill] failed:', e);
                setAutoFillStatus('补充失败（控制台可看日志）');
            } finally {
                state.loadingMore = false;
            }
        }, AUTO_FILL_DEBOUNCE_MS);
    }

    // -----------------------------
    // Forumdisplay filtering
    // -----------------------------

    function applyForumDisplayFiltering(fromAutoFill = false) {
        const rows = getThreadRows();
        if (rows.length === 0) {
            const stats0 = { total: 0, visible: 0, hidden: 0, hiddenByMale: 0, hiddenByBlacklist: 0, visibleByWhitelist: 0 };
            syncForumSeparatorVisibility(0, 0);
            updateToolbar(stats0);
            return stats0;
        }

        let total = 0;
        let visible = 0;
        let hiddenByMale = 0;
        let hiddenByBlacklist = 0;
        let visibleByWhitelist = 0;
        let visibleStickyRows = 0;
        let visibleNormalRows = 0;

        rows.forEach((row) => {
            if (!row || row.id === 'separatorline') return;

            total += 1;
            const meta = readRowMeta(row);
            if (!meta) {
                setGenderAttr(row, null);
                row.style.display = '';
                visible += 1;
                if (row.id.startsWith('stickthread_')) visibleStickyRows += 1;
                else if (row.id.startsWith('normalthread_')) visibleNormalRows += 1;
                return;
            }

            setGenderAttr(row, meta.genderCode);
            const visibility = evaluateVisibility(meta, isMaleQualified(meta));
            const { whitelisted, blacklisted, shouldHide } = visibility;

            row.style.display = shouldHide ? 'none' : '';

            if (shouldHide) {
                if (blacklisted) hiddenByBlacklist += 1;
                else hiddenByMale += 1;
            } else {
                visible += 1;
                if (whitelisted) visibleByWhitelist += 1;
                if (row.id.startsWith('stickthread_')) visibleStickyRows += 1;
                else if (row.id.startsWith('normalthread_')) visibleNormalRows += 1;
            }
        });

        syncForumSeparatorVisibility(visibleStickyRows, visibleNormalRows);

        const stats = {
            total,
            visible,
            hidden: total - visible,
            hiddenByMale,
            hiddenByBlacklist,
            visibleByWhitelist
        };

        updateToolbar(stats);

        // 避免递归：补齐内部调用(fromAutoFill=true)不触发补齐；
        // 补齐进行中(state.loadingMore=true)也不再次触发。
        if (pageInfo.isForumDisplay && !fromAutoFill && !state.loadingMore) {
            autoFillToThresholdIfNeeded(stats);
        }

        return stats;
    }

    function queueApplyForumDisplay() {
        if (!pageInfo.isForumDisplay || state.forumApplyQueued) return;

        state.forumApplyQueued = true;
        window.requestAnimationFrame(() => {
            state.forumApplyQueued = false;
            applyForumDisplayFiltering(false);
        });
    }

    // -----------------------------
    // Viewthread filtering (posts)
    // -----------------------------

    function readPostMeta(postNode) {
        if (!postNode) return null;

        const favatar = postNode.querySelector('.favatar');
        if (!favatar) return null;

        const authorLink = favatar.querySelector('.pi .authi a[href*="home.php?mod=space"]');
        if (!authorLink) return null;

        const authorName = normalizeText(authorLink.textContent);
        const uid = extractUidFromHref(authorLink.getAttribute('href'));
        const userKey = buildUserKey(uid, authorName);
        const postTable = postNode.querySelector(':scope > table');
        const tableGenderCode = extractGenderCodeFromText(postTable ? postTable.className : '');
        let genderCode = readGenderCode(uid);
        if (genderCode === null && tableGenderCode !== null) {
            genderCode = tableGenderCode;
            if (uid) writeGenderCode(uid, genderCode);
        }
        const isMaleGender = genderCode === 1;
        if (uid && genderCode === null) queueGenderFetch(uid);

        return { postNode, favatar, authorName, uid, userKey, genderCode, isMaleGender };
    }

    function getPostNodes() {
        return Array.from(document.querySelectorAll('div[id^="post_"]'));
    }

    function ensureFavatarControls() {
        if (!pageInfo.isViewThread) return;

        const posts = getPostNodes();
        posts.forEach((postNode) => {
            const meta = readPostMeta(postNode);
            if (!meta || !meta.userKey || !meta.favatar) return;

            let actionList = meta.favatar.querySelector('ul.xl.xl2.o.cl');
            if (!actionList) {
                actionList = document.createElement('ul');
                actionList.className = 'xl xl2 o cl';
                meta.favatar.appendChild(actionList);
            }

            ensureListControls(actionList, meta, { blacklist: 'syysj-userlist-black', whitelist: 'syysj-userlist-white' });
        });
    }

    function applyViewThreadFiltering() {
        if (!pageInfo.isViewThread) return;

        const posts = getPostNodes();
        posts.forEach((postNode) => {
            const meta = readPostMeta(postNode);
            if (!meta) {
                postNode.style.display = '';
                return;
            }

            const { shouldHide } = evaluateVisibility(meta, meta.isMaleGender);
            postNode.style.display = shouldHide ? 'none' : '';
        });
    }

    function queueApplyViewThread() {
        if (!pageInfo.isViewThread || state.threadApplyQueued) return;

        state.threadApplyQueued = true;
        window.requestAnimationFrame(() => {
            state.threadApplyQueued = false;
            applyViewThreadFiltering();
        });
    }

    // -----------------------------
    // Space page controls
    // -----------------------------

    function readSpacePageMeta() {
        if (!pageInfo.isSpace) return null;

        const uid = normalizeText(pageInfo.params.get('uid') || '');
        if (!uid) return null;

        const nameNode =
            document.querySelector('#uhd h2.mbn a[href*="home.php?mod=space&uid="]') ||
            document.querySelector('#uhd h2.mbn');
        const name = normalizeText(nameNode ? nameNode.textContent : '');

        return buildMeta(uid, name);
    }

    function ensureSpacePageControls() {
        if (!pageInfo.isSpace) return;

        const meta = readSpacePageMeta();
        if (!meta || !meta.userKey) return;

        const profileContent = document.getElementById('profile_content');
        if (!profileContent) return;

        let actionList = profileContent.querySelector('ul.xl.xl2.cl.ul_list') || profileContent.querySelector('ul.xl.xl2.cl');
        if (!actionList) {
            actionList = document.createElement('ul');
            actionList.className = 'xl xl2 cl ul_list';
            profileContent.appendChild(actionList);
        }

        ensureListControls(actionList, meta, { blacklist: 'ul_syysj_blacklist', whitelist: 'ul_syysj_whitelist' });
    }

    // -----------------------------
    // Hover cards / userinfo popups
    // -----------------------------

    function readMetaFromHoverCard(cardNode) {
        if (!cardNode) return null;

        const nameAnchor =
            cardNode.querySelector('.card_mn strong a[href*="home.php?mod=space"]') ||
            cardNode.querySelector('a[href*="home.php?mod=space&uid="]');
        if (!nameAnchor) return null;

        const uid = extractUidFromHref(nameAnchor.getAttribute('href'));
        const name = normalizeText(nameAnchor.textContent);
        const meta = buildMeta(uid, name);

        return meta.userKey ? meta : null;
    }

    function syncGenderFromHoverCard(cardNode, meta) {
        if (!cardNode || !meta || !meta.uid) return;

        const genderNode = cardNode.querySelector('.card_gender_0, .card_gender_1, .card_gender_2');
        if (!genderNode) return;

        const code = extractGenderCodeFromText(genderNode.className);
        if (code === null) return;

        if (writeGenderCode(meta.uid, code)) {
            queueApplyCurrentPage();
        }
    }

    function ensureHoverCardControls() {
        const cards = document.querySelectorAll('div.p_pop.card[id^="card_"][id$="_menu"]');
        cards.forEach((cardNode) => {
            const meta = readMetaFromHoverCard(cardNode);
            if (!meta) return;
            syncGenderFromHoverCard(cardNode, meta);

            const actionHost = cardNode.querySelector('.o.cl') || cardNode.querySelector('.o');
            if (!actionHost) return;

            ensureInlineControls(actionHost, meta);
        });
    }

    function readMetaFromUserInfoPopup(popupNode) {
        if (!popupNode) return null;

        const nameAnchor =
            popupNode.querySelector('.i strong a[href*="home.php?mod=space&uid="]') ||
            popupNode.querySelector('.i.y strong a[href*="home.php?mod=space&uid="]') ||
            popupNode.querySelector('a[href*="home.php?mod=space&uid="]');
        if (!nameAnchor) return null;

        const uid = extractUidFromHref(nameAnchor.getAttribute('href'));
        const name = normalizeText(nameAnchor.textContent);
        const meta = buildMeta(uid, name);

        return meta.userKey ? meta : null;
    }

    function ensureUserInfoPopupControls() {
        const popups = document.querySelectorAll('div.p_pop.blk.bui[id^="userinfo"]');
        popups.forEach((popupNode) => {
            const meta = readMetaFromUserInfoPopup(popupNode);
            if (!meta) return;

            const content = popupNode.querySelector('.i.y') || popupNode.querySelector('.i');
            if (!content) return;

            let container = content.querySelector(':scope > .syysj-userlist-popup');
            if (!container) {
                container = document.createElement('div');
                container.className = 'syysj-userlist-popup';
                content.appendChild(container);
            }

            ensureInlineControls(container, meta);
        });
    }

    function installUserControls() {
        ensureHoverCardControls();
        ensureUserInfoPopupControls();

        if (pageInfo.isViewThread) ensureFavatarControls();
        if (pageInfo.isSpace) ensureSpacePageControls();

        refreshAllToggleLabels();
    }

    function queueInstallUserControls() {
        if (state.installUiQueued) return;

        state.installUiQueued = true;
        window.requestAnimationFrame(() => {
            state.installUiQueued = false;
            installUserControls();
        });
    }

    // -----------------------------
    // Observers
    // -----------------------------

    function observeForumDisplayThreadList() {
        if (!pageInfo.isForumDisplay) return;

        const threadTable = document.getElementById('threadlisttableid');
        if (!threadTable || threadTable.__syysjObserverInstalled) return;

        const observer = new MutationObserver(() => {
            queueApplyForumDisplay();
            queueInstallUserControls();
        });

        observer.observe(threadTable, { childList: true, subtree: true });
        threadTable.__syysjObserverInstalled = true;
    }

    function observeViewThreadPostList() {
        if (!pageInfo.isViewThread) return;

        const postList = document.getElementById('postlist');
        if (!postList || postList.__syysjObserverInstalled) return;

        const observer = new MutationObserver(() => {
            queueApplyViewThread();
            queueInstallUserControls();
        });

        observer.observe(postList, { childList: true, subtree: true });
        postList.__syysjObserverInstalled = true;
    }

    function observeGlobalDynamicNodes() {
        if (state.globalObserverInstalled || !document.body) return;

        const observer = new MutationObserver((mutations) => {
            let shouldInstall = false;

            for (const mutation of mutations) {
                if (!mutation.addedNodes || mutation.addedNodes.length === 0) continue;

                for (const node of mutation.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;

                    if (
                        node.matches('div.p_pop.card[id^="card_"][id$="_menu"]') ||
                        node.matches('div.p_pop.blk.bui[id^="userinfo"]') ||
                        node.querySelector('div.p_pop.card[id^="card_"][id$="_menu"]') ||
                        node.querySelector('div.p_pop.blk.bui[id^="userinfo"]')
                    ) {
                        shouldInstall = true;
                        break;
                    }
                }
                if (shouldInstall) break;
            }

            if (shouldInstall) queueInstallUserControls();
        });

        observer.observe(document.body, { childList: true, subtree: true });
        state.globalObserverInstalled = true;
    }

    function bootstrap() {
        ensureStyle();
        ensureGlobalToggleHandler();
        observeGlobalDynamicNodes();

        if (pageInfo.isForumDisplay) {
            const basePage = getCurrentPageFromLocation();
            seedLoadedThreadKeys(true);
            tagThreadRowsWithPage(basePage);

            ensureToolbar();
            observeForumDisplayThreadList();
            queueApplyForumDisplay();
        }

        if (pageInfo.isViewThread) {
            observeViewThreadPostList();
            queueApplyViewThread();
        }

        queueInstallUserControls();
    }

    bootstrap();
    window.addEventListener('pageshow', bootstrap);
})();
