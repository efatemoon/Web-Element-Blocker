// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.6.0
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。双算法协同：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）。v0.6.0：Toast/Modal替代alert/confirm、规则启用/禁用、操作撤销栈、覆盖层扫描异步化、预览逻辑统一引擎、批量删除、错误边界兜底、移除3处死代码。
// @author       EFate
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/web-element-blocker.user.js
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
    // 广告关键词 Set 查表：替代 40+ 交替分支正则，O(tokens) 精确匹配 vs 正则回溯
    // 正则 /ads|adnxs|.../ 在 test() 时对整个 hostname 做回溯匹配，Set 查表按 token 精确命中
    const AD_KEYWORD_SET = new Set([
        'ads', 'adnxs', 'advert', 'banner', 'doubleclick', 'googlesyndication',
        'googleads', 'google-analytics', 'googletag', 'gstatic', 'googleapis',
        'facebook', 'fbcdn', 'twitter', 'adsystem', 'amazon-adsystem', 'outbrain',
        'taboola', 'mgid', 'popads', 'propeller', 'onclickads', 'revcontent',
        'yandex', 'baidu', 'toutiao', 'pangolin', 'gdt', 'mob', 'umeng',
        'umengcloud', 'sentry', 'analytics', 'tracking', 'tracker', 'stats',
        'metrics', 'ping', 'beacon', 'pixel', 'logger'
    ]);
    // 赌博/色情/可疑跳转常用 TLD：被博彩站广泛滥用
    // 扩展高频滥用 TLD：免费域名（tk/ml/ga/cf/gq）与廉价批量注册域（pw/buzz/cyou/monster/rest/cfd/sbs）
    const GAMBLING_TLDS = new Set([
        'cc', 'vip', 'top', 'xyz', 'club', 'icu', 'asia', 'kim', 'win', 'bet',
        'loan', 'review', 'trade', 'stream', 'download', 'live', 'shop', 'fun',
        'space', 'racing', 'party',
        'pw', 'tk', 'ml', 'ga', 'cf', 'gq', 'buzz', 'cyou', 'monster',
        'rest', 'cfd', 'bar', 'sbs', 'cymru', 'wales'
    ]);
    // 检测 hostname 是否含广告关键词：按非字母数字分词后逐 token 查 Set
    const isAdKeywordHost = (hostname) => {
        if (!hostname || typeof hostname !== 'string') return false;
        const lower = hostname.toLowerCase();
        const tokens = lower.split(/[^a-z0-9-]/);
        for (let i = 0; i < tokens.length; i++) {
            if (AD_KEYWORD_SET.has(tokens[i])) return true;
        }
        // 赌博 TLD 上的纯数字域名 / 含赌博词域名 → 直接判定为广告
        const labels = lower.split('.');
        if (labels.length >= 2 && GAMBLING_TLDS.has(labels[labels.length - 1])) {
            const sld = labels[labels.length - 2] || '';
            // 5955123.cc / 016.com 这种纯数字博彩域
            if (/^\d+$/.test(sld)) return true;
            // 含赌博/色情词：casino888.cc / bet365.cc / ag-bbin.vip 等
            const viceKeywords = [
                'casino', 'bet', 'poker', 'bocai', 'porn', 'sex', 'cam',
                'slot', 'lottery', 'jackpot', 'gamble', 'wager', 'lucky',
                'adult', 'xxx', 'hentai', 'nsfw', 'live', 'hookup',
                'ag', 'bbin', 'mg', 'pt', 'sb', 'ibc', 'sbo', 'cmd',
                'sunbet', 'maxbet', 'yazhou', 'caipiao', 'cp'
            ];
            for (const kw of viceKeywords) {
                if (sld.includes(kw)) return true;
            }
        }
        // 纯数字二级域（4 位及以上）+ 可疑 TLD：典型博彩短链域名特征
        if (labels.length >= 2) {
            const sld = labels[labels.length - 2] || '';
            if (/^\d{4,}$/.test(sld) && GAMBLING_TLDS.has(labels[labels.length - 1])) {
                return true;
            }
        }
        return false;
    };

    /**
     * 核心数据与配置管理模块
     * 规则分类（前7类按域名隔离，domainBlock全局生效）：
     *   static / dynamic / regex / attribute / structural / complex / pathPattern / domainBlock
     */
    class StorageManager {
        constructor() {
            this.domain = window.location.hostname;
            this.flashList = GM_getValue('pro_blocker_flash_domains', {});
            // 防抖落盘：内存镜像暂存待写数据，300ms 内合并多次 GM_setValue 为一次写入
            this._pendingWrites = {};
            this._saveTimer = null;
            // 页面卸载前强制落盘，防止防抖窗口内的规则丢失
            window.addEventListener('beforeunload', () => this._flush(), { capture: true });
        }

        // 读取：优先从待写缓存取，保证防抖窗口内 getData 等读取一致
        _readKey(key, defaultValue) {
            if (key in this._pendingWrites) return this._pendingWrites[key];
            return GM_getValue(key, defaultValue);
        }

        // 标记脏数据并防抖落盘
        _markDirty(key, value) {
            this._pendingWrites[key] = value;
            if (this._saveTimer) clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this._flush(), 300);
        }

        // 立即落盘所有待写数据
        _flush() {
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveTimer = null;
            }
            for (const key in this._pendingWrites) {
                GM_setValue(key, this._pendingWrites[key]);
            }
            this._pendingWrites = {};
        }

        // 域名黑名单统一为对象结构 {domain, _ts}：兼容历史 string[] 与对象[]，去重并保留时间戳，
        // 供管理面板按最近过滤时间倒序展示（"最近过滤规则置顶"）
        _normDomains(arr) {
            if (!Array.isArray(arr)) return [];
            const out = [];
            const seen = new Set();
            arr.forEach(item => {
                const domain = (typeof item === 'string') ? item : (item && item.domain);
                if (!domain || typeof domain !== 'string' || domain.length === 0 || domain.length >= 200 || seen.has(domain)) return;
                seen.add(domain);
                const ts = (item && typeof item === 'object' && typeof item._ts === 'number') ? item._ts : 0;
                out.push({ domain, _ts: ts });
            });
            return out;
        }

        // 统一读取入口：始终返回归一化后的 {domain, _ts} 对象数组
        getDomainBlocks() {
            return this._normDomains(this._readKey('domainBlocks', []));
        }

        getData() {
            if (this._cachedData && this._cachedDataDomain === this.domain) return this._cachedData;
            this._cachedDataDomain = this.domain;
            this._cachedData = {
                static: this._readKey('blocks', {})[this.domain] || [],
                dynamic: this._readKey('dynamicBlocks', {})[this.domain] || [],
                regex: this._readKey('regexBlocks', {})[this.domain] || [],
                attribute: this._readKey('attrBlocks', {})[this.domain] || [],
                structural: this._readKey('structBlocks', {})[this.domain] || [],
                complex: this._readKey('complexBlocks', {})[this.domain] || [],
                pathPattern: this._readKey('pathPatternBlocks', {})[this.domain] || [],
                config: this._readKey('config', {})[this.domain] || { mode: 'auto' },
                domainBlock: this.getDomainBlocks()
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
            const allData = this._readKey(key, {});
            if (rules.length === 0) delete allData[this.domain];
            else allData[this.domain] = rules;
            this._markDirty(key, allData);
            this.invalidateDataCache();
            BlockEngine.invalidateCache();
            if (type !== 'regex' && type !== 'complex') BlockEngine.applyCSSRules();
        }

        addRule(type, rule) {
            if (type === 'domainBlock') {
                const list = this.getDomainBlocks();
                if (rule.domain && !list.some(r => r.domain === rule.domain)) {
                    list.push({ domain: rule.domain, _ts: Date.now() });
                    this._markDirty('domainBlocks', list);
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
                (type === 'complex' && JSON.stringify(item.conditions) === JSON.stringify(rule.conditions) && item.level === rule.level && item.logic === rule.logic) ||
                (type === 'pathPattern' && item.pattern === rule.pattern)
            );
            if (!isDuplicate) {
                // 记录添加时间戳，供"规则与防御管理 / 按网站查看所有规则"面板按最近过滤时间倒序展示
                rule._ts = Date.now();
                data.push(rule);
                this.saveData(type, data);
            }
        }

        removeRule(type, index) {
            if (type === 'domainBlock') {
                const list = this.getDomainBlocks();
                if (list[index]) {
                    list.splice(index, 1);
                    this._markDirty('domainBlocks', list);
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
                // saveData 对 regex/complex 跳过 applyCSSRules（正确），但也未重新应用
                // regex/complex 规则。补回：删除后立即重新应用剩余规则，避免旧内联隐藏残留（Bug2.1）
                if (type === 'regex') BlockEngine.applyRegexRules();
                if (type === 'complex') BlockEngine.applyComplexRules();
            }
        }

        // 跨域名删除：供"按网站查看所有规则"面板使用，可删除任意域名下的规则
        removeRuleForDomain(domain, type, index) {
            const keyMap = {
                'static': 'blocks', 'dynamic': 'dynamicBlocks', 'regex': 'regexBlocks',
                'attribute': 'attrBlocks', 'structural': 'structBlocks',
                'complex': 'complexBlocks', 'pathPattern': 'pathPatternBlocks'
            };
            const key = keyMap[type];
            if (!key) return false;
            const allData = this._readKey(key, {});
            const arr = allData[domain];
            if (!Array.isArray(arr) || !arr[index]) return false;
            arr.splice(index, 1);
            if (arr.length === 0) delete allData[domain]; // 清空后移除域名键，避免空键残留
            this._markDirty(key, allData);
            this.invalidateDataCache();
            BlockEngine.invalidateCache();
            BlockEngine.applyCSSRules();
            if (type === 'regex') BlockEngine.applyRegexRules();
            if (type === 'complex') BlockEngine.applyComplexRules();
            return true;
        }

        // 跨域名添加规则：供撤销系统恢复跨站删除的规则（与 removeRuleForDomain 配对）
        addRuleForDomain(domain, type, rule) {
            const keyMap = {
                'static': 'blocks', 'dynamic': 'dynamicBlocks', 'regex': 'regexBlocks',
                'attribute': 'attrBlocks', 'structural': 'structBlocks',
                'complex': 'complexBlocks', 'pathPattern': 'pathPatternBlocks'
            };
            const key = keyMap[type];
            if (!key) return false;
            const allData = this._readKey(key, {});
            if (!Array.isArray(allData[domain])) allData[domain] = [];
            rule._ts = rule._ts || Date.now();
            allData[domain].push(rule);
            this._markDirty(key, allData);
            this.invalidateDataCache();
            BlockEngine.invalidateCache();
            BlockEngine.applyCSSRules();
            if (type === 'regex') BlockEngine.applyRegexRules();
            if (type === 'complex') BlockEngine.applyComplexRules();
            return true;
        }

        // 规则启用/禁用切换：标记 _disabled=true 后所有 apply* 方法跳过该规则，
        // 实现临时禁用而无需删除（用户可随时启用恢复）。domainBlock 同样支持。
        toggleRuleDisabled(type, index, domain) {
            if (type === 'domainBlock') {
                const list = this.getDomainBlocks();
                if (!list[index]) return false;
                list[index]._disabled = !list[index]._disabled;
                this._markDirty('domainBlocks', list);
                this.invalidateDataCache();
                BlockEngine.invalidateCache();
                BlockEngine.applyCSSRules();
                BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                return list[index]._disabled;
            }
            const keyMap = {
                'static': 'blocks', 'dynamic': 'dynamicBlocks', 'regex': 'regexBlocks',
                'attribute': 'attrBlocks', 'structural': 'structBlocks',
                'complex': 'complexBlocks', 'pathPattern': 'pathPatternBlocks'
            };
            const key = keyMap[type];
            if (!key) return false;
            const targetDomain = domain || this.domain;
            const allData = this._readKey(key, {});
            const arr = allData[targetDomain];
            if (!Array.isArray(arr) || !arr[index]) return false;
            arr[index]._disabled = !arr[index]._disabled;
            this._markDirty(key, allData);
            this.invalidateDataCache();
            BlockEngine.invalidateCache();
            // 重新应用受影响的规则类型
            BlockEngine.applyCSSRules();
            if (type === 'regex') BlockEngine.applyRegexRules();
            if (type === 'complex') BlockEngine.applyComplexRules();
            BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
            return arr[index]._disabled;
        }

        // 收集所有"按域名隔离"的规则（不含全局 domainBlock），供跨站管理面板使用
        getAllSiteRules() {
            this._flush(); // 读取前强制落盘，确保跨站面板看到最新数据
            const dictMap = {
                'blocks': { type: 'static', label: '静态', tag: '' },
                'dynamicBlocks': { type: 'dynamic', label: '动态', tag: '' },
                'regexBlocks': { type: 'regex', label: '正则', tag: '' },
                'attrBlocks': { type: 'attribute', label: '属性', tag: 'attr' },
                'structBlocks': { type: 'structural', label: '位置', tag: 'struct' },
                'complexBlocks': { type: 'complex', label: '积木', tag: 'complex' },
                'pathPatternBlocks': { type: 'pathPattern', label: '路径', tag: 'path' }
            };
            const records = [];
            Object.keys(dictMap).forEach(key => {
                const allData = GM_getValue(key, {});
                for (const domain in allData) {
                    if (!Object.prototype.hasOwnProperty.call(allData, domain)) continue;
                    const arr = allData[domain];
                    if (!Array.isArray(arr)) continue;
                    arr.forEach((r, i) => {
                        if (!r || typeof r !== 'object') return;
                        records.push({
                            domain, index: i,
                            type: dictMap[key].type, label: dictMap[key].label, tag: dictMap[key].tag,
                            rule: r
                        });
                    });
                }
            });
            // 按 _ts 倒序：最近添加的规则置顶（解决问题7）。旧规则无 _ts 视为 0，稳定排序保持原顺序。
            records.sort((a, b) => (b.rule._ts || 0) - (a.rule._ts || 0));
            return records;
        }


        clearDomain() {
            ['blocks', 'dynamicBlocks', 'regexBlocks', 'attrBlocks', 'structBlocks', 'complexBlocks', 'pathPatternBlocks', 'config'].forEach(key => {
                const data = this._readKey(key, {});
                delete data[this.domain];
                this._markDirty(key, data);
            });
            if (this.flashList[this.domain]) {
                delete this.flashList[this.domain];
                this._markDirty('pro_blocker_flash_domains', this.flashList);
            }
            // 同步清除自愈计数残留，避免迁移/重置后遗留无效状态
            const cleanLoads = this._readKey('pro_blocker_clean_loads', {});
            if (cleanLoads[this.domain]) {
                delete cleanLoads[this.domain];
                this._markDirty('pro_blocker_clean_loads', cleanLoads);
            }
            BlockEngine.invalidateCache();
        }

        // ================= 导出/导入（v2.0 结构化格式 + v1.0 向后兼容） =================
        // v2.0 格式：meta + domains(纯字符串[]) + sites(按域名分组) + config + flashDomains
        // 设计要点：规则 ID（murmur32 前4位）、域名去 _ts 简化、站点规则按域名聚合、v1.0 自动识别转换

        // 存储键 → v2.0 站点桶名映射
        static _KEY_TO_BUCKET = {
            'blocks': 'static',
            'dynamicBlocks': 'dynamic',
            'regexBlocks': 'regex',
            'attrBlocks': 'attribute',
            'structBlocks': 'structural',
            'complexBlocks': 'complex',
            'pathPatternBlocks': 'pathPattern'
        };

        exportAll() {
            this._flush(); // 导出前强制落盘，确保待写数据已持久化

            // 收集所有有规则的站点域名
            const allSiteDomains = new Set();
            Object.keys(this.constructor._KEY_TO_BUCKET).forEach(key => {
                const dict = this._readKey(key, {});
                Object.keys(dict).forEach(d => {
                    if (Array.isArray(dict[d]) && dict[d].length > 0) allSiteDomains.add(d);
                });
            });

            // 按站点聚合规则，每条规则附加 id（murmur32 前4位）
            const sites = {};
            let totalRules = 0;
            allSiteDomains.forEach(domain => {
                const site = {};
                Object.keys(this.constructor._KEY_TO_BUCKET).forEach(key => {
                    const dict = this._readKey(key, {});
                    const rules = dict[domain];
                    if (Array.isArray(rules) && rules.length > 0) {
                        const bucket = this.constructor._KEY_TO_BUCKET[key];
                        site[bucket] = rules.map(r => {
                            // id 基于规则内容（排除 id 自身）计算，确保同一规则始终同 ID
                            const { id, ...rest } = r;
                            return { ...r, id: BlockEngine.murmur32(JSON.stringify(rest)).slice(0, 4) };
                        });
                        totalRules += rules.length;
                    }
                });
                if (Object.keys(site).length > 0) sites[domain] = site;
            });

            // 域名黑名单：导出时去掉 _ts，纯字符串数组（导入端自动补 _ts: Date.now()）
            const domains = this.getDomainBlocks().map(r => r.domain).filter(Boolean);

            // 配置与闪现域名
            const config = this._readKey('config', {});
            const flashDict = this._readKey('pro_blocker_flash_domains', {});
            const flashDomains = Object.keys(flashDict).filter(d => flashDict[d]);

            const exportData = {
                meta: {
                    version: '2.0',
                    exportedAt: new Date().toISOString(),
                    scriptVersion: GM_info && GM_info.script && GM_info.script.version || 'unknown',
                    counts: {
                        domains: domains.length,
                        siteRules: totalRules,
                        sites: Object.keys(sites).length,
                    }
                },
                domains,
                sites,
                config,
                flashDomains,
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
            // 覆盖模式确认已移至 UI 层（showImportPanel），此处直接执行

            // v2.0 格式检测：有 sites 键时展开为 v1.0 平铺字典，复用已有合并/覆盖逻辑
            // v1.0 格式（有 blocks/dynamicBlocks 等平铺键）直接走下方原有逻辑
            if (importData.sites && typeof importData.sites === 'object') {
                const BUCKET_TO_KEY = {
                    'static': 'blocks',
                    'dynamic': 'dynamicBlocks',
                    'regex': 'regexBlocks',
                    'attribute': 'attrBlocks',
                    'structural': 'structBlocks',
                    'complex': 'complexBlocks',
                    'pathPattern': 'pathPatternBlocks'
                };
                // 将 v2.0 sites 展开为 v1.0 平铺字典
                for (const bucket in BUCKET_TO_KEY) {
                    const key = BUCKET_TO_KEY[bucket];
                    if (!importData[key]) importData[key] = {};
                    for (const domain in importData.sites) {
                        const siteData = importData.sites[domain];
                        if (siteData[bucket] && Array.isArray(siteData[bucket])) {
                            // 剥离 id 字段（id 仅用于导出/管理面板，内部存储不需要）
                            importData[key][domain] = siteData[bucket].map(r => {
                                if (r && typeof r === 'object' && 'id' in r) {
                                    const { id, ...rest } = r;
                                    return rest;
                                }
                                return r;
                            });
                        }
                    }
                }
                // 域名黑名单：v2.0 为纯 string[]，转为 {domain, _ts}[] 供 _normDomains 处理
                if (Array.isArray(importData.domains)) {
                    importData['domainBlocks'] = importData.domains.map(d => ({ domain: d, _ts: Date.now() }));
                }
                // flashDomains: v2.0 为 string[]，转为 dict 供原有逻辑处理
                if (Array.isArray(importData.flashDomains)) {
                    const flashDict = {};
                    importData.flashDomains.forEach(d => { flashDict[d] = true; });
                    importData['pro_blocker_flash_domains'] = flashDict;
                }
            }

            const dictKeys = ['blocks', 'dynamicBlocks', 'regexBlocks', 'attrBlocks', 'structBlocks', 'complexBlocks', 'pathPatternBlocks', 'config', 'pro_blocker_flash_domains'];
            dictKeys.forEach(key => {
                const incoming = importData[key];
                if (merge) {
                    if (!incoming || typeof incoming !== 'object') return;
                    const existing = this._readKey(key, {});
                    for (let d in incoming) {
                        if (!Object.prototype.hasOwnProperty.call(incoming, d)) continue;
                        if (!existing[d]) {
                            existing[d] = incoming[d];
                        } else if (Array.isArray(existing[d]) && Array.isArray(incoming[d])) {
                            // 去重 O(N+M)：用 JSON 指纹建 Set，避免 O(N×M) 的 some() 线性扫描
                            // 排除 _ts 字段：同一逻辑规则在不同时间添加 _ts 不同，若纳入指纹会导致重复导入
                            const fingerprint = (x) => {
                                if (!x || typeof x !== 'object') return JSON.stringify(x);
                                const { _ts, ...rest } = x;
                                return JSON.stringify(rest);
                            };
                            const existingSet = new Set(existing[d].map(fingerprint));
                            incoming[d].forEach(item => {
                                if (item && typeof item === 'object') {
                                    const fp = fingerprint(item);
                                    if (!existingSet.has(fp)) {
                                        existingSet.add(fp);
                                        existing[d].push(item);
                                    }
                                }
                            });
                        } else {
                            existing[d] = incoming[d];
                        }
                    }
                    this._markDirty(key, existing);
                } else {
                    // 覆盖模式：导入数据成为新状态；缺失键显式清空，确保"覆盖"语义完整
                    this._markDirty(key, (incoming && typeof incoming === 'object') ? incoming : {});
                }
            });
            // 域名黑名单：归一化兼容历史 string[] 与新版 {domain,_ts}[]，去重后合并/覆盖
            if (Array.isArray(importData['domainBlocks'])) {
                const incoming = this._normDomains(importData['domainBlocks']);
                if (merge) {
                    const existing = this.getDomainBlocks();
                    const existingSet = new Set(existing.map(x => x.domain));
                    incoming.forEach(r => {
                        if (!existingSet.has(r.domain)) {
                            existingSet.add(r.domain);
                            existing.push(r);
                        }
                    });
                    this._markDirty('domainBlocks', existing);
                } else {
                    this._markDirty('domainBlocks', incoming);
                }
            } else if (!merge) {
                this._markDirty('domainBlocks', []); // 覆盖模式缺失则清空全局域名黑名单
            }
            BlockEngine.invalidateCache();
            this.invalidateDataCache();
            BlockEngine.applyCSSRules();
            BlockEngine.applyRegexRules();
            BlockEngine.applyComplexRules();
            return true;
        }

        markAsFlashing() {
            if (!this.flashList[this.domain]) {
                this.flashList[this.domain] = true;
                this._markDirty('pro_blocker_flash_domains', this.flashList);
            }
            // 闪现复发 → 复位干净加载计数（打断自愈进程）
            const cleanLoads = this._readKey('pro_blocker_clean_loads', {});
            if (cleanLoads[this.domain]) {
                cleanLoads[this.domain] = 0;
                this._markDirty('pro_blocker_clean_loads', cleanLoads);
            }
        }

        // 自愈机制：本次加载未发生闪现时调用。连续 CLEAN_LOAD_THRESHOLD 次干净加载 → 自动清除闪现标记
        // 避免 flashList 永久锁定 preemptive，让"系统评估"真正反映当前规则有效性
        recordCleanLoad() {
            if (!this.flashList[this.domain]) return false;
            const CLEAN_LOAD_THRESHOLD = 3;
            const cleanLoads = this._readKey('pro_blocker_clean_loads', {});
            cleanLoads[this.domain] = (cleanLoads[this.domain] || 0) + 1;
            if (cleanLoads[this.domain] >= CLEAN_LOAD_THRESHOLD) {
                delete this.flashList[this.domain];
                delete cleanLoads[this.domain];
                this._markDirty('pro_blocker_flash_domains', this.flashList);
                this._markDirty('pro_blocker_clean_loads', cleanLoads);
                this.invalidateDataCache();
                return true; // 自愈完成
            }
            this._markDirty('pro_blocker_clean_loads', cleanLoads);
            return false;
        }

        // 手动重置闪现标记（用户确认规则已生效后清除 preemptive 强制启用）
        resetFlash() {
            let changed = false;
            if (this.flashList[this.domain]) {
                delete this.flashList[this.domain];
                this._markDirty('pro_blocker_flash_domains', this.flashList);
                changed = true;
            }
            const cleanLoads = this._readKey('pro_blocker_clean_loads', {});
            if (cleanLoads[this.domain]) {
                delete cleanLoads[this.domain];
                this._markDirty('pro_blocker_clean_loads', cleanLoads);
            }
            if (changed) this.invalidateDataCache();
            return changed;
        }

        getCleanLoadCount() {
            return (this._readKey('pro_blocker_clean_loads', {})[this.domain]) || 0;
        }

        toggleMode() {
            const currentMode = this.getData().config.mode;
            const nextMode = currentMode === 'auto' ? 'preemptive' : 'auto';
            const allConfig = this._readKey('config', {});
            allConfig[this.domain] = { mode: nextMode };
            this._markDirty('config', allConfig);
            this.invalidateDataCache();
            return nextMode;
        }

    }

    const storage = new StorageManager();

    /**
     * 路径规则倒排索引：提取每条 pattern 最长 ≥4 字符 token 建 Map<token, Set<pattern>>，
     * 匹配时仅对 URL 中出现的 token 对应候选 pattern 做字面子串校验，将 O(N) 线性遍历降为 O(tokens) 查找。
     * 无 ≥4 token 的 pattern 进入 fallback 线性表。供网络层 isUrlBlocked 使用；
     * DOM 扫描仍用合并正则（getPathMatcher）以支持 .exec() 提取匹配串日志。
     */
    class PathInvertedIndex {
        static _tokenIndex = new Map();   // token -> Set<{raw, lower}>
        static _fallback = [];            // 无 ≥4 token 的 pattern，存 {raw, lower}
        static _patternCount = 0;

        static build(rawPatterns) {
            this._tokenIndex = new Map();
            this._fallback = [];
            this._patternCount = 0;
            rawPatterns.forEach(pattern => {
                if (!pattern) return;
                this._patternCount++;
                // 预计算小写：test() 热路径中直接用 .lower 字段，消除每次 toLowerCase() 的字符串分配
                const entry = { raw: pattern, lower: pattern.toLowerCase() };
                const token = this._extractToken(entry.lower);
                if (token) {
                    if (!this._tokenIndex.has(token)) this._tokenIndex.set(token, new Set());
                    this._tokenIndex.get(token).add(entry);
                } else {
                    this._fallback.push(entry);
                }
            });
        }

        // 提取最长 ≥4 字符的字母数字 token 作为该 pattern 的倒排键
        static _extractToken(str) {
            const tokens = str.split(/[^a-z0-9]/);
            let maxToken = '';
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].length > maxToken.length) maxToken = tokens[i];
            }
            return maxToken.length >= 4 ? maxToken : null;
        }

        // 字面子串匹配：URL pathStr 含任一 pattern 即命中
        static test(pathStr) {
            if (this._patternCount === 0) return false;
            const lower = pathStr.toLowerCase();
            const tokens = lower.split(/[^a-z0-9]/);
            // 仅校验 token 命中的候选 pattern，跳过绝大多数无关规则
            const candidates = new Set();
            for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].length >= 4) {
                    const set = this._tokenIndex.get(tokens[i]);
                    if (set) set.forEach(p => candidates.add(p));
                }
            }
            for (const p of candidates) {
                if (lower.includes(p.lower)) return true;
            }
            // fallback：无 token 的 pattern 逐一字面子串校验
            for (let i = 0; i < this._fallback.length; i++) {
                if (lower.includes(this._fallback[i].lower)) return true;
            }
            return false;
        }

        static get size() { return this._patternCount; }
    }




    /**
     * 拦截引擎：DOM/CSS 控制 + 动态扫描
     */
    class BlockEngine {
        static styleElementId = 'pro-blocker-core-css';
        static _cachedDomainList = null;
        static _cachedDomainSet = null;
        static _cachedPathPatterns = null;
        static _cachedPathRegex = null; // 合并路径正则缓存：false 表示无路径规则
        static _cachedPathIndex = null; // 倒排索引构建标记：null=未构建，true=已构建
        static _loggedDomains = new Set();
        static _loggedPatterns = new Set();
        static _loggedOverlays = new Set();
        static _addedNodesBuffer = [];
        // 已扫描节点弱引用集合：避免对同一节点重复执行资源域/路径扫描（O(1) 判重）
        // WeakSet 不阻止 GC，节点从 DOM 移除后自动释放，杜绝内存泄漏
        static _scannedNodes = new WeakSet();
        // CSSOM 增量注入指纹：记录上次注入的选择器集合，内容未变时跳过重建
        static _lastCSSFingerprint = '';
        // Constructable Stylesheets 支持：Chrome 99+/Edge/Firefox 101+ 支持，
        // WebKit 支持不完整，需 Feature Detection 后降级到 <style> + insertRule
        static _supportsConstructable = (typeof CSSStyleSheet !== 'undefined') && ('adoptedStyleSheets' in document);
        // 当前生效的 CSSStyleSheet（构造样式表 或 <style>.sheet），首次 applyCSSRules 时确定
        static _styleSheet = null;
        static _useConstructable = false;
        // 拦截统计：供管理面板看板展示，衡量网络层与 DOM 层拦截成效
        static stats = { networkBlocks: 0, domBlocks: 0, matchTimeMs: 0 };
        // 域名匹配 LRU 缓存：高频场景（同域名 20+ 请求）避免重复 split + 循环，O(1) 命中
        static _hostCache = new Map();
        // URL 级拦截判定 LRU 缓存：SPA 场景同一广告 URL 重复请求时 O(1) 命中
        // 缓存完整 URL → boolean，容量 100，规则变更时清空
        static _urlBlockCache = new Map();
        // 本次页面加载是否检测到广告闪现（fastInject 重置，detectFlashAndMark 置位）
        // load 事件据此判断是否为"干净加载"，驱动 flashList 自愈
        static _flashDetectedThisLoad = false;

        static invalidateCache() {
            this._cachedDomainList = null;
            this._cachedDomainSet = null;
            this._cachedPathPatterns = null;
            this._cachedPathRegex = null;
            this._cachedPathIndex = null; // 倒排索引标记重置，下次 isUrlBlocked 重建
            this._lastCSSFingerprint = ''; // 规则变更后强制下次 applyCSSRules 重建样式表
            this._hostCache.clear(); // 域名黑名单变更后清空 LRU 缓存，避免过期决策
            this._urlBlockCache.clear(); // URL 拦截缓存一并清空，避免规则变更后旧决策残留
        }

        // 构建路径倒排索引（网络层专用）：仅当 _cachedPathIndex !== true 时重建。
        // DOM 扫描仍用 getPathMatcher() 以支持 .exec() 提取匹配串日志。
        static _ensurePathIndex() {
            if (this._cachedPathIndex === true) return;
            const patterns = (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern.filter(r => !r._disabled))
                .map(r => r && r.pattern).filter(Boolean);
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = patterns;
            PathInvertedIndex.build(patterns);
            this._cachedPathIndex = true;
        }

        // 获取域名集合（与 _cachedDomainList 同生命周期），供网络拦截器与动态扫描复用
        // domainBlocks 已迁移为 {domain,_ts}[]，此处抽取 domain 字符串构建 Set
        // 过滤 _disabled=true 的规则：禁用的域名不参与网络层拦截
        static getDomainSet() {
            if (this._cachedDomainSet === null) {
                const list = this._cachedDomainList !== null ? this._cachedDomainList : storage.getDomainBlocks().filter(r => !r._disabled).map(r => r.domain);
                if (this._cachedDomainList === null) this._cachedDomainList = list;
                this._cachedDomainSet = new Set(list);
            }
            return this._cachedDomainSet;
        }

        // 获取合并路径正则：多条路径模式合并为单个 RegExp，O(L) 一次匹配替代 O(n) 线性遍历
        // 返回 RegExp 或 false（无路径规则时）
        static getPathMatcher() {
            if (this._cachedPathRegex !== null) return this._cachedPathRegex;
            const patterns = (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern.filter(r => !r._disabled))
                .map(r => r && r.pattern).filter(Boolean)
                .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            this._cachedPathRegex = patterns.length > 0 ? new RegExp(patterns.join('|')) : false;
            return this._cachedPathRegex;
        }



        // URL 拦截判定：域名黑名单 + 路径模式，供 NetworkInterceptor 与动态扫描复用
        // 路径匹配走倒排索引（O(tokens) 候选过滤），网络层高频调用受益最大
        static isUrlBlocked(url) {
            if (!url || typeof url !== 'string') return false;
            // URL 级 LRU 缓存：SPA 场景同一广告 URL 重复请求时 O(1) 命中
            const cached = this._urlBlockCache.get(url);
            if (cached !== undefined) return cached;
            let result = false;
            try {
                const absUrl = new URL(url, location.href);
                // 仅排除与当前页完全同域的请求（避免拦截页面自身导航/根资源致页面白屏），
                // 子域不在豁免范围：用户显式拉黑的 ads.example.com 在 example.com 下必须生效
                if (absUrl.hostname && absUrl.hostname !== location.hostname) {
                    // 1. 精确域名黑名单
                    if (this.hostnameBlocked(absUrl.hostname, this.getDomainSet())) result = true;
                }
                if (!result) {
                    const pathStr = absUrl.pathname + absUrl.search;
                    // 2. 精确路径模式（倒排索引 O(tokens) 候选过滤）
                    this._ensurePathIndex();
                    if (PathInvertedIndex.size > 0 && PathInvertedIndex.test(pathStr)) result = true;
                }
            } catch (e) { }
            // LRU 淘汰：缓存满 100 条时淘汰最旧条目
            if (this._urlBlockCache.size >= 100) {
                this._urlBlockCache.delete(this._urlBlockCache.keys().next().value);
            }
            this._urlBlockCache.set(url, result);
            return result;
        }

        // ReDoS 静态预检：在执行前检测危险模式，拒绝执行可能引发灾难性回溯的正则
        // 替代原"执行后检测耗时"的伪保护（ReDoS 在 test() 内部阻塞，事后检测无法阻止卡顿）
        // 仅检测嵌套量词（真正的 ReDoS 元凶），移除过于保守的"重叠分支"检测（误杀率高）
        static isRegexSafe(pattern) {
            if (!pattern || typeof pattern !== 'string') return false;
            // 嵌套量词检测：(a+)+, (a*)*, (a{1,3})+, (a+)? 等
            if (/\([^)]*[+*?][^)]*\)[+*?]/.test(pattern)) return false;
            if (/\([^)]*\{\d+(?:,\d*)?\}[^)]*\)[+*?]/.test(pattern)) return false;
            return true;
        }

        /**
         * 域名匹配（最优算法）：用 Set 做精确匹配 O(1)，再逐级上探父域 O(depth)
         * 替代原 domainList.some(hostname === d || hostname.endsWith('.' + d)) 的 O(n) 线性扫描
         * 例如 ads.example.com → 先查精确，再查 example.com，再查 com（TLD 单独不计）
         * 当黑名单 40+ 域名时，单次匹配从 O(40) 降为 O(2~3)
         * LRU 缓存：高频场景（同域名 20+ 请求）直接 O(1) 命中缓存，避免重复 split + 循环
         */
        static hostnameBlocked(host, domainSet) {
            if (!host || !domainSet || domainSet.size === 0) return false;
            host = String(host).toLowerCase();
            const cached = this._hostCache.get(host);
            if (cached !== undefined) return cached;
            let result = this._rawHostnameMatch(host, domainSet);
            // LRU 淘汰：缓存满 200 条时淘汰最旧条目（Map 保持插入顺序）
            if (this._hostCache.size >= 200) {
                this._hostCache.delete(this._hostCache.keys().next().value);
            }
            this._hostCache.set(host, result);
            return result;
        }

        static _rawHostnameMatch(host, domainSet) {
            if (domainSet.has(host)) return true;
            const parts = host.split('.');
            // 保留至少 TLD：从第二段起逐级上探，避免误匹配单 TLD（如 "com"）
            for (let i = 1; i < parts.length - 1; i++) {
                if (domainSet.has(parts.slice(i).join('.'))) return true;
            }
            return false;
        }

        // 始终在 document-start 注入 CSS，确保广告在首次渲染前即被隐藏
        static fastInject() {
            this._flashDetectedThisLoad = false;
            this.applyCSSRules();
            // preemptive 判定：用户手动开启该模式，或该域名曾被检测到广告闪现（flashList 标记）
            // flashList 由 detectFlashAndMark 自动写入，recordCleanLoad/resetFlash 自动清除（自愈）
            const data = storage.getData();
            const mode = data.config.mode || 'auto';
            const isPreemptive = mode === 'preemptive' || !!storage.flashList[storage.domain];
            if (isPreemptive) {
                // 扫描时序：0/100/300/700/1500ms 递增覆盖，比 5 连续帧（~80ms）更能捕获延迟加载的广告
                // 早期扫描（0/100ms）拦截 document-start 阶段注入的广告；后期扫描兜底异步注入
                const delays = [0, 100, 300, 700, 1500];
                delays.forEach(d => {
                    setTimeout(() => {
                        this.applyCSSRules();
                        if (document.body) {
                            this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                            this.scanInvisibleOverlays({ autoBlock: true });
                        }
                    }, d);
                });
            } else if (!document.documentElement) {
                // auto 模式：documentElement 未就绪时下一帧重试一次
                requestAnimationFrame(() => this.applyCSSRules());
            }
        }

        /**
         * 检测广告闪现：若元素在被拦截前已渲染（有非零尺寸 + 含广告特征），标记域名为闪现域
         * 一旦标记，下次进入该域会自动启用 preemptive 模式；连续 3 次干净加载后自愈清除
         */
        static detectFlashAndMark(element, triggerUrl) {
            if (!element) return;
            try {
                const rect = element.getBoundingClientRect();
                // 阈值 50px：过滤 1x1 追踪像素等非可视闪现，只对真正可见的广告标记
                if (rect.width < 50 || rect.height < 50) return;
                const host = triggerUrl ? new URL(triggerUrl, location.href).hostname : '';
                if (host && isAdKeywordHost(host)) {
                    this._flashDetectedThisLoad = true;
                    storage.markAsFlashing();
                }
            } catch (e) { }
        }

        /**
         * 不可见覆盖层广告扫描：检测"看不见但触屏/点击就跳转"的透明 overlay
         * 典型特征：position:fixed/absolute + opacity:0/visibility:hidden + pointer-events:auto + 大面积
         * autoBlock=true 时直接屏蔽高风险项；返回全部候选供 UI 审阅
         */
        static scanInvisibleOverlays(options = {}) {
            const { autoBlock = true, root = document.documentElement, minSize = 50, _depth = 0 } = options;
            const results = [];
            if (!root || !document.body) return results;
            // Shadow DOM 递归深度限制：浏览器 shadow 嵌套通常 ≤3 层，但恶意/异常页面
            // 可能构造循环引用导致栈溢出，防御性限制最大 5 层
            if (_depth > 5) return results;

            const selfHost = window.location.hostname;

            let candidates;
            try {
                // 扩大选择器范围：ins（广告常用标签）+ 所有带内联事件的元素 + data-* 跳转属性
                // + 内联 position/z-index 的 div（覆盖层广告常通过内联样式定位）
                candidates = root.querySelectorAll(
                    'a, iframe, div, button, span, img, object, embed, ins, ' +
                    '[onclick], [ontouchstart], [onmousedown], ' +
                    '[data-href], [data-url], [data-link], ' +
                    'div[style*="position"], div[style*="z-index"]'
                );
            } catch (e) { return results; }

            candidates.forEach(el => {
                const record = this._checkOverlayCandidate(el, minSize, selfHost, autoBlock);
                if (record) results.push(record);
            });

            // 穿透 Shadow DOM 边界：querySelectorAll 不进入 shadow root，需递归扫描 shadow 内的覆盖层
            // 广告 SDK 常在 shadow 内注入透明跳转层以规避常规选择器，不递归则完全漏拦
            // 脚本自身的 closed shadowRoot 不可访问，且 isProtectedElement 已在候选遍历时排除
            candidates.forEach(el => {
                if (el.shadowRoot && !UIManager.isProtectedElement(el)) {
                    const shadowResults = this.scanInvisibleOverlays({ autoBlock, root: el.shadowRoot, minSize, _depth: _depth + 1 });
                    for (let i = 0; i < shadowResults.length; i++) results.push(shadowResults[i]);
                }
            });

            return results;
        }

        // 单个候选元素的覆盖层检测逻辑（同步/异步扫描共用）
        // 返回 record 或 null（不达标）。autoBlock=true 时对高风险项直接隐藏并标记 blocked
        static _checkOverlayCandidate(el, minSize, selfHost, autoBlock) {
            // 统一保护判定：脚本自身 UI 宿主（含 Shadow DOM 内部）跳过，避免误伤面板
            if (UIManager.isProtectedElement(el)) return null;
            if (el.style.display === 'none') return null;

            // 两阶段过滤：先用廉价的 getBoundingClientRect 过滤面积/视口，
            // 再对达标元素调用昂贵的 getComputedStyle，减少 80%+ 的 getComputedStyle 调用
            const rect = el.getBoundingClientRect();
            if (rect.width < minSize || rect.height < minSize) return null;
            const area = rect.width * rect.height;
            if (area < minSize * minSize) return null;
            // 视口相交判定：离屏定位（如 left:-9999px）的元素无法捕获点击，排除以减少误报
            const vw = window.innerWidth, vh = window.innerHeight;
            if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) return null;

            let style;
            try { style = window.getComputedStyle(el); } catch (e) { return null; }
            if (style.position !== 'fixed' && style.position !== 'absolute') return null;
            if (style.pointerEvents === 'none') return null;
            if (style.display === 'none') return null;

            // 不可见性判定：透明/隐藏但仍可点击
            const opacity = parseFloat(style.opacity);
            // 浏览器对透明背景的序列化可能为 'rgba(0, 0, 0, 0)' 或 'transparent'，两者均需识别
            const bgTransparent = (style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent') &&
                (!style.backgroundImage || style.backgroundImage === 'none');
            const isTransparent = opacity < 0.1 || style.visibility === 'hidden' || bgTransparent;
            if (!isTransparent) return null;

            // 跳转能力判定：自身或子元素可触发跳转
            // 注意：<a href="#"> 的 el.href 会被浏览器解析为"当前URL#"（非 '#'），需排除 hash-only / 空锚点
            const rawHref = el.tagName === 'A' ? el.getAttribute('href') : null;
            const selfHref = rawHref !== null && rawHref !== '' && !rawHref.startsWith('#') &&
                !rawHref.startsWith('javascript:') && !rawHref.startsWith('mailto:');
            const hasOnClick = el.hasAttribute('onclick') || el.hasAttribute('ontouchstart') || el.hasAttribute('onmousedown');
            // 广告 SDK 常把跳转地址藏在 data-* 属性，由 JS 读取后跳转，纳入触发源
            const dataTrigger = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
            const childLink = el.querySelector && el.querySelector('a[href]:not([href="#"]):not([href^="javascript:"]):not([href^="#"]):not([href=""])');
            // 排除 about:blank / 空 src 的 iframe，避免误判为跨域高风险
            const childIframe = el.querySelector && el.querySelector('iframe[src]:not([src="about:blank"]):not([src=""])');

            let triggerUrl = '';
            if (selfHref) triggerUrl = el.href;
            else if (dataTrigger) triggerUrl = dataTrigger;
            else if (childLink) triggerUrl = childLink.href;
            else if (childIframe) triggerUrl = childIframe.src;

            if (!selfHref && !hasOnClick && !dataTrigger && !childLink && !childIframe) return null;

            const record = {
                el,
                tagName: el.tagName,
                id: el.id || '',
                className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
                opacity,
                visibility: style.visibility,
                position: style.position,
                rect: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
                triggerUrl,
                hasOnClick,
                hasIframeChild: !!childIframe,
                highRisk: false
            };

            try {
                if (triggerUrl) {
                    const u = new URL(triggerUrl, location.href);
                    record.crossDomain = u.hostname !== selfHost;
                    record.highRisk = record.crossDomain && area > (minSize * minSize * 4);
                }
            } catch (e) { record.crossDomain = false; }

            if (autoBlock && (record.highRisk || (record.triggerUrl && record.crossDomain))) {
                el.style.setProperty('display', 'none', 'important');
                el.style.setProperty('pointer-events', 'none', 'important');
                el.style.setProperty('visibility', 'hidden', 'important');
                record.blocked = true;
                const key = record.tagName + '|' + record.id + '|' + record.className;
                if (!this._loggedOverlays.has(key)) {
                    this._loggedOverlays.add(key);
                    console.info(`[Pro Blocker] 拦截不可见覆盖层 ${record.tagName} ${record.rect.w}x${record.rect.h} -> ${triggerUrl || 'onclick'}`);
                }
            }
            return record;
        }

        // 异步覆盖层扫描：requestIdleCallback 时间分片，避免大型页面 5000+ 候选导致主线程卡顿
        // autoBlock=false 供 UI 面板使用；autoBlock=true 仍建议用同步版本确保即时拦截
        static scanInvisibleOverlaysAsync(options = {}) {
            return new Promise((resolve) => {
                const { autoBlock = false, root = document.documentElement, minSize = 50, _depth = 0 } = options;
                const results = [];
                if (!root || !document.body) return resolve(results);
                if (_depth > 5) return resolve(results);
                const selfHost = window.location.hostname;

                let candidates;
                try {
                    candidates = root.querySelectorAll(
                        'a, iframe, div, button, span, img, object, embed, ins, ' +
                        '[onclick], [ontouchstart], [onmousedown], ' +
                        '[data-href], [data-url], [data-link], ' +
                        'div[style*="position"], div[style*="z-index"]'
                    );
                } catch (e) { return resolve(results); }

                // 无 requestIdleCallback 时降级为同步（保证功能可用）
                if (typeof requestIdleCallback !== 'function') {
                    candidates.forEach(el => {
                        const record = this._checkOverlayCandidate(el, minSize, selfHost, autoBlock);
                        if (record) results.push(record);
                    });
                    // Shadow DOM 递归（同步）
                    this._scanShadowOverlays(candidates, autoBlock, minSize, _depth, results);
                    return resolve(results);
                }

                // 时间分片：每帧处理一批，timeRemaining 耗尽则让出到下一空闲帧
                let idx = 0;
                const processBatch = (deadline) => {
                    while (idx < candidates.length) {
                        const el = candidates[idx++];
                        const record = this._checkOverlayCandidate(el, minSize, selfHost, autoBlock);
                        if (record) results.push(record);
                        const hasTime = deadline.timeRemaining ? deadline.timeRemaining() > 2 : true;
                        if (!hasTime && !deadline.didTimeout) {
                            requestIdleCallback(processBatch, { timeout: 200 });
                            return;
                        }
                    }
                    // 候选处理完毕，递归扫描 Shadow DOM（通常候选少，同步处理）
                    this._scanShadowOverlays(candidates, autoBlock, minSize, _depth, results);
                    resolve(results);
                };
                requestIdleCallback(processBatch, { timeout: 200 });
            });
        }

        // Shadow DOM 递归扫描辅助：供同步/异步扫描共用
        static _scanShadowOverlays(candidates, autoBlock, minSize, _depth, results) {
            candidates.forEach(el => {
                if (el.shadowRoot && !UIManager.isProtectedElement(el)) {
                    const shadowResults = this.scanInvisibleOverlays({ autoBlock, root: el.shadowRoot, minSize, _depth: _depth + 1 });
                    for (let i = 0; i < shadowResults.length; i++) results.push(shadowResults[i]);
                }
            });
        }

        static applyCSSRules() {
            const data = storage.getData();
            const selectors = [];
            const hideCSS = '{ display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -2147483648 !important; height: 0 !important; width: 0 !important; position: absolute !important; }';

            // 跳过 _disabled=true 的规则（用户临时禁用，不参与拦截）
            data.static.forEach(r => !r._disabled && r.selector && selectors.push(r.selector));
            data.dynamic.forEach(r => {
                if (r._disabled || !r.className) return;
                const token = r.className.split(/\s+/).filter(Boolean)[0];
                if (token) selectors.push(`[class*="${escapeCSSAttr(token)}"]`);
            });
            data.attribute.forEach(r => !r._disabled && r.attrSelector && selectors.push(r.attrSelector));
            data.structural.forEach(r => !r._disabled && r.structSelector && selectors.push(r.structSelector));

            // 全局域名黑名单：覆盖所有可能携带资源 URL 的属性（含 srcset）
            // 同时生成 :has() 规则隐藏父级容器，避免横幅广告仅隐藏 iframe 后留下空白占位
            // 优化：批量合并选择器（BATCH=40），将 2N 条规则降为 ⌈2N/BATCH⌉×2 条，
            // 减少 Style Recalculation 开销 ~70%
            const CSS_BATCH = 40;
            const domainAttrSelectors = [];
            const domainHasSelectors = [];
            data.domainBlock.forEach(entry => {
                if (entry._disabled) return;
                const domain = entry.domain;
                if (!domain) return;
                const esc = escapeCSSAttr(domain);
                const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [poster*="${esc}"], [srcset*="${esc}"]`;
                domainAttrSelectors.push(sel);
                // 注意：:has(> a, b) 中 > 仅作用于 a，其余为后代选择器会过度隐藏。
                // 用 :is() 包裹整组，使 > 对每个选择器均生效，只隐藏"直接子节点命中"的父容器。
                domainHasSelectors.push(sel);
            });
            for (let i = 0; i < domainAttrSelectors.length; i += CSS_BATCH) {
                selectors.push(domainAttrSelectors.slice(i, i + CSS_BATCH).join(', '));
            }
            for (let i = 0; i < domainHasSelectors.length; i += CSS_BATCH) {
                selectors.push(`*:has(> :is(${domainHasSelectors.slice(i, i + CSS_BATCH).join(', ')}))`);
            }

            // 路径模式拦截：典型广告跳转路径，如 /000/flink/url.php
            // 同样追加 :has() 规则隐藏父级，覆盖横幅广告场景，同样批量合并
            const pathAttrSelectors = [];
            const pathHasSelectors = [];
            data.pathPattern.forEach(r => {
                if (r._disabled || !r.pattern) return;
                const esc = escapeCSSAttr(r.pattern);
                const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                pathAttrSelectors.push(sel);
                pathHasSelectors.push(sel);
            });
            for (let i = 0; i < pathAttrSelectors.length; i += CSS_BATCH) {
                selectors.push(pathAttrSelectors.slice(i, i + CSS_BATCH).join(', '));
            }
            for (let i = 0; i < pathHasSelectors.length; i += CSS_BATCH) {
                selectors.push(`*:has(> :is(${pathHasSelectors.slice(i, i + CSS_BATCH).join(', ')}))`);
            }

            // document-start 阶段 documentElement 可能尚未就绪，做安全检查避免抛错
            // 注：Constructable Stylesheets 不依赖 head，可更早注入；<style> 降级路径需 head/documentElement
            const sheet = this._getSheet();
            if (!sheet) return;

            // 无规则时清空旧样式表，避免残留拦截
            if (selectors.length === 0) {
                this._clearSheetRules(sheet);
                this._lastCSSFingerprint = '';
                return;
            }

            // 自身 UI 保护：所有选择器追加 :not() 排除 #pro-blocker-ui-host 及其子元素，
            // 确保任何用户规则都不会隐藏脚本自身的面板宿主（否则所有面板都会消失）
            const SELF_PROTECT = ':not(#pro-blocker-ui-host):not(#pro-blocker-ui-host *)';
            const protectedSelectors = selectors.map(s => {
                // 复合选择器（含逗号）拆分后逐个保护再合并
                return s.split(',').map(part => part.trim() + SELF_PROTECT).join(', ');
            });

            // 指纹比对：内容未变则跳过，避免无谓的 CSSOM 重建（Style Recalculation）
            const fingerprint = protectedSelectors.join('\n');
            if (fingerprint === this._lastCSSFingerprint) return;

            const cssText = protectedSelectors.map(s => `${s} ${hideCSS}`).join('\n');

            // Constructable Stylesheets 快路径：replaceSync 一次性 C++ 注入，
            // 不触发 HTML 解析器，且无法被 document.querySelector('style') 探查（防反屏蔽）
            if (this._useConstructable) {
                try {
                    sheet.replaceSync(cssText);
                    this._lastCSSFingerprint = fingerprint;
                    return;
                } catch (e) {
                    // 整体替换失败（某条选择器非法，如 :has 在旧引擎）：
                    // 清空后降级到逐条 insertRule 隔离，单条非法不影响其余
                    this._clearSheetRules(sheet);
                }
            } else {
                this._clearSheetRules(sheet);
            }

            // 逐条 insertRule：降级路径 + 构造样式表整体失败后的隔离路径
            // 单条选择器非法（如 :has 在旧浏览器）静默跳过，不影响其他规则注入
            for (const sel of protectedSelectors) {
                try {
                    sheet.insertRule(`${sel} ${hideCSS}`, sheet.cssRules.length);
                } catch (e) {
                    // 非标准伪类静默跳过
                }
            }
            this._lastCSSFingerprint = fingerprint;
        }

        // 清除某域名相关元素的内联隐藏样式（删除 domainBlock 规则后调用，解决问题2&5）
        // scanAndBlockDynamic 会给命中元素的单子链容器打 inline display:none；删除规则只重建 CSS 表，
        // inline 残留导致"删除规则后元素仍屏蔽"。此处清除该域名命中的资源元素及其父级的内联隐藏，
        // 随后由 force 重扫重新应用剩余规则。
        static restoreInlineForDomain(domain) {
            if (!domain) return;
            const esc = escapeCSSAttr(domain);
            const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [poster*="${esc}"], [srcset*="${esc}"]`;
            const clear = (node) => {
                if (!node) return;
                node.style.removeProperty('display');
                node.style.removeProperty('opacity');
                node.style.removeProperty('visibility');
                node.style.removeProperty('pointer-events');
            };
            document.querySelectorAll(sel).forEach(el => {
                clear(el);
                if (el.parentElement) clear(el.parentElement);
                // 单子链容器也可能被 scanAndBlockDynamic 隐藏，向上清一层兜底
                const wrapper = this.findSingleChildWrapper(el, 4);
                clear(wrapper);
            });
        }

        // 通用内联样式还原：删除任意类型规则后，清除所有由脚本设置的内联隐藏样式
        // 适用于 static/dynamic/attribute/structural/regex/complex 规则删除场景
        // 策略：清除所有带 display:none!important 的内联样式，然后重建 CSS 表 + 重扫
        static restoreAllInlineStyles() {
            const _clearStyle = (node) => {
                if (!node || !node.style) return;
                // 仅清除脚本设置的内联隐藏样式（display:none + opacity:0 + visibility:hidden + pointer-events:none）
                // 判定标准：任一属性为 important 且值为隐藏值，则视为脚本设置，一并清除四个属性
                // 保留页面自身设置的非 important 或非隐藏值的样式
                const isHidden = (
                    (node.style.getPropertyValue('display') === 'none' && node.style.getPropertyPriority('display') === 'important') ||
                    (node.style.getPropertyValue('visibility') === 'hidden' && node.style.getPropertyPriority('visibility') === 'important') ||
                    (node.style.getPropertyValue('opacity') === '0' && node.style.getPropertyPriority('opacity') === 'important') ||
                    (node.style.getPropertyValue('pointer-events') === 'none' && node.style.getPropertyPriority('pointer-events') === 'important')
                );
                if (isHidden) {
                    node.style.removeProperty('display');
                    node.style.removeProperty('opacity');
                    node.style.removeProperty('visibility');
                    node.style.removeProperty('pointer-events');
                }
            };
            // 遍历所有可能被隐藏的元素：带内联 display:none / visibility:hidden / opacity:0 / pointer-events:none 的元素
            document.querySelectorAll('[style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"], [style*="opacity: 0"], [style*="opacity:0"], [style*="pointer-events: none"], [style*="pointer-events:none"]').forEach(el => {
                _clearStyle(el);
            });
        }

        // 获取（惰性创建）当前生效的 CSSStyleSheet：
        // 优先 Constructable Stylesheets（C++ 对象，零解析、防探查），不支持时降级到 <style>.sheet
        static _getSheet() {
            if (this._styleSheet) return this._styleSheet;
            // 路径 A：Constructable Stylesheets
            if (this._supportsConstructable) {
                try {
                    const csSheet = new CSSStyleSheet();
                    document.adoptedStyleSheets = [...document.adoptedStyleSheets, csSheet];
                    this._styleSheet = csSheet;
                    this._useConstructable = true;
                    return csSheet;
                } catch (e) {
                    // adoptedStyleSheets 赋值失败（被覆盖/只读），降级
                }
            }
            // 路径 B：<style> + insertRule 降级
            const parent = document.head || document.documentElement;
            if (!parent) return null;
            let styleEl = document.getElementById(this.styleElementId);
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = this.styleElementId;
                if (parent.firstChild) parent.insertBefore(styleEl, parent.firstChild);
                else parent.appendChild(styleEl);
            }
            this._styleSheet = styleEl.sheet;
            this._useConstructable = false;
            return this._styleSheet;
        }

        // 清空任意 CSSStyleSheet（构造样式表 或 <style>.sheet）的所有规则
        static _clearSheetRules(sheet) {
            if (!sheet) return;
            // 快路径：Constructable Stylesheets 用 replaceSync('') 一次性清空，O(1) 调用
            if (this._useConstructable) {
                try { sheet.replaceSync(''); return; } catch (e) { }
            }
            // <style> 降级路径：直接清空 ownerNode.textContent（触发整表重建，O(1) 调用）
            // 替代原 deleteRule(0) 循环——每次删首条后剩余规则索引全重排，N 条规则 O(N²)
            const owner = sheet.ownerNode;
            if (owner) { owner.textContent = ''; return; }
            // 兜底：从尾部删除（deleteRule(length-1) 无需索引重排，O(1)/条 vs deleteRule(0) 的 O(N)/条）
            if (sheet.cssRules) {
                while (sheet.cssRules.length > 0) {
                    try { sheet.deleteRule(sheet.cssRules.length - 1); } catch (e) { break; }
                }
            }
        }

        /**
         * 动态拦截核心：扫描新增节点的资源域与路径模式，命中则隐藏整个广告容器
         * 解决"刷新就复活"——动态生成的广告无法靠固定CSS规则拦截
         */
        static scanAndBlockDynamic(node, cachedDomainList, cachedPathPatterns, options = {}) {
            // fallback 路径同样过滤 _disabled 规则，与 _getLists()/getDomainSet() 保持一致
            const domainList = cachedDomainList !== undefined ? cachedDomainList : (this._cachedDomainList !== null ? this._cachedDomainList : storage.getDomainBlocks().filter(r => !r._disabled).map(r => r.domain));
            const pathPatterns = cachedPathPatterns !== undefined ? cachedPathPatterns : (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern.filter(r => !r._disabled));
            if (this._cachedDomainList === null) this._cachedDomainList = domainList;
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = pathPatterns;
            // 域名集合与列表同生命周期：列表重建时集合一并重建，避免每次匹配都 new Set
            if (this._cachedDomainSet === null) this._cachedDomainSet = new Set(this._cachedDomainList);
            const domainSet = this._cachedDomainSet;
            if (domainList.length === 0 && pathPatterns.length === 0) return;
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
            // WeakSet 去重：已扫描节点跳过，避免全页重复扫描；属性变更时 options.force 强制重扫
            if (!options.force && this._scannedNodes.has(node)) return;
            this._scannedNodes.add(node);

            const elements = [node];
            try {
                node.querySelectorAll && node.querySelectorAll('img, iframe, video, script, a, source, embed, object').forEach(el => elements.push(el));
            } catch (e) { }

            const currentHost = window.location.hostname;

            const _t0 = performance.now();
            elements.forEach(el => {
                // 全局保护：脚本自身 UI 宿主及其子节点跳过，避免误伤面板
                if (UIManager.isProtectedElement(el)) return;
                let blocked = false;
                let matchedDomain = '';
                let matchedPattern = '';

                // 收集所有可能的资源 URL（含 srcset 多 URL 拆分）
                // data-href/data-url/data-lazy-src 等是广告 SDK 常见懒加载属性
                const urls = [
                    el.src,
                    el.href,
                    el.getAttribute && el.getAttribute('data-src'),
                    el.getAttribute && el.getAttribute('data-original'),
                    el.getAttribute && el.getAttribute('data-href'),
                    el.getAttribute && el.getAttribute('data-url'),
                    el.getAttribute && el.getAttribute('data-link'),
                    el.getAttribute && el.getAttribute('data-lazy-src'),
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
                        // 合并正则 O(L) 一次匹配替代 O(n) 线性遍历 pathPatterns
                        const pathMatcher = this.getPathMatcher();
                        if (pathMatcher) {
                            const m = pathMatcher.exec(url);
                            if (m) {
                                blocked = true;
                                matchedPattern = m[0];
                            }
                        }
                        if (blocked) break;

                        let absUrl = url;
                        if (url.startsWith('//')) absUrl = location.protocol + url;
                        if (absUrl.startsWith('http')) {
                            const urlObj = new URL(absUrl);
                            // 仅排除与当前页完全同域的资源；子域不豁免（与 isUrlBlocked 保持一致）
                            if (urlObj.hostname && urlObj.hostname !== currentHost) {
                                // Set O(1) 精确匹配 + O(depth) 父域上探，替代 O(n) 线性扫描
                                if (this.hostnameBlocked(urlObj.hostname, domainSet)) {
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
                    // 闪现检测必须在隐藏之前：display:none 会使 getBoundingClientRect 返回 0×0
                    // 元素已渲染出非零尺寸才说明它"闪现"过 → 标记域名，下次进入自动启用 preemptive
                    this.detectFlashAndMark(el, matchedDomain ? `https://${matchedDomain}/` : '');
                    this.stats.domBlocks++;
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
            // 累计匹配引擎耗时，供管理面板看板展示 Long Task 风险
            this.stats.matchTimeMs += performance.now() - _t0;
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

            // 静态预检过滤不安全正则（ReDoS 防护）：嵌套量词/重叠分支在入口处拒绝执行
            // 同时跳过 _disabled=true 的规则，不参与文本匹配
            const rules = data.regex
                .filter(r => r.regex && !r._disabled && this.isRegexSafe(r.regex))
                .map(r => ({ regex: this.getCompiledRegex(r.regex), level: r.level }))
                .filter(r => r.regex);
            if (rules.length === 0) return;

            // 合并正则：每条规则用捕获组包裹，exec 一次即可定位命中的规则索引
            // 将每节点 RegExp 调用从 N 次降为 1 次，TreeWalker 遍历次数不变
            // 分批合并：V8 对单条正则捕获组数量有隐性上限（~500），规则数 >50 时分批
            // 每批 50 条，避免 RegExp too complex 编译失败导致所有正则规则静默失效
            const REGEX_BATCH_SIZE = 50;
            const mergedBatches = [];
            for (let i = 0; i < rules.length; i += REGEX_BATCH_SIZE) {
                const batch = rules.slice(i, i + REGEX_BATCH_SIZE);
                try {
                    const source = batch.map(r => `(${r.regex.source})`).join('|');
                    mergedBatches.push({ regex: new RegExp(source, 'i'), offset: i, rules: batch });
                } catch (e) {
                    // 该批合并失败，降级为逐条执行（保留原 rule 对象供降级路径使用）
                    mergedBatches.push({ regex: null, offset: i, rules: batch });
                }
            }

            // 文本节点过滤器：跳过脚本/样式内的文本，避免误隐藏 <script> 父级导致页面功能损坏
            const textFilter = {
                acceptNode(node) {
                    const tag = node.parentElement && node.parentElement.tagName;
                    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            };

            // requestIdleCallback 不可用（如旧版 Safari）时回退到同步遍历，保证功能可用
            if (typeof requestIdleCallback !== 'function') {
                return this._applyRegexRulesSync(targetNode, mergedBatches, textFilter);
            }

            // 时间分片：在浏览器空闲帧执行正则比对，避免 Long Task 阻塞主线程导致卡顿
            try {
                const walker = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT, textFilter, false);
                const processChunk = (deadline) => {
                    let node;
                    while ((node = walker.nextNode())) {
                        // 先处理当前节点再判时：避免 timeRemaining 耗尽时 break 跳过该节点
                        // （walker.nextNode 已推进内部指针，break 后该节点永久漏匹配）
                        this._executeRegexMatch(node, mergedBatches);
                        const hasTime = deadline.timeRemaining ? deadline.timeRemaining() > 1 : true;
                        if (!hasTime && !deadline.didTimeout) {
                            // 当前节点已处理，下次空闲帧从下一个节点继续
                            requestIdleCallback(processChunk, { timeout: 1000 });
                            return;
                        }
                    }
                };
                requestIdleCallback(processChunk, { timeout: 1000 });
            } catch (e) {
                console.error('[Pro Blocker] 正则遍历异常:', e);
            }
        }

        // 对单个文本节点执行正则匹配，命中则按 level 向上隐藏父级
        // 分批合并快速路径：每批一次 exec 定位命中规则；降级路径：逐条 test
        static _executeRegexMatch(node, mergedBatches) {
            const text = node.textContent || '';
            if (!text) return;
            const truncated = text.length > 2000 ? text.slice(0, 2000) : text;

            for (const batch of mergedBatches) {
                if (batch.regex) {
                    // 合并正则快速路径：一次 exec 替代 N 次 test
                    const match = batch.regex.exec(truncated);
                    if (match) {
                        // match[1..N] 为各捕获组，找到第一个非 undefined 的组即命中的规则
                        let level = 0;
                        for (let i = 1; i <= batch.rules.length; i++) {
                            if (match[i] !== undefined) { level = batch.rules[i - 1].level; break; }
                        }
                        this._hideRegexAncestor(node, level);
                        return; // 命中即返回，避免重复隐藏
                    }
                } else {
                    // 降级路径：该批合并失败时逐条测试
                    for (const rule of batch.rules) {
                        if (rule.regex.test(truncated)) {
                            this._hideRegexAncestor(node, rule.level);
                            return;
                        }
                    }
                }
            }
        }

        // 按 level 向上隐藏文本节点的祖先元素
        static _hideRegexAncestor(node, level) {
            let element = node.parentElement;
            if (!element) return;
            // 全局保护：避免正则规则隐藏到脚本自身 UI 宿主
            if (UIManager.isProtectedElement(element)) return;
            for (let i = 0; i < level; i++) {
                if (element.parentElement && element.parentElement !== document.body) {
                    element = element.parentElement;
                    // 上溯过程中再次校验，避免选中受保护祖先
                    if (UIManager.isProtectedElement(element)) return;
                } else break;
            }
            if (element && element.style.display !== 'none') {
                this.stats.domBlocks++;
                element.style.setProperty('display', 'none', 'important');
            }
        }

        // 同步兜底：无 requestIdleCallback 的环境使用同步 TreeWalker 遍历
        static _applyRegexRulesSync(targetNode, mergedBatches, textFilter) {
            try {
                const walker = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT, textFilter, false);
                let node;
                while ((node = walker.nextNode())) {
                    this._executeRegexMatch(node, mergedBatches);
                }
            } catch (e) {
                console.error('[Pro Blocker] 正则遍历异常:', e);
            }
        }

        static applyComplexRules(targetNode = document.body) {
            const data = storage.getData();
            if (!data.complex || data.complex.length === 0 || !targetNode) return;

            // ShadowRoot(DOCUMENT_FRAGMENT_NODE) 与 Element 均可直接 querySelectorAll；
            // 其它节点类型（如文本节点）回退到 parentElement
            const root = (targetNode.nodeType === Node.ELEMENT_NODE || targetNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
                ? targetNode : targetNode.parentElement;
            if (!root) return;

            data.complex.forEach(rule => {
                if (rule._disabled) return;
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
                        // 全局保护：脚本自身 UI 宿主跳过，避免积木规则误伤面板
                        if (UIManager.isProtectedElement(el)) return;
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

        // Shadow DOM 穿透：代理 attachShadow，将隐藏在 Shadow DOM 内的贴片广告纳入扫描
        static _shadowRoots = new WeakSet();
        // 每个 shadow root 独立的去抖定时器，避免高频注入下重复全量扫描
        static _shadowApplyTimers = new WeakMap();

        static hookAttachShadow() {
            const orig = Element.prototype.attachShadow;
            if (!orig || orig.__proBlockerHooked) return;
            const hooked = function (init) {
                const root = orig.call(this, init);
                try { BlockEngine._observeShadowRoot(root); } catch (e) { }
                return root;
            };
            hooked.__proBlockerHooked = true;
            Element.prototype.attachShadow = hooked;
        }

        static _observeShadowRoot(root) {
            if (!root || this._shadowRoots.has(root)) return;
            this._shadowRoots.add(root);
            // 立即扫描已有内容：ShadowRoot 非 ELEMENT_NODE，需遍历其子元素逐个扫描
            // 否则 scanAndBlockDynamic 第 741 行 nodeType 守卫会直接 return，初始扫描成空操作
            const { domainList, pathPatterns } = this._getLists();
            if (domainList.length > 0 || pathPatterns.length > 0) {
                Array.from(root.children).forEach(child => this.scanAndBlockDynamic(child, domainList, pathPatterns, { force: true }));
            }
            this.applyRegexRules(root);
            this.applyComplexRules(root);
            // 观察后续动态注入的节点与属性变更
            const obs = new MutationObserver((mutations) => {
                const batchNodes = [];
                for (const m of mutations) {
                    if (m.type === 'childList') {
                        m.addedNodes.forEach(node => {
                            if (node.nodeType === Node.ELEMENT_NODE) batchNodes.push(node);
                        });
                    } else if (m.type === 'attributes' && m.target && m.target.nodeType === Node.ELEMENT_NODE) {
                        batchNodes.push(m.target);
                    }
                }
                if (batchNodes.length > 0) {
                    // 重新获取列表：invalidateCache 会将缓存置 null，闭包捕获的旧数组引用不会更新，
                    // shadow 内动态节点会因过期规则漏拦截
                    const cur = this._getLists();
                    if (cur.domainList.length > 0 || cur.pathPatterns.length > 0) {
                        batchNodes.forEach(node => this.scanAndBlockDynamic(node, cur.domainList, cur.pathPatterns, { force: true }));
                    }
                    // 去抖执行正则/积木规则：shadow 边界外的主观察器无法覆盖 shadow 内动态内容
                    // 不补充此调用则这些规则类型对 shadow 内动态广告完全失效
                    this._scheduleShadowApply(root);
                }
            });
            obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-src', 'data-original', 'data-href', 'data-url', 'data-link', 'data-lazy-src', 'data-srcset', 'poster', 'srcset'] });
        }

        // 去抖对 shadow root 应用正则/积木规则 + 覆盖层扫描，避免高频 mutation 重复全量扫描
        static _scheduleShadowApply(root) {
            const existing = this._shadowApplyTimers.get(root);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
                this._shadowApplyTimers.delete(root);
                this.applyRegexRules(root);
                this.applyComplexRules(root);
                // shadow 内动态注入的透明跳转层同样需拦截，与主观察器行为一致
                this.scanInvisibleOverlays({ autoBlock: true, root: root });
            }, 150);
            this._shadowApplyTimers.set(root, timer);
        }

        // 缓存获取域名/路径列表（供 shadow observer 等复用）
        static _getLists() {
            // 过滤 _disabled=true 的规则：domainBlock 仅取 domain 字段，pathPattern 保留对象
            if (this._cachedDomainList === null) this._cachedDomainList = storage.getDomainBlocks().filter(r => !r._disabled).map(r => r.domain);
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = storage.getData().pathPattern.filter(r => !r._disabled);
            return { domainList: this._cachedDomainList, pathPatterns: this._cachedPathPatterns };
        }

        static startObserver() {
            // 监听这些资源属性的变化，捕获懒加载广告（src 在元素插入后才被 JS 设置）
            // data-href/data-url/data-lazy-src 等是常见广告 SDK 的懒加载属性，需一并监听
            const RESOURCE_ATTRS = ['src', 'href', 'data-src', 'data-original', 'data-href', 'data-url', 'data-link', 'data-lazy', 'data-lazy-src', 'data-srcset', 'poster', 'srcset'];

            // 正则/积木规则较重，去抖执行；缩短到 120ms/600ms 让广告闪现时间最短
            const debouncedDynamicApply = debounce(() => {
                const rawNodes = this._addedNodesBuffer;
                this._addedNodesBuffer = [];
                if (rawNodes.length === 0) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                    // 不可见覆盖层扫描：动态注入的透明 overlay 也需在去抖窗口内拦截
                    this.scanInvisibleOverlays({ autoBlock: true });
                    return;
                }
                // 过滤游离节点 + 去除嵌套（子节点会被父节点的子树扫描覆盖）
                const nodes = rawNodes.filter(n =>
                    document.contains(n) && !rawNodes.some(other => other !== n && other.contains(n))
                );
                if (nodes.length === 0) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                    this.scanInvisibleOverlays({ autoBlock: true });
                } else {
                    nodes.forEach(node => {
                        this.applyRegexRules(node);
                        this.applyComplexRules(node);
                        // 对新增子树单独扫描，避免每次都全页扫描
                        this.scanInvisibleOverlays({ autoBlock: true, root: node });
                    });
                }
            }, 120, 600);

            // 批量获取缓存的域名/路径列表，避免每个 mutation 重复读取存储
            // 复用 _getLists()：统一过滤 _disabled 规则，避免双份缓存不一致

            // 视口驱动扫描：节点进入视口时强制重扫，捕获插入后才懒加载的广告资源
            // 替代纯时间轮询：只在需要时（进入视口）扫描，降低主线程无谓唤醒
            let _viewportObserver = null;
            const initViewportObserver = () => {
                if (_viewportObserver || typeof IntersectionObserver !== 'function') return;
                _viewportObserver = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (entry.isIntersecting) {
                            // force=true：节点可能在初次扫描后才有 src 被设置，需绕过去重重扫
                            this.scanAndBlockDynamic(entry.target, undefined, undefined, { force: true });
                            _viewportObserver.unobserve(entry.target);
                        }
                    }
                }, { rootMargin: '200px' }); // 提前 200px 预扫描，用户滚动前即拦截
            };

            // —— 拆分观察器：childList 与 attributes 分离，避免相互阻塞（SPA 性能优化）——
            // 节点变更观察器：新增节点立即扫描域名/路径，正则/积木规则去抖执行
            const childListObserver = new MutationObserver((mutations) => {
                let hasAddedNodes = false;
                const batchNodes = [];
                for (const mutation of mutations) {
                    if (mutation.type === 'childList') {
                        if (mutation.addedNodes.length > 0) {
                            hasAddedNodes = true;
                            mutation.addedNodes.forEach(node => {
                                if (node.nodeType === Node.ELEMENT_NODE) {
                                    batchNodes.push(node);
                                    this._addedNodesBuffer.push(node);
                                    // 注册到视口观察器：节点滚入视口时强制重扫，捕获懒加载资源
                                    if (_viewportObserver) _viewportObserver.observe(node);
                                }
                            });
                        }
                        // 节点移除时从视口观察器释放：IntersectionObserver 持有目标强引用，
                        // 不主动 unobserve 会导致 SPA 虚拟列表/无限滚动场景内存持续增长
                        if (mutation.removedNodes.length > 0 && _viewportObserver) {
                            mutation.removedNodes.forEach(node => {
                                if (node.nodeType === Node.ELEMENT_NODE) _viewportObserver.unobserve(node);
                            });
                        }
                    }
                }
                if (hasAddedNodes) {
                    const { domainList, pathPatterns } = this._getLists();
                    // 新增节点立即扫描域名/路径（不等去抖，避免广告闪现）
                    if (domainList.length > 0 || pathPatterns.length > 0) {
                        batchNodes.forEach(node => this.scanAndBlockDynamic(node, domainList, pathPatterns));
                    }
                    // 正则/积木规则去抖执行（较重，避免每次 mutation 都跑）
                    debouncedDynamicApply();
                }
            });

            // 属性变更观察器：懒加载广告在元素插入后才设置 src/data-src，需捕获此变化
            // 用微任务合并同一轮多次属性变更，仅扫描最终状态，减少重复扫描
            let _attrBatch = new Set();
            let _attrScheduled = false;
            const _scheduleAttrScan = () => {
                _attrScheduled = false;
                const nodes = _attrBatch;
                _attrBatch = new Set();
                if (nodes.size === 0) return;
                const { domainList, pathPatterns } = this._getLists();
                if (domainList.length > 0 || pathPatterns.length > 0) {
                    // force=true：属性变更（如 src 被设置）需绕过 WeakSet 去重强制重扫
                    nodes.forEach(node => this.scanAndBlockDynamic(node, domainList, pathPatterns, { force: true }));
                }
            };
            const attrObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
                        _attrBatch.add(mutation.target);
                    }
                }
                if (_attrBatch.size > 0 && !_attrScheduled) {
                    _attrScheduled = true;
                    // 优先用 queueMicrotask（渲染前执行，广告闪现时间最短）；不可用时回退 setTimeout
                    if (typeof queueMicrotask === 'function') {
                        queueMicrotask(_scheduleAttrScan);
                    } else {
                        setTimeout(_scheduleAttrScan, 0);
                    }
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

            // 视口观察器在 body 就绪后初始化（IntersectionObserver 需要可计算的根节点）
            initViewportObserver();

            // 立即在 documentElement 上启动两个观察器（不等 body，覆盖 head 阶段注入的早期广告）
            // 这是解决"首次进入广告未过滤、需刷新"的关键：原来等 body 才观察，会漏掉 body 之前注入的节点
            childListObserver.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
            attrObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: RESOURCE_ATTRS,
                subtree: true
            });

            // body 就绪后立即做全量扫描（不等 DOMContentLoaded，消除监控盲区）
            const doInitialScan = () => {
                this.applyCSSRules();
                if (document.body) {
                    this.applyRegexRules();
                    this.applyComplexRules();
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    // 不可见覆盖层在 body 就绪后立即扫描，防止首次进入就被透明 overlay 截获点击
                    this.scanInvisibleOverlays({ autoBlock: true });
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
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    this.scanInvisibleOverlays({ autoBlock: true });
                }
            });

            // 页面完全加载后再做一次兜底扫描
            window.addEventListener('load', () => {
                this.applyCSSRules();
                this.applyRegexRules();
                this.applyComplexRules();
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    this.scanInvisibleOverlays({ autoBlock: true });
                }
                // 自愈检查：本次加载（含 preemptive 各时序扫描）未检测到闪现 → 记录一次干净加载
                // 连续 3 次干净加载后 flashList 自动清除，preemptive 强制启用随之解除
                if (!this._flashDetectedThisLoad) {
                    storage.recordCleanLoad();
                }
            });

            // SPA 路由变化时重新应用规则（解决点击链接不刷新导致广告漏网）
            let _lastUrl = location.href;
            const reapplyOnNavigation = () => {
                if (location.href === _lastUrl) return;
                _lastUrl = location.href;
                this.applyCSSRules();
                this.applyRegexRules();
                this.applyComplexRules();
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    this.scanInvisibleOverlays({ autoBlock: true });
                }
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
         * MurmurHash3 (x86 32-bit) —— 位操作优化的非加密哈希。
         * 用于规则 ID 生成：将规则内容压缩为定长 hex，便于去重与导出引用。
         * 仅用 Math.imul（32-bit 整数乘法）与位运算，无浮点开销。
         */
        static murmur32(str) {
            let k, h = 0x811c9dc5;
            for (let i = 0, len = str.length; i < len; i++) {
                k = str.charCodeAt(i);
                k = Math.imul(k, 0xcc9e2d51);
                k = (k << 15) | (k >>> 17);
                k = Math.imul(k, 0x1b873593);
                h ^= k;
                h = (h << 13) | (h >>> 19);
                h = Math.imul(h, 5) + 0xe6546b64;
            }
            h ^= str.length;
            h ^= h >>> 16;
            h = Math.imul(h, 0x85ebca6b);
            h ^= h >>> 13;
            h = Math.imul(h, 0xc2b2ae35);
            h ^= h >>> 16;
            return (h >>> 0).toString(16);
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
                            // 允许子域：首尾须为字母数字，中间可含 ./-，覆盖 "ads.example.com" 这类多级广告域
                            // 原正则 [a-z0-9-]+ 不含点号，无法匹配子域，遗漏了大量广告配置中的域名引用
                            const domainMatches = text.match(/["']([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.(?:com|cn|net|org|io|cc|tv|xyz|top|club|info|site|vip|icu|asia|app|dev|co|me|mobi|us|biz|ru|jp|tw|hk|uk|de|fr|br|au))["']/gi);
                            if (domainMatches) domainMatches.forEach(d => addUrl('https://' + d.replace(/["']/g, ''), 'script-var'));
                        }
                    });
                } catch (e) { }

                // 内联事件属性中的 URL 采集（onclick/ontouchstart/onmousedown + data-href/data-url/data-link）
                try {
                    const inlineEls = document.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                    inlineEls.forEach(el => {
                        ['onclick', 'ontouchstart', 'onmousedown', 'data-href', 'data-url', 'data-link'].forEach(attr => {
                            const val = el.getAttribute(attr);
                            if (val) scanString(val, 'inline-event');
                        });
                    });
                } catch (e) { }
            }

            domainMeta.forEach((meta, host) => {
                let score = 0;
                // 评分矩阵：keyword 40 / script 25 / data-attr 15 / style 10 / srcset+attr 10 / 频次上限 20(λ=2) / 安全CDN -50
                if (isAdKeywordHost(host)) score += 40;
                if (meta.sources.has('script-text') || meta.sources.has('script-var')) score += 25;
                if (meta.sources.has('inline-style') || meta.sources.has('stylesheet')) score += 10;
                if (meta.sources.has('srcset') || meta.sources.has('attr')) score += 10;
                if (meta.sources.has('data-attr')) score += 15;
                score += Math.min(meta.count * 2, 20);
                if (KNOWN_SAFE_CDNS.has(host)) score -= 50;
                if (host === window.location.hostname || host.endsWith('.' + window.location.hostname)) score -= 1000;
                // 上界 100：避免线性累加导致"分数无上限"，与 LR 引擎的 0-100 概率刻度对齐
                meta.score = Math.min(100, Math.max(0, score));
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
     * 网络层拦截器：在 document-start 阶段劫持 fetch / XHR / script.src，
     * 命中全局域名黑名单或路径模式时直接丢弃请求，从源头阻止广告资源加载（而非等 DOM 渲染后再隐藏）。
     * 判定逻辑复用 BlockEngine.isUrlBlocked，与 DOM 层拦截规则完全一致，避免双标。
     */
    class NetworkInterceptor {

        static init() {
            this.hookFetch();
            this.hookXHR();
            this.hookScriptSrc();
        }

        static isUrlBlocked(url) {
            // 显式规则拦截：域名黑名单 + 路径模式（与 DOM 层规则一致）
            return BlockEngine.isUrlBlocked(url);
        }

        static hookFetch() {
            if (!window.fetch || window.fetch.__proBlockerHooked) return;
            const origFetch = window.fetch;
            const hooked = function (input, init) {
                let url = '';
                if (typeof input === 'string') url = input;
                else if (input && typeof input.url === 'string') url = input.url;
                if (NetworkInterceptor.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    // 返回空 200 响应，避免页面 fetch().then 抛错影响正常逻辑
                    return Promise.resolve(new Response('', { status: 200, statusText: 'blocked by Pro Blocker' }));
                }
                return origFetch.apply(this, arguments);
            };
            hooked.__proBlockerHooked = true;
            window.fetch = hooked;
        }

        static hookXHR() {
            if (!window.XMLHttpRequest || XMLHttpRequest.prototype.open.__proBlockerHooked) return;
            const origOpen = XMLHttpRequest.prototype.open;
            const hooked = function (method, url) {
                if (NetworkInterceptor.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    // 改写为 about:blank（同源空响应），XHR 正常完成但无广告数据
                    arguments[1] = 'about:blank';
                }
                return origOpen.apply(this, arguments);
            };
            hooked.__proBlockerHooked = true;
            XMLHttpRequest.prototype.open = hooked;
        }

        // 拦截动态 <script src="...">：仅拦截黑名单 URL，合法脚本不受影响
        static hookScriptSrc() {
            const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (!desc || !desc.set || desc.set.__proBlockerHooked) return;
            const origSet = desc.set;
            const hooked = function (url) {
                if (NetworkInterceptor.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    return; // 静默丢弃：不设置 src，广告脚本永不加载
                }
                return origSet.call(this, url);
            };
            hooked.__proBlockerHooked = true;
            try {
                Object.defineProperty(HTMLScriptElement.prototype, 'src', {
                    get: desc.get,
                    set: hooked,
                    configurable: true,
                    enumerable: desc.enumerable
                });
            } catch (e) {
                // 某些环境 src 描述符不可重定义，静默跳过（DOM 层仍会拦截）
            }
        }
    }


    /**
     * ═══════════════════════════════════════════════════════════════
     *  算法一：GlobalDomainScanner — 全量域名深度检索
     *
     *  核心原则：
     *    · 全：6通道采集，不遗漏任何网络资源
     *    · 准：12维特征 + 交叉验证 + 共振加成
     *    · 快：单次扫描 < 8ms（万级节点页面）
     *    · 博彩/色情：专项词库 + 图片行为分析
     * ═══════════════════════════════════════════════════════════════
     */
    const GlobalDomainScanner = (() => {

        // ─── 配置 ───
        const MAX_URLS_PER_HOST = 5;

        const MULTI_TLDS = new Set([
            'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
            'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au',
            'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'or.kr',
            'com.br', 'com.tw', 'com.hk', 'co.in', 'co.za',
            'com.sg', 'com.my', 'com.ph', 'co.th', 'co.id'
        ]);

        // ─── 广告词元库 ───
        const AD_TOKENS = new Set([
            'ad', 'ads', 'adx', 'adnxs', 'advert', 'adsystem', 'adserver', 'adserving',
            'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics',
            'amazon-adsystem', 'taboola', 'outbrain', 'mgid', 'criteo', 'media6degrees',
            'popads', 'propellerads', 'revcontent', 'adcolony', 'unityads', 'ironsrc',
            'analytics', 'tracking', 'tracker', 'beacon', 'pixel', 'logger', 'telemetry',
            'metrics', 'collect', 'umeng', 'sentry', 'hotjar', 'mixpanel', 'segment',
            'cnzz', 'baidu', 'tongji', 'stat', 'count', 'report'
        ]);

        // ─── 博彩/色情/恶意跳转词元库 ───
        const VICE_TOKENS = new Set([
            'casino', 'bet', 'betting', 'poker', 'slot', 'lottery', 'jackpot',
            'wager', 'gambling', 'lucky', 'spin', 'baccarat', 'roulette', 'blackjack',
            'sportsbook', 'bookmaker', 'odds', 'handicap', 'parlay',
            'bocai', 'caipiao', 'yazhou', 'ag', 'bbin', 'mg', 'pt', 'sb', 'ibc',
            'sbo', 'cmd368', 'maxbet', 'sunbet', 'tombola', 'lottomatica',
            'adult', 'xxx', 'porn', 'sex', 'nude', 'erotic', 'hentai', 'nsfw',
            'live', 'cam', 'dating', 'hookup', 'escort', 'onlyfans', 'xvideos',
            'pornhub', 'xhamster', 'redtube', 'youporn', 'brazzers',
            'redirect', 'click', 'track', 'go', 'jump', 'link', 'short', 'tiny',
            'bitly', 'turl', 'sclick', 'goo', 'owly', 'rebrandly', 'cuttly',
            'popup', 'popunder', 'overlay', 'push', 'notification', 'interstitial',
            'splash', 'takeover', 'skyscraper', 'leaderboard', 'native-ad'
        ]);

        // ─── 资源类型映射 ───
        const TYPE_MAP = {
            'script': 'script', 'link': 'css', 'css': 'css',
            'img': 'image', 'image': 'image', 'picture': 'image',
            'xmlhttprequest': 'xhr', 'fetch': 'xhr', 'beacon': 'beacon',
            'iframe': 'iframe', 'subdocument': 'iframe', 'frame': 'iframe',
            'video': 'media', 'audio': 'media',
            'websocket': 'ws', 'embed': 'plugin', 'object': 'plugin', 'other': 'other'
        };

        // ─── 主域名提取（与 BlockEngine 主域逻辑一致，独立维护避免耦合）───
        function mainDomain(host) {
            const p = host.toLowerCase().split('.');
            if (p.length <= 2) return host;
            const last2 = p.slice(-2).join('.');
            if (MULTI_TLDS.has(last2)) return p.slice(-3).join('.');
            return last2;
        }

        function isSameSite(host, main) {
            return host === main || host.endsWith('.' + main);
        }

        // ════════════════════════════════════════
        //  阶段1：全通道采集（6通道）
        // ════════════════════════════════════════
        function collect() {
            const map = new Map();
            const curHost = location.hostname.toLowerCase();
            const main = mainDomain(curHost);

            function _addEntry(hostname, url, type, bytes) {
                if (!hostname || hostname === curHost) return;
                let info = map.get(hostname);
                if (!info) {
                    info = { hostname, urls: [], types: new Set(), bytes: 0, count: 0, t0: 0, t1: 0, hasRedirect: false };
                    map.set(hostname, info);
                }
                if (info.urls.length < MAX_URLS_PER_HOST) info.urls.push(url);
                info.types.add(type);
                info.bytes += (bytes || 0);
                info.count++;
            }

            // 通道A：Performance API（所有已加载资源）
            try {
                for (const e of performance.getEntriesByType('resource')) {
                    try {
                        const u = new URL(e.name);
                        const h = u.hostname.toLowerCase();
                        const type = TYPE_MAP[e.initiatorType] || 'other';
                        _addEntry(h, e.name, type, e.transferSize || e.encodedBodySize || 0);
                        const info = map.get(h);
                        if (info) {
                            const t = e.startTime || 0;
                            if (!info.t0 || t < info.t0) info.t0 = t;
                            if (t > info.t1) info.t1 = t;
                            if (e.redirectStart && e.redirectEnd && e.redirectEnd > e.redirectStart) {
                                info.hasRedirect = true;
                            }
                        }
                    } catch (ex) { }
                }
            } catch (ex) { }

            // 通道B：DOM 资源元素（懒加载/srcset/poster）
            try {
                const SEL = [
                    'img[src]', 'img[data-src]', 'img[data-lazy-src]', 'img[srcset]',
                    'source[src]', 'source[srcset]', 'source[data-src]',
                    'script[src]', 'script[data-src]',
                    'link[href][rel="stylesheet"]',
                    'iframe[src]', 'iframe[data-src]',
                    'video[src]', 'video[poster]', 'audio[src]',
                    'embed[src]', 'object[data]',
                    'a[href*="."][target="_blank"] img'
                ].join(',');
                for (const el of document.querySelectorAll(SEL)) {
                    const cands = [el.src, el.href, el.dataset && el.dataset.src, el.dataset && el.dataset.lazySrc, el.poster, el.data].filter(Boolean);
                    const ss = el.srcset || (el.getAttribute && el.getAttribute('srcset')) || (el.dataset && el.dataset.srcset);
                    if (ss) {
                        for (const p of ss.split(',')) {
                            const u = p.trim().split(/\s+/)[0];
                            if (u) cands.push(u);
                        }
                    }
                    for (const raw of cands) {
                        if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) continue;
                        try {
                            const abs = new URL(raw, location.href);
                            const h = abs.hostname.toLowerCase();
                            const type = TYPE_MAP[el.tagName.toLowerCase()] || 'other';
                            _addEntry(h, raw, type, 0);
                        } catch (ex) { }
                    }
                }
            } catch (ex) { }

            // 通道C：iframe 递归（同源 iframe 内部资源）
            try {
                const iframes = document.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    try {
                        const src = iframe.src;
                        if (src && !src.startsWith('data:') && !src.startsWith('about:')) {
                            const h = new URL(src, location.href).hostname.toLowerCase();
                            _addEntry(h, src, 'iframe', 0);
                        }
                        if (iframe.contentDocument) {
                            const innerImgs = iframe.contentDocument.querySelectorAll('img[src]');
                            for (const img of innerImgs) {
                                try {
                                    const h2 = new URL(img.src).hostname.toLowerCase();
                                    _addEntry(h2, img.src, 'image', 0);
                                } catch (e2) { }
                            }
                        }
                    } catch (ex) { }
                }
            } catch (ex) { }

            // 通道D：CSS 中的外部资源（@import / url()）
            try {
                for (const sheet of document.styleSheets) {
                    try {
                        if (sheet.href) {
                            const h = new URL(sheet.href).hostname.toLowerCase();
                            _addEntry(h, sheet.href, 'css', 0);
                        }
                        for (const rule of (sheet.cssRules || [])) {
                            if (rule.style && rule.style.backgroundImage && rule.style.backgroundImage.includes('url(')) {
                                const m = rule.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
                                if (m && m[1] && !m[1].startsWith('data:')) {
                                    try {
                                        const h = new URL(m[1], sheet.href || location.href).hostname.toLowerCase();
                                        _addEntry(h, m[1], 'image', 0);
                                    } catch (e3) { }
                                }
                            }
                        }
                    } catch (ex) { }
                }
            } catch (ex) { }

            // 通道E：页面中所有链接的跳转目标（博彩/色情跳转检测）
            try {
                const links = document.querySelectorAll('a[href]');
                for (const a of links) {
                    const href = a.href;
                    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
                    try {
                        const h = new URL(href).hostname.toLowerCase();
                        if (h !== curHost && !isSameSite(h, main)) {
                            const hasImg = a.querySelector('img') !== null;
                            const type = hasImg ? 'image-link' : 'link';
                            _addEntry(h, href, type, 0);
                            const info = map.get(h);
                            if (info) info.hasRedirect = true;
                        }
                    } catch (ex) { }
                }
            } catch (ex) { }

            // 通道F：内联事件属性中的跳转 URL（onclick/ontouchstart/onmousedown 中的 window.open/location）
            try {
                const inlineEls = document.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                for (const el of inlineEls) {
                    const attrs = ['onclick', 'ontouchstart', 'onmousedown', 'data-href', 'data-url', 'data-link'];
                    for (const attr of attrs) {
                        const val = el.getAttribute(attr);
                        if (!val) continue;
                        // 提取所有 http(s):// URL
                        const urls = val.match(/https?:\/\/[^\s"'<>(){}']+/gi);
                        if (urls) {
                            for (const u of urls) {
                                try {
                                    const h = new URL(u).hostname.toLowerCase();
                                    if (h !== curHost && !isSameSite(h, main)) {
                                        _addEntry(h, u, 'inline-event', 0);
                                        const info = map.get(h);
                                        if (info) info.hasRedirect = true;
                                    }
                                } catch (ex) { }
                            }
                        }
                    }
                }
            } catch (ex) { }

            // 标记第三方
            for (const [, info] of map) {
                info.thirdParty = !isSameSite(info.hostname, main);
            }

            return map;
        }

        // ════════════════════════════════════════
        //  阶段2：12维特征提取
        // ════════════════════════════════════════
        function extractFeatures(info) {
            const h = info.hostname;
            const tokens = h.split(/[^a-z0-9-]/).filter(Boolean);
            const f = { hostname: h };

            // ① 广告词元
            f.adToken = null;
            for (const t of tokens) { if (AD_TOKENS.has(t)) { f.adToken = t; break; } }

            // ② 博彩/色情词元
            f.viceToken = null;
            for (const t of tokens) { if (VICE_TOKENS.has(t)) { f.viceToken = t; break; } }

            // ③ 第三方
            f.thirdParty = info.thirdParty ? 1 : 0;

            // ④ 子域深度
            const depth = h.split('.').length;
            f.subDepth = depth >= 5 ? 1 : depth === 4 ? 0.6 : depth === 3 ? 0.3 : 0;

            // ⑤ 混合类型
            const T = info.types;
            f.hasScript = T.has('script');
            f.hasImage = T.has('image');
            f.hasXHR = T.has('xhr');
            f.hasIframe = T.has('iframe');
            f.hasBeacon = T.has('beacon');
            f.hasImageLink = T.has('image-link');
            f.mixed = (f.hasScript && f.hasImage && f.hasXHR) ? 1 : 0;

            // ⑥ 追踪像素
            const avg = info.count > 0 ? info.bytes / info.count : 0;
            f.pixel = (f.hasImage && !f.hasScript && !f.hasXHR && avg > 0 && avg < 1024) ? 1 : 0;

            // ⑦ 频次
            f.freq = info.count;

            // ⑧ 时间跨度
            const span = info.t1 - info.t0;
            f.span = span > 15000 ? 1 : span > 5000 ? 0.6 : span > 2000 ? 0.3 : 0;

            // ⑨ 类型多样性
            f.typeCount = T.size;

            // ⑩ 图片行为特征（博彩/色情图片关键）
            f.imageBehavior = 0;
            if (f.hasImage && info.types.size === 1) f.imageBehavior = 0.3;
            if (f.hasImageLink) f.imageBehavior = 0.8;
            if (f.hasImage && info.hasRedirect) f.imageBehavior = 1;
            const imgCount = info.urls.filter(u => /\.(gif|jpg|jpeg|png|webp|avif)(\?|$)/i.test(u)).length;
            if (imgCount >= 3) f.imageBehavior = Math.max(f.imageBehavior, 0.7);

            // ⑪ 跳转链特征
            f.redirectChain = info.hasRedirect ? 1 : 0;

            // ⑫ 隐藏通道
            f.hiddenChannel = (f.hasBeacon || (f.hasIframe && !f.hasScript)) ? 1 : 0;

            return f;
        }

        // ════════════════════════════════════════
        //  阶段3：精准评分（交叉验证 + 共振）
        // ════════════════════════════════════════
        function calculateScore(f) {
            if (!f.thirdParty && !f.adToken && !f.viceToken) {
                return { score: 0, level: 'safe', reasons: ['同站资源'], signals: 0 };
            }
            let s = 0, sig = 0;
            const r = [];

            if (f.viceToken) { s += 35; sig++; r.push('🚫词元"' + f.viceToken + '"'); }
            if (f.adToken) { s += 22; sig++; r.push('词元"' + f.adToken + '"'); }
            if (f.pixel) { s += 20; sig++; r.push('追踪像素'); }
            if (f.mixed) { s += 18; sig++; r.push('混合类型'); }

            if (f.thirdParty) { s += 8; sig++; r.push('第三方'); }
            if (f.subDepth >= 0.6) { s += 7; sig++; r.push('深子域'); }
            if (f.imageBehavior >= 0.8) { s += 20; sig++; r.push('🖼️图片跳转'); }
            else if (f.imageBehavior >= 0.5) { s += 12; sig++; r.push('图片异常'); }
            if (f.redirectChain) { s += 15; sig++; r.push('🔗跳转链'); }
            if (f.hiddenChannel) { s += 12; sig++; r.push('隐藏通道'); }

            if (f.freq >= 5) { s += 6; sig++; r.push('×' + f.freq); }
            else if (f.freq >= 3) { s += 3; }
            if (f.span > 0) { s += 5; sig++; r.push('持续请求'); }
            if (f.typeCount >= 4) { s += 4; }

            // 共振加成
            if (sig >= 5) { s += 20; r.push('共振+20'); }
            else if (sig >= 4) { s += 15; r.push('共振+15'); }
            else if (sig >= 3) { s += 10; r.push('共振+10'); }
            else if (sig >= 2) { s += 5; r.push('共振+5'); }

            // 博彩/色情特殊加成
            if (f.viceToken && f.imageBehavior >= 0.5) { s += 10; r.push('🚨博彩色情+图片'); }

            let level;
            if (s >= 55 && sig >= 3) level = 'ad';
            else if (s >= 35 && sig >= 2) level = 'suspect';
            else if (s >= 15) level = 'watch';
            else level = 'safe';

            return { score: Math.min(s, 100), level, reasons: r, signals: sig };
        }

        // ════════════════════════════════════════
        //  主入口
        // ════════════════════════════════════════
        function scan() {
            const t0 = performance.now();
            const map = collect();
            const results = [];
            for (const [, info] of map) {
                const f = extractFeatures(info);
                const { score, level, reasons, signals } = calculateScore(f);
                results.push(Object.assign({}, f, { score, level, reasons, signals, info }));
            }
            results.sort((a, b) => b.score - a.score);
            const elapsed = (performance.now() - t0).toFixed(1);
            return { results, elapsed, total: results.length };
        }

        return { scan, VICE_TOKENS };
    })();

    /**
     * ═══════════════════════════════════════════════════════════════
     *  算法二：OverlayAdScanner — 不可见/覆盖层广告专攻
     *
     *  专攻目标：不可见元素 · 覆盖层 · 博彩/色情图片 · 点击跳转拦截
     * ═══════════════════════════════════════════════════════════════
     */
    const OverlayAdScanner = (() => {

        const VICE_CONTAINER_RE = /(^|[\s_-])(ad|ads|advert|banner|sponsor|promo|overlay|popup|popunder|float|sticky|interstitial|modal|mask|cover|layer|tracking|pixel|casino|bet|porn|xxx|adult|sex|live|cam|dating|hot|splash|takeover|skyscraper|leaderboard|notification|push)([\s_-]|$)/i;
        const VICE_IMG_RE = /(^|[\s_-])(hot|live|sexy|nude|girl|casino|slot|bet|bonus|jackpot|winner|free|click|download|register|promo|banner|ad|popup)([\s_-]|$)/i;

        const QUICK_SEL = [
            'div[class]', 'div[id]', 'section[class]', 'aside[class]',
            'iframe', 'ins', 'a[target="_blank"]', 'img[src]',
            'div[style*="position"]', 'div[style*="z-index"]',
            'div[style*="opacity"]', 'div[style*="visibility"]',
            '[onclick]', '[ontouchstart]', '[onmousedown]',
            '[data-href]', '[data-url]', '[data-link]',
            'body > div[style*="position:fixed"]',
            'a[href*="goto"]', 'a[href*="click"]', 'a[href*="jump"]'
        ].join(',');

        function scan() {
            const t0 = performance.now();
            const results = [];
            const seen = new Set();

            // 阶段1：快速选择器扫描
            try {
                const candidates = document.querySelectorAll(QUICK_SEL);
                for (const el of candidates) {
                    if (seen.has(el)) continue;
                    // 统一保护判定：脚本自身 UI 宿主（含 Shadow DOM 内部节点）跳过
                    if (UIManager.isProtectedElement(el)) continue;
                    seen.add(el);
                    const f = _analyzeElement(el);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { }

            // 阶段2：定位元素扫描（覆盖层核心）
            try {
                const positioned = document.querySelectorAll('div,section,aside,article');
                for (const el of positioned) {
                    if (seen.has(el)) continue;
                    if (UIManager.isProtectedElement(el)) continue;
                    const cs = _cs(el);
                    if (!cs) continue;
                    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                    seen.add(el);
                    const f = _analyzeOverlay(el, cs);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { }

            // 阶段3：可点击图片专项（博彩/色情核心）
            try {
                const clickableImgs = document.querySelectorAll('a img, a > img, [onclick] img, img[onclick]');
                for (const img of clickableImgs) {
                    if (seen.has(img)) continue;
                    if (UIManager.isProtectedElement(img)) continue;
                    seen.add(img);
                    const f = _analyzeClickableImage(img);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { }

            // 阶段4：内联事件广告（移动端最常见的劫持手法）
            // 扫描所有 [onclick]、[ontouchstart]、[onmousedown] 的元素
            try {
                const inlineEventAds = document.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                for (const el of inlineEventAds) {
                    if (seen.has(el)) continue;
                    if (UIManager.isProtectedElement(el)) continue;
                    seen.add(el);
                    const f = _analyzeInlineEventAd(el);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { }

            results.sort((a, b) => b.suspicion - a.suspicion);
            const elapsed = (performance.now() - t0).toFixed(1);
            return { results, elapsed, total: results.length };
        }

        function _analyzeElement(el) {
            // 防御性保护：即使从外部直接调用也不会扫描脚本自身 UI
            if (UIManager.isProtectedElement(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'unknown' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'unknown' };
            const cs = _cs(el);
            if (!cs) return f;
            const tag = el.tagName.toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const rect = _rect(el);

            if (cs.opacity === '0' && rect.width > 0 && rect.height > 0) {
                f.suspicion += 35; f.reasons.push('opacity:0占位');
                f.features.invisible = 'opacity'; f.category = 'invisible';
            }
            if (cs.visibility === 'hidden' && rect.width > 0) {
                f.suspicion += 30; f.reasons.push('visibility:hidden');
                f.features.invisible = 'visibility'; f.category = 'invisible';
            }
            if (cs.display === 'none') {
                if (el.querySelector('img,iframe,script')) {
                    f.suspicion += 10; f.reasons.push('display:none含资源');
                    f.features.invisible = 'display';
                }
            }
            if (rect.left < -100 || rect.top < -100 || rect.right > window.innerWidth + 200) {
                f.suspicion += 25; f.reasons.push('屏幕外');
                f.features.offscreen = true; f.category = 'invisible';
            }
            if (rect.width >= 1 && rect.width <= 2 && rect.height >= 1 && rect.height <= 2) {
                f.suspicion += 40; f.reasons.push('1×1像素');
                f.features.pixel = true; f.category = 'tracking';
            }
            const z = parseInt(cs.zIndex) || 0;
            if ((cs.position === 'fixed' || cs.position === 'absolute') && z > 999) {
                f.suspicion += 25; f.reasons.push('z:' + z);
                f.features.highZ = z; f.category = 'overlay';
            }
            const screenArea = window.innerWidth * window.innerHeight;
            const area = rect.width * rect.height;
            if (area > screenArea * 0.7 && (cs.position === 'fixed' || cs.position === 'absolute')) {
                f.suspicion += 25; f.reasons.push('大面积覆盖');
                f.features.fullscreen = true; f.category = 'overlay';
            }
            if (VICE_CONTAINER_RE.test(cls) || VICE_CONTAINER_RE.test(id)) {
                f.suspicion += 20; f.reasons.push('命名可疑');
                f.features.viceAttr = true;
            }
            if (cs.pointerEvents === 'none' && rect.width > 100 && rect.height > 100) {
                f.suspicion += 15; f.reasons.push('幽灵遮罩');
                f.features.ghost = true; f.category = 'overlay';
            }
            if (el.querySelector('iframe,script[src]')) {
                f.suspicion += 10; f.reasons.push('内嵌资源');
                f.features.hasEmbed = true;
            }
            // 检查 onclick 内联跳转（广告常用手法）
            const onclickVal = el.getAttribute('onclick') || '';
            if (onclickVal) {
                if (onclickVal.includes('window.open') || onclickVal.includes('location.href') || onclickVal.includes('location=')) {
                    f.suspicion += 20; f.reasons.push('onclick跳转');
                    f.features.clickable = true;
                    // 提取跳转目标域名
                    const urlMatch = onclickVal.match(/https?:\/\/[^\s"'<>(){}']+/i);
                    if (urlMatch) {
                        try {
                            const targetHost = new URL(urlMatch[0]).hostname;
                            if (targetHost !== location.hostname) {
                                f.suspicion += 15; f.reasons.push('跨域跳转');
                                f.features.externalLink = targetHost;
                            }
                        } catch (e) { }
                    }
                }
            }
            // 检查 data-href/data-url/data-link 跳转属性
            const dataTrigger = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
            if (dataTrigger && /^https?:\/\//.test(dataTrigger)) {
                f.suspicion += 15; f.reasons.push('data-*跳转');
                f.features.clickable = true;
                try {
                    const targetHost = new URL(dataTrigger).hostname;
                    if (targetHost !== location.hostname) {
                        f.features.externalLink = targetHost;
                    }
                } catch (e) { }
            }
            f.selector = _buildSelector(el);
            f.features.tag = tag;
            return f;
        }

        function _analyzeOverlay(el, cs) {
            if (UIManager.isProtectedElement(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };
            const rect = _rect(el);
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const z = parseInt(cs.zIndex) || 0;

            if (z > 9999) { f.suspicion += 35; f.reasons.push('超高z:' + z); }
            else if (z > 999) { f.suspicion += 20; f.reasons.push('高z:' + z); }

            if (cs.position === 'fixed' && rect.width >= window.innerWidth * 0.85 && rect.height >= window.innerHeight * 0.85) {
                f.suspicion += 30; f.reasons.push('全屏fixed');
                f.features.fullscreen = true;
            }
            const opacity = parseFloat(cs.opacity);
            if (opacity > 0 && opacity < 0.15 && rect.width > 200 && rect.height > 200) {
                f.suspicion += 20; f.reasons.push('微透明遮罩');
                f.features.ghost = true;
            }
            if (VICE_CONTAINER_RE.test(cls) || VICE_CONTAINER_RE.test(id)) {
                f.suspicion += 20; f.reasons.push('命名可疑');
            }
            if (el.querySelector('iframe')) { f.suspicion += 15; f.reasons.push('含iframe'); }
            const imgs = el.querySelectorAll('img');
            if (imgs.length > 0) {
                f.suspicion += 10; f.reasons.push('含' + imgs.length + '张图');
                const links = el.querySelectorAll('a[href]');
                if (links.length > 0) {
                    f.suspicion += 15; f.reasons.push('图片+链接');
                    f.features.hasLink = true;
                }
            }
            f.features.zIndex = z;
            f.features.position = cs.position;
            f.selector = _buildSelector(el);
            f.features.tag = el.tagName.toLowerCase();
            return f;
        }

        function _analyzeClickableImage(img) {
            if (UIManager.isProtectedElement(img)) return { el: img, suspicion: 0, reasons: [], features: {}, category: 'vice-image' };
            const f = { el: img, suspicion: 0, reasons: [], features: {}, category: 'vice-image' };
            const rect = _rect(img);
            const parent = img.closest('a, [onclick]');
            const container = img.parentElement;

            if (parent) {
                const href = parent.getAttribute('href') || parent.getAttribute('onclick') || '';
                if (href && !href.startsWith('#') && !href.startsWith('javascript:void')) {
                    f.suspicion += 15; f.reasons.push('可点击跳转');
                    f.features.clickable = true;
                    try {
                        const targetHost = new URL(href, location.href).hostname;
                        if (targetHost !== location.hostname) {
                            f.suspicion += 20; f.reasons.push('外部跳转');
                            f.features.externalLink = targetHost;
                            const tokens = targetHost.split(/[^a-z0-9-]/i);
                            for (const t of tokens) {
                                if (GlobalDomainScanner.VICE_TOKENS.has(t.toLowerCase())) {
                                    f.suspicion += 30; f.reasons.push('🚫跳转"' + t + '"');
                                    f.features.viceTarget = t;
                                    break;
                                }
                            }
                        }
                    } catch (e) { }
                    if (href.includes('window.open') || href.includes('location')) {
                        f.suspicion += 25; f.reasons.push('JS跳转');
                        f.features.jsRedirect = true;
                    }
                }
            }
            if (rect.width > window.innerWidth * 0.4 && rect.height > 100) {
                f.suspicion += 10; f.reasons.push('大面积图片');
            }
            const src = img.src || (img.dataset && img.dataset.src) || '';
            if (src.endsWith('.gif') || src.includes('.gif?')) {
                f.suspicion += 10; f.reasons.push('GIF动图');
                f.features.isGif = true;
            }
            const cls = ((img.className || '') + ' ' + (container ? (container.className || '') : '')).toLowerCase();
            const id = (img.id || '').toLowerCase();
            if (VICE_IMG_RE.test(cls) || VICE_IMG_RE.test(id)) {
                f.suspicion += 15; f.reasons.push('图片命名可疑');
            }
            const cs = _cs(img) || _cs(container);
            if (cs && (cs.position === 'fixed' || cs.position === 'absolute')) {
                const z = parseInt(cs.zIndex) || 0;
                if (z > 100) { f.suspicion += 15; f.reasons.push('图片覆盖层z:' + z); }
            }
            if (img.dataset && img.dataset._dynamicInsert === '1') {
                f.suspicion += 15; f.reasons.push('动态插入');
                f.features.dynamic = true;
            }
            f.selector = _buildSelector(img.parentElement || img);
            f.features.tag = 'img';
            f.features.src = src.substring(0, 120);
            return f;
        }

        // 分析带内联事件的广告元素（移动端劫持核心）
        // 针对 [onclick] / [ontouchstart] / [onmousedown] / [data-href] 等元素
        function _analyzeInlineEventAd(el) {
            if (UIManager.isProtectedElement(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'invisible' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'invisible' };
            const tag = el.tagName.toLowerCase();
            const rect = _rect(el);
            const cls = (el.className || '').toString().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const onclickVal = el.getAttribute('onclick') || '';
            if (onclickVal) {
                if (/window\.open|location\.href|location\s*=|window\.location/.test(onclickVal)) {
                    f.suspicion += 35; f.reasons.push('onclick含跳转');
                    f.features.clickable = true;
                    const urlMatch = onclickVal.match(/['"]([^'"]*\.cc[^'"]*|https?:\/\/[^'"]+)['"]/);
                    if (urlMatch) {
                        try {
                            const targetHost = new URL(urlMatch[1]).hostname;
                            f.features.externalLink = targetHost;
                            const labels = targetHost.toLowerCase().split('.');
                            if (labels.length >= 2 && GAMBLING_TLDS.has(labels[labels.length - 1])) {
                                f.suspicion += 25; f.reasons.push('赌博TLD');
                                f.features.viceTarget = targetHost;
                                f.category = 'vice-image';
                            }
                        } catch (e) { }
                    }
                }
                if (/^gogogo|^gourl|^godown|^golh|^goAppHtml|^GoGd|^GoTp|^lksdjfrefruise|^diensfeifwej|^_czc\./.test(onclickVal.trim())) {
                    f.suspicion += 25; f.reasons.push('可疑函数');
                    f.features.clickable = true;
                }
            }
            const ontouchstartVal = el.getAttribute('ontouchstart') || '';
            if (ontouchstartVal) {
                if (/this\.click\(\)/.test(ontouchstartVal)) {
                    f.suspicion += 40; f.reasons.push('移动端劫持');
                    f.features.clickable = true;
                    f.category = 'overlay';
                } else if (ontouchstartVal.length > 5) {
                    f.suspicion += 20; f.reasons.push('触屏事件');
                    f.features.clickable = true;
                }
            }
            if (el.getAttribute('onmousedown')) {
                f.suspicion += 15; f.reasons.push('mousedown事件');
                f.features.clickable = true;
            }
            const dataTrigger = el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
            if (dataTrigger && /^https?:\/\/|^\/\//.test(dataTrigger)) {
                f.suspicion += 30; f.reasons.push('data跳转');
                f.features.clickable = true;
                try {
                    const targetHost = new URL(dataTrigger, location.href).hostname;
                    f.features.externalLink = targetHost;
                    const labels = targetHost.toLowerCase().split('.');
                    if (labels.length >= 2 && GAMBLING_TLDS.has(labels[labels.length - 1])) {
                        f.suspicion += 25; f.reasons.push('赌博TLD');
                        f.features.viceTarget = targetHost;
                        f.category = 'vice-image';
                    }
                } catch (e) { }
            }
            if (tag === 'a') {
                const href = el.getAttribute('href') || '';
                if (/goto|click|jump|go\.php/.test(href)) {
                    f.suspicion += 20; f.reasons.push('跳转代理');
                    f.features.clickable = true;
                }
                const parentCls = el.parentElement ? (el.parentElement.className || '').toString().toLowerCase() : '';
                if (/ad|ads|advert|banner|popup|overlay|promo|sponsor/.test(parentCls)) {
                    f.suspicion += 15; f.reasons.push('父级广告类名');
                    f.features.viceAttr = true;
                }
            }
            if (VICE_CONTAINER_RE.test(cls) || VICE_CONTAINER_RE.test(id)) {
                f.suspicion += 15; f.reasons.push('命名可疑');
                f.features.viceAttr = true;
            }
            if (rect.width >= 50 && rect.height >= 30) {
                if (rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight) {
                    f.suspicion += 5;
                }
            }
            if (f.suspicion <= 0) return f;
            f.selector = _buildSelector(el);
            f.features.tag = tag;
            return f;
        }

        // ─── 跳转拦截（博彩/色情核心防线，补充 NetworkInterceptor 未覆盖的导航型拦截）───
        let _navBlocked = [];
        let _navInterceptorActive = false;

        function enableNavigationInterceptor(blockedDomains) {
            if (_navInterceptorActive) return;
            _navInterceptorActive = true;
            // 初始快照用于启动期，后续命中通过静态特征匹配
            const _checkNav = (url) => {
                if (!url) return false;
                // 兜底：启动期快照 + 静态特征（IP/短链/博彩色情词元）
                return _isBlockedNav(url, blockedDomains);
            };

            // ① 拦截 window.open
            const _origOpen = window.open;
            window.open = function (url) {
                const args = Array.prototype.slice.call(arguments);
                if (_checkNav(url)) {
                    _navBlocked.push({ type: 'window.open', url: url, time: Date.now() });
                    console.warn('[OverlayAdScanner] 拦截 window.open:', url);
                    return null;
                }
                return _origOpen.apply(this, args);
            };

            // ② 拦截 <a> 点击 + onclick 内联跳转（捕获阶段）
            document.addEventListener('click', function (e) {
                // 统一保护：脚本自身 UI 宿主内的点击不处理，避免误删面板
                if (UIManager.isProtectedElement(e.target)) return;
                // 先检查 <a href> 跳转
                const link = e.target.closest && e.target.closest('a');
                if (link) {
                    const href = link.href || '';
                    if (href && _checkNav(href)) {
                        e.preventDefault();
                        e.stopPropagation();
                        _navBlocked.push({ type: 'link.click', url: href, time: Date.now() });
                        console.warn('[OverlayAdScanner] 拦截链接:', href);
                        const container = link.closest('[class*="ad"],[class*="popup"],[class*="banner"],[class*="overlay"]') || link;
                        // 删除前再次校验保护，避免误删脚本自身 UI 的祖先
                        if (!UIManager.isProtectedElement(container)) container.remove();
                        return;
                    }
                }
                // 再检查 onclick 内联属性中的跳转 URL（广告常用手法）
                const target = e.target;
                if (target && target.getAttribute) {
                    const onclickVal = target.getAttribute('onclick') || '';
                    if (onclickVal) {
                        // 提取 onclick 中的 URL（window.open('...') / location.href='...' / location='...'）
                        const urlMatches = onclickVal.match(/(?:window\.open\s*\(\s*['"]|location(?:\.href)?\s*=\s*['"])([^'"]+)['"]/g);
                        if (urlMatches) {
                            for (const m of urlMatches) {
                                const url = m.match(/['"]([^'"]+)['"]/);
                                if (url && _checkNav(url[1])) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.stopImmediatePropagation && e.stopImmediatePropagation();
                                    _navBlocked.push({ type: 'onclick', url: url[1], time: Date.now() });
                                    console.warn('[OverlayAdScanner] 拦截 onclick 跳转:', url[1]);
                                    const container = target.closest('[class*="ad"],[class*="popup"],[class*="banner"],[class*="overlay"]') || target;
                                    // 删除前再次校验保护，避免误删脚本自身 UI 的祖先
                                    if (!UIManager.isProtectedElement(container)) container.remove();
                                    return;
                                }
                            }
                        }
                    }
                }
            }, true);

            // ③ 拦截 location.href 赋值
            try {
                const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
                if (desc && desc.set) {
                    Object.defineProperty(Location.prototype, 'href', {
                        set(val) {
                            if (_checkNav(val)) {
                                _navBlocked.push({ type: 'location.href', url: val, time: Date.now() });
                                console.warn('[OverlayAdScanner] 拦截 location:', val);
                                return;
                            }
                            desc.set.call(this, val);
                        },
                        get() { return desc.get.call(this); },
                        configurable: true
                    });
                }
            } catch (e) { }

            // ④ 拦截 form 提交
            document.addEventListener('submit', function (e) {
                const action = e.target.action || '';
                if (action && _checkNav(action)) {
                    e.preventDefault();
                    e.stopPropagation();
                    _navBlocked.push({ type: 'form.submit', url: action, time: Date.now() });
                }
            }, true);
        }

        function _isBlockedNav(url, blockedDomains) {
            if (!url) return false;
            try {
                const u = new URL(url, location.href);
                const h = u.hostname.toLowerCase();
                if (blockedDomains) {
                    for (const d of blockedDomains) {
                        if (h === d || h.endsWith('.' + d)) return true;
                    }
                }
                const tokens = h.split(/[^a-z0-9-]/);
                for (const t of tokens) {
                    if (GlobalDomainScanner.VICE_TOKENS.has(t)) return true;
                }
                if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
                if (/bit\.ly|t\.cn|tinyurl|goo\.gl|ow\.ly|cutt\.ly|rebrand\.ly/i.test(h)) return true;
                return false;
            } catch (e) { return false; }
        }

        function _cs(el) {
            try { return window.getComputedStyle(el); } catch (e) { return null; }
        }
        function _rect(el) {
            try { return el.getBoundingClientRect(); } catch (e) { return { width: 0, height: 0, left: 0, top: 0, right: 0 }; }
        }
        function _buildSelector(el) {
            if (!el) return '';
            if (el.id) return '#' + el.id;
            let s = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') {
                const cls = el.className.trim().split(/\s+/).slice(0, 2);
                if (cls[0]) s += '.' + cls.join('.');
            }
            const parent = el.parentElement;
            if (parent && parent.id) return '#' + parent.id + ' > ' + s;
            if (parent && parent.className && typeof parent.className === 'string') {
                const pcls = parent.className.trim().split(/\s+/)[0];
                if (pcls) return '.' + pcls + ' > ' + s;
            }
            return s;
        }

        return { scan, enableNavigationInterceptor };
    })();

    /**
     * 用户交互界面：基于 Shadow DOM 隔离
     */
    class UIManager {
        // 全局不可侵犯保护判定：所有扫描/隐藏入口必须调用此函数，
        // 统一排除脚本自身 UI 宿主（含其子元素、Shadow DOM 内部节点），
        // 防止任何规则或扫描误伤面板导致整个脚本 UI 全毁
        static isProtectedElement(el) {
            if (!el) return true;
            if (el.id === 'pro-blocker-ui-host') return true;
            if (el.closest && el.closest('#pro-blocker-ui-host')) return true;
            // Shadow DOM 内部节点保护：getRootNode 返回 ShadowRoot 时，其 host 即面板宿主
            let root;
            try { root = el.getRootNode && el.getRootNode(); } catch (e) { root = null; }
            if (root && root.host && root.host.id === 'pro-blocker-ui-host') return true;
            return false;
        }

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
            this._actionPreview = { active: false, el: null, elements: [] };
            // 全局域名面板预览状态：必须为实例属性，clearPanel 才能跨面板切换时清理，避免预览隐藏的元素永久残留
            this._globalPreview = { active: false, elements: [] };
            // 覆盖层扫描面板预览状态：同为实例属性，clearPanel 跨面板切换时还原 visibility/display
            this._overlayPreview = { active: false, elements: [] };
            // 手动选区面板域名选择状态：默认全选检测到的域名，用户可逐个取消
            this._actionHosts = null;
            this._actionHostsEl = null;
            this._contextmenuHandler = null;
            // 选择模式状态横幅与预览模式横幅：实例属性，clearPanel 兜底清理
            this._selectionBanner = null;
            this._previewBanner = null;
            // 轻量撤销栈：最近 5 次删除规则操作可撤销
            this._undoStack = [];
            this._handleMouseOver = this._handleMouseOver.bind(this);
            this._handleClick = this._handleClick.bind(this);
            this._handlePointerDown = this._handlePointerDown.bind(this);
            this._handleMouseDown = this._handleMouseDown.bind(this);
            // 中键/右键辅助点击拦截：防止广告通过 auxclick 触发新标签打开跳转
            this._handleAuxClick = this._handleAuxClick.bind(this);
            // 触屏处理函数同样在构造期绑定一次，保持引用稳定，避免 startSelection 重复 bind 已绑定函数
            this._handleTouchStart = this._handleTouchStart.bind(this);
            this._handleTouchMove = this._handleTouchMove.bind(this);
            this._handleTouchEnd = this._handleTouchEnd.bind(this);
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
                    .panel { background: rgba(25, 25, 30, 0.52); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); max-width: calc(100vw - 64px); max-height: 70vh; padding: 16px; }
                }
                @media (max-width: 480px) {
                    .panel { padding: 16px; border-radius: 14px; max-height: 72vh; width: calc(100vw - 56px); max-width: calc(100vw - 56px); }
                    .panel h3 { font-size: 15px; }
                    .panel p, .panel .hint-text { font-size: 12px; }
                    .btn-group button { padding: 8px 10px; font-size: 12px; }
                    .gd-domain-row { padding: 8px; }
                    .gd-domain-row .gd-host { font-size: 11px; }
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
                .as-site { font-size: 10px; padding: 2px 7px; border-radius: 10px; background: rgba(255,111,0,0.55); color: #fff; margin-right: 6px; font-weight: 600; white-space: nowrap; display: inline-block; max-width: 140px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
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
                /* 未选中的域名：灰色，提示用户该项不会被封杀 */
                .selection-info .domain-item.unselected { background: rgba(120,120,120,0.55); color: #ccc; text-decoration: line-through; }
                /* 规则与防御管理：域名规则置顶的小标题 */
                .rule-list .rule-section-title { list-style: none; font-size: 11px; color: #ff8a80; font-weight: 700; margin: 6px 0 2px; padding: 2px 4px; border-bottom: 1px dashed rgba(255,138,128,0.4); }
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
                .gd-scroll-area { max-height: 320px; overflow-y: auto; padding-right: 4px; }
                .gd-scroll-area::-webkit-scrollbar { width: 6px; }
                .gd-scroll-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
                .gd-scroll-area::-webkit-scrollbar-track { background: transparent; }

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

                /* Toast 通知：非阻塞，右上角自动消失，替代 alert() */
                .pro-toast {
                    position: fixed; top: 20px; right: 20px; z-index: 2147483646;
                    padding: 12px 18px; border-radius: 10px;
                    background: rgba(30,30,35,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                    border: 1px solid rgba(255,255,255,0.15);
                    color: #fff; font-size: 13px; display: flex; align-items: center; gap: 8px;
                    transform: translateX(120%); transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
                    box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-width: 360px; word-break: break-all;
                }
                .pro-toast.pro-toast-show { transform: translateX(0); }
                .pro-toast.pro-toast-hide { transform: translateX(120%); opacity: 0; }
                .pro-toast-success { border-left: 3px solid #34c759; }
                .pro-toast-error { border-left: 3px solid #ff3b30; }
                .pro-toast-warning { border-left: 3px solid #ff9500; }
                .pro-toast-info { border-left: 3px solid #4aa3ff; }
                .pro-toast .toast-undo {
                    margin-left: 8px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
                    background: rgba(255,149,0,0.7); border: none; color: #fff; font-size: 12px; font-weight: 600;
                    flex: none;
                }
                .pro-toast .toast-undo:hover { filter: brightness(1.15); }

                /* 内嵌确认弹窗：替代 confirm()，面板内弹出 */
                .pro-confirm-overlay {
                    position: fixed; inset: 0; z-index: 2147483646;
                    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
                    display: flex; align-items: center; justify-content: center;
                }
                .pro-confirm-box {
                    background: rgba(25,25,30,0.95); border-radius: 14px;
                    padding: 24px; width: min(380px, 90vw);
                    border: 1px solid rgba(255,255,255,0.15);
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                }
                .pro-confirm-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 12px; }
                .pro-confirm-body { font-size: 13px; color: #ccc; line-height: 1.6; margin-bottom: 20px; white-space: pre-line; word-break: break-all; }
                .pro-confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
                .pro-confirm-actions button { flex: none; padding: 8px 20px; }

                /* 选择模式状态横幅 */
                .pro-selection-banner {
                    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;
                    background: rgba(255,149,0,0.9); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                    color: #fff; text-align: center; padding: 8px 16px;
                    font-size: 13px; font-weight: 500; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    box-shadow: 0 2px 12px rgba(0,0,0,0.2);
                }

                /* 预览模式全局横幅 */
                .pro-preview-banner {
                    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483646;
                    background: rgba(74,163,255,0.92); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                    color: #fff; padding: 8px 20px; border-radius: 20px;
                    font-size: 12px; font-weight: 500; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.3); display: flex; align-items: center; gap: 8px;
                }
                .pro-preview-banner .pro-preview-close {
                    background: rgba(255,255,255,0.2); border: none; color: #fff; cursor: pointer;
                    width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
                    font-size: 14px; padding: 0;
                }
                .pro-preview-banner .pro-preview-close:hover { background: rgba(255,255,255,0.35); }
            `;
            this.shadowRoot.appendChild(style);
        }

        // Toast 通知：非阻塞，自动消失，替代 alert()
        // type: success/error/warning/info；duration 默认 3000ms；onUndo 可选撤销回调
        showToast(message, type = 'success', duration = 3000, onUndo = null) {
            const toast = document.createElement('div');
            toast.className = `pro-toast pro-toast-${type}`;
            const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
            const iconSpan = icons[type] ? `<span>${icons[type]}</span>` : '';
            const undoBtn = onUndo ? `<button class="toast-undo">撤销</button>` : '';
            toast.innerHTML = `${iconSpan}<span>${message}</span>${undoBtn}`;
            this.shadowRoot.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('pro-toast-show'));
            let undone = false;
            if (onUndo) {
                toast.querySelector('.toast-undo').addEventListener('click', () => {
                    if (undone) return;
                    undone = true;
                    onUndo();
                    this._dismissToast(toast);
                });
            }
            setTimeout(() => this._dismissToast(toast), duration);
        }

        _dismissToast(toast) {
            if (!toast || !toast.isConnected) return;
            toast.classList.remove('pro-toast-show');
            toast.classList.add('pro-toast-hide');
            setTimeout(() => toast.remove(), 300);
        }

        // 内嵌确认弹窗：替代 confirm()，onConfirm 为确认回调
        showConfirm(title, message, onConfirm) {
            const overlay = document.createElement('div');
            overlay.className = 'pro-confirm-overlay';
            overlay.innerHTML = `
                <div class="pro-confirm-box">
                    <div class="pro-confirm-title">${escapeHTML(title)}</div>
                    <div class="pro-confirm-body">${escapeHTML(message)}</div>
                    <div class="pro-confirm-actions">
                        <button class="btn-danger" id="cf-yes">确认</button>
                        <button class="btn-outline" id="cf-no">取消</button>
                    </div>
                </div>`;
            this.shadowRoot.appendChild(overlay);
            overlay.querySelector('#cf-yes').addEventListener('click', () => {
                overlay.remove();
                try { onConfirm && onConfirm(); } catch (e) { console.error('[Pro Blocker] 确认回调异常:', e); }
            });
            overlay.querySelector('#cf-no').addEventListener('click', () => overlay.remove());
            overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        }

        // 选择模式状态横幅
        _showSelectionBanner() {
            this._hideSelectionBanner();
            const banner = document.createElement('div');
            banner.className = 'pro-selection-banner';
            banner.textContent = '🎯 选择模式 — 点击广告元素进行屏蔽 │ ESC 退出';
            this.shadowRoot.appendChild(banner);
            this._selectionBanner = banner;
        }
        _hideSelectionBanner() {
            if (this._selectionBanner) {
                this._selectionBanner.remove();
                this._selectionBanner = null;
            }
        }

        // 面板智能定位：避免遮挡选中元素，优先在元素下方/上方/居中
        _positionPanelNearElement(panel, targetEl) {
            if (!panel || !targetEl || !targetEl.getBoundingClientRect) return;
            const rect = targetEl.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            const panelW = Math.min(480, vw - 48);
            const panelH = Math.min(720, vh * 0.76);
            // 默认在元素下方
            let top = rect.bottom + 12;
            let left = Math.max(24, Math.min(rect.left, vw - panelW - 24));
            // 下方空间不够 → 放上方
            if (top + panelH > vh - 24) {
                top = Math.max(24, rect.top - panelH - 12);
            }
            // 上方也不够 → 居中
            if (top < 24) {
                top = (vh - panelH) / 2;
                left = (vw - panelW) / 2;
            }
            panel.style.transform = 'none';
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
        }

        // 预览模式全局横幅：所有预览激活时显示，提示用户当前处于预览态
        _showPreviewBanner(onClose) {
            this._hidePreviewBanner();
            const banner = document.createElement('div');
            banner.className = 'pro-preview-banner';
            banner.innerHTML = `<span>👁 预览模式激活中 — 已隐藏元素为预览效果</span><button class="pro-preview-close" title="退出预览">✕</button>`;
            this.shadowRoot.appendChild(banner);
            this._previewBanner = banner;
            banner.querySelector('.pro-preview-close').addEventListener('click', () => {
                try { onClose && onClose(); } catch (e) { console.error('[Pro Blocker] 预览关闭异常:', e); }
            });
        }
        _hidePreviewBanner() {
            if (this._previewBanner) {
                this._previewBanner.remove();
                this._previewBanner = null;
            }
        }

        // ===== 统一预览引擎：抽取各面板重复的 hideNode / 域名资源隐藏逻辑 =====
        // 预览隐藏单个节点（标准口径：display + opacity，与 applyCSSRules 一致）
        // store 为调用方预览状态的 elements 数组，隐藏的节点推入其中便于还原
        _previewHideNode(node, store) {
            if (!node || node === document.body || node === document.documentElement) return false;
            if (UIManager.isProtectedElement(node)) return false;
            if (node.style.display === 'none') return false;
            node.style.setProperty('display', 'none', 'important');
            node.style.setProperty('opacity', '0', 'important');
            store.push(node);
            return true;
        }

        // 预览隐藏资源元素及其父级 + 单子链容器（与 scanAndBlockDynamic 同口径）
        _previewHideResourceAndWrappers(target, store) {
            if (!target) return;
            this._previewHideNode(target, store);
            if (target.parentElement) this._previewHideNode(target.parentElement, store);
            this._previewHideNode(BlockEngine.findSingleChildWrapper(target, 4), store);
        }

        // 预览按域名隐藏全页资源：6 通道属性选择器（src/href/data-src/data-original/srcset/poster）
        // domains 可为 Set 或数组
        _previewHideDomainResources(domains, store) {
            if (!domains || !store) return;
            const list = Array.from(domains);
            list.forEach(d => {
                const esc = escapeCSSAttr(d);
                const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`;
                try {
                    document.querySelectorAll(sel).forEach(el => this._previewHideResourceAndWrappers(el, store));
                } catch (e) { } // 选择器可能因特殊字符抛 SyntaxError
            });
        }

        // 轻量撤销栈：最近 5 次删除规则操作可撤销
        // entry: { type, domain, scope, rule } —— rule 为删除前捕获的完整规则对象
        _pushUndo(entry) {
            this._undoStack.push(entry);
            if (this._undoStack.length > 5) this._undoStack.shift();
        }
        _performUndo() {
            const entry = this._undoStack.pop();
            if (!entry) { this.showToast('没有可撤销的操作', 'info'); return; }
            try {
                // 批量删除撤销：entry.batch=true 时 rules 为删除规则数组，逐条恢复
                const items = entry.batch ? entry.rules : [entry];
                items.forEach(it => {
                    if (it.scope === 'global' || it.type === 'domainBlock') {
                        storage.addRule('domainBlock', { domain: it.rule.domain, type: 'domainBlock' });
                    } else if (it.scope === 'other') {
                        storage.addRuleForDomain(it.domain, it.type, it.rule);
                    } else {
                        storage.addRule(it.type, it.rule);
                    }
                });
                BlockEngine.restoreAllInlineStyles();
                BlockEngine.applyCSSRules();
                BlockEngine.applyRegexRules();
                BlockEngine.applyComplexRules();
                BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                this.showToast(entry.batch ? `已撤销批量删除（${items.length} 条）` : '已撤销删除', 'success');
            } catch (e) {
                console.error('[Pro Blocker] 撤销失败:', e);
                this.showToast('撤销失败：' + e.message, 'error');
            }
        }

        // 错误兜底面板：面板渲染异常时显示，避免整个 UI 崩溃
        // onRetry 为可选重试回调，传入时点击"重试"重新执行失败的面板入口
        _showErrorPanel(title, detail, onRetry) {
            this.shadowRoot.innerHTML = '';
            this.injectStyles();
            const panel = document.createElement('div');
            panel.className = 'panel';
            panel.innerHTML = `
                <h3>⚠️ ${escapeHTML(title)}</h3>
                <p style="color:#ff6b6b; font-size:12px;">${escapeHTML(detail)}</p>
                <div class="btn-group">
                    <button class="btn-primary" id="btn-retry">重试</button>
                    <button class="btn-outline" id="btn-close-err">关闭</button>
                </div>`;
            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);
            panel.querySelector('#btn-close-err').addEventListener('click', () => this.clearPanel());
            panel.querySelector('#btn-retry').addEventListener('click', () => {
                this.clearPanel();
                if (typeof onRetry === 'function') { try { onRetry(); } catch (e) { console.error('[Pro Blocker] 重试失败:', e); } }
            });
        }

        // 面板入口错误边界：包裹面板渲染逻辑，异常时显示错误面板而非崩溃
        // title 用于错误面板标题，retry 为重试回调（通常重新调用该面板入口）
        _safeCall(title, fn, retry) {
            try {
                fn();
            } catch (e) {
                console.error('[Pro Blocker] ' + title + '失败:', e);
                this._showErrorPanel(title + '失败', e && e.message ? e.message : String(e), retry);
            }
        }

        injectHighlightStyle() {
            // 从存储加载用户自定义高亮颜色，默认 #FF3B30
            const savedColor = GM_getValue('config_highlight_color', '#FF3B30');
            document.documentElement.style.setProperty('--pro-blocker-highlight-color', savedColor);

            let style = document.getElementById('pro-blocker-highlight-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'pro-blocker-highlight-style';
                style.textContent = `
                    .pro-blocker-highlight {
                        outline: 3px solid var(--pro-blocker-highlight-color, #FF3B30) !important; outline-offset: -3px !important;
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
                // 拖拽边距保护与 CSS 响应式边距保持一致（Bug2）
                const padding = window.innerWidth <= 480 ? 28 : (window.innerWidth <= 600 ? 32 : 24);
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

        startSelection() {
            this.stopSelection();
            this.injectHighlightStyle();
            this._showSelectionBanner();
            // 选择模式下完全冻结页面导航：广告常通过 window.open / location.href / form.submit
            // 在 touchstart/click 触发瞬间跳转，仅靠事件 capture 无法兜底，必须从 API 层拦截
            this._freezeNavigation();
            this._contextmenuHandler = (e) => {
                e.preventDefault();
                this.stopSelection();
            };
            this._keydownHandler = (e) => {
                if (e.key === 'Escape') this.stopSelection();
            };
            document.addEventListener('keydown', this._keydownHandler);
            // 拦截事件必须尽可能早地阻止广告跳转：
            // ① pointerdown：在 mousedown/touchstart 之前触发，是最早可拦截的人机交互事件
            // ② document 级 capture：确保在所有目标阶段处理之前拦截（无论 body 是否被广告脚本清空）
            // ③ 同时拦截 mouseover/click/touch*/auxclick：覆盖鼠标 + 触屏 + pointer + 中键四种交互模型
            const registerOnDoc = () => {
                document.addEventListener('pointerdown', this._handlePointerDown, { capture: true, passive: false });
                document.addEventListener('mousedown', this._handleMouseDown, { capture: true, passive: false });
                document.addEventListener('mouseover', this._handleMouseOver, { capture: true });
                document.addEventListener('click', this._handleClick, { capture: true, passive: false });
                document.addEventListener('contextmenu', this._contextmenuHandler, { capture: true });
                document.addEventListener('touchstart', this._handleTouchStart, { capture: true, passive: false });
                document.addEventListener('touchmove', this._handleTouchMove, { capture: true, passive: false });
                document.addEventListener('touchend', this._handleTouchEnd, { capture: true, passive: false });
                // 拦截 auxclick（中键点击打开新标签、右键点击）：防止绕过 click 拦截触发跳转
                document.addEventListener('auxclick', this._handleAuxClick, { capture: true });
            };
            registerOnDoc();
        }

        stopSelection() {
            if (this._keydownHandler) {
                document.removeEventListener('keydown', this._keydownHandler);
                this._keydownHandler = null;
            }
            document.removeEventListener('pointerdown', this._handlePointerDown, { capture: true });
            document.removeEventListener('mousedown', this._handleMouseDown, { capture: true });
            document.removeEventListener('mouseover', this._handleMouseOver, { capture: true });
            document.removeEventListener('click', this._handleClick, { capture: true });
            if (this._contextmenuHandler) {
                document.removeEventListener('contextmenu', this._contextmenuHandler, { capture: true });
                this._contextmenuHandler = null;
            }
            if (this._handleTouchStart) document.removeEventListener('touchstart', this._handleTouchStart, { capture: true });
            if (this._handleTouchMove) document.removeEventListener('touchmove', this._handleTouchMove, { capture: true });
            if (this._handleTouchEnd) document.removeEventListener('touchend', this._handleTouchEnd, { capture: true });
            if (this._handleAuxClick) document.removeEventListener('auxclick', this._handleAuxClick, { capture: true });
            if (this.highlightEl) {
                this.highlightEl.classList.remove('pro-blocker-highlight');
                this.highlightEl = null;
            }
            this._hideSelectionBanner();
            // 恢复导航能力：必须与 _freezeNavigation 配对，否则页面所有跳转永久失效
            this._unfreezeNavigation();
        }

        // 选择模式导航冻结：劫持所有可能触发跳转的 API，确保用户点击广告元素时页面不跳走
        _freezeNavigation() {
            // 幂等保护：重复调用不覆盖已保存的原始引用，避免恢复时还原成被劫持版本
            if (this._navFrozen) return;
            this._navFrozen = true;
            this._origWindowOpen = window.open;
            this._origLocationHrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
            this._origAssign = Location.prototype.assign;
            this._origReplace = Location.prototype.replace;
            this._origPushState = history.pushState;
            this._origReplaceState = history.replaceState;
            this._origFormSubmit = HTMLFormElement.prototype.submit;

            window.open = (...args) => {
                console.warn('[Pro Blocker] 选择模式：拦截 window.open', args[0]);
                return null;
            };
            try {
                const desc = this._origLocationHrefDesc;
                if (desc && desc.set) {
                    Object.defineProperty(Location.prototype, 'href', {
                        get: desc.get,
                        set: (val) => {
                            console.warn('[Pro Blocker] 选择模式：拦截 location.href =', val);
                        },
                        configurable: true
                    });
                }
            } catch (e) { }
            Location.prototype.assign = function (url) {
                console.warn('[Pro Blocker] 选择模式：拦截 location.assign', url);
            };
            Location.prototype.replace = function (url) {
                console.warn('[Pro Blocker] 选择模式：拦截 location.replace', url);
            };
            history.pushState = function () { /* 静默：阻止 SPA 路由跳转 */ };
            history.replaceState = function () { /* 静默 */ };
            HTMLFormElement.prototype.submit = function () {
                console.warn('[Pro Blocker] 选择模式：拦截 form.submit');
            };
        }

        // 解除导航冻结：恢复所有被 _freezeNavigation 劫持的原始函数
        _unfreezeNavigation() {
            if (!this._navFrozen) return;
            this._navFrozen = false;
            if (this._origWindowOpen) window.open = this._origWindowOpen;
            if (this._origLocationHrefDesc) {
                try {
                    Object.defineProperty(Location.prototype, 'href', this._origLocationHrefDesc);
                } catch (e) { }
            }
            if (this._origAssign) Location.prototype.assign = this._origAssign;
            if (this._origReplace) Location.prototype.replace = this._origReplace;
            if (this._origPushState) history.pushState = this._origPushState;
            if (this._origReplaceState) history.replaceState = this._origReplaceState;
            if (this._origFormSubmit) HTMLFormElement.prototype.submit = this._origFormSubmit;
        }

        _handleMouseOver(e) {
            if (!e.target || !e.target.closest) return;
            // 统一调用 isProtectedElement：覆盖 shadowRoot 内部子元素，防止选中面板自身
            if (UIManager.isProtectedElement(e.target)) return;
            // 排除 body/html：透明覆盖层覆盖全页时 mouseover target 可能是 body/html，
            // 高亮整个页面会导致用户无法选择具体广告元素
            if (e.target === document.body || e.target === document.documentElement) return;
            // 大面积元素智能降级：广告脚本可能清空 body 后重建一个超大容器，
            // 此时选中整页容器无意义，自动降级到其首个有实际内容的子元素
            const rect = e.target.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            if (rect.width > vw * 0.9 && rect.height > vh * 0.9) {
                const child = e.target.querySelector('div, section, aside, article, iframe, img, a');
                if (child && !UIManager.isProtectedElement(child)) {
                    if (this.highlightEl) this.highlightEl.classList.remove('pro-blocker-highlight');
                    this.highlightEl = child;
                    this.highlightEl.classList.add('pro-blocker-highlight');
                    return;
                }
                return; // 无法找到更具体的子元素，不高亮
            }
            if (this.highlightEl) this.highlightEl.classList.remove('pro-blocker-highlight');
            this.highlightEl = e.target;
            this.highlightEl.classList.add('pro-blocker-highlight');
        }

        // 触屏移动设备：通过 touchmove 实时更新高亮（替代 mouseover）
        _handleTouchMove(e) {
            if (!e.touches || e.touches.length === 0) return;
            const touch = e.touches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            if (!target || !target.closest || UIManager.isProtectedElement(target)) return;
            if (target === document.body || target === document.documentElement) return;
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
            if (!target || !target.closest || UIManager.isProtectedElement(target)) return;
            if (target === document.body || target === document.documentElement) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
            this.stopSelection();
            this.showActionPanel(target);
        }

        // 阻止 touchstart 默认行为，防止广告通过 touch 事件直接触发跳转（移动端）
        _handleTouchStart(e) {
            if (!e.target || !e.target.closest || UIManager.isProtectedElement(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // pointerdown 是最早的人机交互事件，先于 mousedown/touchstart/click 触发
        // 在 capture 阶段拦截，确保广告 ontouchstart="this.click();" / onclick 无法执行
        _handlePointerDown(e) {
            if (!e.target || !e.target.closest || UIManager.isProtectedElement(e.target)) return;
            // 必须先 stop 掉广告可能的 ontouchstart / onclick
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // mousedown 作为兜底：有些环境 pointerdown 不触发（如纯鼠标点击）
        _handleMouseDown(e) {
            if (!e.target || !e.target.closest || UIManager.isProtectedElement(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // 拦截中键/右键辅助点击：广告 <a target="_blank"> 中键点击会绕过 click 监听直接打开新标签
        _handleAuxClick(e) {
            if (!e.target || !e.target.closest || UIManager.isProtectedElement(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        _handleClick(e) {
            if (!e.target || !e.target.closest || UIManager.isProtectedElement(e.target)) return;
            // body/html 不是有效拦截目标，提示用户选择具体元素
            if (e.target === document.body || e.target === document.documentElement) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation && e.stopImmediatePropagation();
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
            this.stopSelection();
            // 元素有效性校验：广告脚本可能在 stopSelection 触发的导航解冻瞬间移除目标元素
            // 此时再 showActionPanel 会绑定失效引用，导致后续操作报错
            if (!this._isElementInDOM(e.target)) {
                this.showToast('目标元素已失效，请重新选择。', 'warning');
                return;
            }
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
            // 新版预览隐藏「所选域名命中的全部元素 + 当前广告容器」，需逐个还原
            if (Array.isArray(this._actionPreview.elements) && this._actionPreview.elements.length > 0) {
                this._actionPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    }
                });
            }
            // 兼容旧版单元素字段
            const el = this._actionPreview.el;
            if (el) {
                el.style.removeProperty('display');
            }
            this._actionPreview = { active: false, el: null, elements: [] };
            // 隐藏预览横幅
            this._hidePreviewBanner();
            // 恢复显示后必须重新挂上红框：预览时元素 display:none 不可见无需移除类，
            // 恢复后若不还原 pro-blocker-selected，用户将看不到当前选定元素（红框消失 bug 根因）
            if (this.currentSelectedEl && this._isElementInDOM(this.currentSelectedEl)) {
                this.currentSelectedEl.classList.add('pro-blocker-selected');
            }
            const btn = panel.querySelector('#btn-preview');
            if (btn) btn.textContent = '🔍 预览效果';
        }

        // 应用预览隐藏：严格复刻封杀后的实际效果（Bug2&5）
        // domainBlock 的 CSS 同时隐藏「资源元素本身 [src*=domain]」与「其直接父级 *:has(>...)」，
        // pathPattern 的 CSS 同样隐藏元素 + 直接父级，外加手动隐藏广告容器。
        // scanAndBlockDynamic 还会调用 findSingleChildWrapper(el,4) 隐藏单子链容器——
        // 该容器可能上溯至包含正常内容的高层节点，预览必须补齐此步，使预览=刷新后实际效果。
        _applyActionPreviewHiding() {
            const el = this.currentSelectedEl;
            if (!el || !this._isElementInDOM(el)) return;
            const store = this._actionPreview.elements;
            // 1) 选中域名命中的全页资源（元素 + 父级 + 单子链容器）
            this._previewHideDomainResources(this._actionHosts || [], store);
            // 2) 路径模式：与封杀时自动提取的 pathCandidates 同口径
            const result = BlockEngine.extractResourceDomains(el, { deep: true });
            const pathCandidates = new Set();
            result.urls.forEach(u => {
                try {
                    if (u.startsWith('//') || u.startsWith('http')) return;
                    if (u.startsWith('/') && u.length > 5) {
                        const pathOnly = u.split('?')[0].split('#')[0];
                        const segs = pathOnly.split('/').filter(Boolean);
                        if (segs.length >= 2) pathCandidates.add('/' + segs.slice(0, 3).join('/'));
                    }
                } catch (err) { }
            });
            pathCandidates.forEach(p => {
                const esc = escapeCSSAttr(p);
                const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                try {
                    document.querySelectorAll(sel).forEach(target => this._previewHideResourceAndWrappers(target, store));
                } catch (e) { }
            });
            // 3) 当前框选的广告容器（正式封杀也会手动隐藏容器）
            this._previewHideNode(BlockEngine.findSingleChildWrapper(el, 4), store);
        }

        // 实时更新预览：域名选择变化时，先还原已隐藏元素，再基于当前选择重新应用（Bug2）
        _updateActionPreview() {
            if (!this._actionPreview.active) return;
            // 还原当前预览隐藏的元素（保留 active=true）
            if (Array.isArray(this._actionPreview.elements) && this._actionPreview.elements.length > 0) {
                this._actionPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    }
                });
            }
            this._actionPreview.elements = [];
            // 重新应用隐藏
            this._applyActionPreviewHiding();
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
            // 域名选择状态：元素切换时重置为「全选」（默认推荐封杀全部检测到的域名，用户可逐个取消）
            if (!this._actionHosts || this._actionHostsEl !== el) {
                this._actionHosts = new Set(resourceResult.domains);
                this._actionHostsEl = el;
            } else {
                // 同一元素：仅移除已不存在的域名（元素资源集合变化兜底），绝不自动补回——
                // 否则会把用户刚手动取消选中的域名重新加回来（问题1根因：点击 pill 无效果）
                const current = new Set(resourceResult.domains);
                Array.from(this._actionHosts).forEach(h => { if (!current.has(h)) this._actionHosts.delete(h); });
            }
            if (domainBox) {
                if (resourceResult.domains.length > 0) {
                    domainBox.innerHTML = '<span class="info-label">🔍 发现第三方资源域（点击可取消选择，仅封杀选中项）：</span>' +
                        resourceResult.domains.map(d => {
                            const checked = this._actionHosts.has(d);
                            return `<span class="domain-item${checked ? '' : ' unselected'}" data-host="${escapeHTML(d)}">${checked ? '✓ ' : ''}${escapeHTML(d)}</span>`;
                        }).join('');
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
                const total = resourceResult.domains.length;
                const sel = this._actionHosts.size;
                if (total > 0) {
                    btnDomain.disabled = sel === 0;
                    btnDomain.textContent = `🔥 彻底封杀 ${sel}/${total} 个广告域名（推荐）`;
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
            this._actionPreview = { active: false, el: null, elements: [] };
            // 域名选择状态：默认全选检测到的域名，用户可在面板内逐个取消（解决问题1：原版只能全量封杀）
            this._actionHosts = null;
            this._actionHostsEl = null;

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
            // 智能定位：面板出现在选中元素附近，避免居中遮住目标元素影响预览
            this._positionPanelNearElement(panel, element);

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
                if (!primaryClass) { this.showToast('当前元素无有效类名，请选择其他拦截方式。', 'warning'); return; }
                storage.addRule('dynamic', { className: primaryClass, type: 'dynamic' });
                this.clearPanel();
            });

            // 物理结构拦截：基于元素位置路径生成选择器，作为 Selector 失效时的兜底定位
            panel.querySelector('#btn-struct').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const sel = BlockEngine.generateStructuralSelector(el);
                storage.addRule('structural', { structSelector: sel, type: 'structural' });
                this.clearPanel();
            });

            // 域名选择切换：点击域名 pill 可取消/恢复选中，仅封杀选中项（解决问题1）
            panel.querySelector('#info-domains').addEventListener('click', (e) => {
                const item = e.target.closest('.domain-item');
                if (!item || !this._actionHosts) return;
                const host = item.dataset.host;
                if (!host) return;
                if (this._actionHosts.has(host)) this._actionHosts.delete(host);
                else this._actionHosts.add(host);
                // 预览激活时实时更新，无需重置再手动预览（Bug2）
                this._updateActionPreview();
                this._refreshSelectionInfo(panel);
            });

            // 彻底封杀域名（核心：解决刷新复活）— 仅封杀用户选中的域名，与预览保持一致（解决问题2）
            panel.querySelector('#btn-domain').addEventListener('click', () => {
                if (!this._isElementInDOM(this.currentSelectedEl)) {
                    this.showToast('目标元素已从页面移除，请重新选择。', 'warning');
                    this.clearPanel();
                    return;
                }
                const result = BlockEngine.extractResourceDomains(this.currentSelectedEl, { deep: true });
                if (result.domains.length === 0) {
                    this.showToast('当前框选范围内未发现第三方资源域，无法执行域名封杀。', 'warning');
                    return;
                }
                const list = Array.from(this._actionHosts || []);
                if (list.length === 0) {
                    this.showToast('已取消全部域名选择，请至少保留一个域名再封杀。', 'warning');
                    return;
                }
                const confirmMsg = `将封杀以下 ${list.length} 个域名（全局生效，所有页面都将拦截）：\n\n${list.join('\n')}\n\n同时会隐藏当前框选的整个广告容器。确认继续？`;
                this.showConfirm('封杀域名确认', confirmMsg, () => {
                    // 封杀前先还原预览隐藏的元素，避免预览状态残留与正式封杀叠加
                    this._resetActionPreview(panel);

                    list.forEach(d => {
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
                    if (container) {
                        container.style.setProperty('display', 'none', 'important');
                        container.style.setProperty('opacity', '0', 'important');
                    }

                    // 扫描全页命中选中域名的资源：隐藏元素本身 + 直接父级 + 单子链容器
                    // 口径与 applyCSSRules（[src*=domain] 与 *:has(>...)）+ scanAndBlockDynamic
                    // （findSingleChildWrapper）完全一致，确保 即时效果=预览=刷新后效果
                    const hideNodeInline = (node) => {
                        if (!node || node === document.body || node === document.documentElement) return;
                        // 统一保护：脚本自身 UI 宿主跳过，避免封杀域名时隐藏面板
                        if (UIManager.isProtectedElement(node)) return;
                        node.style.setProperty('display', 'none', 'important');
                        node.style.setProperty('opacity', '0', 'important');
                    };
                    list.forEach(d => {
                        const esc = escapeCSSAttr(d);
                        const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`;
                        document.querySelectorAll(sel).forEach(target => {
                            hideNodeInline(target);
                            if (target.parentElement) hideNodeInline(target.parentElement);
                            const wrapper = BlockEngine.findSingleChildWrapper(target, 4);
                            hideNodeInline(wrapper);
                        });
                    });

                    const pathNote = pathCandidates.size > 0 ? '，并记录 ' + pathCandidates.size + ' 条路径模式' : '';
                    this.clearPanel();
                    this.showToast(`已封杀 ${list.length} 个域名${pathNote}，后续刷新与所有页面都将自动拦截。`, 'success');
                });
            });

            // 预览效果：必须与「彻底封杀」后的实际效果完全一致——
            // domainBlock 的 CSS 同时隐藏「资源元素本身 [src*=domain]」与「其直接父级 *:has(>...)」，
            // pathPattern 的 CSS 同样隐藏元素 + 直接父级，外加手动隐藏广告容器。
            // 旧预览只隐藏 findSingleChildWrapper（口径不一致）→ 预览看到的与刷新后实际不符，
            // 正常元素被一并屏蔽却未在预览体现（问题1.1根因）。此处严格按 CSS 口径预览。
            // 激活后选择变化自动实时更新预览（Bug1&2），再次点击关闭预览
            panel.querySelector('#btn-preview').addEventListener('click', (e) => {
                if (this._actionPreview.active) {
                    this._resetActionPreview(panel);
                    return;
                }
                const el = this.currentSelectedEl;
                if (!this._isElementInDOM(el)) {
                    this.showToast('目标元素已从页面移除，请重新选择。', 'warning');
                    this.clearPanel();
                    return;
                }
                this._actionPreview = { active: true, el: null, elements: [] };
                this._applyActionPreviewHiding();
                // 显示预览横幅，关闭时还原
                this._showPreviewBanner(() => this._resetActionPreview(panel));
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

            // 双引擎采集：BlockEngine.extractResourceDomains（DOM 资源来源）+ GlobalDomainScanner（6通道+12维+博彩色情）
            // 合并策略：按 hostname 合并，分数取较高者，附加 viceToken/adToken/level 标记
            // 过滤策略：已在域名黑名单中的域名不再展示（Bug3）
            const blockedDomainSet = new Set(storage.getDomainBlocks().map(r => r.domain));
            const { scoredDomains = [] } = BlockEngine.extractResourceDomains(document.documentElement, { deep: true });
            let gdsResult = { results: [], elapsed: '0', total: 0 };
            try { gdsResult = GlobalDomainScanner.scan(); } catch (e) { }
            const gdsMap = new Map();
            for (const r of (gdsResult.results || [])) gdsMap.set(r.hostname, r);

            // 合并：existing scoredDomains 为基线，叠加 GDS 的 12 维评分与博彩色情标记，过滤已封杀域名
            let allDomains = scoredDomains.filter(d => !blockedDomainSet.has(d.host)).map(d => {
                const g = gdsMap.get(d.host);
                if (!g) return d;
                // 取较高分（GDS 12维更精细，但保留原有 sources/reasons）
                const mergedScore = Math.max(d.score, g.score);
                return {
                    ...d,
                    score: mergedScore,
                    viceToken: g.viceToken || null,
                    adToken: g.adToken || null,
                    level: g.level || null,
                    gdsReasons: g.reasons || [],
                    signals: g.signals || 0
                };
            });
            // 补充 GDS 独有域名（extractResourceDomains 未覆盖的 Performance API / 链接跳转目标），过滤已封杀
            for (const [host, g] of gdsMap) {
                if (blockedDomainSet.has(host)) continue;
                if (!allDomains.find(d => d.host === host)) {
                    allDomains.push({
                        host, score: g.score, count: g.freq || 1,
                        sources: ['performance-api'], reasons: g.reasons || [],
                        viceToken: g.viceToken || null, adToken: g.adToken || null,
                        level: g.level || null, gdsReasons: g.reasons || [], signals: g.signals || 0
                    });
                }
            }
            // 按分数降序，确保高分广告域置顶
            allDomains.sort((a, b) => b.score - a.score);

            let selectedHosts = new Set(allDomains.filter(d => d.score >= 35 || d.viceToken).map(d => d.host));
            let filterText = '';
            let onlyAds = true;

            const isAdLike = (d) => isAdKeywordHost(d.host) || d.score >= 40 || !!d.viceToken || !!d.adToken || d.level === 'ad' || d.level === 'suspect';

            const getScoreClass = (score) => score >= 50 ? 'high' : score >= 25 ? 'mid' : 'low';
            const sourceLabel = (src) => ({ 'attr': '属性', 'srcset': '响应图', 'inline-style': '内联样式', 'stylesheet': '样式表', 'data-attr': '数据属性', 'script-text': '脚本文本', 'script-var': '脚本变量', 'performance-api': '性能API', 'image-link': '图片链接', 'link': '跳转链接' }[src] || src);

            const renderDomains = () => {
                const box = panel.querySelector('#global-domains');
                const stats = panel.querySelector('#gd-stats');
                if (!box) return;

                const filtered = allDomains.filter(d => {
                    if (filterText && !d.host.includes(filterText)) return false;
                    if (onlyAds && !isAdLike(d)) return false;
                    return true;
                });

                if (stats) {
                    const viceCount = allDomains.filter(d => d.viceToken).length;
                    const adCount = allDomains.filter(d => d.level === 'ad').length;
                    stats.textContent = `共 ${allDomains.length} 个第三方域名 · 🚫博彩/色情 ${viceCount} · 广告级 ${adCount} · 已选 ${selectedHosts.size} · 显示 ${filtered.length}`;
                }

                if (filtered.length === 0) {
                    box.innerHTML = '<span class="info-label" style="color:#bbb;">未匹配到域名，请尝试取消“只看广告相关”或手动添加。</span>';
                } else {
                    box.innerHTML = filtered.map(d => {
                        const checked = selectedHosts.has(d.host);
                        // 博彩/色情标记（最高优先级）
                        const viceBadge = d.viceToken ? `<span class="tag" style="background:rgba(255,0,80,0.7);" title="博彩/色情词元：${escapeHTML(d.viceToken)}">🚫${escapeHTML(d.viceToken)}</span>` : '';
                        const adBadge = d.adToken ? `<span class="tag" style="background:rgba(255,149,0,0.55);">广告</span>` : '';
                        const levelBadge = d.level === 'ad' ? '<span class="tag" style="background:rgba(255,59,48,0.7);">广告级</span>'
                            : d.level === 'suspect' ? '<span class="tag" style="background:rgba(255,149,0,0.55);">可疑</span>'
                                : d.level === 'watch' ? '<span class="tag" style="background:rgba(120,144,156,0.5);">关注</span>' : '';
                        const reasons = (d.gdsReasons && d.gdsReasons.length) ? d.gdsReasons.slice(0, 3).join(', ')
                            : (d.reasons.length ? d.reasons.slice(0, 3).join(', ') : '');
                        const sources = d.sources.map(sourceLabel).join('、');
                        return `<div class="gd-domain-row ${checked ? 'selected' : ''}" data-host="${escapeHTML(d.host)}">
                            <div class="gd-left">
                                <div class="gd-check">${checked ? '✓' : ''}</div>
                                <div>
                                    <div class="gd-host">${escapeHTML(d.host)} ${viceBadge}${adBadge}${levelBadge}</div>
                                    <div class="gd-meta">来源：${sources}${reasons ? ' · ' + escapeHTML(reasons) : ''}</div>
                                </div>
                            </div>
                            <div class="gd-score ${getScoreClass(d.score)}">${d.score}</div>
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
                <h3 title="按住可拖动窗口">🌐 全局域名深度检索</h3>
                <p>双引擎采集：DOM 资源来源 + 6通道性能API + 12维特征评分 + 博彩/色情词库。红色🚫为博彩/色情域，建议优先封杀。</p>
                <div class="gd-toolbar">
                    <input type="text" id="gd-filter" placeholder="输入域名关键字过滤..." />
                    <label><input type="checkbox" id="gd-only-ads" checked /> 只看广告相关</label>
                    <button class="btn-outline" id="gd-select-all">全选</button>
                    <button class="btn-outline" id="gd-select-none">清空</button>
                </div>
                <div class="gd-stats" id="gd-stats"></div>
                <div class="gd-scroll-area" id="global-domains"></div>
                <div class="gd-manual">
                    <input type="text" id="gd-manual-input" placeholder="手动输入域名，例如：ads.example.com" />
                    <button class="btn-outline" id="gd-manual-add">+ 添加</button>
                </div>
                <div class="btn-group">
                    <button class="btn-danger" id="btn-block-global" style="flex:100%; font-weight:bold;">🔥 彻底封杀广告域名（推荐）</button>
                </div>
                <div class="section-divider"></div>
                <div class="btn-group">
                    <button class="btn-info" id="btn-deep-scan" title="运行双引擎联合扫描">🤖 深度扫描</button>
                    <button class="btn-warning" id="btn-preview-global">🔍 预览效果</button>
                    <button class="btn-outline" id="btn-cancel-global">取消</button>
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
                updateGlobalPreview();
                renderDomains();
            });

            panel.querySelector('#gd-filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); renderDomains(); });
            panel.querySelector('#gd-only-ads').addEventListener('change', (e) => { onlyAds = e.target.checked; renderDomains(); });
            panel.querySelector('#gd-select-all').addEventListener('click', () => {
                allDomains.forEach(d => selectedHosts.add(d.host));
                updateGlobalPreview();
                renderDomains();
            });
            panel.querySelector('#gd-select-none').addEventListener('click', () => {
                selectedHosts.clear();
                updateGlobalPreview();
                renderDomains();
            });
            panel.querySelector('#gd-manual-add').addEventListener('click', () => {
                const input = panel.querySelector('#gd-manual-input');
                const host = input.value.trim().toLowerCase();
                if (!host) return;
                // 拒绝添加已封杀域名：避免UI误导用户以为该域名未封杀（Bug1）
                const currentBlocked = new Set(storage.getDomainBlocks().map(r => r.domain));
                if (currentBlocked.has(host)) {
                    this.showToast(`域名 ${host} 已在黑名单中，无需重复添加。`, 'info');
                    input.value = '';
                    return;
                }
                if (!allDomains.find(d => d.host === host)) {
                    allDomains.push({ host, score: 99, sources: ['manual'], reasons: ['用户手动添加'], count: 1, viceToken: null, adToken: null, level: null, gdsReasons: [], signals: 0 });
                }
                selectedHosts.add(host);
                input.value = '';
                updateGlobalPreview();
                renderDomains();
            });

            // 深度扫描：运行双引擎联合扫描后刷新列表
            panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
                const btn = e.target;
                const origText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 扫描中...';
                setTimeout(() => {
                    try {
                        // 扫描后重新合并数据并刷新列表
                        const currentBlocked = new Set(storage.getDomainBlocks().map(r => r.domain));
                        allDomains = allDomains.filter(d => !currentBlocked.has(d.host));
                        const newGds = GlobalDomainScanner.scan();
                        const newMap = new Map();
                        for (const r of newGds.results) newMap.set(r.hostname, r);
                        for (const g of newMap.values()) {
                            if (currentBlocked.has(g.hostname)) continue;
                            const exist = allDomains.find(d => d.host === g.hostname);
                            if (exist) {
                                exist.score = Math.max(exist.score, g.score);
                                exist.viceToken = g.viceToken || exist.viceToken;
                                exist.adToken = g.adToken || exist.adToken;
                                exist.level = g.level || exist.level;
                                exist.gdsReasons = g.reasons || exist.gdsReasons;
                            } else {
                                allDomains.push({ host: g.hostname, score: g.score, count: g.freq || 1, sources: ['performance-api'], reasons: g.reasons || [], viceToken: g.viceToken, adToken: g.adToken, level: g.level, gdsReasons: g.reasons, signals: g.signals });
                            }
                        }
                        allDomains.sort((a, b) => b.score - a.score);
                        renderDomains();
                        btn.disabled = false;
                        btn.textContent = origText;
                        this.showToast('深度扫描完成，域名列表已刷新。', 'success');
                    } catch (err) {
                        btn.disabled = false;
                        btn.textContent = origText;
                        this.showToast('深度扫描失败：' + err.message, 'error');
                    }
                }, 50);
            });

            // 预览状态使用实例属性 this._globalPreview，clearPanel 可跨面板清理，避免预览元素残留
            // 实时联动模式：预览激活时选择变化自动更新预览（Bug2&5），预览口径与 applyCSSRules 完全一致
            const resetGlobalPreview = () => {
                if (!this._globalPreview.active) return;
                this._globalPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    }
                });
                this._globalPreview = { active: false, elements: [] };
                this._hidePreviewBanner();
                previewBtn.textContent = '🔍 预览效果';
            };
            // 实时更新预览：根据当前 selectedHosts 重新隐藏元素（Bug2&5）
            const updateGlobalPreview = () => {
                if (!this._globalPreview.active) return;
                // 先还原所有预览元素
                this._globalPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    }
                });
                this._globalPreview.elements = [];
                // 预览口径与 applyCSSRules 完全一致：
                // 1) CSS [src*=domain] 隐藏资源元素本身
                // 2) CSS *:has(> :is(...)) 隐藏直接父级
                // 3) scanAndBlockDynamic 隐藏 findSingleChildWrapper 单子链容器
                this._previewHideDomainResources(selectedHosts, this._globalPreview.elements);
            };
            const previewBtn = panel.querySelector('#btn-preview-global');
            previewBtn.addEventListener('click', () => {
                if (this._globalPreview.active) {
                    resetGlobalPreview();
                    return;
                }
                if (selectedHosts.size === 0) return;
                this._globalPreview = { active: true, elements: [] };
                updateGlobalPreview();
                this._showPreviewBanner(() => resetGlobalPreview());
                previewBtn.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-block-global').addEventListener('click', () => {
                if (selectedHosts.size === 0) return;
                const list = Array.from(selectedHosts);
                const confirmMsg = `将封杀以下 ${list.length} 个域名（全局生效，所有页面都将拦截）：\n\n${list.join('\n')}\n\n确认继续？`;
                this.showConfirm('封杀域名确认', confirmMsg, () => {
                    resetGlobalPreview();
                    list.forEach(d => storage.addRule('domainBlock', { domain: d, type: 'domainBlock' }));
                    list.forEach(d => {
                        const esc = escapeCSSAttr(d);
                        document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                            const t = BlockEngine.findSingleChildWrapper(el, 4);
                            // 统一保护：脚本自身 UI 宿主跳过，避免封杀域名时隐藏面板
                            if (UIManager.isProtectedElement(t)) return;
                            t.style.setProperty('display', 'none', 'important');
                            t.style.setProperty('opacity', '0', 'important');
                        });
                    });
                    this._globalPreview = { active: false, elements: [] };
                    this.clearPanel();
                    this.showToast(`已封杀 ${list.length} 个域名，后续刷新与所有页面都将自动拦截。`, 'success');
                });
            });

            panel.querySelector('#btn-cancel-global').addEventListener('click', () => {
                resetGlobalPreview();
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
                    this._hidePreviewBanner();
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
                    // 路径模式预览：与正式 pathPattern 拦截同口径
                    // 必须隐藏：元素本身 + 直接父级 + findSingleChildWrapper（Bug4 预览口径一致）
                    const text = panel.querySelector('#path-input').value.trim();
                    if (!text) { this.showToast('校验失败：请输入路径片段。', 'warning'); return; }
                    const esc = escapeCSSAttr(text);
                    const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [data-href*="${esc}"], [data-url*="${esc}"], [data-link*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`;
                    let hit = 0;
                    const hideNode = (node) => {
                        if (!node || node === document.body || node === document.documentElement) return false;
                        // 统一保护：脚本自身 UI 宿主跳过，避免预览隐藏面板
                        if (UIManager.isProtectedElement(node)) return false;
                        if (node.style.display === 'none') return false;
                        node.style.setProperty('display', 'none', 'important');
                        node.style.setProperty('opacity', '0', 'important');
                        this._previewAffectedElements.push({ el: node });
                        return true;
                    };
                    document.querySelectorAll(sel).forEach(el => {
                        let counted = false;
                        if (hideNode(el)) counted = true;
                        if (el.parentElement && hideNode(el.parentElement)) counted = true;
                        const wrapper = BlockEngine.findSingleChildWrapper(el, 4);
                        if (hideNode(wrapper)) counted = true;
                        if (counted) hit++;
                    });
                    if (hit === 0) { this.showToast('当前页面未匹配到含该路径片段的资源，预览为空。', 'info'); return; }
                    isPreviewing = true;
                    this._showPreviewBanner(() => resetPreview());
                    e.target.textContent = '👁 恢复显示';
                    return;
                }

                if (mode === 'attribute') {
                    const text = panel.querySelector('#attr-input').value.trim();
                    if (!text) { this.showToast('校验失败：请输入属性选择器。', 'warning'); return; }
                    // 预览口径与 applyCSSRules 完全一致：attribute 规则保存后直接注入 CSS 选择器，
                    // 无 level 向上遍历逻辑。预览也仅隐藏选择器命中的元素本身，确保预览=刷新后效果。
                    try {
                        document.querySelectorAll(text).forEach(el => {
                            if (el && el.style.display !== 'none') {
                                this._previewAffectedElements.push({ el });
                                el.style.setProperty('display', 'none', 'important');
                                el.style.setProperty('opacity', '0', 'important');
                            }
                        });
                    } catch (err) {
                        this.showToast('校验失败：属性选择器语法错误。', 'error');
                        return;
                    }
                    isPreviewing = true;
                    this._showPreviewBanner(() => resetPreview());
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
                        this.showToast('规则校验失败：请完整填写所有积木条件的值再进行预览。', 'warning');
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
                        this.showToast('规则校验失败：请输入有效的匹配内容再进行预览。', 'warning');
                        return;
                    }

                    let regexRule = text;
                    if (mode === 'contains') {
                        const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        regexRule = `.*${escapedText}.*`;
                    }

                    try {
                        const regex = new RegExp(regexRule, 'i');
                        // 与 applyRegexRules 保持一致：跳过 SCRIPT/STYLE/NOSCRIPT 内的文本，
                        // 否则预览会误隐藏 <script> 父级导致页面功能损坏，且与实际执行结果不一致
                        const textFilter = {
                            acceptNode(node) {
                                const tag = node.parentElement && node.parentElement.tagName;
                                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                                return NodeFilter.FILTER_ACCEPT;
                            }
                        };
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, textFilter, false);
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
                        this.showToast('规则校验失败：正则表达式存在语法错误。', 'error');
                        return;
                    }
                }

                isPreviewing = true;
                this._showPreviewBanner(() => resetPreview());
                e.target.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-save-regex').addEventListener('click', () => {
                const mode = modeSelect.value;

                if (mode === 'path') {
                    const text = panel.querySelector('#path-input').value.trim();
                    if (!text) { this.showToast('校验失败：请输入路径片段。', 'warning'); return; }
                    storage.addRule('pathPattern', { pattern: text, type: 'pathPattern' });
                    BlockEngine.applyCSSRules();
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    this.clearPanel();
                    return;
                }

                if (mode === 'attribute') {
                    const text = panel.querySelector('#attr-input').value.trim();
                    if (!text) { this.showToast('校验失败：请输入属性选择器。', 'warning'); return; }
                    try { document.querySelector(text); } catch (err) {
                        this.showToast('校验失败：属性选择器语法错误，请检查括号、引号是否匹配。', 'error');
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
                        this.showToast('校验失败：请完整填写所有积木条件的值。', 'warning');
                        return;
                    }

                    storage.addRule('complex', { logic, conditions, level, type: 'complex' });
                    BlockEngine.applyComplexRules();

                } else {
                    const text = panel.querySelector('#regex-input').value.trim();
                    if (!text) { this.showToast('校验失败：请输入有效的匹配内容。', 'warning'); return; }

                    let regexRule = text;
                    if (mode === 'contains') {
                        const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        regexRule = `.*${escapedText}.*`;
                    }
                    // 正则模式保存前校验语法，与预览路径一致；非法正则会被 applyRegexRules 静默丢弃
                    if (mode === 'regex') {
                        try { new RegExp(regexRule); }
                        catch (e) { this.showToast('校验失败：正则表达式语法错误。' + e.message, 'error'); return; }
                    }

                    storage.addRule('regex', { regex: regexRule, level: level, type: 'regex' });
                    BlockEngine.applyRegexRules();
                }

                this.clearPanel();
            });

            panel.querySelector('#btn-close-regex').addEventListener('click', () => this.clearPanel());
        }

        // 规则影响度评估：统计每条规则在当前页面命中的元素数，命中越多越疑似误杀
        // 仅评估本站规则 + 全局域名黑名单（其他站点规则不在当前页生效，评估无意义）
        // regex 规则用 TreeWalker 采样前 500 个文本节点，避免全页遍历开销过大
        evaluateRuleImpact() {
            const data = storage.getData();
            const impacts = []; // {type, index, score, count}

            // 1. static 规则：直接 querySelectorAll 计数
            (data.static || []).forEach((r, i) => {
                if (!r.selector) return;
                let count = 0;
                try { count = document.querySelectorAll(r.selector).length; } catch (e) { }
                impacts.push({ type: 'static', index: i, count, score: this._calcImpactScore(count) });
            });

            // 2. dynamic 规则：取首个类名 token 转属性选择器计数
            (data.dynamic || []).forEach((r, i) => {
                if (!r.className) return;
                const token = r.className.split(/\s+/).filter(Boolean)[0];
                if (!token) return;
                let count = 0;
                try { count = document.querySelectorAll(`[class*="${token}"]`).length; } catch (e) { }
                impacts.push({ type: 'dynamic', index: i, count, score: this._calcImpactScore(count) });
            });

            // 3. attribute 规则：直接使用 attrSelector 计数
            (data.attribute || []).forEach((r, i) => {
                if (!r.attrSelector) return;
                let count = 0;
                try { count = document.querySelectorAll(r.attrSelector).length; } catch (e) { }
                impacts.push({ type: 'attribute', index: i, count, score: this._calcImpactScore(count) });
            });

            // 4. regex 规则：TreeWalker 采样前 500 个文本节点（跳过 SCRIPT/STYLE/NOSCRIPT）
            (data.regex || []).forEach((r, i) => {
                if (!r.regex) return;
                let count = 0;
                try {
                    const regex = new RegExp(r.regex, 'i');
                    const textFilter = {
                        acceptNode(node) {
                            const tag = node.parentElement && node.parentElement.tagName;
                            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    };
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, textFilter, false);
                    let node, checked = 0;
                    while ((node = walker.nextNode()) && checked < 500) {
                        checked++;
                        if (regex.test(node.textContent || '')) count++;
                    }
                } catch (e) { }
                impacts.push({ type: 'regex', index: i, count, score: this._calcImpactScore(count) });
            });

            // 5. domainBlock 规则：按 src/href/data-src 属性匹配计数
            (data.domainBlock || []).forEach((r, i) => {
                if (!r.domain) return;
                const esc = r.domain.replace(/"/g, '\\"');
                const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"]`;
                let count = 0;
                try { count = document.querySelectorAll(sel).length; } catch (e) { }
                impacts.push({ type: 'domainBlock', index: i, count, score: this._calcImpactScore(count) });
            });

            // 6. pathPattern 规则：按 href/src 属性匹配计数
            (data.pathPattern || []).forEach((r, i) => {
                if (!r.pattern) return;
                const esc = r.pattern.replace(/"/g, '\\"');
                const sel = `[href*="${esc}"], [src*="${esc}"]`;
                let count = 0;
                try { count = document.querySelectorAll(sel).length; } catch (e) { }
                impacts.push({ type: 'pathPattern', index: i, count, score: this._calcImpactScore(count) });
            });

            // structural / complex 规则不评估：structural 选择器含 :nth-of-type 路径，
            // complex 无单一选择器，评估成本高且命中数参考价值低
            impacts.sort((a, b) => b.score - a.score);
            return impacts;
        }

        // 影响度评分：命中元素越多 = 影响越大 = 越可能是误杀
        // 0 命中=未生效（0分），1-2=精准命中（10分），3-5=略多（30分），
        // 6-15=可能误杀（60分），16-50=高度可疑（80分），>50=几乎确定误杀（100分）
        _calcImpactScore(count) {
            if (count === 0) return 0;
            if (count <= 2) return 10;
            if (count <= 5) return 30;
            if (count <= 15) return 60;
            if (count <= 50) return 80;
            return 100;
        }

        // 统一规则管理面板：合并「规则与防御管理」与「按网站查看所有规则」为单一透明玻璃面板（问题3）
        // 全局域名黑名单 + 本站规则 + 其他站点规则统一汇总，按最近过滤时间 _ts 倒序置顶，便于快速删除
        showManager() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';
            const data = storage.getData();

            // 防御策略状态
            const isManualPreemptive = data.config.mode === 'preemptive';
            const isFlashMarked = !!storage.flashList[storage.domain];
            const cleanCount = storage.getCleanLoadCount();
            let modeText, modeHint;
            if (isManualPreemptive) {
                modeText = '<span style="color:#ffb74d; font-weight:bold;">极速预判（手动开启）</span>';
                modeHint = '在 0/100/300/700/1500ms 多时序重扫，专治首屏闪现；观察无闪现后可切回智能自动。';
            } else if (isFlashMarked) {
                modeText = `<span style="color:#ff6f00; font-weight:bold;">极速预判（闪现自动启用）</span> · 自愈进度 ${cleanCount}/3`;
                modeHint = '检测到广告闪现已自动升级。连续 3 次干净加载后自动恢复智能自动，或手动重置。';
            } else {
                modeText = '<span style="color:#34c759; font-weight:bold;">智能自动</span>';
                modeHint = '由 MutationObserver 实时拦截动态广告，常规站点推荐。遇首屏闪现可手动切到极速预判。';
            }
            const flashStatus = isFlashMarked
                ? `<span style="color:red; font-weight:bold;">已记录闪现特征</span>（本次加载如无闪现，将计入自愈 ${cleanCount}/3）`
                : '<span style="color:#34c759; font-weight:bold;">运行良好</span>';
            const highlightColor = GM_getValue('config_highlight_color', '#FF3B30');

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">规则与防御管理 (${storage.domain})</h3>

                <div class="status-bar">
                    <div><strong>防御策略：</strong> ${modeText}</div>
                    <div style="font-size:11px; color:#999; margin:2px 0 6px;">${modeHint}</div>
                    <div><strong>系统评估：</strong> ${flashStatus}</div>
                    <div><strong>全局域名黑名单：</strong> 共 <span id="mgr-domain-count">${data.domainBlock.length}</span> 个域名（跨站点生效）</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.1);">
                        <div>🌐 <strong>网络拦截：</strong><span style="color:#4aa3ff;"> ${BlockEngine.stats.networkBlocks}</span> 次</div>
                        <div>🧩 <strong>DOM 屏蔽：</strong><span style="color:#34c759;"> ${BlockEngine.stats.domBlocks}</span> 个</div>
                        <div>⚡ <strong>匹配耗时：</strong><span style="color:#ffb74d;"> ${BlockEngine.stats.matchTimeMs.toFixed(2)}</span> ms</div>
                    </div>
                    <div style="font-size:10px; color:#888; margin-top:4px;">统计为本页本次会话累计，刷新后归零</div>
                </div>

                <div class="status-bar" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <label style="margin:0; font-size:12px; color:#ddd; white-space:nowrap;">🎨 高亮选框颜色：</label>
                    <input type="text" id="ui-highlight-color" value="${escapeHTML(highlightColor)}"
                           pattern="^#[0-9A-Fa-f]{6}$" maxlength="7" placeholder="#FF3B30"
                           style="width:90px; padding:4px 8px; font-family:monospace; text-transform:uppercase; background:rgba(0,0,0,0.25); color:#eee; border:1px solid rgba(255,255,255,0.2); border-radius:6px;" />
                    <span id="color-preview" style="display:inline-block; width:20px; height:20px; border-radius:4px; border:1px solid rgba(255,255,255,0.3); background:${escapeHTML(highlightColor)}; vertical-align:middle;"></span>
                    <span style="font-size:10px; color:#888;">输入 Hex 色值（如 #FF3B30）实时预览</span>
                </div>

                <div class="gd-toolbar">
                    <select id="mgr-scope-filter" style="flex:none; padding:6px 8px; background:rgba(0,0,0,0.25); color:#eee; border:1px solid rgba(255,255,255,0.2); border-radius:6px;">
                        <option value="all">全部范围</option>
                        <option value="global">域名黑名单</option>
                        <option value="current">本站规则</option>
                        <option value="other">其他站点</option>
                    </select>
                    <select id="mgr-type-filter" style="flex:none; padding:6px 8px; background:rgba(0,0,0,0.25); color:#eee; border:1px solid rgba(255,255,255,0.2); border-radius:6px;">
                        <option value="">全部类型</option>
                        <option value="domainBlock">域名</option>
                        <option value="static">静态</option>
                        <option value="dynamic">动态</option>
                        <option value="regex">正则</option>
                        <option value="attribute">属性</option>
                        <option value="structural">位置</option>
                        <option value="complex">积木</option>
                        <option value="pathPattern">路径</option>
                    </select>
                    <input type="text" id="mgr-filter" placeholder="输入域名或规则内容关键字过滤..." />
                    <button class="btn-warning" id="btn-impact-sort" style="flex:none; padding:6px 10px; font-size:12px;">📊 按影响度排序</button>
                    <button class="btn-outline" id="btn-batch" style="flex:none; padding:6px 10px; font-size:12px;">☑ 批量选择</button>
                    <button class="btn-danger" id="btn-batch-delete" style="flex:none; padding:6px 10px; font-size:12px; display:none;">🗑 删除选中(0)</button>
                </div>
                <div class="gd-stats" id="mgr-stats"></div>
                <div class="selection-info" style="max-height: 320px; overflow-y: auto; margin-bottom: 12px;">
                    <ul class="rule-list" id="mgr-list"></ul>
                </div>

                <div class="btn-group">
                    <button class="btn-info" id="btn-toggle-mode">🚀 切换防御策略</button>
                    <button class="btn-warning" id="btn-reset-flash" style="${isFlashMarked ? '' : 'display:none;'}">♻️ 重置闪现标记</button>
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

            // —— 统一记录构建：全局域名黑名单 + 本站 7 类 + 其他站点规则，按 _ts 倒序（最近置顶）——
            const formatRuleContent = (type, r) => {
                switch (type) {
                    case 'static': return escapeHTML(r.selector || '');
                    case 'dynamic': return `类名: ${escapeHTML(r.className || '')}`;
                    case 'regex': return `匹配: ${escapeHTML(r.regex || '')} (层级: ${r.level})`;
                    case 'attribute': return `选择器: ${escapeHTML(r.attrSelector || '')}`;
                    case 'structural': return escapeHTML(r.structSelector || '');
                    case 'pathPattern': return `模式: ${escapeHTML(r.pattern || '')}`;
                    case 'complex': {
                        const formatOp = (op) => op === 'contains' ? '包含' : (op === 'equals' ? '等于' : '不包含');
                        const formatType = (t) => t === 'text' ? '文本' : (t === 'class' ? '类名' : 'ID');
                        const condText = (r.conditions || []).map(c => `[${formatType(c.type)} ${formatOp(c.operator)} "${escapeHTML(c.value)}"]`).join(` <span style="color:#007AFF; font-weight:bold;">${escapeHTML(r.logic || 'AND')}</span> `);
                        return `${condText} (层级: ${r.level})`;
                    }
                    default: return '';
                }
            };
            const TYPE_META = {
                domainBlock: { label: '域名', tag: 'domain' },
                static: { label: '静态', tag: '' },
                dynamic: { label: '动态', tag: '' },
                regex: { label: '正则', tag: '' },
                attribute: { label: '属性', tag: 'attr' },
                structural: { label: '位置', tag: 'struct' },
                complex: { label: '积木', tag: 'complex' },
                pathPattern: { label: '路径', tag: 'path' }
            };
            const buildRecords = () => {
                const recs = [];
                const d = storage.getData();
                // 1. 全局域名黑名单（{domain,_ts}[]）
                d.domainBlock.forEach((r, i) => recs.push({
                    scope: 'global', domain: '(全局)', index: i, type: 'domainBlock',
                    content: escapeHTML(r.domain), ts: r._ts || 0, value: r.domain,
                    disabled: !!r._disabled
                }));
                // 2. 本站 7 类规则
                ['static', 'dynamic', 'regex', 'attribute', 'structural', 'complex', 'pathPattern'].forEach(type => {
                    (d[type] || []).forEach((r, i) => recs.push({
                        scope: 'current', domain: storage.domain, index: i, type,
                        content: formatRuleContent(type, r), ts: r._ts || 0,
                        value: (type === 'pathPattern') ? (r.pattern || '') : '',
                        disabled: !!r._disabled
                    }));
                });
                // 3. 其他站点规则（跨站，排除本站以免重复）
                storage.getAllSiteRules().forEach(rec => {
                    if (rec.domain === storage.domain) return;
                    recs.push({
                        scope: 'other', domain: rec.domain, index: rec.index, type: rec.type,
                        content: formatRuleContent(rec.type, rec.rule), ts: rec.rule._ts || 0,
                        value: (rec.type === 'pathPattern') ? (rec.rule.pattern || '') : '',
                        disabled: !!rec.rule._disabled
                    });
                });
                // 按 _ts 倒序：最近过滤的规则置顶（问题3&7）
                recs.sort((a, b) => b.ts - a.ts);
                return recs;
            };

            let filterScope = 'all';
            let filterType = '';
            let filterText = '';
            // 影响度排序模式：true 时按 impactScore 降序展示，高分规则红色标记便于排查误杀
            let impactMode = false;
            // 批量选择模式：true 时每条规则前显示复选框，支持一次性删除多条
            let batchMode = false;
            const batchSelected = new Set(); // key: `${scope}|${domain}|${type}|${index}`
            let records = buildRecords();

            const renderList = () => {
                const list = panel.querySelector('#mgr-list');
                const stats = panel.querySelector('#mgr-stats');
                const countEl = panel.querySelector('#mgr-domain-count');
                if (countEl) countEl.textContent = records.filter(r => r.scope === 'global').length;
                if (!list) return;
                // 影响度模式下按 impactScore 降序，让高风险（疑似误杀）规则置顶
                const displayRecords = impactMode
                    ? records.slice().sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0))
                    : records;
                const filtered = displayRecords.filter(rec => {
                    if (filterScope !== 'all' && rec.scope !== filterScope) return false;
                    if (filterType && rec.type !== filterType) return false;
                    if (filterText) {
                        const hay = (rec.domain + ' ' + (TYPE_META[rec.type] ? TYPE_META[rec.type].label : '') + ' ' + rec.content).toLowerCase();
                        if (!hay.includes(filterText)) return false;
                    }
                    return true;
                });
                if (stats) stats.textContent = impactMode
                    ? `共 ${records.length} 条 · 当前显示 ${filtered.length} 条（按影响度排序，⚠️ 标记为疑似误杀）`
                    : `共 ${records.length} 条 · 当前显示 ${filtered.length} 条（最近过滤置顶，点击删除即时生效）`;
                if (filtered.length === 0) {
                    list.innerHTML = '<li class="empty-tip">暂无规则。手动屏蔽元素或封杀域名后将显示在此处。</li>';
                    return;
                }
                list.innerHTML = filtered.map(rec => {
                    const meta = TYPE_META[rec.type] || { label: rec.type, tag: '' };
                    const siteBadge = rec.scope === 'current'
                        ? `<span class="as-site" style="background:rgba(52,199,89,0.3);">本站</span>`
                        : rec.scope === 'global'
                            ? `<span class="as-site" style="background:rgba(255,111,0,0.35);">全局</span>`
                            : `<span class="as-site" title="${escapeHTML(rec.domain)}">${escapeHTML(rec.domain)}</span>`;
                    // 影响度模式：score≥60 红色警告（高度疑似误杀），30-59 黄色提示
                    const impactBadge = impactMode && rec.impactScore >= 60
                        ? `<span class="tag" style="background:rgba(255,0,0,0.7);">⚠️影响${rec.impactScore}</span>`
                        : impactMode && rec.impactScore >= 30
                            ? `<span class="tag" style="background:rgba(255,159,10,0.7);">影响${rec.impactScore}</span>`
                            : '';
                    // 禁用规则：文字置灰 + 切换按钮显示"启用"，否则显示"禁用"
                    const disabledStyle = rec.disabled ? 'opacity:0.45; text-decoration:line-through;' : '';
                    const toggleLabel = rec.disabled ? '启用' : '禁用';
                    const toggleClass = rec.disabled ? 'btn-success' : 'btn-outline';
                    // 批量选择模式：每条规则前显示复选框，key 唯一标识一条规则用于批量删除
                    const recKey = `${rec.scope}|${rec.domain}|${rec.type}|${rec.index}`;
                    const batchBox = batchMode
                        ? `<input type="checkbox" class="batch-check" data-key="${escapeHTML(recKey)}" ${batchSelected.has(recKey) ? 'checked' : ''} style="flex:none; width:16px; height:16px; margin-right:8px; cursor:pointer; accent-color:#ff3b30;" />`
                        : '';
                    return `<li class="rule-item">
                        ${batchBox}
                        <div class="rule-content" style="${disabledStyle}">
                            ${siteBadge}<span class="tag ${meta.tag}">${meta.label}</span> ${rec.content} ${impactBadge}
                        </div>
                        <button class="${toggleClass} btn-toggle" style="flex:none; width:54px; padding: 6px; margin-right:6px;" data-scope="${rec.scope}" data-domain="${escapeHTML(rec.domain)}" data-type="${rec.type}" data-index="${rec.index}">${toggleLabel}</button>
                        <button class="btn-danger btn-delete" style="flex:none; width:60px; padding: 6px;" data-scope="${rec.scope}" data-domain="${escapeHTML(rec.domain)}" data-type="${rec.type}" data-index="${rec.index}" data-value="${escapeHTML(rec.value || '')}">删除</button>
                    </li>`;
                }).join('');
            };
            renderList();

            // 过滤器事件
            panel.querySelector('#mgr-scope-filter').addEventListener('change', (e) => { filterScope = e.target.value; renderList(); });
            panel.querySelector('#mgr-type-filter').addEventListener('change', (e) => { filterType = e.target.value; renderList(); });
            panel.querySelector('#mgr-filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); renderList(); });

            // 影响度排序：评估每条规则当前页面命中元素数，命中越多越疑似误杀
            // 切换为 toggle：首次点击进入影响度模式，再次点击恢复 _ts 倒序
            panel.querySelector('#btn-impact-sort').addEventListener('click', (e) => {
                if (!impactMode) {
                    const impacts = this.evaluateRuleImpact();
                    impactMode = true;
                    e.target.textContent = '↩ 恢复原排序';
                    e.target.classList.remove('btn-warning');
                    e.target.classList.add('btn-success');
                    // 建立 (type-index) → score 索引，注入到 records 上
                    const impactMap = new Map();
                    impacts.forEach(imp => impactMap.set(`${imp.type}-${imp.index}`, imp.score));
                    records = records.map(rec => ({
                        ...rec,
                        impactScore: impactMap.get(`${rec.type}-${rec.index}`) || 0
                    }));
                } else {
                    impactMode = false;
                    e.target.textContent = '📊 按影响度排序';
                    e.target.classList.remove('btn-success');
                    e.target.classList.add('btn-warning');
                    records = buildRecords(); // 恢复 _ts 倒序
                }
                renderList();
            });

            // 删除：事件委托，按归属调用对应删除 API，并还原内联隐藏 + 强制重扫确保即时生效（问题2&5）
            // 删除后仅重渲染列表（不重建面板），保留过滤态与滚动位置，连续删除无需重开面板（问题3）
            panel.querySelector('#mgr-list').addEventListener('click', (e) => {
                // 启用/禁用切换：调用 toggleRuleDisabled，引擎层会自动重新应用规则
                const toggleBtn = e.target.closest('.btn-toggle');
                if (toggleBtn) {
                    const scope = toggleBtn.getAttribute('data-scope');
                    const domain = toggleBtn.getAttribute('data-domain');
                    const type = toggleBtn.getAttribute('data-type');
                    const index = parseInt(toggleBtn.getAttribute('data-index'), 10);
                    // 跨站规则需传 domain，本站/全局用默认
                    const targetDomain = scope === 'other' ? domain : null;
                    const nowDisabled = storage.toggleRuleDisabled(type, index, targetDomain);
                    this.showToast(nowDisabled ? '规则已禁用' : '规则已启用', nowDisabled ? 'warning' : 'success');
                    records = buildRecords();
                    renderList();
                    return;
                }
                const btn = e.target.closest('.btn-delete');
                if (!btn) return;
                const scope = btn.getAttribute('data-scope');
                const domain = btn.getAttribute('data-domain');
                const type = btn.getAttribute('data-type');
                const index = parseInt(btn.getAttribute('data-index'), 10);
                const value = btn.getAttribute('data-value') || '';
                const scrollBox = panel.querySelector('#mgr-list').parentElement;
                const savedScroll = scrollBox ? scrollBox.scrollTop : 0;

                // 删除前捕获完整规则对象，供撤销恢复使用
                let capturedRule = null;
                if (scope === 'global') {
                    capturedRule = storage.getDomainBlocks()[index];
                } else if (scope === 'current') {
                    capturedRule = storage.getData()[type][index];
                } else {
                    const siteRec = storage.getAllSiteRules().find(r => r.domain === domain && r.type === type && r.index === index);
                    capturedRule = siteRec ? siteRec.rule : null;
                }

                if (scope === 'global') {
                    // 域名黑名单：先还原该域名的内联隐藏，再删除规则，最后强制重扫应用剩余规则
                    BlockEngine.restoreInlineForDomain(value);
                    storage.removeRule('domainBlock', index);
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                } else if (scope === 'current') {
                    storage.removeRule(type, index);
                    // restoreAllInlineStyles 清除所有内联隐藏（含 regex/complex/pathPattern/domainBlock），
                    // 必须重新应用所有基于内联样式的拦截，否则其他类型规则的隐藏会丢失
                    BlockEngine.restoreAllInlineStyles();
                    BlockEngine.applyCSSRules();
                    BlockEngine.applyRegexRules();
                    BlockEngine.applyComplexRules();
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                } else {
                    // 跨站规则：同上，需重新应用所有内联拦截
                    storage.removeRuleForDomain(domain, type, index);
                    BlockEngine.restoreAllInlineStyles();
                    BlockEngine.applyCSSRules();
                    BlockEngine.applyRegexRules();
                    BlockEngine.applyComplexRules();
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                }
                // 推入撤销栈并显示带撤销按钮的 Toast（5s 内可恢复）
                if (capturedRule) {
                    this._pushUndo({ type, domain, scope, rule: { ...capturedRule } });
                    this.showToast('已删除规则', 'warning', 5000, () => {
                        this._performUndo();
                        records = buildRecords();
                        renderList();
                    });
                }
                records = buildRecords();
                renderList();
                requestAnimationFrame(() => { if (scrollBox) scrollBox.scrollTop = savedScroll; });
            });

            // ===== 批量删除功能 =====
            // 批量选择 toggle：切换批量模式，退出时清空已选集合
            panel.querySelector('#btn-batch').addEventListener('click', (e) => {
                batchMode = !batchMode;
                if (!batchMode) batchSelected.clear();
                e.target.textContent = batchMode ? '↩ 退出批量' : '☑ 批量选择';
                e.target.classList.toggle('btn-success', batchMode);
                e.target.classList.toggle('btn-outline', !batchMode);
                const delBtn = panel.querySelector('#btn-batch-delete');
                if (delBtn) {
                    delBtn.style.display = batchMode ? '' : 'none';
                    delBtn.textContent = `🗑 删除选中(${batchSelected.size})`;
                }
                renderList();
            });

            // 复选框变化：同步 batchSelected 集合并更新删除按钮计数
            panel.querySelector('#mgr-list').addEventListener('change', (e) => {
                if (!e.target.classList.contains('batch-check')) return;
                const key = e.target.getAttribute('data-key');
                if (e.target.checked) batchSelected.add(key);
                else batchSelected.delete(key);
                const delBtn = panel.querySelector('#btn-batch-delete');
                if (delBtn) delBtn.textContent = `🗑 删除选中(${batchSelected.size})`;
            });

            // 批量删除：按 (scope|domain|type) 分组，索引降序逐条删除避免错位；
            // 删除前捕获完整规则对象，整体推入撤销栈（一次撤销恢复全部）
            panel.querySelector('#btn-batch-delete').addEventListener('click', () => {
                if (batchSelected.size === 0) { this.showToast('未选中任何规则', 'info'); return; }
                const count = batchSelected.size;
                this.showConfirm('批量删除确认', `确认删除选中的 ${count} 条规则？\n\n此操作可通过 Toast 撤销按钮一次性恢复（5 次操作内）。`, () => {
                    // 解析选中 key → 删除任务列表
                    const tasks = [];
                    batchSelected.forEach(key => {
                        const parts = key.split('|');
                        // key 格式：scope|domain|type|index，domain 可能含 | 已用 escapeHTML 转义，此处 domain 为存储域名为安全字符
                        if (parts.length < 4) return;
                        const scope = parts[0];
                        const domain = parts[1];
                        const type = parts[2];
                        const index = parseInt(parts[3], 10);
                        if (isNaN(index)) return;
                        tasks.push({ scope, domain, type, index });
                    });
                    // 捕获待删规则快照（用于撤销恢复）
                    const captured = [];
                    tasks.forEach(t => {
                        let rule = null;
                        let value = '';
                        if (t.scope === 'global') {
                            rule = storage.getDomainBlocks()[t.index];
                            value = rule ? rule.domain : '';
                        } else if (t.scope === 'current') {
                            rule = storage.getData()[t.type] && storage.getData()[t.type][t.index];
                        } else {
                            const siteRec = storage.getAllSiteRules().find(r => r.domain === t.domain && r.type === t.type && r.index === t.index);
                            rule = siteRec ? siteRec.rule : null;
                        }
                        if (rule) captured.push({ scope: t.scope, domain: t.domain, type: t.type, rule: { ...rule }, value });
                    });
                    // 全局域名：先逐个还原内联隐藏（removeRule 前调用，避免规则已删无法定位）
                    tasks.filter(t => t.scope === 'global').forEach(t => {
                        const r = storage.getDomainBlocks()[t.index];
                        if (r) BlockEngine.restoreInlineForDomain(r.domain);
                    });
                    // 按 (scope|domain|type) 分组，组内索引降序删除，保证低索引不受高索引删除影响
                    const groups = new Map();
                    tasks.forEach(t => {
                        const gk = `${t.scope}|${t.domain}|${t.type}`;
                        if (!groups.has(gk)) groups.set(gk, []);
                        groups.get(gk).push(t);
                    });
                    groups.forEach(groupTasks => {
                        groupTasks.sort((a, b) => b.index - a.index);
                        groupTasks.forEach(t => {
                            if (t.scope === 'global') storage.removeRule('domainBlock', t.index);
                            else if (t.scope === 'current') storage.removeRule(t.type, t.index);
                            else storage.removeRuleForDomain(t.domain, t.type, t.index);
                        });
                    });
                    // 删除后统一重新应用所有拦截规则
                    BlockEngine.restoreAllInlineStyles();
                    BlockEngine.applyCSSRules();
                    BlockEngine.applyRegexRules();
                    BlockEngine.applyComplexRules();
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    // 推入批量撤销条目（一次撤销恢复全部）
                    if (captured.length > 0) {
                        this._pushUndo({ batch: true, rules: captured });
                        this.showToast(`已批量删除 ${captured.length} 条规则`, 'warning', 5000, () => {
                            this._performUndo();
                            records = buildRecords();
                            renderList();
                        });
                    }
                    batchSelected.clear();
                    batchMode = false;
                    const batchBtn = panel.querySelector('#btn-batch');
                    if (batchBtn) {
                        batchBtn.textContent = '☑ 批量选择';
                        batchBtn.classList.toggle('btn-success', false);
                        batchBtn.classList.toggle('btn-outline', true);
                    }
                    const delBtn = panel.querySelector('#btn-batch-delete');
                    if (delBtn) delBtn.style.display = 'none';
                    records = buildRecords();
                    renderList();
                });
            });

            // 高亮颜色 Hex 输入：实时校验、预览并持久化
            const colorInput = panel.querySelector('#ui-highlight-color');
            const colorPreview = panel.querySelector('#color-preview');
            if (colorInput) {
                colorInput.addEventListener('input', (e) => {
                    const val = e.target.value.trim();
                    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                        document.documentElement.style.setProperty('--pro-blocker-highlight-color', val);
                        if (colorPreview) colorPreview.style.background = val;
                        GM_setValue('config_highlight_color', val);
                    }
                });
            }

            panel.querySelector('#btn-toggle-mode').addEventListener('click', () => {
                const newMode = storage.toggleMode();
                this.showToast(`策略已调整为：${newMode === 'preemptive' ? '极速预判模式' : '智能自动模式'}，页面即将刷新。`, 'info', 2000);
                setTimeout(() => window.location.reload(), 1500);
            });

            const resetBtn = panel.querySelector('#btn-reset-flash');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    this.showConfirm('清除闪现标记', '确认清除本站的闪现标记？清除后将恢复"智能自动"模式（除非你手动开启极速预判）。', () => {
                        storage.resetFlash();
                        this.showToast('闪现标记已清除，页面即将刷新。', 'success', 2000);
                        setTimeout(() => window.location.reload(), 1500);
                    });
                });
            }

            panel.querySelector('#btn-export').addEventListener('click', () => this.showExportPanel());
            panel.querySelector('#btn-import').addEventListener('click', () => this.showImportPanel());
            panel.querySelector('#btn-ag-export').addEventListener('click', () => this.showAdGuardExportPanel());

            panel.querySelector('#btn-clear-all').addEventListener('click', () => {
                this.showConfirm('清除本站规则', '警告：此操作将清空【当前域名】下的所有拦截规则和配置（不影响全局域名黑名单）。确认继续？', () => {
                    storage.clearDomain();
                    window.location.reload();
                });
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
                    this.showToast('已复制到剪贴板！', 'success');
                } catch (e) {
                    ta.select();
                    try { document.execCommand('copy'); this.showToast('已复制到剪贴板！', 'success'); }
                    catch (e2) { this.showToast('复制失败，请手动选中文本复制。', 'error'); }
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
            // v2.0 格式：sites 按域名分组 + domains 纯字符串数组
            // v1.0 格式：blocks/dynamicBlocks 等平铺字典 + domainBlocks {domain,_ts}[]
            const isV2 = raw.sites && typeof raw.sites === 'object';
            const BUCKET_TO_TYPE = {
                'static': 'static', 'dynamic': 'dynamic', 'regex': 'regex',
                'attribute': 'attribute', 'structural': 'structural',
                'complex': 'complex', 'pathPattern': 'pathPattern'
            };
            const allDomains = new Set(isV2 ? Object.keys(raw.sites) : []);
            let ruleBuckets;
            if (isV2) {
                // v2.0：从 sites 提取各桶，补全 type 字段供 convertRule 使用
                ruleBuckets = {};
                for (const bucket in BUCKET_TO_TYPE) {
                    ruleBuckets[bucket] = {};
                    for (const domain in raw.sites) {
                        const arr = raw.sites[domain][bucket];
                        if (Array.isArray(arr) && arr.length > 0) {
                            ruleBuckets[bucket][domain] = arr.map(r => ({ ...r, type: BUCKET_TO_TYPE[bucket] }));
                        }
                    }
                }
            } else {
                // v1.0 兼容：直接用平铺字典
                ruleBuckets = {
                    blocks: raw.blocks || {},
                    dynamicBlocks: raw.dynamicBlocks || {},
                    regexBlocks: raw.regexBlocks || {},
                    attrBlocks: raw.attrBlocks || {},
                    structBlocks: raw.structBlocks || {},
                    complexBlocks: raw.complexBlocks || {},
                    pathPatternBlocks: raw.pathPatternBlocks || {}
                };
                Object.keys(ruleBuckets).forEach(k => {
                    Object.keys(ruleBuckets[k]).forEach(d => allDomains.add(d));
                });
            }
            // 校验域名：非空、无空白、长度合理
            const isValidDomain = (d) => typeof d === 'string' && d.length > 0 && d.length < 200 && !/\s/.test(d);
            // 全局域名黑名单：v2.0 为 string[]，v1.0 为 {domain,_ts}[]，统一提取 domain 字符串
            const rawDomains = isV2 ? (raw.domains || []) : (raw.domainBlocks || []);
            const globalDomains = (Array.isArray(rawDomains) ? rawDomains : [])
                .map(r => (r && typeof r === 'object') ? r.domain : r)
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
                        // 与脚本内 CSS 注入保持一致：同时隐藏资源元素及其直接父容器（解决横幅空白）
                        // :has() 属于 AdGuard 扩展 CSS，需用 #?# 标记
                        // 用 :is() 包裹逗号选择器组，确保 > 对每项生效，避免后代匹配过度隐藏
                        const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                        return `${domain}##${sel}\n${domain}#?#*:has(> :is(${sel}))`;
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
                                if (c.operator === 'equals') pseudoParts.push(`:has-text(/^\\s*${escapeRegexLiteral(c.value)}\\s*$/)`);
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
                                    if (c.operator === 'equals') return `${domain}#?#*:has-text(/^\\s*${escapeRegexLiteral(c.value)}\\s*$/)`;
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
                // v2.0 用桶名（static/dynamic/...），v1.0 用存储键名（blocks/dynamicBlocks/...）
                // 两种格式统一通过 Object.values 遍历所有桶，按域名提取规则
                const rules = [];
                for (const bucket in ruleBuckets) {
                    const arr = ruleBuckets[bucket][domain];
                    if (Array.isArray(arr)) rules.push(...arr);
                }
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

            let rulesText = this.generateAdGuardRules();

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">🛡️ 导出 AdGuard 规则</h3>
                <p class="hint-text">已将当前所有拦截规则转换为 AdGuard / uBlock Origin 兼容语法。元素隐藏规则 (## / #?#) 可导入 AdGuard 浏览器扩展或 uBlock Origin；全局域名拦截段含 DNS 兼容版 (||domain^)，可导入 AdGuard DNS / AdGuard Home。</p>
                <textarea class="export-box" id="ag-export-box" readonly></textarea>
                <div class="btn-group">
                    <button class="btn-primary" id="btn-ag-copy">📋 复制全部</button>
                    <button class="btn-success" id="btn-ag-download">💾 下载 txt</button>
                    <button class="btn-outline" id="btn-ag-back">返回</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);

            const box = panel.querySelector('#ag-export-box');
            box.value = rulesText;

            panel.querySelector('#btn-ag-copy').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(rulesText);
                    this.showToast('AdGuard 规则已复制到剪贴板！', 'success');
                } catch (e) {
                    box.select();
                    try { document.execCommand('copy'); this.showToast('AdGuard 规则已复制到剪贴板！', 'success'); }
                    catch (e2) { this.showToast('复制失败，请手动选中文本复制。', 'error'); }
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

        /**
         * 不可见覆盖层广告扫描面板：列出所有透明/隐藏的可跳转 overlay，支持逐项拦截与批量拦截
         * 解决"触碰到就跳转但看不见"的广告问题
         */
        showOverlayScanPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            // 双引擎采集：BlockEngine.scanInvisibleOverlays（透明跳转覆盖层）+ OverlayAdScanner（不可见/覆盖层/博彩色情图片/追踪像素）
            // 合并策略：按元素引用合并，BlockEngine 提供触发URL/跨域/尺寸，OverlayAdScanner 提供嫌疑分/分类/特征/原因
            // 过滤策略：已封杀域名 / 已被脚本隐藏 / 已匹配现有规则的元素不再重复展示
            const collectAll = async () => {
                const blockedDomains = new Set(storage.getDomainBlocks().map(r => r.domain));
                // 异步时间分片扫描：避免大型页面 5000+ 候选导致主线程卡顿
                const beRecords = await BlockEngine.scanInvisibleOverlaysAsync({ autoBlock: false });
                let oasResult = { results: [], elapsed: '0', total: 0 };
                try { oasResult = OverlayAdScanner.scan(); } catch (e) { }
                // 以元素引用为 key 建立 OverlayAdScanner 特征索引
                const oasMap = new Map();
                for (const r of (oasResult.results || [])) {
                    if (r.el) oasMap.set(r.el, r);
                }

                // 判定元素是否已被封杀（域名已在黑名单 / 元素已被脚本隐藏 / 元素匹配现有规则）
                const isAlreadyBlocked = (rec) => {
                    if (!rec.el) return true;
                    // 脚本自身 UI 永远视为已处理（不展示在扫描结果中）
                    if (UIManager.isProtectedElement(rec.el)) return true;
                    // 元素已从 DOM 移除（被脚本 remove() 或被父级移除）
                    if (!document.contains(rec.el)) return true;
                    if (rec.triggerUrl) {
                        try {
                            const h = new URL(rec.triggerUrl, location.href).hostname;
                            if (blockedDomains.has(h)) return true;
                        } catch (e) { }
                    }
                    // 内联隐藏（脚本封杀后打的内联样式）：扩展 visibility/opacity/pointer-events 的 important 检查
                    if (rec.el.style) {
                        const s = rec.el.style;
                        if (s.display === 'none') return true;
                        if (s.visibility === 'hidden' && s.getPropertyPriority('visibility') === 'important') return true;
                        if (s.opacity === '0' && s.getPropertyPriority('opacity') === 'important') return true;
                        if (s.pointerEvents === 'none' && s.getPropertyPriority('pointer-events') === 'important') return true;
                    }
                    // CSS 规则隐藏：OAS 独有结果未经过 BlockEngine 的 getComputedStyle 过滤
                    // 通过计算样式检查，避免已封杀的元素再次出现在扫描列表
                    // 新增：父级隐藏检查——自身可见但被父级 display:none / visibility:hidden 隐藏
                    if (document.contains(rec.el)) {
                        try {
                            const cs = window.getComputedStyle(rec.el);
                            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return true;
                            let parent = rec.el.parentElement;
                            while (parent && parent !== document.body) {
                                const pcs = window.getComputedStyle(parent);
                                if (pcs.display === 'none' || pcs.visibility === 'hidden') return true;
                                parent = parent.parentElement;
                            }
                        } catch (e) { }
                    }
                    // 检查元素是否匹配现有的静态/属性规则（确保持久化拦截的元素不再展示）
                    if (rec.el) {
                        try {
                            const data = storage.getData();
                            // 静态选择器规则
                            for (const r of (data.static || [])) {
                                if (r.selector && rec.el.matches && rec.el.matches(r.selector)) return true;
                            }
                            // 属性选择器规则
                            for (const r of (data.attribute || [])) {
                                if (r.attrSelector && rec.el.matches && rec.el.matches(r.attrSelector)) return true;
                            }
                            // 动态类名规则
                            if (typeof rec.el.className === 'string') {
                                for (const r of (data.dynamic || [])) {
                                    if (r.className && rec.el.classList.contains(r.className)) return true;
                                }
                            }
                        } catch (e) { }
                    }
                    return false;
                };

                // ① BlockEngine 记录为基线，叠加 OAS 的嫌疑分/分类/特征
                const merged = beRecords.map(rec => {
                    const oas = rec.el ? oasMap.get(rec.el) : null;
                    if (!oas) return rec;
                    return {
                        ...rec,
                        suspicion: oas.suspicion || 0,
                        category: oas.category || 'unknown',
                        oasReasons: oas.reasons || [],
                        features: oas.features || {},
                        selector: oas.selector || '',
                        // 高嫌疑分也算高风险（补充 BlockEngine 仅按面积判定 highRisk 的不足）
                        highRisk: rec.highRisk || (oas.suspicion >= 50)
                    };
                }).filter(r => !isAlreadyBlocked(r));
                // ② 补充 OAS 独有结果（BlockEngine 未覆盖的不可见元素/博彩色情图片/追踪像素）
                for (const oas of (oasResult.results || [])) {
                    if (!oas.el || beRecords.find(r => r.el === oas.el)) continue;
                    const rect = oas.el.getBoundingClientRect ? oas.el.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
                    const rec = {
                        el: oas.el,
                        tagName: oas.el.tagName,
                        id: oas.el.id || '',
                        className: typeof oas.el.className === 'string' ? oas.el.className.slice(0, 80) : '',
                        opacity: parseFloat(window.getComputedStyle(oas.el).opacity) || 1,
                        visibility: window.getComputedStyle(oas.el).visibility,
                        position: window.getComputedStyle(oas.el).position,
                        rect: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
                        triggerUrl: oas.features?.externalLink || '',
                        hasOnClick: !!oas.features?.clickable,
                        hasIframeChild: !!oas.features?.hasEmbed,
                        crossDomain: !!oas.features?.externalLink,
                        highRisk: oas.suspicion >= 50,
                        suspicion: oas.suspicion || 0,
                        category: oas.category || 'unknown',
                        oasReasons: oas.reasons || [],
                        features: oas.features || {},
                        selector: oas.selector || ''
                    };
                    if (!isAlreadyBlocked(rec)) merged.push(rec);
                }
                // 按嫌疑分降序，高分置顶
                merged.sort((a, b) => (b.suspicion || 0) - (a.suspicion || 0));
                return { records: merged, oasElapsed: oasResult.elapsed };
            };

            // 异步初始加载：扫描在空闲帧分片执行，先显示加载态再渲染结果
            let records = [];
            let oasElapsed = '0';
            let selectedSet = new Set();
            let onlyHigh = false;
            // 占位渲染，待异步扫描完成后 render() 重绘
            const listEl0 = panel.querySelector('#overlay-list');
            if (listEl0) listEl0.innerHTML = '<li class="empty-tip">⏳ 正在扫描覆盖层...</li>';
            (async () => {
                try {
                    const collected = await collectAll();
                    records = collected.records;
                    oasElapsed = collected.oasElapsed;
                    selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
                    render();
                } catch (e) {
                    console.error('[Pro Blocker] 覆盖层扫描失败:', e);
                    this.showToast('扫描失败：' + e.message, 'error');
                }
            })();

            const categoryLabel = (cat) => ({
                'invisible': '不可见',
                'overlay': '覆盖层',
                'tracking': '追踪像素',
                'vice-image': '🚫博彩色情图'
            }[cat] || '可疑');
            const categoryColor = (cat) => ({
                'invisible': 'rgba(120,144,156,0.65)',
                'overlay': 'rgba(255,59,48,0.65)',
                'tracking': 'rgba(255,149,0,0.65)',
                'vice-image': 'rgba(255,0,80,0.75)'
            }[cat] || 'rgba(255,149,0,0.5)');
            const getScoreClass = (s) => s >= 50 ? 'high' : s >= 25 ? 'mid' : 'low';

            const render = () => {
                const box = panel.querySelector('#overlay-list');
                const stats = panel.querySelector('#overlay-stats');
                if (!box) return;

                const filtered = onlyHigh ? records.map((r, i) => ({ r, i })).filter(({ r }) => r.highRisk) : records.map((r, i) => ({ r, i }));

                if (stats) {
                    const blockedCount = records.filter(r => r.blocked).length;
                    const viceCount = records.filter(r => r.category === 'vice-image').length;
                    const invisibleCount = records.filter(r => r.category === 'invisible').length;
                    const overlayCount = records.filter(r => r.category === 'overlay').length;
                    stats.textContent = `共 ${records.length} 项 · 🚫博彩色情 ${viceCount} · 覆盖层 ${overlayCount} · 不可见 ${invisibleCount} · 已拦截 ${blockedCount} · 选中 ${selectedSet.size}`;
                }

                if (filtered.length === 0) {
                    box.innerHTML = '<span class="info-label" style="color:#bbb;">未发现不可见覆盖层广告。可尝试取消"只看高风险"或使用"深度扫描"。</span>';
                    const btnBlock = panel.querySelector('#btn-block-overlay');
                    if (btnBlock) btnBlock.disabled = true;
                    return;
                }

                box.innerHTML = filtered.map(({ r, i }) => {
                    const checked = selectedSet.has(i);
                    const catLabel = categoryLabel(r.category);
                    const catColor = categoryColor(r.category);
                    const catBadge = `<span class="tag" style="background:${catColor};">${catLabel}</span>`;
                    const riskBadge = r.highRisk ? '<span class="tag" style="background:rgba(255,59,48,0.7);">高风险</span>' : '';
                    const blockedBadge = r.blocked ? '<span class="tag" style="background:rgba(52,199,89,0.6);">已拦截</span>' : '';
                    const viceBadge = r.features?.viceTarget ? `<span class="tag" style="background:rgba(255,0,80,0.75);">🚫${escapeHTML(r.features.viceTarget)}</span>` : '';
                    const reasons = (r.oasReasons && r.oasReasons.length) ? r.oasReasons.slice(0, 3).join(' · ') : '';
                    const trigger = r.triggerUrl ? escapeHTML(r.triggerUrl.length > 80 ? r.triggerUrl.slice(0, 80) + '...' : r.triggerUrl) : (r.hasOnClick ? 'onclick' : '—');
                    const selector = r.selector ? `<div class="gd-meta">选择器：${escapeHTML(r.selector)}</div>` : '';
                    const cls = r.className ? `<div class="gd-meta">class: ${escapeHTML(r.className)}</div>` : '';
                    const suspicion = r.suspicion || 0;
                    return `<div class="gd-domain-row ${checked ? 'selected' : ''}" data-idx="${i}">
                        <div class="gd-left">
                            <div class="gd-check">${checked ? '✓' : ''}</div>
                            <div>
                                <div class="gd-host">${catBadge}${riskBadge}${blockedBadge}${viceBadge} ${escapeHTML(r.tagName)} ${r.id ? '#' + escapeHTML(r.id) : ''} · ${r.rect.w}×${r.rect.h}px</div>
                                <div class="gd-meta">${reasons ? escapeHTML(reasons) : ''}${reasons ? ' · ' : ''}触发：${trigger}${r.crossDomain ? ' · 跨域' : ''}</div>
                                ${selector}${cls}
                            </div>
                        </div>
                        <div class="gd-score ${getScoreClass(suspicion)}">${suspicion}</div>
                    </div>`;
                }).join('');

                const btnBlock = panel.querySelector('#btn-block-overlay');
                if (btnBlock) {
                    btnBlock.disabled = selectedSet.size === 0;
                    btnBlock.textContent = selectedSet.size > 0
                        ? `🛡️ 拦截选中的 ${selectedSet.size} 个覆盖层`
                        : '🛡️ 未选择覆盖层';
                }
            };

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">👁 不可见覆盖层扫描</h3>
                <p>双引擎检测：透明跳转覆盖层 + 不可见元素 + 高z-index覆盖层 + 1×1追踪像素 + 博彩/色情可点击图片。红色🚫为博彩/色情图片，建议优先拦截。</p>
                <div class="gd-toolbar">
                    <label><input type="checkbox" id="ov-only-high" /> 只看高风险</label>
                    <button class="btn-outline" id="ov-select-high">选中高风险</button>
                    <button class="btn-outline" id="ov-select-none">清空</button>
                </div>
                <div class="gd-stats" id="overlay-stats"></div>
                <div class="gd-scroll-area" id="overlay-list"></div>
                <label style="display:flex; align-items:center; gap:6px; margin:8px 0; font-size:12px; color:#ddd; cursor:pointer;">
                    <input type="checkbox" id="ov-block-domain" checked style="cursor:pointer;" />
                    <span>同时封杀跳转域名（加入全局黑名单，并预览/拦截全页该域资源）</span>
                </label>
                <div class="btn-group">
                    <button class="btn-danger" id="btn-block-overlay" style="flex:100%; font-weight:bold;">🛡️ 拦截选中的覆盖层</button>
                </div>
                <div class="section-divider"></div>
                <div class="btn-group">
                    <button class="btn-info" id="btn-deep-scan" title="运行双引擎联合扫描">🤖 深度扫描</button>
                    <button class="btn-warning" id="btn-preview-overlay">🔍 预览效果</button>
                    <button class="btn-warning" id="btn-rescan">🔄 重新扫描</button>
                    <button class="btn-outline" id="btn-close-overlay">关闭</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);
            render();

            // 预览状态：实例属性，clearPanel 切换/关闭面板时兜底还原，避免预览隐藏的元素永久残留
            // 实时联动模式：预览激活时，选择变化自动更新预览（隐藏新增选中 / 还原取消选中），无需手动重置
            this._overlayPreview = { active: false, elements: [], hiddenDomains: new Set() };
            const resetOverlayPreview = () => {
                if (!this._overlayPreview.active) return;
                this._overlayPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                        el.style.removeProperty('visibility');
                        el.style.removeProperty('pointer-events');
                    }
                });
                this._overlayPreview = { active: false, elements: [], hiddenDomains: new Set() };
                this._hidePreviewBanner();
                previewBtn.textContent = '🔍 预览效果';
            };
            const previewBtn = panel.querySelector('#btn-preview-overlay');

            // 实时更新预览：根据当前 selectedSet 和域名勾选状态，增量隐藏/还原元素
            const updatePreview = () => {
                if (!this._overlayPreview.active) return;
                // ① 先还原所有预览元素
                this._overlayPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                        el.style.removeProperty('visibility');
                        el.style.removeProperty('pointer-events');
                    }
                });
                this._overlayPreview.elements = [];
                this._overlayPreview.hiddenDomains = new Set();
                const blockDomainToo = panel.querySelector('#ov-block-domain').checked;
                // ② 重新隐藏当前选中的覆盖层
                Array.from(selectedSet).forEach(idx => {
                    const r = records[idx];
                    if (!r || !r.el || !document.contains(r.el)) return;
                    // 统一保护：脚本自身 UI 宿主（含 Shadow DOM 内部）跳过
                    if (UIManager.isProtectedElement(r.el)) return;
                    if (r.el.style.display !== 'none') {
                        r.el.style.setProperty('display', 'none', 'important');
                        r.el.style.setProperty('pointer-events', 'none', 'important');
                        r.el.style.setProperty('visibility', 'hidden', 'important');
                        this._overlayPreview.elements.push(r.el);
                    }
                    if (blockDomainToo && r.triggerUrl) {
                        try {
                            const u = new URL(r.triggerUrl, location.href);
                            if (u.hostname !== window.location.hostname) this._overlayPreview.hiddenDomains.add(u.hostname);
                        } catch (e) { }
                    }
                });
                // ③ 勾选域名时，同步预览全页该域名资源的隐藏效果（与正式拦截同口径）
                // 必须隐藏：元素本身 + 直接父级 + findSingleChildWrapper（Bug4 预览口径一致）
                this._previewHideDomainResources(this._overlayPreview.hiddenDomains, this._overlayPreview.elements);
            };

            panel.querySelector('#overlay-list').addEventListener('click', (e) => {
                const row = e.target.closest('.gd-domain-row');
                if (!row) return;
                const idx = parseInt(row.dataset.idx, 10);
                if (selectedSet.has(idx)) selectedSet.delete(idx);
                else selectedSet.add(idx);
                // 预览激活时实时更新，无需手动重置再预览（Bug2）
                updatePreview();
                render();
            });

            panel.querySelector('#ov-only-high').addEventListener('change', (e) => { onlyHigh = e.target.checked; render(); });
            panel.querySelector('#ov-select-high').addEventListener('click', () => {
                records.forEach((r, i) => { if (r.highRisk) selectedSet.add(i); });
                updatePreview();
                render();
            });
            panel.querySelector('#ov-select-none').addEventListener('click', () => {
                selectedSet.clear();
                updatePreview();
                render();
            });


            // 预览效果：预览「隐藏选中覆盖层 + 勾选域名时全页该域资源也被隐藏」，与正式拦截效果一致
            // 激活后选择变化自动实时更新预览（Bug1&2），再次点击关闭预览
            previewBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止事件冒泡触发其他监听器
                if (this._overlayPreview.active) {
                    resetOverlayPreview();
                    return;
                }
                if (selectedSet.size === 0) {
                    this.showToast('请先选择需要预览的覆盖层。', 'warning');
                    return;
                }
                this._overlayPreview = { active: true, elements: [], hiddenDomains: new Set() };
                try {
                    updatePreview();
                } catch (err) {
                    console.error('[Pro Blocker] 覆盖层预览失败:', err);
                    this._overlayPreview.active = false;
                    this.showToast('预览失败：' + err.message, 'error');
                    return;
                }
                this._showPreviewBanner(() => resetOverlayPreview());
                previewBtn.textContent = '👁 恢复显示';
            });

            // 域名勾选变化时实时更新预览
            panel.querySelector('#ov-block-domain').addEventListener('change', () => updatePreview());

            panel.querySelector('#btn-block-overlay').addEventListener('click', () => {
                if (selectedSet.size === 0) return;
                const blockDomainToo = panel.querySelector('#ov-block-domain').checked;
                // 正式拦截前先还原预览，避免预览态与正式拦截叠加造成状态混乱
                resetOverlayPreview();
                let domainCount = 0;
                let ruleCount = 0;
                let skippedSelfUI = 0;
                // 仅修改 record 属性不删除数组元素，无需降序遍历；直接 forEach
                Array.from(selectedSet).forEach(idx => {
                    const r = records[idx];
                    if (!r || !r.el || !document.contains(r.el)) return;
                    // 统一保护：脚本自身 UI 宿主（含 Shadow DOM 内部）绝不拦截，否则所有面板都会消失
                    if (UIManager.isProtectedElement(r.el)) {
                        skippedSelfUI++;
                        return;
                    }
                    r.el.style.setProperty('display', 'none', 'important');
                    r.el.style.setProperty('pointer-events', 'none', 'important');
                    r.el.style.setProperty('visibility', 'hidden', 'important');
                    r.blocked = true;
                    // 自动生成持久化规则：基于元素特征生成属性选择器，确保刷新后仍能拦截
                    try {
                        const el = r.el;
                        const tag = el.tagName.toLowerCase();
                        let attrSelector = null;
                        // 优先用 id 生成属性规则（唯一性最强）
                        if (el.id) {
                            attrSelector = `${tag}[id="${CSS.escape(el.id)}"]`;
                        } else if (typeof el.className === 'string' && el.className.trim()) {
                            // 用第一个有辨识度的 class 生成属性规则
                            const classes = el.className.trim().split(/\s+/).filter(c => c.length >= 3);
                            if (classes.length > 0) {
                                attrSelector = `${tag}[class*="${CSS.escape(classes[0])}"]`;
                            }
                        }
                        if (attrSelector) {
                            storage.addRule('attribute', { attrSelector, type: 'attribute' });
                            ruleCount++;
                        }
                    } catch (e) { }
                    // 仅在勾选「封杀域名」时加入全局黑名单
                    if (blockDomainToo && r.triggerUrl) {
                        try {
                            const u = new URL(r.triggerUrl, location.href);
                            if (u.hostname !== window.location.hostname) {
                                storage.addRule('domainBlock', { domain: u.hostname, type: 'domainBlock' });
                                domainCount++;
                            }
                        } catch (e) { }
                    }
                });
                selectedSet.clear();
                render();
                const domainNote = blockDomainToo ? `，${domainCount} 个跨域跳转域名已加入全局黑名单` : '（未封杀域名）';
                const ruleNote = ruleCount > 0 ? `，已生成 ${ruleCount} 条持久化规则` : '';
                const skipNote = skippedSelfUI > 0 ? `（跳过 ${skippedSelfUI} 个脚本自身元素）` : '';
                this.showToast(`已拦截选中的覆盖层${domainNote}${ruleNote}${skipNote}`, 'success');
            });

            // 深度扫描：运行双引擎联合扫描后重新采集，补充 Performance API / 跳转目标等隐藏资源
            panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
                const btn = e.target;
                const origText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 扫描中...';
                (async () => {
                    try {
                        resetOverlayPreview();
                        // 强制重新运行双引擎扫描
                        try { OverlayAdScanner.scan(); } catch (e) { }
                        const collected = await collectAll();
                        records = collected.records;
                        selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
                        render();
                        this.showToast(`深度扫描完成，发现 ${records.length} 个可疑覆盖层。`, 'success');
                    } catch (err) {
                        this.showToast('深度扫描失败：' + err.message, 'error');
                    } finally {
                        btn.disabled = false;
                        btn.textContent = origText;
                    }
                })();
            });

            panel.querySelector('#btn-rescan').addEventListener('click', () => {
                resetOverlayPreview();
                (async () => {
                    const collected = await collectAll();
                    records = collected.records;
                    selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
                    updatePreview();
                    render();
                })();
            });

            panel.querySelector('#btn-close-overlay').addEventListener('click', () => this.clearPanel());
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
                if (!text) { this.showToast('请粘贴规则 JSON 文本。', 'warning'); return; }
                const mode = panel.querySelector('#import-mode').value;
                const doImport = () => {
                    try {
                        storage.importAll(text, mode === 'merge');
                        this.showToast('导入成功！页面即将刷新以应用规则。', 'success', 2000);
                        setTimeout(() => window.location.reload(), 1500);
                    } catch (e) {
                        this.showToast('导入失败：' + e.message, 'error');
                    }
                };
                // 覆盖模式需用户确认（confirm 已从 importAll 移出）
                if (mode === 'replace') {
                    this.showConfirm('覆盖导入确认', '覆盖导入将清除现有所有规则，确定继续？', doImport);
                } else {
                    doImport();
                }
            });

            panel.querySelector('#btn-back').addEventListener('click', () => this.showManager());
        }

        clearPanel() {
            if (this._actionPreview && this._actionPreview.active) {
                // 还原域名预览隐藏的全部元素（新版预览可能隐藏多个容器）
                if (Array.isArray(this._actionPreview.elements)) {
                    this._actionPreview.elements.forEach(el => {
                        if (el) {
                            el.style.removeProperty('display');
                            el.style.removeProperty('opacity');
                        }
                    });
                }
                const el = this._actionPreview.el;
                if (el) {
                    el.style.removeProperty('display');
                }
                this._actionPreview = { active: false, el: null, elements: [] };
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
            // 全局域名面板预览：跨面板切换时恢复被预览隐藏的元素，修复局部变量无法清理的泄漏
            if (this._globalPreview && this._globalPreview.active) {
                this._globalPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                    }
                });
                this._globalPreview = { active: false, elements: [] };
            }
            // 覆盖层扫描面板预览：还原 visibility/pointer-events/display/opacity，避免预览元素残留
            if (this._overlayPreview && this._overlayPreview.active) {
                this._overlayPreview.elements.forEach(el => {
                    if (el) {
                        el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                        el.style.removeProperty('visibility');
                        el.style.removeProperty('pointer-events');
                    }
                });
                this._overlayPreview = { active: false, elements: [] };
            }
            // 切换/关闭面板时停止选择模式，避免 _handleClick 残留导致 panel 内点击被拦截
            this.stopSelection();
            this._clearSelectionHighlight();
            // 清理预览模式横幅（若激活）
            this._hidePreviewBanner();

            const oldPanel = this.shadowRoot.querySelector('.panel');
            if (oldPanel && typeof oldPanel._cleanupDrag === 'function') {
                oldPanel._cleanupDrag();
            }
            // 保留 Toast/横幅等瞬时元素，仅移除面板与确认弹窗
            this.shadowRoot.querySelectorAll('.panel, .pro-confirm-overlay').forEach(el => {
                if (typeof el._cleanupDrag === 'function') el._cleanupDrag();
                el.remove();
            });
        }
    }

    // ================= 初始化与执行流 =================

    // 网络层拦截须最先执行：在页面任何 fetch/XHR/script 加载前完成 hook，确保广告请求被源头丢弃
    NetworkInterceptor.init();
    // 跳转拦截（window.open/location/form）：补充 NetworkInterceptor 未覆盖的导航型广告
    try {
        const _blockedDomains = storage.getDomainBlocks().map(r => r.domain);
        OverlayAdScanner.enableNavigationInterceptor(_blockedDomains);
    } catch (e) { }
    // Shadow DOM 穿透须在页面脚本调用 attachShadow 前完成代理
    BlockEngine.hookAttachShadow();
    BlockEngine.fastInject();
    BlockEngine.startObserver();

    if (window.self === window.top) {
        let uiInstance = null;
        function getUI() {
            if (!uiInstance) uiInstance = new UIManager();
            return uiInstance;
        }

        GM_registerMenuCommand('🖱 手动选择屏蔽元素', () => getUI()._safeCall('选择模式', () => getUI().startSelection()));
        GM_registerMenuCommand('📝 添加文本/正则/积木/属性/路径规则', () => getUI()._safeCall('规则面板', () => getUI().showRegexPanel(), () => getUI().showRegexPanel()));
        GM_registerMenuCommand('🌐 全局检索域名', () => getUI()._safeCall('域名检索', () => getUI().showGlobalDomainPanel(), () => getUI().showGlobalDomainPanel()));
        GM_registerMenuCommand('👁 扫描不可见覆盖层广告', () => getUI()._safeCall('覆盖层扫描', () => getUI().showOverlayScanPanel(), () => getUI().showOverlayScanPanel()));
        GM_registerMenuCommand('⚙️ 管理规则与防御策略', () => getUI()._safeCall('管理面板', () => getUI().showManager(), () => getUI().showManager()));
        GM_registerMenuCommand('📤 导出规则（跨设备迁移）', () => getUI()._safeCall('导出面板', () => getUI().showExportPanel(), () => getUI().showExportPanel()));
        GM_registerMenuCommand('🛡️ 导出 AdGuard 规则', () => getUI()._safeCall('AdGuard 导出', () => getUI().showAdGuardExportPanel(), () => getUI().showAdGuardExportPanel()));
        GM_registerMenuCommand('📥 导入规则', () => getUI()._safeCall('导入面板', () => getUI().showImportPanel(), () => getUI().showImportPanel()));
    }

})();
