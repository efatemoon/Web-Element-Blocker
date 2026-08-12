// ==UserScript==
// @name         网页元素屏蔽器
// @namespace    http://tampermonkey.net/
// @version      3.3.0
// @description  三层架构 v2.1：FrameDetector 独立模块（帧发现与同域判定）。
//               Engine Layer 包含：NetworkEngine（网络请求拦截）、DOMScanner（动态节点扫描）、
//               CSSEngine（CSS 规则注入）、FrameDetector（iframe 帧发现）、
//               IframeGuard（iframe 分类决策）、IframeDeepScanner（帧内深扫）、FrameMessenger（跨域通信）。
//               iframe 防线 v3.0：正文保护铁律、冻结测量防振荡、帧内深扫、双路径决策（同域递归+跨域上报）。
//               v0.12.0：FrameDetector 独立化——从 IframeGuard 提取帧发现逻辑，通过 EventBus 事件通信；
//               启动顺序：FrameDetector → IframeGuard；模块依赖更清晰。
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

/**
 * 架构总览 v2.1
 *
 * 三层架构（低耦合）：
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  UI Layer（面板层）                                              │
 * │  UIManager + EventBus                                          │
 * │  依赖：所有 Engine 模块                                        │
 * └─────────────────────────────────────────────────────────────────┘
 *                              ↓ EventBus 事件驱动
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Engine Layer（引擎层）                                          │
 * │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
 * │  │ NetworkEngine │  │  DOMScanner   │  │    CSSEngine         │ │
 * │  │ (网络拦截)    │  │ (动态扫描)    │  │  (CSS 规则注入)      │ │
 * │  └──────────────┘  └──────────────┘  └──────────────────────┘ │
 * │                          ↓                                      │
 * │  ┌──────────────┐  ┌──────────────────────────────────────┐   │
 * │  │ FrameDetector │  │         IframeGuard                  │   │
 * │  │ (帧发现)      │──│  ┌──────────┐ ┌──────────┐          │   │
 * │  │ frame:new     │  │  │Classifier│ │DeepScan  │          │   │
 * │  │ frame:same    │  │  │(分类器)   │ │(帧内深扫) │          │   │
 * │  │ frame:diff    │  │  └──────────┘ └──────────┘          │   │
 * │  └──────────────┘  │         FrameMessenger(跨域通信)     │   │
 * │                    └──────────────────────────────────────┘   │
 * └─────────────────────────────────────────────────────────────────┘
 *                              ↓
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Storage Layer（存储层）                                         │
 * │  StorageManager（规则 CRUD + 持久化）                           │
 * │  WhitelistStore（iframe 白名单）                               │
 * │  依赖：GM_setValue / GM_getValue                               │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 启动顺序：
 *   NetworkInterceptor.init() → BlockEngine.hookAttachShadow() → BlockEngine.fastInject()
 *   → BlockEngine.startObserver() → FrameDetector.init() → IframeGuard.init()
 *
 * 模块依赖关系：
 *   FrameDetector ──(frame:new)──> IframeGuard
 *   IframeGuard ──(iframe:blocked/protected)──> UIManager
 *   ContentClassifier ──(classify)──> IframeGuard
 *   FrameMessenger ──(postMessage)──> IframeGuard
 *
 * 核心设计原则：
 * 1. 正文保护铁律：contentScore > 60 → 仅清理内部广告，绝不整体隐藏 iframe
 * 2. 冻结测量防振荡：首次几何值缓存，避免 hidden→重测→分数变化→恢复的循环
 * 3. 粘性判定：blocked/manual 状态跨扫描保留，除非白名单
 * 4. 双路径决策：同域递归深扫 + 跨域 postMessage 上报
 * 5. 用户规则优先：iframeBlock 规则 > 白名单 > 自动分类
 */

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

    // ─── 日志工具：统一错误处理，避免空catch块掩盖错误 ───
    const Log = {
        _tag: '[Pro Blocker]',
        _enabled: true,
        info(...args) {
            if (!this._enabled) return;
            try { console.info(this._tag, ...args); } catch (e) { Log.warn(e.message || e); }
        },
        // 安全日志：失败时不抛出，仅记录警告
        warn(...args) {
            if (!this._enabled) return;
            try { console.warn(this._tag, ...args); } catch (e) { Log.warn(e.message || e); }
        },
        error(...args) {
            if (!this._enabled) return;
            try { console.error(this._tag, ...args); } catch (e) { Log.warn(e.message || e); }
        },
        // 包装函数：自动捕获异常并记录
        wrap(fn, name = 'anonymous') {
            return function (...args) {
                try {
                    return fn.apply(this, args);
                } catch (e) {
                    Log.error(name + ' 执行失败:', e);
                    return null;
                }
            };
        },
        // 空catch块替代：安全执行，失败时记录警告
        safe(fn, name = 'operation') {
            try {
                return fn();
            } catch (e) {
                Log.warn(name + ' 异常:', e.message || e);
                return undefined;
            }
        }
    };

    // safeExecute: 统一错误处理包装器，替代重复的 catch (e) { Log.warn(...) } 模式
    function safeExecute(fn, name = 'operation') {
        try {
            return fn();
        } catch (e) {
            Log.warn(name + ' 异常:', e.message || e);
        }
    }


    // 安全获取计算样式：跨帧调用时若失败则返回 null
    function safeGetComputedStyle(el, view) {
        try { return view.getComputedStyle(el); } catch (e) { return null; }
    }

    // 安全提取 URL hostname：失败返回空字符串
    function safeURLHostname(url) {
        try { return new URL(url).hostname; } catch (e) { return ''; }
    }

    // 分数钳制：确保值在 [min, max] 范围内
    function clampScore(val, min, max) {
        return Math.min(max, Math.max(min, val));
    }

    // ─── 配置常量：统一魔法数字，便于调整和维护 ───
    const CONFIG = {
        // 分数相关
        MAX_SCORE: 255,
        SCORE_BASE: 10,
        SCORE_THRESHOLD_50: 50,
        SCORE_THRESHOLD_100: 100,
        // 置信度阈值
        CONFIDENCE_HIGH: 0.7,
        CONFIDENCE_LOW: 0.1,
        CONFIDENCE_MEDIUM: 0.3,
        // 时间相关
        DEBOUNCE_MS: 300,
        RELOAD_DELAY_MS: 1500,
        OBSERVER_DEBOUNCE_MS: 2000,
        // 尺寸相关
        MIN_VISIBLE_RATIO: 0.25,
        MAX_TEXT_LENGTH: 200,
        // 深度限制
        MAX_SCAN_DEPTH: 3,
        MAX_NESTING_DEPTH: 10
    };


    // 资源选择器构建器：统一域名/路径资源属性选择器构建，消除 8+ 处手动拼接(4.4 节)
    const ResourceSelectorBuilder = {
        // 域名资源属性选择器（6 通道）：匹配 src/href/data-src/data-original/poster/srcset
        buildDomainAttr(domain) {
            const esc = escapeCSSAttr(domain);
            return `[src*="${esc}"], [href*="${esc}"], [data-src*="${esc}"], [data-original*="${esc}"], [poster*="${esc}"], [srcset*="${esc}"]`;
        },
        // 路径模式属性选择器（3 通道）：匹配 href/src/data-src
        buildPathAttr(pattern) {
            const esc = escapeCSSAttr(pattern);
            return `[href*="${esc}"], [src*="${esc}"], [data-src*="${esc}"]`;
        }
    };

    // 域名封杀统一执行器：消除 ActionPanel/GlobalDomainPanel/OverlayScanPanel 三处重复(4.3 节)
    // 统一「添加 domainBlock 规则 + 即时隐藏匹配资源」口径，确保即时效果=预览=刷新后效果
    const DomainBlockExecutor = {
        /**
         * 添加域名封杀规则并即时隐藏匹配资源
         * @param {string[]} domains - 待封杀域名列表
         * @param {object} options - { hideMode: 'full'|'wrapper'|'none' }
         *   'full': 隐藏资源元素 + 直接父级 + 单子链容器（ActionPanel 口径）
         *   'wrapper': 仅隐藏单子链容器（GlobalDomainPanel 口径）
         *   'none': 仅添加规则不隐藏（OverlayScanPanel，元素已单独隐藏）
         */
        execute(domains, options = {}) {
            const { hideMode = 'wrapper' } = options;
            // 1. 添加持久化规则（冗余-5：skipApply=true 跳过逐条 applyCSSRules，末尾统一重建一次）
            domains.forEach(d => storage.addRule('domainBlock', { domain: d, type: 'domainBlock' }, true));
            // 1.1 统一重建一次样式表（替代循环内 N 次 applyCSSRules）
            if (domains.length > 0) BlockEngine.applyCSSRules();
            // 2. 即时隐藏（统一口径，保护脚本自身 UI 绝不拦截）
            if (hideMode === 'none') return;
            domains.forEach(d => {
                const sel = ResourceSelectorBuilder.buildDomainAttr(d);
                document.querySelectorAll(sel).forEach(el => {
                    if (ProtectedCheck.isProtected(el)) return;
                    if (hideMode === 'full') {
                        BlockEngine.hideElement(el);
                        if (el.parentElement) BlockEngine.hideElement(el.parentElement);
                    }
                    BlockEngine.hideElement(BlockEngine.findSingleChildWrapper(el, 4));
                });
            });
        }
    };

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

    // 统一广告/赌博词库(6.5 节)：合并 AD_KEYWORD_SET 与 GlobalDomainScanner.AD_TOKENS，消除 70% 重复
    // GlobalDomainScanner 内部引用此统一集合，不再维护独立 AD_TOKENS
    const AD_TOKENS_UNIFIED = new Set([
        ...AD_KEYWORD_SET,
        'ad', 'adx', 'adserver', 'adserving', 'googleadservices', 'criteo',
        'media6degrees', 'propellerads', 'adcolony', 'unityads', 'ironsrc',
        'telemetry', 'collect', 'hotjar', 'mixpanel', 'segment', 'cnzz',
        'tongji', 'stat', 'count', 'report'
    ]);
    // 统一赌博/色情词库：合并 isAdKeywordHost.viceKeywords 与 GlobalDomainScanner.VICE_TOKENS
    // 短词(长度 ≤ 3)用 sld.includes() 会误判通用域名：delivery.cc 含 'live'、gogo.cc 含 'go'、blink.cc 含 'link'
    // 因此短词在 isAdKeywordHost 中改用「单词边界」精确匹配，避免子串误命中(BUG-10)
    const VICE_TOKENS_UNIFIED = new Set([
        'casino', 'bet', 'poker', 'bocai', 'porn', 'sex', 'cam',
        'slot', 'lottery', 'jackpot', 'gamble', 'wager', 'lucky',
        'adult', 'xxx', 'hentai', 'nsfw', 'live', 'hookup',
        'ag', 'bbin', 'mg', 'pt', 'sb', 'ibc', 'sbo', 'cmd',
        'sunbet', 'maxbet', 'yazhou', 'caipiao', 'cp',
        'betting', 'gambling', 'spin', 'baccarat', 'roulette', 'blackjack',
        'sportsbook', 'bookmaker', 'odds', 'handicap', 'parlay',
        'cmd368', 'tombola', 'lottomatica',
        'nude', 'erotic', 'dating', 'escort', 'onlyfans', 'xvideos',
        'pornhub', 'xhamster', 'redtube', 'youporn', 'brazzers',
        'redirect', 'click', 'track', 'go', 'jump', 'link', 'short', 'tiny',
        'bitly', 'turl', 'sclick', 'goo', 'owly', 'rebrandly', 'cuttly',
        'popup', 'popunder', 'overlay', 'push', 'notification', 'interstitial',
        'splash', 'takeover', 'skyscraper', 'leaderboard', 'native-ad'
    ]);
    // 短词集合（长度 ≤ 3）：includes 子串匹配误判面大，需用单词边界精确匹配
    // 如 'go' 会匹配 gogo/linker/ego，'live' 会匹配 delivery/solive，'link' 会匹配 blink/thinking
    const VICE_SHORT_TOKENS = new Set(
        Array.from(VICE_TOKENS_UNIFIED).filter(kw => kw.length <= 3)
    );
    // H10 修复：link/live/tiny/jump/short/owly 等 4 字符词需 TLD 上下文，不进单判长词集
    // 仅 casino/poker/baccarat 等强特征词可单独判定
    const VICE_LONG_TOKENS = new Set(
        Array.from(VICE_TOKENS_UNIFIED).filter(kw => {
            // 需 TLD 上下文的弱特征词
            const NEEDS_TLD = new Set(['link', 'live', 'tiny', 'jump', 'short', 'owly']);
            return kw.length >= 4 && !NEEDS_TLD.has(kw);
        })
    );
    const VICE_SHORT_TOKENS_NAV = VICE_SHORT_TOKENS;
    // 预编译短词边界正则(问题3)：isAdKeywordHost 对每个域名调用一次，大页面 30-50 个域名 ×
    // 每次循环 ~20 个短词 new RegExp 会创建大量临时对象。模块初始化时预编译一次，运行时复用
    const VICE_SHORT_RE_MAP = new Map();
    VICE_SHORT_TOKENS.forEach(kw => {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        VICE_SHORT_RE_MAP.set(kw, new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i'));
    });

    // 检测 hostname 是否含广告关键词：按非字母数字分词后逐 token 查 Set
    const isAdKeywordHost = (hostname) => {
        if (!hostname || typeof hostname !== 'string') return false;
        const lower = hostname.toLowerCase();
        const tokens = lower.split(/[^a-z0-9-]/);
        for (let i = 0; i < tokens.length; i++) {
            if (AD_TOKENS_UNIFIED.has(tokens[i])) return true;
        }
        // 赌博 TLD 上的纯数字域名 / 含赌博词域名 → 直接判定为广告
        const labels = lower.split('.');
        if (labels.length >= 2 && GAMBLING_TLDS.has(labels[labels.length - 1])) {
            const sld = labels[labels.length - 2] || '';
            // 5955123.cc / 016.com 这种纯数字博彩域
            if (/^\d+$/.test(sld)) return true;
            // 含赌博/色情词：casino888.cc / bet365.cc / ag-bbin.vip 等
            // 短词(≤3)用单词边界匹配，避免 'go' 匹配 gogo.cc、'live' 匹配 delivery.cc(BUG-10)
            // 长词(≥4)仍用 includes 子串匹配，保留 casino888/bet365 等拼接形式命中
            for (const kw of VICE_TOKENS_UNIFIED) {
                if (VICE_SHORT_TOKENS.has(kw)) {
                    // 短词：复用预编译边界正则(问题3)，避免每次调用 new RegExp
                    if (VICE_SHORT_RE_MAP.get(kw).test(sld)) return true;
                } else if (sld.includes(kw)) {
                    return true;
                }
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

    // ═══════════════════════════════════════════════════════════
    // RuleStore：规则存储接口（从 StorageManager 拆分）
    // 职责：规则 CRUD + 导入导出 + 缓存管理
    // 依赖：GM_setValue/GM_getValue
    // ═══════════════════════════════════════════════════════════
    const RuleStore = {};

    // ═══════════════════════════════════════════════════════════
    // ConfigStore：配置存储接口（从 StorageManager 拆分）
    // 职责：运行时配置 + 闪现标记 + iframe 配置
    // 依赖：GM_setValue/GM_getValue
    // ═══════════════════════════════════════════════════════════
    const ConfigStore = {};

    // ═══════════════════════════════════════════════════════════
    // StorageManager：存储层核心模块
    // 职责：规则 CRUD + 持久化（GM_setValue/GM_getValue）+ 防抖落盘
    // 规则类型：static/dynamic/regex/attribute/structural/complex/pathPattern/domainBlock/iframeBlock
    // 依赖：GM API、CSSInjector（规则变更时触发重建）
    // ═══════════════════════════════════════════════════════════
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
            this._saveTimer = setTimeout(() => this._flush(), TIMING.TOAST_DISMISS_MS);
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

        // 域名黑名单统一为对象结构 {domain, _ts, _disabled}：兼容历史 string[] 与对象[]，去重并保留时间戳与禁用标记，
        // 供管理面板按最近过滤时间倒序展示（"最近过滤规则置顶"）
        _normDomains(arr) {
            if (!Array.isArray(arr)) return [];
            const out = [];
            const seen = new Set();
            arr.forEach(item => {
                const domain = typeof item === 'string' ? item : (item?.domain);
                if (!domain || typeof domain !== 'string' || domain.length < 1 || domain.length > 200 || seen.has(domain)) return;
                seen.add(domain);
                const ts = (item && typeof item._ts === 'number') ? item._ts : 0;
                const disabled = item?._disabled === true;
                out.push({ domain, _ts: ts, _disabled: disabled });
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

        saveData(type, rules, skipApply = false) {
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
            // skipApply=true 时不内部触发 applyCSSRules，由外部统一调用 reapplyAll 接管(不一致-1)
            if (!skipApply && type !== 'regex' && type !== 'complex') BlockEngine.applyCSSRules();
        }

        addRule(type, rule, skipApply = false) {
            if (type === 'domainBlock') {
                const list = this.getDomainBlocks();
                if (rule.domain && !list.some(r => r.domain === rule.domain)) {
                    list.push({ domain: rule.domain, _ts: Date.now() });
                    this._markDirty('domainBlocks', list);
                    this.invalidateDataCache();
                    BlockEngine.invalidateCache();
                    // skipApply=true 时由外部统一调用 reapplyAll 接管(冗余-2)
                    if (!skipApply) BlockEngine.applyCSSRules();
                }
                return;
            }
            const data = this.getData()[type];
            // regex 规则去重必须比较 mode(BUG-7)：同文本不同模式(regex vs contains)语义不同，
            // 缺 mode 比较会导致「先加 regex 模式"广告"，再加 contains 模式"广告"」时后者被判定为重复而丢失
            const isDuplicate = data.some(item =>
                (type === 'regex' && item.regex === rule.regex && item.level === rule.level && (item.mode || '') === (rule.mode || '')) ||
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
                // skipApply=true 时跳过 saveData 内部 applyCSSRules，由外部统一调用(冗余-2)
                this.saveData(type, data, skipApply);
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
                    // 不再内部调用 applyCSSRules，统一由外部 reapplyAll 接管(不一致-1)
                }
                return;
            }
            const data = this.getData()[type];
            if (data[index]) {
                data.splice(index, 1);
                // skipApply=true 跳过 saveData 内部 applyCSSRules；regex/complex 的 apply 也由外部 reapplyAll 接管(不一致-1)
                this.saveData(type, data, true);
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
            // 不再内部调用 apply*，统一由外部 reapplyAll 接管(不一致-1)
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
            // 不再内部调用 apply*，统一由外部 reapplyAll 接管(不一致-1)
            return true;
        }

        // 规则启用/禁用切换：标记 _disabled=true 后所有 apply* 方法跳过该规则，
        // 实现临时禁用而无需删除（用户可随时启用恢复）。domainBlock 同样支持。
        // 切换后必须 restoreAllInlineStyles 清除之前的内联隐藏，再重新应用规则，
        // 这样禁用时被隐藏的元素立即恢复显示，启用时立即重新隐藏——用户实时看到效果。
        toggleRuleDisabled(type, index, domain) {
            if (type === 'domainBlock') {
                const list = this.getDomainBlocks();
                if (!list[index]) return false;
                list[index]._disabled = !list[index]._disabled;
                this._markDirty('domainBlocks', list);
                this.invalidateDataCache();
                BlockEngine.invalidateCache();
                BlockEngine.restoreAllInlineStyles();
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
            // 先清除所有内联隐藏样式，再重新应用（跳过 _disabled 规则），确保禁用即时生效
            BlockEngine.restoreAllInlineStyles();
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
                    if (Array.isArray(dict[d]) && dict[d].length) allSiteDomains.add(d);
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
                    if (Array.isArray(rules) && rules.length) {
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

            // iframe 规则（§8.7 导出新增桶）
            const iframeRules = this.getIframeBlocks().map(r => {
                const { _ts, ...rest } = r;
                return rest;
            });
            const iframeConfig = this.getIframeConfig();

            const exportData = {
                meta: {
                    version: '2.0',
                    exportedAt: new Date().toISOString(),
                    scriptVersion: GM_info && GM_info.script && GM_info.script.version || 'unknown',
                    counts: {
                        domains: domains.length,
                        siteRules: totalRules,
                        sites: Object.keys(sites).length,
                        iframeRules: iframeRules.length,
                    }
                },
                domains,
                sites,
                config,
                flashDomains,
                iframeRules,
                iframeConfig,
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
            // iframe 规则导入（§8.9 导入新增桶）
            if (Array.isArray(importData.iframeRules)) {
                const incoming = importData.iframeRules.filter(r => r && r.matchType && r.value !== undefined);
                if (merge) {
                    const existing = this.getIframeBlocks();
                    const fp = (x) => x.matchType + '|' + x.value;
                    const existingSet = new Set(existing.map(fp));
                    incoming.forEach(r => {
                        if (!existingSet.has(fp(r))) {
                            existingSet.add(fp(r));
                            existing.push({ ...r, _ts: Date.now() });
                        }
                    });
                    this._markDirty('iframeBlocks', existing);
                } else {
                    this._markDirty('iframeBlocks', incoming.map(r => ({ ...r, _ts: Date.now() })));
                }
                if (typeof IframeGuard !== 'undefined') IframeGuard.invalidateBlockRules();
            } else if (!merge) {
                this._markDirty('iframeBlocks', []);
            }
            // iframe 配置导入（合并模式仅写入不存在的键）
            if (importData.iframeConfig && typeof importData.iframeConfig === 'object') {
                const cur = this.getIframeConfig();
                const merged = merge ? { ...importData.iframeConfig, ...cur } : importData.iframeConfig;
                this._markDirty('iframeConfig', merged);
            }
            BlockEngine.invalidateCache();
            this.invalidateDataCache();
            BlockEngine.applyCSSRules();
            BlockEngine.applyRegexRules();
            BlockEngine.applyComplexRules();
            // iframe 规则/配置导入后重新加载配置并重扫
            try {
                IframeGuard._loadConfig();
                IframeGuard.rescanAll();
            } catch (e) { Log.warn(e.message || e); }
            return true;
        }

        // ─── iframe 规则存储（§13 新增规则类型） ───
        // iframeBlock：全局生效，数组结构 [{matchType, value, _ts, _disabled}]
        //   matchType: 'srcDomain' | 'srcdocKeyword' | 'geometry'
        getIframeBlocks() {
            const raw = this._readKey('iframeBlocks', []);
            if (!Array.isArray(raw)) return [];
            return raw.filter(r => r && r.matchType && r.value !== undefined);
        }
        addIframeRule(rule, skipApply = false) {
            const list = this.getIframeBlocks();
            // 去重：matchType + value 完全相同
            const exists = list.some(r => r.matchType === rule.matchType && r.value === rule.value);
            if (exists) return false;
            list.push({ matchType: rule.matchType, value: rule.value, _ts: Date.now() });
            this._markDirty('iframeBlocks', list);
            if (!skipApply) {
                IframeGuard.invalidateBlockRules(); // 清缓存
                EventBus.emit('rule:changed', { type: 'iframeBlock' });
            }
            return true;
        }
        removeIframeRule(index) {
            const list = this.getIframeBlocks();
            if (index < 0 || index >= list.length) return false;
            list.splice(index, 1);
            this._markDirty('iframeBlocks', list);
            IframeGuard.invalidateBlockRules();
            EventBus.emit('rule:changed', { type: 'iframeBlock' });
            return true;
        }
        toggleIframeRuleDisabled(index) {
            const list = this.getIframeBlocks();
            if (index < 0 || index >= list.length) return false;
            list[index]._disabled = !list[index]._disabled;
            this._markDirty('iframeBlocks', list);
            IframeGuard.invalidateBlockRules();
            EventBus.emit('rule:changed', { type: 'iframeBlock' });
            return list[index]._disabled;
        }
        getIframeConfig() {
            return this._readKey('iframeConfig', { maxDepth: 3 });
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

    // 真实浏览器才实例化 StorageManager（其构造器依赖 window/document）；node/jest 下置 null，
    // 使产物可被 require 做 UI 契约测试（Feathers《Working Effectively with Legacy Code》§3 接缝）
    const storage = (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof window.HTMLElement !== 'undefined') ? new StorageManager() : null;

    // 门面模式：RuleStore 和 ConfigStore 委托到 storage 实例
    // node/jest 下 storage 为 null，跳过门面装配（产物仍可 require 做 UI 契约测试）
    if (storage) {
        ['getDomainBlocks', 'addRule', 'removeRule', 'toggleDisabled', 'getData',
            'getIframeBlocks', 'addIframeRule', 'removeIframeRule', 'toggleIframeRuleDisabled',
            'exportAll', 'importAll', 'invalidateDataCache', 'getDomainSet',
            'getStatic', 'getDynamic', 'getRegex', 'getAttribute', 'getStructural',
            'getComplex', 'getPathPattern', 'domain'
        ].forEach(m => {
            if (typeof storage[m] === 'function') RuleStore[m] = (...args) => storage[m](...args);
            else RuleStore[m] = storage[m];
        });
        ['getConfig', 'setConfig', 'getIframeConfig', 'markAsFlashing', 'resetFlash', 'flashList'
        ].forEach(m => {
            if (typeof storage[m] === 'function') ConfigStore[m] = (...args) => storage[m](...args);
            else ConfigStore[m] = storage[m];
        });
    }

    /**
     * 路径规则倒排索引：提取每条 pattern 最长 ≥4 字符 token 建 Map<token, Set<pattern>>，
     * 匹配时仅对 URL 中出现的 token 对应候选 pattern 做字面子串校验，将 O(N) 线性遍历降为 O(tokens) 查找。
     * 无 ≥4 token 的 pattern 进入 fallback 线性表。供网络层 isUrlBlocked 使用；
     * DOM 扫描仍用合并正则（getPathMatcher）以支持 .exec() 提取匹配串日志。
     */
    class PathInvertedIndex {
        static _windowIndex = new Map();   // 4-char window -> Set<{raw, lower}>
        static _fallback = [];            // 无法分4元组的 pattern，存 {raw, lower}
        static _patternCount = 0;
        static _W = 4;                    // 滑窗长度

        static build(rawPatterns) {
            this._windowIndex = new Map();
            this._fallback = [];
            this._patternCount = 0;
            rawPatterns.forEach(pattern => {
                if (!pattern) return;
                this._patternCount++;
                const lower = pattern.toLowerCase();
                const entry = { raw: pattern, lower };
                // 滑窗建索引：从 pattern 中提取所有长度 W 的子串作为倒排键
                const windows = this._slideWindows(lower);
                if (windows.length > 0) {
                    windows.forEach(w => {
                        if (!this._windowIndex.has(w)) this._windowIndex.set(w, new Set());
                        this._windowIndex.get(w).add(entry);
                    });
                } else {
                    this._fallback.push(entry);
                }
            });
        }

        // 滑窗：从字符串中提取所有长度为 W 的连续子串
        static _slideWindows(str) {
            if (str.length < this._W) return [];
            const ws = [];
            for (let i = 0; i <= str.length - this._W; i++) ws.push(str.slice(i, i + this._W));
            return ws;
        }

        // 从 pathStr 中提取可查询的滑窗集合（合并 token 滑窗 + 全串滑窗）
        static _queryWindows(pathStr) {
            const set = new Set();
            // 1. 按非字母数字 token 切分后对每个 token 滑窗（长 token 可靠）
            pathStr.toLowerCase().split(/[^a-z0-9]+/).forEach(tok => {
                this._slideWindows(tok).forEach(w => set.add(w));
            });
            // 2. 整串滑窗兜底（短 token / 短 URL 场景）
            this._slideWindows(pathStr.toLowerCase()).forEach(w => set.add(w));
            return set;
        }

        // 滑窗测试：pathStr 含任一 pattern 即命中
        static test(pathStr) {
            if (this._patternCount === 0) return false;
            const query = this._queryWindows(pathStr);
            const candidates = new Set();
            query.forEach(w => {
                const s = this._windowIndex.get(w);
                if (s) s.forEach(p => candidates.add(p));
            });
            const lower = pathStr.toLowerCase();
            for (const p of candidates) {
                if (lower.includes(p.lower)) return true;
            }
            // fallback：无滑窗的 pattern 逐一字面子串校验
            for (let i = 0; i < this._fallback.length; i++) {
                if (lower.includes(this._fallback[i].lower)) return true;
            }
            return false;
        }

        static get size() { return this._patternCount; }
    }




    // ═══════════════════════════════════════════════════════════
    // CSSInjector：CSS 规则注入引擎（从 BlockEngine 拆分）
    // 职责：Constructable Stylesheets 管理 + CSS 规则批量注入 + 指纹比对
    // 依赖：storage, ResourceSelectorBuilder, escapeCSSAttr
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // CSSInjector：CSSEngine（引擎层·CSS 规则注入模块）
    // 职责：将规则编译为 CSS 选择器并注入页面样式表
    // 优化：Constructable Stylesheets + 批量合并选择器（40条/批）+ 指纹缓存
    // 依赖：StorageManager、ResourceSelectorBuilder
    // ═══════════════════════════════════════════════════════════
    const CSSInjector = {
        styleElementId: 'pro-blocker-core-css',
        // CSSOM 增量注入指纹：记录上次注入的选择器集合，内容未变时跳过重建
        _lastCSSFingerprint: '',
        // Constructable Stylesheets 支持：Chrome 99+/Edge/Firefox 101+ 支持，
        // WebKit 支持不完整，需 Feature Detection 后降级到 <style> + insertRule
        _supportsConstructable: (typeof CSSStyleSheet !== 'undefined') && ('adoptedStyleSheets' in document),
        // 当前生效的 CSSStyleSheet（构造样式表 或 <style>.sheet），首次 applyCSSRules 时确定
        _styleSheet: null,
        _useConstructable: false,

        applyCSSRules() {
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
                const sel = ResourceSelectorBuilder.buildDomainAttr(domain);
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
                const sel = ResourceSelectorBuilder.buildPathAttr(r.pattern);
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
            // 跨脚本保护：同时排除 #va-ui-host（视频加速脚本 UI），防止广告拦截误伤视频控制 FAB
            const SELF_PROTECT = ':not(#pro-blocker-ui-host):not(#pro-blocker-ui-host *):not(#va-ui-host):not(#va-ui-host *)';
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
        },

        // 获取（惰性创建）当前生效的 CSSStyleSheet：
        // 优先 Constructable Stylesheets（C++ 对象，零解析、防探查），不支持时降级到 <style>.sheet
        _getSheet() {
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
        },

        // 清空任意 CSSStyleSheet（构造样式表 或 <style>.sheet）的所有规则
        _clearSheetRules(sheet) {
            if (!sheet) return;
            // 快路径：Constructable Stylesheets 用 replaceSync('') 一次性清空，O(1) 调用
            if (this._useConstructable) {
                try { sheet.replaceSync(''); return; } catch (e) { Log.warn(e.message || e); }
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
        },

        // 通用内联样式还原：删除任意类型规则后，清除所有由脚本设置的内联隐藏样式
        // 适用于 static/dynamic/attribute/structural/regex/complex 规则删除场景
        // 策略：清除所有带 display:none!important 的内联样式，然后重建 CSS 表 + 重扫
        restoreAllInlineStyles() {
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
        },

        invalidateFingerprint() { this._lastCSSFingerprint = ''; }
    };

    // ═══════════════════════════════════════════════════════════
    // ProtectedCheck：元素保护判定（从 UIManager.isProtectedElement 提取）
    // 职责：判定元素是否属于脚本 UI 宿主或其子节点，防止误拦截
    // 跨脚本保护：同时识别 video-accelerator 的 va-ui-host，避免误拦截
    // ═══════════════════════════════════════════════════════════
    const ProtectedCheck = {
        isProtected(el) {
            if (!el) return true;
            // 广告拦截器自身 UI
            if (el.id === 'pro-blocker-ui-host') return true;
            if (el.closest && el.closest('#pro-blocker-ui-host')) return true;
            let root;
            try { root = el.getRootNode && el.getRootNode(); } catch (e) { root = null; }
            if (root && root.host && root.host.id === 'pro-blocker-ui-host') return true;
            // 视频加速脚本 UI（跨脚本保护）
            if (el.id === 'va-ui-host') return true;
            if (el.closest && el.closest('#va-ui-host')) return true;
            if (root && root.host && root.host.id === 'va-ui-host') return true;
            // 视频加速 FAB 按钮（z-index: 2147483646 会被误判为广告覆盖层）
            if (el.classList && el.classList.contains('fab')) return true;
            return false;
        }
    };

    // ═══════════════════════════════════════════════════════════
    // ElementHider：元素隐藏/还原引擎（从 BlockEngine 拆分）
    // 职责：统一的 display/opacity/visibility/pointer-events 四件套隐藏口径
    // 依赖：UIManager.isProtectedElement
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // ElementHider：隐藏执行器（统一四件套隐藏口径）
    // 职责：hideElement/showElement 统一入口，确保 display/opacity/visibility/pointer-events 一致
    // 保护：isProtectedElement 全局守卫，防止误伤脚本自身 UI
    // 依赖：UIManager（isProtectedElement）
    // ═══════════════════════════════════════════════════════════
    const ElementHider = {
        // ─── 统一隐藏口径(BUG-M3 & 5.2 隐藏口径统一) ───
        // 所有 DOM 层隐藏入口必须调用此方法，确保 display/opacity/visibility/pointer-events 四件套一致，
        // 避免各处只写 2~3 个属性导致广告元素仍可点击或仍占据空间。
        // 保护脚本自身 UI 宿主：拦截入口统一豁免 #pro-blocker-ui-host，防止任何规则隐藏面板
        hideElement(el) {
            if (!el || el === document.body || el === document.documentElement) return;
            if (ProtectedCheck.isProtected(el)) return;
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
        },

        // 还原 hideElement 设置的内联隐藏样式（删除规则/禁用规则/预览还原时调用）
        showElement(el) {
            if (!el) return;
            el.style.removeProperty('display');
            el.style.removeProperty('opacity');
            el.style.removeProperty('visibility');
            el.style.removeProperty('pointer-events');
        }
    };

    // ═══════════════════════════════════════════════════════════
    // SelectorBuilder：选择器构建引擎（从 BlockEngine 拆分）
    // 职责：CSS 选择器生成 + 元素层级导航 + 路径候选提取
    // 依赖：escapeCSSAttr（全局）
    // ═══════════════════════════════════════════════════════════
    const SelectorBuilder = {
        // 积木模式：从条件列表构建 CSS 基础选择器（AND 逻辑可利用 class/id 缩小候选集）
        _buildComplexBaseSelector(conditions, logic) {
            if (logic !== 'AND') return '*';
            const simpleParts = [];
            conditions.forEach(c => {
                if (c.type === 'class' && (c.operator === 'contains' || c.operator === 'equals')) simpleParts.push(`[class*="${escapeCSSAttr(c.value)}"]`);
                if (c.type === 'id' && c.operator === 'equals') simpleParts.push(`[id="${escapeCSSAttr(c.value)}"]`);
                if (c.type === 'id' && c.operator === 'contains') simpleParts.push(`[id*="${escapeCSSAttr(c.value)}"]`);
            });
            return simpleParts.length > 0 ? `*${simpleParts.join('')}` : '*';
        },

        // 按 level 向上查找祖先元素（跳过 body/documentElement），用于积木/正则命中后定位隐藏目标
        findLevelAncestor(el, level) {
            let target = el;
            for (let i = 0; i < level; i++) {
                if (target.parentElement && target.parentElement !== document.body && target.parentElement !== document.documentElement) {
                    target = target.parentElement;
                } else break;
            }
            return target;
        },

        generateOptimalSelector(element) {
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
        },

        generateStructuralSelector(element) {
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
        },

        /**
         * 从 extractResourceDomains 的结果中提取路径模式候选(BUG-A3 + 冗余-7)
         * 取每个相对路径/同源路径的前 3 段作为 pathPattern，≥2 段才收录
         * 统一 btn-domain 回调与 _applyActionPreviewHiding 的路径提取口径，消除重复代码
         * @param {Object} result - extractResourceDomains 返回值
         * @returns {Set<string>} 路径模式集合，如 {'/ads/banner', '/static/img'}
         */
        extractPathCandidates(result) {
            const candidates = new Set();
            if (!result || !result.paths) return candidates;
            for (const p of result.paths) {
                try {
                    if (!p || !p.startsWith('/') || p.length <= 5) continue;
                    const segs = p.split('/').filter(Boolean);
                    if (segs.length >= 2) candidates.add('/' + segs.slice(0, 3).join('/'));
                } catch (e) { Log.warn(e.message || e); }
            }
            return candidates;
        },

        isSafeOutermost(element) {
            if (!element || !element.parentElement) return true;
            const p = element.parentElement;
            return p === document.body || p === document.documentElement;
        },

        /**
         * 沿单子链向上查找包裹容器：父级仅含一个元素子节点时继续向上
         * 遇到多子分支或 body/html 时停止。maxDepth 防止极端深度
         */
        findSingleChildWrapper(element, maxDepth = 6) {
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
        },

        /**
         * 智能查找广告最外层容器：沿单子链向上，遇到多子分支即停止
         */
        findOutermostAdContainer(element) {
            return this.findSingleChildWrapper(element, 50);
        }
    };

    // ═══════════════════════════════════════════════════════════
    // RegexEngine：正则/积木规则引擎（从 BlockEngine 拆分）
    // 职责：正则编译缓存 + ReDoS 预检 + 文本节点遍历匹配 + 积木条件求值
    // 依赖：storage, ElementHider, UIManager.isProtectedElement, SelectorBuilder
    // ═══════════════════════════════════════════════════════════
    const RegexEngine = {
        _regexCache: new Map(),

        // 文本节点过滤器：跳过 SCRIPT/STYLE/NOSCRIPT 内的文本，避免误隐藏脚本父级导致页面功能损坏
        _textNodeFilter: {
            acceptNode(node) {
                const tag = node.parentElement && node.parentElement.tagName;
                if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        },

        // ReDoS 静态预检：在执行前检测危险模式，拒绝执行可能引发灾难性回溯的正则
        // 替代原"执行后检测耗时"的伪保护（ReDoS 在 test() 内部阻塞，事后检测无法阻止卡顿）
        // 仅检测嵌套量词（真正的 ReDoS 元凶），移除过于保守的"重叠分支"检测（误杀率高）
        isRegexSafe(pattern) {
            if (!pattern || typeof pattern !== 'string') return false;
            // 嵌套量词检测：(a+)+, (a*)*, (a{1,3})+, (a+)? 等
            if (/\([^)]*[+*?][^)]*\)[+*?]/.test(pattern)) return false;
            if (/\([^)]*\{\d+(?:,\d*)?\}[^)]*\)[+*?]/.test(pattern)) return false;
            return true;
        },

        getCompiledRegex(pattern) {
            if (this._regexCache.has(pattern)) return this._regexCache.get(pattern);
            try {
                const regex = new RegExp(pattern);
                this._regexCache.set(pattern, regex);
                return regex;
            } catch (e) {
                this._regexCache.set(pattern, null);
                return null;
            }
        },

        applyRegexRules(targetNode = document.body) {
            const data = storage.getData();
            if (!data.regex || data.regex.length === 0 || !targetNode) return;

            // 分流：contains 模式规则用 String.includes() 匹配(BUG-M7)，其余走正则引擎
            // contains 规则存储原始文本(mode='contains')，避免 .*text.* 合并正则引发贪婪回溯
            const containsRules = data.regex
                .filter(r => r.regex && !r._disabled && r.mode === 'contains')
                .map(r => ({ text: r.regex.toLowerCase(), level: r.level }));
            const regexRules = data.regex
                .filter(r => r.regex && !r._disabled && r.mode !== 'contains' && this.isRegexSafe(r.regex))
                .map(r => ({ regex: this.getCompiledRegex(r.regex), level: r.level }))
                .filter(r => r.regex);

            if (containsRules.length === 0 && regexRules.length === 0) return;

            // 合并正则：每条规则用捕获组包裹，exec 一次即可定位命中的规则索引
            // 将每节点 RegExp 调用从 N 次降为 1 次，TreeWalker 遍历次数不变
            // 分批合并：V8 对单条正则捕获组数量有隐性上限（~500），规则数 >50 时分批
            // 每批 50 条，避免 RegExp too complex 编译失败导致所有正则规则静默失效
            const REGEX_BATCH_SIZE = 50;
            const mergedBatches = [];
            for (let i = 0; i < regexRules.length; i += REGEX_BATCH_SIZE) {
                const batch = regexRules.slice(i, i + REGEX_BATCH_SIZE);
                try {
                    // 捕获组错位修复(BUG-A1)：规则自带捕获组(如 广告(\d+))会令合并后
                    // (广告(\d+))|(推广) 的组号右移，match[i]!==undefined 循环取错 level。
                    // 合并前将内层捕获组转非捕获组 (?:...)，确保第 i 个外层组 = 第 i 条规则。
                    //
                    // 状态机转换(v0.7.2 彻底修复)：旧版两步正则替换会误改转义括号 \( 和
                    // 字符类 [(a)] 内的 (。改用单次遍历状态机，正确区分三种上下文：
                    //   ① 普通上下文：\( 是字面量(跳过\)，(?<name> 是命名组→(?:，( 是捕获组→(?:，
                    //                  (?:/(?=/(?!/(?<=/(?<! 是非捕获/断言(保留)，[ 进入字符类
                    //   ② 转义上下文：\ 后任意字符按字面量处理（跳过该字符）
                    //   ③ 字符类上下文：[...] 内的 ( 是字面量(保留)，] 退出回到普通上下文
                    const convertGroups = (src) => {
                        let out = '';
                        let i = 0;
                        let inClass = false; // 是否在字符类 [...] 内
                        while (i < src.length) {
                            const ch = src[i];
                            if (inClass) {
                                // 字符类内：] 结束字符类（未转义），其他字符（含 ( ) \）原样保留
                                if (ch === '\\' && i + 1 < src.length) {
                                    out += ch + src[i + 1];
                                    i += 2;
                                    continue;
                                }
                                if (ch === ']') inClass = false;
                                out += ch;
                                i++;
                            } else if (ch === '\\') {
                                // 转义：连同下一个字符原样保留（\( \/ \d 等都是字面量/预定义类）
                                out += ch + (src[i + 1] || '');
                                i += 2;
                            } else if (ch === '[') {
                                // 进入字符类（注意 [] 内规则与外部不同，括号不作为分组）
                                inClass = true;
                                out += ch;
                                i++;
                            } else if (ch === '(') {
                                // 分组：判断后续字符决定类型
                                const next = src[i + 1];
                                if (next === '?') {
                                    const after = src[i + 2];
                                    if (after === '<') {
                                        // 命名组 (?<name>...) 或后向断言 (?<= / (?<!)
                                        const after2 = src[i + 3];
                                        if (after2 === '=' || after2 === '!') {
                                            // (?<= / (?<! 后向断言：非捕获，保留原样
                                            out += src.slice(i, i + 4);
                                            i += 4;
                                        } else {
                                            // (?<name>...) 命名捕获组 → 转为非捕获 (?:
                                            out += '(?:';
                                            i += 2;
                                            // 跳过 <name> 直到 > 结束
                                            let j = i;
                                            while (j < src.length && src[j] !== '>') j++;
                                            i = j + 1; // 跳过 >
                                        }
                                    } else {
                                        // (?: / (?= / (?! 等非捕获/断言：保留原样
                                        out += ch;
                                        i++;
                                    }
                                } else {
                                    // 普通捕获组 ( → 非捕获 (?:
                                    out += '(?:';
                                    i++;
                                }
                            } else {
                                out += ch;
                                i++;
                            }
                        }
                        return out;
                    };
                    const source = batch.map(r => `(${convertGroups(r.regex.source)})`).join('|');
                    mergedBatches.push({ regex: new RegExp(source, 'i'), offset: i, rules: batch });
                } catch (e) {
                    // 该批合并失败，降级为逐条执行（保留原 rule 对象供降级路径使用）
                    mergedBatches.push({ regex: null, offset: i, rules: batch });
                }
            }

            // requestIdleCallback 不可用（如旧版 Safari）时回退到同步遍历，保证功能可用
            if (typeof requestIdleCallback !== 'function') {
                return this._applyRegexRulesSync(targetNode, mergedBatches, containsRules);
            }

            // 时间分片：在浏览器空闲帧执行正则比对，避免 Long Task 阻塞主线程导致卡顿
            try {
                const walker = document.createTreeWalker(targetNode, NodeFilter.SHOW_TEXT, this._textNodeFilter, false);
                const processChunk = (deadline) => {
                    let node;
                    while ((node = walker.nextNode())) {
                        // 先处理当前节点再判时：避免 timeRemaining 耗尽时 break 跳过该节点
                        // （walker.nextNode 已推进内部指针，break 后该节点永久漏匹配）
                        this._executeRegexMatch(node, mergedBatches, containsRules);
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
                Log.error('正则遍历异常:', e);
            }
        },

        // 对单个文本节点执行正则/contains 匹配，命中则按 level 向上隐藏父级
        // contains 规则用 String.includes() O(n) 匹配(BUG-M7)；正则规则用合并批次 exec
        _executeRegexMatch(node, mergedBatches, containsRules) {
            const text = node.textContent || '';
            if (!text) return;
            const truncated = text.length > 2000 ? text.slice(0, 2000) : text;

            // contains 规则优先匹配（字符串包含，无回溯）
            if (containsRules && containsRules.length > 0) {
                const lower = truncated.toLowerCase();
                for (const rule of containsRules) {
                    if (lower.includes(rule.text)) {
                        this._hideRegexAncestor(node, rule.level);
                        return; // 命中即返回，避免重复隐藏
                    }
                }
            }

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
        },

        // 按 level 向上隐藏文本节点的祖先元素
        _hideRegexAncestor(node, level) {
            let element = node.parentElement;
            if (!element) return;
            // 全局保护：避免正则规则隐藏到脚本自身 UI 宿主
            if (ProtectedCheck.isProtected(element)) return;
            for (let i = 0; i < level; i++) {
                if (element.parentElement && element.parentElement !== document.body) {
                    element = element.parentElement;
                    // 上溯过程中再次校验，避免选中受保护祖先
                    if (ProtectedCheck.isProtected(element)) return;
                } else break;
            }
            if (element && element.style.display !== 'none') {
                BlockEngine.stats.domBlocks++;
                // 统一隐藏口径(5.2 节)
                ElementHider.hideElement(element);
            }
        },

        // 同步兜底：无 requestIdleCallback 的环境使用同步 TreeWalker 遍历
        _applyRegexRulesSync(targetNode, mergedBatches, containsRules) {
            this.walkTextNodes(targetNode, (node) => {
                this._executeRegexMatch(node, mergedBatches, containsRules);
            });
        },

        // 遍历 root 下所有文本节点（跳过 SCRIPT/STYLE/NOSCRIPT），callback 返回 false 可提前终止
        walkTextNodes(root, callback) {
            if (!root) return;
            try {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, this._textNodeFilter, false);
                let node;
                while ((node = walker.nextNode())) {
                    if (callback(node) === false) break;
                }
            } catch (e) {
                Log.error('文本节点遍历异常:', e);
            }
        },

        // 积木模式：对单个元素评估所有条件，按 logic(AND/OR) 聚合结果
        evaluateConditions(conditions, logic, el) {
            const results = conditions.map(c => {
                let val = '';
                if (c.type === 'text') val = el.textContent || '';
                else if (c.type === 'class') val = el.className || '';
                else if (c.type === 'id') val = el.id || '';
                if (c.operator === 'contains') return val.includes(c.value);
                if (c.operator === 'not_contains') return val !== '' && !val.includes(c.value);
                if (c.operator === 'equals') return val.trim() === c.value.trim();
                return false;
            });
            return logic === 'AND' ? results.every(r => r) : results.some(r => r);
        },

        applyComplexRules(targetNode = document.body) {
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
                    const baseSelector = SelectorBuilder._buildComplexBaseSelector(rule.conditions, rule.logic);

                    const elements = baseSelector === '*'
                        ? root.querySelectorAll('div, span, a, p, img, li, ul, iframe, section, article, aside')
                        : root.querySelectorAll(baseSelector);

                    elements.forEach(el => {
                        // 全局保护：脚本自身 UI 宿主跳过，避免积木规则误伤面板
                        if (ProtectedCheck.isProtected(el)) return;
                        if (baseSelector === '*' && (el.textContent || '').length > 3000) return;

                        if (this.evaluateConditions(rule.conditions, rule.logic, el)) {
                            const target = SelectorBuilder.findLevelAncestor(el, rule.level);
                            if (target.style.display !== 'none') {
                                // 统一隐藏口径(5.2 节)
                                ElementHider.hideElement(target);
                            }
                        }
                    });
                } catch (e) {
                    Log.error('积木规则执行错误:', e);
                }
            });
        }
    };

    // ═══════════════════════════════════════════════════════════
    // DomScanner：DOM 动态扫描引擎（从 BlockEngine 拆分）
    // 职责：MutationObserver 监听 + 动态资源域扫描 + Shadow DOM 递归
    // 依赖：storage, CSSInjector, RegexEngine, ElementHider, UIManager
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // DomScanner：DOM 动态扫描引擎（引擎层·MutationObserver 模块）
    // 职责：监听 DOM 变化、扫描新节点资源域/路径、执行隐藏
    // 特性：Shadow DOM 穿透、SPA 路由监听、去抖时间分片（requestIdleCallback）
    // 依赖：StorageManager、BlockEngine（isUrlBlocked）、ElementHider
    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // DomScanner：DOM 动态扫描引擎（引擎层·MutationObserver 模块）
    // 职责：监听 DOM 变化、扫描新节点资源域/路径、执行隐藏
    // 特性：Shadow DOM 穿透、SPA 路由监听、去抖时间分片（requestIdleCallback）
    // 依赖：StorageManager、BlockEngine（isUrlBlocked）、ElementHider
    // ═══════════════════════════════════════════════════════════
    const DomScanner = {
        _addedNodesBuffer: [],
        // 已扫描节点弱引用集合：避免对同一节点重复执行资源域/路径扫描（O(1) 判重）
        // WeakSet 不阻止 GC，节点从 DOM 移除后自动释放，杜绝内存泄漏
        _scannedNodes: new WeakSet(),
        // 选择模式导航冻结标志：选择模式开启时 SPA 路由跳转被静默阻止，避免双重劫持导致路由监听失效
        _selectionNavLocked: false,
        // Shadow DOM 穿透：代理 attachShadow，将隐藏在 Shadow DOM 内的贴片广告纳入扫描
        _shadowRoots: new WeakSet(),
        // 每个 shadow root 独立的去抖定时器，避免高频注入下重复全量扫描
        _shadowApplyTimers: new WeakMap(),

        scanAndBlockDynamic(node, cachedDomainList, cachedPathPatterns, options = {}) {
            // fallback 路径同样过滤 _disabled 规则，与 _getLists()/getDomainSet() 保持一致
            const domainList = cachedDomainList !== undefined ? cachedDomainList : (BlockEngine._cachedDomainList !== null ? BlockEngine._cachedDomainList : storage.getDomainBlocks().filter(r => !r._disabled).map(r => r.domain));
            const pathPatterns = cachedPathPatterns !== undefined ? cachedPathPatterns : (BlockEngine._cachedPathPatterns !== null ? BlockEngine._cachedPathPatterns : storage.getData().pathPattern.filter(r => !r._disabled));
            if (BlockEngine._cachedDomainList === null) BlockEngine._cachedDomainList = domainList;
            if (BlockEngine._cachedPathPatterns === null) BlockEngine._cachedPathPatterns = pathPatterns;
            // 域名集合与列表同生命周期：列表重建时集合一并重建，避免每次匹配都 new Set
            if (BlockEngine._cachedDomainSet === null) BlockEngine._cachedDomainSet = new Set(BlockEngine._cachedDomainList);
            const domainSet = BlockEngine._cachedDomainSet;
            if (domainList.length === 0 && pathPatterns.length === 0) return;
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
            // WeakSet 去重：已扫描节点跳过，避免全页重复扫描；属性变更时 options.force 强制重扫
            if (!options.force && this._scannedNodes.has(node)) return;
            this._scannedNodes.add(node);

            const elements = [node];
            try {
                node.querySelectorAll && node.querySelectorAll('img, iframe, video, script, a, source, embed, object').forEach(el => elements.push(el));
            } catch (e) { Log.warn(e.message || e); }

            const currentHost = window.location.hostname;

            const _t0 = performance.now();
            elements.forEach(el => {
                // 全局保护：脚本自身 UI 宿主及其子节点跳过，避免误伤面板
                if (ProtectedCheck.isProtected(el)) return;
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
                        const pathMatcher = BlockEngine.getPathMatcher();
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
                                if (BlockEngine.hostnameBlocked(urlObj.hostname, domainSet)) {
                                    blocked = true;
                                    matchedDomain = urlObj.hostname;
                                    break;
                                }
                            }
                        }
                    } catch (e) { Log.warn(e.message || e); }
                }

                if (blocked) {
                    const target = BlockEngine.findSingleChildWrapper(el, 4);
                    // 闪现检测必须在隐藏之前：display:none 会使 getBoundingClientRect 返回 0×0
                    // 元素已渲染出非零尺寸才说明它"闪现"过 → 标记域名，下次进入自动启用 preemptive
                    BlockEngine.detectFlashAndMark(el, matchedDomain ? `https://${matchedDomain}/` : '');
                    BlockEngine.stats.domBlocks++;
                    // 统一隐藏口径(5.2 节)：display/opacity/visibility/pointer-events 四件套
                    ElementHider.hideElement(target);
                    if (matchedDomain && !BlockEngine._loggedDomains.has(matchedDomain)) {
                        BlockEngine._loggedDomains.add(matchedDomain);
                        // console.info(`[Pro Blocker] 动态拦截域名: ${matchedDomain}`);
                    }
                    if (matchedPattern && !BlockEngine._loggedPatterns.has(matchedPattern)) {
                        BlockEngine._loggedPatterns.add(matchedPattern);
                        // console.info(`[Pro Blocker] 动态拦截路径: ${matchedPattern}`);
                    }
                }
            });
            // 累计匹配引擎耗时，供管理面板看板展示 Long Task 风险
            BlockEngine.stats.matchTimeMs += performance.now() - _t0;
        },

        startObserver() {
            // 监听这些资源属性的变化，捕获懒加载广告（src 在元素插入后才被 JS 设置）
            // data-href/data-url/data-lazy-src 等是常见广告 SDK 的懒加载属性，需一并监听
            const RESOURCE_ATTRS = ['src', 'href', 'data-src', 'data-original', 'data-href', 'data-url', 'data-link', 'data-lazy', 'data-lazy-src', 'data-srcset', 'poster', 'srcset'];

            // 正则/积木规则较重，去抖执行；缩短到 120ms/600ms 让广告闪现时间最短
            const debouncedDynamicApply = debounce(() => {
                const rawNodes = this._addedNodesBuffer;
                this._addedNodesBuffer = [];
                if (rawNodes.length === 0) {
                    RegexEngine.applyRegexRules();
                    RegexEngine.applyComplexRules();
                    // 不可见覆盖层扫描：动态注入的透明 overlay 也需在去抖窗口内拦截
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
                    return;
                }
                // 过滤游离节点 + 去除嵌套（子节点会被父节点的子树扫描覆盖）
                const nodes = rawNodes.filter(n =>
                    document.contains(n) && !rawNodes.some(other => other !== n && other.contains(n))
                );
                if (nodes.length === 0) {
                    RegexEngine.applyRegexRules();
                    RegexEngine.applyComplexRules();
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
                } else {
                    nodes.forEach(node => {
                        RegexEngine.applyRegexRules(node);
                        RegexEngine.applyComplexRules(node);
                        // 对新增子树单独扫描，避免每次都全页扫描
                        BlockEngine.scanInvisibleOverlays({ autoBlock: true, root: node });
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
                const styleEl = document.getElementById(CSSInjector.styleElementId);
                if (styleEl && document.head && styleEl.parentElement !== document.head) {
                    document.head.insertBefore(styleEl, document.head.firstChild);
                    CSSInjector.applyCSSRules();
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
                CSSInjector.applyCSSRules();
                if (document.body) {
                    RegexEngine.applyRegexRules();
                    RegexEngine.applyComplexRules();
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    // 不可见覆盖层在 body 就绪后立即扫描，防止首次进入就被透明 overlay 截获点击
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
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
                CSSInjector.applyCSSRules();
                RegexEngine.applyRegexRules();
                RegexEngine.applyComplexRules();
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
                }
            });

            // 页面完全加载后再做一次兜底扫描
            window.addEventListener('load', () => {
                CSSInjector.applyCSSRules();
                RegexEngine.applyRegexRules();
                RegexEngine.applyComplexRules();
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
                }
                // 自愈检查：本次加载（含 preemptive 各时序扫描）未检测到闪现 → 记录一次干净加载
                // 连续 3 次干净加载后 flashList 自动清除，preemptive 强制启用随之解除
                if (!BlockEngine._flashDetectedThisLoad) {
                    storage.recordCleanLoad();
                }
            });

            // SPA 路由变化时重新应用规则（解决点击链接不刷新导致广告漏网）
            let _lastUrl = location.href;
            const reapplyOnNavigation = () => {
                if (location.href === _lastUrl) return;
                _lastUrl = location.href;
                CSSInjector.applyCSSRules();
                RegexEngine.applyRegexRules();
                RegexEngine.applyComplexRules();
                if (document.body) {
                    this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
                    BlockEngine.scanInvisibleOverlays({ autoBlock: true });
                }
            };
            window.addEventListener('popstate', reapplyOnNavigation);
            window.addEventListener('hashchange', reapplyOnNavigation);

            // 额外兜底：某些 SPA 通过 history.pushState 导航，劫持它以触发重应用
            // 选择模式开启时 SPA 路由跳转被静默阻止，改用标志位让 wrapper 主动让路
            const _pushState = history.pushState;
            history.pushState = function (...args) {
                if (BlockEngine._selectionNavLocked) return; // 选择模式静默阻止路由跳转
                _pushState.apply(this, args);
                setTimeout(() => reapplyOnNavigation(), 0);
            };
            const _replaceState = history.replaceState;
            history.replaceState = function (...args) {
                if (BlockEngine._selectionNavLocked) return;
                _replaceState.apply(this, args);
                setTimeout(() => reapplyOnNavigation(), 0);
            };
        },

        hookAttachShadow() {
            const orig = Element.prototype.attachShadow;
            if (!orig || orig.__proBlockerHooked) return;
            const hooked = function (init) {
                const root = orig.call(this, init);
                try { DomScanner._observeShadowRoot(root); } catch (e) { Log.warn(e.message || e); }
                return root;
            };
            hooked.__proBlockerHooked = true;
            Element.prototype.attachShadow = hooked;
        },

        _observeShadowRoot(root) {
            if (!root || this._shadowRoots.has(root)) return;
            this._shadowRoots.add(root);
            // 立即扫描已有内容：ShadowRoot 非 ELEMENT_NODE，需遍历其子元素逐个扫描
            // 否则 scanAndBlockDynamic 第 741 行 nodeType 守卫会直接 return，初始扫描成空操作
            const { domainList, pathPatterns } = this._getLists();
            if (domainList.length > 0 || pathPatterns.length > 0) {
                Array.from(root.children).forEach(child => this.scanAndBlockDynamic(child, domainList, pathPatterns, { force: true }));
            }
            RegexEngine.applyRegexRules(root);
            RegexEngine.applyComplexRules(root);
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
        },

        // 去抖对 shadow root 应用正则/积木规则 + 覆盖层扫描，避免高频 mutation 重复全量扫描
        _scheduleShadowApply(root) {
            const existing = this._shadowApplyTimers.get(root);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
                this._shadowApplyTimers.delete(root);
                RegexEngine.applyRegexRules(root);
                RegexEngine.applyComplexRules(root);
                // shadow 内动态注入的透明跳转层同样需拦截，与主观察器行为一致
                BlockEngine.scanInvisibleOverlays({ autoBlock: true, root: root });
            }, 150);
            this._shadowApplyTimers.set(root, timer);
        },

        // 缓存获取域名/路径列表（供 shadow observer 等复用）
        _getLists() {
            // 过滤 _disabled=true 的规则：domainBlock 仅取 domain 字段，pathPattern 保留对象
            if (BlockEngine._cachedDomainList === null) BlockEngine._cachedDomainList = storage.getDomainBlocks().filter(r => !r._disabled).map(r => r.domain);
            if (BlockEngine._cachedPathPatterns === null) BlockEngine._cachedPathPatterns = storage.getData().pathPattern.filter(r => !r._disabled);
            return { domainList: BlockEngine._cachedDomainList, pathPatterns: BlockEngine._cachedPathPatterns };
        }
    };

    // ═══════════════════════════════════════════════════════════
    // BlockEngine：核心拦截引擎（引擎层·规则应用中枢）
    // 职责：域名/路径匹配、选择器生成、CSS 规则重建、隐藏/显示操作
    // 性能：LRU 缓存（域名 200 条 + URL 100 条）、倒排索引（路径 4-char 滑窗）
    // 依赖：StorageManager、CSSInjector、PathInvertedIndex、ElementHider、DomScanner
    // ═══════════════════════════════════════════════════════════
    class BlockEngine {
        static _cachedDomainList = null;
        static _cachedDomainSet = null;
        static _cachedPathPatterns = null;
        static _cachedPathRegex = null; // 合并路径正则缓存：false 表示无路径规则
        static _cachedPathIndex = null; // 倒排索引构建标记：null=未构建，true=已构建
        static _loggedDomains = new Set();
        static _loggedPatterns = new Set();
        static _loggedOverlays = new Set();
        // 拦截统计：供管理面板看板展示，衡量网络层与 DOM 层拦截成效
        static stats = { networkBlocks: 0, domBlocks: 0, matchTimeMs: 0 };
        // 选择模式导航冻结标志：startObserver 的 pushState/replaceState wrapper 据此让路(BUG-S1)
        // true 时 SPA 路由跳转被静默阻止，避免双重劫持导致退出选择模式后路由监听失效
        // 已迁移至 DomScanner，此处保留 getter/setter 转发以兼容 UIManager 的 BlockEngine._selectionNavLocked 读写
        static get _selectionNavLocked() { return DomScanner._selectionNavLocked; }
        static set _selectionNavLocked(v) { DomScanner._selectionNavLocked = v; }
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
            CSSInjector.invalidateFingerprint(); // 规则变更后强制下次 applyCSSRules 重建样式表
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
            } catch (e) { Log.warn(e.message || e); }
            // LRU 淘汰：缓存满 100 条时淘汰最旧条目
            if (this._urlBlockCache.size >= 100) {
                this._urlBlockCache.delete(this._urlBlockCache.keys().next().value);
            }
            this._urlBlockCache.set(url, result);
            return result;
        }

        static isRegexSafe(pattern) {
            return RegexEngine.isRegexSafe(pattern);
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
            } catch (e) { Log.warn(e.message || e); }
        }

        /**
         * 不可见覆盖层广告扫描：检测"看不见但触屏/点击就跳转"的透明 overlay
         * 典型特征：position:fixed/absolute + opacity:0/visibility:hidden + pointer-events:auto + 大面积
         * autoBlock=true 时直接屏蔽高风险项；返回全部候选供 UI 审阅
         * B3 修复：增加 view 参数，支持帧内复用——getComputedStyle/innerWidth/innerHeight 全部改走 view
         */
        static scanInvisibleOverlays(options = {}) {
            const { autoBlock = true, root = document.documentElement, minSize = 50, _depth = 0, view = window } = options;
            const results = [];
            if (!root || !root.ownerDocument?.body) return results;
            // Shadow DOM 递归深度限制：浏览器 shadow 嵌套通常 ≤3 层，但恶意/异常页面
            // 可能构造循环引用导致栈溢出，防御性限制最大 5 层
            if (_depth > 5) return results;

            const selfHost = view.location?.hostname || '';

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

            // B3 修复：帧内扫描使用帧自身的 view
            const viewCSS = el => safeGetComputedStyle(el, view);

            candidates.forEach(el => {
                const record = this._checkOverlayCandidate(el, minSize, selfHost, autoBlock, view, viewCSS);
                if (record) results.push(record);
            });

            // 穿透 Shadow DOM 边界：querySelectorAll 不进入 shadow root，需递归扫描 shadow 内的覆盖层
            // 广告 SDK 常在 shadow 内注入透明跳转层以规避常规选择器，不递归则完全漏拦
            // 脚本自身的 closed shadowRoot 不可访问，且 isProtectedElement 已在候选遍历时排除
            candidates.forEach(el => {
                if (el.shadowRoot && !ProtectedCheck.isProtected(el)) {
                    const shadowResults = this.scanInvisibleOverlays({ autoBlock, root: el.shadowRoot, minSize, _depth: _depth + 1, view });
                    for (let i = 0; i < shadowResults.length; i++) results.push(shadowResults[i]);
                }
            });

            return results;
        }

        // 单个候选元素的覆盖层检测逻辑（同步/异步扫描共用）
        // B3 修复：增加 view 和 viewCSS 参数，支持帧内复用
        static _checkOverlayCandidate(el, minSize, selfHost, autoBlock, view = window, viewCSS = null) {
            viewCSS = viewCSS || ((el) => { try { return view.getComputedStyle(el); } catch (e) { return null; } });
            // 统一保护判定：脚本自身 UI 宿主（含 Shadow DOM 内部）跳过，避免误伤面板
            if (ProtectedCheck.isProtected(el)) return null;
            if (el.style.display === 'none') return null;

            // 两阶段过滤：先用廉价的 getBoundingClientRect 过滤面积/视口，
            // 再对达标元素调用昂贵的 getComputedStyle，减少 80%+ 的 getComputedStyle 调用
            const rect = el.getBoundingClientRect();
            if (rect.width < minSize || rect.height < minSize) return null;
            const area = rect.width * rect.height;
            if (area < minSize * minSize) return null;
            // B3 修复：视口相交判定使用帧的 view
            const vw = view.innerWidth || (view.document?.documentElement?.clientWidth) || 1;
            const vh = view.innerHeight || (view.document?.documentElement?.clientHeight) || 1;
            if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) return null;

            let style;
            try { style = viewCSS(el); } catch (e) { return null; }
            if (!style) return null;
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
                highRisk: false,
                // will-change 检测：广告覆盖层常提前创建合成层以规避检测(7.3 节)
                hasWillChange: style.willChange && style.willChange !== 'auto'
            };

            try {
                if (triggerUrl) {
                    const base = view.location?.href || location.href;
                    const u = new URL(triggerUrl, base);
                    record.crossDomain = u.hostname !== selfHost;
                    // will-change 元素更可能是动态注入的覆盖层，降低 highRisk 面积阈值
                    record.highRisk = record.crossDomain && (area > (minSize * minSize * 4) || record.hasWillChange);
                }
            } catch (e) { record.crossDomain = false; }

            if (autoBlock && (record.highRisk || (record.triggerUrl && record.crossDomain))) {
                // 统一隐藏口径(5.2 节 & BUG-M3)：补齐 opacity:0
                this.hideElement(el);
                record.blocked = true;
                const key = record.tagName + '|' + record.id + '|' + record.className;
                if (!this._loggedOverlays.has(key)) {
                    this._loggedOverlays.add(key);
                    Log.info(`[Pro Blocker] 拦截不可见覆盖层 ${record.tagName} ${record.rect.w}x${record.rect.h} -> ${triggerUrl || 'onclick'}`);
                }
            }
            return record;
        }

        // 异步覆盖层扫描：requestIdleCallback 时间分片，避免大型页面 5000+ 候选导致主线程卡顿
        // autoBlock=false 供 UI 面板使用；autoBlock=true 仍建议用同步版本确保即时拦截
        static scanInvisibleOverlaysAsync(options = {}) {
            return new Promise((resolve) => {
                const { autoBlock = false, root = document.documentElement, minSize = 50, _depth = 0, view = window } = options;
                const results = [];
                if (!root || !root.ownerDocument?.body) return resolve(results);
                if (_depth > 5) return resolve(results);
                const selfHost = view.location?.hostname || '';

                let candidates;
                try {
                    candidates = root.querySelectorAll(
                        'a, iframe, div, button, span, img, object, embed, ins, ' +
                        '[onclick], [ontouchstart], [onmousedown], ' +
                        '[data-href], [data-url], [data-link], ' +
                        'div[style*="position"], div[style*="z-index"]'
                    );
                } catch (e) { return resolve(results); }

                const viewCSS = el => safeGetComputedStyle(el, view);
                const _check = (el) => this._checkOverlayCandidate(el, minSize, selfHost, autoBlock, view, viewCSS);

                // 无 requestIdleCallback 时降级为同步（保证功能可用）
                if (typeof requestIdleCallback !== 'function') {
                    candidates.forEach(el => {
                        const record = _check(el);
                        if (record) results.push(record);
                    });
                    // Shadow DOM 递归（同步）
                    this._scanShadowOverlays(candidates, autoBlock, minSize, _depth, results, view, viewCSS);
                    return resolve(results);
                }

                // 时间分片：每帧处理一批，timeRemaining 耗尽则让出到下一空闲帧
                let idx = 0;
                const processBatch = (deadline) => {
                    while (idx < candidates.length) {
                        const el = candidates[idx++];
                        const record = _check(el);
                        if (record) results.push(record);
                        const hasTime = deadline.timeRemaining ? deadline.timeRemaining() > 2 : true;
                        if (!hasTime && !deadline.didTimeout) {
                            requestIdleCallback(processBatch, { timeout: 200 });
                            return;
                        }
                    }
                    // 候选处理完毕，递归扫描 Shadow DOM（通常候选少，同步处理）
                    this._scanShadowOverlays(candidates, autoBlock, minSize, _depth, results, view, viewCSS);
                    resolve(results);
                };
                requestIdleCallback(processBatch, { timeout: 200 });
            });
        }

        // Shadow DOM 递归扫描辅助：供同步/异步扫描共用
        static _scanShadowOverlays(candidates, autoBlock, minSize, _depth, results, view = window, viewCSS = null) {
            candidates.forEach(el => {
                if (el.shadowRoot && !ProtectedCheck.isProtected(el)) {
                    const shadowResults = this.scanInvisibleOverlays({ autoBlock, root: el.shadowRoot, minSize, _depth: _depth + 1, view });
                    for (let i = 0; i < shadowResults.length; i++) results.push(shadowResults[i]);
                }
            });
        }

        static applyCSSRules() {
            return CSSInjector.applyCSSRules();
        }

        // 通用内联样式还原：删除任意类型规则后，清除所有由脚本设置的内联隐藏样式
        // 适用于 static/dynamic/attribute/structural/regex/complex 规则删除场景
        // 策略：清除所有带 display:none!important 的内联样式，然后重建 CSS 表 + 重扫
        static restoreAllInlineStyles() {
            return CSSInjector.restoreAllInlineStyles();
        }

        // 获取（惰性创建）当前生效的 CSSStyleSheet：
        // 优先 Constructable Stylesheets（C++ 对象，零解析、防探查），不支持时降级到 <style>.sheet
        static _getSheet() {
            return CSSInjector._getSheet();
        }

        // 清空任意 CSSStyleSheet（构造样式表 或 <style>.sheet）的所有规则
        static _clearSheetRules(sheet) {
            return CSSInjector._clearSheetRules(sheet);
        }

        /**
         * 动态拦截核心：扫描新增节点的资源域与路径模式，命中则隐藏整个广告容器
         * 解决"刷新就复活"——动态生成的广告无法靠固定CSS规则拦截
         */
        static scanAndBlockDynamic(node, cachedDomainList, cachedPathPatterns, options) {
            return DomScanner.scanAndBlockDynamic(node, cachedDomainList, cachedPathPatterns, options);
        }

        static getCompiledRegex(pattern) {
            return RegexEngine.getCompiledRegex(pattern);
        }

        static applyRegexRules(targetNode) {
            return RegexEngine.applyRegexRules(targetNode);
        }

        static _executeRegexMatch(node, mergedBatches, containsRules) {
            return RegexEngine._executeRegexMatch(node, mergedBatches, containsRules);
        }

        static _hideRegexAncestor(node, level) {
            return RegexEngine._hideRegexAncestor(node, level);
        }

        static _applyRegexRulesSync(targetNode, mergedBatches, containsRules) {
            return RegexEngine._applyRegexRulesSync(targetNode, mergedBatches, containsRules);
        }

        // ===== 共享方法：积木条件匹配 + 文本节点遍历（消除 applyComplexRules / showRegexPanel / evaluateRuleImpact 重复） =====

        static walkTextNodes(root, callback) {
            return RegexEngine.walkTextNodes(root, callback);
        }

        // 积木模式：从条件列表构建 CSS 基础选择器（AND 逻辑可利用 class/id 缩小候选集）
        static _buildComplexBaseSelector(conditions, logic) {
            return SelectorBuilder._buildComplexBaseSelector(conditions, logic);
        }

        static evaluateConditions(conditions, logic, el) {
            return RegexEngine.evaluateConditions(conditions, logic, el);
        }

        // 按 level 向上查找祖先元素（跳过 body/documentElement），用于积木/正则命中后定位隐藏目标
        static findLevelAncestor(el, level) {
            return SelectorBuilder.findLevelAncestor(el, level);
        }

        static applyComplexRules(targetNode) {
            return RegexEngine.applyComplexRules(targetNode);
        }

        static hookAttachShadow() {
            return DomScanner.hookAttachShadow();
        }

        static _observeShadowRoot(root) {
            return DomScanner._observeShadowRoot(root);
        }

        // 去抖对 shadow root 应用正则/积木规则 + 覆盖层扫描，避免高频 mutation 重复全量扫描
        static _scheduleShadowApply(root) {
            return DomScanner._scheduleShadowApply(root);
        }

        // 缓存获取域名/路径列表（供 shadow observer 等复用）
        static _getLists() {
            return DomScanner._getLists();
        }

        static startObserver() {
            return DomScanner.startObserver();
        }

        static generateOptimalSelector(element) {
            return SelectorBuilder.generateOptimalSelector(element);
        }

        static generateStructuralSelector(element) {
            return SelectorBuilder.generateStructuralSelector(element);
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
            const relativePaths = new Set(); // 同源相对路径 /xxx，供路径模式自动提取(BUG-A3)
            const domainMeta = new Map(); // domain -> {score, sources:Set, reasons:Set}
            if (!element) return { urls: [], domains: [], scoredDomains: [], paths: [] };

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
                // BUG-A3 修复：相对路径 /xxx 不含 hostname，无法提取域名，但可用于路径模式自动提取。
                // 旧版直接 return 导致 result.urls 永远不含相对路径，"自动记录路径模式"功能形同死代码。
                // 此处将相对路径收集到 relativePaths，供 btn-domain 回调提取前 3 段作为 pathPattern。
                if (!absUrl.startsWith('http')) {
                    if (url.startsWith('/') && url.length > 5) {
                        relativePaths.add(url.split('?')[0].split('#')[0]);
                    }
                    return;
                }
                try {
                    const urlObj = new URL(absUrl);
                    if (!urlObj.hostname) return;
                    urls.add(url);
                    const host = urlObj.hostname.toLowerCase();
                    if (host === window.location.hostname || host.endsWith('.' + window.location.hostname)) {
                        // 同源绝对 URL 的路径也收集，供路径模式提取(BUG-A3)
                        // pathname 本身不含 query/hash（它们在 .search/.hash），无需 split(冗余-4.2)
                        const p = urlObj.pathname;
                        if (p && p.startsWith('/') && p.length > 5) relativePaths.add(p);
                        return;
                    }
                    if (!domainMeta.has(host)) domainMeta.set(host, { score: 0, sources: new Set(), reasons: new Set(), count: 0 });
                    const meta = domainMeta.get(host);
                    meta.count++;
                    meta.sources.add(source);
                    if (reason) meta.reasons.add(reason);
                } catch (e) { Log.warn(e.message || e); }
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
            } catch (e) { Log.warn(e.message || e); }

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
                            } catch (e) { Log.warn(e.message || e); }
                        });
                    });
                } catch (e) { Log.warn(e.message || e); }
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
                } catch (e) { Log.warn(e.message || e); }

                // 内联事件属性中的 URL 采集（onclick/ontouchstart/onmousedown + data-href/data-url/data-link）
                try {
                    const inlineEls = document.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                    inlineEls.forEach(el => {
                        ['onclick', 'ontouchstart', 'onmousedown', 'data-href', 'data-url', 'data-link'].forEach(attr => {
                            const val = el.getAttribute(attr);
                            if (val) scanString(val, 'inline-event');
                        });
                    });
                } catch (e) { Log.warn(e.message || e); }
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
                meta.score = clampScore(score, 0, 100);
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

            return { urls: Array.from(urls), domains: scoredDomains.map(d => d.host), scoredDomains, paths: Array.from(relativePaths) };
        }

        /**
         * 从 extractResourceDomains 的结果中提取路径模式候选(BUG-A3 + 冗余-7)
         * 取每个相对路径/同源路径的前 3 段作为 pathPattern，≥2 段才收录
         * 统一 btn-domain 回调与 _applyActionPreviewHiding 的路径提取口径，消除重复代码
         * @param {Object} result - extractResourceDomains 返回值
         * @returns {Set<string>} 路径模式集合，如 {'/ads/banner', '/static/img'}
         */
        static extractPathCandidates(result) {
            return SelectorBuilder.extractPathCandidates(result);
        }

        static isSafeOutermost(element) {
            return SelectorBuilder.isSafeOutermost(element);
        }

        /**
         * 沿单子链向上查找包裹容器：父级仅含一个元素子节点时继续向上
         * 遇到多子分支或 body/html 时停止。maxDepth 防止极端深度
         */
        static findSingleChildWrapper(element, maxDepth = 6) {
            return SelectorBuilder.findSingleChildWrapper(element, maxDepth);
        }

        /**
         * 智能查找广告最外层容器：沿单子链向上，遇到多子分支即停止
         */
        static findOutermostAdContainer(element) {
            return SelectorBuilder.findOutermostAdContainer(element);
        }

        // ─── 统一隐藏口径(BUG-M3 & 5.2 隐藏口径统一) ───
        // 所有 DOM 层隐藏入口必须调用此方法，确保 display/opacity/visibility/pointer-events 四件套一致，
        // 避免各处只写 2~3 个属性导致广告元素仍可点击或仍占据空间。
        // 保护脚本自身 UI 宿主：拦截入口统一豁免 #pro-blocker-ui-host，防止任何规则隐藏面板
        static hideElement(el) {
            return ElementHider.hideElement(el);
        }

        // 还原 hideElement 设置的内联隐藏样式（删除规则/禁用规则/预览还原时调用）
        static showElement(el) {
            return ElementHider.showElement(el);
        }

        // 统一重新应用：删除/禁用/撤销规则后调用，替代各面板重复的 5 行重应用代码(4.5 节)
        static reapplyAll() {
            this.restoreAllInlineStyles();
            this.applyCSSRules();
            this.applyRegexRules();
            this.applyComplexRules();
            this.scanAndBlockDynamic(document.body, undefined, undefined, { force: true });
        }
    }

    /**
     * 网络层拦截器：在 document-start 阶段劫持 fetch / XHR / script.src，
     * 命中全局域名黑名单或路径模式时直接丢弃请求，从源头阻止广告资源加载（而非等 DOM 渲染后再隐藏）。
     * 判定逻辑复用 BlockEngine.isUrlBlocked，与 DOM 层拦截规则完全一致，避免双标。
     */
    // ═══════════════════════════════════════════════════════════
    // NetworkEngine（原名 NetworkInterceptor，保留别名）：网络请求拦截引擎
    // 职责：Hook fetch/XHR/script.src/img.src/link.href/media.src 等网络请求，
    //       在请求发起前检查域名黑名单和路径模式，拦截广告请求
    // 依赖：BlockEngine（isUrlBlocked）
    // 命名：保持 NetworkInterceptor 别名兼容，同时使用 NetworkEngine 新名称
    // ═══════════════════════════════════════════════════════════
    const NetworkEngine = {
        init() {
            this.hookFetch();
            this.hookXHR();
            this.hookScriptSrc();
            this.hookImageSrc();
            this.hookLinkHref();
            this.hookMediaSrc();
            this.hookWebSocket();
            this.hookSendBeacon();
            this.hookIframeSrc();
        },

        isUrlBlocked(url) {
            // 显式规则拦截：域名黑名单 + 路径模式（与 DOM 层规则一致）
            return BlockEngine.isUrlBlocked(url);
        },

        hookFetch() {
            if (!window.fetch || window.fetch.__proBlockerHooked) return;
            const origFetch = window.fetch;
            const hooked = function (input, init) {
                let url = '';
                if (typeof input === 'string') url = input;
                else if (input && typeof input.url === 'string') url = input.url;
                if (NetworkEngine.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    // 返回空 200 响应，避免页面 fetch().then 抛错影响正常逻辑
                    return Promise.resolve(new Response('', { status: 200, statusText: 'blocked by Pro Blocker' }));
                }
                return origFetch.apply(this, arguments);
            };
            hooked.__proBlockerHooked = true;
            window.fetch = hooked;
        },

        hookXHR() {
            if (!window.XMLHttpRequest || XMLHttpRequest.prototype.open.__proBlockerHooked) return;
            const origOpen = XMLHttpRequest.prototype.open;
            const hooked = function (method, url) {
                if (NetworkEngine.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    // 改写为 about:blank（同源空响应），XHR 正常完成但无广告数据
                    arguments[1] = 'about:blank';
                }
                return origOpen.apply(this, arguments);
            };
            hooked.__proBlockerHooked = true;
            XMLHttpRequest.prototype.open = hooked;
        },

        hookScriptSrc() {
            this._hookSrcProperty(HTMLScriptElement, 'src');
        },

        hookImageSrc() {
            this._hookSrcProperty(HTMLImageElement, 'src');
        },

        hookLinkHref() {
            this._hookSrcProperty(HTMLLinkElement, 'href');
        },

        hookMediaSrc() {
            this._hookSrcProperty(HTMLMediaElement, 'src');
        },

        _hookSrcProperty(ElementClass, propName) {
            const desc = Object.getOwnPropertyDescriptor(ElementClass.prototype, propName);
            if (!desc || !desc.set || desc.set.__proBlockerHooked) return;
            const origSet = desc.set;
            const hooked = function (url) {
                if (NetworkEngine.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    return; // 静默丢弃：不设置 src/href，广告资源永不加载
                }
                return origSet.call(this, url);
            };
            hooked.__proBlockerHooked = true;
            try {
                Object.defineProperty(ElementClass.prototype, propName, {
                    get: desc.get,
                    set: hooked,
                    configurable: true,
                    enumerable: desc.enumerable
                });
            } catch (e) {
                // 某些环境描述符不可重定义，静默跳过（DOM 层仍会拦截）
            }
        },

        hookIframeSrc() {
            this._hookSrcProperty(HTMLIFrameElement, 'src');
        },

        hookWebSocket() {
            if (!window.WebSocket || window.WebSocket.__proBlockerHooked) return;
            const OrigWS = window.WebSocket;
            // 全局追踪集合：记录所有 WS 连接目标，供 GlobalDomainScanner 深度扫描挖掘隐藏域名
            if (!Array.isArray(window.__proBlocker_ws_targets)) {
                try { Object.defineProperty(window, '__proBlocker_ws_targets', { value: [], writable: true, configurable: true }); } catch (e) { window.__proBlocker_ws_targets = []; }
            }
            const hooked = function (url, protocols) {
                // 记录 WS 目标（无论是否拦截），供深度域名扫描使用
                try {
                    const target = typeof url === 'string' ? url : (url && url.url) || '';
                    if (target && window.__proBlocker_ws_targets.length < 200) window.__proBlocker_ws_targets.push(target);
                } catch (e) { Log.warn(e.message || e); }
                if (NetworkEngine.isUrlBlocked(typeof url === 'string' ? url : (url && url.url) || '')) {
                    BlockEngine.stats.networkBlocks++;
                    // 返回一个立即关闭的伪 WebSocket，避免页面 new WS() 抛错
                    return new OrigWS('ws://localhost:0'); // 连接立即失败，不产生广告上报
                }
                return new OrigWS(url, protocols);
            };
            hooked.__proBlockerHooked = true;
            hooked.prototype = OrigWS.prototype;
            hooked.CONNECTING = OrigWS.CONNECTING;
            hooked.OPEN = OrigWS.OPEN;
            hooked.CLOSING = OrigWS.CLOSING;
            hooked.CLOSED = OrigWS.CLOSED;
            try { window.WebSocket = hooked; } catch (e) { Log.warn(e.message || e); }
        },

        hookSendBeacon() {
            if (!navigator.sendBeacon || navigator.sendBeacon.__proBlockerHooked) return;
            const origBeacon = navigator.sendBeacon.bind(navigator);
            const hooked = function (url, data) {
                if (NetworkEngine.isUrlBlocked(url)) {
                    BlockEngine.stats.networkBlocks++;
                    return true; // 静默丢弃：返回 true 让页面认为上报成功
                }
                return origBeacon(url, data);
            };
            hooked.__proBlockerHooked = true;
            try { navigator.sendBeacon = hooked; } catch (e) { Log.warn(e.message || e); }
        }
    };

    // 保留别名：NetworkInterceptor → NetworkEngine（向后兼容）
    const NetworkInterceptor = NetworkEngine;


    // ═══════════════════════════════════════════════════════════
    // DomainAnalyzer：统一域名分析引擎
    // 职责：资源域名提取 + 评分 + 采集通道管理
    // 合并自：GlobalDomainScanner + BlockEngine.extractResourceDomains
    // 依赖：isAdKeywordHost, GAMBLING_TLDS, AD_TOKENS_UNIFIED, storage
    // ═══════════════════════════════════════════════════════════    // ═══════════════════════════════════════════════════════════
    const DomainAnalyzer = {
        // 委托到 BlockEngine.extractResourceDomains（后续逐步迁移实现）
        extractResourceDomains(element, options) {
            return BlockEngine.extractResourceDomains(element, options);
        },

        // 委托到 GlobalDomainScanner（后续逐步迁移实现）
        collect(root) {
            return GlobalDomainScanner.collect(root);
        },

        scan(root, options) {
            return GlobalDomainScanner.scan(root, options);
        },

        deepScan() {
            return GlobalDomainScanner.deepScan();
        }
    };


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

        // ─── 广告词元库（使用顶层统一集合，消除重复维护 6.5 节）───
        const AD_TOKENS = AD_TOKENS_UNIFIED;

        // ─── 博彩/色情/恶意跳转词元库（使用顶层统一集合）───
        const VICE_TOKENS = VICE_TOKENS_UNIFIED;

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
                    } catch (ex) { Log.warn(ex.message || ex); }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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
                        } catch (ex) { Log.warn(ex.message || ex); }
                    }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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
                                } catch (e2) { Log.warn(e2.message || e2); }
                            }
                        }
                    } catch (ex) { Log.warn(ex.message || ex); }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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
                                    } catch (e3) { Log.warn(e3.message || e3); }
                                }
                            }
                        }
                    } catch (ex) { Log.warn(ex.message || ex); }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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
                    } catch (ex) { Log.warn(ex.message || ex); }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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
                                } catch (ex) { Log.warn(ex.message || ex); }
                            }
                        }
                    }
                }
            } catch (ex) { Log.warn(ex.message || ex); }

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

            return { score: clampScore(s, 0, 100), level, reasons: r, signals: sig };
        }

        // ════════════════════════════════════════
        //  主入口
        // ════════════════════════════════════════
        function scan() {
            const t0 = performance.now();
            const map = collect();
            // 优化方案 §6.1 面板3：扫描同域 iframe 内的资源域名
            collectIframeDomains(map);
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

        // ════════════════════════════════════════
        //  真·深度域名挖掘（v0.7.0 新增）
        //  补充 collect() 6 通道未覆盖的隐藏域名：
        //  - Service Worker / Web Worker 后台线程域名
        //  - 活跃 WebSocket 连接域名
        //  - Base64 / Blob URL 溯源
        //  - CSS 伪元素 ::before/::after 中的 url() 注入
        //  - SVG <use href> / <image href> 资源引用
        // ════════════════════════════════════════

        /**
         * 收集 deep scan 阶段独有的隐藏域名，并入主 map
         * @param {Map} baseMap collect() 返回的主 map，函数内就地合并
         * @returns {Object} { swHosts: [], wsHosts: [], blobUrls: [], pseudoUrls: [], svgUrls: [] }
         */
        function _collectDeepDomains(baseMap) {
            const curHost = location.hostname.toLowerCase();
            const main = mainDomain(curHost);
            const extras = { swHosts: [], wsHosts: [], blobUrls: [], pseudoUrls: [], svgUrls: [] };

            function _addHost(hostname, url, type) {
                if (!hostname || hostname === curHost || isSameSite(hostname, main)) return;
                let info = baseMap.get(hostname);
                if (!info) {
                    info = { hostname, urls: [], types: new Set(), bytes: 0, count: 0, t0: 0, t1: 0, hasRedirect: false, thirdParty: true };
                    baseMap.set(hostname, info);
                }
                if (info.urls.length < MAX_URLS_PER_HOST) info.urls.push(url);
                info.types.add(type);
                info.count++;
                return info;
            }

            // ① Service Worker 后台线程域名
            try {
                if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                    // getRegistrations 返回 Promise，深度扫描时同步收集可能尚未完成
                    // 此处用 .then 异步收集，仅作尽力而为探测
                    navigator.serviceWorker.getRegistrations().then(regs => {
                        for (const reg of regs) {
                            try {
                                const u = new URL(reg.scope || '');
                                const h = u.hostname.toLowerCase();
                                if (_addHost(h, reg.scope || '', 'sw')) extras.swHosts.push(h);
                            } catch (e) { Log.warn(e.message || e); }
                        }
                    }).catch((e) => { Log.warn('serviceWorker scan failed:', e); });
                }
            } catch (e) { Log.warn(e.message || e); }

            // ② 活跃 WebSocket 连接域名（无法直接枚举，扫描已 hook 的 WebSocket 实例）
            // NetworkInterceptor.hookWebSocket 已记录 ws 连接，此处从全局追踪集合读取
            try {
                if (window.__proBlocker_ws_targets && Array.isArray(window.__proBlocker_ws_targets)) {
                    for (const wsUrl of window.__proBlocker_ws_targets) {
                        try {
                            const u = new URL(wsUrl);
                            const h = u.hostname.toLowerCase();
                            if (_addHost(h, wsUrl, 'ws')) extras.wsHosts.push(h);
                        } catch (e) { Log.warn(e.message || e); }
                    }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ③ Base64 / Blob URL 溯源：Blob URL 本身不含域名，但创建前的源码常含真实地址
            try {
                const blobEls = document.querySelectorAll('[src^="blob:"], [href^="blob:"], [src^="data:"], [href^="data:"]');
                for (const el of blobEls) {
                    const val = el.getAttribute('src') || el.getAttribute('href') || '';
                    if (!val) continue;
                    // data: URL 内嵌的 base64 内容可能含 URL 字符串
                    if (val.startsWith('data:') && val.length < 5000) {
                        const matches = val.match(/https?:\/\/[^\s"'<>(){}',;]+/gi);
                        if (matches) {
                            for (const u of matches) {
                                try {
                                    const h = new URL(u).hostname.toLowerCase();
                                    if (_addHost(h, u, 'data-embed')) extras.blobUrls.push(u);
                                } catch (e) { Log.warn(e.message || e); }
                            }
                        }
                    }
                    // blob: URL 无法直接溯源，记录出现供后续追溯
                    if (val.startsWith('blob:')) extras.blobUrls.push(val);
                }
            } catch (e) { Log.warn(e.message || e); }

            // ④ CSS 伪元素 ::before/::after 中的 url() 注入
            try {
                const candidates = document.querySelectorAll('div,section,aside,a,ins');
                let checked = 0;
                for (const el of candidates) {
                    if (checked >= 500) break; // 采样上限
                    checked++;
                    if (ProtectedCheck.isProtected(el)) continue;
                    try {
                        const before = window.getComputedStyle(el, '::before').content;
                        const after = window.getComputedStyle(el, '::after').content;
                        [before, after].forEach(content => {
                            if (!content || content === 'none' || content === 'normal') return;
                            const m = content.match(/url\(["']?([^"')]+)["']?\)/);
                            if (m && m[1] && /^https?:\/\//i.test(m[1])) {
                                try {
                                    const h = new URL(m[1]).hostname.toLowerCase();
                                    if (_addHost(h, m[1], 'pseudo-css')) extras.pseudoUrls.push(m[1]);
                                } catch (e) { Log.warn(e.message || e); }
                            }
                        });
                    } catch (e) { Log.warn(e.message || e); }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ⑤ SVG <use href> / <image href> / <image xlink:href> 资源引用
            try {
                // xlink:href 含冒号需在 CSS 选择器中转义，避免 querySelectorAll 抛错
                const svgRefs = document.querySelectorAll('use[href], image[href], image[xlink\\:href]');
                for (const el of svgRefs) {
                    const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
                    if (!href || href.startsWith('#') || href.startsWith('data:')) continue;
                    try {
                        const abs = new URL(href, location.href);
                        const h = abs.hostname.toLowerCase();
                        if (_addHost(h, href, 'svg-ref')) extras.svgUrls.push(href);
                    } catch (e) { Log.warn(e.message || e); }
                }
            } catch (e) { Log.warn(e.message || e); }

            return extras;
        }

        /**
         * 递归收集同域 iframe 内的资源域名（优化方案 §6.1 面板3改进）
         * @param {Map} baseMap collect() 返回的主 map，就地合并
         * @param {number} maxDepth 最大递归深度，默认 3
         * @param {number} currentDepth 当前深度，默认 0
         */
        function collectIframeDomains(baseMap, maxDepth = 3, currentDepth = 0) {
            if (currentDepth >= maxDepth) return;
            const curHost = location.hostname.toLowerCase();
            try {
                const iframes = document.querySelectorAll('iframe');
                iframes.forEach(iframe => {
                    try {
                        const src = iframe.src || '';
                        if (!src) return;
                        const iframeHost = new URL(src).hostname.toLowerCase();
                        // 跳过跨域 iframe
                        if (iframeHost === curHost || isSameSite(iframeHost, mainDomain(curHost))) return;
                        const iframeDoc = iframe.contentDocument;
                        if (!iframeDoc) return;
                        // 递归收集 iframe 内的资源
                        iframeDoc.querySelectorAll('img[src], img[data-src], script[src], iframe[src], a[href], link[rel="stylesheet"], video[src], source[src]').forEach(el => {
                            const attrs = ['src', 'href', 'data-src'];
                            for (const attr of attrs) {
                                const val = el.getAttribute(attr);
                                if (!val || val.startsWith('data:') || val.startsWith('blob:')) continue;
                                try {
                                    const absUrl = new URL(val, iframeDoc.baseURI || src);
                                    const h = absUrl.hostname.toLowerCase();
                                    if (h !== curHost && !isSameSite(h, mainDomain(curHost))) {
                                        let info = baseMap.get(h);
                                        if (!info) {
                                            info = { hostname: h, urls: [], types: new Set(), bytes: 0, count: 0, t0: 0, t1: 0, hasRedirect: false };
                                            baseMap.set(h, info);
                                        }
                                        if (info.urls.length < MAX_URLS_PER_HOST) info.urls.push(val);
                                        info.types.add(TYPE_MAP[el.tagName.toLowerCase()] || 'other');
                                        info.count++;
                                    }
                                } catch (e) { Log.warn(e.message || e); }
                            }
                        });
                        // 递归处理嵌套同域 iframe
                        collectIframeDomains(baseMap, maxDepth, currentDepth + 1);
                    } catch (e) { Log.warn(e.message || e); }
                });
            } catch (e) { Log.warn(e.message || e); }
        }

        /**
         * 真·深度域名扫描主入口
         * @param {Object} opts.deep=true 开启深度探测；false 仅基线 scan()
         * @returns {Object} scan() 结果 + deepExtras 字段
         */
        function deepScan(opts = {}) {
            const t0 = performance.now();
            const map = collect();
            // 优化方案 §6.1 面板3：扫描同域 iframe 内的资源域名
            collectIframeDomains(map);
            let deepExtras = null;
            if (opts.deep) {
                deepExtras = _collectDeepDomains(map);
            }
            const results = [];
            for (const [, info] of map) {
                const f = extractFeatures(info);
                const { score, level, reasons, signals } = calculateScore(f);
                // 深度扫描新增的隐藏通道域名加分
                let extraScore = 0;
                const extraReasons = [];
                if (deepExtras) {
                    if (deepExtras.swHosts.includes(info.hostname)) { extraScore += 18; extraReasons.push('🛠ServiceWorker'); }
                    if (deepExtras.wsHosts.includes(info.hostname)) { extraScore += 15; extraReasons.push('🔌WebSocket'); }
                    if (info.types.has('pseudo-css')) { extraScore += 12; extraReasons.push('::伪元素注入'); }
                    if (info.types.has('svg-ref')) { extraScore += 8; extraReasons.push('SVG引用'); }
                    if (info.types.has('data-embed')) { extraScore += 10; extraReasons.push('📦data内嵌'); }
                }
                const finalScore = clampScore(score + extraScore, 0, 100);
                const allReasons = extraReasons.length > 0 ? reasons.concat(extraReasons) : reasons;
                results.push(Object.assign({}, f, {
                    score: finalScore, level: finalScore >= 55 && signals + (extraScore > 0 ? 1 : 0) >= 3 ? 'ad' : level,
                    reasons: allReasons, signals, info
                }));
            }
            results.sort((a, b) => b.score - a.score);
            const elapsed = (performance.now() - t0).toFixed(1);
            return { results, elapsed, total: results.length, deepExtras };
        }

        return { scan, deepScan, VICE_TOKENS };
    })();

    // ═══════════════════════════════════════════════════════════
    // ── 全局时序常量（消除魔法数字，TD-02 / TD-04 其余批次）──
    const TIMING = {
        RELOAD_DELAY_MS: 1500,      // 规则变更/导入后页面重载延迟
        REPORT_DELAY_MS: 100,       // 子帧分类上报延迟
        TOAST_DISMISS_MS: 300,      // Toast 自动消失延迟
        OBSERVER_TIMEOUT_MS: 30000, // 帧观察器自动断开超时（防 GC 泄漏）
        DEEP_SCAN_DELAY_MS: 50,     // 深扫防抖
        MICRO_DELAY_MS: 10          // 微任务延迟
    };

    // OverlayDetector：统一覆盖层检测引擎
    // 职责：不可见覆盖层扫描 + 肤色检测 + 追踪像素检测
    // 合并自：OverlayScanEngine + BlockEngine.scanInvisibleOverlays
    // 依赖：ElementHider, UIManager, BlockEngine (域名匹配)
    // ═══════════════════════════════════════════════════════════
    const OverlayDetector = {
        // 委托到 BlockEngine.scanInvisibleOverlays
        scanInvisibleOverlays(options) {
            return BlockEngine.scanInvisibleOverlays(options);
        },

        scanInvisibleOverlaysAsync(options) {
            return BlockEngine.scanInvisibleOverlaysAsync(options);
        },

        // 委托到 OverlayScanEngine（后续逐步迁移实现）
        scan(root, options) {
            return OverlayScanEngine.scan(root, options);
        },

        deepScan() {
            return OverlayScanEngine.deepScan();
        }
    };

    /**
     * ═══════════════════════════════════════════════════════════════
     *  算法二：OverlayScanEngine — 不可见/覆盖层广告专攻
     *
     *  专攻目标：不可见元素 · 覆盖层 · 博彩/色情图片 · 点击跳转拦截
     * ═══════════════════════════════════════════════════════════════
     */
    const OverlayScanEngine = (() => {

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

        function scan(root, options) {
            const t0 = performance.now();
            const results = [];
            const seen = new Set();
            // 尊重调用方传入的 root：按子树作用域扫描，而非始终扫描顶层 document。
            // root 未传时退化为 document（行为不变）。
            const scope = (root && typeof root.querySelectorAll === 'function') ? root : document;

            // 阶段1：快速选择器扫描
            try {
                const candidates = scope.querySelectorAll(QUICK_SEL);
                for (const el of candidates) {
                    if (seen.has(el)) continue;
                    // 统一保护判定：脚本自身 UI 宿主（含 Shadow DOM 内部节点）跳过
                    if (ProtectedCheck.isProtected(el)) continue;
                    seen.add(el);
                    const f = _analyzeElement(el);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { Log.warn(e.message || e); }

            // 阶段2：定位元素扫描（覆盖层核心）
            try {
                const positioned = scope.querySelectorAll('div,section,aside,article');
                for (const el of positioned) {
                    if (seen.has(el)) continue;
                    if (ProtectedCheck.isProtected(el)) continue;
                    const cs = _cs(el);
                    if (!cs) continue;
                    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
                    seen.add(el);
                    const f = _analyzeOverlay(el, cs);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { Log.warn(e.message || e); }

            // 阶段3：可点击图片专项（博彩/色情核心）
            try {
                const clickableImgs = scope.querySelectorAll('a img, a > img, [onclick] img, img[onclick]');
                for (const img of clickableImgs) {
                    if (seen.has(img)) continue;
                    if (ProtectedCheck.isProtected(img)) continue;
                    seen.add(img);
                    const f = _analyzeClickableImage(img);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { Log.warn(e.message || e); }

            // 阶段4：内联事件广告（移动端最常见的劫持手法）
            // 扫描所有 [onclick]、[ontouchstart]、[onmousedown] 的元素
            try {
                const inlineEventAds = scope.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                for (const el of inlineEventAds) {
                    if (seen.has(el)) continue;
                    if (ProtectedCheck.isProtected(el)) continue;
                    seen.add(el);
                    const f = _analyzeInlineEventAd(el);
                    if (f.suspicion > 0) results.push(f);
                }
            } catch (e) { Log.warn(e.message || e); }

            results.sort((a, b) => b.suspicion - a.suspicion);
            const elapsed = (performance.now() - t0).toFixed(1);
            return { results, elapsed, total: results.length };
        }

        function _analyzeElement(el) {
            // 防御性保护：即使从外部直接调用也不会扫描脚本自身 UI
            if (ProtectedCheck.isProtected(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'unknown' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'unknown' };
            const cs = _cs(el);
            if (!cs) return f;
            const tag = el.tagName.toLowerCase();
            const cls = (el.className || '').toLowerCase();
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
            const z = parseInt(cs.zIndex, 10) || 0;
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
                        } catch (e) { Log.warn(e.message || e); }
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
                } catch (e) { Log.warn(e.message || e); }
            }
            f.selector = _buildSelector(el);
            f.features.tag = tag;
            return f;
        }

        function _analyzeOverlay(el, cs) {
            if (ProtectedCheck.isProtected(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };
            const rect = _rect(el);
            const cls = (el.className || '').toLowerCase();
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
            if (ProtectedCheck.isProtected(img)) return { el: img, suspicion: 0, reasons: [], features: {}, category: 'vice-image' };
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
                    } catch (e) { Log.warn(e.message || e); }
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
                const z = parseInt(cs.zIndex, 10) || 0;
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
            if (ProtectedCheck.isProtected(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'invisible' };
            const f = { el, suspicion: 0, reasons: [], features: {}, category: 'invisible' };
            const tag = el.tagName.toLowerCase();
            const rect = _rect(el);
            const cls = (el.className || '').toLowerCase();
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
                        } catch (e) { Log.warn(e.message || e); }
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
                } catch (e) { Log.warn(e.message || e); }
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
        let _navInterceptorActive = false;

        function enableNavigationInterceptor(blockedDomains) {
            if (_navInterceptorActive) return;
            _navInterceptorActive = true;
            // 注意：_navBlocked 累加器曾用于记录被拦截导航，但全文件无任何读取/清空逻辑，
            // 长会话下无限增长（内存泄漏），且数据从未被消费，已于 v8.5 移除。拦截副作用（Log.warn + 阻止跳转）不受影响。
            // BUG-A2 修复：blockedDomains 是启动期快照，用户后续新封杀的域名不会进入闭包。
            // 改为实时读取 BlockEngine.getDomainSet()——该集合由 invalidateCache() 在
            // addRule/removeRule/saveData 时自动失效重建，确保新封域名即时生效。
            // 启动期快照作为 BlockEngine 尚未就绪时的兜底（document-start 阶段可能时序靠前）。
            // 注意：不能用 size>0 判断，否则用户删除全部域名后会回退到过期快照（A2残留缺陷）
            const _checkNav = (url) => {
                if (!url) return false;
                let liveDomains = blockedDomains;
                try {
                    // getDomainSet() 返回缓存 Set，命中 invalidateCache 自动重建，O(1) 查询
                    // 空集合也必须采用，否则删光域名后仍按启动快照拦截（v0.7.2 修复）
                    const liveSet = BlockEngine.getDomainSet();
                    if (liveSet) liveDomains = liveSet;
                } catch (e) { /* BlockEngine 未就绪时回退快照 */ }
                return _isBlockedNav(url, liveDomains);
            };

            // ① 拦截 window.open
            const _origOpen = window.open;
            window.open = function (url) {
                const args = Array.prototype.slice.call(arguments);
                if (_checkNav(url)) {
                    Log.warn('拦截 window.open:', url);
                    return null;
                }
                return _origOpen.apply(this, args);
            };

            // ② 拦截 <a> 点击 + onclick 内联跳转（捕获阶段）
            document.addEventListener('click', function (e) {
                // 统一保护：脚本自身 UI 宿主内的点击不处理，避免误删面板
                if (ProtectedCheck.isProtected(e.target)) return;
                // 先检查 <a href> 跳转
                const link = e.target.closest && e.target.closest('a');
                if (link) {
                    const href = link.href || '';
                    if (href && _checkNav(href)) {
                        e.preventDefault();
                        e.stopPropagation();
                        Log.warn('[OverlayScanEngine] 拦截链接:', href);
                        const container = link.closest('[class*="ad"],[class*="popup"],[class*="banner"],[class*="overlay"]') || link;
                        // 删除前再次校验保护，避免误删脚本自身 UI 的祖先
                        if (!ProtectedCheck.isProtected(container)) container.remove();
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
                                    Log.warn('拦截onclick跳转:', url[1]);
                                    const container = target.closest('[class*="ad"],[class*="popup"],[class*="banner"],[class*="overlay"]') || target;
                                    // 删除前再次校验保护，避免误删脚本自身 UI 的祖先
                                    if (!ProtectedCheck.isProtected(container)) container.remove();
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
                                Log.warn('拦截location:', val);
                                return;
                            }
                            desc.set.call(this, val);
                        },
                        get() { return desc.get.call(this); },
                        configurable: true
                    });
                }
            } catch (e) { Log.warn(e.message || e); }

            // ④ 拦截 form 提交
            document.addEventListener('submit', function (e) {
                const action = e.target.action || '';
                if (action && _checkNav(action)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        }

        function _isBlockedNav(url, blockedDomains) {
            if (!url) return false;
            try {
                const u = new URL(url, location.href);
                const h = u.hostname.toLowerCase();
                if (blockedDomains) {
                    // Set 用 has() O(1)，数组用 for...of O(n)；两种形态均支持(BUG-A2 实时读取)
                    if (blockedDomains.has) {
                        if (blockedDomains.has(h)) return true;
                        // 同源子域名匹配：逐级向上剥離子域检查
                        let dot = h.indexOf('.');
                        while (dot !== -1) {
                            const parent = h.slice(dot + 1);
                            if (blockedDomains.has(parent)) return true;
                            dot = h.indexOf('.', dot + 1);
                        }
                    } else {
                        for (const d of blockedDomains) {
                            if (h === d || h.endsWith('.' + d)) return true;
                        }
                    }
                }
                const tokens = h.split(/[^a-z0-9-]/);
                // B13 修复：短词(≤3字符)如 go/link/click 单独判定会误杀 go.microsoft.com、link.springer.com 等合法跳转
                // 长词(≥4字符)如 casino/poker/baccarat 可单独判定
                // 短词需叠加 GAMBLING_TLDS 高风险 TLD 上下文才判拦截
                const tld = h.split('.').pop() || '';
                for (const t of tokens) {
                    if (VICE_LONG_TOKENS.has(t)) return true;
                    if (VICE_SHORT_TOKENS_NAV.has(t) && GAMBLING_TLDS.has(tld)) return true;
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

        // ════════════════════════════════════════
        //  真·深度扫描（v0.7.0 新增）：高开销、深层级、针对性探测
        //  - Canvas 肤色采样：识别博彩/色情图片（vice-image）
        //  - CSS 伪元素穿透：提取 ::before/::after 中隐藏的 URL/文本
        //  - 混淆跳转沙箱解码：还原 eval(atob)/fromCharCode 等混淆跳转
        //  - Icon Font 映射检测：识别博彩网站自定义字体图标
        //  全部方法采用 try/catch 包裹，跨域污染/不可读时静默降级，避免控制台报错
        // ════════════════════════════════════════

        /**
         * 轻量级肤色检测：针对同域/CORS 允许的 img/canvas
         * 缩放至 50×50 后采样像素 RGB，肤色像素占比 > 30% 视为色情高危
         * 跨域 tainted canvas 会抛 SecurityError，catch 后返回 0 静默跳过
         */
        function detectSkinTone(imgEl) {
            try {
                if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0) return 0;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) return 0;
                const w = 50, h = 50;
                canvas.width = w; canvas.height = h;
                ctx.drawImage(imgEl, 0, 0, w, h);
                const data = ctx.getImageData(0, 0, w, h).data;
                let skinPixels = 0, totalPixels = 0;
                // 每隔 4 个像素采样一次（步长 16=4 通道×4 像素），提升速度
                for (let i = 0; i < data.length; i += 16) {
                    const r = data[i], g = data[i + 1], b = data[i + 2];
                    // 简化版 RGB 肤色规则（Peer et al.）
                    if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
                        (Math.max(r, g, b) - Math.min(r, g, b)) > 15 &&
                        Math.abs(r - g) > 15) {
                        skinPixels++;
                    }
                    totalPixels++;
                }
                return totalPixels > 0 ? skinPixels / totalPixels : 0;
            } catch (e) {
                return 0; // 跨域污染或其他错误，静默跳过
            }
        }

        /**
         * 提取 CSS 伪元素中的隐藏 URL 或文本
         * 高级广告常用 ::before/::after 注入全屏遮罩或博彩文字（DOM textContent 抓不到）
         */
        function extractPseudoContent(el) {
            const results = [];
            try {
                if (!el) return results;
                const before = window.getComputedStyle(el, '::before').content;
                const after = window.getComputedStyle(el, '::after').content;
                [before, after].forEach(content => {
                    if (!content || content === 'none' || content === 'normal') return;
                    // 提取 url("...")
                    const urlMatch = content.match(/url\(["']?([^"')]+)["']?\)/);
                    if (urlMatch) results.push({ type: 'url', value: urlMatch[1] });
                    // 提取纯文本（去除引号），长度 2~100 视为有意义的注入文本
                    const text = content.replace(/^["']|["']$/g, '');
                    if (text.length > 2 && text.length < 100) {
                        results.push({ type: 'text', value: text });
                    }
                });
            } catch (e) { Log.warn(e.message || e); }
            return results;
        }

        /**
         * 解码混淆的 onclick/href 跳转 URL
         * 针对 eval(atob())、String.fromCharCode、\x、\u 等逃逸手法
         * 沙箱屏蔽 window.location 防止意外跳转，仅返回解码后的字符串 URL
         */
        function decodeObfuscatedUrl(code) {
            if (!code || typeof code !== 'string') return null;
            // 仅对包含混淆特征的代码进行沙箱测试，避免无谓开销
            if (!/atob|fromCharCode|unescape|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(code)) return null;
            try {
                // 构建沙箱：屏蔽 location 防止意外跳转，仅暴露解码相关函数
                // 注意：new Function 内部 this=global，需显式声明屏蔽外层 window
                const fn = new Function('atob', 'String', 'unescape', `
                    "use strict";
                    var location = { href: '' };
                    var window = { location: { href: '' }, open: function(){}, atob: atob, String: String, unescape: unescape };
                    var document = {};
                    try { return (${code}); } catch (e) { return null; }
                `);
                const decoded = fn(window.atob, window.String, window.unescape);
                if (typeof decoded === 'string' && /https?:\/\//i.test(decoded)) {
                    return decoded;
                }
            } catch (e) { /* 解码失败静默忽略 */ }
            return null;
        }

        /**
         * Icon Font 映射检测：博彩网站常使用自定义 @font-face 将普通 Unicode 映射为博彩图标
         * 检查元素的 font-family 是否为自定义字体（非系统字体），结合内容打分
         */
        const SYSTEM_FONT_FAMILIES = new Set([
            'arial', 'helvetica', 'times new roman', 'georgia', 'courier new',
            'verdana', 'tahoma', 'trebuchet ms', 'impact', 'comic sans ms',
            'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
            'segoe ui', 'microsoft yahei', 'pingfang sc', 'hiragino sans gb',
            'songti sc', 'simhei', 'simsun', 'fangsong', 'stheiti'
        ]);
        function isCustomFont(el) {
            try {
                if (!el) return false;
                const cs = window.getComputedStyle(el);
                const ff = (cs.fontFamily || '').toLowerCase();
                if (!ff) return false;
                // 拆分多个字体名，逐个检查是否有非系统字体
                const fonts = ff.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
                for (const f of fonts) {
                    if (!SYSTEM_FONT_FAMILIES.has(f)) return true; // 存在非系统字体=自定义字体
                }
                return false;
            } catch (e) { return false; }
        }

        /**
         * 真·深度扫描主入口：在基础 scan() 之上叠加高开销探测
         * @param {Object} opts.deep=true 开启深度探测；false 仅基线扫描
         * @returns {Object} { results, elapsed, total, deepExtras }
         *   deepExtras: 深度扫描新增的额外发现（肤色调色情图、伪元素注入、混淆跳转域名等）
         */
        function deepScan(opts = {}) {
            const t0 = performance.now();
            const base = scan();
            if (!opts.deep) return Object.assign(base, { deepExtras: null });

            const deepExtras = {
                viceImages: [],     // { el, ratio, src } 肤色占比超阈值的图片
                pseudoInjects: [],  // { el, items } 伪元素注入的 URL/文本
                obfuscatedUrls: [], // { el, url } 混淆解码出的跳转 URL
                customFontEls: []   // { el, sample } 使用自定义字体的元素
            };

            // ① 肤色采样：仅扫描可点击图片（a img / [onclick] img），避免对全站图片扫描
            try {
                const clickableImgs = document.querySelectorAll('a img, a > img, [onclick] img, img[onclick]');
                for (const img of clickableImgs) {
                    if (ProtectedCheck.isProtected(img)) continue;
                    const ratio = detectSkinTone(img);
                    if (ratio > 0.3) {
                        deepExtras.viceImages.push({
                            el: img,
                            ratio: Math.round(ratio * 100) / 100,
                            src: (img.src || '').substring(0, 120)
                        });
                    }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ② 伪元素穿透：扫描高 z-index 定位元素（覆盖层广告常注入伪元素）
            try {
                const positioned = document.querySelectorAll('div,section,aside,a');
                let checked = 0;
                for (const el of positioned) {
                    if (checked >= 800) break; // 采样上限，避免大型页面卡顿
                    checked++;
                    if (ProtectedCheck.isProtected(el)) continue;
                    const items = extractPseudoContent(el);
                    if (items.length > 0) {
                        deepExtras.pseudoInjects.push({ el, items });
                    }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ③ 混淆跳转沙箱解码：扫描含混淆特征的内联事件
            try {
                const inlineEls = document.querySelectorAll('[onclick], [ontouchstart], [onmousedown], [data-href], [data-url], [data-link]');
                for (const el of inlineEls) {
                    if (ProtectedCheck.isProtected(el)) continue;
                    const attrs = ['onclick', 'ontouchstart', 'onmousedown', 'data-href', 'data-url', 'data-link'];
                    for (const attr of attrs) {
                        const val = el.getAttribute(attr);
                        if (!val) continue;
                        const decoded = decodeObfuscatedUrl(val);
                        if (decoded) {
                            deepExtras.obfuscatedUrls.push({ el, url: decoded });
                        }
                    }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ④ Icon Font 映射检测：扫描博彩/色情容器内的元素
            try {
                const viceContainers = document.querySelectorAll(
                    '[class*="casino"], [class*="bet"], [class*="slot"], [class*="poker"], [class*="lottery"], ins'
                );
                for (const c of viceContainers) {
                    if (ProtectedCheck.isProtected(c)) continue;
                    if (isCustomFont(c)) {
                        const sample = (c.textContent || '').trim().substring(0, 50);
                        deepExtras.customFontEls.push({ el: c, sample });
                    }
                }
            } catch (e) { Log.warn(e.message || e); }

            // ⑤ 融合深度发现到 results：肤色调色情图直接升级 category，混淆 URL 注入 triggerUrl
            const elToResult = new Map();
            for (const r of base.results) if (r.el) elToResult.set(r.el, r);
            // 肤色图片：升级为 vice-image 并加分
            for (const v of deepExtras.viceImages) {
                let r = elToResult.get(v.el);
                if (!r) {
                    // OAS 基线未收录的图片，新增记录
                    r = {
                        el: v.el, suspicion: 40, reasons: ['🎨肤色采样' + Math.round(v.ratio * 100) + '%'],
                        features: { skinRatio: v.ratio, src: v.src }, category: 'vice-image',
                        selector: _buildSelector(v.el.parentElement || v.el)
                    };
                    r.features.tag = 'img';
                    base.results.push(r);
                    elToResult.set(v.el, r);
                } else {
                    r.suspicion = (r.suspicion || 0) + 35;
                    r.reasons = r.reasons || [];
                    r.reasons.push('🎨肤色采样' + Math.round(v.ratio * 100) + '%');
                    r.features = r.features || {};
                    r.features.skinRatio = v.ratio;
                    r.category = 'vice-image';
                }
            }
            // 混淆 URL：注入 triggerUrl 并加分
            for (const o of deepExtras.obfuscatedUrls) {
                let r = elToResult.get(o.el);
                if (!r) {
                    r = {
                        el: o.el, suspicion: 45, reasons: ['🔐混淆跳转解码'],
                        features: { clickable: true, externalLink: o.url }, category: 'overlay',
                        selector: _buildSelector(o.el), triggerUrl: o.url
                    };
                    r.features.tag = o.el.tagName.toLowerCase();
                    base.results.push(r);
                    elToResult.set(o.el, r);
                } else {
                    r.suspicion = (r.suspicion || 0) + 30;
                    r.reasons = r.reasons || [];
                    r.reasons.push('🔐混淆跳转解码');
                    r.features = r.features || {};
                    r.features.obfuscatedRedirect = o.url;
                    if (!r.triggerUrl) r.triggerUrl = o.url;
                }
            }
            // 伪元素注入：加分（不新增记录，仅标记已有覆盖层）
            for (const p of deepExtras.pseudoInjects) {
                const r = elToResult.get(p.el);
                if (r) {
                    r.suspicion = (r.suspicion || 0) + 15;
                    r.reasons = r.reasons || [];
                    r.reasons.push('::伪元素注入');
                    r.features = r.features || {};
                    r.features.pseudoInject = p.items;
                }
            }
            // Icon Font：加分
            for (const cf of deepExtras.customFontEls) {
                let r = elToResult.get(cf.el);
                if (!r) {
                    r = {
                        el: cf.el, suspicion: 20, reasons: ['🔤自定义字体图标'],
                        features: { customFont: true }, category: 'vice-image',
                        selector: _buildSelector(cf.el)
                    };
                    r.features.tag = cf.el.tagName.toLowerCase();
                    base.results.push(r);
                    elToResult.set(cf.el, r);
                } else {
                    r.suspicion = (r.suspicion || 0) + 18;
                    r.reasons = r.reasons || [];
                    r.reasons.push('🔤自定义字体图标');
                    r.features = r.features || {};
                    r.features.customFont = true;
                }
            }

            // 重新排序
            base.results.sort((a, b) => (b.suspicion || 0) - (a.suspicion || 0));
            base.total = base.results.length;
            const elapsed = (performance.now() - t0).toFixed(1);
            return Object.assign(base, { elapsed, deepExtras });
        }

        return { scan, deepScan, enableNavigationInterceptor, detectSkinTone, extractPseudoContent, decodeObfuscatedUrl };
    })();


    // ═══════════════════════════════════════════════════════════════
    // 服务层端口（L2）：UI 只依赖端口，不直连引擎/存储具体实现
    // （《整洁架构》Ch.5 DIP；《PoEAA》Repository 单一写入方）
    // ═══════════════════════════════════════════════════════════════

    // OverlayService：覆盖层扫描用例编排端口。消除 UIManager→OverlayScanEngine 跨层直调（R3-1 违规①）
    const OverlayService = {
        scan(root, options) { return OverlayDetector.scan(root, options); },
        deepScan(options) { return OverlayDetector.deepScan(options); },
        enableNavigationInterceptor(domains) { return OverlayScanEngine.enableNavigationInterceptor(domains); },
        scanInvisibleOverlays(options) { return BlockEngine.scanInvisibleOverlays(options); }
    };

    // StorageService：持久化唯一写入端口。UI 层经此读写，不直接触碰 storage 实例；
    // 缓存失效（iframe 规则）内聚到 invalidateIframeRules，消除散落直写（TD-01/R3 残留）
    const StorageService = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'invalidateIframeRules') {
                return () => {
                    if (typeof IframeGuard !== 'undefined' && typeof IframeGuard.invalidateBlockRules === 'function') {
                        IframeGuard.invalidateBlockRules();
                    }
                };
            }
            const target = storage || {};
            const v = target[prop];
            return (typeof v === 'function') ? v.bind(target) : v;
        }
    });

    // PanelRegistry：面板 key→UIManager 方法的注册表（OCP 接缝）。
    // 新增第 10 个面板 = 注册一行 + MENU_ITEMS 加一项，_buildMenu 分派逻辑零改动（《敏捷软件开发》OCP）
    const PanelRegistry = {
        selection: 'startSelection',
        regex: 'showRegexPanel',
        domain: 'showGlobalDomainPanel',
        overlay: 'showOverlayScanPanel',
        manager: 'showManager',
        iframe: 'showIframePanel',
        export: 'showExportPanel',
        adguard: 'showAdGuardExportPanel',
        import: 'showImportPanel'
    };

    /**
     * 用户交互界面：基于 Shadow DOM 隔离
     */
    // ── Phase B 面板模块（物理抽离自 UIManager · 独立可测） ──
    // 每个面板为独立函数模块，经 XPanel.call(this) 注入 UIManager 协调器为 this；行为等价（SRP/OCP）。
    function SelectionPanel() {
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
        this._trackDoc('keydown', this._keydownHandler);
        // 拦截事件必须尽可能早地阻止广告跳转：
        // ① pointerdown：在 mousedown/touchstart 之前触发，是最早可拦截的人机交互事件
        // ② document 级 capture：确保在所有目标阶段处理之前拦截（无论 body 是否被广告脚本清空）
        // ③ 同时拦截 mouseover/click/touch*/auxclick：覆盖鼠标 + 触屏 + pointer + 中键四种交互模型
        const registerOnDoc = () => {
            this._trackDoc('pointerdown', this._handlePointerDown, { capture: true, passive: false });
            this._trackDoc('mousedown', this._handleMouseDown, { capture: true, passive: false });
            this._trackDoc('mouseover', this._handleMouseOver, { capture: true });
            this._trackDoc('click', this._handleClick, { capture: true, passive: false });
            this._trackDoc('contextmenu', this._contextmenuHandler, { capture: true });
            this._trackDoc('touchstart', this._handleTouchStart, { capture: true, passive: false });
            this._trackDoc('touchmove', this._handleTouchMove, { capture: true, passive: false });
            this._trackDoc('touchend', this._handleTouchEnd, { capture: true, passive: false });
            // 拦截 auxclick（中键点击打开新标签、右键点击）：防止绕过 click 拦截触发跳转
            this._trackDoc('auxclick', this._handleAuxClick, { capture: true });
        };
        registerOnDoc();
    }

    function GlobalDomainPanel() {
        this.clearPanel();
        const panel = document.createElement('div');
        panel.className = 'panel';

        // 双引擎采集：BlockEngine.extractResourceDomains（DOM 资源来源）+ GlobalDomainScanner（6通道+12维+博彩色情）
        // 合并策略：按 hostname 合并，分数取较高者，附加 viceToken/adToken/level 标记
        // 过滤策略：已在域名黑名单中的域名不再展示（Bug3）
        const blockedDomainSet = new Set(this.storage.getDomainBlocks().map(r => r.domain));
        const { scoredDomains = [] } = BlockEngine.extractResourceDomains(document.documentElement, { deep: true });
        let gdsResult = { results: [], elapsed: '0', total: 0 };
        try { gdsResult = GlobalDomainScanner.scan(); } catch (e) { Log.warn(e.message || e); }
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
        // 冗余-3：用 Set O(1) 查找替代 allDomains.find O(n) 线性查找
        const existingHosts = new Set(allDomains.map(d => d.host));
        for (const [host, g] of gdsMap) {
            if (blockedDomainSet.has(host)) continue;
            if (!existingHosts.has(host)) {
                allDomains.push({
                    host, score: g.score, count: g.freq || 1,
                    sources: ['performance-api'], reasons: g.reasons || [],
                    viceToken: g.viceToken || null, adToken: g.adToken || null,
                    level: g.level || null, gdsReasons: g.reasons || [], signals: g.signals || 0
                });
                existingHosts.add(host);
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
                box.innerHTML = '<div class="empty-tip">未匹配到域名，请尝试取消“只看广告相关”或手动添加。</div>';
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
            // 域名格式校验：拒绝带协议、路径、空格等非法输入(BUG-M5)
            if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
                this.showToast(`域名格式无效："${host}"，请输入纯域名（如 ad.example.com，不含 http://）。`, 'warning');
                return;
            }
            // 拒绝添加已封杀域名：避免UI误导用户以为该域名未封杀（Bug1）
            const currentBlocked = new Set(this.storage.getDomainBlocks().map(r => r.domain));
            if (currentBlocked.has(host)) {
                this.showToast(`域名 ${host} 已在黑名单中，无需重复添加。`, 'info');
                input.value = '';
                return;
            }
            // 冗余-3：用 some 替代 find（仅需判断存在性，无需返回元素），语义更清晰
            if (!allDomains.some(d => d.host === host)) {
                allDomains.push({ host, score: 99, sources: ['manual'], reasons: ['用户手动添加'], count: 1, viceToken: null, adToken: null, level: null, gdsReasons: [], signals: 0 });
            }
            selectedHosts.add(host);
            input.value = '';
            updateGlobalPreview();
            renderDomains();
        });

        // 深度扫描：真·深度域名挖掘（v0.7.0 重构）
        // 双引擎：BlockEngine.extractResourceDomains（DOM 资源）+ GlobalDomainScanner.deepScan（GDS 6通道+12维+真·深度）
        // 真·深度：CSS 伪元素穿透 / Service Worker / WebSocket / Blob URL 溯源 / SVG 引用
        // 时间分片：requestIdleCallback 包裹高开销探测，避免主线程卡顿(BUG-4)
        panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
            const btn = e.currentTarget; // BUG-3：用 currentTarget 取按钮本身
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '⏳ 深度挖掘中...';
            // 高开销探测包裹 requestIdleCallback，避免主线程卡死（方案六.2 性能保护）
            const runDeep = () => {
                try {
                    const currentBlocked = new Set(this.storage.getDomainBlocks().map(r => r.domain));
                    allDomains = allDomains.filter(d => !currentBlocked.has(d.host));
                    // BUG-4 修复：补齐双引擎——extractResourceDomains DOM 资源 + GDS.deepScan 真·深度
                    const { scoredDomains = [] } = BlockEngine.extractResourceDomains(document.documentElement, { deep: true });
                    const deepResult = GlobalDomainScanner.deepScan({ deep: true });
                    // 冗余-3 修复：用 Map O(1) 查找合并，替代 allDomains.find O(n) 线性查找
                    const existingMap = new Map();
                    for (const d of allDomains) existingMap.set(d.host, d);
                    // 合并 extractResourceDomains 结果
                    for (const sd of scoredDomains) {
                        if (currentBlocked.has(sd.host)) continue;
                        const exist = existingMap.get(sd.host);
                        if (exist) {
                            exist.score = Math.max(exist.score, sd.score);
                            if (!exist.sources.includes('dom-resource')) exist.sources.push('dom-resource');
                        } else {
                            const newD = { host: sd.host, score: sd.score, count: sd.count || 1, sources: sd.sources || ['dom-resource'], reasons: sd.reasons || [], viceToken: null, adToken: null, level: null, gdsReasons: [], signals: 0 };
                            existingMap.set(sd.host, newD);
                            allDomains.push(newD);
                        }
                    }
                    // 合并 GDS.deepScan 结果（含真·深度新增的隐藏域名）
                    for (const g of deepResult.results) {
                        if (currentBlocked.has(g.hostname)) continue;
                        const exist = existingMap.get(g.hostname);
                        if (exist) {
                            exist.score = Math.max(exist.score, g.score);
                            exist.viceToken = g.viceToken || exist.viceToken;
                            exist.adToken = g.adToken || exist.adToken;
                            exist.level = g.level || exist.level;
                            exist.gdsReasons = g.reasons || exist.gdsReasons;
                            exist.signals = Math.max(exist.signals, g.signals || 0);
                        } else {
                            const newD = { host: g.hostname, score: g.score, count: g.freq || 1, sources: ['performance-api'], reasons: g.reasons || [], viceToken: g.viceToken, adToken: g.adToken, level: g.level, gdsReasons: g.reasons, signals: g.signals };
                            existingMap.set(g.hostname, newD);
                            allDomains.push(newD);
                        }
                    }
                    allDomains.sort((a, b) => b.score - a.score);
                    // 同步 selectedHosts：移除已被过滤掉的域名(BUG-M2)
                    const hostSet = new Set(allDomains.map(d => d.host));
                    Array.from(selectedHosts).forEach(h => { if (!hostSet.has(h)) selectedHosts.delete(h); });
                    // ⑩ 深度扫描后自动勾选新出现的高分域名，与初始加载逻辑一致
                    // 初始加载 selectedHosts 纳入 score>=35 || viceToken，深度扫描同口径补齐新增域名
                    allDomains.forEach(d => {
                        if ((d.score >= 35 || d.viceToken) && !selectedHosts.has(d.host)) {
                            selectedHosts.add(d.host);
                        }
                    });
                    renderDomains();
                    btn.disabled = false;
                    btn.textContent = origText;
                    const deepNote = deepResult.deepExtras ? `（深度新增：SW ${deepResult.deepExtras.swHosts.length} · WS ${deepResult.deepExtras.wsHosts.length} · 伪元素 ${deepResult.deepExtras.pseudoUrls.length} · SVG ${deepResult.deepExtras.svgUrls.length}）` : '';
                    this.showToast(`深度扫描完成，域名列表已刷新。${deepNote}`, 'success', 5000);
                } catch (err) {
                    btn.disabled = false;
                    btn.textContent = origText;
                    this.showToast('深度扫描失败：' + err.message, 'error');
                }
            };
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => runDeep(), { timeout: 500 });
            } else {
                setTimeout(runDeep, TIMING.DEEP_SCAN_DELAY_MS);
            }
        });

        // 预览状态使用实例属性 this._globalPreview，clearPanel 可跨面板清理，避免预览元素残留
        // 实时联动模式：预览激活时选择变化自动更新预览（Bug2&5），预览口径与 applyCSSRules 完全一致
        // 注意：previewBtn 必须先于 resetGlobalPreview 声明，避免 TDZ 风险(BUG-M1)
        const previewBtn = panel.querySelector('#btn-preview-global');
        const resetGlobalPreview = () => {
            if (!this._globalPreview.active) return;
            this._globalPreview.elements.forEach(el => BlockEngine.showElement(el));
            this._globalPreview = { active: false, elements: [] };
            this._hidePreviewBanner();
            previewBtn.textContent = '🔍 预览效果';
        };
        // 实时更新预览：根据当前 selectedHosts 重新隐藏元素（Bug2&5）
        const updateGlobalPreview = () => {
            if (!this._globalPreview.active) return;
            // 先还原所有预览元素
            this._globalPreview.elements.forEach(el => BlockEngine.showElement(el));
            this._globalPreview.elements = [];
            // 预览口径与 applyCSSRules 完全一致：
            // 1) CSS [src*=domain] 隐藏资源元素本身
            // 2) CSS *:has(> :is(...)) 隐藏直接父级
            // 3) scanAndBlockDynamic 隐藏 findSingleChildWrapper 单子链容器
            this._previewHideDomainResources(selectedHosts, this._globalPreview.elements);
        };
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
                if (!panel.isConnected) return; // 防御：confirm 期间面板可能已被 clearPanel 移除(BUG-S4)
                resetGlobalPreview();
                // 封杀选中域名：添加 domainBlock 规则 + 即时隐藏匹配资源（wrapper 口径）
                DomainBlockExecutor.execute(list, { hideMode: 'wrapper' });
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

    function RegexPanel() {
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
                    <option value="iframeBlock">iframe 子文档拦截 (封杀指定域名的 iframe 帧)</option>
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

                <div id="iframe-block-ui" style="display: none;">
                    <label for="iframe-domain-input">iframe 子文档域名</label>
                    <input type="text" id="iframe-domain-input" placeholder="例如：ads.example.com 或 doubleclick.net" />
                    <p style="color:#bbb; font-size:11px;">提示：输入广告 iframe 的 src 域名，系统将生成 iframeBlock 规则，拦截所有 src 包含该域名的 iframe 帧（即 $subdocument 拦截）。可封杀整个广告 iframe，而不影响同域名下的正常页面内容。</p>
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

        const iframeBlockUI = panel.querySelector('#iframe-block-ui');

        modeSelect.addEventListener('change', (e) => {
            const v = e.target.value;
            standardUI.style.display = (v === 'contains' || v === 'regex') ? 'block' : 'none';
            builderUI.style.display = (v === 'builder') ? 'block' : 'none';
            pathUI.style.display = (v === 'path') ? 'block' : 'none';
            attrUI.style.display = (v === 'attribute') ? 'block' : 'none';
            iframeBlockUI.style.display = (v === 'iframeBlock') ? 'block' : 'none';
            levelRow.style.display = (v === 'path' || v === 'attribute' || v === 'iframeBlock') ? 'none' : 'block';
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
                // 统一使用 BlockEngine.showElement：还原 hideElement 设置的全部 4 个属性(BUG-2)
                // 否则 path 预览(用 hideElement)隐藏的 visibility/pointer-events 会永久残留
                this._previewAffectedElements.forEach(item => BlockEngine.showElement(item.el));
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
            const btn = e.currentTarget; // 用 currentTarget 而非 e.target(BUG-L2)
            if (isPreviewing) { resetPreview(); return; }

            const mode = modeSelect.value;
            // NaN 兜底：输入框被清空时 parseInt 返回 NaN，_hideRegexAncestor 的 for(i=0;i<NaN;i++) 不执行 → 静默退化为 level 0
            const level = parseInt(panel.querySelector('#regex-level').value, 10) || 0;
            this._previewAffectedElements = [];

            if (mode === 'path') {
                // 路径模式预览：与正式 pathPattern 拦截同口径
                // 必须隐藏：元素本身 + 直接父级 + findSingleChildWrapper（Bug4 预览口径一致）
                const text = panel.querySelector('#path-input').value.trim();
                if (!text) { this.showToast('校验失败：请输入路径片段。', 'warning'); return; }
                // 与 applyCSSRules 中 pathPattern 一致：3 通道(href/src/data-src)(BUG-6)
                // 旧版误用 9 通道扩展选择器导致预览比实际拦截多匹配 6 个属性通道
                const sel = ResourceSelectorBuilder.buildPathAttr(text);
                let hit = 0;
                const hideNode = (node) => {
                    if (!node || node === document.body || node === document.documentElement) return false;
                    if (ProtectedCheck.isProtected(node)) return false;
                    if (node.style.display === 'none') return false;
                    BlockEngine.hideElement(node);
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
                btn.textContent = '👁 恢复显示';
                return;
            }

            if (mode === 'attribute') {
                const text = panel.querySelector('#attr-input').value.trim();
                if (!text) { this.showToast('校验失败：请输入属性选择器。', 'warning'); return; }
                // 预览口径与 applyCSSRules 完全一致：attribute 规则保存后直接注入 CSS 选择器，
                // 无 level 向上遍历逻辑。预览也仅隐藏选择器命中的元素本身，确保预览=刷新后效果。
                // 必须校验 isProtectedElement，否则 [id="pro-blocker-ui-host"] 会隐藏整个脚本 UI(BUG-5)
                try {
                    document.querySelectorAll(text).forEach(el => {
                        if (!el || el.style.display === 'none') return;
                        if (ProtectedCheck.isProtected(el)) return;
                        this._previewAffectedElements.push({ el });
                        BlockEngine.hideElement(el); // 统一 4 属性口径(冗余-5)
                    });
                } catch (err) {
                    this.showToast('校验失败：属性选择器语法错误。', 'error');
                    return;
                }
                isPreviewing = true;
                this._showPreviewBanner(() => resetPreview());
                btn.textContent = '👁 恢复显示';
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

                const baseSelector = BlockEngine._buildComplexBaseSelector(conditions, logic);

                const root = document.body;
                const elements = baseSelector === '*'
                    ? root.querySelectorAll('div, span, a, p, img, li, ul, iframe, section, article, aside')
                    : root.querySelectorAll(baseSelector);

                elements.forEach(el => {
                    if (baseSelector === '*' && (el.textContent || '').length > 3000) return;

                    if (BlockEngine.evaluateConditions(conditions, logic, el)) {
                        const target = BlockEngine.findLevelAncestor(el, level);
                        if (target.style.display !== 'none') {
                            this._previewAffectedElements.push({ el: target });
                            BlockEngine.hideElement(target); // 统一 4 属性口径(冗余-5)
                        }
                    }
                });

            } else {
                const text = panel.querySelector('#regex-input').value.trim();
                if (!text) {
                    this.showToast('规则校验失败：请输入有效的匹配内容再进行预览。', 'warning');
                    return;
                }

                // contains 模式用 String.includes() 匹配，不走正则引擎(BUG-M7)
                // regex 模式校验语法后用 RegExp.test()
                const isContains = mode === 'contains';
                let regex = null;
                if (!isContains) {
                    try { regex = new RegExp(text, 'i'); }
                    catch (err) { this.showToast('规则校验失败：正则表达式存在语法错误。', 'error'); return; }
                    // 预览 ReDoS 预检(问题4)：applyRegexRules 会用 isRegexSafe 过滤嵌套量词，
                    // 预览时不检查会导致 regex.test 在每个文本节点上执行，可能触发灾难性回溯卡死页面
                    if (!BlockEngine.isRegexSafe(text)) {
                        this.showToast('规则校验失败：正则含嵌套量词（ReDoS 风险），已拒绝预览。', 'error');
                        return;
                    }
                }

                // 与 applyRegexRules 保持一致：跳过 SCRIPT/STYLE/NOSCRIPT 内的文本，
                // 否则预览会误隐藏 <script> 父级导致页面功能损坏，且与实际执行结果不一致
                const lowerText = isContains ? text.toLowerCase() : null;
                BlockEngine.walkTextNodes(document.body, (node) => {
                    const content = node.textContent || '';
                    const hit = isContains ? content.toLowerCase().includes(lowerText) : regex.test(content);
                    if (hit) {
                        const target = BlockEngine.findLevelAncestor(node.parentElement, level);
                        if (target && target.style.display !== 'none') {
                            this._previewAffectedElements.push({ el: target });
                            BlockEngine.hideElement(target); // 统一 4 属性口径(冗余-5)
                        }
                    }
                });
            }

            isPreviewing = true;
            this._showPreviewBanner(() => resetPreview());
            btn.textContent = '👁 恢复显示';
        });

        panel.querySelector('#btn-save-regex').addEventListener('click', () => {
            const mode = modeSelect.value;

            if (mode === 'iframeBlock') {
                const domain = panel.querySelector('#iframe-domain-input').value.trim().toLowerCase();
                if (!domain) { this.showToast('校验失败：请输入要拦截的 iframe 域名。', 'warning'); return; }
                if (!/^[a-z0-9.\-]+$/.test(domain)) { this.showToast('校验失败：域名格式无效（仅允许字母、数字、点和横线）。', 'error'); return; }
                const added = this.storage.addIframeRule({ matchType: 'srcDomain', value: domain });
                if (!added) { this.showToast('该域名已存在 iframeBlock 规则，已跳过重复添加。', 'info'); return; }
                IframeGuard.invalidateBlockRules();
                EventBus.emit('rule:changed', { type: 'iframeBlock' });
                this.showToast(`已添加 iframe 拦截规则：${domain}`, 'success');
                this.clearPanel();
                return;
            }

            if (mode === 'path') {
                const text = panel.querySelector('#path-input').value.trim();
                if (!text) { this.showToast('校验失败：请输入路径片段。', 'warning'); return; }
                // addRule 内部已通过 saveData 调用 applyCSSRules，此处无需重复(不一致-2)
                this.storage.addRule('pathPattern', { pattern: text, type: 'pathPattern' });
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
                // addRule 内部已通过 saveData 调用 applyCSSRules，此处无需重复(不一致-2)
                this.storage.addRule('attribute', { attrSelector: text, type: 'attribute' });
                this.clearPanel();
                return;
            }

            // NaN 兜底：输入框被清空时 parseInt 返回 NaN，需兜底为 0
            const level = parseInt(panel.querySelector('#regex-level').value, 10) || 0;

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

                this.storage.addRule('complex', { logic, conditions, level, type: 'complex' });
                BlockEngine.applyComplexRules();

            } else {
                const text = panel.querySelector('#regex-input').value.trim();
                if (!text) { this.showToast('校验失败：请输入有效的匹配内容。', 'warning'); return; }

                if (mode === 'contains') {
                    // contains 模式存储原始文本 + mode 标记，applyRegexRules 用 String.includes() 匹配(BUG-M7)
                    // 避免 .*text.* 合并到批量正则后引发贪婪回溯，影响性能
                    this.storage.addRule('regex', { regex: text, level: level, mode: 'contains', type: 'regex' });
                } else {
                    // 正则模式保存前校验语法，与预览路径一致；非法正则会被 applyRegexRules 静默丢弃
                    try { new RegExp(text); }
                    catch (e) { this.showToast('校验失败：正则表达式语法错误。' + e.message, 'error'); return; }
                    // ReDoS 预检(BUG-8)：applyRegexRules 用 isRegexSafe 过滤嵌套量词，
                    // 保存前不检查会导致规则保存了但永不生效，用户无任何提示
                    if (!BlockEngine.isRegexSafe(text)) {
                        this.showToast('校验失败：正则含嵌套量词（ReDoS 风险），已拒绝保存。', 'error');
                        return;
                    }
                    this.storage.addRule('regex', { regex: text, level: level, type: 'regex' });
                }
                BlockEngine.applyRegexRules();
            }

            this.clearPanel();
        });

        panel.querySelector('#btn-close-regex').addEventListener('click', () => this.clearPanel());
    }

    function IframePanel() {
        this.clearPanel();
        const panel = document.createElement('div');
        panel.className = 'panel';

        const config = this.storage.getIframeConfig();

        panel.innerHTML = `
                <h3 title="按住可拖动窗口">🖼️ iframe 防线管理</h3>
                <p>动态 iframe 广告拦截：扫描页面所有 iframe 及帧内可疑元素，按嫌疑分和分类展示，勾选后统一拦截。</p>

                <div class="gd-toolbar">
                    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#ddd;cursor:pointer;">
                        <input type="checkbox" id="if-only-high" /> 只看高风险
                    </label>
                    <button class="btn-outline" id="if-select-high">选中高风险</button>
                    <button class="btn-outline" id="if-select-none">清空</button>
                    <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#ddd;margin:0;">
                        <span>嵌套深度：</span>
                        <input type="number" id="iframe-max-depth" min="1" max="5" value="${config.maxDepth || 3}"
                               style="width:50px;padding:4px 6px;background:rgba(0,0,0,0.25);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:6px;" />
                        <span style="font-size:10px;color:#888;">1-5</span>
                    </label>
                </div>

                <div class="gd-stats" id="iframe-stats"></div>
                <div class="gd-scroll-area" id="iframe-list" style="max-height:320px;"></div>

                <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px;color:#ddd;cursor:pointer;">
                    <input type="checkbox" id="if-block-domain" checked style="cursor:pointer;" />
                    <span>同时封杀 iframe 源域名（加入全局黑名单，并预览/拦截全页该域资源）</span>
                </label>

                <div class="btn-group">
                    <button class="btn-danger" id="btn-block-iframe" style="flex:100%;font-weight:bold;">🛡️ 未选择 iframe</button>
                </div>

                <div class="section-divider"></div>

                <div class="btn-group">
                    <button class="btn-info" id="btn-deep-scan" title="在「重新扫描」基础上：临时拉满嵌套深度并强制重跑帧内元素级深扫（递归嵌套帧、识别透明覆盖/赌博域名等元素），更彻底但更慢">🤖 深度扫描</button>
                    <button class="btn-warning" id="btn-preview-iframe">🔍 预览效果</button>
                    <button class="btn-warning" id="btn-rescan-iframe" title="重新检测页面所有 iframe 并重新分类、刷新列表（不拉满嵌套深度）">🔄 重新扫描</button>
                    <button class="btn-outline" id="btn-close-iframe">关闭</button>
                </div>

                <div class="section-divider"></div>
            `;

        this.makeDraggable(panel);
        this.shadowRoot.appendChild(panel);

        // ─── 状态 ───
        let records = [];
        let selectedSet = new Set();
        let onlyHigh = false;
        let scanning = true;
        let _scanCache = null;
        let _scanCacheTime = 0;
        const SCAN_CACHE_TTL = 5000;

        // 已拦截指纹：跨扫描保留 blocked 状态
        const blockedFingerprints = new WeakSet();
        IframeGuard._liveFrames().forEach((iframe) => {
            const rec = IframeGuard._frameRecords.get(iframe);
            if (rec && (rec.blocked || rec.manual)) blockedFingerprints.add(iframe);
        });

        // ─── 标签与颜色 ───
        const verdictLabel = (v) => ({ 'ad': '广告帧', 'content': '内容帧', 'whitelist': '白名单', 'unknown': '未知' }[v] || '未知');
        const verdictColor = (v) => ({ 'ad': 'rgba(255,59,48,0.7)', 'content': 'rgba(52,199,89,0.6)', 'whitelist': 'rgba(0,122,255,0.6)', 'unknown': 'rgba(120,144,156,0.5)' }[v] || 'rgba(120,144,156,0.5)');
        const elementReasonLabel = { 'domain-ad': '域名封杀', 'path-ad': '路径匹配', 'overlay': '透明覆盖', 'vice': '赌博域名', 'skin': '肤色特征' };
        const getScoreClass = (s) => s >= 50 ? 'high' : s >= 25 ? 'mid' : 'low';

        // 帧级风险分：广告帧最高，未知次之
        const frameScore = (rec) => {
            if (rec.blocked || rec.manual) return 0;
            if (rec.verdict === 'ad') return 100;
            if (rec.verdict === 'unknown') return 50;
            return 10;
        };

        // ─── 采集：合并帧级 + 帧内元素级为统一 records ───
        const collectAll = async () => {
            const now = Date.now();
            let deepResults;
            if (_scanCache && (now - _scanCacheTime) < SCAN_CACHE_TTL) {
                deepResults = _scanCache.results;
            } else {
                deepResults = IframeDeepScanner.scanAll();
                _scanCache = { results: deepResults, time: now };
                _scanCacheTime = now;
            }
            const iframeRecs = [];
            document.querySelectorAll('iframe').forEach(iframe => {
                if (ProtectedCheck.isProtected(iframe)) return;
                const rec = IframeGuard._ensureRecord(iframe);
                iframeRecs.push({ iframe, rec });
            });

            const out = [];
            iframeRecs.forEach(({ iframe, rec }) => {
                const score = frameScore(rec);
                out.push({
                    type: 'frame',
                    iframe,
                    rec,
                    highRisk: score >= 50,
                    blocked: rec.blocked || rec.manual,
                    suspicion: score,
                    verdict: rec.verdict
                });
            });
            deepResults.forEach((elRec) => {
                const cat = elRec.category || 'unknown';
                const suspicion = elRec.suspicion || 0;
                out.push({
                    type: 'element',
                    elRec,
                    highRisk: suspicion >= 50,
                    blocked: elRec.blocked || false,
                    suspicion,
                    category: cat
                });
            });
            out.sort((a, b) => b.suspicion - a.suspicion);
            return out;
        };

        // ─── 扫描执行器 ───
        const runScan = async (skipInitialRender = false) => {
            if (!skipInitialRender) {
                scanning = true;
                render();
            }
            try {
                records = await collectAll();
                selectedSet = new Set();
                records.forEach((r, i) => { if (r.highRisk && !r.blocked) selectedSet.add(i); });
                scanning = false;
                render();
                return true;
            } catch (e) {
                scanning = false;
                Log.error('iframe 扫描失败:', e);
                this.showToast('扫描失败：' + e.message, 'error');
                render();
                return false;
            }
        };

        // ─── 列表渲染 ───
        const render = () => {
            const box = panel.querySelector('#iframe-list');
            const stats = panel.querySelector('#iframe-stats');
            if (!box) return;

            if (scanning) {
                box.innerHTML = '<li class="empty-tip">⏳ 正在扫描 iframe...</li>';
                if (stats) stats.textContent = '正在扫描...';
                const btn = panel.querySelector('#btn-block-iframe');
                if (btn) btn.disabled = true;
                return;
            }

            const filtered = onlyHigh ? records.map((r, i) => ({ r, i })).filter(({ r }) => r.highRisk) : records.map((r, i) => ({ r, i }));

            if (stats) {
                const blockedCount = records.filter(r => r.blocked).length;
                const adFrameCount = records.filter(r => r.type === 'frame' && r.verdict === 'ad').length;
                const contentFrameCount = records.filter(r => r.type === 'frame' && r.verdict === 'content').length;
                const elementCount = records.filter(r => r.type === 'element').length;
                stats.textContent = `共 ${records.length} 项 · 广告帧 ${adFrameCount} · 内容帧 ${contentFrameCount} · 可疑元素 ${elementCount} · 已拦截 ${blockedCount} · 选中 ${selectedSet.size}`;
            }

            if (filtered.length === 0) {
                box.innerHTML = '<div class="empty-tip">当前页面未发现 iframe 或帧内可疑元素。可尝试取消"只看高风险"或使用"深度扫描"。</div>';
                const btn = panel.querySelector('#btn-block-iframe');
                if (btn) { btn.disabled = true; btn.textContent = '🛡️ 未选择 iframe'; }
                return;
            }

            box.innerHTML = filtered.map(({ r, i }) => {
                const checked = selectedSet.has(i);
                const scoreClass = getScoreClass(r.suspicion);
                let badgeHtml = '';
                let titleHtml = '';
                const metaLines = [];

                if (r.type === 'frame') {
                    const rec = r.rec;
                    const iframe = r.iframe;
                    badgeHtml = `<span class="tag" style="background:${verdictColor(rec.verdict)};">${verdictLabel(rec.verdict)}</span>`;
                    if (rec.frozen && !(rec.frozen.w > 0)) badgeHtml += '<span class="tag" style="background:rgba(255,149,0,0.5);">跨域</span>';
                    if (r.blocked) badgeHtml += '<span class="tag" style="background:rgba(52,199,89,0.6);">已拦截</span>';

                    const idPart = iframe.id ? '#' + escapeHTML(iframe.id) : '';
                    const clsPart = iframe.className ? ' · ' + escapeHTML(String(iframe.className).slice(0, 40)) : '';
                    titleHtml = `${escapeHTML(iframe.tagName.toLowerCase())}${idPart}${clsPart}`;
                    const src = iframe.src || '(空)';
                    metaLines.push(`src: ${(src.length > 50) ? escapeHTML(src.slice(0, 50)) + '...' : escapeHTML(src)}`);
                    if (rec.frozen && rec.frozen.w > 0) {
                        metaLines.push(`尺寸: ${rec.frozen.w}×${rec.frozen.h}px · op=${rec.frozen.opacity} · z=${rec.frozen.zi}`);
                    }
                } else {
                    const elRec = r.elRec;
                    const cat = r.category;
                    const color = cat.endsWith('-ad') ? 'rgba(255,59,48,0.7)' : 'rgba(255,159,10,0.6)';
                    const label = elementReasonLabel[cat] || cat;
                    badgeHtml = `<span class="tag" style="background:${color};">⚠${label}</span>`;
                    if (r.blocked) badgeHtml += '<span class="tag" style="background:rgba(52,199,89,0.6);">已拦截</span>';

                    const el = elRec.el;
                    const tagName = el?.tagName ? escapeHTML(el.tagName.toLowerCase()) : '(unknown)';
                    const idPart = el?.id ? '#' + escapeHTML(el.id) : '';
                    const clsPart = el?.className ? '.' + escapeHTML(String(el.className).split(' ')[0]) : '';
                    titleHtml = `<code>${tagName}${idPart}${clsPart}</code>`;
                    if (elRec.selector) metaLines.push(`选择器：${escapeHTML(elRec.selector)}`);
                    if (elRec.frameHost) metaLines.push(`帧域名：${escapeHTML(elRec.frameHost)}`);
                }

                return `<div class="gd-domain-row ${checked ? 'selected' : ''}" data-idx="${i}">
                        <div class="gd-left">
                            <div class="gd-check">${checked ? '✓' : ''}</div>
                            <div>
                                <div class="gd-host">${badgeHtml} ${titleHtml}</div>
                                ${metaLines.map(line => `<div class="gd-meta">${line}</div>`).join('')}
                            </div>
                        </div>
                        <div class="gd-score ${scoreClass}">${r.suspicion}</div>
                    </div>`;
            }).join('');

            const btn = panel.querySelector('#btn-block-iframe');
            if (btn) {
                btn.disabled = selectedSet.size === 0;
                btn.textContent = selectedSet.size > 0 ? `🛡️ 拦截选中的 ${selectedSet.size} 个 iframe/元素` : '🛡️ 未选择 iframe';
            }
        };

        // ─── 预览 ───
        this._iframePreview = { active: false, elements: [] };
        const previewBtn = panel.querySelector('#btn-preview-iframe');
        const resetPreview = () => {
            if (!this._iframePreview.active) return;
            this._iframePreview.elements.forEach(el => BlockEngine.showElement(el));
            this._iframePreview = { active: false, elements: [] };
            this._hidePreviewBanner();
            previewBtn.textContent = '🔍 预览效果';
        };
        const updatePreview = () => {
            if (!this._iframePreview.active) return;
            this._iframePreview.elements.forEach(el => BlockEngine.showElement(el));
            this._iframePreview.elements = [];
            Array.from(selectedSet).forEach(idx => {
                const r = records[idx];
                if (!r || r.blocked) return;
                if (r.type === 'frame') {
                    const iframe = r.iframe;
                    if (document.contains(iframe) && iframe.style.display !== 'none') {
                        BlockEngine.hideElement(iframe);
                        this._iframePreview.elements.push(iframe);
                    }
                } else {
                    const el = r.elRec?.el;
                    if (el && document.contains(el) && el.style.display !== 'none') {
                        BlockEngine.hideElement(el);
                        this._iframePreview.elements.push(el);
                    }
                }
            });
        };

        // ─── 事件绑定 ───
        panel.querySelector('#iframe-list').addEventListener('click', (e) => {
            const row = e.target.closest('.gd-domain-row');
            if (!row) return;
            const idx = parseInt(row.dataset.idx, 10);
            if (selectedSet.has(idx)) selectedSet.delete(idx);
            else selectedSet.add(idx);
            updatePreview();
            render();
        });

        panel.querySelector('#if-only-high').addEventListener('change', (e) => { onlyHigh = e.target.checked; render(); });
        panel.querySelector('#if-select-high').addEventListener('click', () => {
            records.forEach((r, i) => { if (r.highRisk && !r.blocked) selectedSet.add(i); });
            updatePreview();
            render();
        });
        panel.querySelector('#if-select-none').addEventListener('click', () => {
            selectedSet.clear();
            updatePreview();
            render();
        });

        panel.querySelector('#btn-block-iframe').addEventListener('click', () => {
            if (selectedSet.size === 0) return;
            resetPreview();
            let count = 0;
            let iframeRuleCount = 0;
            const blockDomainToo = panel.querySelector('#if-block-domain').checked;
            const domainsToBlock = new Set();
            Array.from(selectedSet).forEach(idx => {
                const r = records[idx];
                if (!r || r.blocked) return;
                if (r.type === 'frame') {
                    const iframe = r.iframe;
                    if (!document.contains(iframe)) return;
                    if (ProtectedCheck.isProtected(iframe)) return;
                    // 持久化 iframeBlock 规则（按 src 域名）：刷新后由 IframeGuard 自动拦截，并出现在「管理规则与防御策略」
                    if (iframe.src) {
                        try {
                            const u = new URL(iframe.src, location.href);
                            if (u.hostname && u.hostname !== window.location.hostname) {
                                if (this.storage.addIframeRule({ matchType: 'srcDomain', value: u.hostname })) iframeRuleCount++;
                            }
                        } catch (e) { Log.warn(e.message || e); }
                    }
                    BlockEngine.hideElement(iframe);
                    r.rec.blocked = true; r.rec.verdict = 'ad';
                    blockedFingerprints.add(iframe);
                    IframeGuard._incStat('blocked');
                    EventBus.emit('iframe:blocked', { iframe, reason: 'panel-click' });
                    if (blockDomainToo && iframe.src) {
                        try {
                            const u = new URL(iframe.src, location.href);
                            if (u.hostname !== window.location.hostname) domainsToBlock.add(u.hostname);
                        } catch (e) { Log.warn(e.message || e); }
                    }
                    count++;
                } else {
                    const elRec = r.elRec;
                    if (!elRec || elRec.blocked) return;
                    IframeGuard.blockInFrameNode(elRec);
                    const targetIframe = elRec.el?.closest('iframe');
                    if (targetIframe) blockedFingerprints.add(targetIframe);
                    if (blockDomainToo && elRec.frameHost) {
                        try {
                            const u = new URL('//' + elRec.frameHost, location.href);
                            if (u.hostname !== window.location.hostname) domainsToBlock.add(u.hostname);
                        } catch (e) { Log.warn(e.message || e); }
                    }
                    count++;
                }
            });
            if (domainsToBlock.size > 0) {
                DomainBlockExecutor.execute(Array.from(domainsToBlock), { hideMode: 'none' });
            }
            selectedSet.clear();
            render();
            let msg = `已拦截 ${count} 个 iframe/元素`;
            if (iframeRuleCount > 0) msg += `，其中 ${iframeRuleCount} 个 iframe 已写入持久规则（刷新后持续生效，可在「管理规则与防御策略」统一管理）`;
            if (domainsToBlock.size > 0) msg += `，并封杀 ${domainsToBlock.size} 个域名`;
            this.showToast(msg, 'success');
        });

        previewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._iframePreview.active) {
                resetPreview();
                return;
            }
            if (selectedSet.size === 0) {
                this.showToast('请先选择需要预览的 iframe/元素。', 'warning');
                return;
            }
            this._iframePreview = { active: true, elements: [] };
            try {
                updatePreview();
            } catch (err) {
                Log.error('iframe 预览失败:', err);
                this._iframePreview.active = false;
                this.showToast('预览失败：' + err.message, 'error');
                return;
            }
            this._showPreviewBanner(() => resetPreview());
            previewBtn.textContent = '👁 恢复显示';
        });

        panel.querySelector('#if-block-domain').addEventListener('change', () => updatePreview());

        panel.querySelector('#btn-deep-scan').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const old = btn.textContent;
            btn.textContent = '⏳ 扫描中...';
            btn.disabled = true;
            _scanCache = null;
            selectedSet.clear();
            // 深度：临时拉满嵌套深度，强制重跑帧内元素级深扫（递归嵌套帧、识别透明覆盖/赌博域名等元素）
            const prevDepth = IframeDeepScanner.maxDepth;
            IframeDeepScanner.maxDepth = IframeGuard.MAX_DEPTH;
            try { IframeGuard.forceRescan(); } catch (er) { Log.warn(er.message || er); }
            const ok = await runScan(false);
            IframeDeepScanner.maxDepth = prevDepth;
            btn.textContent = old;
            btn.disabled = false;
            if (ok) this.showToast('深度扫描完成（已递归嵌套帧、重跑元素级深扫）', 'success');
        });

        panel.querySelector('#btn-rescan-iframe').addEventListener('click', async () => {
            _scanCache = null;
            selectedSet.clear();
            try { IframeGuard.forceRescan(); } catch (e) { this.showToast('重扫失败: ' + e.message, 'error'); return; }
            await runScan(false);
            this.showToast('已重新扫描全部 iframe（帧级重新分类）', 'success');
        });

        panel.querySelector('#iframe-max-depth').addEventListener('change', (e) => {
            const d = parseInt(e.target.value, 10);
            if (d >= IframeGuard.MIN_DEPTH && d <= IframeGuard.MAX_DEPTH) {
                IframeGuard.setMaxDepth(d);
                IframeDeepScanner.maxDepth = d;
                this.showToast(`扫描深度已设为 ${d} 层`, 'success');
            } else {
                this.showToast('深度须在 1-5 之间', 'warning');
                e.target.value = this.storage.getIframeConfig().maxDepth || 3;
            }
        });

        panel.querySelector('#btn-close-iframe').addEventListener('click', () => {
            resetPreview();
            this.clearPanel();
        });

        // 订阅统计更新
        if (!this._iframeUnsubs) this._iframeUnsubs = [];
        this._iframeUnsubs.push(EventBus.on('iframe:stats', () => render()));

        // 初始加载
        runScan(true);
    }

    function ManagerPanel() {
        this.clearPanel();
        const panel = document.createElement('div');
        panel.className = 'panel';
        const data = this.storage.getData();

        // 防御策略状态
        const isManualPreemptive = data.config.mode === 'preemptive';
        const isFlashMarked = !!this.storage.flashList[this.storage.domain];
        const cleanCount = this.storage.getCleanLoadCount();
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
                <h3 title="按住可拖动窗口">规则与防御管理 (${this.storage.domain})</h3>

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
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:6px; margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.05);">
                        <div>🖼️ <strong>iframe 拦截：</strong><span style="color:#ff6f00;"> ${IframeGuard.getStats().blocked}</span> 个</div>
                        <div>🛡️ <strong>iframe 保护：</strong><span style="color:#34c759;"> ${IframeGuard.getStats().protected}</span> 个</div>
                        <div>🔍 <strong>iframe 扫描：</strong><span style="color:#4aa3ff;"> ${IframeGuard.getStats().scanned}</span> 个</div>
                        <div>🧹 <strong>内部清理：</strong><span style="color:#9c27b0;"> ${IframeGuard.getStats().cleaned}</span> 个</div>
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
                        <option value="iframeBlock">iframe</option>
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
                    <button class="btn-info" id="btn-iframe-panel">🖼️ iframe 防线管理</button>
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
                case 'regex': return `${r.mode === 'contains' ? '包含' : '匹配'}: ${escapeHTML(r.regex || '')} (层级: ${r.level})`;
                case 'attribute': return `选择器: ${escapeHTML(r.attrSelector || '')}`;
                case 'structural': return escapeHTML(r.structSelector || '');
                case 'pathPattern': return `模式: ${escapeHTML(r.pattern || '')}`;
                case 'iframeBlock': {
                    const mt = r.matchType === 'srcDomain' ? 'src域名' : (r.matchType === 'srcdocKeyword' ? 'srcdoc关键词' : (r.matchType === 'geometry' ? '几何条件' : r.matchType));
                    return `iframe[${mt}]: ${escapeHTML(r.value || '')}`;
                }
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
            iframeBlock: { label: 'iframe', tag: 'iframe' },
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
            const d = this.storage.getData();
            // 1. 全局域名黑名单（{domain,_ts}[]）
            d.domainBlock.forEach((r, i) => recs.push({
                scope: 'global', domain: '(全局)', index: i, type: 'domainBlock',
                content: escapeHTML(r.domain), ts: r._ts || 0, value: r.domain,
                disabled: !!r._disabled,
                rule: r
            }));
            // 1.1 iframe 规则（全局生效，{matchType,value,_ts,_disabled}[]）
            this.storage.getIframeBlocks().forEach((r, i) => recs.push({
                scope: 'global', domain: '(全局)', index: i, type: 'iframeBlock',
                content: formatRuleContent('iframeBlock', r), ts: r._ts || 0, value: r.value || '',
                disabled: !!r._disabled,
                rule: r
            }));
            // 2. 本站 7 类规则
            ['static', 'dynamic', 'regex', 'attribute', 'structural', 'complex', 'pathPattern'].forEach(type => {
                (d[type] || []).forEach((r, i) => recs.push({
                    scope: 'current', domain: this.storage.domain, index: i, type,
                    content: formatRuleContent(type, r), ts: r._ts || 0,
                    value: (type === 'pathPattern') ? (r.pattern || '') : '',
                    disabled: !!r._disabled,
                    rule: r
                }));
            });
            // 3. 其他站点规则（跨站，排除本站以免重复）
            this.storage.getAllSiteRules().forEach(rec => {
                if (rec.domain === this.storage.domain) return;
                recs.push({
                    scope: 'other', domain: rec.domain, index: rec.index, type: rec.type,
                    content: formatRuleContent(rec.type, rec.rule), ts: rec.rule._ts || 0,
                    value: (rec.type === 'pathPattern') ? (rec.rule.pattern || '') : '',
                    disabled: !!rec.rule._disabled,
                    rule: rec.rule
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
        // 构建记录并按需注入 impactScore：删除/撤销/切换后调用，避免影响度模式下排序退化(BUG-S3)
        const rebuildRecords = () => {
            const recs = buildRecords();
            if (impactMode) {
                const impacts = this.evaluateRuleImpact();
                const impactMap = new Map();
                impacts.forEach(imp => impactMap.set(`${imp.type}-${imp.index}`, imp.score));
                recs.forEach(rec => { rec.impactScore = impactMap.get(`${rec.type}-${rec.index}`) || 0; });
            }
            return recs;
        };
        let records = rebuildRecords();

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
                    const hay = (rec.domain + ' ' + (TYPE_META[rec.type] ? TYPE_META[rec.type].label : '') + ' ' + rec.content + (rec.rule?._meta || '')).toLowerCase();
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
                // 禁用规则：文字置灰 + 删除线 + "已禁用"标记 + 切换按钮显示"启用"
                const disabledStyle = rec.disabled ? 'opacity:0.45; text-decoration:line-through;' : '';
                const disabledBadge = rec.disabled ? '<span class="tag" style="background:rgba(142,142,147,0.6);">已禁用</span>' : '';
                const toggleLabel = rec.disabled ? '启用' : '禁用';
                const toggleClass = rec.disabled ? 'btn-success' : 'btn-outline';
                // 批量选择模式：每条规则前显示复选框，key 唯一标识一条规则用于批量删除
                const recKey = `${rec.scope}|${rec.domain}|${rec.type}|${rec.index}`;
                const batchBox = batchMode
                    ? `<input type="checkbox" class="batch-check" data-key="${escapeHTML(recKey)}" ${batchSelected.has(recKey) ? 'checked' : ''} style="flex:none; width:16px; height:16px; margin-right:8px; cursor:pointer; accent-color:#ff3b30;" />`
                    : '';
                // 帧内深扫规则徽章（B4）
                const iframeBadge = (rec.rule?._meta === 'iframe-scan')
                    ? '<span class="tag" style="background:rgba(156,39,176,.5);">🖼帧内</span>' : '';
                return `<li class="rule-item">
                        ${batchBox}
                        <div class="rule-content" style="${disabledStyle}">
                            ${siteBadge}<span class="tag ${meta.tag}">${meta.label}</span> ${rec.content} ${impactBadge} ${disabledBadge} ${iframeBadge}
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
            // 用 currentTarget 取按钮本身，避免点击子元素时 e.target 指向子元素(BUG-3)
            const btn = e.currentTarget;
            if (!impactMode) {
                impactMode = true;
                btn.textContent = '↩ 恢复原排序';
                btn.classList.remove('btn-warning');
                btn.classList.add('btn-success');
                records = rebuildRecords(); // 进入影响度模式时注入 impactScore
            } else {
                impactMode = false;
                btn.textContent = '📊 按影响度排序';
                btn.classList.remove('btn-success');
                btn.classList.add('btn-warning');
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
                // iframe 规则走独立 API
                if (type === 'iframeBlock') {
                    const nowDisabled = this.storage.toggleIframeRuleDisabled(index);
                    this.showToast(nowDisabled ? '规则已禁用' : '规则已启用', nowDisabled ? 'warning' : 'success');
                    try { IframeGuard.rescanAll(); } catch (e) { Log.warn(e.message || e); }
                    records = rebuildRecords();
                    renderList();
                    return;
                }
                // 跨站规则需传 domain，本站/全局用默认
                const targetDomain = scope === 'other' ? domain : null;
                const nowDisabled = this.storage.toggleRuleDisabled(type, index, targetDomain);
                this.showToast(nowDisabled ? '规则已禁用' : '规则已启用', nowDisabled ? 'warning' : 'success');
                // B4: iframe-scan 规则启用/禁用时同步重应用到帧内
                if (type === 'attribute') {
                    try {
                        const allRules = this.storage.getAllSiteRules();
                        const targetRule = allRules.find(r => r.domain === domain && r.type === type && r.index === index);
                        if (targetRule && targetRule.rule?._meta === 'iframe-scan') {
                            IframeGuard.reapplyInFrames();
                        }
                    } catch (e) { Log.warn(e.message || e); }
                }
                records = rebuildRecords();
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
            if (type === 'iframeBlock') {
                capturedRule = this.storage.getIframeBlocks()[index];
            } else if (scope === 'global') {
                capturedRule = this.storage.getDomainBlocks()[index];
            } else if (scope === 'current') {
                capturedRule = this.storage.getData()[type][index];
            } else {
                const siteRec = this.storage.getAllSiteRules().find(r => r.domain === domain && r.type === type && r.index === index);
                capturedRule = siteRec ? siteRec.rule : null;
            }

            if (type === 'iframeBlock') {
                this.storage.removeIframeRule(index);
                IframeGuard.rescanAll(); // 重新评估所有 iframe（含已处理的）让规则变更即时生效
            } else if (scope === 'global') {
                // 域名黑名单：removeRule 已不再内部 apply(不一致-1)，统一由 reapplyAll 接管
                // reapplyAll = restoreAllInlineStyles + applyCSSRules + applyRegexRules + applyComplexRules + scanAndBlockDynamic
                // restoreAllInlineStyles 清除该域名命中的内联隐藏，applyCSSRules 重建表（不含已删域名）
                this.storage.removeRule('domainBlock', index);
                BlockEngine.reapplyAll();
            } else if (scope === 'current') {
                this.storage.removeRule(type, index);
                BlockEngine.reapplyAll();
            } else {
                // 跨站规则：同上，需重新应用所有内联拦截
                this.storage.removeRuleForDomain(domain, type, index);
                BlockEngine.reapplyAll();
                // B4: 若是 iframe-scan 规则，同步重应用到各帧
                if (capturedRule && capturedRule._meta === 'iframe-scan') {
                    try { IframeGuard.reapplyInFrames(); } catch (e) { Log.warn(e.message || e); }
                }
            }
            // 推入撤销栈并显示带撤销按钮的 Toast（5s 内可恢复）
            if (capturedRule) {
                this._pushUndo({ type, domain, scope, rule: { ...capturedRule } });
                this.showToast('已删除规则', 'warning', 5000, () => {
                    this._performUndo();
                    records = rebuildRecords();
                    renderList();
                });
            }
            records = rebuildRecords();
            renderList();
            requestAnimationFrame(() => { if (scrollBox) scrollBox.scrollTop = savedScroll; });
        });

        // ===== 批量删除功能 =====
        // 批量选择 toggle：切换批量模式，退出时清空已选集合
        panel.querySelector('#btn-batch').addEventListener('click', (e) => {
            batchMode = !batchMode;
            if (!batchMode) batchSelected.clear();
            // 用 currentTarget 取按钮本身，避免点击子元素时 e.target 指向子元素(BUG-3)
            const btn = e.currentTarget;
            btn.textContent = batchMode ? '↩ 退出批量' : '☑ 批量选择';
            btn.classList.toggle('btn-success', batchMode);
            btn.classList.toggle('btn-outline', !batchMode);
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
                    if (t.type === 'iframeBlock') {
                        // iframeBlock 规则走独立 API（须在 scope==='global' 分支前判断，因 iframeBlock 也标记为 global）
                        rule = this.storage.getIframeBlocks()[t.index];
                        value = rule ? (rule.value || '') : '';
                    } else if (t.scope === 'global') {
                        rule = this.storage.getDomainBlocks()[t.index];
                        value = rule ? rule.domain : '';
                    } else if (t.scope === 'current') {
                        rule = this.storage.getData()[t.type] && this.storage.getData()[t.type][t.index];
                    } else {
                        const siteRec = this.storage.getAllSiteRules().find(r => r.domain === t.domain && r.type === t.type && r.index === t.index);
                        rule = siteRec ? siteRec.rule : null;
                    }
                    if (rule) captured.push({ scope: t.scope, domain: t.domain, type: t.type, rule: { ...rule }, value });
                });
                // 冗余-1：已移除 restoreInlineForDomain 循环——reapplyAll 内部 restoreAllInlineStyles
                // 会清除全部内联隐藏样式（不依赖规则存在），此处的逐域名还原完全被覆盖，属冗余操作
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
                        if (t.type === 'iframeBlock') this.storage.removeIframeRule(t.index);
                        else if (t.scope === 'global') this.storage.removeRule('domainBlock', t.index);
                        else if (t.scope === 'current') this.storage.removeRule(t.type, t.index);
                        else this.storage.removeRuleForDomain(t.domain, t.type, t.index);
                    });
                });
                // 删除后统一重新应用所有拦截规则
                BlockEngine.reapplyAll();
                // iframeBlock 规则变更需重新扫描（reapplyAll 不覆盖 iframe 扫描）
                if (tasks.some(t => t.type === 'iframeBlock')) {
                    try { IframeGuard.rescanAll(); } catch (e) { Log.warn(e.message || e); }
                }
                // 推入批量撤销条目（一次撤销恢复全部）
                if (captured.length > 0) {
                    this._pushUndo({ batch: true, rules: captured });
                    this.showToast(`已批量删除 ${captured.length} 条规则`, 'warning', 5000, () => {
                        this._performUndo();
                        records = rebuildRecords();
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
                records = rebuildRecords();
                renderList();
            });
        });

        // 高亮颜色 Hex 输入：实时校验、预览并持久化
        const colorInput = panel.querySelector('#ui-highlight-color');
        const colorPreview = panel.querySelector('#color-preview');
        if (colorInput) {
            colorInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                // 非法 Hex 值给视觉反馈(BUG-11)：红框提示用户格式错误，合法时还原边框并实时预览
                if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
                    colorInput.style.borderColor = '';
                    document.documentElement.style.setProperty('--pro-blocker-highlight-color', val);
                    if (colorPreview) colorPreview.style.background = val;
                    GM_setValue('config_highlight_color', val);
                } else {
                    colorInput.style.borderColor = '#FF3B30';
                }
            });
        }

        panel.querySelector('#btn-toggle-mode').addEventListener('click', () => {
            const newMode = this.storage.toggleMode();
            this.showToast(`策略已调整为：${newMode === 'preemptive' ? '极速预判模式' : '智能自动模式'}，页面即将刷新。`, 'info', 2000);
            setTimeout(() => window.location.reload(), TIMING.RELOAD_DELAY_MS);
        });

        const resetBtn = panel.querySelector('#btn-reset-flash');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.showConfirm('清除闪现标记', '确认清除本站的闪现标记？清除后将恢复"智能自动"模式（除非你手动开启极速预判）。', () => {
                    this.storage.resetFlash();
                    this.showToast('闪现标记已清除，页面即将刷新。', 'success', 2000);
                    setTimeout(() => window.location.reload(), TIMING.RELOAD_DELAY_MS);
                });
            });
        }

        panel.querySelector('#btn-export').addEventListener('click', () => this.showExportPanel());
        panel.querySelector('#btn-import').addEventListener('click', () => this.showImportPanel());
        panel.querySelector('#btn-ag-export').addEventListener('click', () => this.showAdGuardExportPanel());

        panel.querySelector('#btn-clear-all').addEventListener('click', () => {
            this.showConfirm('清除本站规则', '警告：此操作将清空【当前域名】下的所有拦截规则和配置（不影响全局域名黑名单）。确认继续？', () => {
                this.storage.clearDomain();
                window.location.reload();
            });
        });

        panel.querySelector('#btn-close-manager').addEventListener('click', () => this.clearPanel());
        panel.querySelector('#btn-iframe-panel').addEventListener('click', () => this.showIframePanel());
    }

    function ExportPanel() {
        this.clearPanel();
        const panel = document.createElement('div');
        panel.className = 'panel';
        const json = this.storage.exportAll();

        panel.innerHTML = `
                <h3 title="按住可拖动窗口">📤 导出规则</h3>
                <p>下方文本框包含全部拦截规则、全局域名黑名单、iframe 拦截规则与白名单。复制后保存到任意位置，或在新设备的脚本中通过"导入规则"粘贴即可。</p>
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

    function AdGuardExportPanel() {
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

    function OverlayScanPanel() {
        this.clearPanel();
        const panel = document.createElement('div');
        panel.className = 'panel';

        // 双引擎采集：BlockEngine.scanInvisibleOverlays（透明跳转覆盖层）+ OverlayScanEngine（不可见/覆盖层/博彩色情图片/追踪像素）
        // 合并策略：按元素引用合并，BlockEngine 提供触发URL/跨域/尺寸，OverlayScanEngine 提供嫌疑分/分类/特征/原因
        // 过滤策略：已封杀域名 / 已被脚本隐藏 / 已匹配现有规则的元素不再重复展示
        const collectAll = async (opts = {}) => {
            const deep = !!opts.deep;
            const blockedDomains = new Set(this.storage.getDomainBlocks().map(r => r.domain));
            // 异步时间分片扫描：避免大型页面 5000+ 候选导致主线程卡顿
            const beRecords = await BlockEngine.scanInvisibleOverlaysAsync({ autoBlock: false });
            let oasResult = { results: [], elapsed: '0', total: 0, deepExtras: null };
            try {
                // 不一致-3 修复：deep=true 调用 deepScan（肤色/伪元素/沙箱解码高阶探测），
                //              deep=false 调用 scan（快速基线），两者维度/耗时显著区分
                oasResult = deep ? OverlayService.deepScan({ deep: true }) : OverlayService.scan();
            } catch (e) { Log.warn(e.message || e); }
            // 以元素引用为 key 建立 OverlayScanEngine 特征索引
            const oasMap = new Map();
            for (const r of (oasResult.results || [])) {
                if (r.el) oasMap.set(r.el, r);
            }

            // 判定元素是否已被封杀（域名已在黑名单 / 元素已被脚本隐藏 / 元素匹配现有规则）
            const isAlreadyBlocked = (rec) => {
                if (!rec.el) return true;
                // 脚本自身 UI 永远视为已处理（不展示在扫描结果中）
                if (ProtectedCheck.isProtected(rec.el)) return true;
                // 元素已从 DOM 移除（被脚本 remove() 或被父级移除）
                if (!document.contains(rec.el)) return true;
                if (rec.triggerUrl) {
                    try {
                        const h = new URL(rec.triggerUrl, location.href).hostname;
                        if (blockedDomains.has(h)) return true;
                    } catch (e) { Log.warn(e.message || e); }
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
                    } catch (e) { Log.warn(e.message || e); }
                }
                // 检查元素是否匹配现有的静态/属性规则（确保持久化拦截的元素不再展示）
                if (rec.el) {
                    try {
                        const data = this.storage.getData();
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
                    } catch (e) { Log.warn(e.message || e); }
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
            // 用 Set O(1) 去重替代 beRecords.find O(n)，避免 O(n×m) 嵌套查找(冗余-4)
            const beElSet = new Set(beRecords.map(r => r.el).filter(Boolean));
            for (const oas of (oasResult.results || [])) {
                if (!oas.el || beElSet.has(oas.el)) continue;
                const rect = oas.el.getBoundingClientRect ? oas.el.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
                // getComputedStyle 缓存一次，避免重复 3 次调用(冗余-3)
                const cs = window.getComputedStyle(oas.el);
                const rec = {
                    el: oas.el,
                    tagName: oas.el.tagName,
                    id: oas.el.id || '',
                    className: typeof oas.el.className === 'string' ? oas.el.className.slice(0, 80) : '',
                    opacity: parseFloat(cs.opacity) || 1,
                    visibility: cs.visibility,
                    position: cs.position,
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
            return { records: merged, oasElapsed: oasResult.elapsed, deepExtras: oasResult.deepExtras || null };
        };

        // 异步初始加载：扫描在空闲帧分片执行，先显示加载态再渲染结果
        let records = [];
        let oasElapsed = '0';
        let selectedSet = new Set();
        let onlyHigh = false;
        // 已拦截元素指纹集合：跨重新扫描保留 blocked 状态(BUG-D8)
        // 用 tagName+id+className+rect 组合作为元素指纹，避免元素引用失效后状态丢失
        let blockedFingerprints = new Set();
        const fingerprintOf = (r) => `${r.tagName}|${r.id || ''}|${typeof r.el?.className === 'string' ? r.el.className.slice(0, 80) : ''}|${r.rect?.w || 0}x${r.rect?.h || 0}`;
        // 扫描进行中标志：render() 据此显示加载占位，避免空 records 误导用户以为扫描无结果(BUG-S2)
        let scanning = true;

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

            // 扫描进行中：显示加载占位，不展示"未发现"误导用户(BUG-S2)
            if (scanning) {
                box.innerHTML = '<li class="empty-tip">⏳ 正在扫描覆盖层...</li>';
                if (stats) stats.textContent = '正在扫描...';
                const btnBlock = panel.querySelector('#btn-block-overlay');
                if (btnBlock) btnBlock.disabled = true;
                return;
            }

            const filtered = onlyHigh ? records.map((r, i) => ({ r, i })).filter(({ r }) => r.highRisk) : records.map((r, i) => ({ r, i }));

            if (stats) {
                const blockedCount = records.filter(r => r.blocked).length;
                const viceCount = records.filter(r => r.category === 'vice-image').length;
                const invisibleCount = records.filter(r => r.category === 'invisible').length;
                const overlayCount = records.filter(r => r.category === 'overlay').length;
                stats.textContent = `共 ${records.length} 项 · 🚫博彩色情 ${viceCount} · 覆盖层 ${overlayCount} · 不可见 ${invisibleCount} · 已拦截 ${blockedCount} · 选中 ${selectedSet.size}`;
            }

            if (filtered.length === 0) {
                box.innerHTML = '<div class="empty-tip">未发现不可见覆盖层广告。可尝试取消"只看高风险"或使用"深度扫描"。</div>';
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
                const willChangeBadge = r.hasWillChange ? '<span class="tag" style="background:rgba(255,149,0,0.6);">合成层</span>' : '';
                const blockedBadge = r.blocked ? '<span class="tag" style="background:rgba(52,199,89,0.6);">已拦截</span>' : '';
                const viceBadge = r.features?.viceTarget ? `<span class="tag" style="background:rgba(255,0,80,0.75);">🚫${escapeHTML(r.features.viceTarget)}</span>` : '';
                const reasons = (r.oasReasons && r.oasReasons.length) ? r.oasReasons.slice(0, 3).join(' · ') : '';
                // 截断 triggerUrl 时添加 title 属性展示完整 URL(BUG-L4)
                const triggerRaw = r.triggerUrl || (r.hasOnClick ? 'onclick' : '—');
                const triggerDisplay = r.triggerUrl && r.triggerUrl.length > 80
                    ? escapeHTML(r.triggerUrl.slice(0, 80)) + '...'
                    : escapeHTML(triggerRaw);
                const trigger = r.triggerUrl
                    ? `<span title="${escapeHTML(r.triggerUrl)}">${triggerDisplay}</span>`
                    : triggerDisplay;
                const selector = r.selector ? `<div class="gd-meta">选择器：${escapeHTML(r.selector)}</div>` : '';
                const cls = r.className ? `<div class="gd-meta">class: ${escapeHTML(r.className)}</div>` : '';
                const suspicion = r.suspicion || 0;
                return `<div class="gd-domain-row ${checked ? 'selected' : ''}" data-idx="${i}">
                        <div class="gd-left">
                            <div class="gd-check">${checked ? '✓' : ''}</div>
                            <div>
                                <div class="gd-host">${catBadge}${riskBadge}${willChangeBadge}${blockedBadge}${viceBadge} ${escapeHTML(r.tagName)} ${r.id ? '#' + escapeHTML(r.id) : ''} · ${r.rect.w}×${r.rect.h}px</div>
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
        // 先渲染加载占位(BUG-S2)，再启动异步扫描；扫描完成后用真实结果重绘
        render();
        // 记录最近一次深度扫描的额外发现，供 Toast 统计展示（必须先于 runScan 声明，避免 TDZ）
        let lastDeepExtras = null;
        // 共享扫描执行器：初始加载 / 重新扫描 / 深度扫描统一调用，避免重复代码
        // skipInitialRender=true 时跳过内部 scanning=true+render()，供首次加载复用外部已渲染的占位(问题5)
        // opts.deep=true 开启真·深度扫描（肤色/伪元素/沙箱解码），false 仅基线扫描（不一致-3）
        const runScan = async (skipInitialRender = false, opts = {}) => {
            const deep = !!opts.deep;
            if (!skipInitialRender) {
                scanning = true;
                render();
            }
            try {
                // collectAll 内部按 deep 调用 OverlayScanEngine.deepScan/scan，此处不再冗余预调用(BUG-M6)
                const collected = await collectAll({ deep });
                records = collected.records;
                oasElapsed = collected.oasElapsed;
                lastDeepExtras = collected.deepExtras || null;
                // 跨扫描保留已拦截状态(BUG-D8)：用指纹匹配回填 r.blocked
                records.forEach(r => { if (blockedFingerprints.has(fingerprintOf(r))) r.blocked = true; });
                // 默认选中所有未拦截的高风险记录(BUG-3)：必须基于原始 records 索引遍历，
                // 旧版 filter().map((r,i)=>i) 的 i 是过滤后数组索引，导致 selectedSet 指向错误元素
                selectedSet = new Set();
                records.forEach((r, i) => { if (r.highRisk && !r.blocked) selectedSet.add(i); });
                scanning = false;
                render();
                return true; // 扫描成功(BUG-9)：供深度扫描回调判断是否显示完成 Toast
            } catch (e) {
                scanning = false;
                Log.error('覆盖层扫描失败:', e);
                this.showToast('扫描失败：' + e.message, 'error');
                render();
                return false; // 扫描失败：避免回调再显示矛盾的"深度扫描完成"Toast
            }
        };
        // 首次加载：外部已渲染加载占位，跳过 runScan 内部重复渲染(问题5)；初始为基线扫描
        runScan(true, { deep: false });

        // 预览状态：实例属性，clearPanel 切换/关闭面板时兜底还原，避免预览隐藏的元素永久残留
        // 实时联动模式：预览激活时，选择变化自动更新预览（隐藏新增选中 / 还原取消选中），无需手动重置
        this._overlayPreview = { active: false, elements: [], hiddenDomains: new Set() };
        // previewBtn 必须先于 resetOverlayPreview 声明，否则闭包内引用触发 TDZ ReferenceError(BUG-4)
        const previewBtn = panel.querySelector('#btn-preview-overlay');
        const resetOverlayPreview = () => {
            if (!this._overlayPreview.active) return;
            this._overlayPreview.elements.forEach(el => BlockEngine.showElement(el));
            this._overlayPreview = { active: false, elements: [], hiddenDomains: new Set() };
            this._hidePreviewBanner();
            previewBtn.textContent = '🔍 预览效果';
        };

        // 实时更新预览：根据当前 selectedSet 和域名勾选状态，增量隐藏/还原元素
        const updatePreview = () => {
            if (!this._overlayPreview.active) return;
            // ① 先还原所有预览元素
            this._overlayPreview.elements.forEach(el => BlockEngine.showElement(el));
            this._overlayPreview.elements = [];
            this._overlayPreview.hiddenDomains = new Set();
            const blockDomainToo = panel.querySelector('#ov-block-domain').checked;
            // ② 重新隐藏当前选中的覆盖层
            Array.from(selectedSet).forEach(idx => {
                const r = records[idx];
                if (!r || !r.el || !document.contains(r.el)) return;
                // 统一保护：脚本自身 UI 宿主（含 Shadow DOM 内部）跳过
                if (ProtectedCheck.isProtected(r.el)) return;
                if (r.el.style.display !== 'none') {
                    // 统一隐藏口径(5.2 节)
                    BlockEngine.hideElement(r.el);
                    this._overlayPreview.elements.push(r.el);
                }
                if (blockDomainToo && r.triggerUrl) {
                    try {
                        const u = new URL(r.triggerUrl, location.href);
                        if (u.hostname !== window.location.hostname) this._overlayPreview.hiddenDomains.add(u.hostname);
                    } catch (e) { Log.warn(e.message || e); }
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
            // 与 runScan 初始化逻辑一致(问题1)：排除已拦截项，避免重复生成持久化规则
            records.forEach((r, i) => { if (r.highRisk && !r.blocked) selectedSet.add(i); });
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
                Log.error('覆盖层预览失败:', err);
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
            let ruleCount = 0;
            let skippedSelfUI = 0;
            // 收集选中记录的去重跨域域名，循环结束后批量封杀（避免重复添加规则）
            const domainsToBlock = new Set();
            // 仅修改 record 属性不删除数组元素，无需降序遍历；直接 forEach
            Array.from(selectedSet).forEach(idx => {
                const r = records[idx];
                if (!r || !r.el || !document.contains(r.el)) return;
                // 统一保护：脚本自身 UI 宿主（含 Shadow DOM 内部）绝不拦截，否则所有面板都会消失
                if (ProtectedCheck.isProtected(r.el)) {
                    skippedSelfUI++;
                    return;
                }
                // 统一隐藏口径：补齐 opacity:0，与 applyCSSRules/scanAndBlockDynamic 一致(BUG-D4)
                BlockEngine.hideElement(r.el);
                r.blocked = true;
                // 记录指纹：重新扫描后据此回填 blocked 状态(BUG-D8)
                blockedFingerprints.add(fingerprintOf(r));
                // 自动生成持久化规则：基于元素特征生成属性选择器，确保刷新后仍能拦截
                // 无 id/class 时回退到物理结构选择器(BUG-D5)，避免刷新后拦截失效
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
                    // skipApply=true：跳过 addRule 内部 applyCSSRules，循环结束后统一调用一次(冗余-2)
                    if (attrSelector) {
                        this.storage.addRule('attribute', { attrSelector, type: 'attribute' }, true);
                        ruleCount++;
                    } else {
                        // 兜底：无 id/class 时用物理结构选择器(nth-of-type 路径)，刷新后仍可定位(BUG-D5)
                        const structSelector = BlockEngine.generateStructuralSelector(el);
                        if (structSelector) {
                            this.storage.addRule('structural', { structSelector, type: 'structural' }, true);
                            ruleCount++;
                        }
                    }
                } catch (e) { Log.warn(e.message || e); }
                // 仅在勾选「封杀域名」时收集跨域跳转域名（去重）
                if (blockDomainToo && r.triggerUrl) {
                    try {
                        const u = new URL(r.triggerUrl, location.href);
                        if (u.hostname !== window.location.hostname) {
                            domainsToBlock.add(u.hostname);
                        }
                    } catch (e) { Log.warn(e.message || e); }
                }
            });
            // 循环内 addRule 均用 skipApply=true 跳过，此处统一重建一次样式表(冗余-2)
            if (ruleCount > 0) BlockEngine.applyCSSRules();
            // 批量封杀收集到的域名：添加 domainBlock 规则（元素已单独隐藏，hideMode='none'）
            const domainCount = domainsToBlock.size;
            if (domainCount > 0) {
                DomainBlockExecutor.execute(Array.from(domainsToBlock), { hideMode: 'none' });
            }
            selectedSet.clear();
            render();
            const domainNote = blockDomainToo ? `，${domainCount} 个跨域跳转域名已加入全局黑名单` : '（未封杀域名）';
            const ruleNote = ruleCount > 0 ? `，已生成 ${ruleCount} 条持久化规则` : '';
            const skipNote = skippedSelfUI > 0 ? `（跳过 ${skippedSelfUI} 个脚本自身元素）` : '';
            this.showToast(`已拦截选中的覆盖层${domainNote}${ruleNote}${skipNote}`, 'success');
        });

        // 深度扫描：真·深度覆盖层挖掘（v0.7.0 重构）
        // 开启高开销探测：Canvas 肤色采样 / CSS 伪元素穿透 / 混淆跳转沙箱解码 / Icon Font 映射
        // 耗时 200ms~2s，runScan 内部已通过 scanInvisibleOverlaysAsync 时间分片，避免主线程卡顿(不一致-3)
        panel.querySelector('#btn-deep-scan').addEventListener('click', (e) => {
            const btn = e.currentTarget; // BUG-3：用 currentTarget 取按钮本身
            btn.disabled = true;
            btn.textContent = '⏳ 深度挖掘中...';
            resetOverlayPreview();
            // runScan 返回成功/失败标志(BUG-9)：失败时 catch 已显示"扫描失败"Toast，
            // 此处仅成功时显示"深度扫描完成"，避免两个矛盾 Toast 同时出现
            runScan(false, { deep: true }).then(ok => {
                btn.disabled = false;
                btn.textContent = '🤖 深度扫描';
                if (ok) {
                    const ex = lastDeepExtras;
                    const note = ex ? `（深度新增：🎨肤色图 ${ex.viceImages.length} · 🔐混淆跳转 ${ex.obfuscatedUrls.length} · ::伪元素 ${ex.pseudoInjects.length} · 🔤自定义字体 ${ex.customFontEls.length}）` : '';
                    this.showToast(`深度扫描完成，发现 ${records.length} 个可疑覆盖层。${note}`, 'success', 6000);
                }
            });
        });

        // 重新扫描：快速基线扫描（耗时 < 50ms），仅双引擎基线，不开启高开销探测(不一致-3)
        panel.querySelector('#btn-rescan').addEventListener('click', () => {
            resetOverlayPreview();
            runScan(false, { deep: false });
        });

        panel.querySelector('#btn-close-overlay').addEventListener('click', () => this.clearPanel());
    }

    function ImportPanel() {
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
                    this.storage.importAll(text, mode === 'merge');
                    this.showToast('导入成功！页面即将刷新以应用规则。', 'success', 2000);
                    setTimeout(() => window.location.reload(), TIMING.RELOAD_DELAY_MS);
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
            this.storage = StorageService;
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
            this._actionPreview = { active: false, elements: [] };
            // 全局域名面板预览状态：必须为实例属性，clearPanel 才能跨面板切换时清理，避免预览隐藏的元素永久残留
            this._globalPreview = { active: false, elements: [] };
            // 覆盖层扫描面板预览状态：同为实例属性，clearPanel 跨面板切换时还原 visibility/display
            this._overlayPreview = { active: false, elements: [] };
            // iframe 防线面板预览状态：对齐覆盖层面板口径，支持勾选+批量预览
            this._iframePreview = { active: false, elements: [] };
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
                :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; }
                .panel {
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(25, 25, 30, 0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255,255,255,0.16); padding: 20px; border-radius: 16px;
                    box-shadow: 0 20px 64px rgba(0,0,0,0.42), inset 0 0 0 1px rgba(255,255,255,0.07);
                    width: min(480px, calc(100vw - 48px));
                    max-width: calc(100vw - 48px);
                    max-height: min(720px, 76vh); overflow-y: auto; color: #eee; text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                    box-sizing: border-box; font-size: 14px; /* 切断宿主页面 font-size 继承，避免面板字体异常放大 */
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
                .pro-toast-container {
                    position: fixed; top: 20px; right: 20px; z-index: 2147483646;
                    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
                }
                .pro-toast {
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
                    padding: 24px; width: min(440px, 92vw);
                    max-height: min(80vh, 600px);
                    border: 1px solid rgba(255,255,255,0.15);
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                    display: flex; flex-direction: column;
                }
                .pro-confirm-title { font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 12px; flex: none; }
                .pro-confirm-body { font-size: 13px; color: #ccc; line-height: 1.6; margin-bottom: 20px; white-space: pre-line; word-break: break-all; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
                .pro-confirm-actions { display: flex; gap: 10px; justify-content: flex-end; flex: none; }
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
            // B15 修复：Toast 放入容器而非直接 append 到 shadowRoot，避免同坐标 fixed 叠放互相遮挡
            let container = this.shadowRoot.querySelector('.pro-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'pro-toast-container';
                this.shadowRoot.appendChild(container);
            }
            container.appendChild(toast);
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
            setTimeout(() => toast.remove(), TIMING.TOAST_DISMISS_MS);
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
                try { onConfirm && onConfirm(); } catch (e) { Log.error('确认回调异常:', e); }
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
                try { onClose && onClose(); } catch (e) { Log.error('预览关闭异常:', e); }
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
            if (ProtectedCheck.isProtected(node)) return false;
            if (node.style.display === 'none') return false;
            // 统一隐藏口径(5.2 节)：预览与正式拦截一致，避免预览看到的与实际不符
            BlockEngine.hideElement(node);
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
                const sel = ResourceSelectorBuilder.buildDomainAttr(d);
                try {
                    document.querySelectorAll(sel).forEach(el => this._previewHideResourceAndWrappers(el, store));
                } catch (e) { Log.warn(e.message || e); } // 选择器可能因特殊字符抛 SyntaxError
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
                    if (it.type === 'iframeBlock') {
                        // iframeBlock 规则走独立 API（须在 scope==='global' 分支前判断，因 iframeBlock 也标记为 global）
                        this.storage.addIframeRule(it.rule, true);
                    } else if (it.scope === 'global' || it.type === 'domainBlock') {
                        this.storage.addRule('domainBlock', { domain: it.rule.domain, type: 'domainBlock' });
                    } else if (it.scope === 'other') {
                        this.storage.addRuleForDomain(it.domain, it.type, it.rule);
                    } else {
                        this.storage.addRule(it.type, it.rule);
                    }
                });
                // iframe 规则变更后重新扫描（reapplyAll 不覆盖 iframe 扫描）
                if (items.some(it => it.type === 'iframeBlock')) {
                    try { IframeGuard.rescanAll(); } catch (e) { Log.warn(e.message || e); }
                }
                // 统一调用 reapplyAll(问题2)：与删除规则后重新应用逻辑保持一致，
                // 将来 reapplyAll 增加步骤（如覆盖层重扫）时撤销逻辑自动跟上
                BlockEngine.reapplyAll();
                this.showToast(entry.batch ? `已撤销批量删除（${items.length} 条）` : '已撤销删除', 'success');
            } catch (e) {
                Log.error('撤销失败:', e);
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
                if (typeof onRetry === 'function') { try { onRetry(); } catch (e) { Log.error('重试失败:', e); } }
            });
        }

        // 面板入口错误边界：包裹面板渲染逻辑，异常时显示错误面板而非崩溃
        // title 用于错误面板标题，retry 为重试回调（通常重新调用该面板入口）
        _safeCall(title, fn, retry) {
            // 重试回退与入口函数保持一致（FIX-GM-2 / 整洁架构 Ch.4 失败语义分级）：
            // 调用方通常省略 retry，则点击"重试"重新执行同一面板入口；显式传入则使用指定回退。
            const onRetry = (typeof retry === 'function') ? retry : fn;
            try {
                fn();
            } catch (e) {
                Log.error(title + '失败:', e);
                this._showErrorPanel(title + '失败', e && e.message ? e.message : String(e), onRetry);
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
            return SelectionPanel.call(this);
        }

        stopSelection() {
            this._untrackDocAll();
            this._keydownHandler = null;
            this._contextmenuHandler = null;
            if (this.highlightEl) {
                this.highlightEl.classList.remove('pro-blocker-highlight');
                this.highlightEl = null;
            }
            this._hideSelectionBanner();
            // 恢复导航能力：必须与 _freezeNavigation 配对，否则页面所有跳转永久失效
            this._unfreezeNavigation();
            // 清除 iframe 上下文
            this._selectionIframeContext = null;
        }

        // ── 集中式文档监听器追踪（TD-GM-08）──
        // 选择模式在 document 上批量注册拦截监听；退出时统一注销，避免残留监听导致
        // 面板内点击被拦截或内存泄漏。引用 Feathers《Working Effectively with Legacy Code》§3 接缝；
        // Fowler《重构》§12.2 消除重复
        _trackDoc(type, handler, opts) {
            document.addEventListener(type, handler, opts);
            (this._docListeners || (this._docListeners = [])).push({ type, handler, opts });
        }
        _untrackDocAll() {
            if (!this._docListeners) return;
            this._docListeners.forEach(({ type, handler, opts }) => {
                try { document.removeEventListener(type, handler, opts); } catch (e) { Log.warn(e.message || e); }
            });
            this._docListeners = [];
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
            this._origFormSubmit = HTMLFormElement.prototype.submit;

            window.open = (...args) => {
                Log.warn('拦截window.open:', args[0]);
                return null;
            };
            try {
                const desc = this._origLocationHrefDesc;
                if (desc && desc.set) {
                    Object.defineProperty(Location.prototype, 'href', {
                        get: desc.get,
                        set: (val) => {
                            Log.warn('拦截location.href:', val);
                        },
                        configurable: true
                    });
                }
            } catch (e) { Log.warn(e.message || e); }
            Location.prototype.assign = function (url) {
                Log.warn('拦截location.assign:', url);
            };
            Location.prototype.replace = function (url) {
                Log.warn('拦截location.replace:', url);
            };
            HTMLFormElement.prototype.submit = function () {
                Log.warn('拦截form.submit');
            };
            // pushState/replaceState 不再重复劫持，改用标志位让 startObserver 的 wrapper 主动让路(BUG-S1)
            // 这样退出选择模式后无需恢复，SPA 路由监听 wrapper 始终在位、永久生效
            BlockEngine._selectionNavLocked = true;
        }

        // 解除导航冻结：恢复所有被 _freezeNavigation 劫持的原始函数
        _unfreezeNavigation() {
            if (!this._navFrozen) return;
            this._navFrozen = false;
            if (this._origWindowOpen) window.open = this._origWindowOpen;
            if (this._origLocationHrefDesc) {
                try {
                    Object.defineProperty(Location.prototype, 'href', this._origLocationHrefDesc);
                } catch (e) { Log.warn(e.message || e); }
            }
            if (this._origAssign) Location.prototype.assign = this._origAssign;
            if (this._origReplace) Location.prototype.replace = this._origReplace;
            if (this._origFormSubmit) HTMLFormElement.prototype.submit = this._origFormSubmit;
            BlockEngine._selectionNavLocked = false;
        }

        _handleMouseOver(e) {
            if (!e.target || !e.target.closest) return;
            // 统一调用 isProtectedElement：覆盖 shadowRoot 内部子元素，防止选中面板自身
            if (ProtectedCheck.isProtected(e.target)) return;
            // 排除 body/html：透明覆盖层覆盖全页时 mouseover target 可能是 body/html，
            // 高亮整个页面会导致用户无法选择具体广告元素
            if (e.target === document.body || e.target === document.documentElement) return;
            // 大面积元素智能递归降级(BUG-L1)：广告脚本可能清空 body 后重建一个超大容器，
            // 此时选中整页容器无意义。递归向下查找更具体的子元素，最多 5 层，
            // 只要子元素仍占满 90% 视口就继续向下，直到找到非全覆盖的元素
            const vw = window.innerWidth, vh = window.innerHeight;
            let target = e.target;
            for (let depth = 0; depth < 5; depth++) {
                const r = target.getBoundingClientRect();
                if (r.width <= vw * 0.9 || r.height <= vh * 0.9) break;
                const child = target.querySelector('div, section, aside, article, iframe, img, a');
                if (!child || ProtectedCheck.isProtected(child)) break;
                target = child;
            }
            if (target !== e.target) {
                if (this.highlightEl) this.highlightEl.classList.remove('pro-blocker-highlight');
                this.highlightEl = target;
                this.highlightEl.classList.add('pro-blocker-highlight');
                return;
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
            if (!target || !target.closest || ProtectedCheck.isProtected(target)) return;
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
            if (!target || !target.closest || ProtectedCheck.isProtected(target)) return;
            if (target === document.body || target === document.documentElement) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
            this.stopSelection();
            // 元素有效性校验(BUG-2)：stopSelection 触发导航解冻瞬间，广告脚本可能移除目标元素，
            // 此时 showActionPanel 会绑定失效引用导致后续操作报错，与 _handleClick 校验口径保持一致
            if (!this._isElementInDOM(target)) {
                this.showToast('目标元素已失效，请重新选择。', 'warning');
                return;
            }
            this.showActionPanel(target);
        }

        // 阻止 touchstart 默认行为，防止广告通过 touch 事件直接触发跳转（移动端）
        _handleTouchStart(e) {
            if (!e.target || !e.target.closest || ProtectedCheck.isProtected(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // pointerdown 是最早的人机交互事件，先于 mousedown/touchstart/click 触发
        // 在 capture 阶段拦截，确保广告 ontouchstart="this.click();" / onclick 无法执行
        _handlePointerDown(e) {
            if (!e.target || !e.target.closest || ProtectedCheck.isProtected(e.target)) return;
            // 必须先 stop 掉广告可能的 ontouchstart / onclick
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // mousedown 作为兜底：有些环境 pointerdown 不触发（如纯鼠标点击）
        _handleMouseDown(e) {
            if (!e.target || !e.target.closest || ProtectedCheck.isProtected(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        // 拦截中键/右键辅助点击：广告 <a target="_blank"> 中键点击会绕过 click 监听直接打开新标签
        _handleAuxClick(e) {
            if (!e.target || !e.target.closest || ProtectedCheck.isProtected(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation && e.stopImmediatePropagation();
        }

        _handleClick(e) {
            if (!e.target || !e.target.closest || ProtectedCheck.isProtected(e.target)) return;
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

            // 优化方案 §6.1 面板1：检测选中元素是否在 iframe 内，若是同域 iframe 则进入选择模式
            const targetIframe = e.target.closest('iframe');
            if (targetIframe) {
                try {
                    const iframeDoc = targetIframe.contentDocument;
                    const iframeSrc = targetIframe.src || '';
                    // 同源检查：iframe 可访问且域名相同
                    if (iframeDoc && iframeSrc) {
                        const iframeHost = new URL(iframeSrc).hostname;
                        if (iframeHost === window.location.hostname ||
                            iframeHost.endsWith('.' + window.location.hostname) ||
                            window.location.hostname.endsWith('.' + iframeHost)) {
                            // 进入 iframe 上下文
                            this._selectionIframeContext = {
                                iframe: targetIframe,
                                doc: iframeDoc,
                                win: targetIframe.contentWindow
                            };
                            this.showToast(`已进入 iframe: ${iframeHost}`, 'info');
                            // 重新绑定事件到 iframe 文档
                            const registerOnDoc = (doc) => {
                                doc.addEventListener('pointerdown', this._handlePointerDown, { capture: true, passive: false });
                                doc.addEventListener('mousedown', this._handleMouseDown, { capture: true, passive: false });
                                doc.addEventListener('mouseover', this._handleMouseOver, { capture: true });
                                doc.addEventListener('click', this._handleClick, { capture: true, passive: false });
                                doc.addEventListener('contextmenu', this._contextmenuHandler, { capture: true });
                                doc.addEventListener('touchstart', this._handleTouchStart, { capture: true, passive: false });
                                doc.addEventListener('touchmove', this._handleTouchMove, { capture: true, passive: false });
                                doc.addEventListener('touchend', this._handleTouchEnd, { capture: true, passive: false });
                                doc.addEventListener('auxclick', this._handleAuxClick, { capture: true });
                            };
                            registerOnDoc(iframeDoc);
                            return;
                        }
                    }
                } catch (ex) { Log.warn(ex.message || ex); }
            }

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
            // 如果在 iframe 上下文中，检查元素是否在该 iframe 的 document 中
            if (this._selectionIframeContext) {
                return el && this._selectionIframeContext.doc.contains(el);
            }
            return el && document.contains(el);
        }

        _applySelectionHighlight(element) {
            this._clearSelectionHighlight();
            this.currentSelectedEl = element;
            element.classList.add('pro-blocker-selected');
            try { element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { Log.warn(e.message || e); }
        }

        _resetActionPreview(panel) {
            if (!this._actionPreview.active) return;
            // 新版预览隐藏「所选域名命中的全部元素 + 当前广告容器」，需逐个还原
            // 统一使用 BlockEngine.showElement：还原 hideElement 设置的全部 4 个属性(display/opacity/visibility/pointer-events)
            // 否则 visibility/pointer-events 残留会导致元素永久不可见(BUG-1)
            if (Array.isArray(this._actionPreview.elements) && this._actionPreview.elements.length) {
                this._actionPreview.elements.forEach(el => BlockEngine.showElement(el));
            }
            this._actionPreview = { active: false, elements: [] };
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
            // 2) 路径模式：与封杀时自动提取的 pathCandidates 同口径(BUG-A3 + 冗余-7)
            // 统一调用 BlockEngine.extractPathCandidates，消除重复代码
            const result = BlockEngine.extractResourceDomains(el, { deep: true });
            const pathCandidates = BlockEngine.extractPathCandidates(result);
            pathCandidates.forEach(p => {
                const sel = ResourceSelectorBuilder.buildPathAttr(p);
                try {
                    document.querySelectorAll(sel).forEach(target => this._previewHideResourceAndWrappers(target, store));
                } catch (e) { Log.warn(e.message || e); }
            });
            // 3) 当前框选的广告容器（正式封杀也会手动隐藏容器）
            this._previewHideNode(BlockEngine.findSingleChildWrapper(el, 4), store);
        }

        // 实时更新预览：域名选择变化时，先还原已隐藏元素，再基于当前选择重新应用（Bug2）
        _updateActionPreview() {
            if (!this._actionPreview.active) return;
            // 还原当前预览隐藏的元素（保留 active=true）
            // 统一使用 BlockEngine.showElement：还原 hideElement 设置的全部 4 个属性(BUG-1)
            if (Array.isArray(this._actionPreview.elements) && this._actionPreview.elements.length) {
                this._actionPreview.elements.forEach(el => BlockEngine.showElement(el));
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
            this._actionPreview = { active: false, elements: [] };
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
                this.storage.addRule('static', { selector: sel, type: 'static' });
                this.clearPanel();
            });

            // 动态类名拦截
            panel.querySelector('#btn-dynamic').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const primaryClass = (el.className || '').split(/\s+/)[0];
                if (!primaryClass) { this.showToast('当前元素无有效类名，请选择其他拦截方式。', 'warning'); return; }
                this.storage.addRule('dynamic', { className: primaryClass, type: 'dynamic' });
                this.clearPanel();
            });

            // 物理结构拦截：基于元素位置路径生成选择器，作为 Selector 失效时的兜底定位
            panel.querySelector('#btn-struct').addEventListener('click', () => {
                const el = this.currentSelectedEl;
                const sel = BlockEngine.generateStructuralSelector(el);
                this.storage.addRule('structural', { structSelector: sel, type: 'structural' });
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
                    // 防御：confirm 是异步弹窗，期间用户可能通过 ESC/其他操作触发 clearPanel() 导致 panel 已从 DOM 移除(BUG-S4)
                    if (!panel.isConnected) return;
                    // 封杀前先还原预览隐藏的元素，避免预览状态残留与正式封杀叠加
                    this._resetActionPreview(panel);

                    // 自动提取路径模式(BUG-A3 + 冗余-7)：统一调用 BlockEngine.extractPathCandidates
                    // 冗余-6：循环内 addRule 用 skipApply=true 跳过，由后续 DomainBlockExecutor.execute
                    //         内部的 applyCSSRules 统一重建（会同时应用 pathPattern + domainBlock），无需此处再调一次
                    const pathCandidates = BlockEngine.extractPathCandidates(result);
                    pathCandidates.forEach(p => {
                        this.storage.addRule('pathPattern', { pattern: p, type: 'pathPattern' }, true);
                    });

                    // 立即隐藏当前框选的整个广告容器（向上找单子链容器）
                    const container = BlockEngine.findSingleChildWrapper(this.currentSelectedEl, 4);
                    BlockEngine.hideElement(container);

                    // 封杀选中域名：添加 domainBlock 规则 + 即时隐藏匹配资源（full 口径）
                    // 口径与 applyCSSRules + scanAndBlockDynamic 一致，确保即时效果=预览=刷新后效果
                    // 内部 addRule 用 skipApply=true + 末尾单次 applyCSSRules，pathPattern 规则也一并应用
                    DomainBlockExecutor.execute(list, { hideMode: 'full' });

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
                const previewBtn = e.currentTarget; // 用 currentTarget 而非 e.target(BUG-L2)
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
                this._actionPreview = { active: true, elements: [] };
                this._applyActionPreviewHiding();
                // 显示预览横幅，关闭时还原
                this._showPreviewBanner(() => this._resetActionPreview(panel));
                previewBtn.textContent = '👁 恢复显示';
            });

            panel.querySelector('#btn-cancel').addEventListener('click', () => {
                this.clearPanel();
            });

            this._applySelectionHighlight(element);
            this._refreshSelectionInfo(panel);
        }

        showGlobalDomainPanel() {
            return GlobalDomainPanel.call(this);
        }

        showRegexPanel() {
            return RegexPanel.call(this);
        }

        // 规则影响度评估：统计每条规则在当前页面命中的元素数，命中越多越疑似误杀
        // 仅评估本站规则 + 全局域名黑名单（其他站点规则不在当前页生效，评估无意义）
        // regex 规则用 TreeWalker 采样前 500 个文本节点，避免全页遍历开销过大
        evaluateRuleImpact() {
            const data = this.storage.getData();
            const impacts = []; // {type, index, score, count}

            // 1. static 规则：直接 querySelectorAll 计数
            (data.static || []).forEach((r, i) => {
                if (r._disabled || !r.selector) return;
                const count = this._countMatches(r.selector);

                impacts.push({ type: 'static', index: i, count, score: this._calcImpactScore(count) });
            });

            // 2. dynamic 规则：取首个类名 token 转属性选择器计数
            (data.dynamic || []).forEach((r, i) => {
                if (r._disabled || !r.className) return;
                const token = r.className.split(/\s+/).filter(Boolean)[0];
                if (!token) return;
                const count = this._countMatches(`[class*="${token}"]`);
                impacts.push({ type: 'dynamic', index: i, count, score: this._calcImpactScore(count) });
            });

            // 3. attribute 规则：直接使用 attrSelector 计数
            (data.attribute || []).forEach((r, i) => {
                if (r._disabled || !r.attrSelector) return;
                const count = this._countMatches(r.attrSelector);
                impacts.push({ type: 'attribute', index: i, count, score: this._calcImpactScore(count) });
            });

            // 4. regex 规则：TreeWalker 采样前 500 个文本节点
            //    contains 模式用 String.includes()，其余用 RegExp
            //    ReDoS 预检(BUG-A4)：非 contains 模式必须通过 isRegexSafe，否则嵌套量词(如 (a+)+)
            //    会在 500 节点上 test() → ReDoS 卡死页面
            (data.regex || []).forEach((r, i) => {
                if (r._disabled || !r.regex) return;
                let count = 0;
                try {
                    const isContains = r.mode === 'contains';
                    if (!isContains && !BlockEngine.isRegexSafe(r.regex)) return;
                    const regex = isContains ? null : new RegExp(r.regex, 'i');
                    const lowerText = isContains ? r.regex.toLowerCase() : null;
                    let checked = 0;
                    BlockEngine.walkTextNodes(document.body, (node) => {
                        if (checked >= 500) return false;
                        checked++;
                        const content = node.textContent || '';
                        if (isContains ? content.toLowerCase().includes(lowerText) : regex.test(content)) count++;
                    });
                } catch (e) { Log.warn(e.message || e); }
                impacts.push({ type: 'regex', index: i, count, score: this._calcImpactScore(count) });
            });

            // 5. domainBlock 规则：按 6 通道属性选择器匹配计数（与 applyCSSRules 一致）
            (data.domainBlock || []).forEach((r, i) => {
                if (r._disabled || !r.domain) return;
                const count = this._countMatches(ResourceSelectorBuilder.buildDomainAttr(r.domain));
                impacts.push({ type: 'domainBlock', index: i, count, score: this._calcImpactScore(count) });
            });

            // 6. pathPattern 规则：按 3 通道属性选择器匹配计数（与 applyCSSRules 一致）
            (data.pathPattern || []).forEach((r, i) => {
                if (r._disabled || !r.pattern) return;
                const count = this._countMatches(ResourceSelectorBuilder.buildPathAttr(r.pattern));
                impacts.push({ type: 'pathPattern', index: i, count, score: this._calcImpactScore(count) });
            });

            // structural / complex 规则不评估：structural 选择器含 :nth-of-type 路径，
            // complex 无单一选择器，评估成本高且命中数参考价值低
            impacts.sort((a, b) => b.score - a.score);
            return impacts;
        }

        // 统一 querySelectorAll 计数：失败时返回 0
        _countMatches(selector) {
            let count = 0;
            try { count = document.querySelectorAll(selector).length; } catch (e) { Log.warn(e.message || e); }
            return count;
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

        // ═══════════════════════════════════════════════════════════
        // iframe 防线独立面板：统计看板 + 扫描检测 + 白名单管理 + 规则添加 + 扫描深度
        // 风格对齐 showOverlayScanPanel（毛玻璃 + 可拖动 + gd-* 样式）
        // ═══════════════════════════════════════════════════════════
        showIframePanel() {
            return IframePanel.call(this);
        }



        // 统一规则管理面板：合并「规则与防御管理」与「按网站查看所有规则」为单一透明玻璃面板（问题3）
        // 全局域名黑名单 + 本站规则 + 其他站点规则统一汇总，按最近过滤时间 _ts 倒序置顶，便于快速删除
        showManager() {
            return ManagerPanel.call(this);
        }

        showExportPanel() {
            return ExportPanel.call(this);
        }

        generateAdGuardRules() {
            const raw = JSON.parse(this.storage.exportAll() || '{}');
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
                        if (Array.isArray(arr) && arr.length) {
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
            // BUG-A11 修复：旧版 replace(/\//g, '\\/') 会把用户已转义的 \/ 二次转义为 \\/，
            // 在 AdGuard :has-text(/.../) 中语义被破坏（反斜杠+结束定界符）。
            // 用 (\\*)\/ 捕获连续反斜杠：奇数=已转义保留，偶数=未转义补 \/
            // 正确处理 a/b→a\/b、a\/b→a\/b、a\\/b→a\\\/b、a\\\/b→a\\\/b
            const escapeAdGuardRegex = (r) => String(r).replace(/[\r\n]+/g, '').replace(/(\\*)\//g, (m, bs) => bs.length % 2 === 1 ? m : bs + '\\/');
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
                        // contains 模式存储原始文本，导出为字面量 has-text(BUG-M7)
                        if (rule.mode === 'contains') {
                            return `${domain}#?#*:has-text("${escapeCssValue(rule.regex)}")`;
                        }
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
                        let hasPositiveCondition = false; // 是否存在正向条件(contains/equals)，用于过滤纯 not_contains 规则(BUG-S5)
                        rule.conditions.forEach(c => {
                            if (c.type === 'class') {
                                if (c.operator === 'contains' || c.operator === 'equals') { simpleParts.push(`[class*="${escapeCssValue(c.value)}"]`); hasPositiveCondition = true; }
                                if (c.operator === 'not_contains') pseudoParts.push(`:not([class*="${escapeCssValue(c.value)}"])`);
                            } else if (c.type === 'id') {
                                if (c.operator === 'equals') { simpleParts.push(`[id="${escapeCssValue(c.value)}"]`); hasPositiveCondition = true; }
                                else if (c.operator === 'contains') { simpleParts.push(`[id*="${escapeCssValue(c.value)}"]`); hasPositiveCondition = true; }
                                else if (c.operator === 'not_contains') pseudoParts.push(`:not([id*="${escapeCssValue(c.value)}"])`);
                            } else if (c.type === 'text') {
                                if (c.operator === 'contains') { pseudoParts.push(`:has-text("${escapeCssValue(c.value)}")`); hasPositiveCondition = true; }
                                if (c.operator === 'equals') { pseudoParts.push(`:has-text(/^\\s*${escapeRegexLiteral(c.value)}\\s*$/)`); hasPositiveCondition = true; }
                                if (c.operator === 'not_contains') pseudoParts.push(`:not(:has-text("${escapeCssValue(c.value)}"))`);
                            }
                        });
                        if (andMode) {
                            // 纯 not_contains 条件无法限定范围：*:not(:has-text(...)) 会隐藏页面几乎所有元素(BUG-S5)
                            if (!hasPositiveCondition) return null;
                            if (!pseudoParts.length && !simpleParts.length) return null;
                            const base = simpleParts.length ? `*${simpleParts.join('')}` : '*';
                            const marker = pseudoParts.length > 0 ? '#?#' : '##';
                            return `${domain}${marker}${base}${pseudoParts.join('')}`;
                        } else {
                            // OR 模式：not_contains 单独成行会匹配几乎所有元素，跳过 not_contains 条件(BUG-S5)
                            return rule.conditions.filter(c => c.operator !== 'not_contains').map(c => {
                                if (c.type === 'class') {
                                    if (c.operator === 'contains') return `${domain}##*[class*="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'equals') return `${domain}##[class*="${escapeCssValue(c.value)}"]`;
                                } else if (c.type === 'id') {
                                    if (c.operator === 'equals') return `${domain}##[id="${escapeCssValue(c.value)}"]`;
                                    if (c.operator === 'contains') return `${domain}##[id*="${escapeCssValue(c.value)}"]`;
                                } else if (c.type === 'text') {
                                    if (c.operator === 'contains') return `${domain}#?#*:has-text("${escapeCssValue(c.value)}")`;
                                    if (c.operator === 'equals') return `${domain}#?#*:has-text(/^\\s*${escapeRegexLiteral(c.value)}\\s*$/)`;
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

            // ─── iframe 规则转换（§8.8 映射表） ───
            const iframeRules = Array.isArray(raw.iframeRules) ? raw.iframeRules : [];
            if (iframeRules.length > 0) {
                lines.push('! iframe 拦截规则');
                iframeRules.forEach(r => {
                    if (!r || !r.matchType) return;
                    if (r.matchType === 'srcDomain' && r.value) {
                        // ||domain^$subdocument,third-party
                        lines.push(`||${r.value}^$subdocument,third-party`);
                    } else if (r.matchType === 'geometry' && r.value) {
                        // 几何条件无法直接转 AdGuard，导出为注释说明
                        lines.push(`! [iframe geometry] ${r.value}（AdGuard 不支持几何规则，需手动添加元素隐藏规则）`);
                    } else if (r.matchType === 'srcdocKeyword' && r.value) {
                        // AdGuard 不支持 srcdoc 匹配，导出为注释
                        lines.push(`! [iframe srcdoc keyword] "${r.value}"（AdGuard 不支持 srcdoc 匹配）`);
                    }
                });
                lines.push('');
            }

            return lines.join('\n');
        }

        showAdGuardExportPanel() {
            return AdGuardExportPanel.call(this);
        }

        /**
         * 不可见覆盖层广告扫描面板：列出所有透明/隐藏的可跳转 overlay，支持逐项拦截与批量拦截
         * 解决"触碰到就跳转但看不见"的广告问题
         */
        showOverlayScanPanel() {
            return OverlayScanPanel.call(this);
        }


        showImportPanel() {
            return ImportPanel.call(this);
        }

        clearPanel() {
            if (this._actionPreview && this._actionPreview.active) {
                // 还原域名预览隐藏的全部元素（新版预览可能隐藏多个容器）
                if (Array.isArray(this._actionPreview.elements)) {
                    this._actionPreview.elements.forEach(el => BlockEngine.showElement(el));
                }
                this._actionPreview = { active: false, elements: [] };
            }
            if (this._previewAffectedElements && this._previewAffectedElements.length > 0) {
                this._previewAffectedElements.forEach(item => BlockEngine.showElement(item.el));
                this._previewAffectedElements = [];
            }
            // 全局域名面板预览：跨面板切换时恢复被预览隐藏的元素，修复局部变量无法清理的泄漏
            if (this._globalPreview && this._globalPreview.active) {
                this._globalPreview.elements.forEach(el => BlockEngine.showElement(el));
                this._globalPreview = { active: false, elements: [] };
            }
            // 覆盖层扫描面板预览：还原 visibility/pointer-events/display/opacity，避免预览元素残留
            if (this._overlayPreview && this._overlayPreview.active) {
                this._overlayPreview.elements.forEach(el => BlockEngine.showElement(el));
                this._overlayPreview = { active: false, elements: [] };
            }
            // iframe 防线面板预览：跨面板切换时恢复被预览隐藏的元素
            if (this._iframePreview && this._iframePreview.active) {
                this._iframePreview.elements.forEach(el => BlockEngine.showElement(el));
                this._iframePreview = { active: false, elements: [] };
            }
            // 切换/关闭面板时停止选择模式，避免 _handleClick 残留导致 panel 内点击被拦截
            this.stopSelection();
            this._clearSelectionHighlight();
            // 清理预览模式横幅（若激活）
            this._hidePreviewBanner();
            // B7 修复：iframe EventBus 退订
            if (this._iframeUnsubs) {
                this._iframeUnsubs.forEach(u => { try { u(); } catch (e) { Log.warn(e.message || e); } });
                this._iframeUnsubs = null;
            }

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
    // ================= iframe 防线模块（v2.0 动态 iframe 广告拦截） =================
    // 依据《动态 iframe 广告拦截完整重构方案 v2.0》实现：
    //   FrameDetector · EventBus · ContentClassifier · FrameMessenger · MessageGuard · IframeGuard
    // 设计原则：正文保护铁律（§2.1）+ 帧内自治 + 顶层仲裁双层决策（§1.2③）
    // 模块依赖：FrameDetector（帧发现）→ IframeGuard（分类决策）

    // ─── EventBus：模块解耦核心（§11.2 事件清单） ───
    // 同层模块通过事件通信，下层不引用上层，避免循环依赖
    const EventBus = {
        _handlers: new Map(),
        on(event, handler) {
            if (!this._handlers.has(event)) this._handlers.set(event, new Set());
            this._handlers.get(event).add(handler);
            return () => { this._handlers.get(event) && this._handlers.get(event).delete(handler); };
        },
        off(event, handler) {
            const handlers = this._handlers.get(event);
            if (handlers) handlers.delete(handler);
        },
        emit(event, data) {
            const handlers = this._handlers.get(event);
            if (handlers) handlers.forEach(h => { try { h(data); } catch (e) { Log.warn(e.message || e); } });
        }
    };

    // ─── FrameDetector：iframe 发现与同域判定（§4.1 FrameDetect） ───
    // 职责：监听 iframe 创建/插入、URL 解析、同域判断、事件分发
    // 依赖：无（底层模块）
    // 事件：frame:new · frame:sameOrigin · frame:differentOrigin
    const FrameDetector = {
        _observer: null,
        _interactionTime: 0,
        _init: false,

        // PENDING-GM-01 配套：单层 iframe 枚举，DOM 查询下沉（DIP）
        // 供 IframeGuard._liveFrames 复用，避免 IframeGuard 直接触碰 document
        queryIframes(root) {
            try { return Array.from(root.querySelectorAll('iframe')); }
            catch (e) { Log.warn(e.message || e); return []; }
        },

        init() {
            if (this._init) return;
            this._init = true;
            this._hookCreateElement();
            this._startObserver();
            this._trackInteractions();
        },

        // §7.1 创建时拦截：Hook document.createElement
        _hookCreateElement() {
            const orig = document.createElement;
            const self = this;
            const hooked = function (tagName) {
                const el = orig.apply(this, arguments);
                if (typeof tagName === 'string' && tagName.toLowerCase() === 'iframe') {
                    // 延迟检测：src 可能在此之后才设置
                    self._observeIframeSrc(el);
                }
                return el;
            };
            if (!document.createElement.__proBlockerHooked) {
                document.createElement = hooked;
                document.createElement.__proBlockerHooked = true;
            }
        },

        // 监听 iframe src/srcdoc 设置：属性变更后触发 frame:new 事件
        _observeIframeSrc(iframe) {
            if (iframe.__proBlockerIframeObserved) return;
            iframe.__proBlockerIframeObserved = true;
            const self = this;
            try {
                let cleanupTimer = null;
                const obs = new MutationObserver(() => {
                    if (iframe.src || iframe.srcdoc) {
                        self._emitFrameEvent(iframe);
                        obs.disconnect();
                        // FIX-A (Brooks R6): src 已就绪则取消兜底定时器，避免 30s 空转
                        if (cleanupTimer) clearTimeout(cleanupTimer);
                    }
                });
                obs.observe(iframe, { attributes: true, attributeFilter: ['src', 'srcdoc'] });
                // 超时兜底——iframe 创建后 30s 未设 src 则断开 observer，防止 GC 泄漏
                cleanupTimer = setTimeout(() => { try { obs.disconnect(); } catch (e) { Log.warn(e.message || e); } }, TIMING.OBSERVER_TIMEOUT_MS);
            } catch (e) { Log.warn(e.message || e); }
        },

        // MutationObserver 监听 DOM 中新增 iframe
        _startObserver() {
            this._observer = new MutationObserver(mutations => {
                for (let i = 0; i < mutations.length; i++) {
                    const added = mutations[i].addedNodes;
                    for (let j = 0; j < added.length; j++) {
                        const node = added[j];
                        if (node.nodeType !== 1) continue;
                        if (node.tagName === 'IFRAME') {
                            this._emitFrameEvent(node);
                        } else if (node.querySelectorAll) {
                            try {
                                node.querySelectorAll('iframe').forEach(f => this._emitFrameEvent(f));
                            } catch (e) { Log.warn(e.message || e); }
                        }
                    }
                }
            });
            this._observer.observe(document.documentElement, { childList: true, subtree: true });
        },

        // 记录用户交互时间，用于「创建时机在用户交互后 300ms 内」评分
        _trackInteractions() {
            // FIX-B (Brooks R6): 幂等保护——init() 无守卫时重复调用会叠加 4 个 document 监听器
            if (this._interactionsTracked) return;
            this._interactionsTracked = true;
            const record = () => { this._interactionTime = Date.now(); };
            ['click', 'mousedown', 'touchstart', 'keydown'].forEach(evt => {
                document.addEventListener(evt, record, { capture: true, passive: true });
            });
        },

        // 统一触发 frame 事件并分发
        _emitFrameEvent(iframe) {
            if (!iframe || iframe.nodeType !== 1) return;
            const src = iframe.src || '';
            const sameOrigin = this._isSameOrigin(iframe);
            EventBus.emit('frame:new', { iframe, src, sameOrigin, interactionTime: this._interactionTime });
            if (sameOrigin) {
                EventBus.emit('frame:sameOrigin', { iframe, src });
            } else {
                EventBus.emit('frame:differentOrigin', { iframe, src });
            }
        },

        // 同域判断：try-catch 是最可靠的运行时方式
        _isSameOrigin(iframe) {
            try {
                const src = iframe.src || '';
                if (!src || src === 'about:blank') return true;
                const iframeURL = new URL(src, window.location.href);
                return iframeURL.origin === window.location.origin;
            } catch (e) {
                return false;
            }
        },

        // 获取用户最近交互时间
        getInteractionTime() { return this._interactionTime; },

        // 首次全量扫描已有 iframe
        scanAll() {
            try {
                document.querySelectorAll('iframe').forEach(f => this._emitFrameEvent(f));
            } catch (e) { Log.warn(e.message || e); }
        },

        destroy() {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
        }
    };

    // ─── ContentClassifier：内容/广告分类评分（§2.3 评分体系） ───
    // 纯函数模块，不持有状态，供 IframeGuard 与子帧自治上报复用
    // 判定公式：正文分>60 → 内容帧；广告分>70 且 正文分<20 → 纯广告帧；其余 → 未知
    const ContentClassifier = {
        // 计算正文分：越高越像正文
        // B1 修复：支持 frozen 参数——跳过 getBoundingClientRect/getComputedStyle 实时测量，使用首次冻结值
        computeContentScore(doc, iframe, frozen) {
            let score = 0;
            const reasons = [];
            if (!doc) return { score, reasons };
            // iframe 内文本节点总长 > 200 字符: +40
            try {
                const text = doc.body ? (doc.body.innerText || '') : '';
                if (text.length > 200) { score += 40; reasons.push('text>200'); }
            } catch (e) { Log.warn(e.message || e); }
            // 含语义标签 article/p/h1~h6/main: +25
            try {
                if (doc.querySelector && doc.querySelector('article,p,h1,h2,h3,h4,h5,h6,main')) {
                    score += 25; reasons.push('semantic');
                }
            } catch (e) { Log.warn(e.message || e); }
            // iframe src 与当前页同主域: +15
            if (iframe && iframe.src) {
                try {
                    const iframeHost = new URL(iframe.src).hostname;
                    const topHost = window.location.hostname;
                    if (iframeHost === topHost ||
                        iframeHost.endsWith('.' + topHost) ||
                        topHost.endsWith('.' + iframeHost)) {
                        score += 15; reasons.push('same-origin-domain');
                    }
                } catch (e) { Log.warn(e.message || e); }
            }
            // iframe 面积占视口 30%~90%: +10（B1：使用冻结值）
            if (iframe) {
                try {
                    const rect = frozen ? { width: frozen.w, height: frozen.h } : iframe.getBoundingClientRect();
                    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
                    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                    if (vw > 0 && vh > 0) {
                        const ratio = (rect.width * rect.height) / (vw * vh);
                        if (ratio >= 0.3 && ratio <= 0.9) { score += 10; reasons.push('area 30-90%'); }
                    }
                } catch (e) { Log.warn(e.message || e); }
            }
            // iframe 有 id 或 name 含 content/main/article/body: +10
            if (iframe) {
                const idName = ((iframe.id || '') + ' ' + (iframe.name || '')).toLowerCase();
                if (/content|main|article|body/.test(idName)) { score += 10; reasons.push('content-id'); }
            }
            // iframe 完全透明 (opacity < 0.05): -20（B1：使用冻结值）
            if (iframe) {
                try {
                    const opacity = frozen ? frozen.opacity : parseFloat(window.getComputedStyle(iframe).opacity);
                    if (opacity < 0.05) { score -= 20; reasons.push('transparent'); }
                } catch (e) { Log.warn(e.message || e); }
            }
            // position:fixed 且覆盖 > 70% 视口: -30（B1：使用冻结值）
            if (iframe) {
                try {
                    const pos = frozen ? frozen.position : window.getComputedStyle(iframe).position;
                    if (pos === 'fixed') {
                        const rect = frozen ? { width: frozen.w, height: frozen.h } : iframe.getBoundingClientRect();
                        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
                        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                        if (vw > 0 && vh > 0) {
                            const ratio = (rect.width * rect.height) / (vw * vh);
                            if (ratio > 0.7) { score -= 30; reasons.push('fixed overlay'); }
                        }
                    }
                } catch (e) { Log.warn(e.message || e); }
            }
            // iframe src 域名在广告黑名单: -25
            if (iframe && iframe.src) {
                try {
                    const host = new URL(iframe.src).hostname;
                    if (host !== window.location.hostname && BlockEngine.hostnameBlocked(host, BlockEngine.getDomainSet())) {
                        score -= 25; reasons.push('src in blacklist');
                    }
                } catch (e) { Log.warn(e.message || e); }
            }
            return { score, reasons };
        },
        // 计算广告分：越高越像广告
        // B1 修复：支持 frozen 参数——跳过 getComputedStyle/getBoundingClientRect 实时测量
        computeAdScore(iframe, doc, contentScore, frozen) {
            let score = 0;
            const reasons = [];
            if (!iframe) return { score, reasons };
            // src 域名命中全局黑名单: +35
            if (iframe.src) {
                try {
                    const host = new URL(iframe.src).hostname;
                    if (host !== window.location.hostname && BlockEngine.hostnameBlocked(host, BlockEngine.getDomainSet())) {
                        score += 35; reasons.push('src blacklisted');
                    }
                } catch (e) { Log.warn(e.message || e); }
            }
            // src 域名含广告关键词: +25
            if (iframe.src) {
                try {
                    const host = new URL(iframe.src).hostname;
                    if (isAdKeywordHost(host)) { score += 25; reasons.push('ad keyword host'); }
                } catch (e) { Log.warn(e.message || e); }
            }
            // 透明/隐藏但仍可点击: +25（B1：使用冻结值）
            try {
                const opacity = frozen ? frozen.opacity : parseFloat(window.getComputedStyle(iframe).opacity);
                const visibility = frozen ? (frozen.opacity < 0.1 ? 'hidden' : 'visible') : window.getComputedStyle(iframe).visibility;
                const pointerEvents = frozen ? (frozen.opacity < 0.1 ? 'auto' : 'none') : window.getComputedStyle(iframe).pointerEvents;
                if ((opacity < 0.1 || visibility === 'hidden') && pointerEvents !== 'none') {
                    score += 25; reasons.push('hidden but clickable');
                }
            } catch (e) { Log.warn(e.message || e); }
            // position:fixed/absolute + z-index > 999: +20（B1：使用冻结值）
            try {
                const pos = frozen ? frozen.position : window.getComputedStyle(iframe).position;
                const zi = frozen ? frozen.zi : parseInt(window.getComputedStyle(iframe).zIndex, 10);
                if ((pos === 'fixed' || pos === 'absolute') && zi > 999) {
                    score += 20; reasons.push('fixed/abs z>999');
                }
            } catch (e) { Log.warn(e.message || e); }
            // 面积 > 视口 60% 且无实质文本: +15（B1：使用冻结值）
            try {
                const rect = frozen ? { width: frozen.w, height: frozen.h } : iframe.getBoundingClientRect();
                const vw = window.innerWidth || document.documentElement.clientWidth || 0;
                const vh = window.innerHeight || document.documentElement.clientHeight || 0;
                if (vw > 0 && vh > 0) {
                    const ratio = (rect.width * rect.height) / (vw * vh);
                    const textLen = doc && doc.body ? (doc.body.innerText || '').length : 0;
                    if (ratio > 0.6 && textLen < 50) { score += 15; reasons.push('large area no text'); }
                }
            } catch (e) { Log.warn(e.message || e); }
            // 创建时机在用户交互后 300ms 内: +15（FrameDetector 记录交互时间）
            if (FrameDetector._interactionTime && Date.now() - FrameDetector._interactionTime < 300) {
                score += 15; reasons.push('post-interaction');
            }
            // srcdoc 内含广告关键词: +10
            if (iframe.srcdoc) {
                const lower = iframe.srcdoc.toLowerCase();
                for (const kw of AD_TOKENS_UNIFIED) {
                    if (lower.includes(kw)) { score += 10; reasons.push('srcdoc ad kw'); break; }
                }
            }
            // 正文分 > 50: -50（有正文则大幅降低广告判定）
            if (contentScore > 50) { score -= 50; reasons.push('has content -50'); }
            return { score, reasons };
        },
        // 综合分类：返回 {contentScore, adScore, verdict, reasons}
        // verdict: 'whitelist' | 'content' | 'ad' | 'unknown'
        // B1 修复：可选 frozen 参数——禁止使用 getBoundingClientRect/getComputedStyle 实时测量
        //          传递冻结值后几何维度使用首次测量值，保证两按钮分数一致
        classify(iframe, frozen) {
            let doc = null;
            try { doc = iframe.contentDocument; } catch (e) { doc = null; }
            // B1 修复：冻结测量时传 frozen 跳过实时几何测量
            const { score: contentScore, reasons: cReasons } = this.computeContentScore(doc, iframe, frozen);
            const { score: adScore, reasons: aReasons } = this.computeAdScore(iframe, doc, contentScore, frozen);
            let verdict = 'unknown';
            // 判定公式（§2.3）
            if (contentScore > 60) verdict = 'content';
            else if (adScore > 70 && contentScore < 20) verdict = 'ad';
            return { contentScore, adScore, verdict, reasons: cReasons.concat(aReasons) };
        },

        // BUG-FIX: 子帧自治评分——用 window.location 替代 iframe.src，跳过外部几何特征
        // 此前 _reportSelf 传 null 给 computeAdScore 导致恒返回 0，子帧永远无法上报 verdict='ad'
        computeSelfAdScore(contentScore) {
            let score = 0;
            const reasons = [];
            const selfHref = window.location.href;
            const selfHost = window.location.hostname;
            // src 域名命中全局黑名单: +35
            try {
                if (selfHost && BlockEngine.hostnameBlocked(selfHost, BlockEngine.getDomainSet())) {
                    score += 35; reasons.push('self blacklisted');
                }
            } catch (e) { Log.warn(e.message || e); }
            // src 域名含广告关键词: +25
            if (selfHost && isAdKeywordHost(selfHost)) { score += 25; reasons.push('ad keyword host'); }
            // 创建时机在用户交互后 300ms 内: +15
            if (FrameDetector._interactionTime && Date.now() - FrameDetector._interactionTime < 300) {
                score += 15; reasons.push('post-interaction');
            }
            // 正文分 > 50: -50（有正文则大幅降低广告判定）
            if (contentScore > 50) { score -= 50; reasons.push('has content -50'); }
            return { score, reasons };
        }
    };

    // ─── FrameMessenger：跨域帧间通信（§6.3 postMessage 通信协议） ───
    // 消息类型前缀 PRO_BLOCKER_ 防伪造；子帧上报分类结果，父帧仲裁
    const FrameMessenger = {
        _MSG_PREFIX: 'PRO_BLOCKER_',
        _init: false,
        _frameId: null,
        init() {
            if (this._init) return;
            this._init = true;
            this._frameId = 'f_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
            window.addEventListener('message', e => this._onMessage(e));
        },
        _onMessage(e) {
            if (!e || !e.data || typeof e.data !== 'object') return;
            const type = e.data.type;
            if (typeof type !== 'string' || !type.startsWith(this._MSG_PREFIX)) return;
            // BUG-FIX: 安全校验——丢弃空 origin 和无 source 的可疑消息
            if (!e.origin || !e.source) return;
            // 安全校验：仅处理 PRO_BLOCKER_ 前缀消息（§6.3）
            EventBus.emit('frame:report', { source: e.source, origin: e.origin, data: e.data });
        },
        // 子帧 → 父帧：上报自身分类结果（§6.1 策略A）
        sendReport(payload) {
            if (window.self === window.top) return; // 顶层无需上报
            try {
                // BUG-FIX: 优先用父帧 origin 限制消息目标，减少中间帧窃听风险
                let targetOrigin = '*';
                try {
                    // 同域时可获取父帧 origin；跨域时 fallback 到 '*'
                    if (window.parent.location && window.parent.location.origin) {
                        targetOrigin = window.parent.location.origin;
                    }
                } catch (e) { /* 跨域 SecurityError，保持 '*' */ }
                window.parent.postMessage({
                    type: this._MSG_PREFIX + 'REPORT',
                    frameId: this._frameId,
                    hostname: window.location.hostname,
                    ...payload
                }, targetOrigin);
            } catch (e) { Log.warn(e.message || e); }
        }
    };

    // ─── MessageGuard：postMessage 可疑消息监控（§14 消息防御） ───
    // 不拦截正常通信，仅检测广告/追踪相关 postMessage 并记录日志
    const MessageGuard = {
        _log: [],
        _maxLog: 50,
        _init: false,
        init() {
            if (this._init) return;
            this._init = true;
            window.addEventListener('message', e => this._analyze(e), true);
        },
        _analyze(e) {
            try {
                const d = e.data;
                if (!d) return;
                // 跳过自身协议消息（FrameMessenger 处理）
                if (typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('PRO_BLOCKER_')) return;
                // B12 修复：先廉价字符串嗅探再 JSON.stringify——聊天/埋点密集页避免 O(n) 字符串化
                // 字符串消息直接转小写，对象消息按需 stringify（限制长度）
                let lower = '';
                if (typeof d === 'string') {
                    lower = d.toLowerCase();
                } else {
                    // 先做廉价结构检查：数组长度 > 100 或嵌套对象 > 5 层则跳过
                    try {
                        const keys = Object.keys(d);
                        if (keys.length > 20) return; // 对象键过多，可能是大型数据集
                        // 检查是否有嵌套对象
                        let hasNested = false;
                        for (const k of keys) {
                            const v = d[k];
                            if (v && typeof v === 'object' && !Array.isArray(v)) {
                                hasNested = true; break;
                            }
                        }
                        if (hasNested) {
                            // 有嵌套对象时做 stringify，但截断限制
                            const raw = JSON.stringify(d);
                            if (raw.length > 50000) return;
                            lower = raw.toLowerCase();
                        } else {
                            lower = JSON.stringify(d).toLowerCase();
                        }
                    } catch (e2) { return; }
                }
                let suspicious = false;
                let reason = '';
                // 检测广告域名（B12 复用 lower，避免重复转换）
                for (const kw of AD_TOKENS_UNIFIED) {
                    if (lower.includes(kw)) { suspicious = true; reason = 'ad keyword: ' + kw; break; }
                }
                // 检测跳转 URL
                if (!suspicious && /https?:\/\/[^"'\\\s]+/.test(lower)) {
                    const urls = lower.match(/https?:\/\/[^"'\\\s]+/g) || [];
                    for (const u of urls) {
                        try {
                            const host = new URL(u).hostname;
                            if (host !== window.location.hostname && BlockEngine.hostnameBlocked(host, BlockEngine.getDomainSet())) {
                                suspicious = true; reason = 'blacklisted url in msg'; break;
                            }
                        } catch (err) { Log.warn(err.message || err); }
                    }
                }
                if (suspicious) {
                    this._log.unshift({ ts: Date.now(), origin: e.origin, reason, snippet: lower.slice(0, 200) });
                    if (this._log.length > this._maxLog) this._log.length = this._maxLog;
                    EventBus.emit('message:suspicious', { origin: e.origin, reason });
                }
            } catch (err) { Log.warn(err.message || err); }
        }
    };

    // ─── IframeDeepScanner：帧内元素级深扫（B3 新增） ───
    // 职责：对同域 iframe 执行全引擎深扫，产出元素级 record（非整帧）
    // 复用：domainSet / getPathMatcher / scanInvisibleOverlays（已支持 view 参数）
    // record 结构：{ el, doc, iframe, frameHost, chain, depth, category, suspicion, reasons[], rect, selector, adDomains[], crossOrigin, blocked }
    const IframeDeepScanner = {
        maxDepth: 3,
        // 深度扫描入帧：返回元素级 record 数组
        scanAll() {
            const results = [];
            try {
                document.querySelectorAll('iframe').forEach(iframe => {
                    const rec = IframeGuard._ensureRecord(iframe);
                    if (rec.blocked || rec.manual) return; // 已拦截帧跳过
                    try {
                        const doc = iframe.contentDocument;
                        if (!doc || !doc.documentElement) return;
                        const frameHost = iframe.src ? safeURLHostname(iframe.src) : window.location.hostname;
                        const elResults = this.scanFrame(iframe, doc, frameHost, [], 0);
                        results.push(...elResults);
                    } catch (e) { Log.warn(e.message || e); }
                });
            } catch (e) { Log.warn(e.message || e); }
            return results;
        },

        // 深度扫描单个同域帧内的元素
        scanFrame(iframe, doc, frameHost, chain, depth) {
            const results = [];
            if (depth > this.maxDepth) return results;

            try {
                // 1. 应用域名封杀规则（复用现有 domainSet）
                const domainSet = BlockEngine.getDomainSet();
                if (domainSet.size > 0) {
                    domainSet.forEach(d => {
                        const sel = ResourceSelectorBuilder.buildDomainAttr(d);
                        try {
                            doc.querySelectorAll(sel).forEach(el => {
                                const r = this._classifyElement(el, doc, iframe, frameHost, chain, depth, 'domain-ad');
                                if (r) results.push(r);
                            });
                        } catch (e) { Log.warn(e.message || e); }
                    });
                }

                // 2. 应用路径模式（复用 getPathMatcher）
                try {
                    const pathPatterns = this.storage.getData().pathPattern.filter(r => !r._disabled);
                    if (pathPatterns.length > 0) {
                        const matcher = BlockEngine.getPathMatcher();
                        doc.querySelectorAll('a[href], img[src], script[src], link[href], iframe[src]').forEach(el => {
                            const href = el.getAttribute('href') || el.getAttribute('src') || '';
                            if (href && matcher.test(href)) {
                                const r = this._classifyElement(el, doc, iframe, frameHost, chain, depth, 'path-ad');
                                if (r) results.push(r);
                            }
                        });
                    }
                } catch (e) { Log.warn(e.message || e); }

                // 3. H3+H4 修复：overlay 结果直接 _buildRecord 透传 suspicion（不二次过滤）
                // deepScan 仍保留（见 OverlayScanEngine.deepScan）：其高阶特征（肤色/伪元素/混淆URL）
                // 仅在 opts.deep 时启用，且肤色采样限定于可点击图片，避免全站 Canvas 开销（H3 性能约束）
                try {
                    const cw = iframe.contentWindow;
                    if (cw) {
                        const overlayResults = BlockEngine.scanInvisibleOverlays({
                            autoBlock: false,
                            root: doc.documentElement,
                            minSize: 30,
                            view: cw
                        });
                        overlayResults.forEach(rec => {
                            if (rec && rec.el) {
                                results.push(this._buildRecord(rec.el, doc, iframe, frameHost, chain, depth, rec));
                            }
                        });
                    }
                } catch (e) { Log.warn(e.message || e); }

                // 5. 递归处理嵌套 iframe
                try {
                    doc.querySelectorAll('iframe').forEach(inner => {
                        const innerChain = chain ? chain + ' > iframe' : 'iframe';
                        const innerRecs = this.scanFrame(iframe, inner.contentDocument, frameHost, innerChain, depth + 1);
                        results.push(...innerRecs);
                        // 同时处理内嵌 iframe 自身的分类
                        IframeGuard._classifyAndAct(inner, depth + 1);
                    });
                } catch (e) { Log.warn(e.message || e); }
            } catch (e) { Log.warn(e.message || e); }
            return results;
        },

        // 对帧内元素进行分类判定
        _classifyElement(el, doc, iframe, frameHost, chain, depth, baseCategory) {
            if (!el || ProtectedCheck.isProtected(el)) return null;
            if (el.style.display === 'none') return null;

            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) return null;
            if (!doc.documentElement.contains(el)) return null;

            let suspicion = 0;
            const reasons = [];
            const adDomains = [];
            let category = baseCategory;

            // 基于 class/id/文本命名可疑度
            const cls = (el.className || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            const text = (el.textContent || '').trim().slice(0, 100);
            if (/(?:^|\s)(?:ad|ads|advert|banner|popup|overlay|promo|sponsor|skyscraper|leaderboard|native)[\w-]*\s*/.test(cls)) {
                suspicion += 30; reasons.push('ad-like class');
            }
            if (/(?:^|\s)(?:ad|ads|advert|banner|popup|overlay|promo|sponsor)[\w-]*\s*/.test(id)) {
                suspicion += 30; reasons.push('ad-like id');
            }
            if (/广告|advert|banner|popup|popup|sponsor/i.test(text)) {
                suspicion += 15; reasons.push('ad-like text');
            }

            // 检查 src/href 是否命中广告域
            const srcAttr = el.getAttribute('src') || el.getAttribute('href') || '';
            if (srcAttr) {
                try {
                    const u = new URL(srcAttr, doc.baseURI || location.href);
                    if (BlockEngine.hostnameBlocked(u.hostname, BlockEngine.getDomainSet())) {
                        suspicion += 35; reasons.push('src blacklisted'); adDomains.push(u.hostname);
                    }
                    if (isAdKeywordHost(u.hostname)) {
                        suspicion += 25; reasons.push('src ad keyword host'); adDomains.push(u.hostname);
                    }
                } catch (e) { Log.warn(e.message || e); }
            }

            // 几何特征
            const vw = doc.defaultView?.innerWidth || window.innerWidth || 1;
            const vh = doc.defaultView?.innerHeight || window.innerHeight || 1;
            const areaRatio = (rect.width * rect.height) / (vw * vh);
            if (areaRatio > 0.3 && text.length < 20) { suspicion += 10; reasons.push('large area no text'); }
            if (rect.height < 50 && rect.width < 50 && areaRatio > 0.05) { suspicion += 15; reasons.push('small overlay'); }

            if (suspicion < 20) return null;

            const selector = this._buildSelector(el, doc);
            const chainStr = (chain && chain.length) ? `${chain} > ${selector}` : selector;

            return {
                el, doc, iframe, frameHost, chain: chainStr, depth, category,
                suspicion, reasons, rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
                selector, adDomains, crossOrigin: false, blocked: false
            };
        },

        // 从 OverlayScanEngine result 构建 record
        _buildRecord(oasEl, doc, iframe, frameHost, chain, depth, oas) {
            const rect = oasEl.getBoundingClientRect ? oasEl.getBoundingClientRect() : { width: 0, height: 0 };
            const suspicion = oas.suspicion || 0;
            const reasons = oas.reasons || [];
            const category = oas.category || 'unknown';
            return {
                el: oasEl, doc, iframe, frameHost, chain, depth, category,
                suspicion, reasons,
                rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
                selector: oas.selector || '',
                adDomains: [], crossOrigin: false, blocked: false
            };
        },

        _buildSelector(el) {
            if (!el) return '';
            if (el.id) return '#' + el.id;
            let s = el.tagName.toLowerCase();
            if (el.className && typeof el.className === 'string') {
                const cls = el.className.trim().split(/\s+/).slice(0, 2);
                if (cls[0]) s += '.' + cls.join('.');
            }
            return s;
        }
    };

    // ─── IframeGuard：iframe 防线核心（§4 §5 §7） ───
    // 职责：发现 iframe → 分类 → 拦截纯广告 / 清理内容帧内部广告 / 保护白名单
    // 正文保护铁律（§2.1）在 _handleAdNode 中强制执行
    const IframeGuard = {
        _processedIframes: new WeakSet(),
        _stats: { blocked: 0, protected: 0, scanned: 0, cleaned: 0 },
        _maxDepth: 3,
        MIN_DEPTH: 1,
        MAX_DEPTH: 5,
        _init: false,
        _iframeBlockRules: null, // iframeBlock 规则缓存
        // B1 修复：帧记录单一数据源——冻结几何测量，防止「测量-动作耦合」导致分数不一致+振荡
        // 注意：WeakMap/WeakSet 按设计均不可枚举（无 forEach/迭代器）。
        // 如需遍历记录，请用 _liveFrames() 以 DOM 为真实来源反查，切勿另建 key 集合。
        _frameRecords: new WeakMap(),
        // B10: 子帧 MutationObserver——帧内动态元素补报（≤3次）
        _frameMutObs: new WeakMap(),

        init() {
            if (this._init) return;
            this._init = true;
            this._loadConfig();
            // 订阅 FrameDetector 事件（§4.2 帧发现→分类）
            EventBus.on('frame:new', ({ iframe }) => {
                this._handleNewIframe(iframe);
            });
            // 监听规则变更
            EventBus.on('rule:changed', () => { this._iframeBlockRules = null; });
            // BUG-FIX: 注册 frame:report 处理器——子帧上报分类结果后重新评估对应 iframe
            // 此前 frame:report 事件无消费者，跨域帧双层决策模型完全断裂
            EventBus.on('frame:report', (payload) => { this._handleFrameReport(payload); });
            // 首次扫描（FrameDetector 已启动，触发全量 frame:new 事件）
            FrameDetector.scanAll();
        },

        // B1 修复：确保帧记录存在，冻结首次测量的几何值
        // 隐藏后 getBoundingClientRect 返回 0×0 → 面积/透明度维度全部失效 → 两次扫描分数必然不同
        // 冻结后 classify 始终用首次测量值 → 两按钮分数一致、振荡消失
        _ensureRecord(iframe) {
            let r = this._frameRecords.get(iframe);
            if (!r) {
                let cs = null, q = { width: 0, height: 0 };
                try {
                    cs = window.getComputedStyle(iframe);
                    q = iframe.getBoundingClientRect();
                } catch (e) { Log.warn(e.message || e); }
                r = {
                    iframe,
                    frozen: {
                        w: q.width || 0,
                        h: q.height || 0,
                        opacity: cs ? parseFloat(cs.opacity) : 1,
                        zi: cs ? (parseInt(cs.zIndex, 10) || 0) : 0,
                        position: cs ? cs.position : '',
                        pointerEvents: cs ? cs.pointerEvents : ''
                    },
                    verdict: 'unknown',
                    blocked: false,
                    manual: false,
                    counted: {}
                };
                this._frameRecords.set(iframe, r);
            }
            return r;
        },

        // 枚举当前文档树中所有存活 iframe（含同源嵌套帧，深度受 _maxDepth 约束）
        // WeakMap 不可枚举，故以 DOM 为唯一真实来源反查记录：既不持有强引用（无泄漏），
        // 又天然跳过已脱离文档的废弃帧
        // PENDING-03：DOM 查询下沉 FrameDetector，IframeGuard 不再直接触碰 document（DIP）
        _liveFrames(root = document, depth = 0, out = []) {
            if (depth > this._maxDepth) return out;
            try {
                FrameDetector.queryIframes(root).forEach(f => {
                    out.push(f);
                    try {
                        const doc = f.contentDocument;
                        if (doc) this._liveFrames(doc, depth + 1, out);
                    } catch (e) { /* 跨域帧 contentDocument 不可访问，属预期情况 */ }
                });
            } catch (e) { Log.warn(e.message || e); }
            return out;
        },

        // H7 修复：挑出粘性记录（blocked/manual）迁移到新 WeakMap，防止重扫后手动拦截复活
        _keepStickyRecords() {
            const keep = new WeakMap();
            this._liveFrames().forEach(iframe => {
                const rec = this._frameRecords.get(iframe);
                if (rec && (rec.blocked || rec.manual)) keep.set(iframe, rec);
            });
            return keep;
        },

        // B1 修复：统一 stats 计数口径——首次计数 + EventBus 发射实时看板
        _incStat(k, n = 1) {
            this._stats[k] = (this._stats[k] || 0) + n;
            EventBus.emit('iframe:stats', { ...this._stats });
        },

        _loadConfig() {
            const config = GM_getValue('iframeConfig', {});
            const depth = parseInt(config.maxDepth, 10);
            this._maxDepth = (depth >= this.MIN_DEPTH && depth <= this.MAX_DEPTH) ? depth : 3;
        },

        setMaxDepth(depth) {
            const d = parseInt(depth, 10);
            if (d >= this.MIN_DEPTH && d <= this.MAX_DEPTH) {
                this._maxDepth = d;
                const config = GM_getValue('iframeConfig', {});
                config.maxDepth = d;
                GM_setValue('iframeConfig', config);
            }
        },

        // 首次全量扫描（委托给 FrameDetector）
        scanAll() {
            FrameDetector.scanAll();
        },

        // PENDING-GM-01：暴露公开方法，消除外部模块对私有 _iframeBlockRules 的直写（R3-1 / DIP）
        invalidateBlockRules() {
            this._iframeBlockRules = null;
        },

        // 规则变更后重新评估所有 iframe（包括已处理的）：清除 WeakSet 后全量重扫
        // H7 修复：保留粘性记录（blocked/manual），防止重扫后手动拦截复活
        rescanAll() {
            try {
                this._processedIframes = new WeakSet();
                this._frameRecords = this._keepStickyRecords();
                this._frameMutObs = new WeakMap();
                this.scanAll();
            } catch (e) { Log.warn(e.message || e); }
        },

        // H7 修复：强制重扫语义与 rescanAll 完全一致，保留独立入口供外部调用
        forceRescan() {
            this.rescanAll();
        },

        _handleNewIframe(iframe) {
            if (!iframe || iframe.nodeType !== 1) return;
            if (this._processedIframes.has(iframe)) return;
            // 保护脚本自身 UI
            if (ProtectedCheck.isProtected(iframe)) return;
            this._processedIframes.add(iframe);
            // B1 修复：stats 统一通过 _incStat 计数 + EventBus 发射
            this._incStat('scanned');
            // 延迟分类：等 iframe 内容加载（srcdoc/about:blank 同步可访问，跨域 load 后才有 src）
            this._classifyAndAct(iframe, 0);
            // 监听 load 事件：跨域 iframe 加载完成后重新评估
            // BUG-FIX: 防止 rescanAll 后重复绑定 load 监听器导致累积泄漏
            if (!iframe.__proBlockerLoadBound) {
                iframe.__proBlockerLoadBound = true;
                iframe.addEventListener('load', () => {
                    if (!iframe.isConnected) return; // iframe 已脱离 DOM，跳过
                    this._classifyAndAct(iframe, 0);
                });
            }
        },

        // 核心决策：分类 → 执行（§4.2 §5.1）
        // B1 修复：冻结测量+单一 record 源+判定粘性
        _classifyAndAct(iframe, depth) {
            if (depth > this._maxDepth) return;
            if (!iframe.isConnected) return; // iframe 已脱离 DOM
            if (ProtectedCheck.isProtected(iframe)) return;

            // B1 修复：单一数据源——所有判定基于 _ensureRecord 的冻结测量
            const rec = this._ensureRecord(iframe);

            // B2 修复：粘性判定——blocked 或 manual 的帧永不自动复活
            // 此前：隐藏→重测分降→verdict 翻成 unknown/content→showElement→恢复可见→再测又 ad→再隐藏…振荡
            if (rec.blocked || rec.manual) return;

            // 先检查 iframeBlock 规则（用户显式规则优先）
            if (this._matchesIframeBlockRules(iframe)) {
                this._blockIframe(iframe, 'iframeBlock rule');
                return;
            }

            // B1 修复：classify 使用冻结几何值，隐藏后分数不变
            const result = ContentClassifier.classify(iframe, rec.frozen);
            EventBus.emit('iframe:classified', { iframe, ...result });

            // BUG-FIX: verdict 从 ad 变为非 ad 时先恢复显示（铁律1：不隐藏含正文的 iframe）
            // 初始分类时内容未加载可能误判为 ad，load 后重判为 content 须先 showElement
            const prevVerdict = rec.verdict || null;
            if (prevVerdict === 'ad' && result.verdict !== 'ad') {
                BlockEngine.showElement(iframe);
            }
            rec.verdict = result.verdict;

            if (result.verdict === 'ad') {
                this._blockIframe(iframe, result.reasons.join(','));
                return;
            }
            if (result.verdict === 'content') {
                // 内容 iframe：仅清理内部广告，保留 iframe 容器（铁律1 §2.1）
                this._scanContentIframe(iframe, depth);
                // B1 修复：stats 首次计数
                if (!rec.counted.p) { rec.counted.p = 1; this._incStat('protected'); }
                EventBus.emit('iframe:protected', { iframe, reason: 'content' });
                return;
            }
            // unknown：标记监听，不自动拦截（铁律4 §2.1）
            // 跨域帧等待子帧 postMessage 上报
        },

        // 检查 iframeBlock 规则匹配
        _matchesIframeBlockRules(iframe) {
            const rules = this._getIframeBlockRules();
            for (let i = 0; i < rules.length; i++) {
                const r = rules[i];
                if (r._disabled) continue;
                if (r.matchType === 'srcDomain' && r.value && iframe.src) {
                    try {
                        const host = new URL(iframe.src).hostname;
                        if (host === r.value || host.endsWith('.' + r.value)) return true;
                    } catch (e) { Log.warn(e.message || e); }
                }
                if (r.matchType === 'srcdocKeyword' && r.value && iframe.srcdoc) {
                    if (iframe.srcdoc.toLowerCase().includes(r.value.toLowerCase())) return true;
                }
                if (r.matchType === 'geometry') {
                    // 几何规则：value 形如 "area>60,opacity<0.1,zIndex>999"
                    if (this._matchGeometry(iframe, r.value)) return true;
                }
            }
            return false;
        },

        _getIframeBlockRules() {
            if (this._iframeBlockRules !== null) return this._iframeBlockRules;
            this._iframeBlockRules = this.storage.getIframeBlocks();
            return this._iframeBlockRules;
        },

        _matchGeometry(iframe, expr) {
            if (!expr) return false;
            try {
                const cs = window.getComputedStyle(iframe);
                const rect = iframe.getBoundingClientRect();
                const vw = window.innerWidth || document.documentElement.clientWidth || 1;
                const vh = window.innerHeight || document.documentElement.clientHeight || 1;
                const areaRatio = (rect.width * rect.height) / (vw * vh) * 100;
                const opacity = parseFloat(cs.opacity) * 100;
                const zi = parseInt(cs.zIndex, 10) || 0;
                const conditions = expr.split(',').map(s => s.trim()).filter(Boolean);
                // BUG-FIX: 无效条件不再被 continue 跳过导致恒 true，改为要求全部条件有效且匹配
                let matchedCount = 0;
                for (const cond of conditions) {
                    const m = cond.match(/^(area|opacity|zIndex)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/);
                    if (!m) return false; // 遇到无法解析的条件，规则不匹配
                    const [, key, op, num] = m;
                    const val = key === 'area' ? areaRatio : (key === 'opacity' ? opacity : zi);
                    const n = parseFloat(num);
                    if (op === '>' && !(val > n)) return false;
                    if (op === '<' && !(val < n)) return false;
                    if (op === '>=' && !(val >= n)) return false;
                    if (op === '<=' && !(val <= n)) return false;
                    matchedCount++;
                }
                return matchedCount > 0 && matchedCount === conditions.length;
            } catch (e) { return false; }
        },

        // 整体拦截纯广告 iframe（铁律3 §2.1）
        // B1/B2 修复：更新 record.blocked=true 实现粘性，stats 统一通过 _incStat
        _blockIframe(iframe, reason) {
            BlockEngine.hideElement(iframe);
            const rec = this._ensureRecord(iframe);
            rec.blocked = true;
            rec.verdict = 'ad';
            // B1 修复：stats 首次计数
            if (!rec.counted.b) { rec.counted.b = 1; this._incStat('blocked'); }
            EventBus.emit('iframe:blocked', { iframe, reason });
        },

        // 内容 iframe 内部广告清理（铁律1 §2.1：绝不删 iframe 容器）
        _scanContentIframe(iframe, depth) {
            let doc = null;
            try { doc = iframe.contentDocument; } catch (e) { return; }
            if (!doc || !doc.documentElement) return;
            try {
                // 应用域名封杀规则到 iframe 内部
                const domainSet = BlockEngine.getDomainSet();
                if (domainSet.size > 0) {
                    domainSet.forEach(d => {
                        const sel = ResourceSelectorBuilder.buildDomainAttr(d);
                        try {
                            doc.querySelectorAll(sel).forEach(el => {
                                this._handleAdNode(el, doc);
                            });
                        } catch (e) { Log.warn(e.message || e); }
                    });
                }
                // 递归处理嵌套 iframe（§7.2 深度控制）
                try {
                    doc.querySelectorAll('iframe').forEach(inner => {
                        this._classifyAndAct(inner, depth + 1);
                    });
                } catch (e) { Log.warn(e.message || e); }
            } catch (e) { Log.warn(e.message || e); }
            // B10: 为同源帧设置子帧 MutationObserver，2s 去抖补报动态元素
            this._observeFrameChildren(iframe, depth);
        },

        // B10: 子帧 MutationObserver——帧内动态元素补报（≤3次）
        _observeFrameChildren(iframe, depth) {
            if (depth > this._maxDepth) return;
            if (this._frameMutObs.has(iframe)) return;
            let doc = null;
            try { doc = iframe.contentDocument; } catch (e) { return; }
            if (!doc || !doc.documentElement) return;
            try {
                let reportCount = 0;
                const maxReports = 3;
                let debounceTimer = null; // H13 修复：存 timer，2s 去抖
                const observer = new MutationObserver((mutations) => {
                    if (reportCount >= maxReports) {
                        // FIX-C (Brooks R6): 达到上报上限时清除待执行的去抖定时器，避免空转
                        clearTimeout(debounceTimer);
                        observer.disconnect();
                        return;
                    }
                    // H13 修复：去抖，同一 batch 只起一个 timer
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        if (reportCount >= maxReports) return;
                        try {
                            const newIf = doc.querySelectorAll('iframe');
                            if (newIf.length > 0) {
                                newIf.forEach(f => this._classifyAndAct(f, depth + 1));
                                reportCount++;
                            }
                        } catch (e) { Log.warn(e.message || e); }
                    }, 2000);
                });
                observer.observe(doc.documentElement, { childList: true, subtree: true });
                this._frameMutObs.set(iframe, observer);
            } catch (e) { Log.warn(e.message || e); }
        },

        // 正文保护判定（§5.2）：有正文 → 仅删广告节点，不动容器
        _handleAdNode(node, doc) {
            if (!node || ProtectedCheck.isProtected(node)) return;
            // 找最近的包裹容器
            const container = BlockEngine.findSingleChildWrapper(node, 4);
            let containerText = '';
            let hasSemantic = false;
            try {
                containerText = (container.innerText || container.textContent || '');
                hasSemantic = !!(container.querySelector && container.querySelector('article,main,p,h1,h2,h3,h4,h5,h6'));
            } catch (e) { Log.warn(e.message || e); }
            // 铁律2：有正文 → 只删广告节点，不动容器
            if (containerText.length > 200 || hasSemantic) {
                BlockEngine.hideElement(node);
                this._incStat('cleaned');
                return;
            }
            // 铁律3：无正文的纯广告容器 → 可安全删除
            BlockEngine.hideElement(container);
            this._incStat('cleaned');
        },

        // B2/B4 修复：帧内元素级拦截——生成持久规则 + 即时隐藏 + stats 收口
        // 同源帧：selector 在帧内文档生成，写入帧所在域名桶 → 子帧实例刷新后自应用
        // 跨域帧：行内整帧拦截 → 生成 iframeBlock srcDomain 规则
        blockInFrameNode(rec) {
            if (!rec || !rec.el) return;
            // 已有规则则跳过
            if (rec.blocked) return;

            // 1. 域名封杀（全局域规则）
            if (rec.adDomains && rec.adDomains.length > 0) {
                try { DomainBlockExecutor.execute(rec.adDomains, { hideMode: 'none' }); } catch (e) { Log.warn(e.message || e); }
            }

            // 2. H14 修复：用 generateOptimalSelector 生成精准选择器，避免 tag+2class 过宽误伤
            let selector = rec.selector;
            if (!selector && rec.el) {
                try { selector = BlockEngine.generateOptimalSelector(rec.el); } catch (e) { Log.warn(e.message || e); }
            }
            if (selector && !rec.crossOrigin && rec.frameHost) {
                try {
                    this.storage.addRuleForDomain(rec.frameHost, 'attribute', {
                        attrSelector: selector,
                        type: 'attribute',
                        _meta: 'iframe-scan'
                    });
                } catch (e) { Log.warn(e.message || e); }
            }

            // 3. 即时隐藏
            try { BlockEngine.hideElement(rec.el); } catch (e) { Log.warn(e.message || e); }

            // 4. 更新 record
            rec.blocked = true;
            this._incStat('blocked');
            EventBus.emit('iframe:blocked', { record: rec, reason: 'frame-element' });
        },

        // H5 修复：reapplyInFrames 用 hostname 比较 + 先恢复再按生效规则重隐藏
        reapplyInFrames() {
            try {
                document.querySelectorAll('iframe').forEach(iframe => {
                    if (!iframe.isConnected) return;
                    let doc = null;
                    try { doc = iframe.contentDocument; } catch (e) { return; }
                    if (!doc) return;
                    // H5 修复：用 hostname 与 domain 比较，而非完整 URL
                    const host = safeURLHostname(iframe.src);
                    if (!host) return;
                    // 1. 先恢复所有帧内 inline 隐藏（清除旧规则覆盖的 display:none）
                    doc.querySelectorAll('*').forEach(el => {
                        if (el.style.display === 'none') el.style.removeProperty('display');
                        el.style.removeProperty('opacity');
                        el.style.removeProperty('visibility');
                    });
                    // 2. 按未禁用规则重隐藏
                    const rules = this.storage.getAllSiteRules().filter(r => r.domain === host && r.type === 'attribute');
                    rules.forEach(r => {
                        try {
                            if (r.rule && r.rule.attrSelector && !r.rule._disabled) {
                                doc.querySelectorAll(r.rule.attrSelector).forEach(el => {
                                    if (!ProtectedCheck.isProtected(el)) BlockEngine.hideElement(el);
                                });
                            }
                        } catch (e) { Log.warn(e.message || e); }
                    });
                });
            } catch (e) { Log.warn(e.message || e); }
        },

        getStats() { return this._stats; },

        // 扫描检测：返回页面所有 iframe 的分类详情，供面板展示
        scanAndReport() {
            const results = [];
            try {
                const iframes = document.querySelectorAll('iframe');
                iframes.forEach(iframe => {
                    if (ProtectedCheck.isProtected(iframe)) return;
                    const rect = iframe.getBoundingClientRect();
                    let cs = null;
                    try { cs = window.getComputedStyle(iframe); } catch (e) { Log.warn(e.message || e); }
                    const record = {
                        el: iframe,
                        src: iframe.src || '',
                        srcdoc: iframe.srcdoc ? '(有 srcdoc)' : '',
                        id: iframe.id || '',
                        name: iframe.name || '',
                        className: typeof iframe.className === 'string' ? iframe.className.slice(0, 80) : '',
                        rect: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) },
                        opacity: cs ? parseFloat(cs.opacity) : 1,
                        position: cs ? cs.position : '',
                        zIndex: cs ? (parseInt(cs.zIndex, 10) || 0) : 0,
                        verdict: iframe.__proBlockerVerdict || 'unknown',
                        crossOrigin: false,
                        contentScore: 0,
                        adScore: 0,
                        reasons: []
                    };
                    // 尝试分类
                    try {
                        const result = ContentClassifier.classify(iframe);
                        record.contentScore = result.contentScore;
                        record.adScore = result.adScore;
                        record.reasons = (result.reasons || []);
                        if (record.reasons.length > 4) {
                            record.reasons = record.reasons.slice(0, 4).concat(['+ ' + (result.reasons.length - 4) + ' more']);
                        }
                        if (result.verdict !== 'unknown') record.verdict = result.verdict;
                    } catch (e) { Log.warn(e.message || e); }
                    // 跨域检测
                    try {
                        const doc = iframe.contentDocument;
                        record.crossOrigin = !doc;
                    } catch (e) { record.crossOrigin = true; }
                    results.push(record);
                });
            } catch (e) { Log.warn(e.message || e); }
            return results;
        },

        // BUG-FIX: 处理子帧 postMessage 上报的分类结果（§6.1 策略A 顶层仲裁）
        // 根据 e.source 匹配 iframe 元素，按子帧上报的 verdict 重新决策
        _handleFrameReport(payload) {
            try {
                if (!payload || !payload.source || !payload.data) return;
                const childWindow = payload.source;
                const data = payload.data;
                // 遍历所有 iframe 找到 contentWindow 匹配的 iframe
                const iframes = document.querySelectorAll('iframe');
                for (let i = 0; i < iframes.length; i++) {
                    const iframe = iframes[i];
                    if (iframe.contentWindow !== childWindow) continue;
                    // 找到匹配的 iframe，按子帧上报结果处理
                    if (data.verdict === 'content') {
                        // 子帧报告为内容帧：恢复显示（可能被初始误判为 ad 隐藏），保护不动
                        if (iframe.__proBlockerVerdict === 'ad') {
                            BlockEngine.showElement(iframe);
                        }
                        iframe.__proBlockerVerdict = 'content';
                        this._incStat('protected');
                        EventBus.emit('iframe:protected', { iframe, reason: 'frame-report:content' });
                    } else if (data.verdict === 'ad') {
                        // 子帧报告为纯广告帧：整体隐藏
                        this._blockIframe(iframe, 'frame-report:ad (adScore=' + data.adScore + ')');
                    }
                    // unknown：不干预，继续监听
                    return;
                }
            } catch (e) { Log.warn(e.message || e); }
        }
    };

    // ── GM 菜单注册表（抽离为纯函数，可被 jest 直接单测，关闭 TD-08 / T5 的 0% 覆盖缺口）──
    const MENU_ITEMS = [
        ['🖱 手动选择屏蔽元素', '选择模式', 'selection'],
        ['📝 添加文本/正则/积木/属性/路径规则', '规则面板', 'regex'],
        ['🌐 全局检索域名', '域名检索', 'domain'],
        ['👁 扫描不可见覆盖层广告', '覆盖层扫描', 'overlay'],
        ['⚙️ 管理规则与防御策略', '管理面板', 'manager'],
        ['🖼️ iframe 防线管理', 'iframe面板', 'iframe'],
        ['📤 导出规则（跨设备迁移）', '导出面板', 'export'],
        ['🛡️ 导出 AdGuard 规则', 'AdGuard 导出', 'adguard'],
        ['📥 导入规则', '导入面板', 'import']
    ];

    // 纯函数：将菜单项注册到任意 register（GM_registerMenuCommand 或测试桩）。
    // 经 PanelRegistry 将面板 key 解析为 UIManager 方法，新增面板 = 注册一行 + MENU_ITEMS 加一项，
    // 分派逻辑零改动（《敏捷软件开发》OCP；《重构》Ch.7 消除重复模板）
    function _buildMenu(register, uiFactory) {
        MENU_ITEMS.forEach(([label, title, key]) => {
            const method = PanelRegistry[key];
            if (!method) { Log.error('未知面板 key: ' + key); return; }
            register(label, () => {
                const ui = uiFactory();
                ui._safeCall(title, () => ui[method]());
            });
        });
    }

    // ================= 初始化与执行流 =================
    // 真实浏览器才执行初始化：node/jest 环境（window.HTMLElement 未定义）跳过本块，
    // 使产物可被 require 做 UI 契约测试，且完全不改变浏览器运行行为（Feathers《Working
    // Effectively with Legacy Code》§3 接缝；Fowler《重构》§12.2 提取可测函数）
    if (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof window.HTMLElement !== 'undefined') {

        // 网络层拦截须最先执行：在页面任何 fetch/XHR/script 加载前完成 hook，确保广告请求被源头丢弃
        NetworkInterceptor.init();
        // Shadow DOM 穿透须在页面脚本调用 attachShadow 前完成代理
        BlockEngine.hookAttachShadow();
        BlockEngine.fastInject();
        BlockEngine.startObserver();

        // ─── iframe 防线初始化（§9 启动流程） ───
        // 帧发现引擎：最先启动，监听 iframe 创建/插入
        FrameDetector.init();
        // 帧间通信与消息监控：所有帧（顶层 + 子帧）均需初始化
        FrameMessenger.init();
        MessageGuard.init();
        // iframe 检测与分类：订阅 FrameDetector 事件
        IframeGuard.init();

        // ── L2 服务层：覆盖层扫描端口（OverlayService）注入导航拦截（原置于网络层之前，现归位到服务层，消除启动直连引擎具体实现）──
        try {
            const _blockedDomains = StorageService.getDomainBlocks().map(r => r.domain);
            OverlayService.enableNavigationInterceptor(_blockedDomains);
        } catch (e) { Log.warn(e.message || e); }

        // 子帧自治上报（§6.1 策略A）：子帧向父帧 postMessage 上报自身分类结果
        // 顶层窗口无需上报；延迟到 DOMContentLoaded 后计算评分（确保正文已渲染）
        if (window.self !== window.top) {
            const _reportSelf = () => {
                try {
                    // BUG-FIX: 子帧用 computeSelfAdScore 自评估（非 computeAdScore(null,...) 恒 0）
                    const cScore = ContentClassifier.computeContentScore(document, null);
                    const aScore = ContentClassifier.computeSelfAdScore(cScore.score);
                    let verdict = 'unknown';
                    if (cScore.score > 60) verdict = 'content';
                    else if (aScore.score > 70 && cScore.score < 20) verdict = 'ad';
                    FrameMessenger.sendReport({
                        contentScore: cScore.score,
                        adScore: aScore.score,
                        hasContent: cScore.score > 60,
                        verdict,
                        url: window.location.href
                    });
                } catch (e) { Log.warn(e.message || e); }
            };
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                setTimeout(_reportSelf, TIMING.REPORT_DELAY_MS);
            } else {
                document.addEventListener('DOMContentLoaded', () => setTimeout(_reportSelf, TIMING.REPORT_DELAY_MS));
            }
        }

        if (window.self === window.top) {
            let uiInstance = null;
            function getUI() {
                if (!uiInstance) uiInstance = new UIManager();
                return uiInstance;
            }

            // GM 菜单注册：复用 _buildMenu 纯函数，消除 9 处重复模板
            _buildMenu(GM_registerMenuCommand, getUI);
        }

    } // end: 真实浏览器初始化守卫

    // 测试可注入性：node/jest 下导出内部符号，供 UI 契约测试 require（不影响浏览器运行）
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            MENU_ITEMS, _buildMenu, PanelRegistry, OverlayService, StorageService,
            SelectionPanel, RegexPanel, GlobalDomainPanel, OverlayScanPanel, ManagerPanel,
            IframePanel, ExportPanel, AdGuardExportPanel, ImportPanel, UIManager
        };
    }

})();
