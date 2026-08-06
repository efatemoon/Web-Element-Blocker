// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      0.2.22
// @description  集成原生CSS极速注入、Shadow DOM隔离、DOM结构拦截、广告域封杀、正则文本拦截、动态资源域实时拦截、路径模式拦截与规则导入导出。支持积木组合模式、元素层级缩放选择与全局域名黑名单，彻底解决广告刷新复活。新增三算法协同系统：全局域名深度检索（6通道12维评分）、不可见覆盖层专攻（博彩/色情图片检测）、智能自学习泛化引擎（置信度追踪+自动衰减）。
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
    // 检测 hostname 是否含广告关键词：按非字母数字分词后逐 token 查 Set
    const isAdKeywordHost = (hostname) => {
        if (!hostname || typeof hostname !== 'string') return false;
        const tokens = hostname.toLowerCase().split(/[^a-z0-9-]/);
        for (let i = 0; i < tokens.length; i++) {
            if (AD_KEYWORD_SET.has(tokens[i])) return true;
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
            // 正常路径采集：Set 镜像做 O(1) 去重，批量缓冲减少 95% 落盘频率
            this._normalPathSets = {};   // site -> Set<path>，内存去重镜像
            this._normalPathsBuffer = []; // 批量缓冲，满 20 条统一落盘
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
            // 先刷新正常路径缓冲，确保批量数据进入待写队列
            this._flushNormalPaths();
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
            if (type === 'pathPattern') AutoGeneralizer.schedule(); // 路径模式变更 → 触发路径轨重新泛化
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
                    AutoGeneralizer.schedule(); // 域名黑名单变更 → 触发双轨重新泛化
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
                    AutoGeneralizer.schedule(); // 域名黑名单变更 → 触发双轨重新泛化
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
            if (type === 'pathPattern') AutoGeneralizer.schedule(); // 跨站删除路径规则 → 重新泛化
            return true;
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

        // ================= 自动化泛化规则 CRUD =================
        // 泛化规则不区分网站（由全局域名黑名单与全站路径模式推导而来），
        // 独立存储于 generalizedRules 键：{ domain:[], path:[], fused:[] }

        getGeneralized() {
            const data = this._readKey('generalizedRules', null);
            if (!data || typeof data !== 'object') return { domain: [], path: [], fused: [] };
            return {
                domain: Array.isArray(data.domain) ? data.domain : [],
                path: Array.isArray(data.path) ? data.path : [],
                fused: Array.isArray(data.fused) ? data.fused : []
            };
        }

        setGeneralized(data) {
            const normalized = {
                domain: Array.isArray(data?.domain) ? data.domain : [],
                path: Array.isArray(data?.path) ? data.path : [],
                fused: Array.isArray(data?.fused) ? data.fused : []
            };
            this._markDirty('generalizedRules', normalized);
            BlockEngine.invalidateCache(); // 泛化规则变更后重建匹配缓存
        }

        // 删除单条泛化规则：type ∈ {'domain','path','fused'}，index 为数组下标
        removeGeneralizedRule(type, index) {
            if (!['domain', 'path', 'fused'].includes(type)) return;
            const data = this.getGeneralized();
            if (index >= 0 && index < data[type].length) {
                data[type].splice(index, 1);
                this._markDirty('generalizedRules', data);
                BlockEngine.invalidateCache();
                // 触发重新泛化：面板说明承诺"规则增删后会自动重新泛化"（Bug1.3）
                AutoGeneralizer.schedule();
            }
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
            AutoGeneralizer.schedule(); // 清除本域路径规则 → 重新泛化
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

            // 正常路径采集数据：泛化引擎误杀检测的参照样本，跨设备迁移时需一并导出
            // 否则新设备泛化引擎缺少正常路径参照，无法评估误杀风险
            const rawNormalPaths = this._readKey('normalPaths', {});
            const normalPaths = {};
            for (const site in rawNormalPaths) {
                if (Array.isArray(rawNormalPaths[site]) && rawNormalPaths[site].length > 0) {
                    normalPaths[site] = rawNormalPaths[site];
                }
            }

            // GeneralizationEngine 自学习规则：跨设备迁移时需一并导出
            // 否则新设备丢失已学习的置信度追踪数据，泛化引擎需从零重新学习
            let geRules = null;
            try {
                const snap = GeneralizationEngine.getRulesSnapshot();
                const totalCount = Object.values(snap).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
                if (totalCount > 0) geRules = snap;
            } catch(e){}

            const exportData = {
                meta: {
                    version: '2.0',
                    exportedAt: new Date().toISOString(),
                    scriptVersion: GM_info && GM_info.script && GM_info.script.version || 'unknown',
                    counts: {
                        domains: domains.length,
                        siteRules: totalRules,
                        sites: Object.keys(sites).length,
                        geRules: geRules ? Object.values(geRules).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0) : 0
                    }
                },
                domains,
                sites,
                config,
                flashDomains,
                normalPaths,
                geRules
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
            if (!merge && !confirm('覆盖导入将清除现有所有规则，确定继续？')) return false;

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
                // normalPaths: v2.0 为 { site: [path, ...] }，合并到现有存储并更新 Set 镜像
                // 泛化引擎依赖正常路径做误杀检测，跨设备迁移必须保留
                if (importData.normalPaths && typeof importData.normalPaths === 'object') {
                    if (merge) {
                        // 合并模式：叠加去重
                        const existing = this._readKey('normalPaths', {});
                        for (const site in importData.normalPaths) {
                            if (!Array.isArray(importData.normalPaths[site])) continue;
                            if (!existing[site]) existing[site] = [];
                            if (!this._normalPathSets[site]) {
                                this._normalPathSets[site] = new Set(existing[site]);
                            }
                            const pathSet = this._normalPathSets[site];
                            for (const path of importData.normalPaths[site]) {
                                if (!pathSet.has(path)) {
                                    pathSet.add(path);
                                    existing[site].push(path);
                                }
                            }
                            if (existing[site].length > 200) {
                                const removed = existing[site].splice(0, existing[site].length - 200);
                                for (const r of removed) pathSet.delete(r);
                            }
                        }
                        this._markDirty('normalPaths', existing);
                    } else {
                        // 覆盖模式：导入数据成为新状态，重置 Set 镜像（Bug5.1&5.2）
                        const incoming = {};
                        for (const site in importData.normalPaths) {
                            if (Array.isArray(importData.normalPaths[site])) {
                                incoming[site] = importData.normalPaths[site].slice(-200);
                            }
                        }
                        this._normalPathSets = {}; // 清空 Set 镜像，下次访问时按新数据重建
                        this._markDirty('normalPaths', incoming);
                    }
                } else if (!merge) {
                    // 覆盖模式且导入数据无 normalPaths：清空现有（Bug5.2）
                    this._normalPathSets = {};
                    this._markDirty('normalPaths', {});
                }
                // GeneralizationEngine 自学习规则：v2.0 字段
                // 跨设备迁移必须保留置信度追踪数据，否则新设备需从零重新学习
                if (importData.geRules && typeof importData.geRules === 'object') {
                    try {
                        if (!merge) GeneralizationEngine.clearRules(); // 覆盖模式先清空（Bug5.3）
                        GeneralizationEngine.mergeRules(importData.geRules);
                    } catch(e){}
                } else if (!merge) {
                    // 覆盖模式且导入数据无 geRules：清空现有
                    try { GeneralizationEngine.clearRules(); } catch(e){}
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
            // 自动化泛化规则不再导入：由导入的域名/路径规则经 AutoGeneralizer.run() 自动重新派生，
            // 避免不同环境泛化结果失真（与导出端一致，解决问题4）
            // 覆盖模式下先清空旧泛化规则，确保 run() 从干净状态重新派生（Bug5.4）
            if (!merge) {
                this._markDirty('generalizedRules', {});
            }
            BlockEngine.invalidateCache();
            this.invalidateDataCache();
            BlockEngine.applyCSSRules();
            BlockEngine.applyRegexRules();
            BlockEngine.applyComplexRules();
            // 导入后触发重新泛化，合并新规则并刷新匹配缓存
            // 用同步 run() 而非防抖 schedule()：showImportPanel 紧随 alert+reload，
            // 防抖定时器会被导航取消导致重新泛化永不执行；同步执行后由 beforeunload 落盘
            AutoGeneralizer.run();
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

        // ================= 正常路径采集（供泛化引擎误杀检测） =================
        // 记录未被拦截的请求路径，作为该站点的"正常路径"样本。
        // 泛化引擎生成路径通配规则后，用正常路径做反向验证：若通配规则命中正常路径，
        // 则判定误杀风险高，拒绝输出该规则。只保留最近 200 条，Set 去重，落盘开销极小。

        recordNormalPath(site, path) {
            if (!site || !path || typeof path !== 'string' || path.length < 2) return;
            // 仅记录 pathname（不含 query/hash），减少存储体积与误判噪声
            const cleanPath = path.split('?')[0].split('#')[0];
            if (cleanPath.length < 2 || cleanPath === '/') return;
            // Set 镜像做 O(1) 去重，替代原 Array.includes() 的 O(N) 热路径
            if (!this._normalPathSets[site]) {
                const allPaths = this._readKey('normalPaths', {});
                this._normalPathSets[site] = new Set(allPaths[site] || []);
            }
            const pathSet = this._normalPathSets[site];
            if (pathSet.has(cleanPath)) return; // O(1) 替代 O(N)
            pathSet.add(cleanPath);
            // 批量缓冲：满 20 条统一落盘，减少 95% 的 _markDirty 调用
            this._normalPathsBuffer.push({ site, path: cleanPath });
            if (this._normalPathsBuffer.length >= 20) this._flushNormalPaths();
        }

        // 批量刷新正常路径缓冲到待写队列
        _flushNormalPaths() {
            if (this._normalPathsBuffer.length === 0) return;
            const allPaths = this._readKey('normalPaths', {});
            for (const { site, path } of this._normalPathsBuffer) {
                if (!allPaths[site]) allPaths[site] = [];
                allPaths[site].push(path);
                // 只保留最近 200 条，FIFO 淘汰
                if (allPaths[site].length > 200) {
                    const removed = allPaths[site].splice(0, allPaths[site].length - 200);
                    // 同步清理 Set 镜像中被淘汰的路径，保持镜像与存储一致
                    if (this._normalPathSets[site]) {
                        for (let i = 0; i < removed.length; i++) this._normalPathSets[site].delete(removed[i]);
                    }
                }
            }
            this._normalPathsBuffer = [];
            this._markDirty('normalPaths', allPaths);
        }

        getNormalPaths(site) {
            if (!site) return [];
            const allPaths = this._readKey('normalPaths', {});
            return allPaths[site] || [];
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
     * 域名泛化器：反向基数树 (Reverse Radix Trie)。
     * 利用域名层级倒置特性（com.adnetwork.srv1）构建反向字典树，
     * 当某基准域名下子域密度 ≥ threshold 时自动收敛为 *.base 规则，抑制 DGA/CDN 泛洪。
     * 安全约束：仅在 currentPath ≥ 2 层（com.xxx）时输出通配，永不输出 *.com 这类灾难性规则。
     */
    class DomainGeneralizer {
        // 构建反向字典树时在每个节点记录覆盖的域名列表，避免 extractOptimalDomains 中
        // 对每个子键做 O(N) filter 导致整体 O(N²)。50 域名时从 ~1250 次 split+reverse 降为 50 次
        static buildReverseTrie(domains) {
            const root = {};
            domains.forEach(domain => {
                if (!domain || typeof domain !== 'string') return;
                const parts = domain.toLowerCase().split('.').reverse();
                let curr = root;
                parts.forEach(part => {
                    if (!part) return;
                    if (!curr[part]) curr[part] = { _count: 0, _children: {}, _domains: [] };
                    curr[part]._count++;
                    curr[part]._domains.push(domain); // 构建时即记录，traverse 时直接取用
                    curr = curr[part]._children;
                });
            });
            return root;
        }

        // 返回 [{rule, meta, sources}] —— threshold 个以上子域收敛为 *.base
        static extractOptimalDomains(domains, threshold = 3) {
            if (!domains || domains.length < threshold) return [];
            const trie = this.buildReverseTrie(domains);
            const results = [];
            const seen = new Set();

            const traverse = (node, currentPath, childDomains) => {
                const childrenKeys = Object.keys(node._children);
                // 仅在 ≥2 层（com.xxx）且子域密度达标时收敛，杜绝 *.com 灾难性通配
                if (currentPath.length >= 2 && childrenKeys.length >= threshold) {
                    const base = [...currentPath].reverse().join('.');
                    if (seen.has(base)) return;
                    seen.add(base);
                    results.push({
                        rule: '*.' + base,
                        meta: `${childrenKeys.length} 子域`,
                        sources: childDomains.slice(0, 5)
                    });
                    return; // 已收敛，不再下钻
                }
                childrenKeys.forEach(key => {
                    const childNode = node._children[key];
                    // 直接取构建时记录的 _domains，替代原 O(N) filter 线性扫描
                    traverse(childNode, [...currentPath, key], childNode._domains);
                });
            };

            Object.keys(trie).forEach(tld => traverse(trie[tld], [tld], trie[tld]._domains));
            return results;
        }
    }

    /**
     * 路径泛化器：基于结构指纹聚类的通配推导。
     * 核心改进（替代 MSA 逐位对齐）：
     *   1. 结构指纹聚类：将路径段分类为 NUM/VER/HEX/FILE/WORD，相同指纹归组
     *   2. 精准通配：仅 NUM/HEX 位置通配，WORD 位置保留或小量枚举（{a|b}）
     *   3. 误杀检测：用站点正常路径做反向验证，误杀率 > 30% 则拒绝输出
     *   4. 通配上限：通配段占比 > 50% 则拒绝（防止过度泛化）
     *   5. 按站点独立泛化：不同站点的路径结构不同，不跨站混合
     */
    class PathGeneralizer {
        /**
         * 结构指纹：将路径转为结构签名
         * /ads/banner/123.jpg → WORD/WORD/NUM/FILE
         * /api/v2/track       → WORD/VER/WORD
         */
        static getStructuralFingerprint(path) {
            const segments = String(path).split('/').filter(Boolean);
            return segments.map(seg => {
                if (/^\d+$/.test(seg)) return 'NUM';
                if (/^v\d+/i.test(seg)) return 'VER';
                if (/^[a-f0-9]{8,}$/i.test(seg)) return 'HEX';
                if (/\.\w{2,4}$/.test(seg)) return 'FILE';
                return 'WORD';
            }).join('/');
        }

        /**
         * 按结构指纹聚类：相同指纹的路径归为一组
         * 返回 [[path1, path2, ...], ...]，仅保留 ≥3 条的组
         */
        static clusterByStructure(paths) {
            const map = new Map();
            for (const p of paths) {
                const fp = this.getStructuralFingerprint(p);
                if (!map.has(fp)) map.set(fp, []);
                map.get(fp).push(String(p));
            }
            return [...map.values()].filter(arr => arr.length >= 3);
        }

        /**
         * 从聚类中提取结构模式
         * 与逐位对齐不同：只在 NUM/HEX 位置通配，WORD 位置保留或枚举
         * 通配超过 50% 的段则拒绝（太泛化）
         */
        static extractStructurePattern(cluster) {
            const segArrays = cluster.map(p => String(p).split('/').filter(Boolean));
            const len = segArrays[0].length;
            if (!segArrays.every(a => a.length === len)) return null;

            const pattern = [];
            let wildcardCount = 0;

            for (let i = 0; i < len; i++) {
                const values = new Set(segArrays.map(a => a[i]));
                if (values.size === 1) {
                    pattern.push(segArrays[0][i]); // 所有路径此位置相同，保留
                } else {
                    // 检查是否全是 NUM/HEX（安全通配位置）
                    const allNumeric = [...values].every(v => /^\d+$/.test(v) || /^[a-f0-9]{8,}$/i.test(v));
                    if (allNumeric) {
                        pattern.push('*');
                        wildcardCount++;
                    } else if (values.size <= 3) {
                        // 少量变体：用 {a|b} 枚举（不生成通配）
                        pattern.push('{' + [...values].join('|') + '}');
                    } else {
                        pattern.push('*');
                        wildcardCount++;
                    }
                }
            }

            // 通配超过 50% 的段则拒绝（太泛化）
            if (wildcardCount / len > 0.5) return null;

            return '/' + pattern.join('/');
        }

        /**
         * 将结构模式转为正则：* → [^/]*，{a|b} → (a|b)，其余转义
         * 供误杀检测与 isUrlBlocked 路径匹配复用
         */
        static patternToRegexSource(rule) {
            // 先提取 {a|b} 枚举到占位符，再转义特殊字符，最后还原
            const tokens = [];
            let str = String(rule).replace(/\{([^}]+)\}/g, (_, g) => {
                tokens.push(g);
                return '\x00' + (tokens.length - 1) + '\x00';
            }).replace(/\*/g, '\x01');
            str = str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            str = str.replace(/\x01/g, '[^/]*');
            str = str.replace(/\x00(\d+)\x00/g, (_, i) => '(' + tokens[+i] + ')');
            return str;
        }

        /**
         * 误杀风险评估：用站点正常路径做反向验证
         * 返回 0-1，0 = 无误杀，1 = 全部误杀
         */
        static estimateFalsePositive(pattern, normalPaths) {
            if (!normalPaths || normalPaths.length === 0) return 0.5; // 无参照，中等风险
            let regex;
            try { regex = new RegExp('^' + this.patternToRegexSource(pattern) + '$'); } catch (e) { return 1; }
            let hits = 0;
            for (const p of normalPaths) {
                if (regex.test(p)) hits++;
            }
            return hits / normalPaths.length;
        }

        /**
         * 入口：按站点独立泛化
         * pathsBySite: { site: [path, ...], ... }
         * 返回 [{rule, meta, sources, site}]
         */
        static extractOptimalPatterns(pathsBySite) {
            const results = [];
            for (const [site, paths] of Object.entries(pathsBySite)) {
                if (!paths || paths.length < 4) continue;
                const clusters = this.clusterByStructure(paths);
                for (const cluster of clusters) {
                    if (cluster.length < 3) continue; // 至少 3 条同类路径才泛化
                    const pattern = this.extractStructurePattern(cluster);
                    if (!pattern) continue;
                    // 误杀检测：用该站点正常路径做反向验证
                    const normalPaths = storage.getNormalPaths(site);
                    const fpRisk = this.estimateFalsePositive(pattern, normalPaths);
                    if (fpRisk > 0.3) continue; // 误杀风险 > 30% 则跳过
                    results.push({
                        rule: pattern,
                        meta: `${cluster.length} 路径聚类 (风险${Math.round(fpRisk * 100)}%)`,
                        sources: cluster.slice(0, 5),
                        site
                    });
                }
            }
            return results;
        }

        // 兼容旧接口：单组路径提取模式（供熔断日志使用）
        static extractOptimalPattern(paths) {
            if (!paths || paths.length < 2) return null;
            const clusters = this.clusterByStructure(paths);
            if (clusters.length === 0) return null;
            const pattern = this.extractStructurePattern(clusters[0]);
            if (!pattern) return null;
            return { rule: pattern, meta: `${clusters[0].length} 路径聚类`, sources: clusters[0].slice(0, 5) };
        }
    }

    /**
     * 自动化泛化编排器：读取当前域名黑名单与路径模式规则，
     * 驱动双轨泛化（DomainGeneralizer + PathGeneralizer），
     * 将结果写入 StorageManager.generalizedRules 并刷新匹配缓存。
     * 触发时机：域名/路径规则增删后防抖调用，或管理面板手动"重新泛化"。
     */
    class AutoGeneralizer {
        static _runTimer = null;

        // 防抖触发：合并 500ms 内的多次规则变更
        static schedule() {
            if (this._runTimer) clearTimeout(this._runTimer);
            this._runTimer = setTimeout(() => {
                this._runTimer = null;
                this.run();
            }, 500);
        }

        static run() {
            try {
                const data = storage.getData();
                // 域名轨：全局域名黑名单（domainBlock 已为 {domain,_ts}[]，抽取 domain 字符串）
                const domains = (data.domainBlock || []).map(r => r.domain).filter(Boolean);
                let genDomains = DomainGeneralizer.extractOptimalDomains(domains, 3);
                // 覆盖收益比过滤：仅当通配域名数 / 总域名数 > 0.6 时才值得泛化
                // 防止少量域名触发过度泛化（如 3 个域名中 2 个同 base → 66% 覆盖，可接受）
                if (domains.length > 0) {
                    genDomains = genDomains.filter(g => {
                        const base = g.rule.replace(/^\*\./, '');
                        const covered = domains.filter(d => d.endsWith('.' + base) || d === base).length;
                        return covered / domains.length > 0.6;
                    });
                }

                // 路径轨：按站点独立泛化（不跨站混合，避免不同站点路径结构差异导致误杀）
                const pathDict = storage._readKey('pathPatternBlocks', {});
                const pathsBySite = {};
                const fused = [];
                Object.keys(pathDict).forEach(d => {
                    const paths = (pathDict[d] || []).map(r => r && r.pattern).filter(Boolean);
                    if (paths.length === 0) return;
                    pathsBySite[d] = paths;
                    // 熔断日志：记录被泛化器拒绝的候选（样本不足/特征不足/误杀风险）
                    if (paths.length >= 2 && paths.length < 4) {
                        fused.push({ rule: paths[0], meta: `样本不足(${paths.length}<4)`, sources: paths.slice(0, 3) });
                    }
                });
                const genPaths = PathGeneralizer.extractOptimalPatterns(pathsBySite);

                storage.setGeneralized({ domain: genDomains, path: genPaths, fused });
            } catch (e) {
                console.warn('[Pro Blocker] 自动化泛化失败：', e);
            }
        }
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
        // 泛化规则匹配缓存：域名通配后缀集合 + 路径通配正则
        static _cachedGenDomainSet = null;
        static _cachedGenPathRegex = null; // false 表示无泛化路径规则
        static _loggedDomains = new Set();
        static _loggedPatterns = new Set();
        static _loggedOverlays = new Set();
        static _addedNodesBuffer = [];
        // 已扫描节点弱引用集合：避免对同一节点重复执行资源域/路径扫描（O(1) 判重）
        // WeakSet 不阻止 GC，节点从 DOM 移除后自动释放，杜绝内存泄漏
        static _scannedNodes = new WeakSet();
        // 拓扑指纹缓存：WeakMap 按 element 引用键控，DOM 不变时重复调用直接 O(1) 命中
        // DOMContentLoaded + load + SPA 导航会对同一批元素重复计算指纹，缓存命中率 ~95%
        static _topoFpCache = new WeakMap();
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
            this._cachedGenDomainSet = null;
            this._cachedGenPathRegex = null;
            this._lastCSSFingerprint = ''; // 规则变更后强制下次 applyCSSRules 重建样式表
            this._hostCache.clear(); // 域名黑名单变更后清空 LRU 缓存，避免过期决策
            this._urlBlockCache.clear(); // URL 拦截缓存一并清空，避免规则变更后旧决策残留
        }

        // 构建路径倒排索引（网络层专用）：仅当 _cachedPathIndex !== true 时重建。
        // DOM 扫描仍用 getPathMatcher() 以支持 .exec() 提取匹配串日志。
        static _ensurePathIndex() {
            if (this._cachedPathIndex === true) return;
            const patterns = (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern)
                .map(r => r && r.pattern).filter(Boolean);
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = patterns;
            PathInvertedIndex.build(patterns);
            this._cachedPathIndex = true;
        }

        // 获取域名集合（与 _cachedDomainList 同生命周期），供网络拦截器与动态扫描复用
        // domainBlocks 已迁移为 {domain,_ts}[]，此处抽取 domain 字符串构建 Set
        static getDomainSet() {
            if (this._cachedDomainSet === null) {
                const list = this._cachedDomainList !== null ? this._cachedDomainList : storage.getDomainBlocks().map(r => r.domain);
                if (this._cachedDomainList === null) this._cachedDomainList = list;
                this._cachedDomainSet = new Set(list);
            }
            return this._cachedDomainSet;
        }

        // 获取合并路径正则：多条路径模式合并为单个 RegExp，O(L) 一次匹配替代 O(n) 线性遍历
        // 返回 RegExp 或 false（无路径规则时）
        static getPathMatcher() {
            if (this._cachedPathRegex !== null) return this._cachedPathRegex;
            const patterns = (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern)
                .map(r => r && r.pattern).filter(Boolean)
                .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            this._cachedPathRegex = patterns.length > 0 ? new RegExp(patterns.join('|')) : false;
            return this._cachedPathRegex;
        }

        // 泛化域名集合：将 *.base 规则剥离 '*.' 前缀得 base 后缀，复用 hostnameBlocked 父域上探匹配
        static getGeneralizedDomainSet() {
            if (this._cachedGenDomainSet === null) {
                const gen = storage.getGeneralized().domain || [];
                const list = gen.map(r => r && r.rule ? String(r.rule).replace(/^\*\./, '') : '').filter(Boolean);
                this._cachedGenDomainSet = new Set(list);
            }
            return this._cachedGenDomainSet;
        }

        // 泛化路径正则：将 /a/*/b 通配与 {a|b} 枚举转为正则，合并为单 RegExp
        // * → [^/]*（仅匹配单段，避免跨 / 误杀）；{a|b} → (a|b)；其余特殊字符转义
        // 返回 RegExp 或 false（无泛化路径规则时）
        static getGeneralizedPathRegex() {
            if (this._cachedGenPathRegex !== null) return this._cachedGenPathRegex;
            const gen = storage.getGeneralized().path || [];
            const regexParts = [];
            gen.forEach(r => {
                if (!r || !r.rule) return;
                // 复用 PathGeneralizer.patternToRegexSource 统一转换 * 和 {a|b} 语法
                const part = PathGeneralizer.patternToRegexSource(r.rule);
                if (part.length > 4) regexParts.push(part);
            });
            this._cachedGenPathRegex = regexParts.length > 0 ? new RegExp(regexParts.join('|')) : false;
            return this._cachedGenPathRegex;
        }

        // URL 拦截判定：域名黑名单 + 路径模式 + 泛化规则，供 NetworkInterceptor 与动态扫描复用
        // 路径匹配走倒排索引（O(tokens) 候选过滤）+ 泛化路径正则，网络层高频调用受益最大
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
                    // 2. 泛化域名通配（*.base 收敛规则）
                    else {
                        const genDomainSet = this.getGeneralizedDomainSet();
                        if (genDomainSet.size > 0 && this.hostnameBlocked(absUrl.hostname, genDomainSet)) result = true;
                    }
                }
                if (!result) {
                    const pathStr = absUrl.pathname + absUrl.search;
                    // 3. 精确路径模式（倒排索引 O(tokens) 候选过滤）
                    this._ensurePathIndex();
                    if (PathInvertedIndex.size > 0 && PathInvertedIndex.test(pathStr)) result = true;
                    // 4. 泛化路径通配（结构指纹聚类生成的 /a/*/b 正则）
                    else {
                        const genPathRegex = this.getGeneralizedPathRegex();
                        if (genPathRegex && genPathRegex.test(pathStr)) result = true;
                    }
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
        static isRegexSafe(pattern) {
            if (!pattern || typeof pattern !== 'string') return false;
            // 嵌套量词检测：(a+)+, (a*)*, (a{1,3})+, (a+)? 等
            if (/\([^)]*[+*?][^)]*\)[+*?]/.test(pattern)) return false;
            if (/\([^)]*\{\d+(?:,\d*)?\}[^)]*\)[+*?]/.test(pattern)) return false;
            // 重叠分支 + 量词：(a|ab)+, (a|a)* —— 前缀重叠导致回溯爆炸
            const m = pattern.match(/\(([^)]+)\)[+*?]/);
            if (m) {
                const branches = m[1].split('|');
                for (let i = 0; i < branches.length; i++) {
                    for (let j = 0; j < branches.length; j++) {
                        if (i !== j && branches[j].length > 0 && branches[i].startsWith(branches[j])) return false;
                    }
                }
            }
            return true;
        }

        // 安全正则测试：截断超长文本 + 静态预检通过后直接执行
        static safeRegexTest(regex, text) {
            const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
            return regex.test(truncated);
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
            // 缓存 key 按 domainSet 引用做命名空间前缀，隔离精确域名集与泛化域名集两个缓存域
            // 否则 host 对 Set A 返回 false 后被缓存 → 后续对 Set B 查询同一 host 直接返回 false
            // → 泛化域名规则对已被精确 Set 查询过的 host 永远失效
            const cacheKey = (domainSet === this._cachedGenDomainSet ? 'g:' : 'd:') + host;
            const cached = this._hostCache.get(cacheKey);
            if (cached !== undefined) return cached;
            let result = this._rawHostnameMatch(host, domainSet);
            // LRU 淘汰：缓存满 200 条时淘汰最旧条目（Map 保持插入顺序）
            if (this._hostCache.size >= 200) {
                this._hostCache.delete(this._hostCache.keys().next().value);
            }
            this._hostCache.set(cacheKey, result);
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
            const { autoBlock = true, root = document.documentElement, minSize = 100, _depth = 0 } = options;
            const results = [];
            if (!root || !document.body) return results;
            // Shadow DOM 递归深度限制：浏览器 shadow 嵌套通常 ≤3 层，但恶意/异常页面
            // 可能构造循环引用导致栈溢出，防御性限制最大 5 层
            if (_depth > 5) return results;

            const selfHost = window.location.hostname;

            let candidates;
            try {
                candidates = root.querySelectorAll('a, iframe, div, button, span, img, object, embed');
            } catch (e) { return results; }

            candidates.forEach(el => {
                if (el.id === 'pro-blocker-ui-host') return;
                if (el.closest && el.closest('#pro-blocker-ui-host')) return;
                if (el.style.display === 'none') return;

                // 两阶段过滤：先用廉价的 getBoundingClientRect 过滤面积/视口，
                // 再对达标元素调用昂贵的 getComputedStyle，减少 80%+ 的 getComputedStyle 调用
                const rect = el.getBoundingClientRect();
                if (rect.width < minSize || rect.height < minSize) return;
                const area = rect.width * rect.height;
                if (area < minSize * minSize) return;
                // 视口相交判定：离屏定位（如 left:-9999px）的元素无法捕获点击，排除以减少误报
                const vw = window.innerWidth, vh = window.innerHeight;
                if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) return;

                let style;
                try { style = window.getComputedStyle(el); } catch (e) { return; }
                if (style.position !== 'fixed' && style.position !== 'absolute') return;
                if (style.pointerEvents === 'none') return;
                if (style.display === 'none') return;

                // 不可见性判定：透明/隐藏但仍可点击
                const opacity = parseFloat(style.opacity);
                // 浏览器对透明背景的序列化可能为 'rgba(0, 0, 0, 0)' 或 'transparent'，两者均需识别
                const bgTransparent = (style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent') &&
                    (!style.backgroundImage || style.backgroundImage === 'none');
                const isTransparent = opacity < 0.1 || style.visibility === 'hidden' || bgTransparent;
                if (!isTransparent) return;

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

                if (!selfHref && !hasOnClick && !dataTrigger && !childLink && !childIframe) return;

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

                results.push(record);

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
            });

            // 穿透 Shadow DOM 边界：querySelectorAll 不进入 shadow root，需递归扫描 shadow 内的覆盖层
            // 广告 SDK 常在 shadow 内注入透明跳转层以规避常规选择器，不递归则完全漏拦
            candidates.forEach(el => {
                if (el.shadowRoot) {
                    const shadowResults = this.scanInvisibleOverlays({ autoBlock, root: el.shadowRoot, minSize, _depth: _depth + 1 });
                    for (let i = 0; i < shadowResults.length; i++) results.push(shadowResults[i]);
                }
            });

            return results;
        }

        static applyCSSRules() {
            const data = storage.getData();
            const selectors = [];
            const hideCSS = '{ display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -2147483648 !important; height: 0 !important; width: 0 !important; position: absolute !important; }';

            data.static.forEach(r => r.selector && selectors.push(r.selector));
            data.dynamic.forEach(r => {
                if (!r.className) return;
                const token = r.className.split(/\s+/).filter(Boolean)[0];
                if (token) selectors.push(`[class*="${escapeCSSAttr(token)}"]`);
            });
            data.attribute.forEach(r => r.attrSelector && selectors.push(r.attrSelector));
            data.structural.forEach(r => r.structSelector && selectors.push(r.structSelector));

            // 全局域名黑名单：覆盖所有可能携带资源 URL 的属性（含 srcset）
            // 同时生成 :has() 规则隐藏父级容器，避免横幅广告仅隐藏 iframe 后留下空白占位
            // 优化：批量合并选择器（BATCH=40），将 2N 条规则降为 ⌈2N/BATCH⌉×2 条，
            // 减少 Style Recalculation 开销 ~70%
            const CSS_BATCH = 40;
            const domainAttrSelectors = [];
            const domainHasSelectors = [];
            data.domainBlock.forEach(entry => {
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
                if (r.pattern) {
                    const esc = escapeCSSAttr(r.pattern);
                    const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                    pathAttrSelectors.push(sel);
                    pathHasSelectors.push(sel);
                }
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

            // 指纹比对：内容未变则跳过，避免无谓的 CSSOM 重建（Style Recalculation）
            const fingerprint = selectors.join('\n');
            if (fingerprint === this._lastCSSFingerprint) return;

            const cssText = selectors.map(s => `${s} ${hideCSS}`).join('\n');

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
            for (const sel of selectors) {
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

        // 清除某路径模式相关元素的内联隐藏样式（删除 pathPattern 规则后调用，同上）
        static restoreInlineForPath(pattern) {
            if (!pattern) return;
            const esc = escapeCSSAttr(pattern);
            const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
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
            const domainList = cachedDomainList !== undefined ? cachedDomainList : (this._cachedDomainList !== null ? this._cachedDomainList : storage.getDomainBlocks().map(r => r.domain));
            const pathPatterns = cachedPathPatterns !== undefined ? cachedPathPatterns : (this._cachedPathPatterns !== null ? this._cachedPathPatterns : storage.getData().pathPattern);
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
                        // 泛化路径通配（MSA 对齐生成的 /a/*/b 正则）
                        if (!blocked) {
                            const genPathRegex = this.getGeneralizedPathRegex();
                            if (genPathRegex) {
                                const m = genPathRegex.exec(url);
                                if (m) { blocked = true; matchedPattern = m[0]; }
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
                                // 泛化域名通配（*.base 收敛规则）
                                const genDomainSet = this.getGeneralizedDomainSet();
                                if (genDomainSet.size > 0 && this.hostnameBlocked(urlObj.hostname, genDomainSet)) {
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
            const rules = data.regex
                .filter(r => r.regex && this.isRegexSafe(r.regex))
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
            for (let i = 0; i < level; i++) {
                if (element.parentElement && element.parentElement !== document.body) {
                    element = element.parentElement;
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
            this.applyTopologyRules(root);
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
                    // 去抖执行正则/积木/拓扑规则：shadow 边界外的主观察器无法覆盖 shadow 内动态内容
                    // 不补充此调用则这些规则类型对 shadow 内动态广告完全失效
                    this._scheduleShadowApply(root);
                }
            });
            obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-src', 'data-original', 'data-href', 'data-url', 'data-link', 'data-lazy-src', 'data-srcset', 'poster', 'srcset'] });
        }

        // 去抖对 shadow root 应用正则/积木/拓扑规则 + 覆盖层扫描，避免高频 mutation 重复全量扫描
        static _scheduleShadowApply(root) {
            const existing = this._shadowApplyTimers.get(root);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
                this._shadowApplyTimers.delete(root);
                this.applyRegexRules(root);
                this.applyComplexRules(root);
                this.applyTopologyRules(root);
                // shadow 内动态注入的透明跳转层同样需拦截，与主观察器行为一致
                this.scanInvisibleOverlays({ autoBlock: true, root: root });
            }, 150);
            this._shadowApplyTimers.set(root, timer);
        }

        // 缓存获取域名/路径列表（供 shadow observer 等复用）
        static _getLists() {
            if (this._cachedDomainList === null) this._cachedDomainList = storage.getDomainBlocks().map(r => r.domain);
            if (this._cachedPathPatterns === null) this._cachedPathPatterns = storage.getData().pathPattern;
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
                    this.applyTopologyRules();
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
                    this.applyTopologyRules();
                    this.scanInvisibleOverlays({ autoBlock: true });
                } else {
                    nodes.forEach(node => {
                        this.applyRegexRules(node);
                        this.applyComplexRules(node);
                        this.applyTopologyRules(node);
                        // 对新增子树单独扫描，避免每次都全页扫描
                        this.scanInvisibleOverlays({ autoBlock: true, root: node });
                    });
                }
            }, 120, 600);

            // 批量获取缓存的域名/路径列表，避免每个 mutation 重复读取存储
            const getLists = () => {
                if (this._cachedDomainList === null) this._cachedDomainList = storage.getDomainBlocks().map(r => r.domain);
                if (this._cachedPathPatterns === null) this._cachedPathPatterns = storage.getData().pathPattern;
                return { domainList: this._cachedDomainList, pathPatterns: this._cachedPathPatterns };
            };

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
                    const { domainList, pathPatterns } = getLists();
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
                const { domainList, pathPatterns } = getLists();
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
                    this.applyTopologyRules();
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
                this.applyTopologyRules();
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
                this.applyTopologyRules();
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
                this.applyTopologyRules();
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
         * 用于模糊拓扑指纹：将 DOM 骨架字符串压缩为定长 hex，避免存储与比对原始结构串。
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
         * 模糊拓扑指纹（Fuzzy Topology Signature）：
         * 抛弃脆弱的兄弟节点索引（广告脚本插入空 div 即可破坏），
         * 仅采集"元素自身及父容器的固定骨架信息"（Tag + className 长度分布 + 结构层级），
         * 经 MurmurHash3 压缩为 hex。前缀 'mh:' 标记新算法，便于旧规则迁移识别。
         * 当精准 Selector 因 Tailwind/随机插入层失效时，用指纹兜底定位广告容器。
         */
        static generateTopologyFingerprint(element) {
            if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
            let topology = '';
            let current = element;
            let depth = 0;
            // 沿父链上溯至 body（不含），最多 5 层；采集 tag + className 长度（不采 class 名，抗随机化）
            while (current && current !== document.body && current.nodeType === Node.ELEMENT_NODE && depth < 5) {
                const tag = current.tagName;
                const classDist = typeof current.className === 'string' ? current.className.length : 0;
                topology += `${tag}(${classDist})_`;
                current = current.parentElement;
                depth++;
            }
            return 'mh:' + this.murmur32(topology);
        }

        /**
         * 旧版拓扑规则迁移：v0.2.11 之前的 topoHash 为明文结构串（无 'mh:' 前缀），
         * 与新算法不兼容。无法离线重算（缺原元素），故剥离 topoHash 让规则退化为
         * 纯 Selector 匹配（安全默认）。仅执行一次（topoHashMigrated 标记持久化）。
         */
        static migrateTopoHashes() {
            try {
                if (storage._readKey('topoHashMigrated', false)) return;
                // 遍历所有域名的 structural 规则（getData() 仅返回当前域名，须直接读 structBlocks 字典）
                const allStruct = storage._readKey('structBlocks', {});
                let touched = false;
                for (const domain in allStruct) {
                    if (!Object.prototype.hasOwnProperty.call(allStruct, domain)) continue;
                    const arr = allStruct[domain];
                    if (!Array.isArray(arr)) continue;
                    arr.forEach(r => {
                        if (r && r.topoHash && typeof r.topoHash === 'string' && !r.topoHash.startsWith('mh:')) {
                            delete r.topoHash; // 旧明文指纹剥离，回退到 Selector 兜底
                            touched = true;
                        }
                    });
                }
                if (touched) {
                    storage._markDirty('structBlocks', allStruct);
                    storage.invalidateDataCache();
                    BlockEngine.invalidateCache();
                }
                storage._markDirty('topoHashMigrated', true);
            } catch (e) {
                console.warn('[Pro Blocker] 拓扑指纹迁移失败：', e);
            }
        }

        /**
         * 拓扑哈希兜底拦截：扫描 DOM 中与已存储拓扑指纹匹配的元素并隐藏。
         * 仅在精准 CSS Selector 可能失效的站点（Tailwind/随机层）起兜底作用。
         */
        static applyTopologyRules(targetNode = document.body) {
            const data = storage.getData();
            if (!data.structural || data.structural.length === 0 || !targetNode) return;

            // 仅处理带新算法（'mh:' 前缀）topoHash 的规则；旧明文指纹已由 migrateTopoHashes 剥离
            const hashSet = new Set();
            data.structural.forEach(r => {
                if (r.topoHash && typeof r.topoHash === 'string' && r.topoHash.startsWith('mh:')) hashSet.add(r.topoHash);
            });
            if (hashSet.size === 0) return;

            // ShadowRoot(DOCUMENT_FRAGMENT_NODE) 与 Element 均可直接 querySelectorAll；
            // 其它节点类型（如文本节点）回退到 parentElement
            const root = (targetNode.nodeType === Node.ELEMENT_NODE || targetNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE)
                ? targetNode : targetNode.parentElement;
            if (!root) return;

            // 扫描常见广告容器标签，O(candidates) 匹配
            let candidates;
            try {
                candidates = root.querySelectorAll('div, span, a, p, img, li, ul, iframe, section, article, aside, header, footer, nav');
            } catch (e) { return; }

            candidates.forEach(el => {
                if (el.style.display === 'none') return; // 已隐藏跳过
                // 拓扑指纹缓存：DOM 不变时直接复用，避免重复 5 层父链遍历 + murmur32
                let fp = this._topoFpCache.get(el);
                if (fp === undefined) {
                    fp = this.generateTopologyFingerprint(el);
                    this._topoFpCache.set(el, fp);
                }
                if (hashSet.has(fp)) {
                    this.stats.domBlocks++;
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('opacity', '0', 'important');
                }
            });
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
     * 广告域置信度评分引擎（Logistic Regression）
     * 用 Sigmoid 将线性累加压缩到 (0,1) 概率区间，从数学根源上解决"分数无上限"与基础设施域名被误杀。
     * 结合香农熵特征识别 DGA（域名生成算法）产生的随机子域，对抗广告 SDK 的域名规避手段。
     * 零依赖、微秒级推理：当 evaluate(url) ≥ 阈值时由网络层自动加入拦截队列，减少人工指认成本。
     */
    class AdScorerLR {
        // 向量化权重（Float32Array 连续内存布局，近似向量点积加速）
        // 索引 0-5 对应 6 个正向广告特征；索引 6 为 DGA 高熵惩罚特征
        static weights = new Float32Array([2.5, 2.8, 1.8, 2.0, 2.2, 1.5, 2.0]);
        // 词元→权重索引映射（O(1) 查表替代对象属性查找）
        static keywordMap = new Map([
            ['ad', 0], ['ads', 1], ['analytics', 2], ['track', 3],
            ['banner', 4], ['pixel', 5]
        ]);
        static ENTROPY_INDEX = 6;
        // 基础偏置：抑制默认得分，需累计足够正向特征才能突破拦截阈值
        static bias = -2.5;
        // 自动拦截阈值（0-100）：仅当得分 ≥ 85 才自动拦截，兼顾检测率与误杀控制
        static AUTO_BLOCK_THRESHOLD = 85;
        // 安全 CDN 白名单：与 extractResourceDomains 的 KNOWN_SAFE_CDNS 保持一致，LR 自动拦截豁免
        static safeCDNs = new Set([
            'ajax.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
            'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'code.jquery.com',
            'stackpath.bootstrapcdn.com', 'maxcdn.bootstrapcdn.com', 'cdn.bootcss.com',
            'staticfile.org', 'cdn.staticfile.org', 'www.google.com', 'www.recaptcha.net',
            'challenges.cloudflare.com', 'hcaptcha.com', 'static.cloudflareinsights.com'
        ]);

        // Sigmoid 激活：将线性结果 z 压缩到 (0,1)
        static sigmoid(z) {
            // 数值稳定：z 过大/过小时 Math.exp 溢出，裁剪到安全区间
            if (z > 30) return 1;
            if (z < -30) return 0;
            return 1 / (1 + Math.exp(-z));
        }

        // 香农熵：Uint8Array 计数版，识别 DGA 生成的随机子域名（hostname 为 ASCII，charCodeAt ≤255）
        static getEntropy(str) {
            const len = str.length;
            if (len === 0) return 0;
            const counts = new Uint8Array(256);
            for (let i = 0; i < len; i++) counts[str.charCodeAt(i)]++;
            let entropy = 0;
            for (let i = 0; i < 256; i++) {
                if (counts[i] > 0) {
                    const p = counts[i] / len;
                    entropy -= p * Math.log2(p);
                }
            }
            return entropy;
        }

        // 主干推理：输出 0-100 标准化得分。无效 URL 放行（返回 0）
        // 仅取 hostname 分词（路径信号由 DOM 扫描层覆盖，hostname 更稳定不易误杀）
        static evaluate(urlStr) {
            let z = this.bias;
            try {
                const url = new URL(urlStr, location.href);
                const tokens = url.hostname.toLowerCase().split(/[^a-z0-9]/);
                // 1. 词元特征匹配与权重累加（Map 查表 + Float32Array 索引）
                for (let i = 0; i < tokens.length; i++) {
                    const idx = this.keywordMap.get(tokens[i]);
                    if (idx !== undefined) z += this.weights[idx];
                }
                // 2. 结构特征：规避型子域名高熵检测（DGA 对抗），取首个子域标签
                const sub = url.hostname.split('.')[0];
                if (sub.length >= 8 && this.getEntropy(sub) > 3.6) {
                    z += this.weights[this.ENTROPY_INDEX];
                }
            } catch (e) {
                return 0;
            }
            // 3. 概率映射 → 0-100；z≤0 时直接返回 0（普通域名默认低分，无需 sigmoid 计算）
            return z > 0 ? Math.round(this.sigmoid(z) * 100) : 0;
        }

        // 自动拦截判定：同源/安全 CDN 豁免，仅高分广告域自动拦截
        static shouldAutoBlock(urlStr) {
            if (!urlStr || typeof urlStr !== 'string') return false;
            try {
                const u = new URL(urlStr, location.href);
                if (!u.hostname) return false;
                const host = u.hostname.toLowerCase();
                // 同源豁免
                if (host === location.hostname || host.endsWith('.' + location.hostname)) return false;
                // 安全 CDN 豁免（含父域上探）
                if (this.safeCDNs.has(host)) return false;
                const parts = host.split('.');
                for (let i = 1; i < parts.length - 1; i++) {
                    if (this.safeCDNs.has(parts.slice(i).join('.'))) return false;
                }
                return this.evaluate(urlStr) >= this.AUTO_BLOCK_THRESHOLD;
            } catch (e) {
                return false;
            }
        }
    }

    /**
     * 网络层拦截器：在 document-start 阶段劫持 fetch / XHR / script.src，
     * 命中全局域名黑名单或路径模式时直接丢弃请求，从源头阻止广告资源加载（而非等 DOM 渲染后再隐藏）。
     * 判定逻辑复用 BlockEngine.isUrlBlocked，与 DOM 层拦截规则完全一致，避免双标。
     */
    class NetworkInterceptor {
        // GE 命中计数防抖落盘：避免每个拦截请求都触发 _save
        static _geDirtyTimer = null;
        static _markGEDirty() {
            if (this._geDirtyTimer) return;
            this._geDirtyTimer = setTimeout(() => {
                this._geDirtyTimer = null;
                try { GeneralizationEngine.flush(); } catch(e){}
            }, 5000);
        }

        static init() {
            this.hookFetch();
            this.hookXHR();
            this.hookScriptSrc();
        }

        static isUrlBlocked(url) {
            // 1. 显式规则拦截：域名黑名单 + 路径模式（与 DOM 层规则一致）
            if (BlockEngine.isUrlBlocked(url)) return true;
            // 2. LR 置信度自动拦截：高分广告域自动加入拦截队列，减少人工指认成本
            //    阈值 85 + 同源/安全 CDN 豁免，确保不误伤基础设施与同站资源
            if (AdScorerLR.shouldAutoBlock(url)) return true;
            // 3. GeneralizationEngine 自学习规则：置信度 ≥ 0.5 的 domain/url/path 自动拦截
            //    覆盖深度扫描学习到的博彩/色情/追踪域名与 URL 模式
            try {
                const m = GeneralizationEngine.matchUrl(url);
                if (m.blocked) {
                    if (m.rule) {
                        m.rule.hits = (m.rule.hits || 0) + 1;
                        if (m.rule.confidence < 1.0) m.rule.confidence = Math.min(1.0, m.rule.confidence + 0.05);
                        NetworkInterceptor._markGEDirty();
                    }
                    return true;
                }
            } catch(e){}
            return false;
        }

        // 记录未被拦截的请求路径为"正常路径"样本，供泛化引擎做误杀反向验证
        static _recordNormalPath(url) {
            if (!url || typeof url !== 'string') return;
            try {
                const u = new URL(url, location.href);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
                storage.recordNormalPath(location.hostname, u.pathname);
            } catch (e) { }
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
                NetworkInterceptor._recordNormalPath(url);
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
                } else {
                    NetworkInterceptor._recordNormalPath(url);
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

    // ================= 三算法协同系统 v2 =================
    // GlobalDomainScanner × OverlayAdScanner × GeneralizationEngine × AdBlockOrchestrator
    // 设计目标：全量采集 · 精准评分 · 不可见/覆盖层专攻 · 智能自学习 · 博彩/色情专项拦截
    // 与现有 BlockEngine/NetworkInterceptor 并行：新增博彩色情词库、跳转拦截、置信度追踪能力
    // 不复刻 fetch/XHR/MutationObserver（已有），仅补充 nav 拦截 + 动态学习 + 衰减

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
            'com.cn','net.cn','org.cn','gov.cn','edu.cn',
            'co.uk','org.uk','ac.uk','com.au','net.au',
            'co.jp','or.jp','ne.jp','co.kr','or.kr',
            'com.br','com.tw','com.hk','co.in','co.za',
            'com.sg','com.my','com.ph','co.th','co.id'
        ]);

        // ─── 广告词元库 ───
        const AD_TOKENS = new Set([
            'ad','ads','adx','adnxs','advert','adsystem','adserver','adserving',
            'doubleclick','googlesyndication','googleadservices','google-analytics',
            'amazon-adsystem','taboola','outbrain','mgid','criteo','media6degrees',
            'popads','propellerads','revcontent','adcolony','unityads','ironsrc',
            'analytics','tracking','tracker','beacon','pixel','logger','telemetry',
            'metrics','collect','umeng','sentry','hotjar','mixpanel','segment',
            'cnzz','baidu','tongji','stat','count','report'
        ]);

        // ─── 博彩/色情/恶意跳转词元库 ───
        const VICE_TOKENS = new Set([
            'casino','bet','betting','poker','slot','lottery','jackpot',
            'wager','gambling','lucky','spin','baccarat','roulette','blackjack',
            'sportsbook','bookmaker','odds','handicap','parlay',
            'bocai','caipiao','yazhou','ag','bbin','mg','pt','sb','ibc',
            'sbo','cmd368','maxbet','sunbet','tombola','lottomatica',
            'adult','xxx','porn','sex','nude','erotic','hentai','nsfw',
            'live','cam','dating','hookup','escort','onlyfans','xvideos',
            'pornhub','xhamster','redtube','youporn','brazzers',
            'redirect','click','track','go','jump','link','short','tiny',
            'bitly','turl','sclick','goo','owly','rebrandly','cuttly',
            'popup','popunder','overlay','push','notification','interstitial',
            'splash','takeover','skyscraper','leaderboard','native-ad'
        ]);

        // ─── 资源类型映射 ───
        const TYPE_MAP = {
            'script':'script','link':'css','css':'css',
            'img':'image','image':'image','picture':'image',
            'xmlhttprequest':'xhr','fetch':'xhr','beacon':'beacon',
            'iframe':'iframe','subdocument':'iframe','frame':'iframe',
            'video':'media','audio':'media',
            'websocket':'ws','embed':'plugin','object':'plugin','other':'other'
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
                    } catch(ex){}
                }
            } catch(ex){}

            // 通道B：DOM 资源元素（懒加载/srcset/poster）
            try {
                const SEL = [
                    'img[src]','img[data-src]','img[data-lazy-src]','img[srcset]',
                    'source[src]','source[srcset]','source[data-src]',
                    'script[src]','script[data-src]',
                    'link[href][rel="stylesheet"]',
                    'iframe[src]','iframe[data-src]',
                    'video[src]','video[poster]','audio[src]',
                    'embed[src]','object[data]',
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
                        } catch(ex){}
                    }
                }
            } catch(ex){}

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
                                } catch(e2){}
                            }
                        }
                    } catch(ex){}
                }
            } catch(ex){}

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
                                    } catch(e3){}
                                }
                            }
                        }
                    } catch(ex){}
                }
            } catch(ex){}

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
                    } catch(ex){}
                }
            } catch(ex){}

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

        return { scan, mainDomain, extractFeatures, calculateScore, AD_TOKENS, VICE_TOKENS };
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
            'div[class]','div[id]','section[class]','aside[class]',
            'iframe','ins','a[target="_blank"]','img[src]',
            'div[style*="position"]','div[style*="z-index"]',
            'div[style*="opacity"]','div[style*="visibility"]'
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
                    seen.add(el);
                    const f = _analyzeElement(el);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch(e){}

            // 阶段2：定位元素扫描（覆盖层核心）
            try {
                const positioned = document.querySelectorAll('div,section,aside,article');
                for (const el of positioned) {
                    if (seen.has(el)) continue;
                    const cs = _cs(el);
                    if (!cs) continue;
                    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                    seen.add(el);
                    const f = _analyzeOverlay(el, cs);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch(e){}

            // 阶段3：可点击图片专项（博彩/色情核心）
            try {
                const clickableImgs = document.querySelectorAll('a img, a > img, [onclick] img, img[onclick]');
                for (const img of clickableImgs) {
                    if (seen.has(img)) continue;
                    seen.add(img);
                    const f = _analyzeClickableImage(img);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch(e){}

            results.sort((a, b) => b.suspicion - a.suspicion);
            const elapsed = (performance.now() - t0).toFixed(1);
            return { results, elapsed, total: results.length };
        }

        function _analyzeElement(el) {
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
            f.selector = _buildSelector(el);
            f.features.tag = tag;
            return f;
        }

        function _analyzeOverlay(el, cs) {
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
                    } catch(e){}
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

        // ─── 实时动态插入监控（学习用，不重复隐藏，BlockEngine 已处理拦截）───
        let _observer = null;
        let _dynamicCallback = null;

        function startWatching(callback) {
            if (_observer) _observer.disconnect();
            _dynamicCallback = callback;
            _observer = new MutationObserver(mutations => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        node.dataset._dynamicInsert = '1';
                        const f = _analyzeElement(node);
                        if (f.suspicion >= 30) _dynamicCallback && _dynamicCallback(f);
                        const imgs = node.tagName === 'IMG' ? [node] : Array.from((node.querySelectorAll && node.querySelectorAll('img')) || []);
                        for (const img of imgs) {
                            img.dataset._dynamicInsert = '1';
                            const fi = _analyzeClickableImage(img);
                            if (fi.suspicion >= 25) _dynamicCallback && _dynamicCallback(fi);
                        }
                    }
                }
            });
            _observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        function stopWatching() {
            if (_observer) _observer.disconnect();
            _observer = null;
        }

        // ─── 跳转拦截（博彩/色情核心防线，现有 NetworkInterceptor 未覆盖）───
        let _navBlocked = [];
        let _navInterceptorActive = false;

        function enableNavigationInterceptor(blockedDomains) {
            if (_navInterceptorActive) return;
            _navInterceptorActive = true;
            // 初始快照仅用于启动期；后续命中通过 GE.matchNavigation 实时查询，
            // 使深度扫描学习到的新 nav 规则能立即生效
            const _checkNav = (url) => {
                if (!url) return false;
                // 优先 GE 实时匹配（覆盖后续学习的规则 + 同步命中计数）
                try {
                    const m = GeneralizationEngine.matchNavigation(url);
                    if (m.blocked) {
                        if (m.rule) {
                            m.rule.hits = (m.rule.hits || 0) + 1;
                            NetworkInterceptor._markGEDirty();
                        }
                        return true;
                    }
                } catch(e){}
                // 兜底：启动期快照 + 静态特征（IP/短链/博彩色情词元）
                return _isBlockedNav(url, blockedDomains);
            };

            // ① 拦截 window.open
            const _origOpen = window.open;
            window.open = function(url) {
                const args = Array.prototype.slice.call(arguments);
                if (_checkNav(url)) {
                    _navBlocked.push({ type: 'window.open', url: url, time: Date.now() });
                    console.warn('[OverlayAdScanner] 拦截 window.open:', url);
                    return null;
                }
                return _origOpen.apply(this, args);
            };

            // ② 拦截 <a> 点击（捕获阶段）
            document.addEventListener('click', function(e) {
                const link = e.target.closest && e.target.closest('a');
                if (!link) return;
                const href = link.href || '';
                if (href && _checkNav(href)) {
                    e.preventDefault();
                    e.stopPropagation();
                    _navBlocked.push({ type: 'link.click', url: href, time: Date.now() });
                    console.warn('[OverlayAdScanner] 拦截链接:', href);
                    const container = link.closest('[class*="ad"],[class*="popup"],[class*="banner"],[class*="overlay"]') || link;
                    container.remove();
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
            } catch(e){}

            // ④ 拦截 form 提交
            document.addEventListener('submit', function(e) {
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
            } catch(e) { return false; }
        }

        function getBlockedNav() { return _navBlocked; }

        function _cs(el) {
            try { return window.getComputedStyle(el); } catch(e) { return null; }
        }
        function _rect(el) {
            try { return el.getBoundingClientRect(); } catch(e) { return { width:0, height:0, left:0, top:0, right:0 }; }
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

        return { scan, startWatching, stopWatching, enableNavigationInterceptor, getBlockedNav, _isBlockedNav };
    })();

    /**
     * ═══════════════════════════════════════════════════════════════
     *  算法三：GeneralizationEngine — 智能自学习泛化引擎
     *
     *  独立规则库 ge_rules_v2：与现有 storage 规则并行，互不污染
     *  学习通道：域名扫描 / 覆盖层扫描 / 用户手动 / 反馈 / 运行时命中
     * ═══════════════════════════════════════════════════════════════
     */
    const GeneralizationEngine = (() => {

        let rules = {
            domain: [], url: [], css: [], attr: [], nav: [], path: []
        };

        const CONFIDENCE_MIN = 0.5;
        const CONFIDENCE_MAX = 1.0;
        const DECAY_FACTOR = 0.7;
        const BOOST_FACTOR = 0.1;
        const PENALTY_FACTOR = 0.4;
        const MAX_RULES = { domain: 300, url: 80, css: 150, attr: 80, nav: 100, path: 50 };
        const DECAY_INTERVAL = 30 * 86400000;
        const VICE_RE_SIMPLE = /^(ad|ads|advert|banner|sponsor|promo|overlay|popup|float|sticky|track|pixel|interstitial|casino|bet|porn|xxx|adult|sex|hot|live|cam|modal|mask|cover)/i;

        _load();

        function learnFromDomainScan(scanResults) {
            let learned = 0;
            for (const r of scanResults) {
                if (r.level !== 'ad' && r.level !== 'suspect') continue;
                if (!_hasRule('domain', r.hostname)) {
                    rules.domain.push({
                        hostname: r.hostname,
                        confidence: r.level === 'ad' ? 0.92 : 0.68,
                        hits: 0, misses: 0, source: 'domain_scan', created: Date.now(),
                        features: { adToken: r.adToken, viceToken: r.viceToken, imageBehavior: r.imageBehavior, redirectChain: r.redirectChain }
                    });
                    learned++;
                } else {
                    _boostRule('domain', r.hostname);
                }
                if (r.viceToken) {
                    if (!_hasRule('nav', r.hostname)) {
                        rules.nav.push({ hostname: r.hostname, confidence: 0.95, hits: 0, source: 'domain_scan', created: Date.now() });
                        learned++;
                    }
                }
                if (r.adToken || r.viceToken) {
                    const token = r.viceToken || r.adToken;
                    const pattern = _tokenToUrlPattern(token);
                    if (pattern && !_hasRule('url', pattern)) {
                        rules.url.push({ pattern, confidence: r.viceToken ? 0.85 : 0.7, hits: 0, source: 'domain_scan', created: Date.now() });
                        learned++;
                    }
                }
                if (r.info && r.info.urls) {
                    for (const url of r.info.urls.slice(0, 3)) {
                        const pp = _extractPathPattern(url);
                        if (pp && !_hasRule('path', pp)) {
                            rules.path.push({ pattern: pp, confidence: 0.6, hits: 0, source: 'domain_scan', created: Date.now() });
                            learned++;
                        }
                    }
                }
            }
            learned += _generalizeDomainCluster(scanResults);
            _save();
            return learned;
        }

        function learnFromOverlayScan(scanResults) {
            let learned = 0;
            for (const r of scanResults) {
                if (r.suspicion < 25) continue;
                const f = r.features;
                const sel = r.selector;
                if (f.invisible && sel && !_hasRule('css', sel)) {
                    rules.css.push({ selector: sel, confidence: 0.85, hits: 0, source: 'overlay_scan', created: Date.now(), reason: '不可见(' + f.invisible + ')' });
                    learned++;
                }
                if ((f.highZ || f.fullscreen) && sel && !_hasRule('css', sel)) {
                    rules.css.push({ selector: sel, confidence: f.fullscreen ? 0.9 : 0.75, hits: 0, source: 'overlay_scan', created: Date.now(), reason: '覆盖层' });
                    learned++;
                }
                if (r.category === 'vice-image') {
                    if (sel && !_hasRule('css', sel)) {
                        rules.css.push({ selector: sel, confidence: 0.8, hits: 0, source: 'overlay_scan', created: Date.now(), reason: '博彩/色情图片' });
                        learned++;
                    }
                    if (f.externalLink && !_hasRule('nav', f.externalLink)) {
                        rules.nav.push({ hostname: f.externalLink, confidence: 0.9, hits: 0, source: 'overlay_scan', created: Date.now() });
                        learned++;
                    }
                }
                if (f.pixel) {
                    const src = (r.el && r.el.src) || '';
                    if (src && !_hasRule('url', src)) {
                        rules.url.push({ pattern: _escapeRegex(src), confidence: 0.9, hits: 0, source: 'overlay_scan', created: Date.now() });
                        learned++;
                    }
                }
                if (f.viceAttr && r.el) {
                    const cls = (r.el.className || '').toString();
                    const tokens = cls.split(/[\s_-]+/).filter(t => t.length > 2 && VICE_RE_SIMPLE.test(t));
                    for (const t of tokens.slice(0, 2)) {
                        const key = (cls ? 'class' : 'id') + ':' + t;
                        if (!_hasRule('attr', key)) {
                            rules.attr.push({ attr: cls ? 'class' : 'id', value: t, tag: f.tag || '*', confidence: 0.7, hits: 0, source: 'overlay_scan', created: Date.now() });
                            learned++;
                        }
                    }
                }
            }
            learned += _generalizeOverlayCluster(scanResults);
            _save();
            return learned;
        }

        function learnFromManualSelect(element) {
            if (!element) return 0;
            let learned = 0;
            const tag = element.tagName.toLowerCase();
            const cls = (element.className || '').toString();
            const sel = _buildPreciseSelector(element);
            if (sel && !_hasRule('css', sel)) {
                rules.css.push({ selector: sel, confidence: CONFIDENCE_MAX, hits: 0, source: 'manual', created: Date.now(), reason: '用户手动选择' });
                learned++;
            }
            if (cls) {
                for (const c of cls.trim().split(/\s+/)) {
                    if (c.length > 2 && !_hasRule('attr', 'class:' + c)) {
                        rules.attr.push({ attr: 'class', value: c, tag, confidence: 0.8, hits: 0, source: 'manual', created: Date.now() });
                        learned++;
                    }
                }
            }
            const embed = element.querySelector('iframe[src],img[src]');
            if (embed) {
                const src = embed.src || '';
                const pat = _srcToPattern(src);
                if (pat && !_hasRule('url', pat)) {
                    rules.url.push({ pattern: pat, confidence: 0.85, hits: 0, source: 'manual', created: Date.now() });
                    learned++;
                }
            }
            _save();
            return learned;
        }

        function feedbackFalsePositive(ruleType, ruleId) {
            const arr = rules[ruleType];
            if (!arr) return;
            // 用户明确标记误报 → 直接删除该规则（Bug1.2：旧版需多次点击才删除，体验差）
            const idx = arr.findIndex(r => (r.hostname || r.pattern || r.selector || r.value) === ruleId);
            if (idx >= 0) {
                arr.splice(idx, 1);
                _save();
            }
        }

        function feedbackConfirm(ruleType, ruleId) {
            const arr = rules[ruleType];
            if (!arr) return;
            const rule = arr.find(r => (r.hostname || r.pattern || r.selector || r.value) === ruleId);
            if (rule) {
                rule.confidence = Math.min(CONFIDENCE_MAX, rule.confidence + BOOST_FACTOR);
                _save();
            }
        }

        function matchUrl(url) {
            if (!url) return { blocked: false };
            try {
                const u = new URL(url, location.href);
                const host = u.hostname.toLowerCase();
                for (const r of rules.domain) {
                    if (r.confidence < CONFIDENCE_MIN) continue;
                    if (host === r.hostname || host.endsWith('.' + r.hostname)) {
                        return { blocked: true, rule: r, type: 'domain' };
                    }
                }
                for (const r of rules.url) {
                    if (r.confidence < CONFIDENCE_MIN) continue;
                    try { if (new RegExp(r.pattern, 'i').test(url)) { return { blocked: true, rule: r, type: 'url' }; } } catch(e){}
                }
                for (const r of rules.path) {
                    if (r.confidence < CONFIDENCE_MIN) continue;
                    if (u.pathname.includes(r.pattern)) { return { blocked: true, rule: r, type: 'path' }; }
                }
            } catch(e){}
            return { blocked: false };
        }

        function matchNavigation(url) {
            if (!url) return { blocked: false };
            try {
                const host = new URL(url, location.href).hostname.toLowerCase();
                for (const r of rules.nav) {
                    if (r.confidence < CONFIDENCE_MIN) continue;
                    if (host === r.hostname || host.endsWith('.' + r.hostname)) {
                        return { blocked: true, rule: r, type: 'nav' };
                    }
                }
            } catch(e){}
            return { blocked: false };
        }

        function getBlockedDomains() {
            return rules.nav.filter(r => r.confidence >= CONFIDENCE_MIN).map(r => r.hostname);
        }

        function decay() {
            const now = Date.now();
            let cleaned = 0;
            for (const type of Object.keys(rules)) {
                rules[type] = rules[type].filter(r => {
                    if (r.hits === 0 && now - r.created > DECAY_INTERVAL && r.source !== 'manual') {
                        r.confidence *= DECAY_FACTOR;
                    }
                    if (r.hits >= 5 && r.confidence < CONFIDENCE_MAX) {
                        r.confidence = Math.min(CONFIDENCE_MAX, r.confidence + 0.05);
                    }
                    if (r.confidence < 0.12) { cleaned++; return false; }
                    return true;
                });
                if (rules[type].length > MAX_RULES[type]) {
                    rules[type].sort((a, b) => b.confidence - a.confidence);
                    rules[type] = rules[type].slice(0, MAX_RULES[type]);
                }
            }
            _save();
            return cleaned;
        }

        function optimize() {
            const cssSet = new Set();
            rules.css = rules.css.filter(r => { if (cssSet.has(r.selector)) return false; cssSet.add(r.selector); return true; });
            const domSet = new Set();
            rules.domain = rules.domain.filter(r => { if (domSet.has(r.hostname)) return false; domSet.add(r.hostname); return true; });
            _save();
        }

        function getStatus() {
            const all = [].concat(rules.domain, rules.url, rules.css, rules.attr, rules.nav, rules.path);
            return {
                counts: { domain: rules.domain.length, url: rules.url.length, css: rules.css.length, attr: rules.attr.length, nav: rules.nav.length, path: rules.path.length },
                totalRules: all.length,
                totalHits: all.reduce((s, r) => s + (r.hits || 0), 0),
                avgConfidence: all.length > 0 ? (all.reduce((s, r) => s + r.confidence, 0) / all.length).toFixed(3) : 0
            };
        }

        function _generalizeDomainCluster(results) {
            let learned = 0;
            const adHosts = results.filter(r => r.level === 'ad' || r.level === 'suspect').map(r => r.hostname);
            if (adHosts.length < 2) return 0;
            const prefixCount = {};
            for (const h of adHosts) {
                const parts = h.split('.');
                if (parts.length >= 3) {
                    const prefix = parts[0];
                    if (/^(ad|ads|px|pixel|track|srv|cdn\d*|banner|pop|float|bet|casino|hot|live|img\d*)/i.test(prefix)) {
                        prefixCount[prefix] = (prefixCount[prefix] || 0) + 1;
                    }
                }
            }
            for (const prefix in prefixCount) {
                if (prefixCount[prefix] >= 2) {
                    const pattern = '^https?://' + prefix + '[^/]*\\.';
                    if (!_hasRule('url', pattern)) {
                        rules.url.push({ pattern, confidence: 0.65, hits: 0, source: 'generalization', created: Date.now() });
                        learned++;
                    }
                }
            }
            const mainDomainCount = {};
            for (const h of adHosts) {
                const md = GlobalDomainScanner.mainDomain(h);
                mainDomainCount[md] = (mainDomainCount[md] || 0) + 1;
            }
            for (const md in mainDomainCount) {
                if (mainDomainCount[md] >= 2 && !_hasRule('domain', md)) {
                    rules.domain.push({ hostname: md, confidence: 0.8, hits: 0, misses: 0, source: 'generalization', created: Date.now(), features: { clustered: true, subdomainCount: mainDomainCount[md] } });
                    learned++;
                }
            }
            return learned;
        }

        function _generalizeOverlayCluster(results) {
            let learned = 0;
            const classCount = {};
            for (const r of results) {
                if (r.suspicion < 35 || !r.el) continue;
                const cls = (r.el.className || '').toString();
                for (const c of cls.split(/\s+/)) {
                    if (c.length > 3 && VICE_RE_SIMPLE.test(c)) {
                        classCount[c] = (classCount[c] || 0) + 1;
                    }
                }
            }
            for (const c in classCount) {
                if (classCount[c] >= 2 && !_hasRule('attr', 'class:' + c)) {
                    rules.attr.push({ attr: 'class', value: c, tag: '*', confidence: 0.75, hits: 0, source: 'generalization', created: Date.now() });
                    learned++;
                }
            }
            return learned;
        }

        function _tokenToUrlPattern(token) {
            if (!token || token.length < 2) return null;
            return '[?/&][^=]*' + token + '[^=]*=';
        }
        function _extractPathPattern(url) {
            try {
                const u = new URL(url);
                const segs = u.pathname.split('/').filter(Boolean);
                for (const seg of segs) {
                    if (VICE_RE_SIMPLE.test(seg) && seg.length > 3) return '/' + seg;
                }
            } catch(e){}
            return null;
        }
        function _srcToPattern(src) {
            if (!src) return null;
            try {
                const u = new URL(src, location.href);
                return '^https?://([^/]*\\.)?' + _escapeRegex(u.hostname);
            } catch(e) { return null; }
        }
        function _escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
        function _buildPreciseSelector(el) {
            if (el.id) return '#' + el.id;
            let s = el.tagName.toLowerCase();
            const cls = (el.className || '').toString().trim();
            if (cls) { const first = cls.split(/\s+/)[0]; if (first) s += '.' + first; }
            return s;
        }
        function _hasRule(type, key) {
            const arr = rules[type];
            if (!arr) return false;
            return arr.some(r => (r.hostname === key) || (r.pattern === key) || (r.selector === key) || (r.value === key));
        }
        function _boostRule(type, key) {
            const arr = rules[type];
            if (!arr) return;
            const rule = arr.find(r => r.hostname === key || r.pattern === key || r.selector === key);
            if (rule) rule.confidence = Math.min(CONFIDENCE_MAX, rule.confidence + 0.05);
        }

        function _save() {
            try {
                const data = JSON.stringify(rules);
                if (typeof GM_setValue === 'function') GM_setValue('ge_rules_v2', data);
                else localStorage.setItem('ge_rules_v2', data);
            } catch(e){}
        }
        function _load() {
            try {
                let data;
                if (typeof GM_getValue === 'function') data = GM_getValue('ge_rules_v2', null);
                else data = localStorage.getItem('ge_rules_v2');
                if (data) {
                    const parsed = JSON.parse(data);
                    if (parsed && typeof parsed === 'object') {
                        rules = { domain: [], url: [], css: [], attr: [], nav: [], path: [] };
                        for (const k of Object.keys(rules)) {
                            if (Array.isArray(parsed[k])) rules[k] = parsed[k];
                        }
                    }
                }
            } catch(e){}
        }

        function getRulesSnapshot() {
            return JSON.parse(JSON.stringify(rules));
        }

        // 跨设备迁移：合并导入的 GE 规则，按 ruleKey 去重，保留较高置信度
        function mergeRules(incoming) {
            if (!incoming || typeof incoming !== 'object') return 0;
            let merged = 0;
            for (const type of Object.keys(rules)) {
                if (!Array.isArray(incoming[type])) continue;
                const existing = rules[type];
                const existingKeys = new Set(existing.map(r => r.hostname || r.pattern || r.selector || r.value || ''));
                for (const r of incoming[type]) {
                    if (!r || typeof r !== 'object') continue;
                    const key = r.hostname || r.pattern || r.selector || r.value || '';
                    if (key && !existingKeys.has(key)) {
                        existingKeys.add(key);
                        existing.push(r);
                        merged++;
                    } else if (key) {
                        // 已存在 → 取较高置信度，累加命中数
                        const exist = existing.find(x => (x.hostname || x.pattern || x.selector || x.value || '') === key);
                        if (exist) {
                            exist.confidence = Math.max(exist.confidence || 0, r.confidence || 0);
                            exist.hits = (exist.hits || 0) + (r.hits || 0);
                        }
                    }
                }
                // 容量限制
                if (existing.length > MAX_RULES[type]) {
                    existing.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
                    existing.length = MAX_RULES[type];
                }
            }
            if (merged > 0) _save();
            return merged;
        }

        function matchNavigation(url) {
            if (!url) return { blocked: false };
            try {
                const host = new URL(url, location.href).hostname.toLowerCase();
                for (const r of rules.nav) {
                    if (r.confidence < CONFIDENCE_MIN) continue;
                    if (host === r.hostname || host.endsWith('.' + r.hostname)) {
                        return { blocked: true, rule: r, type: 'nav' };
                    }
                }
            } catch(e){}
            return { blocked: false };
        }

        // 批量落盘：供 NetworkInterceptor 防抖调用，避免每次命中都 _save
        function flush() { _save(); }

        // 清空所有自学习规则（覆盖导入时使用）
        function clearRules() {
            for (const type of Object.keys(rules)) {
                rules[type].length = 0;
            }
            _save();
        }

        return {
            learnFromDomainScan, learnFromOverlayScan, learnFromManualSelect,
            feedbackFalsePositive, feedbackConfirm,
            matchUrl, matchNavigation, getBlockedDomains,
            decay, optimize, getStatus, getRulesSnapshot, mergeRules, clearRules, flush, rules
        };
    })();

    /**
     * ═══════════════════════════════════════════════════════════════
     *  统一调度器：一键扫描 + 学习 + 拦截
     *  仅启用跳转拦截 + 动态学习 + 衰减（fetch/XHR/MutationObserver 由现有
     *  NetworkInterceptor/BlockEngine 负责，避免双重 hook 冲突）
     * ═══════════════════════════════════════════════════════════════
     */
    const AdBlockOrchestrator = (() => {
        let _initialized = false;

        function fullScan() {
            const t0 = performance.now();
            const domainResult = GlobalDomainScanner.scan();
            const overlayResult = OverlayAdScanner.scan();
            const domainLearned = GeneralizationEngine.learnFromDomainScan(domainResult.results);
            const overlayLearned = GeneralizationEngine.learnFromOverlayScan(overlayResult.results);
            GeneralizationEngine.optimize();
            const cleaned = GeneralizationEngine.decay();
            const elapsed = (performance.now() - t0).toFixed(1);
            return {
                domains: domainResult, overlays: overlayResult,
                learned: { domains: domainLearned, overlays: overlayLearned },
                cleaned, engine: GeneralizationEngine.getStatus(), elapsed
            };
        }

        function initRuntime() {
            if (_initialized) return;
            _initialized = true;

            // 跳转拦截（博彩/色情核心防线，现有 NetworkInterceptor 未覆盖 window.open/location/form）
            const blockedDomains = GeneralizationEngine.getBlockedDomains();
            OverlayAdScanner.enableNavigationInterceptor(blockedDomains);

            // 动态插入监控：高分可疑元素 → 自动学习（不重复隐藏，BlockEngine 已处理拦截）
            OverlayAdScanner.startWatching((f) => {
                if (f.suspicion >= 40) {
                    GeneralizationEngine.learnFromOverlayScan([f]);
                }
            });

            // 定期衰减（24h）
            setInterval(() => GeneralizationEngine.decay(), 24 * 3600 * 1000);
        }

        function onUserSelect(element) {
            const learned = GeneralizationEngine.learnFromManualSelect(element);
            return learned;
        }

        return { fullScan, initRuntime, onUserSelect };
    })();

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
            this._actionPreview = { active: false, el: null, elements: [] };
            // 全局域名面板预览状态：必须为实例属性，clearPanel 才能跨面板切换时清理，避免预览隐藏的元素永久残留
            this._globalPreview = { active: false, elements: [] };
            // 覆盖层扫描面板预览状态：同为实例属性，clearPanel 跨面板切换时还原 visibility/display
            this._overlayPreview = { active: false, elements: [] };
            // 手动选区面板域名选择状态：默认全选检测到的域名，用户可逐个取消
            this._actionHosts = null;
            this._actionHostsEl = null;
            this._contextmenuHandler = null;
            this._handleMouseOver = this._handleMouseOver.bind(this);
            this._handleClick = this._handleClick.bind(this);
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

                /* 自动化泛化管理面板 */
                .gen-section { margin-bottom: 12px; }
                .gen-sec-title { font-size: 12px; font-weight: 600; color: #ddd; margin: 8px 0 4px; }
                .gen-rule { font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; color: #ff9f0a; word-break: break-all; }
                .fused-item { opacity: 0.55; }
                .fused-item .gen-rule { color: #aaa; text-decoration: line-through; }
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

        _whenBodyReady(cb) {
            if (document.body) { cb(); return; }
            // 持有 observer 引用，stopSelection 时可取消，避免在停止后仍触发绑定监听器导致泄漏
            this._bodyReadyObserver = new MutationObserver(() => {
                if (document.body) {
                    if (this._bodyReadyObserver) {
                        this._bodyReadyObserver.disconnect();
                        this._bodyReadyObserver = null;
                    }
                    cb();
                }
            });
            this._bodyReadyObserver.observe(document.documentElement, { childList: true });
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
            // 取消尚在等待 body 就绪的 observer，防止 stopSelection 后才触发绑定导致监听器泄漏
            if (this._bodyReadyObserver) {
                this._bodyReadyObserver.disconnect();
                this._bodyReadyObserver = null;
            }
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
            const hideNode = (node) => {
                if (!node || node === document.body || node === document.documentElement) return;
                if (node.style.display === 'none') return;
                node.style.setProperty('display', 'none', 'important');
                node.style.setProperty('opacity', '0', 'important');
                this._actionPreview.elements.push(node);
            };
            const hideResourceAndParent = (target) => {
                hideNode(target);
                if (target.parentElement) hideNode(target.parentElement);
                hideNode(BlockEngine.findSingleChildWrapper(target, 4));
            };
            // 1) 选中域名命中的全页资源（元素 + 父级 + 单子链容器）
            const hosts = Array.from(this._actionHosts || []);
            hosts.forEach(d => {
                const esc = escapeCSSAttr(d);
                const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`;
                document.querySelectorAll(sel).forEach(hideResourceAndParent);
            });
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
                document.querySelectorAll(sel).forEach(hideResourceAndParent);
            });
            // 3) 当前框选的广告容器（正式封杀也会手动隐藏容器）
            hideNode(BlockEngine.findSingleChildWrapper(el, 4));
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
                // 自动学习：用户手动确认 = 高置信度信号（Bug4）
                try { AdBlockOrchestrator.onUserSelect(this.currentSelectedEl); } catch(e){}
                this.clearPanel();
            });

            // 动态类名拦截
            panel.querySelector('#btn-dynamic').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const primaryClass = (typeof el.className === 'string' ? el.className : '').split(/\s+/)[0];
                if (!primaryClass) { alert('当前元素无有效类名，请选择其他拦截方式。'); return; }
                storage.addRule('dynamic', { className: primaryClass, type: 'dynamic' });
                // 自动学习：用户手动确认 = 高置信度信号（Bug4）
                try { AdBlockOrchestrator.onUserSelect(el); } catch(e){}
                this.clearPanel();
            });

            // 物理结构拦截（同时生成拓扑指纹，作为 Selector 失效时的兜底定位）
            panel.querySelector('#btn-struct').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const sel = BlockEngine.generateStructuralSelector(el);
                const topoHash = BlockEngine.generateTopologyFingerprint(el);
                storage.addRule('structural', { structSelector: sel, topoHash, type: 'structural' });
                // 自动学习：用户手动确认 = 高置信度信号（Bug4）
                try { AdBlockOrchestrator.onUserSelect(el); } catch(e){}
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
                    alert('目标元素已从页面移除，请重新选择。');
                    this.clearPanel();
                    return;
                }
                const result = BlockEngine.extractResourceDomains(this.currentSelectedEl, { deep: true });
                if (result.domains.length === 0) {
                    alert('当前框选范围内未发现第三方资源域，无法执行域名封杀。');
                    return;
                }
                const list = Array.from(this._actionHosts || []);
                if (list.length === 0) {
                    alert('已取消全部域名选择，请至少保留一个域名再封杀。');
                    return;
                }
                const confirmMsg = `将封杀以下 ${list.length} 个域名（全局生效，所有页面都将拦截）：\n\n${list.join('\n')}\n\n同时会隐藏当前框选的整个广告容器。确认继续？`;
                if (!confirm(confirmMsg)) return;
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

                // 同步学习到泛化引擎：用户手动确认 = 高置信度信号
                try { AdBlockOrchestrator.onUserSelect(this.currentSelectedEl); } catch(e){}

                // 扫描全页命中选中域名的资源：隐藏元素本身 + 直接父级 + 单子链容器
                // 口径与 applyCSSRules（[src*=domain] 与 *:has(>...)）+ scanAndBlockDynamic
                // （findSingleChildWrapper）完全一致，确保 即时效果=预览=刷新后效果
                const hideNodeInline = (node) => {
                    if (!node || node === document.body || node === document.documentElement) return;
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
                alert(`已封杀 ${list.length} 个域名${pathNote}。\n后续刷新与所有页面都将自动拦截。`);
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
                    alert('目标元素已从页面移除，请重新选择。');
                    this.clearPanel();
                    return;
                }
                this._actionPreview = { active: true, el: null, elements: [] };
                this._applyActionPreviewHiding();
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
            try { gdsResult = GlobalDomainScanner.scan(); } catch(e){}
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
                    <button class="btn-info" id="btn-deep-scan" title="运行三算法联合扫描，将高分域名与博彩色情域自动学习到泛化引擎">🤖 深度学习扫描</button>
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
                    alert(`域名 ${host} 已在黑名单中，无需重复添加。`);
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

            // 深度学习扫描：运行三算法联合全扫，将高分域名与博彩色情域自动学习到 GeneralizationEngine
            panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
                const btn = e.target;
                const origText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 扫描中...';
                setTimeout(() => {
                    try {
                        const result = AdBlockOrchestrator.fullScan();
                        // 扫描后重新合并数据并刷新列表
                        // 重新读取已封杀域名集合：深度扫描期间用户可能已在其他面板封杀域名（Bug3）
                        const currentBlocked = new Set(storage.getDomainBlocks().map(r => r.domain));
                        // 清理 allDomains 中已被封杀的域名（用户在扫描期间封杀的）
                        allDomains = allDomains.filter(d => !currentBlocked.has(d.host));
                        const newGds = GlobalDomainScanner.scan();
                        const newMap = new Map();
                        for (const r of newGds.results) newMap.set(r.hostname, r);
                        for (const g of newMap.values()) {
                            // 跳过已封杀域名，避免已封杀规则再次出现在检测界面（Bug3）
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
                        const learned = result.learned.domains + result.learned.overlays;
                        alert(`深度扫描完成（耗时 ${result.elapsed}ms）\n\n域名检索：${result.domains.total} 个\n覆盖层：${result.overlays.total} 个\n本次学习：${learned} 条规则\n清理过期：${result.cleaned} 条\n\n泛化引擎现有：${result.engine.totalRules} 条规则，平均置信度 ${result.engine.avgConfidence}`);
                    } catch (err) {
                        btn.disabled = false;
                        btn.textContent = origText;
                        alert('深度扫描失败：' + err.message);
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
                const hideNode = (node) => {
                    if (!node || node === document.body || node === document.documentElement) return;
                    if (node.style.display === 'none') return;
                    node.style.setProperty('display', 'none', 'important');
                    node.style.setProperty('opacity', '0', 'important');
                    this._globalPreview.elements.push(node);
                };
                selectedHosts.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                        hideNode(el);
                        if (el.parentElement) hideNode(el.parentElement);
                        hideNode(BlockEngine.findSingleChildWrapper(el, 4));
                    });
                });
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
                previewBtn.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-block-global').addEventListener('click', () => {
                if (selectedHosts.size === 0) return;
                const list = Array.from(selectedHosts);
                if (!confirm(`将封杀以下 ${list.length} 个域名（全局生效，所有页面都将拦截）：\n\n${list.join('\n')}\n\n确认继续？`)) return;
                resetGlobalPreview();
                list.forEach(d => storage.addRule('domainBlock', { domain: d, type: 'domainBlock' }));
                list.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(el => {
                        const t = BlockEngine.findSingleChildWrapper(el, 4);
                        t.style.setProperty('display', 'none', 'important');
                        t.style.setProperty('opacity', '0', 'important');
                    });
                });
                // 同步学习到泛化引擎：用户确认封杀 = 高置信度信号（Bug4）
                // 仅学习选中域名，避免 fullScan 的全量开销
                try {
                    const learnable = allDomains.filter(d => selectedHosts.has(d.host)).map(d => ({
                        hostname: d.host, level: d.viceToken ? 'ad' : (d.score >= 50 ? 'ad' : 'suspect'),
                        adToken: d.adToken, viceToken: d.viceToken,
                        imageBehavior: 0, redirectChain: 0
                    }));
                    GeneralizationEngine.learnFromDomainScan(learnable);
                } catch(e){}
                this._globalPreview = { active: false, elements: [] };
                this.clearPanel();
                alert(`已封杀 ${list.length} 个域名，后续刷新与所有页面都将自动拦截。`);
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
                    if (!text) { alert('校验失败：请输入路径片段。'); return; }
                    const esc = escapeCSSAttr(text);
                    const sel = `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [data-href*="${esc}"], [data-url*="${esc}"], [data-link*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`;
                    let hit = 0;
                    const hideNode = (node) => {
                        if (!node || node === document.body || node === document.documentElement) return false;
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
                    if (hit === 0) { alert('当前页面未匹配到含该路径片段的资源，预览为空。'); return; }
                    isPreviewing = true;
                    e.target.textContent = '👁 恢复显示';
                    return;
                }

                if (mode === 'attribute') {
                    const text = panel.querySelector('#attr-input').value.trim();
                    if (!text) { alert('校验失败：请输入属性选择器。'); return; }
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
                    BlockEngine.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
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
                    // 正则模式保存前校验语法，与预览路径一致；非法正则会被 applyRegexRules 静默丢弃
                    if (mode === 'regex') {
                        try { new RegExp(regexRule); }
                        catch (e) { alert('校验失败：正则表达式语法错误。\n' + e.message); return; }
                    }

                    storage.addRule('regex', { regex: regexRule, level: level, type: 'regex' });
                    BlockEngine.applyRegexRules();
                }

                this.clearPanel();
            });

            panel.querySelector('#btn-close-regex').addEventListener('click', () => this.clearPanel());
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
                    <button class="btn-info" id="btn-gen">🤖 自动化泛化规则</button>
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
                    content: escapeHTML(r.domain), ts: r._ts || 0, value: r.domain
                }));
                // 2. 本站 7 类规则
                ['static', 'dynamic', 'regex', 'attribute', 'structural', 'complex', 'pathPattern'].forEach(type => {
                    (d[type] || []).forEach((r, i) => recs.push({
                        scope: 'current', domain: storage.domain, index: i, type,
                        content: formatRuleContent(type, r), ts: r._ts || 0,
                        value: (type === 'pathPattern') ? (r.pattern || '') : ''
                    }));
                });
                // 3. 其他站点规则（跨站，排除本站以免重复）
                storage.getAllSiteRules().forEach(rec => {
                    if (rec.domain === storage.domain) return;
                    recs.push({
                        scope: 'other', domain: rec.domain, index: rec.index, type: rec.type,
                        content: formatRuleContent(rec.type, rec.rule), ts: rec.rule._ts || 0,
                        value: (rec.type === 'pathPattern') ? (rec.rule.pattern || '') : ''
                    });
                });
                // 按 _ts 倒序：最近过滤的规则置顶（问题3&7）
                recs.sort((a, b) => b.ts - a.ts);
                return recs;
            };

            let filterScope = 'all';
            let filterType = '';
            let filterText = '';
            let records = buildRecords();

            const renderList = () => {
                const list = panel.querySelector('#mgr-list');
                const stats = panel.querySelector('#mgr-stats');
                const countEl = panel.querySelector('#mgr-domain-count');
                if (countEl) countEl.textContent = records.filter(r => r.scope === 'global').length;
                if (!list) return;
                const filtered = records.filter(rec => {
                    if (filterScope !== 'all' && rec.scope !== filterScope) return false;
                    if (filterType && rec.type !== filterType) return false;
                    if (filterText) {
                        const hay = (rec.domain + ' ' + (TYPE_META[rec.type] ? TYPE_META[rec.type].label : '') + ' ' + rec.content).toLowerCase();
                        if (!hay.includes(filterText)) return false;
                    }
                    return true;
                });
                if (stats) stats.textContent = `共 ${records.length} 条 · 当前显示 ${filtered.length} 条（最近过滤置顶，点击删除即时生效）`;
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
                    return `<li class="rule-item">
                        <div class="rule-content">
                            ${siteBadge}<span class="tag ${meta.tag}">${meta.label}</span> ${rec.content}
                        </div>
                        <button class="btn-danger btn-delete" style="flex:none; width:60px; padding: 6px;" data-scope="${rec.scope}" data-domain="${escapeHTML(rec.domain)}" data-type="${rec.type}" data-index="${rec.index}" data-value="${escapeHTML(rec.value || '')}">删除</button>
                    </li>`;
                }).join('');
            };
            renderList();

            // 过滤器事件
            panel.querySelector('#mgr-scope-filter').addEventListener('change', (e) => { filterScope = e.target.value; renderList(); });
            panel.querySelector('#mgr-type-filter').addEventListener('change', (e) => { filterType = e.target.value; renderList(); });
            panel.querySelector('#mgr-filter').addEventListener('input', (e) => { filterText = e.target.value.trim().toLowerCase(); renderList(); });

            // 删除：事件委托，按归属调用对应删除 API，并还原内联隐藏 + 强制重扫确保即时生效（问题2&5）
            // 删除后仅重渲染列表（不重建面板），保留过滤态与滚动位置，连续删除无需重开面板（问题3）
            panel.querySelector('#mgr-list').addEventListener('click', (e) => {
                const btn = e.target.closest('.btn-delete');
                if (!btn) return;
                const scope = btn.getAttribute('data-scope');
                const domain = btn.getAttribute('data-domain');
                const type = btn.getAttribute('data-type');
                const index = parseInt(btn.getAttribute('data-index'), 10);
                const value = btn.getAttribute('data-value') || '';
                const scrollBox = panel.querySelector('#mgr-list').parentElement;
                const savedScroll = scrollBox ? scrollBox.scrollTop : 0;

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
                records = buildRecords();
                renderList();
                requestAnimationFrame(() => { if (scrollBox) scrollBox.scrollTop = savedScroll; });
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
                alert(`策略已调整为：${newMode === 'preemptive' ? '极速预判模式（多时序重扫，防首屏闪现）' : '智能自动模式（观察器实时拦截）'}\n页面即将刷新以应用变更配置。`);
                window.location.reload();
            });

            const resetBtn = panel.querySelector('#btn-reset-flash');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    if (confirm('确认清除本站的闪现标记？清除后将恢复"智能自动"模式（除非你手动开启极速预判）。')) {
                        storage.resetFlash();
                        alert('闪现标记已清除，页面即将刷新。');
                        window.location.reload();
                    }
                });
            }

            panel.querySelector('#btn-export').addEventListener('click', () => this.showExportPanel());
            panel.querySelector('#btn-import').addEventListener('click', () => this.showImportPanel());
            panel.querySelector('#btn-ag-export').addEventListener('click', () => this.showAdGuardExportPanel());
            panel.querySelector('#btn-gen').addEventListener('click', () => this.showGeneralizationPanel());

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
                <p>下方文本框包含全部拦截规则、全局域名黑名单、正常路径采集数据与泛化引擎自学习规则（置信度追踪）。复制后保存到任意位置，或在新设备的脚本中通过"导入规则"粘贴即可。</p>
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

        generateAdGuardRules(options = {}) {
            const { includeGE = true } = options;
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

            // GeneralizationEngine 自学习规则导出（置信度 ≥ 0.5 的规则才输出）
            // 可通过选项 includeGE=false 跳过（用户在面板可切换）
            if (includeGE) try {
                const geRules = GeneralizationEngine.getRulesSnapshot();
                const geLines = [];
                const isValidHost = (h) => typeof h === 'string' && h.length > 0 && h.length < 200 && !/\s/.test(h);
                // 域名规则 → ||hostname^$third-party
                (geRules.domain || []).filter(r => r.confidence >= 0.5 && isValidHost(r.hostname)).forEach(r => {
                    geLines.push(`||${r.hostname}^$third-party`);
                });
                // 跳转拦截规则 → ||hostname^$third-party
                (geRules.nav || []).filter(r => r.confidence >= 0.5 && isValidHost(r.hostname)).forEach(r => {
                    geLines.push(`||${r.hostname}^$third-party`);
                });
                // URL 正则规则 → AdGuard 正则基本规则（必须用 /.../ 定界符）
                (geRules.url || []).filter(r => r.confidence >= 0.5 && r.pattern).forEach(r => {
                    try { new RegExp(r.pattern); geLines.push(`/${escapeAdGuardRegex(r.pattern)}/`); } catch(e){}
                });
                // CSS 选择器规则 → 全站元素隐藏
                // 含扩展伪类（:has / :has-text 等）时必须用 #?# 标记，否则 AdGuard 视为非法 CSS（Bug4.1）
                (geRules.css || []).filter(r => r.confidence >= 0.5 && r.selector).forEach(r => {
                    const hasExtended = /:has\(|:has-text\(|:not\(:has/.test(r.selector);
                    geLines.push(`${hasExtended ? '#?#' : '##'}${r.selector}`);
                });
                // 属性规则 → 全站属性选择器隐藏
                (geRules.attr || []).filter(r => r.confidence >= 0.5 && r.value && /^[a-zA-Z-]+$/.test(r.attr || '')).forEach(r => {
                    const tag = r.tag && r.tag !== '*' && /^[a-zA-Z]+$/.test(r.tag) ? r.tag : '';
                    geLines.push(`##${tag}[${r.attr}*="${escapeCssValue(r.value)}"]`);
                });
                // 路径规则 → 元素隐藏规则（与 pathPattern 同口径，避免裸 URL 拦截误杀全站资源 Bug4.2）
                (geRules.path || []).filter(r => r.confidence >= 0.5 && r.pattern).forEach(r => {
                    const esc = escapeCssValue(r.pattern);
                    const sel = `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
                    geLines.push(`##${sel}`);
                    geLines.push(`#?#*:has(> :is(${sel}))`);
                });
                if (geLines.length > 0) {
                    lines.push('! GeneralizationEngine 自学习规则（置信度 ≥ 0.5）');
                    geLines.forEach(l => lines.push(l));
                    lines.push('');
                }
            } catch(e){}

            return lines.join('\n');
        }

        showAdGuardExportPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            // 默认包含 GE 规则；用户可通过复选框切换，切换后实时重新生成
            let includeGE = true;
            let rulesText = this.generateAdGuardRules({ includeGE });

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">🛡️ 导出 AdGuard 规则</h3>
                <p class="hint-text">已将当前所有拦截规则转换为 AdGuard / uBlock Origin 兼容语法。元素隐藏规则 (## / #?#) 可导入 AdGuard 浏览器扩展或 uBlock Origin；全局域名拦截段含 DNS 兼容版 (||domain^)，可导入 AdGuard DNS / AdGuard Home。</p>
                <label style="display:flex; align-items:center; gap:6px; margin:8px 0; font-size:12px; color:#ddd; cursor:pointer;">
                    <input type="checkbox" id="ag-include-ge" checked style="cursor:pointer;" />
                    <span>包含泛化引擎自学习规则（置信度 ≥ 0.5 的 domain/url/css/attr/nav/path）</span>
                </label>
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
            const geCheckbox = panel.querySelector('#ag-include-ge');
            box.value = rulesText;

            // 切换 GE 规则开关：实时重新生成并刷新文本框
            geCheckbox.addEventListener('change', (e) => {
                includeGE = e.target.checked;
                rulesText = this.generateAdGuardRules({ includeGE });
                box.value = rulesText;
            });

            panel.querySelector('#btn-ag-copy').addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(rulesText);
                    alert('AdGuard 规则已复制到剪贴板！');
                } catch (e) {
                    box.select();
                    try { document.execCommand('copy'); alert('AdGuard 规则已复制到剪贴板！'); }
                    catch (e2) { alert('复制失败，请手动选中文本复制。'); }
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
            // 过滤策略：已封杀域名对应的元素 / 已被脚本隐藏的元素 不再重复展示（Bug3）
            const collectAll = () => {
                const blockedDomains = new Set(storage.getDomainBlocks().map(r => r.domain));
                const beRecords = BlockEngine.scanInvisibleOverlays({ autoBlock: false });
                let oasResult = { results: [], elapsed: '0', total: 0 };
                try { oasResult = OverlayAdScanner.scan(); } catch(e){}
                // 以元素引用为 key 建立 OverlayAdScanner 特征索引
                const oasMap = new Map();
                for (const r of (oasResult.results || [])) {
                    if (r.el) oasMap.set(r.el, r);
                }

                // 判定元素是否已被封杀（域名已在黑名单 或 元素已被脚本隐藏）
                const isAlreadyBlocked = (rec) => {
                    if (rec.triggerUrl) {
                        try {
                            const h = new URL(rec.triggerUrl, location.href).hostname;
                            if (blockedDomains.has(h)) return true;
                        } catch(e){}
                    }
                    // 内联隐藏（脚本封杀后打的内联样式）
                    if (rec.el && rec.el.style && rec.el.style.getPropertyPriority('display') === 'important' && rec.el.style.display === 'none') return true;
                    // CSS 规则隐藏：OAS 独有结果未经过 BlockEngine 的 getComputedStyle 过滤（Bug1）
                    // 通过计算样式检查，避免已封杀的元素再次出现在扫描列表
                    if (rec.el && document.contains(rec.el)) {
                        try {
                            const cs = window.getComputedStyle(rec.el);
                            if (cs.display === 'none' || cs.visibility === 'hidden') return true;
                        } catch(e){}
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
                    const rect = oas.el.getBoundingClientRect ? oas.el.getBoundingClientRect() : { width:0, height:0, top:0, left:0 };
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

            let { records, oasElapsed } = collectAll();
            let selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
            let onlyHigh = false;

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
                    box.innerHTML = '<span class="info-label" style="color:#bbb;">未发现不可见覆盖层广告。可尝试取消"只看高风险"或使用"深度学习扫描"。</span>';
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
                    <button class="btn-info" id="btn-deep-scan" title="运行三算法联合扫描，将高嫌疑元素自动学习到泛化引擎">🤖 深度学习扫描</button>
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
                this._overlayPreview.hiddenDomains.forEach(d => {
                    const esc = escapeCSSAttr(d);
                    document.querySelectorAll(`[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [srcset*="${esc}"], [poster*="${esc}"]`).forEach(target => {
                        const hideNode = (node) => {
                            if (!node || node === document.body || node === document.documentElement) return;
                            if (node.style.display === 'none') return;
                            node.style.setProperty('display', 'none', 'important');
                            node.style.setProperty('opacity', '0', 'important');
                            this._overlayPreview.elements.push(node);
                        };
                        hideNode(target);
                        if (target.parentElement) hideNode(target.parentElement);
                        hideNode(BlockEngine.findSingleChildWrapper(target, 4));
                    });
                });
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

            // 深度学习扫描：运行三算法联合全扫，将高嫌疑元素自动学习到 GeneralizationEngine
            panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
                const btn = e.target;
                const origText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 扫描中...';
                setTimeout(() => {
                    try {
                        const result = AdBlockOrchestrator.fullScan();
                        // 扫描后重新采集并刷新列表
                        const collected = collectAll();
                        records = collected.records;
                        selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
                        updatePreview();
                        render();
                        btn.disabled = false;
                        btn.textContent = origText;
                        const learned = result.learned.domains + result.learned.overlays;
                        alert(`深度扫描完成（耗时 ${result.elapsed}ms）\n\n覆盖层：${result.overlays.total} 项\n本次学习：${learned} 条规则\n清理过期：${result.cleaned} 条\n\n泛化引擎现有：${result.engine.totalRules} 条规则，平均置信度 ${result.engine.avgConfidence}`);
                    } catch (err) {
                        btn.disabled = false;
                        btn.textContent = origText;
                        alert('深度扫描失败：' + err.message);
                    }
                }, 50);
            });

            // 预览效果：预览「隐藏选中覆盖层 + 勾选域名时全页该域资源也被隐藏」，与正式拦截效果一致
            // 激活后选择变化自动实时更新预览（Bug1&2），再次点击关闭预览
            previewBtn.addEventListener('click', () => {
                if (this._overlayPreview.active) {
                    resetOverlayPreview();
                    return;
                }
                if (selectedSet.size === 0) {
                    alert('请先选择需要预览的覆盖层。');
                    return;
                }
                this._overlayPreview = { active: true, elements: [], hiddenDomains: new Set() };
                updatePreview();
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
                // 仅修改 record 属性不删除数组元素，无需降序遍历；直接 forEach
                Array.from(selectedSet).forEach(idx => {
                    const r = records[idx];
                    if (!r || !r.el || !document.contains(r.el)) return;
                    r.el.style.setProperty('display', 'none', 'important');
                    r.el.style.setProperty('pointer-events', 'none', 'important');
                    r.el.style.setProperty('visibility', 'hidden', 'important');
                    r.blocked = true;
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
                // 同步学习到泛化引擎（用户确认拦截 = 高置信度信号）
                try {
                    const learnable = Array.from(selectedSet).map(idx => records[idx]).filter(r => r.el);
                    GeneralizationEngine.learnFromOverlayScan(learnable.map(r => ({
                        el: r.el, suspicion: r.suspicion || 50, selector: r.selector,
                        category: r.category, features: r.features, reasons: r.oasReasons
                    })));
                } catch(e){}
                selectedSet.clear();
                render();
                const domainNote = blockDomainToo ? `，${domainCount} 个跨域跳转域名已加入全局黑名单` : '（未封杀域名）';
                alert(`已拦截选中的覆盖层${domainNote}。`);
            });

            panel.querySelector('#btn-rescan').addEventListener('click', () => {
                resetOverlayPreview();
                const collected = collectAll();
                records = collected.records;
                selectedSet = new Set(records.filter(r => r.highRisk).map((r, i) => i));
                updatePreview();
                render();
            });

            panel.querySelector('#btn-close-overlay').addEventListener('click', () => this.clearPanel());
        }

        // 自动化泛化规则管理面板：展示双轨（域名/路径）泛化结果与熔断日志，支持删除与重新泛化
        showGeneralizationPanel() {
            this.clearPanel();
            const panel = document.createElement('div');
            panel.className = 'panel';

            // GeneralizationEngine 规则类型元数据
            const GE_TYPES = [
                { key: 'domain', label: '🌐 域名黑名单', icon: '🌐' },
                { key: 'url', label: '🔗 URL 正则', icon: '🔗' },
                { key: 'css', label: '🎨 CSS 选择器', icon: '🎨' },
                { key: 'attr', label: '🏷️ 属性匹配', icon: '🏷️' },
                { key: 'nav', label: '🚫 跳转拦截', icon: '🚫' },
                { key: 'path', label: '📂 路径模式', icon: '📂' }
            ];
            const sourceLabel = (src) => ({ 'domain_scan':'域名检索', 'overlay_scan':'覆盖层扫描', 'manual':'手动选择', 'generalization':'智能泛化' }[src] || src);
            const ruleKey = (r) => r.hostname || r.pattern || r.selector || r.value || '';

            // 仅重渲染列表容器，不重置整个 panel，避免重复 makeDraggable 导致监听器泄漏
            const renderList = () => {
                // ① AutoGeneralizer 双轨（域名/路径/熔断）
                const data = storage.getGeneralized();
                const fillList = (ulId, arr, type, allowDelete) => {
                    const ul = panel.querySelector('#' + ulId);
                    if (!ul) return;
                    if (!arr || arr.length === 0) {
                        ul.innerHTML = '<li class="empty-tip">暂无规则。新增 ≥3 个同基域名或 ≥3 个同结构路径后将自动生成。</li>';
                        return;
                    }
                    ul.innerHTML = arr.map((r, i) => `
                        <li class="rule-item${type === 'fused' ? ' fused-item' : ''}">
                            <div class="rule-content">
                                <span class="gen-rule">${escapeHTML(r.rule || '')}</span>
                                <span class="as-site" style="margin-left:6px;">${escapeHTML(r.meta || '')}</span>
                            </div>
                            ${allowDelete ? `<button class="btn-danger btn-delete" style="flex:none; width:60px; padding:6px;" data-type="${type}" data-index="${i}">删除</button>` : ''}
                        </li>
                    `).join('');
                };
                fillList('gen-domain-list', data.domain, 'domain', true);
                fillList('gen-path-list', data.path, 'path', true);
                fillList('gen-fused-list', data.fused, 'fused', false);

                const agStats = panel.querySelector('#ag-stats');
                if (agStats) {
                    agStats.textContent = `域名轨 ${data.domain.length} 条 · 路径轨 ${data.path.length} 条 · 熔断 ${data.fused.length} 条`;
                }

                // ② GeneralizationEngine 学习的规则
                let geStatus = { counts: {}, totalRules: 0, totalHits: 0, avgConfidence: 0 };
                let geRules = { domain: [], url: [], css: [], attr: [], nav: [], path: [] };
                try {
                    geStatus = GeneralizationEngine.getStatus();
                    geRules = GeneralizationEngine.getRulesSnapshot();
                } catch(e){}

                const geStats = panel.querySelector('#ge-stats');
                if (geStats) {
                    geStats.textContent = `共 ${geStatus.totalRules} 条 · 总命中 ${geStatus.totalHits} 次 · 平均置信度 ${geStatus.avgConfidence}`;
                }

                // 渲染各类型规则
                for (const { key } of GE_TYPES) {
                    const ul = panel.querySelector('#ge-' + key + '-list');
                    if (!ul) continue;
                    const arr = geRules[key] || [];
                    if (arr.length === 0) {
                        ul.innerHTML = '<li class="empty-tip">暂无。深度扫描或手动拦截后将自动学习。</li>';
                        continue;
                    }
                    ul.innerHTML = arr.map((r, i) => {
                        const k = escapeHTML(ruleKey(r));
                        const conf = (r.confidence || 0).toFixed(2);
                        const hits = r.hits || 0;
                        const src = sourceLabel(r.source);
                        const confClass = r.confidence >= 0.8 ? 'high' : r.confidence >= 0.5 ? 'mid' : 'low';
                        const reason = r.reason ? ` · ${escapeHTML(r.reason)}` : '';
                        return `<li class="rule-item">
                            <div class="rule-content">
                                <span class="gen-rule">${k}</span>
                                <span class="gd-score ${confClass}" style="margin-left:6px;">${conf}</span>
                                <span class="as-site" style="margin-left:6px;">${src} · ×${hits}${reason}</span>
                            </div>
                            <button class="btn-danger btn-ge-delete" style="flex:none; width:60px; padding:6px;" data-type="${key}" data-key="${escapeHTML(ruleKey(r))}">删除</button>
                        </li>`;
                    }).join('');
                }
            };

            panel.innerHTML = `
                <h3 title="按住可拖动窗口">🤖 自动化泛化规则</h3>
                <p>双轨自动推导：域名轨用反向基数树将 ≥3 个同基子域收敛为 <code>*.base</code>（覆盖收益比 > 60% 才输出）；路径轨用结构指纹聚类将 ≥3 个同结构路径归并为 <code>/a/*/b</code>，仅 NUM/HEX 位置通配，误杀率 > 30% 拒绝输出。泛化规则自动接入网络层与 DOM 扫描拦截，规则增删后会自动重新泛化。</p>
                <div class="gd-stats" id="ge-stats"></div>
                <div class="gen-section">
                    <div class="gen-sec-title">🧠 GeneralizationEngine 自学习规则（置信度追踪 · 自动衰减）</div>
                    ${GE_TYPES.map(t => `
                        <div style="margin-top:6px;">
                            <div class="gen-sec-title" style="font-size:11px; color:#aaa;">${t.label}</div>
                            <ul class="rule-list" id="ge-${t.key}-list"></ul>
                        </div>
                    `).join('')}
                </div>
                <div class="section-divider"></div>
                <div class="gen-section">
                    <div class="gen-sec-title">🌐 域名轨 (Reverse Trie) · AutoGeneralizer</div>
                    <div class="gd-stats" id="ag-stats"></div>
                    <ul class="rule-list" id="gen-domain-list"></ul>
                </div>
                <div class="gen-section">
                    <div class="gen-sec-title">📂 路径轨 (结构指纹聚类) · AutoGeneralizer</div>
                    <ul class="rule-list" id="gen-path-list"></ul>
                </div>
                <div class="gen-section">
                    <div class="gen-sec-title">⚠️ 熔断日志 (防误杀，已自动废弃)</div>
                    <ul class="rule-list" id="gen-fused-list"></ul>
                </div>
                <div class="section-divider"></div>
                <div class="btn-group">
                    <button class="btn-info" id="gen-deep-scan" title="运行三算法联合扫描，自动学习规则到泛化引擎">🤖 深度学习扫描</button>
                    <button class="btn-primary" id="gen-rebuild">🔄 重新泛化</button>
                    <button class="btn-warning" id="gen-refresh">刷新列表</button>
                </div>
                <div class="btn-group">
                    <button class="btn-outline" id="gen-back">返回管理</button>
                    <button class="btn-outline" id="gen-close">关闭</button>
                </div>
            `;

            this.makeDraggable(panel);
            this.shadowRoot.appendChild(panel);
            renderList();

            // 深度学习扫描：运行三算法联合全扫，将结果学习到 GeneralizationEngine
            panel.querySelector('#gen-deep-scan').addEventListener('click', (e) => {
                const btn = e.target;
                const origText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳ 扫描中...';
                setTimeout(() => {
                    try {
                        const result = AdBlockOrchestrator.fullScan();
                        renderList();
                        btn.disabled = false;
                        btn.textContent = origText;
                        const learned = result.learned.domains + result.learned.overlays;
                        alert(`深度扫描完成（耗时 ${result.elapsed}ms）\n\n域名检索：${result.domains.total} 个\n覆盖层：${result.overlays.total} 项\n本次学习：${learned} 条规则\n清理过期：${result.cleaned} 条\n\n泛化引擎现有：${result.engine.totalRules} 条规则，平均置信度 ${result.engine.avgConfidence}`);
                    } catch (err) {
                        btn.disabled = false;
                        btn.textContent = origText;
                        alert('深度扫描失败：' + err.message);
                    }
                }, 50);
            });

            // 重新泛化：同步触发 AutoGeneralizer.run()，立即刷新列表
            panel.querySelector('#gen-rebuild').addEventListener('click', () => {
                AutoGeneralizer.run();
                renderList();
                alert('已重新泛化，结果已更新。');
            });
            panel.querySelector('#gen-refresh').addEventListener('click', renderList);
            panel.querySelector('#gen-back').addEventListener('click', () => this.showManager());
            panel.querySelector('#gen-close').addEventListener('click', () => this.clearPanel());

            // 事件委托：删除 AutoGeneralizer 域名/路径轨规则（熔断日志不可删）
            const delegate = (ulId) => {
                panel.querySelector('#' + ulId).addEventListener('click', (e) => {
                    const btn = e.target.closest('.btn-delete');
                    if (!btn) return;
                    const type = btn.getAttribute('data-type');
                    const index = parseInt(btn.getAttribute('data-index'), 10);
                    if (!confirm(`确认删除泛化规则 #${index}（${type}）？删除后该规则不再参与拦截。`)) return;
                    storage.removeGeneralizedRule(type, index);
                    renderList();
                });
            };
            delegate('gen-domain-list');
            delegate('gen-path-list');

            // 事件委托：标记 GeneralizationEngine 规则为误报（降低置信度，低于阈值自动清除）
            for (const { key } of GE_TYPES) {
                const ul = panel.querySelector('#ge-' + key + '-list');
                if (!ul) continue;
                ul.addEventListener('click', (e) => {
                    const btn = e.target.closest('.btn-ge-delete');
                    if (!btn) return;
                    const type = btn.getAttribute('data-type');
                    const ruleKeyVal = btn.getAttribute('data-key');
                    if (!confirm(`确认删除此 ${type} 规则？\n\n规则：${ruleKeyVal}\n\n删除后该规则不再参与拦截。`)) return;
                    try {
                        GeneralizationEngine.feedbackFalsePositive(type, ruleKeyVal);
                        renderList();
                    } catch(err) {
                        alert('操作失败：' + err.message);
                    }
                });
            }
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
                    const ok = storage.importAll(text, mode === 'merge');
                    if (ok === false) return; // 用户取消覆盖导入确认，不提示成功也不刷新
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

    // 网络层拦截须最先执行：在页面任何 fetch/XHR/script 加载前完成 hook，确保广告请求被源头丢弃
    NetworkInterceptor.init();
    // Shadow DOM 穿透须在页面脚本调用 attachShadow 前完成代理
    BlockEngine.hookAttachShadow();
    // 旧版明文拓扑指纹迁移至 MurmurHash3（一次性，幂等）
    BlockEngine.migrateTopoHashes();
    BlockEngine.fastInject();
    BlockEngine.startObserver();
    // 三算法协同：跳转拦截（window.open/location/form）+ 动态学习 + 衰减
    // 与 NetworkInterceptor/BlockEngine 并行，补充博彩色情跳转拦截与自学习能力
    AdBlockOrchestrator.initRuntime();

    if (window.self === window.top) {
        let uiInstance = null;
        function getUI() {
            if (!uiInstance) uiInstance = new UIManager();
            return uiInstance;
        }

        GM_registerMenuCommand('🖱 手动选择屏蔽元素', () => getUI().startSelection());
        GM_registerMenuCommand('📝 添加文本/正则/积木/属性/路径规则', () => getUI().showRegexPanel());
        GM_registerMenuCommand('🌐 全局检索域名', () => getUI().showGlobalDomainPanel());
        GM_registerMenuCommand('👁 扫描不可见覆盖层广告', () => getUI().showOverlayScanPanel());
        GM_registerMenuCommand('🤖 自动化泛化规则', () => getUI().showGeneralizationPanel());
        GM_registerMenuCommand('⚙️ 管理规则与防御策略', () => getUI().showManager());
        GM_registerMenuCommand('📤 导出规则（跨设备迁移）', () => getUI().showExportPanel());
        GM_registerMenuCommand('🛡️ 导出 AdGuard 规则', () => getUI().showAdGuardExportPanel());
        GM_registerMenuCommand('📥 导入规则', () => getUI().showImportPanel());
    }

})();
