// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.1.63
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。
// @author       EFate
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/web-element-blocker.user.js%E2%80%8B
// @updateURL    https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/web-element-blocker.meta.js
// ==/UserScript==

(function () {
    'use strict';

    function debounce(func, wait, maxWait) {
        let timeout, lastExec = 0;
        return function (...args) {
            const now = Date.now();
            clearTimeout(timeout);
            if (maxWait && now - lastExec >= maxWait) {
                lastExec = now;
                func.apply(this, args);
            } else {
                timeout = setTimeout(() => { lastExec = Date.now(); func.apply(this, args); }, wait);
            }
        };
    }

    function escapeHTML(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeCSSAttr(s) {
        return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    // 广告域名/关键词通用匹配（在域名扫描与 AdGuard 导出中复用）
    const AD_KEYWORDS = /ads|adnxs|advert|banner|doubleclick|googlesyndication|googleads|google-analytics|googletag|gstatic|googleapis|facebook|fbcdn|twitter|adsystem|amazon-adsystem|outbrain|taboola|mgid|popads|propeller|onclickads|revcontent|yandex|baidu|toutiao|pangolin|gdt|mob|umeng|umengcloud|sentry|analytics|tracking|tracker|stats|metrics|ping|beacon|pixel|logger/i;

    /**
     * 核心数据与配置管理模块
     * 规则分类（前7类按域名隔离，domainBlock全局生效）：
     *   static / dynamic / regex / attribute / structural / complex / pathPattern / domainBlock
     */
    class StorageManager {
        constructor() {
            this.domain = window.location.hostname;
            this.flashList = GM_getValue('pro_blocker_flash_domains', {});
        }

        getData() {
            if (this._cachedData && this._cachedDataDomain === this.domain) return this._cachedData;
            this._cachedDataDomain = this.domain;
            this._cachedData = {
                static: GM_getValue('blocks', {})[this.domain] || [],
                dynamic: GM_getValue('dynamicBlocks', {})[this.domain] || [],
                regex: GM_getValue('regexBlocks', {})[this.domain] || [],
                attribute: GM_getValue('attrBlocks', {})[this.domain] || [],
                structural: GM_getValue('structBlocks', {})[this.domain] || [],
                complex: GM_getValue('complexBlocks', {})[this.domain] || [],
                pathPattern: GM_getValue('pathPatternBlocks', {})[this.domain] || [],
                config: GM_getValue('config', {})[this.domain] || { mode: 'auto' },
                domainBlock: GM_getValue('domainBlocks', [])
            };
            return this._cachedData;
        }

        invalidateDataCache() {
            this._cachedData = null;
            this._cachedDataDomain = null;
        }

        saveData(type, rules) {
            const keyMap = {
                'static': 'blocks', 'dynamic': 'dynamicBlocks', 'regex': 'regexBlocks',
                'attribute': 'attrBlocks', 'structural': 'structBlocks',
                'complex': 'complexBlocks', 'pathPattern': 'pathPatternBlocks'
            };
            const key = keyMap[type];
            if (!key) return;
            const allData = GM_getValue(key, {});
            if (rules.length === 0) delete allData[this.domain];
            else allData[this.domain] = rules;
            GM_setValue(key, allData);
            this.invalidateDataCache();
            BlockEngine.invalidateCache();
            if (type !== 'regex' && type !== 'complex') BlockEngine.applyCSSRules();
        }

        addRule(type, rule) {
            if (type === 'domainBlock') {
                const list = GM_getValue('domainBlocks', []);
                if (rule.domain && !list.includes(rule.domain)) {
                    list.push(rule.domain);
                    GM_setValue('domainBlocks', list);
                    this.invalidateDataCache();
                    BlockEngine.invalidateCache();
                    BlockEngine.applyCSSRules();
                }
                return;
            }
            const data = this.getData()[type];
            const isDuplicate = data.some(item =>
                (type === 'regex' && item.regex === rule.regex && item.level === rule.level) ||
                (type === 'static' && item.selector === rule.selector) ||
                (type === 'dynamic' && item.className === rule.className) ||
                (type === 'attribute' && item.attrSelector === rule.attrSelector) ||
                (type === 'structural' && item.structSelector === rule.structSelector) ||
                (type === 'complex' && JSON.stringify(item.conditions) === JSON.stringify(rule.conditions) && item.level === rule.level) ||
                (type === 'pathPattern' && item.pattern === rule.pattern)
            );
            if (!isDuplicate) {
                data.push(rule);
                this.saveData(type, data);
            }
        }

        removeRule(type, index) {
            if (type === 'domainBlock') {
                const list = GM_getValue('domainBlocks', []);
                if (list[index]) {
                    list.splice(index, 1);
                    GM_setValue('domainBlocks', list);
                    this.invalidateDataCache();
                    BlockEngine.invalidateCache();
                    BlockEngine.applyCSSRules();
                }
                return;
            }
            const data = this.getData()[type];
            if (data[index]) {
                data.splice(index, 1);
                this.saveData(type, data);
            }
        }

        clearDomain() {
            ['blocks', 'dynamicBlocks', 'regexBlocks', 'attrBlocks', 'structBlocks', 'complexBlocks', 'pathPatternBlocks', 'config'].forEach(key => {
                const data = GM_getValue(key, {});
                delete data[this.domain];
                GM_setValue(key, data);
            });
            if (this.flashList[this.domain]) {
                delete this.flashList[this.domain];
                GM_setValue('pro_blocker_flash_domains', this.flashList);
            }
            BlockEngine.invalidateCache();
        }

        exportAll() {
            const exportData = {};
            ['blocks', 'dynamicBlocks', 'regexBlocks', 'attrBlocks', 'structBlocks', 'complexBlocks', 'pathPatternBlocks', 'config', 'pro_blocker_flash_domains'].forEach(key => {
                exportData[key] = GM_getValue(key, {});
            });
            exportData['domainBlocks'] = GM_getValue('domainBlocks', []);
            exportData['__meta__'] = {
                version: '0.9',
                exportTime: new Date().toISOString(),
                exporter: '网页元素屏蔽器'
            };
            return JSON.stringify(exportData, null, 2);
        }

        importAll(jsonStr, merge = true) {
            let importData;
            try {
                importData = JSON.parse(jsonStr);
            } catch (e) {
                throw new Error('JSON 格式错误：' + e.message);
            }
            if (!importData || typeof importData !== 'object') {
                throw new Error('导入数据格式无效');
            }
            if (!merge && !confirm('覆盖导入将清除现有所有规则，确定继续？')) return;

            const dictKeys = ['blocks', 'dynamicBlocks', 'regexBlocks', 'attrBlocks', 'structBlocks', 'complexBlocks', 'pathPatternBlocks', 'config', 'pro_blocker_flash_domains'];
            dictKeys.forEach(key => {
                if (!importData[key] || typeof importData[key] !== 'object') return;
                if (merge) {
                    const existing = GM_getValue(key, {});
                    for (let d in importData[key]) {
                        if (!Object.prototype.hasOwnProperty.call(importData[key], d)) continue;
                        if (!existing[d]) {
                            existing[d] = importData[key][d];
                        } else if (Array.isArray(existing[d]) && Array.isArray(importData[key][d])) {
                            importData[key][d].forEach(item => {
                                if (item && typeof item === 'object' && !existing[d].some(x => JSON.stringify(x) === JSON.stringify(item))) {
                                    existing[d].push(item);
                                }
                            });
                        } else {
                            existing[d] = importData[key][d];
                        }
                    }
                    GM_setValue(key, existing);
                } else {
                    GM_setValue(key, importData[key]);
                }
            });
            if (Array.isArray(importData['domainBlocks'])) {
                const validDomains = importData['domainBlocks'].filter(d => typeof d === 'string' && d.length > 0 && d.length < 200);
                if (merge) {
                    const existing = GM_getValue('domainBlocks', []);
                    validDomains.forEach(d => {
                        if (!existing.includes(d)) existing.push(d);
                    });
                    GM_setValue('domainBlocks', existing);
                } else {
                    GM_setValue('domainBlocks', validDomains);
                }
            }
            BlockEngine.invalidateCache();
            this.invalidateDataCache();
            BlockEngine.applyCSSRules();
            BlockEngine.applyRegexRules();
            BlockEngine.applyComplexRules();
        }

        markAsFlashing() {
            if (!this.flashList[this.domain]) {
                this.flashList[this.domain] = true;
                GM_setValue('pro_blocker_flash_domains', this.flashList);
            }
        }

        toggleMode() {
            const currentMode = this.getData().config.mode;
            const nextMode = currentMode === 'auto' ? 'preemptive' : 'auto';
            const allConfig = GM_getValue('config', {});
            allConfig[this.domain] = { mode: nextMode };
            GM_setValue('config', allConfig);
            this.invalidateDataCache();
            return nextMode;
        }
    }

    const storage = new StorageManager();

    /**
     * 拦截引擎：DOM/CSS 控制 + 动态扫描
     */
    class BlockEngine {
        static styleElementId = 'pro-blocker-core-css';
        static _cachedDomainList = null;
        static _cachedPathPatterns = null;
        static _loggedDomains = new Set();
        static _loggedPatterns = new Set();
        static _addedNodesBuffer = [];

        static invalidateCache() {
            this._cachedDomainList = null;
            this._cachedPathPatterns = null;
        }

        // 始终在 document-start 注入 CSS，确保广告在首次渲染前即被隐藏
        static fastInject() {
            this.applyCSSRules();
            // documentElement 此刻可能尚未就绪，下一帧重试一次确保 CSS 落地
            if (!document.documentElement) {
                requestAnimationFrame(() => this.applyCSSRules());
            }
        }

        static applyCSSRules() {
            const data = storage.getData();
            let cssText = '';
            const hideCSS = '{ display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -2147483648 !important; height: 0 !important; width: 0 !important; position: absolute !important; }\n';

            data.static.forEach(r => r.selector && (cssText += `${r.selector} ${hideCSS}`));
            data.dynamic.forEach(r => {
                if (!r.className) return;
                const token = r.className.split(/\s+/).filter(Boolean)[0];
                if (token) cssText += `[class*="${escapeCSSAttr(token)}"] ${hideCSS}`;
            });
            data.attribute.forEach(r => r.attrSelector && (cssText += `${r.attrSelector} ${hideCSS}`));
            data.structural.forEach(r => r.structSelector && (cssText += `${r.structSelector} ${hideCSS}`));

            // 全局域名黑名单：覆盖所有可能携带资源 URL 的属性（含 srcset）
            data.domainBlock.forEach(domain => {
                if (!domain) return;
                const esc = escapeCSSAttr(domain);
                cssText += `[src*="${esc}"] ${hideCSS}`;
                cssText += `[href*="${esc}"] ${hideCSS}`;
                cssText += `[data-src*="${esc}"] ${hideCSS}`;
                cssText += `[data-original*="${esc}"] ${hideCSS}`;
                cssText += `[poster*="${esc}"] ${hideCSS}`;
                cssText += `[srcset*="${esc}"] ${hideCSS}`;
            });

            // 路径模式拦截：典型广告跳转路径，如 /000/flink/url.php
            data.pathPattern.forEach(r => {
                if (r.pattern) {
                    const esc = escapeCSSAttr(r.pattern);
                    cssText += `[href*="${esc}"] ${hideCSS}`;
                    cssText += `[src*="${esc}"] ${hideCSS}`;
                    cssText += `[data-src*="${esc}"] ${hideCSS}`;
                }
            });

            if (!cssText) return;

            // document-start 阶段 documentElement 可能尚未就绪，做安全检查避免抛错
            const parent = document.head || document.documentElement;
            if (!parent) return;

            let styleEl = document.getElementById(this.styleElementId);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = this.styleElementId;
                if (parent.firstChild) {
                    parent.insertBefore(styleEl, parent.firstChild);
                } else {
                    parent.appendChild(styleEl);
                }
            }
            if (styleEl.textContent !== cssText) {
                styleEl.textContent = cssText;
            }
        }

        /**
         * 动态拦截核心：扫描新增节点的资源域与路径模式，命中则隐藏整个广告容器
         * 解决"刷新就复活"——动态生成的广告无法靠固定CSS规则拦截
         */
        static scanAndBlockDynamic(node, cachedDomainList, cachedPathPatterns) {
            const domainList = cachedDomainList !== undefined ? cachedDomainList : (this._cachedDomainList !== null ? this._cachedDomainList : GM_getValue('domainBlocks', []));
            const pathPatterns = cachedPathPatterns !== undefined ? cachedPathPatterns : (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern);
            if (this._cachedDomainList === null) this._cachedDomainList = domainList;
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = pathPatterns;
            if (domainList.length === 0 && pathPatterns.length === 0) return;
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

            const elements = [node];
            try {
                node.querySelectorAll && node.querySelectorAll('img, iframe, video, script, a, source, embed, object').forEach(el => elements.push(el));
            } catch (e) { }

            const currentHost = window.location.hostname;

            elements.forEach(el => {
                let blocked = false;
                let matchedDomain = '';
                let matchedPattern = '';

                // 收集所有可能的资源 URL（含 srcset 多 URL 拆分）
                const urls = [
                    el.src,
                    el.href,
                    el.getAttribute && el.getAttribute('data-src'),
                    el.getAttribute && el.getAttribute('data-original'),
                    el.getAttribute && el.getAttribute('poster')
                ].filter(Boolean);

                const srcset = el.getAttribute && el.getAttribute('srcset');
                if (srcset) {
                    srcset.split(',').forEach(part => {
                        const url = part.trim().split(/\s+/)[0];
                        if (url) urls.push(url);
                    });
                }

                for (let url of urls) {
                    try {
                        for (let p of pathPatterns) {
                            if (p.pattern && url.includes(p.pattern)) {
                                blocked = true;
                                matchedPattern = p.pattern;
                                break;
                            }
                        }
                        if (blocked) break;

                        let absUrl = url;
                        if (url.startsWith('//')) absUrl = location.protocol + url;
                        if (absUrl.startsWith('http')) {
                            const urlObj = new URL(absUrl);
                            if (urlObj.hostname && urlObj.hostname !== currentHost && !urlObj.hostname.endsWith('.' + currentHost)) {
                                if (domainList.some(d => urlObj.hostname === d || urlObj.hostname.endsWith('.' + d))) {
                                    blocked = true;
                                    matchedDomain = urlObj.hostname;
                                    break;
                                }
                            }
                        }
                    } catch (e) { }
                }

                if (blocked) {
                    const target = this.findSingleChildWrapper(el, 4);
                    target.style.setProperty('display', 'none', 'important');
                    target.style.setProperty('opacity', '0', 'important');
                    target.style.setProperty('visibility', 'hidden', 'important');
                    target.style.setProperty('pointer-events', 'none', 'important');
                    if (matchedDomain && !this._loggedDomains.has(matchedDomain)) {
                        this._loggedDomains.add(matchedDomain);
                        console.info(`[Pro Blocker] 动态拦截域名: ${matchedDomain}`);
                    }
                    if (matchedPattern && !this._loggedPatterns.has(matchedPattern)) {
                        this._loggedPatterns.add(matchedPattern);
                        console.info(`[Pro Blocker] 动态拦截路径: ${matchedPattern}`);
                    }
                }
            });
        }

        static _regexCache = new Map();

        static getCompiledRegex(pattern) {
            if (this._regexCache.has(pattern)) return this._regexCache.get(pattern);
            try {
                const regex = new RegExp(pattern);
                this._regexCache.set(pattern, regex);
                return regex;
            } catch (e) {
                this._regexCache.set(pattern, null);
                return null;
            }
        }

        static applyRegexRules(targetNode = document.body) {
            const data = storage.getData();
            if (!data.regex || data.regex.length === 0 || !targetNode) return;

            data.regex.forEach(rule => {
                const regex = this.getCompiledRegex(rule.regex);
                if (!regex) return;
                try {
                    const walker = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    while ((node = walker.nextNode())) {
                        if (regex.test(node.textContent)) {
                            let element = node.parentElement;
                            for (let i = 0; i < rule.level; i++) {
                                if (element.parentElement && element.parentElement !== document.body) {
                                    element = element.parentElement;
                                } else break;
                            }
                            if (element && element.style.display !== 'none') {
                                element.style.setProperty('display', 'none', 'important');
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Pro Blocker] 正则解析异常:', e);
                }
            });
        }

        static applyComplexRules(targetNode = document.body) {
            const data = storage.getData();
            if (!data.complex || data.complex.length === 0 || !targetNode) return;

            const root = targetNode.nodeType === Node.ELEMENT_NODE ? targetNode : targetNode.parentElement;
            if (!root) return;

            data.complex.forEach(rule => {
                try {
                    let baseSelector = '*';
                    const simpleParts = [];
                    if (rule.logic === 'AND') {
                        rule.conditions.forEach(c => {
                            if (c.type === 'class' && (c.operator === 'contains' || c.operator === 'equals')) simpleParts.push(`[class*="${escapeCSSAttr(c.value)}"]`);
                            if (c.type === 'id' && c.operator === 'equals') simpleParts.push(`[id="${escapeCSSAttr(c.value)}"]`);
                            if (c.type === 'id' && c.operator === 'contains') simpleParts.push(`[id*="${escapeCSSAttr(c.value)}"]`);
                        });
                        if (simpleParts.length > 0) baseSelector = `*${simpleParts.join('')}`;
                    }

                    const elements = baseSelector === '*'
                        ? root.querySelectorAll('div, span, a, p, img, li, ul, iframe, section, article, aside')
                        : root.querySelectorAll(baseSelector);

                    elements.forEach(el => {
                        if (baseSelector === '*' && (el.textContent || '').length > 3000) return;

                        const results = rule.conditions.map(c => {
                            let val = '';
                            if (c.type === 'text') val = el.textContent || '';
                            else if (c.type === 'class') val = typeof el.className === 'string' ? el.className : '';
                            else if (c.type === 'id') val = el.id || '';

                            if (c.operator === 'contains') return val.includes(c.value);
                            if (c.operator === 'not_contains') return val !== '' && !val.includes(c.value);
                            if (c.operator === 'equals') return val.trim() === c.value.trim();
                            return false;
                        });

                        const isMatch = rule.logic === 'AND' ? results.every(r => r) : results.some(r => r);

                        if (isMatch) {
                            let target = el;
                            for (let i = 0; i < rule.level; i++) {
                                if (target.parentElement && target.parentElement !== document.body && target.parentElement !== document.documentElement) {
                                    target = target.parentElement;
                                } else break;
                            }
                            if (target.style.display !== 'none') {
                                target.style.setProperty('display', 'none', 'important');
                                target.style.setProperty('opacity', '0', 'important');
                            }
                        }
                    });
                } catch (e) {
                    console.error('[Pro Blocker] 积木规则执行错误:', e);
                }
            });
        }

        static startObserver() {
            // 监听这些资源属性的变化，捕获懒加载广告（src 在元素插入后才被 JS 设置）
            const RESOURCE_ATTRS = ['src', 'href', 'data-src', 'data-original', 'poster', 'srcset'];

            // 正则/积木规则较重，去抖执行；缩短到 120ms/600ms 让广告闪现时间最短
            const debouncedDynamicApply = debounce(() => {
                const rawNodes = this._addedNodesBuffer;
                this._addedNodesBuffer = [];
                if (rawNodes.length === 0) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                    return;
                }
                // 过滤游离节点 + 去除嵌套（子节点会被父节点的子树扫描覆盖）
                const nodes = rawNodes.filter(n =>
                    document.contains(n) && !rawNodes.some(other => other !== n && other.contains(n))
                );
                if (nodes.length === 0) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                } else {
                    nodes.forEach(node => {
                        this.applyRegexRules(node);
                        this.applyComplexRules(node);
                    });
                }
            }, 120, 600);

            // 批量获取缓存的域名/路径列表，避免每个 mutation 重复读取存储
            const getLists = () => {
                if (this._cachedDomainList === null) this._cachedDomainList = GM_getValue('domainBlocks', []);
                if (this._cachedPathPatterns === null) this._cachedPathPatterns = storage.getData().pathPattern;
                return { domainList: this._cachedDomainList, pathPatterns: this._cachedPathPatterns };
            };

            const observer = new MutationObserver((mutations) => {
                let hasAddedNodes = false;
                const batchNodes = [];
                const attrNodes = new Set();
                for (let mutation of mutations) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        hasAddedNodes = true;
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                batchNodes.push(node);
                                this._addedNodesBuffer.push(node);
                            }
                        });
                    } else if (mutation.type === 'attributes' && mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
                        // 属性变化：懒加载广告在元素插入后才设置 src/data-src，需立即扫描容器
                        attrNodes.add(mutation.target);
                    }
                }
                if (hasAddedNodes || attrNodes.size > 0) {
                    const { domainList, pathPatterns } = getLists();
                    // 新增节点 + 属性变更节点立即扫描域名/路径（不等去抖，避免广告闪现）
                    if (domainList.length > 0 || pathPatterns.length > 0) {
                        batchNodes.forEach(node => this.scanAndBlockDynamic(node, domainList, pathPatterns));
                        attrNodes.forEach(node => this.scanAndBlockDynamic(node, domainList, pathPatterns));
                    }
                    // 正则/积木规则仅在新增节点时去抖执行（属性变化不改文本内容，无需重跑）
                    if (hasAddedNodes) debouncedDynamicApply();
                }
            });

            // head 就绪时立即把 style 移入 head 并应用规则，比等 body 更早
            const ensureStyleInHead = () => {
                const styleEl = document.getElementById(this.styleElementId);
                if (styleEl && document.head && styleEl.parentElement !== document.head) {
                    document.head.insertBefore(styleEl, document.head.firstChild);
                    this.applyCSSRules();
                }
            };

            if (document.head) {
                ensureStyleInHead();
            } else {
                const headObserver = new MutationObserver(() => {
                    if (document.head) {
                        headObserver.disconnect();
                        ensureStyleInHead();
                    }
                });
                headObserver.observe(document.documentElement, { childList: true });
            }

            // 立即在 documentElement 上启动观察器（不等 body，覆盖 head 阶段注入的早期广告）
            // 这是解决"首次进入广告未过滤、需刷新"的关键：原来等 body 才观察，会漏掉 body 之前注入的节点
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: RESOURCE_ATTRS
            });

            // body 就绪后立即做全量扫描（不等 DOMContentLoaded，消除监控盲区）
            const doInitialScan = () => {
                this.applyCSSRules();
                if (document.body) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                    this.scanAndBlockDynamic(document.body);
                }
            };

            if (document.body) {
                doInitialScan();
            } else {
                const bodyObserver = new MutationObserver(() => {
                    if (document.body) {
                        bodyObserver.disconnect();
                        doInitialScan();
                    }
                });
                bodyObserver.observe(document.documentElement, { childList: true });
            }

            // DOMContentLoaded 时做一次全量补充扫描
            window.addEventListener('DOMContentLoaded', () => {
                this.applyCSSRules();
                this.applyRegexRules();
                this.applyComplexRules();
                if (document.body) this.scanAndBlockDynamic(document.body);
            });

            // 页面完全加载后再做一次兜底扫描
            window.addEventListener('load', () => {
                this.applyCSSRules();
                this.applyRegexRules();
                this.applyComplexRules();
                if (document.body) this.scanAndBlockDynamic(document.body);
            });

            // SPA 路由变化时重新应用规则（解决点击链接不刷新导致广告漏网）
            let _lastUrl = location.href;
            const reapplyOnNavigation = () => {
                if (location.href === _lastUrl) return;
                _lastUrl = location.href;
                this.applyCSSRules();
                this.applyRegexRules();
                this.applyComplexRules();
                if (document.body) this.scanAndBlockDynamic(document.body);
            };
            window.addEventListener('popstate', reapplyOnNavigation);
            window.addEventListener('hashchange', reapplyOnNavigation);

            // 额外兜底：某些 SPA 通过 history.pushState 导航，劫持它以触发重应用
            const _pushState = history.pushState;
            history.pushState = function (...args) {
                _pushState.apply(this, args);
                setTimeout(() => reapplyOnNavigation(), 0);
            };
            const _replaceState = history.replaceState;
            history.replaceState = function (...args) {
                _replaceState.apply(this, args);
                setTimeout(() => reapplyOnNavigation(), 0);
            };
        }

        static generateOptimalSelector(element) {
            if (element.id && !/^\d/.test(element.id) && !/[a-zA-Z0-9]{8,}/.test(element.id)) return `#${CSS.escape(element.id)}`;
            let path = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'body' && current.tagName.toLowerCase() !== 'html') {
                let selector = current.tagName.toLowerCase();
                if (current.className && typeof current.className === 'string') {
                    const classes = current.className.trim().split(/\s+/).filter(c => /^[a-zA-Z][a-zA-Z0-9\-_]*$/.test(c) && !/[a-zA-Z0-9]{10,}/.test(c));
                    if (classes.length > 0) selector += '.' + classes.map(c => CSS.escape(c)).join('.');
                }
                let sibling = current, nth = 1;
                while (sibling = sibling.previousElementSibling) {
                    if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) nth++;
                }
                if (nth > 1) selector += `:nth-of-type(${nth})`;
                path.unshift(selector);
                current = current.parentElement;
            }
            return path.join(' > ');
        }

        static generateStructuralSelector(element) {
            let path = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current.tagName.toLowerCase() !== 'html') {
                let tagName = current.tagName.toLowerCase();
                if (tagName === 'body') {
                    path.unshift('body');
                    break;
                }
                if (current.id && !/^\d/.test(current.id) && !/[a-zA-Z0-9]{8,}/.test(current.id)) {
                    path.unshift(`#${CSS.escape(current.id)}`);
                    break;
                }
                let nth = 1, sibling = current.previousElementSibling;
                while (sibling) { if (sibling.tagName === current.tagName) nth++; sibling = sibling.previousElementSibling; }
                path.unshift(`${tagName}:nth-of-type(${nth})`);
                current = current.parentElement;
            }
            return path.join(' > ');
        }

        /**
         * 资源域识别：默认进行轻量扫描（src/href/srcset/内联样式）。
         * 当 deep=true 且扫描对象为 document.documentElement 时，额外扫描样式表、
         * 数据属性、script 文本/JSON 配置与全局变量中暴露的广告域。
         * 返回带置信度与来源说明的结果，便于用户判断。
         */
        static extractResourceDomains(element, options = {}) {
            const { deep = false, includeScripts = true, includeStyles = true } = options;
            const isFullPage = element === document.documentElement;
            const urls = new Set();
            const domainMeta = new Map(); // domain -> {score, sources:Set, reasons:Set}
            if (!element) return { urls: [], domains: [], scoredDomains: [] };

            const KNOWN_SAFE_CDNS = new Set([
                'ajax.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
                'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'code.jquery.com',
                'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com', 'cdn.bootcss.com',
                'staticfile.org', 'cdn.staticfile.org', 'www.google.com', 'www.recaptcha.net',
                'challenges.cloudflare.com', 'hcaptcha.com', 'static.cloudflareinsights.com'
            ]);

            const addUrl = (url, source = 'attr', reason = '') => {
                if (!url || typeof url !== 'string') return;
                if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:')) return;
                let absUrl = url;
                if (url.startsWith('//')) absUrl = location.protocol + url;
                if (!absUrl.startsWith('http')) return;
                try {
                    const urlObj = new URL(absUrl);
                    if (!urlObj.hostname) return;
                    urls.add(url);
                    const host = urlObj.hostname.toLowerCase();
                    if (host === window.location.hostname || host.endsWith('.' + window.location.hostname)) return;
                    if (!domainMeta.has(host)) domainMeta.set(host, { score: 0, sources: new Set(), reasons: new Set(), count: 0 });
                    const meta = domainMeta.get(host);
                    meta.count++;
                    meta.sources.add(source);
                    if (reason) meta.reasons.add(reason);
                } catch (e) { }
            };

            const scanString = (str, source) => {
                if (!str || typeof str !== 'string') return;
                const urlLike = str.match(/https?:\/\/[^\s"'<>(){}]+/gi);
                if (urlLike) urlLike.forEach(u => addUrl(u, source));
            };

            const collect = (el) => {
                if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
                const attrSources = ['src', 'href', 'data-src', 'data-original', 'poster', 'data-href', 'data-url', 'data-link', 'data-bg', 'data-image', 'data-thumb', 'data-poster', 'data-lazy', 'data-lazy-src', 'data-srcset', 'srcset'];
                attrSources.forEach(attr => {
                    const val = el.getAttribute(attr);
                    if (val) {
                        if (attr === 'srcset') {
                            val.split(',').forEach(part => addUrl(part.trim().split(/\s+/)[0], 'srcset'));
                        } else {
                            addUrl(val, 'attr', attr);
                        }
                    }
                });
                if (includeStyles) {
                    const inlineBg = el.style && el.style.backgroundImage;
                    if (inlineBg && inlineBg.includes('url(')) {
                        const matches = inlineBg.match(/url\(["']?([^"')]+)["']?\)/g);
                        if (matches) matches.forEach(m => addUrl(m.replace(/url\(["']?|["']?\)/g, ''), 'inline-style'));
                    }
                }
                if (deep) {
                    Array.from(el.attributes).forEach(attr => {
                        if (attr.name.startsWith('data-') && /^(https?:)?\/\//.test(attr.value)) {
                            addUrl(attr.value, 'data-attr', attr.name);
                        }
                    });
                }
            };

            collect(element);
            try {
                const selectors = deep
                    ? '*'
                    : 'img, iframe, video, source, embed, a, script, link, div, section, article, aside, span';
                element.querySelectorAll && element.querySelectorAll(selectors).forEach(collect);
            } catch (e) { }

            if (deep && includeStyles && isFullPage) {
                try {
                    Array.from(document.styleSheets).forEach(sheet => {
                        let rules;
                        try { rules = sheet.cssRules || sheet.rules; } catch (e) { return; }
                        if (!rules) return;
                        Array.from(rules).forEach(rule => {
                            try {
                                const cssText = rule.cssText || '';
                                const matches = cssText.match(/url\(["']?([^"')]+)["']?\)/g);
                                if (matches) matches.forEach(m => addUrl(m.replace(/url\(["']?|["']?\)/g, ''), 'stylesheet'));
                            } catch (e) { }
                        });
                    });
                } catch (e) { }
            }

            if (deep && includeScripts && isFullPage) {
                try {
                    document.querySelectorAll('script').forEach(script => {
                        const text = script.textContent || '';
                        scanString(text, 'script-text');
                        if (text.includes('window.') || text.includes('var ') || text.includes('let ') || text.includes('const ')) {
                            const domainMatches = text.match(/["']([a-z0-9-]+\.(?:com|cn|net|org|io|cc|tv|xyz|top|club|info|site|vip|icu|asia|app|dev|co|me|mobi|us|biz|ru|jp|tw|hk|uk|de|fr|br|au))["']/gi);
                            if (domainMatches) domainMatches.forEach(d => addUrl('https://' + d.replace(/["']/g, ''), 'script-var'));
                        }
                    });
                } catch (e) { }
            }

            domainMeta.forEach((meta, host) => {
                let score = 0;
                if (AD_KEYWORDS.test(host)) score += 40;
                if (meta.sources.has('script-text') || meta.sources.has('script-var')) score += 20;
                if (meta.sources.has('inline-style') || meta.sources.has('stylesheet')) score += 10;
                if (meta.sources.has('srcset') || meta.sources.has('attr')) score += 10;
                if (meta.sources.has('data-attr')) score += 15;
                score += Math.min(meta.count * 2, 20);
                if (KNOWN_SAFE_CDNS.has(host)) score -= 30;
                if (host === window.location.hostname || host.endsWith('.' + window.location.hostname)) score -= 1000;
                meta.score = Math.max(0, score);
            });

            const scoredDomains = Array.from(domainMeta.entries())
                .filter(([, meta]) => meta.score > 0)
                .sort((a, b) => b[1].score - a[1].score)
                .map(([host, meta]) => ({
                    host,
                    score: meta.score,
                    sources: Array.from(meta.sources),
                    reasons: Array.from(meta.reasons),
                    count: meta.count
                }));

            return { urls: Array.from(urls), domains: scoredDomains.map(d => d.host), scoredDomains };
        }

        static isSafeOutermost(element) {
            if (!element || !element.parentElement) return true;
            const parent = element.parentElement;
            if (parent === document.body || parent === document.documentElement) return true;
            return false;
        }

        /**
         * 沿单子链向上查找包裹容器：父级仅含一个元素子节点时继续向上
         * 遇到多子分支或 body/html 时停止。maxDepth 防止极端深度
         */
        static findSingleChildWrapper(element, maxDepth = 6) {
            let target = element;
            let depth = 0;
            while (target.parentElement &&
                target.parentElement !== document.body &&
                target.parentElement !== document.documentElement &&
                depth < maxDepth) {
                const parent = target.parentElement;
                if (parent.children.length === 1) {
                    target = parent;
                    depth++;
                } else break;
            }
            return target;
        }

        /**
         * 智能查找广告最外层容器：沿单子链向上，遇到多子分支即停止
         */
        static findOutermostAdContainer(element) {
            return this.findSingleChildWrapper(element, 50);
        }
    }

    /**
     * 用户交互界面：基于 Shadow DOM 隔离
     */
    class UIManager {
        constructor() {
            const existingHost = document.getElementById('pro-blocker-ui-host');
            if (existingHost) existingHost.remove();

            this.shadowHost = document.createElement('div');
            this.shadowHost.id = 'pro-blocker-ui-host';
            this.shadowHost.style.cssText = 'position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; overflow: visible;';
            this.shadowRoot = this.shadowHost.attachShadow({ mode: 'closed' });
            this.injectStyles();
            document.documentElement.appendChild(this.shadowHost);

            this.highlightEl = null;
            this.currentSelectedEl = null;
            this.originalSelectedEl = null;
            this.selectionStack = [];
            this._previewAffectedElements = [];
            this._actionPreview = { active: false, el: null };
            this._contextmenuHandler = null;
            this._handleMouseOver = this._handleMouseOver.bind(this);
            this._handleClick = this._handleClick.bind(this);
        }

        injectStyles() {
            const style = document.createElement('style');
            style.textContent = `
                :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                .panel {
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(25, 25, 30, 0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255,255,255,0.16); padding: 20px; border-radius: 16px;
                    box-shadow: 0 20px 64px rgba(0,0,0,0.42), inset 0 0 0 1px rgba(255,255,255,0.07);
                    width: min(480px, calc(100vw - 48px));
                    max-width: calc(100vw - 48px);
                    max-height: min(720px, 76vh); overflow-y: auto; color: #eee; text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                    box-sizing: border-box;
                }
                @media (max-width: 600px) {
                    .panel { background: rgba(25, 25, 30, 0.52); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); max-width: calc(100vw - 48px); max-height: 70vh; padding: 16px; }
                }
                h3 {
                    margin-top: 0; font-size: 17px; font-weight: 600; color: #fff; margin-bottom: 14px;
                    border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 10px; cursor: grab; user-select: none;
                }
                h3:active { cursor: grabbing; }
                p { font-size: 13px; margin: 0 0 12px 0; color: #ccc; line-height: 1.5; word-break: break-all; }
                .code-box {
                    background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255,255,255,0.1); padding: 8px 10px; border-radius: 6px;
                    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px;
                    margin-top: 4px; display: block; max-height: 96px; overflow-y: auto; word-break: break-all;
                    line-height: 1.5; color: #ddd;
                }
                .btn-group { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
                button {
                    padding: 9px 12px; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; cursor: pointer;
                    font-size: 13px; font-weight: 500; transition: filter 0.15s, transform 0.1s; flex: 1;
                    display: flex; align-items: center; justify-content: center; line-height: 1.2;
                    background: rgba(255,255,255,0.1); color: #fff; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                    text-shadow: 0 1px 2px rgba(0,0,0,0.4);
                }
                button:hover:not(:disabled) { filter: brightness(1.15); transform: translateY(-1px); }
                button:active:not(:disabled) { transform: translateY(0); filter: brightness(0.95); }
                button:disabled { opacity: 0.25; cursor: not-allowed; }
                .btn-primary { background: rgba(0,122,255,0.72); color: #fff; }
                .btn-success { background: rgba(52,199,89,0.72); color: #fff; }
                .btn-danger { background: rgba(255,59,48,0.72); color: #fff; }
                .btn-warning { background: rgba(255,149,0,0.72); color: #fff; }
                .btn-dark { background: rgba(80,86,94,0.72); color: #fff; }
                .btn-info { background: rgba(23,162,184,0.72); color: #fff; }
                .btn-outline { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25); color: #fff; }

                label { font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px; color: #ddd; }
                input[type="text"], input[type="number"], select, textarea {
                    width: 100%; padding: 10px; margin-bottom: 14px; border: 1px solid rgba(255,255,255,0.14);
                    border-radius: 8px; box-sizing: border-box; outline: none; font-size: 14px;
                    transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit;
                    background: rgba(0,0,0,0.25); color: #eee;
                }
                input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
                    border-color: #4aa3ff; box-shadow: 0 0 0 3px rgba(74,163,255,0.18);
                }
                textarea { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; resize: vertical; min-height: 140px; }

                .rule-list { list-style: none; padding: 0; margin: 0; }
                .rule-item {
                    display: flex; justify-content: space-between; align-items: center; gap: 8px;
                    padding: 10px 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 8px; margin-bottom: 6px; font-size: 12px; word-break: break-all;
                    color: #eee;
                }
                .rule-content { flex: 1; padding-right: 6px; }
                .tag { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: rgba(255,255,255,0.12); margin-right: 6px; font-weight: bold; white-space: nowrap; color: #fff; }
                .tag.attr { background: rgba(225,190,231,0.35); color: #f3e5f5; }
                .tag.struct { background: rgba(255,224,130,0.35); color: #fff8e1; }
                .tag.complex { background: rgba(227,242,253,0.35); color: #e3f2fd; }
                .tag.domain { background: rgba(255,205,210,0.35); color: #ffebee; }
                .tag.path { background: rgba(200,230,201,0.35); color: #e8f5e9; }
                .status-bar { padding: 11px 12px; background: rgba(255,255,255,0.06); border-radius: 8px; margin-bottom: 14px; font-size: 12px; border: 1px solid rgba(255,255,255,0.1); line-height: 1.7; color: #ccc; }

                .zoom-bar {
                    display: flex; gap: 6px; padding: 8px; background: rgba(255,193,7,0.1);
                    border: 1px solid rgba(255,193,7,0.35); border-radius: 10px; margin-bottom: 12px; align-items: center;
                }
                .zoom-bar button { flex: 1; padding: 8px 6px; font-size: 13px; font-weight: 600; }
                .zoom-bar button#btn-zoom-reset { flex: 0 0 auto; padding: 8px 12px; }

                .selection-info {
                    background: rgba(255,255,255,0.06); border-left: 4px solid #FF6F00; padding: 11px 12px;
                    border-radius: 6px; margin-bottom: 12px; font-size: 12px; line-height: 1.6; color: #ddd;
                }
                .selection-info .info-row { margin: 4px 0; }
                .selection-info .info-label { font-weight: 600; color: #ffb74d; display: block; margin-top: 6px; margin-bottom: 2px; }
                .selection-info .info-row:first-child .info-label { margin-top: 0; }
                .selection-info .domain-item {
                    display: inline-block; background: rgba(255,111,0,0.7); color: white;
                    padding: 2px 9px; border-radius: 12px; margin: 3px 4px 0 0; font-size: 11px;
                    word-break: break-all; font-weight: 500; cursor: pointer; transition: filter 0.15s;
                }
                .selection-info .domain-item:hover { filter: brightness(1.15); }
                .domain-scroll { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; padding-right: 4px; }
                .domain-scroll .domain-item { display: flex; justify-content: space-between; align-items: center; width: 100%; box-sizing: border-box; margin: 0; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
                .domain-scroll::-webkit-scrollbar { width: 4px; }
                .domain-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
                .safe-flag {
                    display: inline-block; background: rgba(40,167,69,0.75); color: white;
                    padding: 2px 9px; border-radius: 12px; font-size: 10px; margin-left: 6px; font-weight: 600;
                }
                .level-info { color: #ffd54f; }
                .level-info b { color: #ff8a80; font-size: 13px; }

                .section-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 14px 0 10px; }
                .empty-tip { text-align: center; color: #aaa; margin: 24px 0; font-size: 13px; }

                .gd-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
                .gd-toolbar input { flex: 1; min-width: 120px; margin-bottom: 0; }
                .gd-toolbar label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #ccc; margin-bottom: 0; cursor: pointer; }
                .gd-toolbar label input[type="checkbox"] { width: auto; margin: 0; }
                .gd-toolbar button { flex: none; padding: 7px 10px; font-size: 12px; }
                .gd-stats { font-size: 11px; color: #aaa; margin-bottom: 8px; }
                .gd-domain-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: background 0.15s; }
                .gd-domain-row:hover { background: rgba(255,255,255,0.12); }
                .gd-domain-row.selected { border-color: rgba(255,111,0,0.7); background: rgba(255,111,0,0.18); }
                .gd-domain-row .gd-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
                .gd-domain-row .gd-check { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #fff; flex: none; }
                .gd-domain-row.selected .gd-check { background: #ff6f00; border-color: #ff6f00; }
                .gd-domain-row .gd-host { font-size: 12px; word-break: break-all; color: #fff; }
                .gd-domain-row .gd-meta { font-size: 10px; color: #aaa; margin-top: 2px; }
                .gd-domain-row .gd-score { flex: none; font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
                .gd-score.high { background: rgba(255,59,48,0.65); color: #fff; }
                .gd-score.mid { background: rgba(255,149,0,0.65); color: #fff; }
                .gd-score.low { background: rgba(120,144,156,0.55); color: #fff; }
                .gd-manual { display: flex; gap: 8px; margin-top: 10px; }
                .gd-manual input { flex: 1; margin-bottom: 0; }
                .gd-manual button { flex: none; }
                .export-box { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 10px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow-y: auto; color: #eee; margin-bottom: 12px; }
                .hint-text { font-size: 11px; color: #aaa; margin: -8px 0 10px; line-height: 1.5; }

                @media (max-width: 480px) {
                    .panel { padding: 16px; border-radius: 14px; max-height: 72vh; }
                    .panel h3 { font-size: 15px; }
                    .panel p, .panel .hint-text { font-size: 12px; }
                    .btn-group button { padding: 8px 10px; font-size: 12px; }
                    .gd-domain-row { padding: 8px; }
                    .gd-domain-row .gd-host { font-size: 11px; }
                }
            `;
            this.shadowRoot.appendChild(style);
        }

        injectHighlightStyle() {
            let style = document.getElementById('pro-blocker-highlight-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'pro-blocker-highlight-style';
                style.textContent = `
                    .pro-blocker-highlight {
                        outline: 3px solid #FF3B30 !important; outline-offset: -3px !important;
                        background-color: rgba(255, 59, 48, 0.15) !important; cursor: crosshair !important;
                        transition: outline 0.1s ease-in-out !important; box-shadow: 0 0 10px rgba(255,59,48,0.5) !important;
                    }
                    /* 当前选中元素：加粗红框 + 多层发光，十分明显 */
                    .pro-blocker-selected {
                        outline: 6px solid #FF0000 !important; outline-offset: -6px !important;
                        background-color: rgba(255, 0, 0, 0.03) !important;
                        box-shadow: 0 0 0 3px #FF0000, 0 0 0 7px rgba(255,0,0,0.35), 0 0 30px rgba(255,0,0,0.9) !important;
                    }
                `;
                (document.head || document.documentElement).appendChild(style);
            }
        }

        makeDraggable(panel) {
            const header = panel.querySelector('h3');
            if (!header) return;

            let isDragging = false;
            let startX, startY, initialLeft, initialTop;

            const onMouseDown = (e) => {
                if (e.target.closest('button, input, select, textarea')) return;
                if (e.target !== header && !header.contains(e.target)) return;
                isDragging = true;
                const rect = panel.getBoundingClientRect();
                panel.style.transform = 'none';
                panel.style.left = rect.left + 'px';
                panel.style.top = rect.top + 'px';
                startX = e.clientX;
                startY = e.clientY;
                initialLeft = rect.left;
                initialTop = rect.top;
                e.preventDefault();
            };

            const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
            const onMouseMove = (e) => {
                if (!isDragging) return;
                const rect = panel.getBoundingClientRect();
                const padding = 24;
                let nextLeft = initialLeft + (e.clientX - startX);
                let nextTop = initialTop + (e.clientY - startY);
                nextLeft = clamp(nextLeft, padding, window.innerWidth - rect.width - padding);
                nextTop = clamp(nextTop, padding, window.innerHeight - rect.height - padding);
                panel.style.left = `${nextLeft}px`;
                panel.style.top = `${nextTop}px`;
            };

            const onMouseUp = () => { isDragging = false; };

            header.addEventListener('mousedown', onMouseDown);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);

            panel._cleanupDrag = () => {
                header.removeEventListener('mousedown', onMouseDown);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                isDragging = false;
            };
        }

        _whenBodyReady(cb) {
            if (document.body) { cb(); return; }
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    cb();
                }
            });
            observer.observe(document.documentElement, { childList: true });
        }

        startSelection() {
            this.stopSelection();
            this.injectHighlightStyle();
            // 存储引用以便 stopSelection 能正确移除
            this._contextmenuHandler = (e) => {
                e.preventDefault();
                this.stopSelection();
            };
            this._keydownHandler = (e) => {
                if (e.key === 'Escape') this.stopSelection();
            };
            // 移动端 touch 事件处理函数绑定（必须在 body 就绪前完成绑定以保持引用一致）
            this._handleTouchStart = this._handleTouchStart.bind(this);
            this._handleTouchMove = this._handleTouchMove.bind(this);
            this._handleTouchEnd = this._handleTouchEnd.bind(this);
            document.addEventListener('keydown', this._keydownHandler);
            this._whenBodyReady(() => {
                document.body.addEventListener('mouseover', this._handleMouseOver, true);
                document.body.addEventListener('click', this._handleClick, true);
                document.body.addEventListener('contextmenu', this._contextmenuHandler);
                // 移动端：拦截 touch 事件，防止广告通过触屏直接跳转；用 touchend 选定元素
                document.body.addEventListener('touchstart', this._handleTouchStart, { capture: true, passive: false });
                document.body.addEventListener('touchmove', this._handleTouchMove, { capture: true, passive: false });
                document.body.addEventListener('touchend', this._handleTouchEnd, { capture: true, passive: false });
            });
        }

        stopSelection() {
            if (this._keydownHandler) {
                document.removeEventListener('keydown', this._keydownHandler);
                this._keydownHandler = null;
            }
            if (!document.body) return;
            document.body.removeEventListener('mouseover', this._handleMouseOver, true);
            document.body.removeEventListener('click', this._handleClick, true);
            if (this._contextmenuHandler) {
                document.body.removeEventListener('contextmenu', this._contextmenuHandler);
                this._contextmenuHandler = null;
            }
            // 移除移动端 touch 监听
            if (this._handleTouchStart) {
                document.body.removeEventListener('touchstart', this._handleTouchStart, { capture: true });
            }
            if (this._handleTouchMove) {
                document.body.removeEventListener('touchmove', this._handleTouchMove, { capture: true });
            }
            if (this._handleTouchEnd) {
                document.body.removeEventListener('touchend', this._handleTouchEnd, { capture: true });
            }
            if (this.highlightEl) {
                this.highlightEl.classList.remove('pro-blocker-highlight');
                this.highlightEl = null;
            }
        }

        _handleMouseOver(e) {
            if (!e.target || !e.target.closest || e.target.closest('#pro-blocker-ui-host')) return;
            if (this.highlightEl) this.highlightEl.classList.remove('pro-blocker-highlight');
            this.highlightEl = e.target;
            this.highlightEl.classList.add('pro-blocker-highlight');
        }

        // 触屏移动设备：通过 touchmove 实时更新高亮（替代 mouseover）
        _handleTouchMove(e) {
            if (!e.touches || e.touches.length === 0) return;
            const touch = e.touches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            if (!target || !target.closest || target.closest('#pro-blocker-ui-host')) return;
            if (this.highlightEl) this.highlightEl.classList.remove('pro-blocker-highlight');
            this.highlightEl = target;
            this.highlightEl.classList.add('pro-blocker-highlight');
            // 阻止页面滚动，确保手指抬起时位置仍是目标元素
            e.preventDefault();
        }

        // 触屏抬起时选定元素（移动端的"点击"）
        _handleTouchEnd(e) {
            if (!e.changedTouches || e.changedTouches.length === 0) return;
            const touch = e.changedTouches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            if (!target || !target.closest || target.closest('#pro-blocker-ui-host')) return;
            e.preventDefault();
            e.stopPropagation();
            this.stopSelection();
            this.showActionPanel(target);
        }

        // 阻止 touchstart 默认行为，防止广告通过 touch 事件直接触发跳转
        _handleTouchStart(e) {
            if (!e.target || !e.target.closest || e.target.closest('#pro-blocker-ui-host')) return;
            e.preventDefault();
            e.stopPropagation();
        }

        _handleClick(e) {
            if (!e.target || !e.target.closest || e.target.closest('#pro-blocker-ui-host')) return;
            e.preventDefault();
            e.stopPropagation();
            this.stopSelection();
            this.showActionPanel(e.target);
        }

        _clearSelectionHighlight() {
            if (this.currentSelectedEl) {
                this.currentSelectedEl.classList.remove('pro-blocker-selected');
            }
        }

        _isElementInDOM(el) {
            return el && document.contains(el);
        }

        _applySelectionHighlight(element) {
            this._clearSelectionHighlight();
            this.currentSelectedEl = element;
            element.classList.add('pro-blocker-selected');
            try { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { }
        }

        _resetActionPreview(panel) {
            if (!this._actionPreview.active) return;
            const el = this._actionPreview.el;
            if (el) {
                el.style.removeProperty('display');
                el.classList.remove('pro-blocker-selected');
            }
            this._actionPreview = { active: false, el: null };
            const btn = panel.querySelector('#btn-preview');
            if (btn) btn.textContent = '🔍 预览效果';
        }

        _refreshSelectionInfo(panel) {
            const el = this.currentSelectedEl;
            if (!el) return;

            const selector = BlockEngine.generateOptimalSelector(el);
            const structSelector = BlockEngine.generateStructuralSelector(el);
            const resourceResult = BlockEngine.extractResourceDomains(el, { deep: true });
            const isSafeOuter = BlockEngine.isSafeOutermost(el);
            const canZoomOut = this.selectionStack.length > 0;
            const canZoomIn = !isSafeOuter && !!el.parentElement;

            const pathBox = panel.querySelector('#info-selector');
            if (pathBox) pathBox.textContent = selector;
            const structBox = panel.querySelector('#info-struct');
            if (structBox) structBox.textContent = structSelector;

            const levelInfo = panel.querySelector('#info-level');
            if (levelInfo) {
                const depth = this.selectionStack.length;
                const depthText = depth === 0 ? '自身（初始选择）' : `向上 ${depth} 层`;
                levelInfo.innerHTML = `<span class="level-info">当前层级：<b>${depth}</b> · ${depthText}</span>` +
                    (isSafeOuter ? '<span class="safe-flag">✓ 已到 DOM 最顶层</span>' : '');
            }

            const domainBox = panel.querySelector('#info-domains');
            if (domainBox) {
                if (resourceResult.domains.length > 0) {
                    domainBox.innerHTML = '<span class="info-label">🔍 发现第三方资源域：</span>' +
                        resourceResult.domains.map(d => `<span class="domain-item">${escapeHTML(d)}</span>`).join('');
                } else {
                    domainBox.innerHTML = '<span class="info-label" style="color:#bbb;">🔍 当前框选范围内未发现第三方资源域</span>';
                }
            }

            const btnZoomIn = panel.querySelector('#btn-zoom-in');
            const btnZoomOut = panel.querySelector('#btn-zoom-out');
            const btnZoomReset = panel.querySelector('#btn-zoom-reset');
            const btnAutoOuter = panel.querySelector('#btn-auto-outer');
            if (btnZoomIn) btnZoomIn.disabled = !canZoomIn;
            if (btnZoomOut) btnZoomOut.disabled = !canZoomOut;
            if (btnZoomReset) btnZoomReset.disabled = (this.selectionStack.length === 0);
            if (btnAutoOuter) btnAutoOuter.disabled = isSafeOuter;

            const btnDomain = panel.querySelector('#btn-domain');
            if (btnDomain) {
                if (resourceResult.domains.length > 0) {
                    btnDomain.disabled = false;
                    btnDomain.textContent = `🔥 彻底封杀 ${resourceResult.domains.length} 个广告域名（推荐）`;
                } else {
                    btnDomain.disabled = true;
                    btnDomain.textContent = '🔥 当前框选未发现第三方域名';
                }
            }
        }

        showActionPanel(element) {
            this.clearPanel();
            this.injectHighlightStyle();
            this.originalSelectedEl = element;
            this.currentSelectedEl = element;
            this.selectionStack = [];
            this._actionPreview = { active: false, el: null };

            const panel = document.createElement('div');
            panel.className = 'panel';

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">确认屏蔽策略</h3>

                <div class="zoom-bar">
                    <button class="btn-warning" id="btn-zoom-in" title="框选更大范围（向父级扩展）">⬆ 放大</button>
                    <button class="btn-dark" id="btn-zoom-out" title="返回上一层级（回到子级）">⬇ 缩小</button>
                    <button class="btn-outline" id="btn-zoom-reset" title="回到最初选中的元素">↺ 重置</button>
                    <button class="btn-success" id="btn-auto-outer" title="自动跳到最外层容器">🎯 自动最外层</button>
                </div>

                <div class="selection-info">
                    <div class="info-row" id="info-level"></div>
                    <div class="info-row"><span class="info-label">常规语义路径</span></div>
                    <span class="code-box" id="info-selector"></span>
                    <div class="info-row"><span class="info-label">物理结构路径</span></div>
                    <span class="code-box" id="info-struct"></span>
                    <div class="info-row" id="info-domains"></div>
                </div>

                <div class="btn-group">
                    <button class="btn-primary" id="btn-static">静态路径拦截</button>
                    <button class="btn-success" id="btn-dynamic">动态类名拦截</button>
                </div>
                <div class="btn-group">
                    <button class="btn-dark" id="btn-struct" style="flex:100%;">🎯 按物理结构拦截 (无视ID/类名随机化)</button>
                </div>
                <div class="btn-group">
                    <button class="btn-danger" id="btn-domain" style="flex:100%; font-weight:bold;">🔥 彻底封杀广告域名（推荐）</button>
                </div>

                <div class="section-divider"></div>
                <div class="btn-group">
                    <button class="btn-warning" id="btn-preview">🔍 预览效果</button>
                    <button class="btn-outline" id="btn-cancel">取消配置</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            // 缩小：回到上一层级
            panel.querySelector('#btn-zoom-out').addEventListener('click', () => {
                if (this.selectionStack.length === 0) return;
                this._resetActionPreview(panel);
                const prev = this.selectionStack.pop();
                this._applySelectionHighlight(prev);
                this._refreshSelectionInfo(panel);
            });

            // 放大：框选父级
            panel.querySelector('#btn-zoom-in').addEventListener('click', () => {
                const cur = this.currentSelectedEl;
                if (!cur || !cur.parentElement || !this._isElementInDOM(cur)) return;
                if (BlockEngine.isSafeOutermost(cur)) return;
                this._resetActionPreview(panel);
                this.selectionStack.push(cur);
                this._applySelectionHighlight(cur.parentElement);
                this._refreshSelectionInfo(panel);
            });

            // 重置：回到最初选中元素
            panel.querySelector('#btn-zoom-reset').addEventListener('click', () => {
                if (this.selectionStack.length === 0) return;
                this._resetActionPreview(panel);
                this._applySelectionHighlight(this.originalSelectedEl);
                this.selectionStack = [];
                this._refreshSelectionInfo(panel);
            });

            // 自动最外层：智能找到广告容器
            panel.querySelector('#btn-auto-outer').addEventListener('click', () => {
                const target = BlockEngine.findOutermostAdContainer(this.currentSelectedEl);
                if (!target || target === this.currentSelectedEl) {
                    this._refreshSelectionInfo(panel);
                    return;
                }
                this._resetActionPreview(panel);
                this.selectionStack = [];
                let cur = this.currentSelectedEl;
                while (cur && cur !== target) {
                    this.selectionStack.push(cur);
                    cur = cur.parentElement;
                    if (!cur || cur === document.body || cur === document.documentElement) break;
                }
                this._applySelectionHighlight(target);
                this._refreshSelectionInfo(panel);
            });

            // 静态路径拦截
            panel.querySelector('#btn-static').addEventListener('click', () => {
                const sel = BlockEngine.generateOptimalSelector(this.currentSelectedEl);
                storage.addRule('static', { selector: sel, type: 'static' });
                this.clearPanel();
            });

            // 动态类名拦截
            panel.querySelector('#btn-dynamic').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const primaryClass = (typeof el.className === 'string' ? el.className : '').split(/\s+/)[0];
                if (!primaryClass) { alert('当前元素无有效类名，请选择其他拦截方式。'); return; }
                storage.addRule('dynamic', { className: primaryClass, type: 'dynamic' });
                this.clearPanel();
            });

            // 物理结构拦截
            panel.querySelector('#btn-struct').addEventListener('click', () => {
                const sel = BlockEngine.generateStructuralSelector(this.currentSelectedEl);
                storage.addRule('structural', { structSelector: sel, type: 'structural' });
                this.clearPanel();
            });

            // 彻底封杀域名（核心：解决刷新复活）
            panel.querySelector('#btn-domain').addEventListener('click', () => {
                if (!this._isElementInDOM(this.currentSelectedEl)) {
                    alert('目标元素已从页面移除，请重新选择。');
                    this.clearPanel();
                    return;
                }
                const result = BlockEngine.extractResourceDomains(this.currentSelectedEl, { deep: true });
                if (result.domains.length === 0) {
                    alert('当前框选范围内未发现第三方资源域，无法执行域名封杀。');
                    return;
                }
                const confirmMsg = `将封杀以下 ${result.domains.length} 个域名（全局生效，所有页面都将拦截）：\n\n${result.domains.join('\n')}\n\n同时会隐藏当前框选的整个广告容器。确认继续？`;
                if (!confirm(confirmMsg)) return;

                result.domains.forEach(d => {
                    storage.addRule('domainBlock', { domain: d, type: 'domainBlock' });
                });

                // 自动提取路径模式（从相对路径 href 中提取前 3 段）
                const pathCandidates = new Set();
                result.urls.forEach(u => {
                    try {
                        if (u.startsWith('//') || u.startsWith('http')) return;
                        if (u.startsWith('/') && u.length > 5) {
                            const pathOnly = u.split('?')[0].split('#')[0];
                            const segs = pathOnly.split('/').filter(Boolean);
                            if (segs.length >= 2) pathCandidates.add('/' + segs.slice(0, 3).join('/'));
                        }
                    } catch (e) { }
                });
                pathCandidates.forEach(p => {
                    storage.addRule('pathPattern', { pattern: p, type: 'pathPattern' });
                });

                // 立即隐藏当前框选的整个广告容器（向上找单子链容器）
                const container = BlockEngine.findSingleChildWrapper(this.currentSelectedEl, 4);
                container.style.setProperty('display', 'none', 'important');
                container.style.setProperty('opacity', '0', 'important');

                // 扫描全页删除该域所有资源（含 srcset）
                result.domains.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                        const t = BlockEngine.findSingleChildWrapper(el, 4);
                        t.style.setProperty('display', 'none', 'important');
                        t.style.setProperty('opacity', '0', 'important');
                    });
                });

                const pathNote = pathCandidates.size > 0 ? '，并记录 ' + pathCandidates.size + ' 条路径模式' : '';
                this.clearPanel();
                alert(`已封杀 ${result.domains.length} 个域名${pathNote}。\n后续刷新与所有页面都将自动拦截。`);
            });

            // 预览效果
            panel.querySelector('#btn-preview').addEventListener('click', (e) => {
                if (this._actionPreview.active) {
                    this._resetActionPreview(panel);
                    return;
                }
                const el = this.currentSelectedEl;
                if (!this._isElementInDOM(el)) {
                    alert('目标元素已从页面移除，请重新选择。');
                    this.clearPanel();
                    return;
                }
                this._actionPreview = { active: true, el };
                el.classList.remove('pro-blocker-selected');
                el.style.setProperty('display', 'none', 'important');
                e.target.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-cancel').addEventListener('click', () => {
                this.clearPanel();
            });

            this._applySelectionHighlight(element);
            this._refreshSelectionInfo(panel);
        }

        showGlobalDomainPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            const { scoredDomains = [] } = BlockEngine.extractResourceDomains(document.documentElement, { deep: true });
            let allDomains = scoredDomains;
            let selectedHosts = new Set(scoredDomains.filter(d => d.score >= 35).map(d => d.host));
            let filterText = '';
            let onlyAds = true;

            const isAdLike = (host) => AD_KEYWORDS.test(host);

            const getScoreClass = (score) => score >= 50 ? 'high' : score >= 25 ? 'mid' : 'low';
            const sourceLabel = (src) => ({ 'attr': '属性', 'srcset': '响应图', 'inline-style': '内联样式', 'stylesheet': '样式表', 'data-attr': '数据属性', 'script-text': '脚本文本', 'script-var': '脚本变量' }[src] || src);

            const renderDomains = () => {
                const box = panel.querySelector('#global-domains');
                const stats = panel.querySelector('#gd-stats');
                if (!box) return;

                const filtered = allDomains.filter(d => {
                    if (filterText && !d.host.includes(filterText)) return false;
                    if (onlyAds && !isAdLike(d.host) && d.score < 40) return false;
                    return true;
                });

                if (stats) stats.textContent = `共 ${allDomains.length} 个第三方域名 · 已选 ${selectedHosts.size} 个 · 当前显示 ${filtered.length} 个`;

                if (filtered.length === 0) {
                    box.innerHTML = '<span class="info-label" style="color:#bbb;">未匹配到域名，请尝试取消“只看广告相关”或手动添加。</span>';
                } else {
                    box.innerHTML = filtered.map(d => {
                        const checked = selectedHosts.has(d.host);
                        const reasons = d.reasons.length ? ` · ${d.reasons.slice(0, 3).join(', ')}` : '';
                        return `<div class="gd-domain-row ${checked ? 'selected' : ''}" data-host="${escapeHTML(d.host)}">
                            <div class="gd-left">
                                <div class="gd-check">${checked ? '✓' : ''}</div>
                                <div>
                                    <div class="gd-host">${escapeHTML(d.host)}</div>
                                    <div class="gd-meta">来源：${d.sources.map(sourceLabel).join('、')}${reasons}</div>
                                </div>
                            </div>
                            <div class="gd-score ${getScoreClass(d.score)}">${d.score} 分</div>
                        </div>`;
                    }).join('');
                }

                const btnBlock = panel.querySelector('#btn-block-global');
                if (btnBlock) {
                    btnBlock.disabled = selectedHosts.size === 0;
                    btnBlock.textContent = selectedHosts.size > 0
                        ? `🔥 彻底封杀 ${selectedHosts.size} 个域名（推荐）`
                        : '🔥 未选择可封杀域名';
                }
            };

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">全局域名深度检索</h3>
                <p>已深度扫描页面资源、样式、数据属性与脚本变量。分数越高越可能是广告域，橙色/红色建议优先封杀。</p>
                <div class="gd-toolbar">
                    <input type="text" id="gd-filter" placeholder="输入域名关键字过滤..." />
                    <label><input type="checkbox" id="gd-only-ads" checked /> 只看广告相关</label>
                    <button class="btn-outline" id="gd-select-all">全选</button>
                    <button class="btn-outline" id="gd-select-none">清空</button>
                </div>
                <div class="gd-stats" id="gd-stats"></div>
                <div class="selection-info" style="max-height: 260px; overflow-y: auto;">
                    <div class="info-row" id="global-domains"></div>
                </div>
                <div class="gd-manual">
                    <input type="text" id="gd-manual-input" placeholder="手动输入域名，例如：ads.example.com" />
                    <button class="btn-outline" id="gd-manual-add">+ 添加</button>
                </div>
                <div class="btn-group">
                    <button class="btn-danger" id="btn-block-global" style="flex:100%; font-weight:bold;">🔥 彻底封杀广告域名（推荐）</button>
                </div>
                <div class="section-divider"></div>
                <div class="btn-group">
                    <button class="btn-warning" id="btn-preview-global">🔍 预览效果</button>
                    <button class="btn-outline" id="btn-cancel-global">取消配置</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);
            renderDomains();

            panel.querySelector('#global-domains').addEventListener('click', (e) => {
                const row = e.target.closest('.gd-domain-row');
                if (!row) return;
                const host = row.dataset.host.toLowerCase();
                if (selectedHosts.has(host)) selectedHosts.delete(host);
                else selectedHosts.add(host);
                renderDomains();
            });

            panel.querySelector('#gd-filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); renderDomains(); });
            panel.querySelector('#gd-only-ads').addEventListener('change', (e) => { onlyAds = e.target.checked; renderDomains(); });
            panel.querySelector('#gd-select-all').addEventListener('click', () => {
                allDomains.forEach(d => selectedHosts.add(d.host));
                renderDomains();
            });
            panel.querySelector('#gd-select-none').addEventListener('click', () => {
                selectedHosts.clear();
                renderDomains();
            });
            panel.querySelector('#gd-manual-add').addEventListener('click', () => {
                const input = panel.querySelector('#gd-manual-input');
                const host = input.value.trim().toLowerCase();
                if (!host) return;
                if (!allDomains.find(d => d.host === host)) {
                    allDomains.push({ host, score: 99, sources: ['manual'], reasons: ['用户手动添加'], count: 1 });
                }
                selectedHosts.add(host);
                input.value = '';
                renderDomains();
            });

            let previewActive = false;
            let previewHiddenElements = [];
            panel.querySelector('#btn-preview-global').addEventListener('click', (e) => {
                if (previewActive) {
                    previewHiddenElements.forEach(el => {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    });
                    previewHiddenElements = [];
                    previewActive = false;
                    e.target.textContent = '🔍 预览效果';
                    return;
                }
                if (selectedHosts.size === 0) return;
                previewHiddenElements = [];
                selectedHosts.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                        const t = BlockEngine.findSingleChildWrapper(el, 4);
                        if (t.style.display !== 'none') {
                            t.style.setProperty('display', 'none', 'important');
                            t.style.setProperty('opacity', '0', 'important');
                            previewHiddenElements.push(t);
                        }
                    });
                });
                previewActive = true;
                e.target.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-block-global').addEventListener('click', () => {
                if (selectedHosts.size === 0) return;
                const list = Array.from(selectedHosts);
                if (!confirm(`将封杀以下 ${list.length} 个域名（全局生效，所有页面都将拦截）：\n\n${list.join('\n')}\n\n确认继续？`)) return;
                list.forEach(d => storage.addRule('domainBlock', { domain: d, type: 'domainBlock' }));
                list.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                        const t = BlockEngine.findSingleChildWrapper(el, 4);
                        t.style.setProperty('display', 'none', 'important');
                        t.style.setProperty('opacity', '0', 'important');
                    });
                });
                this.clearPanel();
                alert(`已封杀 ${list.length} 个域名，后续刷新与所有页面都将自动拦截。`);
            });

            panel.querySelector('#btn-cancel-global').addEventListener('click', () => {
                if (previewActive) {
                    previewHiddenElements.forEach(el => {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    });
                    previewHiddenElements = [];
                    previewActive = false;
                }
                this.clearPanel();
            });
        }

        showRegexPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">添加拦截规则</h3>
                <p>通过组合条件、正则表达式或路径模式，实现对复杂动态广告的精准拦截。</p>

                <label for="regex-mode">匹配模式</label>
                <select id="regex-mode">
                    <option value="contains">基础文本模式 (包含指定字符即隐藏)</option>
                    <option value="builder" selected>积木组合模式 (免代码，支持多条件逻辑运算) ✨</option>
                    <option value="regex">正则表达式模式 (适合高级用户)</option>
                    <option value="attribute">属性选择器模式 (如 [src*="ad"] 或 [id^="banner"])</option>
                    <option value="path">路径模式 (拦截广告跳转链接，如 /flink/url.php)</option>
                </select>

                <div id="standard-ui" style="display: none;">
                    <label for="regex-input">拦截内容</label>
                    <input type="text" id="regex-input" placeholder="输入要屏蔽的关键词或正则表达式片段..." />
                </div>

                <div id="path-ui" style="display: none;">
                    <label for="path-input">广告跳转路径片段</label>
                    <input type="text" id="path-input" placeholder="例如：/flink/url.php 或 /000/flink" />
                    <p style="color:#bbb; font-size:11px;">提示：从广告链接 href 中提取有辨识度的路径片段，无需完整 URL。匹配该片段的所有链接与资源都将被拦截。</p>
                </div>

                <div id="attr-ui" style="display: none;">
                    <label for="attr-input">CSS 属性选择器</label>
                    <input type="text" id="attr-input" placeholder='例如：[src*="ad"] 或 [id^="banner"]' />
                    <p style="color:#bbb; font-size:11px;">提示：输入标准 CSS 属性选择器，匹配元素将被隐藏。可组合多属性如 [src*="ad"][class*="banner"]。</p>
                </div>

                <div id="builder-ui" style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-bottom: 15px;">
                    <label style="margin-bottom: 8px;">总体逻辑网关</label>
                    <select id="builder-logic" style="margin-bottom: 12px;">
                        <option value="AND">满足以下【全部】条件才拦截 (AND)</option>
                        <option value="OR">满足以下【任意】条件即拦截 (OR)</option>
                    </select>

                    <label>详细拦截条件</label>
                    <div id="builder-conditions"></div>
                    <button id="btn-add-condition" class="btn-outline" style="width: 100%; margin-top: 8px; border-style: dashed; padding: 6px;">+ 添加新条件块</button>
                </div>

                <div id="level-row">
                    <label for="regex-level">向上隐藏层级 (0为仅隐藏自身，1为隐藏直接父级节点)</label>
                    <input type="number" id="regex-level" value="0" min="0" max="10" />
                </div>

                <div class="btn-group" style="margin-top: 15px;">
                    <button class="btn-warning" id="btn-preview-regex">🔍 预览效果</button>
                    <button class="btn-primary" id="btn-save-regex">保存并应用</button>
                    <button class="btn-outline" id="btn-close-regex">取消</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            const modeSelect = panel.querySelector('#regex-mode');
            const standardUI = panel.querySelector('#standard-ui');
            const builderUI = panel.querySelector('#builder-ui');
            const pathUI = panel.querySelector('#path-ui');
            const attrUI = panel.querySelector('#attr-ui');
            const levelRow = panel.querySelector('#level-row');
            const conditionsContainer = panel.querySelector('#builder-conditions');

            modeSelect.addEventListener('change', (e) => {
                const v = e.target.value;
                standardUI.style.display = (v === 'contains' || v === 'regex') ? 'block' : 'none';
                builderUI.style.display = (v === 'builder') ? 'block' : 'none';
                pathUI.style.display = (v === 'path') ? 'block' : 'none';
                attrUI.style.display = (v === 'attribute') ? 'block' : 'none';
                levelRow.style.display = (v === 'path' || v === 'attribute') ? 'none' : 'block';
                if (v === 'builder' && conditionsContainer.children.length === 0) addConditionRow();
            });

            const addConditionRow = () => {
                const row = document.createElement('div');
                row.className = 'condition-row';
                row.style.cssText = 'display: flex; gap: 6px; margin-bottom: 8px; align-items: center;';
                row.innerHTML = `
                    <select class="cond-type" style="width: 32%; margin: 0; padding: 8px;">
                        <option value="text">元素文本</option>
                        <option value="class">类名(Class)</option>
                        <option value="id">标识符(ID)</option>
                    </select>
                    <select class="cond-op" style="width: 24%; margin: 0; padding: 8px;">
                        <option value="contains">包含</option>
                        <option value="equals">等于</option>
                        <option value="not_contains">不包含</option>
                    </select>
                    <input type="text" class="cond-val" style="flex: 1; margin: 0; padding: 8px;" placeholder="设定值..." />
                    <button class="btn-danger btn-remove-cond" style="flex: none; width: 32px; padding: 0; min-width: 32px; height: 35px;">✕</button>
                `;
                row.querySelector('.btn-remove-cond').addEventListener('click', () => {
                    row.remove();
                    if (conditionsContainer.children.length === 0) addConditionRow();
                });
                conditionsContainer.appendChild(row);
            };

            addConditionRow();
            panel.querySelector('#btn-add-condition').addEventListener('click', addConditionRow);

            let isPreviewing = false;

            const resetPreview = () => {
                if (isPreviewing) {
                    this._previewAffectedElements.forEach(item => {
                        if (item.el) {
                            item.el.style.removeProperty('display');
                            item.el.style.removeProperty('opacity');
                        }
                    });
                    this._previewAffectedElements = [];
                    isPreviewing = false;
                    const previewBtn = panel.querySelector('#btn-preview-regex');
                    if (previewBtn) previewBtn.textContent = '🔍 预览效果';
                }
            };

            panel.addEventListener('input', resetPreview);
            panel.addEventListener('change', resetPreview);

            panel.querySelector('#btn-preview-regex').addEventListener('click', (e) => {
                if (isPreviewing) { resetPreview(); return; }

                const mode = modeSelect.value;
                const level = parseInt(panel.querySelector('#regex-level').value, 10);
                this._previewAffectedElements = [];

                if (mode === 'path') {
                    alert('路径模式无法预览（影响全局资源），请直接保存查看效果。');
                    return;
                }

                if (mode === 'attribute') {
                    const text = panel.querySelector('#attr-input').value.trim();
                    if (!text) { alert('校验失败：请输入属性选择器。'); return; }
                    try {
                        document.querySelectorAll(text).forEach(el => {
                            let target = el;
                            for (let i = 0; i < level; i++) {
                                if (target.parentElement && target.parentElement !== document.body) {
                                    target = target.parentElement;
                                } else break;
                            }
                            if (target && target.style.display !== 'none') {
                                this._previewAffectedElements.push({ el: target });
                                target.style.setProperty('display', 'none', 'important');
                                target.style.setProperty('opacity', '0', 'important');
                            }
                        });
                    } catch (err) {
                        alert('校验失败：属性选择器语法错误。');
                        return;
                    }
                    isPreviewing = true;
                    e.target.textContent = '👁 恢复显示';
                    return;
                }

                if (mode === 'builder') {
                    const logic = panel.querySelector('#builder-logic').value;
                    const rows = conditionsContainer.querySelectorAll('.condition-row');
                    const conditions = [];
                    let isValueMissing = false;

                    rows.forEach(row => {
                        const type = row.querySelector('.cond-type').value;
                        const op = row.querySelector('.cond-op').value;
                        const val = row.querySelector('.cond-val').value.trim();
                        if (!val) isValueMissing = true;
                        conditions.push({ type, operator: op, value: val });
                    });

                    if (isValueMissing || conditions.length === 0) {
                        alert('规则校验失败：请完整填写所有积木条件的值再进行预览。');
                        return;
                    }

                    let baseSelector = '*';
                    const simpleParts = [];
                    if (logic === 'AND') {
                        conditions.forEach(c => {
                            if (c.type === 'class' && (c.operator === 'contains' || c.operator === 'equals')) simpleParts.push(`[class*="${escapeCSSAttr(c.value)}"]`);
                            if (c.type === 'id' && c.operator === 'equals') simpleParts.push(`[id="${escapeCSSAttr(c.value)}"]`);
                            if (c.type === 'id' && c.operator === 'contains') simpleParts.push(`[id*="${escapeCSSAttr(c.value)}"]`);
                        });
                        if (simpleParts.length > 0) baseSelector = `*${simpleParts.join('')}`;
                    }

                    const root = document.body;
                    const elements = baseSelector === '*'
                        ? root.querySelectorAll('div, span, a, p, img, li, ul, iframe, section, article, aside')
                        : root.querySelectorAll(baseSelector);

                    elements.forEach(el => {
                        if (baseSelector === '*' && (el.textContent || '').length > 3000) return;

                        const results = conditions.map(c => {
                            let val = '';
                            if (c.type === 'text') val = el.textContent || '';
                            else if (c.type === 'class') val = typeof el.className === 'string' ? el.className : '';
                            else if (c.type === 'id') val = el.id || '';

                            if (c.operator === 'contains') return val.includes(c.value);
                            if (c.operator === 'not_contains') return val !== '' && !val.includes(c.value);
                            if (c.operator === 'equals') return val.trim() === c.value.trim();
                            return false;
                        });

                        const isMatch = logic === 'AND' ? results.every(r => r) : results.some(r => r);

                        if (isMatch) {
                            let target = el;
                            for (let i = 0; i < level; i++) {
                                if (target.parentElement && target.parentElement !== document.body && target.parentElement !== document.documentElement) {
                                    target = target.parentElement;
                                } else break;
                            }
                            if (target.style.display !== 'none') {
                                this._previewAffectedElements.push({ el: target });
                                target.style.setProperty('display', 'none', 'important');
                                target.style.setProperty('opacity', '0', 'important');
                            }
                        }
                    });

                } else {
                    const text = panel.querySelector('#regex-input').value.trim();
                    if (!text) {
                        alert('规则校验失败：请输入有效的匹配内容再进行预览。');
                        return;
                    }

                    let regexRule = text;
                    if (mode === 'contains') {
                        const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        regexRule = `.*${escapedText}.*`;
                    }

                    try {
                        const regex = new RegExp(regexRule);
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                        let node;
                        while ((node = walker.nextNode())) {
                            if (regex.test(node.textContent)) {
                                let target = node.parentElement;
                                for (let i = 0; i < level; i++) {
                                    if (target.parentElement && target.parentElement !== document.body) {
                                        target = target.parentElement;
                                    } else break;
                                }
                                if (target && target.style.display !== 'none') {
                                    this._previewAffectedElements.push({ el: target });
                                    target.style.setProperty('display', 'none', 'important');
                                    target.style.setProperty('opacity', '0', 'important');
                                }
                            }
                        }
                    } catch (err) {
                        alert('规则校验失败：正则表达式存在语法错误。');
                        return;
                    }
                }

                isPreviewing = true;
                e.target.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-save-regex').addEventListener('click', () => {
                const mode = modeSelect.value;

                if (mode === 'path') {
                    const text = panel.querySelector('#path-input').value.trim();
                    if (!text) { alert('校验失败：请输入路径片段。'); return; }
                    storage.addRule('pathPattern', { pattern: text, type: 'pathPattern' });
                    BlockEngine.applyCSSRules();
                    BlockEngine.scanAndBlockDynamic(document.body);
                    this.clearPanel();
                    return;
                }

                if (mode === 'attribute') {
                    const text = panel.querySelector('#attr-input').value.trim();
                    if (!text) { alert('校验失败：请输入属性选择器。'); return; }
                    try { document.querySelector(text); } catch (err) {
                        alert('校验失败：属性选择器语法错误，请检查括号、引号是否匹配。');
                        return;
                    }
                    storage.addRule('attribute', { attrSelector: text, type: 'attribute' });
                    BlockEngine.applyCSSRules();
                    this.clearPanel();
                    return;
                }

                const level = parseInt(panel.querySelector('#regex-level').value, 10);

                if (mode === 'builder') {
                    const logic = panel.querySelector('#builder-logic').value;
                    const rows = conditionsContainer.querySelectorAll('.condition-row');
                    const conditions = [];
                    let isValueMissing = false;

                    rows.forEach(row => {
                        const type = row.querySelector('.cond-type').value;
                        const op = row.querySelector('.cond-op').value;
                        const val = row.querySelector('.cond-val').value.trim();
                        if (!val) isValueMissing = true;
                        conditions.push({ type, operator: op, value: val });
                    });

                    if (isValueMissing || conditions.length === 0) {
                        alert('校验失败：请完整填写所有积木条件的值。');
                        return;
                    }

                    storage.addRule('complex', { logic, conditions, level, type: 'complex' });
                    BlockEngine.applyComplexRules();

                } else {
                    const text = panel.querySelector('#regex-input').value.trim();
                    if (!text) { alert('校验失败：请输入有效的匹配内容。'); return; }

                    let regexRule = text;
                    if (mode === 'contains') {
                        const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        regexRule = `.*${escapedText}.*`;
                    }

                    storage.addRule('regex', { regex: regexRule, level: level, type: 'regex' });
                    BlockEngine.applyRegexRules();
                }

                this.clearPanel();
            });

            panel.querySelector('#btn-close-regex').addEventListener('click', () => this.clearPanel());
        }

        showManager() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';
            const data = storage.getData();
            let rulesHTML = '<ul class="rule-list">';

            const renderItem = (type, content, index, tagClass = '') => `
                <li class="rule-item">
                    <div class="rule-content">
                        <span class="tag ${tagClass}">${type}</span> ${content}
                    </div>
                    <button class="btn-danger btn-delete" style="flex:none; width:60px; padding: 6px;" data-type="${type}" data-index="${index}">删除</button>
                </li>
            `;

            data.static.forEach((r, i) => rulesHTML += renderItem('静态', escapeHTML(r.selector), i));
            data.dynamic.forEach((r, i) => rulesHTML += renderItem('动态', `类名: ${escapeHTML(r.className)}`, i));
            data.regex.forEach((r, i) => rulesHTML += renderItem('正则', `匹配: ${escapeHTML(r.regex)} (层级: ${r.level})`, i));
            data.attribute.forEach((r, i) => rulesHTML += renderItem('属性', `选择器: ${escapeHTML(r.attrSelector)}`, i, 'attr'));
            data.structural.forEach((r, i) => rulesHTML += renderItem('位置', escapeHTML(r.structSelector), i, 'struct'));
            data.pathPattern.forEach((r, i) => rulesHTML += renderItem('路径', `模式: ${escapeHTML(r.pattern)}`, i, 'path'));

            data.complex.forEach((r, i) => {
                const formatOp = (op) => op === 'contains' ? '包含' : (op === 'equals' ? '等于' : '不包含');
                const formatType = (t) => t === 'text' ? '文本' : (t === 'class' ? '类名' : 'ID');
                const condText = r.conditions.map(c => `[${formatType(c.type)} ${formatOp(c.operator)} "${escapeHTML(c.value)}"]`).join(` <span style="color:#007AFF; font-weight:bold;">${escapeHTML(r.logic)}</span> `);
                rulesHTML += renderItem('积木', `${condText} (层级: ${r.level})`, i, 'complex');
            });

            data.domainBlock.forEach((d, i) => rulesHTML += renderItem('域名', escapeHTML(d), i, 'domain'));

            if (rulesHTML === '<ul class="rule-list">') {
                rulesHTML = '<p class="empty-tip">当前暂无屏蔽规则</p>';
            } else { rulesHTML += '</ul>'; }

            const modeText = data.config.mode === 'preemptive' ? '强制极速预判 (防闪现)' : '智能自动';
            const flashStatus = storage.flashList[storage.domain] ? '<span style="color:red; font-weight:bold;">已记录闪现特征，系统采用极速注入</span>' : '运行良好';
            const domainCount = data.domainBlock.length;

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">规则与防御管理 (${storage.domain})</h3>

                <div class="status-bar">
                    <div><strong>防御策略：</strong> ${modeText}</div>
                    <div><strong>系统评估：</strong> ${flashStatus}</div>
                    <div><strong>全局域名黑名单：</strong> 共 ${domainCount} 个域名（跨站点生效）</div>
                </div>

                <div style="max-height: 280px; overflow-y: auto; margin-bottom: 15px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 6px;">
                    ${rulesHTML}
                </div>

                <div class="btn-group">
                    <button class="btn-info" id="btn-toggle-mode">🚀 切换防御策略</button>
                    <button class="btn-success" id="btn-export">📤 导出规则</button>
                    <button class="btn-warning" id="btn-import">📥 导入规则</button>
                </div>
                <div class="btn-group" style="margin-top: 10px;">
                    <button class="btn-success" id="btn-ag-export">🛡️ 转 AdGuard 规则</button>
                    <button class="btn-outline" id="btn-clear-all">清除本站规则</button>
                    <button class="btn-primary" id="btn-close-manager">完成</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            panel.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const typeMap = { '静态': 'static', '动态': 'dynamic', '正则': 'regex', '属性': 'attribute', '位置': 'structural', '积木': 'complex', '路径': 'pathPattern', '域名': 'domainBlock' };
                    const type = typeMap[e.target.getAttribute('data-type')];
                    const index = parseInt(e.target.getAttribute('data-index'), 10);
                    storage.removeRule(type, index);
                    // regex/complex 通过 inline style 隐藏，删除后需刷新才能恢复
                    if (type === 'regex' || type === 'complex') {
                        window.location.reload();
                    } else {
                        this.showManager();
                    }
                });
            });

            panel.querySelector('#btn-toggle-mode').addEventListener('click', () => {
                const newMode = storage.toggleMode();
                alert(`策略已调整为：${newMode === 'preemptive' ? '极速预判模式' : '智能自动模式'}\n页面即将刷新以应用变更配置。`);
                window.location.reload();
            });

            panel.querySelector('#btn-export').addEventListener('click', () => this.showExportPanel());
            panel.querySelector('#btn-import').addEventListener('click', () => this.showImportPanel());
            panel.querySelector('#btn-ag-export').addEventListener('click', () => this.showAdGuardExportPanel());

            panel.querySelector('#btn-clear-all').addEventListener('click', () => {
                if (confirm('警告：此操作将清空【当前域名】下的所有拦截规则和配置（不影响全局域名黑名单）。确认继续？')) {
                    storage.clearDomain();
                    window.location.reload();
                }
            });

            panel.querySelector('#btn-close-manager').addEventListener('click', () => this.clearPanel());
        }

        showExportPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';
            const json = storage.exportAll();

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">📤 导出规则</h3>
                <p>下方文本框包含全部拦截规则与全局域名黑名单。复制后保存到任意位置，或在新设备的脚本中通过"导入规则"粘贴即可。</p>
                <textarea id="export-text" readonly></textarea>
                <div class="btn-group" style="margin-top: 10px;">
                    <button class="btn-primary" id="btn-copy">📋 复制到剪贴板</button>
                    <button class="btn-success" id="btn-download">💾 下载为文件</button>
                    <button class="btn-outline" id="btn-back">返回</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            const ta = panel.querySelector('#export-text');
            ta.value = json;

            panel.querySelector('#btn-copy').addEventListener('click', async () => {
                const text = ta.value;
                try {
                    await navigator.clipboard.writeText(text);
                    alert('已复制到剪贴板！');
                } catch (e) {
                    ta.select();
                    try { document.execCommand('copy'); alert('已复制到剪贴板！'); }
                    catch (e2) { alert('复制失败，请手动选中文本复制。'); }
                }
            });

            panel.querySelector('#btn-download').addEventListener('click', () => {
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `pro-blocker-rules-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
            });

            panel.querySelector('#btn-back').addEventListener('click', () => this.showManager());
        }

        generateAdGuardRules() {
            const raw = JSON.parse(storage.exportAll() || '{}');
            const ruleBuckets = {
                blocks: raw.blocks || {},
                dynamicBlocks: raw.dynamicBlocks || {},
                regexBlocks: raw.regexBlocks || {},
                attrBlocks: raw.attrBlocks || {},
                structBlocks: raw.structBlocks || {},
                complexBlocks: raw.complexBlocks || {},
                pathPatternBlocks: raw.pathPatternBlocks || {},
                domainBlocks: raw.domainBlocks || []
            };
            const allDomains = new Set([
                ...Object.keys(ruleBuckets.blocks),
                ...Object.keys(ruleBuckets.dynamicBlocks),
                ...Object.keys(ruleBuckets.regexBlocks),
                ...Object.keys(ruleBuckets.attrBlocks),
                ...Object.keys(ruleBuckets.structBlocks),
                ...Object.keys(ruleBuckets.complexBlocks),
                ...Object.keys(ruleBuckets.pathPatternBlocks)
            ]);
            // 校验域名：非空、无空白、长度合理
            const isValidDomain = (d) => typeof d === 'string' && d.length > 0 && d.length < 200 && !/\s/.test(d);
            const globalDomains = (Array.isArray(ruleBuckets.domainBlocks) ? ruleBuckets.domainBlocks : [])
                .filter(isValidDomain);

            const lines = [
                '! 由 Web Element Blocker 转换的 AdGuard 规则',
                `! 生成时间：${new Date().toLocaleString()}`,
                '! 兼容 AdGuard 浏览器扩展 / uBlock Origin。',
                '! 注意：元素隐藏类规则 (## / #?#) 仅适用于浏览器扩展，不适用于 AdGuard DNS。',
                '! AdGuard DNS 仅支持下方"全局域名拦截（DNS 兼容）"段落中的 ||domain^ 规则。',
                ''
            ];

            const escapeCssValue = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const firstClassToken = (cls) => (cls || '').split(/\s+/).filter(Boolean)[0] || cls;
            // 用户已写好的正则 → 仅转义定界符 / 并剔除换行（保留反斜杠的 regex 语义）
            const escapeAdGuardRegex = (r) => String(r).replace(/[\r\n]+/g, '').replace(/\//g, '\\/');
            // 纯文本 → 转义全部 regex 元字符与定界符，用于嵌入 /.../ 字面量
            const escapeRegexLiteral = (v) => String(v).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/[\r\n]+/g, '');

            /**
             * 把单条规则转换为 AdGuard 兼容文本（OR 模式可能返回多行，用 \n 分隔）
             * 标记说明：
             *   ##  = 普通元素隐藏（标准 CSS 选择器）
             *   #?# = 扩展 CSS（含 :has-text / :not(:has-text) 等扩展伪类，AdGuard 强制要求此标记）
             * 文本匹配统一用 :has-text()，它是 uBlock Origin 主用名、AdGuard 的 :contains() 同义词，兼容性最佳。
             */
            const convertRule = (rule, domain) => {
                if (!rule || !rule.type || !isValidDomain(domain)) return null;
                switch (rule.type) {
                    case 'static':
                        return rule.selector ? `${domain}##${rule.selector}` : null;
                    case 'dynamic':
                        return rule.className ? `${domain}##[class*="${escapeCssValue(firstClassToken(rule.className))}"]` : null;
                    case 'attribute':
                        return rule.attrSelector ? `${domain}##${rule.attrSelector}` : null;
                    case 'structural':
                        return rule.structSelector ? `${domain}##${rule.structSelector}` : null;
                    case 'regex': {
                        if (!rule.regex) return null;
                        try { new RegExp(rule.regex); } catch (e) { return null; }
                        const body = escapeAdGuardRegex(rule.regex);
                        if (!body) return null;
                        // 扩展 CSS 必须用 #?# 标记
                        return `${domain}#?#*:has-text(/${body}/)`;
                    }
                    case 'pathPattern': {
                        if (!rule.pattern) return null;
                        const esc = escapeCssValue(rule.pattern);
                        // AdGuard 一行一条规则，多选择器用逗号合并（与脚本内 CSS 注入的属性范围保持一致）
                        return `${domain}##[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                    }
                    case 'complex': {
                        if (!rule.conditions || rule.conditions.length === 0) return null;
                        const andMode = rule.logic === 'AND';
                        const simpleParts = [];
                        const pseudoParts = [];
                        rule.conditions.forEach(c => {
                            if (c.type === 'class') {
                                if (c.operator === 'contains' || c.operator === 'equals') simpleParts.push(`[class*="${escapeCssValue(c.value)}"]`);
                                if (c.operator === 'not_contains') pseudoParts.push(`:not([class*="${escapeCssValue(c.value)}"])`);
                            } else if (c.type === 'id') {
                                if (c.operator === 'equals') simpleParts.push(`[id="${escapeCssValue(c.value)}"]`);
                                else if (c.operator === 'contains') simpleParts.push(`[id*="${escapeCssValue(c.value)}"]`);
                                else if (c.operator === 'not_contains') pseudoParts.push(`:not([id*="${escapeCssValue(c.value)}"])`);
                            } else if (c.type === 'text') {
                                if (c.operator === 'contains') pseudoParts.push(`:has-text("${escapeCssValue(c.value)}")`);
                                if (c.operator === 'equals') pseudoParts.push(`:has-text(/^${escapeRegexLiteral(c.value)}$/)`);
                                if (c.operator === 'not_contains') pseudoParts.push(`:not(:has-text("${escapeCssValue(c.value)}"))`);
                            }
                        });
                        if (andMode) {
                            if (!pseudoParts.length && !simpleParts.length) return null;
                            const base = simpleParts.length ? `*${simpleParts.join('')}` : '*';
                            const marker = pseudoParts.length > 0 ? '#?#' : '##';
                            return `${domain}${marker}${base}${pseudoParts.join('')}`;
                        } else {
                            // OR：每条件单独成行，含扩展伪类时用 #?#
                            return rule.conditions.map(c => {
                                if (c.type === 'class') {
                                    if (c.operator === 'contains') return `${domain}##*[class*="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'equals') return `${domain}##[class*="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'not_contains') return `${domain}#?#*:not([class*="${escapeCssValue(c.value)}"])`;
                                } else if (c.type === 'id') {
                                    if (c.operator === 'equals') return `${domain}##[id="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'contains') return `${domain}##[id*="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'not_contains') return `${domain}#?#*:not([id*="${escapeCssValue(c.value)}"])`;
                                } else if (c.type === 'text') {
                                    if (c.operator === 'contains') return `${domain}#?#*:has-text("${escapeCssValue(c.value)}")`;
                                    if (c.operator === 'equals') return `${domain}#?#*:has-text(/^${escapeRegexLiteral(c.value)}$/)`;
                                    if (c.operator === 'not_contains') return `${domain}#?#*:not(:has-text("${escapeCssValue(c.value)}"))`;
                                }
                                return null;
                            }).filter(Boolean).join('\n');
                        }
                    }
                    default:
                        return null;
                }
            };

            allDomains.forEach(domain => {
                const rules = [
                    ...(ruleBuckets.blocks[domain] || []),
                    ...(ruleBuckets.dynamicBlocks[domain] || []),
                    ...(ruleBuckets.regexBlocks[domain] || []),
                    ...(ruleBuckets.attrBlocks[domain] || []),
                    ...(ruleBuckets.structBlocks[domain] || []),
                    ...(ruleBuckets.complexBlocks[domain] || []),
                    ...(ruleBuckets.pathPatternBlocks[domain] || [])
                ];
                if (rules.length === 0) return;
                lines.push(`! ${domain}`);
                rules.forEach(rule => {
                    const converted = convertRule(rule, domain);
                    if (converted) lines.push(converted);
                });
                lines.push('');
            });

            if (globalDomains.length) {
                // 浏览器扩展版：$third-party 限定第三方请求，避免误杀同域资源
                lines.push('! 全局域名拦截（AdGuard 浏览器扩展 / uBlock Origin）');
                globalDomains.forEach(host => lines.push(`||${host}^$third-party`));
                lines.push('');
                // DNS 兼容版：AdGuard DNS 会忽略含未知修饰符的整条规则，故去掉 $third-party
                lines.push('! 全局域名拦截（AdGuard DNS 兼容，无修饰符）');
                globalDomains.forEach(host => lines.push(`||${host}^`));
                lines.push('');
            }

            return lines.join('\n');
        }

        showAdGuardExportPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';
            const rulesText = this.generateAdGuardRules();

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">🛡️ 导出 AdGuard 规则</h3>
                <p class="hint-text">已将当前所有拦截规则转换为 AdGuard / uBlock Origin 兼容语法。元素隐藏规则 (## / #?#) 可导入 AdGuard 浏览器扩展或 uBlock Origin；全局域名拦截段含 DNS 兼容版 (||domain^)，可导入 AdGuard DNS / AdGuard Home。</p>
                <div class="export-box" id="ag-export-box"></div>
                <div class="btn-group">
                    <button class="btn-primary" id="btn-ag-copy">📋 复制全部</button>
                    <button class="btn-success" id="btn-ag-download">💾 下载 txt</button>
                    <button class="btn-outline" id="btn-ag-back">返回</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            const box = panel.querySelector('#ag-export-box');
            box.textContent = rulesText || '! 当前没有可转换的规则';

            panel.querySelector('#btn-ag-copy').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(rulesText);
                    alert('AdGuard 规则已复制到剪贴板！');
                } catch (e) {
                    const range = document.createRange();
                    range.selectNode(box);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    try { document.execCommand('copy'); alert('已复制！'); }
                    catch (e2) { alert('复制失败，请手动复制。'); }
                }
            });

            panel.querySelector('#btn-ag-download').addEventListener('click', () => {
                const blob = new Blob([rulesText], { type: 'text/plain;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `adguard-rules-${new Date().toISOString().slice(0, 10)}.txt`;
                a.click();
                URL.revokeObjectURL(url);
            });

            panel.querySelector('#btn-ag-back').addEventListener('click', () => this.showManager());
        }

        showImportPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">📥 导入规则</h3>
                <p>将之前导出的规则 JSON 文本粘贴到下方文本框，选择导入模式后点击"开始导入"。</p>
                <label for="import-mode">导入模式</label>
                <select id="import-mode">
                    <option value="merge" selected>合并导入（推荐，自动去重）</option>
                    <option value="replace">覆盖导入（清空现有规则后导入）</option>
                </select>
                <label for="import-text">规则 JSON 文本</label>
                <textarea id="import-text" placeholder='在此粘贴导出的 JSON 文本...'></textarea>
                <div class="btn-group" style="margin-top: 10px;">
                    <button class="btn-primary" id="btn-do-import">开始导入</button>
                    <button class="btn-outline" id="btn-back">返回</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            panel.querySelector('#btn-do-import').addEventListener('click', () => {
                const text = panel.querySelector('#import-text').value.trim();
                if (!text) { alert('请粘贴规则 JSON 文本。'); return; }
                const mode = panel.querySelector('#import-mode').value;
                try {
                    storage.importAll(text, mode === 'merge');
                    alert('导入成功！页面即将刷新以应用规则。');
                    window.location.reload();
                } catch (e) {
                    alert('导入失败：' + e.message);
                }
            });

            panel.querySelector('#btn-back').addEventListener('click', () => this.showManager());
        }

        clearPanel() {
            if (this._actionPreview && this._actionPreview.active) {
                const el = this._actionPreview.el;
                if (el) {
                    el.style.removeProperty('display');
                }
                this._actionPreview = { active: false, el: null };
            }
            if (this._previewAffectedElements && this._previewAffectedElements.length > 0) {
                this._previewAffectedElements.forEach(item => {
                    if (item.el) {
                        item.el.style.removeProperty('display');
                        item.el.style.removeProperty('opacity');
                    }
                });
                this._previewAffectedElements = [];
            }
            this._clearSelectionHighlight();

            const oldPanel = this.shadowRoot.querySelector('.panel');
            if (oldPanel && typeof oldPanel._cleanupDrag === 'function') {
                oldPanel._cleanupDrag();
            }
            this.shadowRoot.innerHTML = '';
            this.injectStyles();
        }
    }

    // ================= 初始化与执行流 =================

    BlockEngine.fastInject();
    BlockEngine.startObserver();

    if (window.self === window.top) {
        let uiInstance = null;
        function getUI() {
            if (!uiInstance) uiInstance = new UIManager();
            return uiInstance;
        }

        GM_registerMenuCommand('🖱 手动选择屏蔽元素', () => getUI().startSelection());
        GM_registerMenuCommand('🌐 全局检索域名', () => getUI().showGlobalDomainPanel());
        GM_registerMenuCommand('📝 添加文本/正则/积木/属性/路径规则', () => getUI().showRegexPanel());
        GM_registerMenuCommand('⚙️ 管理规则与防御策略', () => getUI().showManager());
        GM_registerMenuCommand('📤 导出规则（跨设备迁移）', () => getUI().showExportPanel());
        GM_registerMenuCommand('🛡️ 导出 AdGuard 规则', () => getUI().showAdGuardExportPanel());
        GM_registerMenuCommand('📥 导入规则', () => getUI().showImportPanel());
    }

})();
