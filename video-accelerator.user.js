// ==UserScript==
// @name         视频快速检测与稳定播放 (v19 架构)
// @namespace    http://tampermonkey.net/
// @version      19.0.2
// @description  v19：感知-裁决-会话-自愈-观测架构。CandidateArbiter 候选评分、GlobalScheduler 统一调度、用户意图保护、恢复预算与冷却、FAB 状态环、配置迁移、iframe FrameMesh。
// @author       EFate (Refactored by AI)
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '19.0.1';
    const PW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    let IS_TOP = true;
    try { if (PW.self !== PW.top) IS_TOP = false; } catch (e) { IS_TOP = false; }

    // 同源守卫：跨域 iframe 中 PW.document 与顶层 document 不同源，不可混用
    // IS_TOP 已在上方判断，顶层用 document，iframe 内用 PW.document（同源时安全）
    const DOC = IS_TOP ? document : (function () {
        try { return PW.document; } catch (e) { return null; }
    })();
    // 顶层文档（跨域 iframe 中 DOC 可能是 iframe 文档，此常量始终指向顶层）
    const DOC_TOP = document;
    const LOC = PW.location || location;
    const NOW = function () { return Date.now(); };

    let SKIP_LOCAL = false;
    if (!IS_TOP) {
        try {
            if (PW.parent && PW.parent.__VA__) SKIP_LOCAL = true;
        } catch (e) { }
    }
    if (SKIP_LOCAL) return;

    try { PW.__VA__ = { version: VERSION, IS_TOP: IS_TOP }; } catch (e) { }

    const IFRAME_ID = 'if_' + Math.random().toString(36).slice(2, 11);
    const HOOKED_DOCS = new Set([DOC]);

    /* ═══════════════════════════════════════════════════════════
       基础工具
    ═══════════════════════════════════════════════════════════ */

    const clamp = function (n, lo, hi) { return (typeof n !== "number" || isNaN(n)) ? lo : Math.max(lo, Math.min(hi, n)); };

    const VIDEO_RE = /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v|flv)(\?|$)|\/(seg|chunk|frag|segment|video|audio|media)s?\//i;
    const isVideoResource = function (url) { return VIDEO_RE.test(url || ''); };

    const isLive = function (v) {
        try { return v && v.duration === Infinity; } catch (e) { return false; }
    };

    // 集中关键阈值与评分语义常量，消除散落的魔法数字，便于统一调参（可维护性优化）
    const VA_TUNING = {
        SCAN_VIDEO_CAP: 800,             // 单次扫描 video/iframe 上限
        SCAN_SHADOW_CAP: 250,            // shadowRoot 宿主遍历上限
        PATROL_COOLDOWN_MS: 10000,       // 巡逻静默冷却（有活跃会话时跳过扫描，毫秒）
        ERROR_RECOVER_THROTTLE_MS: 2500, // 紧急恢复触发节流（毫秒）
        LARGE_AREA_PX: 200000,           // 判定「大尺寸视频」的面积阈值（px²）
        LONG_DURATION_S: 60,             // 判定「长视频」的时长阈值（秒）
        AD_DURATION_MAX_S: 8,            // 疑似广告短视频的时长上限（秒）
        STANDBY_SCORE: 40,               // 进入待命态的评分阈值
        GESTURE_BONUS: 25,               // 用户手势加分
        AD_LIKE_PENALTY: 80,             // 疑似广告惩罚
        PRIMARY_MATCH_BONUS: 30,         // 命中站点主选择器加分
        IGNORE_MATCH_PENALTY: 80,        // 命中站点忽略选择器惩罚
        AD_LIKE_SHORT_PENALTY: 18,       // 疑似广告短视频（短+静音+循环）惩罚
        ARBITER_COOLDOWN_MS: 2000,       // 接管决策冷却（防止同一视频频繁接管，毫秒）
        // 以下缓冲/保活阈值，单独放在 VA_BUFFER 子对象，避免 VA_TUNING 过长
    };

    // 缓冲保活相关阈值：低水位/触发降画质/恢复水位/保活节流/增强节流
    const VA_BUFFER = {
        EMERGENCY_THROTTLE_MS: 3000,     // _bufferCheck 紧急恢复节流（毫秒）
        BOOST_THROTTLE_MS: 8000,         // _bufferCheck 增强预加载节流（毫秒）
        BUFFER_LEVEL_CRITICAL: 1,        // 临界缓冲水位（秒），低于即触发紧急恢复
        BUFFER_LEVEL_WARNING: 5,         // 警告缓冲水位（秒），低于触发轻推
        BUFFER_LEVEL_RECOVER: 8,         // 恢复缓冲水位（秒），高于即判定恢复正常
        LOW_COUNT_TRIGGER: 2,            // 连续低缓冲次数，触发自动降画质
        BACK_BUFFER_MAX_S: 120,          // 后向缓冲上限（秒），超出则裁剪
        BACK_BUFFER_TRIM_S: 30,          // 后向缓冲裁剪目标（秒）
        TIMELINE_RENDER_THROTTLE_MS: 1000, // 时间线渲染节流（毫秒）
        QUALITY_CHANGE_COOLDOWN_MS: 2000, // 画质切换冷却（毫秒）
        STALL_LOG_THROTTLE_MS: 2000,     // 停滞日志节流（毫秒）
        LOG_LINE_LIMIT: 200,             // 日志行最大数量
        USER_GESTURE_WINDOW_MS: 3000,    // 用户手势有效窗口（毫秒）
        // Stall 分级阈值（毫秒）
        FRAME_RECENT_WINDOW_MS: 3000,    // RVFC 帧时间窗口（毫秒）
        STALL_LEVEL_1_MS: 1500,          // L1 卡顿判定（毫秒）
        STALL_LEVEL_2_MS: 3000,          // L2 卡顿判定（毫秒）
        STALL_LEVEL_3_MS: 5000,          // L3 卡顿判定（毫秒）
        RECOVERY_TIMEOUT_MS: 15000,      // 恢复操作超时（毫秒）
    };

    const isVisible = function (el) {
        try {
            if (!el || !el.isConnected) return false;
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || PW;
            const cs = view.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
        } catch (e) { return false; }
    };

    const videoArea = function (v) {
        try {
            const r = v.getBoundingClientRect();
            return Math.max(0, r.width) * Math.max(0, r.height);
        } catch (e) { return 0; }
    };

    const getHost = function (url) {
        try {
            const U = PW.URL || URL;
            return new U(url, LOC.href).host;
        } catch (e) { return ''; }
    };

    const raf = function (cb) {
        try {
            if (PW.requestAnimationFrame) return PW.requestAnimationFrame.call(PW, cb);
        } catch (e) { }
        return PW.setTimeout(cb, 50);
    };

    let _bwCache = 0;
    let _bwTs = 0;

    function estimateBandwidth() {
        try {
            const now = NOW();
            if (now - _bwTs < 5000) return _bwCache;

            const perf = PW.performance || performance;
            if (!perf || !perf.getEntriesByType) return 0;
            const entries = perf.getEntriesByType('resource')
                .filter(function (e) {
                    return isVideoResource(e.name) && (e.transferSize || 0) > 0 && (e.duration || 0) > 0;
                })
                .sort(function (a, b) { return b.startTime - a.startTime; })
                .slice(0, 5);
            if (!entries.length) { _bwCache = 0; _bwTs = now; return 0; }
            const bytes = entries.reduce(function (s, e) { return s + e.transferSize; }, 0);
            const ms = entries.reduce(function (s, e) { return s + e.duration; }, 0);
            _bwCache = ms > 0 ? Math.round((bytes * 8) / (ms / 1000)) : 0;
            _bwTs = now;
            return _bwCache;
        } catch (e) { return 0; }
    }

    function getNetworkType() {
        try {
            const c = PW.navigator.connection || PW.navigator.mozConnection || PW.navigator.webkitConnection;
            return c ? (c.effectiveType || '-') : '-';
        } catch (e) { return '-'; }
    }

    const tryPlay = function (v) {
        try {
            if (!v || typeof v.play !== 'function') return;
            const p = v.play();
            if (p && typeof p.catch === 'function') {
                p.catch(function (e) {
                    Logger.debug('Session', 'autoplay blocked', e && e.name);
                    // 浏览器阻止自动播放时，标记已尝试，避免下次 canplay 再次尝试触发浏览器策略拒绝
                    if (v.__vaSession) v.__vaSession._playedOnce = true;
                });
            }
        } catch (e) {
            Logger.debug('Session', 'play threw', e && e.message);
            if (v.__vaSession) v.__vaSession._playedOnce = true;
        }
    };

    function videoFromEvent(e) {
        try {
            const path = e.composedPath ? e.composedPath() : [];
            for (let i = 0; i < Math.min(path.length, 8); i++) {
                const n = path[i];
                if (n && n.nodeName === 'VIDEO') return n;
            }
            let el = e.target;
            for (let i = 0; i < 6 && el; i++) {
                if (el.nodeName === 'VIDEO') return el;
                if (el.nodeType === 1 && el.querySelector) {
                    const v = el.querySelector('video');
                    if (v) return v;
                }
                el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
            }
        } catch (err) { }
        return null;
    }

    const CandidateState = {
        DETECTED: 'detected',
        STANDBY: 'standby',
        ACTIVE: 'active',
        IGNORED: 'ignored',
        EXPIRED: 'expired'
    };

    const SessionState = {
        ATTACHED: 'attached',
        ACTIVE: 'active',
        USER_PAUSED: 'user_paused',
        DEGRADED: 'degraded',
        RECOVERING: 'recovering',
        FAILED: 'failed',
        DORMANT: 'dormant',
        DESTROYED: 'destroyed'
    };

    const AD_SELECTOR_STRONG = [
        '[data-ad]',
        '[data-ad-unit]',
        '[id^="ad_"]',
        '[id^="ad-"]',
        '[class^="ad-container"]',
        '[class*="advert"]',
        '[aria-label*="advertisement"]'
    ].join(',');

    const SITE_PROFILES = [
        // 示例：
        // {
        //     host: 'example.com',
        //     primarySelector: '.main-player video',
        //     ignoreSelectors: ['.ad video', '.recommend video'],
        //     minVideoArea: 120000
        // }
    ];

    function getSiteProfile() {
        try {
            const host = LOC.hostname || '';
            for (let i = 0; i < SITE_PROFILES.length; i++) {
                const p = SITE_PROFILES[i];
                if (p && p.host && host.indexOf(p.host) >= 0) return p;
            }
        } catch (e) { }
        return null;
    }

    let LAST_SIGNAL_AT = NOW();

    /* ═══════════════════════════════════════════════════════════
       EventBus
    ═══════════════════════════════════════════════════════════ */

    class EventBus {
        constructor() {
            this._handlers = Object.create(null);
        }
        on(type, fn) {
            if (!this._handlers[type]) this._handlers[type] = [];
            this._handlers[type].push(fn);
            return () => this.off(type, fn);
        }
        off(type, fn) {
            const arr = this._handlers[type];
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx >= 0) arr.splice(idx, 1);
        }
        emit(type, payload) {
            const arr = this._handlers[type];
            if (!arr || !arr.length) return;
            const copy = arr.slice();
            for (const fn of copy) {
                try { fn(payload); } catch (e) { }
            }
        }
    }

    const Bus = new EventBus();
    Bus.on('SIGNAL_RAW', function () { LAST_SIGNAL_AT = NOW(); });

    /* ═══════════════════════════════════════════════════════════
       Storage
    ═══════════════════════════════════════════════════════════ */

    const Storage = {
        _gmGet: (typeof GM_getValue === 'function') ? GM_getValue : null,
        _gmSet: (typeof GM_setValue === 'function') ? GM_setValue : null,
        _ls: (function () {
            try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
        })(),
        get(key, def) {
            if (this._gmGet) {
                try { return this._gmGet(key, def); } catch (e) { }
            }
            if (this._ls) {
                try {
                    const v = this._ls.getItem(key);
                    return v === null ? def : v;
                } catch (e) { }
            }
            return def;
        },
        set(key, value) {
            if (this._gmSet) {
                try { this._gmSet(key, value); return; } catch (e) { }
            }
            if (this._ls) {
                try { this._ls.setItem(key, value); } catch (e) { }
            }
        }
    };

    /* ═══════════════════════════════════════════════════════════
       ConfigManager
    ═══════════════════════════════════════════════════════════ */

    const STORAGE_KEY = 'va_config_v19_0';
    const STORAGE_KEY_V18 = 'va_config_v18_0';

    class ConfigManagerClass {
        constructor(bus) {
            this.bus = bus;
            this._cache = null;
            this.defaults = {
                autoPlay: true,
                bigBuffer: true,
                seekGuard: true,
                watchdog: true,
                autoDowngrade: true,
                bufferTarget: 60,
                seekTimeout: 5000,

                showToast: true,
                showDetect: true,
                logLevel: 'info',

                minPreBuffer: 2,
                fastDetect: true,
                fetchPriority: true,
                visibleOnly: true,
                minVideoArea: 8000,

                protoHook: true,
                earlyPointer: true,
                preconnect: true,
                rvfcMonitor: true,
                instantPlay: true,

                qualityManage: true,

                userIntentFirst: true,
                standbyMode: true,
                adGuard: true,
                recoveryBudget: 8,
                frameMesh: true
            };
            this._installRequests();
        }

        load() {
            if (this._cache) return this._cache;

            let raw = null;
            let migrated = false;

            try { raw = Storage.get(STORAGE_KEY, null); } catch (e) { }

            if (raw === null || raw === undefined || raw === '') {
                try {
                    const old = Storage.get(STORAGE_KEY_V18, null);
                    if (old !== null && old !== undefined) {
                        raw = old;
                        migrated = true;
                    }
                } catch (e) { }
            }

            let obj = null;
            if (typeof raw === 'string') {
                try { obj = JSON.parse(raw); } catch (e) { obj = null; }
            } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                obj = raw;
            }

            this._cache = Object.assign({}, this.defaults, obj || {});
            this._normalize();

            if (migrated) {
                try { this.save(); } catch (e) { }
            }

            return this._cache;
        }

        _normalize() {
            const c = this._cache;

            c.bufferTarget = clamp(parseInt(c.bufferTarget, 10) || 60, 10, 300);
            c.minPreBuffer = clamp(parseInt(c.minPreBuffer, 10) || 2, 1, 30);
            c.seekTimeout = clamp(parseInt(c.seekTimeout, 10) || 5000, 2000, 15000);
            c.recoveryBudget = clamp(parseInt(c.recoveryBudget, 10) || 8, 1, 20);

            const mva = parseInt(c.minVideoArea, 10);
            c.minVideoArea = isNaN(mva) ? 8000 : Math.max(0, mva);

            const levels = ['debug', 'info', 'warn', 'error'];
            if (levels.indexOf(c.logLevel) < 0) c.logLevel = 'info';

            const boolKeys = [
                'autoPlay', 'bigBuffer', 'seekGuard', 'watchdog', 'autoDowngrade',
                'showToast', 'showDetect', 'fastDetect', 'fetchPriority', 'visibleOnly',
                'protoHook', 'earlyPointer', 'preconnect', 'rvfcMonitor', 'instantPlay',
                'qualityManage', 'userIntentFirst', 'standbyMode', 'adGuard', 'frameMesh'
            ];
            boolKeys.forEach(function (k) { c[k] = !!c[k]; });
        }

        save() {
            try { Storage.set(STORAGE_KEY, JSON.stringify(this.load())); } catch (e) { }
        }

        get(k) {
            return this.load()[k];
        }

        set(k, v) {
            const c = this.load();
            c[k] = v;
            this._normalize();
            this.save();
            this.bus.emit('CONFIG_CHANGE', { key: k, value: c[k], config: c, local: true });
        }

        _applyPatch(patch, emit) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
            const c = this.load();
            Object.assign(c, patch);
            this._normalize();
            this.save();
            if (emit) {
                this.bus.emit('CONFIG_CHANGE', { batch: true, config: this.load(), local: true });
            }
        }

        update(patch) {
            this._applyPatch(patch, true);
        }

        silentUpdate(patch) {
            this._applyPatch(patch, false);
        }

        exportJSON() {
            return JSON.stringify(this.load(), null, 2);
        }

        importJSON(str) {
            try {
                const obj = JSON.parse(str);
                if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
                this._cache = Object.assign({}, this.defaults, obj);
                this._normalize();
                this.save();
                this.bus.emit('CONFIG_CHANGE', { import: true, config: this.load(), local: true });
                return true;
            } catch (e) {
                return false;
            }
        }

        reset() {
            this._cache = Object.assign({}, this.defaults);
            this._normalize();
            this.save();
            this.bus.emit('CONFIG_CHANGE', { reset: true, config: this.load(), local: true });
        }

        applyRemote(config) {
            if (!config || typeof config !== 'object' || Array.isArray(config)) return;
            this._cache = Object.assign({}, this.defaults, config);
            this._normalize();
            this.bus.emit('CONFIG_CHANGE', { remote: true, config: this.load() });
        }

        _installRequests() {
            this.bus.on('CONFIG_EXPORT_REQUEST', () => {
                this.bus.emit('CONFIG_EXPORT_RESULT', { json: this.exportJSON() });
            });
            this.bus.on('CONFIG_IMPORT_REQUEST', (payload) => {
                const json = payload && payload.json;
                const ok = this.importJSON(json);
                this.bus.emit('CONFIG_IMPORT_RESULT', { ok: ok });
            });
            this.bus.on('CONFIG_RESET_REQUEST', () => {
                this.reset();
            });
            this.bus.on('CONFIG_SET', (payload) => {
                if (!payload || !payload.key) return;
                this.set(payload.key, payload.value);
            });
            this.bus.on('CONFIG_UPDATE', (payload) => {
                this.update(payload);
            });
        }
    }

    const ConfigManager = new ConfigManagerClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       Logger / Metrics
    ═══════════════════════════════════════════════════════════ */

    const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

    class LoggerClass {
        constructor(bus) {
            this.bus = bus;
        }
        _minLevel() {
            const lv = ConfigManager.get('logLevel') || 'info';
            return LOG_LEVELS[lv] || LOG_LEVELS.info;
        }
        log(level, scope, message, data) {
            const num = LOG_LEVELS[level] || LOG_LEVELS.info;
            if (num < this._minLevel()) return;
            const entry = {
                ts: NOW(),
                level: level,
                scope: scope,
                message: message,
                data: data === undefined ? null : data,
                remote: false
            };
            this.bus.emit('LOG_EMIT', entry);
        }
        debug(scope, msg, data) { this.log('debug', scope, msg, data); }
        info(scope, msg, data) { this.log('info', scope, msg, data); }
        warn(scope, msg, data) { this.log('warn', scope, msg, data); }
        error(scope, msg, data) { this.log('error', scope, msg, data); }
    }

    const Logger = new LoggerClass(Bus);

    const Metrics = {
        counters: Object.create(null),
        inc(name, value) {
            value = value || 1;
            this.counters[name] = (this.counters[name] || 0) + value;
            Bus.emit('METRIC_EMIT', { type: 'counter', name: name, value: value });
        }
    };

    /* ═══════════════════════════════════════════════════════════
       GlobalScheduler / ListenerBag / UserGesture
    ═══════════════════════════════════════════════════════════ */

    class GlobalSchedulerClass {
        constructor(bus) {
            this.bus = bus;
            this.tasks = new Map();
            this.last = { fast: 0, normal: 0, slow: 0, ui: 0 };
            this.intervals = { fast: 250, normal: 800, slow: 3000, ui: 500 };
            this.hidden = false;
            this._timer = null;
        }

        register(id, handlers) {
            this.tasks.set(id, handlers || {});
        }

        unregister(id) {
            this.tasks.delete(id);
        }

        isHidden() {
            return this.hidden;
        }

        setHidden(hidden) {
            this.hidden = !!hidden;
        }

        start() {
            if (this._timer) return;

            const loop = () => {
                const now = NOW();
                const tiers = ['fast', 'normal', 'slow', 'ui'];

                for (const tier of tiers) {
                    let interval = this.intervals[tier];

                    if (this.hidden) {
                        if (tier === 'fast') interval *= 4;
                        else if (tier === 'normal') interval *= 3;
                        else if (tier === 'ui') interval *= 2;
                    }

                    if (now - this.last[tier] >= interval) {
                        this.last[tier] = now;
                        this.tasks.forEach((handlers) => {
                            try {
                                if (typeof handlers[tier] === 'function') handlers[tier]();
                            } catch (e) { }
                        });
                    }
                }

                this._timer = PW.setTimeout(loop, 120);
            };

            loop();
        }
    }

    const Scheduler = new GlobalSchedulerClass(Bus);

    try {
        DOC.addEventListener('visibilitychange', function () {
            Scheduler.setHidden(DOC.hidden);
        }, true);
    } catch (e) { }

    class ListenerBag {
        constructor() {
            this.items = [];
        }

        add(target, type, fn, opts) {
            if (!target || typeof target.addEventListener !== 'function') return;
            target.addEventListener(type, fn, opts);
            this.items.push({ target: target, type: type, fn: fn, opts: opts });
        }

        removeAll() {
            for (const item of this.items) {
                try {
                    item.target.removeEventListener(item.type, item.fn, item.opts);
                } catch (e) { }
            }
            this.items = [];
        }
    }

    const UserGesture = {
        lastGestureAt: 0,
        mark() {
            this.lastGestureAt = NOW();
        },
        recent(windowMs) {
            windowMs = windowMs || 3000;
            return NOW() - this.lastGestureAt < windowMs;
        }
    };

    /* ═══════════════════════════════════════════════════════════
       StateStore
    ═══════════════════════════════════════════════════════════ */

    // 模块级空闲状态工厂，供外部复用
    function getIdleState() {
        return {
            status: '未检测到视频',
            statusKey: 'idle',
            sessionState: 'idle',
            playerType: 'unknown',
            playerLabel: '-',
            buffer: 0,
            recoveries: 0,
            videos: 0,
            currentTime: 0,
            duration: 0,
            videoWidth: 0,
            videoHeight: 0,
            readyState: 0,
            networkType: getNetworkType(),
            quality: { level: -1, total: 0, bandwidth: 0, height: 0 },
            canChangeQuality: false,
            bandwidth: 0,
            seeking: false,
            stallLevel: 0,
            userPaused: false
        };
    }

    class StateStoreClass {
        constructor(bus) {
            this.bus = bus;
            this.local = null;
            this.remote = new Map();
            this._last = 0;

            this.bus.on('LOCAL_STATE', (state) => {
                this.local = state;
                this._aggregate();
            });

            this.bus.on('REMOTE_STATE', (payload) => {
                if (!payload || !payload.state) return;
                const id = payload.iframeId || 'unknown';
                this.remote.set(id, { state: payload.state, ts: NOW() });
                this._aggregate();
            });

            this.bus.on('STATE_TICK', () => this._aggregate(true));
        }

        _idle() {
            return getIdleState();
        }

        _aggregate(force) {
            const now = NOW();
            if (!force && now - this._last < 500) return;
            this._last = now;

            const cutoff = now - 15000;
            let remoteVideos = 0;
            let remoteRecoveries = 0;
            let latest = null;
            let latestTs = 0;

            this.remote.forEach((entry, key) => {
                if (!entry || entry.ts < cutoff) {
                    this.remote.delete(key);
                    return;
                }
                const st = entry.state || {};
                remoteVideos += st.videos || 0;
                remoteRecoveries += st.recoveries || 0;
                if (entry.ts >= latestTs) {
                    latestTs = entry.ts;
                    latest = st;
                }
            });

            const local = this.local || this._idle();
            const videos = (local.videos || 0) + remoteVideos;
            const recoveries = (local.recoveries || 0) + remoteRecoveries;

            let base;
            if (local.videos > 0) base = local;
            else if (latest) base = latest;
            else base = this._idle();

            const agg = Object.assign({}, base, { videos: videos, recoveries: recoveries });
            this.bus.emit('STATE_AGGREGATED', agg);
        }
    }

    const StateStore = new StateStoreClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       FrameMesh
    ═══════════════════════════════════════════════════════════ */

    class FrameMeshClass {
        constructor(bus) {
            this.bus = bus;
            this.frames = new Map();
            this.rate = new Map();
            this._initListener();
            this._install();
        }

        _postTop(type, payload) {
            if (!IS_TOP && PW.top) {
                try {
                    PW.top.postMessage(Object.assign({
                        __va_msg: true,
                        ver: 19,
                        type: type,
                        frameId: IFRAME_ID,
                        ts: NOW()
                    }, payload || {}), '*');
                } catch (e) { }
            }
        }

        broadcastToFrames(type, payload) {
            try {
                const msg = Object.assign({
                    __va_msg: true,
                    ver: 19,
                    type: type,
                    ts: NOW()
                }, payload || {});

                HOOKED_DOCS.forEach(function (doc) {
                    try {
                        if (!doc || typeof doc.querySelectorAll !== 'function') return;
                        const iframes = doc.querySelectorAll('iframe');
                        iframes.forEach(function (iframe) {
                            try {
                                if (iframe.contentWindow) iframe.contentWindow.postMessage(msg, '*');
                            } catch (e) { }
                        });
                    } catch (e) { }
                });
            } catch (e) { }
        }

        _allowed(frameId) {
            if (!frameId) return false;
            const now = NOW();
            let r = this.rate.get(frameId);
            if (!r) {
                r = { count: 0, ts: now };
                this.rate.set(frameId, r);
            }
            if (now - r.ts > 1000) {
                r.count = 0;
                r.ts = now;
            }
            r.count++;
            return r.count <= 30;
        }

        _initListener() {
            PW.addEventListener('message', (e) => {
                // 安全加固（M4）：仅接受与当前文档同源的帧消息，
                // 防止任意跨域 iframe 伪造 VA_CFG_SYNC/VA_CMD 越权改写配置或下发命令。
                // 注意：这会令「跨子域 iframe」间的协调失效——属安全优先的可接受权衡。
                if (e.origin && e.origin !== PW.location.origin) return;

                const d = e.data;
                if (!d || typeof d !== 'object' || !d.__va_msg || d.ver !== 19) return;
                if (IS_TOP && d.frameId && !this._allowed(d.frameId)) return;
                this._handle(d, e.source);
            });
        }

        _handle(d, source) {
            if (IS_TOP) {
                if (d.type === 'VA_STATE_UPDATE') {
                    this.frames.set(d.frameId, { lastSeen: NOW() });
                    this.bus.emit('REMOTE_STATE', { iframeId: d.frameId, state: d.state });
                } else if (d.type === 'VA_LOG') {
                    const entry = Object.assign({
                        ts: NOW(),
                        level: 'info',
                        scope: 'iframe',
                        message: '',
                        data: null,
                        remote: true
                    }, d.entry || {});
                    this.bus.emit('LOG_EMIT', entry);
                } else if (d.type === 'VA_TOAST') {
                    this.bus.emit('TOAST', { msg: d.msg, kind: d.kind, remote: true });
                } else if (d.type === 'VA_REQ_CFG') {
                    try {
                        source.postMessage({
                            __va_msg: true,
                            ver: 19,
                            type: 'VA_CFG_SYNC',
                            config: ConfigManager.load()
                        }, '*');
                    } catch (e) { }
                } else if (d.type === 'VA_HELLO_ACK') {
                    this.frames.set(d.frameId, { lastSeen: NOW() });
                } else if (d.type === 'VA_BYE') {
                    this.frames.delete(d.frameId);
                }
            } else {
                if (d.type === 'VA_CFG_SYNC') {
                    ConfigManager.applyRemote(d.config);
                } else if (d.type === 'VA_CMD') {
                    this.bus.emit('CMD', { cmd: d.cmd, remote: true });
                }
            }
        }

        _install() {
            this.bus.on('LOCAL_STATE', (state) => {
                if (!IS_TOP) this._postTop('VA_STATE_UPDATE', { state: state });
            });

            this.bus.on('LOG_EMIT', (entry) => {
                if (!IS_TOP && entry && !entry.remote) this._postTop('VA_LOG', { entry: entry });
            });

            this.bus.on('TOAST', (payload) => {
                if (!IS_TOP && payload && !payload.remote) this._postTop('VA_TOAST', payload);
            });

            this.bus.on('CONFIG_CHANGE', (payload) => {
                if (IS_TOP && !(payload && payload.remote)) {
                    this.broadcastToFrames('VA_CFG_SYNC', { config: ConfigManager.load() });
                }
            });

            this.bus.on('CMD', (payload) => {
                if (IS_TOP && !(payload && payload.remote)) {
                    this.broadcastToFrames('VA_CMD', { cmd: payload && payload.cmd });
                }
            });

            if (!IS_TOP) {
                this._postTop('VA_HELLO_ACK', {});
                this._postTop('VA_REQ_CFG', {});
            }

            if (IS_TOP) {
                Scheduler.register('frame-mesh', {
                    slow: () => {
                        const now = NOW();
                        this.frames.forEach((f, id) => {
                            if (now - f.lastSeen > 30000) this.frames.delete(id);
                        });
                    }
                });
            }
        }
    }

    const FrameMesh = new FrameMeshClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       preconnect
    ═══════════════════════════════════════════════════════════ */

    const preconnectedHosts = new Set();

    function addPreconnect(url, doc) {
        try {
            if (!ConfigManager.get('preconnect')) return;
            if (!url || url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return;

            const host = getHost(url);
            if (!host || host === LOC.host || preconnectedHosts.has(host)) return;
            preconnectedHosts.add(host);

            const D = doc || DOC;
            const append = function () {
                try {
                    const target = D.head || D.documentElement;
                    if (!target) return;

                    const dns = D.createElement('link');
                    dns.rel = 'dns-prefetch';
                    dns.href = '//' + host;
                    target.appendChild(dns);

                    const pre = D.createElement('link');
                    pre.rel = 'preconnect';
                    pre.href = '//' + host;
                    pre.crossOrigin = 'anonymous';
                    target.appendChild(pre);
                } catch (e) { }
            };

            const target = D.head || D.documentElement;
            if (target) append();
            else D.addEventListener('DOMContentLoaded', append, { once: true });
        } catch (e) { }
    }

    /* ═══════════════════════════════════════════════════════════
       HookManager
    ═══════════════════════════════════════════════════════════ */

    class HookManagerClass {
        constructor(bus) {
            this.bus = bus;
        }

        installAll(win, doc) {
            try { this.installFetch(win); } catch (e) { }
            try { this.patchMediaPrototype(win); } catch (e) { }
            try { this.addGesture(doc); } catch (e) { }
        }

        installFetch(W) {
            W = W || PW;
            try {
                if (!W.fetch || W.fetch.__vaPatched) return;
                const base = W.fetch;

                const wrapped = function (input, init) {
                    try {
                        if (ConfigManager.get('fetchPriority')) {
                            let url = '';
                            if (typeof input === 'string') url = input;
                            else if (input && input.url) url = input.url;

                            if (isVideoResource(url)) {
                                const newInit = Object.assign({}, init || {});
                                newInit.priority = 'high';
                                addPreconnect(url, W.document || DOC);
                                return base.call(this, input, newInit);
                            }
                        }
                    } catch (e) { }
                    return base.apply(this, arguments);
                };

                wrapped.__vaPatched = true;
                W.fetch = wrapped;
            } catch (e) { }
        }

        patchMediaPrototype(W) {
            W = W || PW;
            if (!W || !W.HTMLMediaElement || W.HTMLMediaElement.__vaPatched) return;

            try {
                const Proto = W.HTMLMediaElement.prototype;
                const bus = this.bus;

                const srcDesc = Object.getOwnPropertyDescriptor(Proto, 'src');
                if (srcDesc && srcDesc.get && srcDesc.set) {
                    Object.defineProperty(Proto, 'src', {
                        configurable: true,
                        enumerable: true,
                        get: function () {
                            return srcDesc.get.call(this);
                        },
                        set: function (v) {
                            srcDesc.set.call(this, v);
                            try {
                                addPreconnect(v, this.ownerDocument);
                                if (ConfigManager.get('protoHook')) {
                                    bus.emit('SIGNAL_RAW', {
                                        video: this,
                                        source: 'proto-src',
                                        userGesture: UserGesture.recent(),
                                        forceHint: true,
                                        ts: NOW(),
                                        context: { reason: 'src' }
                                    });
                                }
                            } catch (e) { }
                        }
                    });
                }

                const origPlay = Proto.play;
                if (typeof origPlay === 'function' && !origPlay.__vaPatched) {
                    Proto.play = function () {
                        try {
                            if (ConfigManager.get('protoHook')) {
                                bus.emit('SIGNAL_RAW', {
                                    video: this,
                                    source: 'proto-play',
                                    userGesture: UserGesture.recent(),
                                    forceHint: true,
                                    ts: NOW(),
                                    context: { reason: 'play' }
                                });
                            }
                            if (ConfigManager.get('instantPlay')) {
                                bus.emit('SIGNAL_BOOST', { video: this, reason: 'play' });
                            }
                            addPreconnect(this.currentSrc || this.src, this.ownerDocument);
                        } catch (e) { }
                        return origPlay.apply(this, arguments);
                    };
                    Proto.play.__vaPatched = true;
                }

                const origLoad = Proto.load;
                if (typeof origLoad === 'function' && !origLoad.__vaPatched) {
                    Proto.load = function () {
                        try {
                            if (ConfigManager.get('protoHook')) {
                                bus.emit('SIGNAL_RAW', {
                                    video: this,
                                    source: 'proto-load',
                                    userGesture: UserGesture.recent(),
                                    forceHint: false,
                                    ts: NOW(),
                                    context: { reason: 'load' }
                                });
                            }
                            bus.emit('SIGNAL_BOOST', { video: this, reason: 'load' });
                        } catch (e) { }
                        return origLoad.apply(this, arguments);
                    };
                    Proto.load.__vaPatched = true;
                }

                W.HTMLMediaElement.__vaPatched = true;
            } catch (e) { }
        }

        addGesture(doc) {
            if (!doc || doc.__vaGesture) return;

            try {
                doc.__vaGesture = true;
                const bus = this.bus;

                const handler = function (e) {
                    try {
                        UserGesture.mark();

                        if (!ConfigManager.get('earlyPointer')) return;

                        const t = e.target;
                        if (
                            t &&
                            t.closest &&
                            t.nodeName !== 'VIDEO' &&
                            t.closest('button, input, select, textarea, a, label, [role="button"], [role="slider"], [role="menuitem"]')
                        ) {
                            return;
                        }

                        const video = videoFromEvent(e);
                        if (!video) return;

                        bus.emit('SIGNAL_RAW', {
                            video: video,
                            source: 'gesture-pointer',
                            userGesture: true,
                            forceHint: true,
                            ts: NOW(),
                            context: { reason: e.type || 'gesture' }
                        });

                        bus.emit('SIGNAL_BOOST', { video: video, reason: 'gesture' });

                        if (ConfigManager.get('autoPlay') && video.paused && !video.ended) {
                            const s = video.__vaSession;
                            if (!s || !s._userPaused) {
                                tryPlay(video);
                            }
                        }
                    } catch (err) { }
                };

                ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach(function (ev) {
                    doc.addEventListener(ev, handler, { capture: true, passive: true });
                });
            } catch (e) { }
        }
    }

    const HookManager = new HookManagerClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       Detector
    ═══════════════════════════════════════════════════════════ */

    class DetectorClass {
        constructor(bus) {
            this.bus = bus;
            this._hookedDocs = new WeakSet();
            this._observedDocs = new WeakSet();
            this._pendingNodes = new Set();
            this._scanScheduled = false;
            this._viewportObs = null;
            this._viewportTargets = new WeakSet();
            this._spaInstalled = false;
            this._initViewportObserver();
        }

        start() {
            this._setupDoc(DOC, PW);
            this._installSpa();

            try {
                DOC.addEventListener('load', (e) => {
                    const t = e.target;
                    if (t && t.nodeName === 'IFRAME') this._hookIframe(t);
                }, true);
            } catch (e) { }

            Scheduler.register('detector', {
                slow: () => this._patrol()
            });
        }

        _installSpa() {
            if (this._spaInstalled) return;
            this._spaInstalled = true;

            const emitRoute = () => {
                this.bus.emit('SPA_ROUTE_CHANGED', {});
                this._scheduleScan();
                PW.setTimeout(() => this.refresh(), 800);
                PW.setTimeout(() => this.refresh(), 2000);
            };

            try {
                const origPush = PW.history && PW.history.pushState;
                if (typeof origPush === 'function') {
                    PW.history.pushState = function () {
                        const r = origPush.apply(this, arguments);
                        emitRoute();
                        return r;
                    };
                }

                const origReplace = PW.history && PW.history.replaceState;
                if (typeof origReplace === 'function') {
                    PW.history.replaceState = function () {
                        const r = origReplace.apply(this, arguments);
                        emitRoute();
                        return r;
                    };
                }

                PW.addEventListener('popstate', emitRoute);
                PW.addEventListener('hashchange', emitRoute);
            } catch (e) { }
        }

        _setupDoc(doc, win) {
            if (!doc) return;
            win = win || (doc.defaultView || PW);

            HOOKED_DOCS.add(doc);

            try {
                HookManager.installAll(win, doc);
            } catch (e) { }

            if (this._hookedDocs.has(doc)) return;
            this._hookedDocs.add(doc);

            try {
                if (doc.documentElement) this._scanWithin(doc.documentElement);
            } catch (e) { }

            this._observeDoc(doc, win);
        }

        _observeDoc(doc, win) {
            if (!doc || this._observedDocs.has(doc)) return;

            const MO = (win && win.MutationObserver) || PW.MutationObserver;
            if (!MO || !doc.documentElement) return;

            this._observedDocs.add(doc);

            try {
                const obs = new MO((muts) => this._onMutations(muts));
                obs.observe(doc.documentElement, { childList: true, subtree: true });
            } catch (e) { }
        }

        _initViewportObserver() {
            if (this._viewportObs || typeof PW.IntersectionObserver !== 'function') return;

            this._viewportObs = new PW.IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting && entry.target.nodeName === 'VIDEO') {
                        this.bus.emit('SIGNAL_RAW', {
                            video: entry.target,
                            source: 'viewport',
                            userGesture: UserGesture.recent(),
                            forceHint: true,
                            ts: NOW(),
                            context: { reason: 'viewport' }
                        });
                        this.bus.emit('SIGNAL_BOOST', { video: entry.target, reason: 'viewport' });

                        try {
                            this._viewportObs.unobserve(entry.target);
                            this._viewportTargets.delete(entry.target);
                        } catch (e) { }
                    }
                }
            }, { rootMargin: '400px' });
        }

        watchViewport(video) {
            if (!video) return;
            if (this._viewportTargets.has(video)) return;

            if (this._viewportObs && video.ownerDocument === DOC) {
                this._viewportTargets.add(video);
                try { this._viewportObs.observe(video); } catch (e) { }
            } else {
                this.bus.emit('SIGNAL_RAW', {
                    video: video,
                    source: 'viewport-direct',
                    userGesture: UserGesture.recent(),
                    forceHint: false,
                    ts: NOW(),
                    context: { reason: 'viewport-direct' }
                });
            }
        }

        _onMutations(muts) {
            if (!ConfigManager.get('fastDetect')) return;

            let need = false;

            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;

                    if (node.nodeName === 'VIDEO') {
                        this.bus.emit('SIGNAL_RAW', {
                            video: node,
                            source: 'mutation',
                            userGesture: UserGesture.recent(),
                            forceHint: false,
                            ts: NOW(),
                            context: { reason: 'mutation' }
                        });
                        need = true;
                    } else if (node.nodeName === 'IFRAME') {
                        this._hookIframe(node);
                        need = true;
                    } else if (node.querySelector) {
                        this._pendingNodes.add(node);
                        need = true;
                    }
                }
            }

            if (need) this._scheduleScan();
        }

        _scheduleScan() {
            if (this._scanScheduled) return;
            this._scanScheduled = true;

            const flush = () => {
                this._scanScheduled = false;
                const nodes = Array.from(this._pendingNodes);
                this._pendingNodes.clear();

                for (const n of nodes) {
                    try {
                        if (n.isConnected) this._scanWithin(n);
                    } catch (e) { }
                }
            };

            raf(flush);
        }

        _hookIframe(f) {
            if (!f || f.nodeName !== 'IFRAME') return false;

            let doc = null;
            let win = null;

            try {
                win = f.contentWindow;
                doc = win ? win.document : null;
            } catch (e) { }

            if (doc && doc.documentElement) {
                this._setupDoc(doc, win);
                return true;
            }

            try {
                f.addEventListener('load', () => {
                    try {
                        const w = f.contentWindow;
                        const d = w && w.document;
                        if (d && d.documentElement) this._setupDoc(d, w);
                    } catch (e) { }
                }, { once: true });
            } catch (e) { }

            return false;
        }

        _scanWithin(root) {
            if (!root) return;

            try {
                const name = root.nodeName || '';

                if (name === 'VIDEO') {
                    this.bus.emit('SIGNAL_RAW', {
                        video: root,
                        source: 'scan',
                        userGesture: UserGesture.recent(),
                        forceHint: false,
                        ts: NOW(),
                        context: { reason: 'scan' }
                    });
                } else if (name === 'IFRAME') {
                    this._hookIframe(root);
                }

                if (root.querySelectorAll) {
                    const els = root.querySelectorAll('video,iframe');
                    const limit = Math.min(els.length, VA_TUNING.SCAN_VIDEO_CAP);

                    for (let i = 0; i < limit; i++) {
                        const el = els[i];
                        if (el.nodeName === 'VIDEO') {
                            this.bus.emit('SIGNAL_RAW', {
                                video: el,
                                source: 'scan',
                                userGesture: UserGesture.recent(),
                                forceHint: false,
                                ts: NOW(),
                                context: { reason: 'scan' }
                            });
                        } else if (el.nodeName === 'IFRAME') {
                            this._hookIframe(el);
                        }
                    }
                }
            } catch (e) { }

            try {
                if (root.querySelectorAll) {
                    // 仅在「带 class/id 的元素」中查找 shadowRoot 宿主，避免对超大 DOM 做
                    // querySelectorAll('*') 全量遍历（性能优化，主功能仍由 video/iframe 选择器保证）
                    const all = root.querySelectorAll('[class],[id]');
                    const limit = Math.min(all.length, VA_TUNING.SCAN_SHADOW_CAP);

                    for (let i = 0; i < limit; i++) {
                        const sr = all[i].shadowRoot;
                        if (sr) this._scanWithin(sr);
                    }
                }
            } catch (e) { }
        }

        refresh() {
            try {
                if (DOC.documentElement) this._scanWithin(DOC.documentElement);
            } catch (e) { }
        }

        _patrol() {
            if (Scheduler.isHidden()) return;
            if (!DOC) return;

            try {
                if (
                    typeof SessionManager !== 'undefined' &&
                    SessionManager.sessions.size > 0 &&
                    NOW() - LAST_SIGNAL_AT < VA_TUNING.PATROL_COOLDOWN_MS
                ) {
                    return;
                }
            } catch (e) { }

            try { this.refresh(); } catch (e) { }
            this.bus.emit('PATROL', {});
        }
    }

    const Detector = new DetectorClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       Player Adapter
    ═══════════════════════════════════════════════════════════ */

    const PLAYER_LABEL = {
        hls: 'HLS.js',
        dash: 'dash.js',
        shaka: 'Shaka',
        mse: 'MSE',
        native: '原生',
        videojs: 'Video.js',
        jw: 'JW',
        unknown: '未知'
    };

    function getHls(video) {
        const keys = ['hls', '_hls', '__hls', 'hlsjs', 'hlsPlayer', '__hlsjs'];
        for (const k of keys) {
            try {
                const h = video[k];
                if (h && typeof h === 'object' && (h.config || h.startLoad || h.recoverMediaError)) {
                    return h;
                }
            } catch (e) { }
        }
        return null;
    }

    function getDash(video) {
        const keys = ['dashjs', '_dashjs', '__dashjs', 'dash'];
        for (const k of keys) {
            try {
                const d = video[k];
                if (d && typeof d === 'object' && (d.refreshManifest || d.getBufferLength || d.attachSource)) {
                    return d;
                }
            } catch (e) { }
        }
        return null;
    }

    function applyHlsConfig(hls) {
        if (!hls || !hls.config) return;

        try {
            const big = ConfigManager.get('bigBuffer');
            const target = clamp(parseInt(ConfigManager.get('bufferTarget'), 10) || 60, 10, 300);

            hls.config.maxBufferLength = big ? 90 : Math.max(30, target);
            hls.config.maxMaxBufferLength = big ? 360 : 180;
            hls.config.maxBufferHole = 0.2;
            hls.config.startFragPrefetch = true;
            hls.config.backBufferLength = big ? 60 : 30;
            hls.config.nudgeOffset = 0.1;
            hls.config.nudgeMaxRetry = 5;
            hls.config.fragLoadingMaxRetry = 6;
            hls.config.fragLoadingMaxRetryTimeout = 8000;
            hls.config.autoStartLoad = true;
        } catch (e) { }
    }

    const PlayerRegistry = {
        _map: new WeakMap(),
        get(v) {
            return this._map.get(v);
        },
        set(v, info) {
            this._map.set(v, info);
        }
    };

    const Adaptor = {
        detect(video) {
            const cached = PlayerRegistry.get(video);
            if (cached && cached.type !== 'unknown') return cached;

            let info = { type: 'unknown', player: null };

            try {
                const hls = getHls(video);
                if (hls) {
                    info = { type: 'hls', player: hls };
                    applyHlsConfig(hls);
                    PlayerRegistry.set(video, info);
                    return info;
                }

                const dash = getDash(video);
                if (dash) {
                    info = { type: 'dash', player: dash };
                    PlayerRegistry.set(video, info);
                    return info;
                }

                const src = video.currentSrc || video.src || '';
                if (src.indexOf('blob:') === 0) {
                    info = { type: 'mse', player: null };
                } else if (src) {
                    info = { type: 'native', player: null };
                } else {
                    info = { type: 'unknown', player: null };
                }
            } catch (e) { }

            PlayerRegistry.set(video, info);
            return info;
        },

        applyConfig(video) {
            const info = PlayerRegistry.get(video);
            if (info && info.type === 'hls' && info.player) {
                applyHlsConfig(info.player);
            }
        },

        canChangeQuality(video) {
            if (!ConfigManager.get('qualityManage')) return false;

            const info = PlayerRegistry.get(video);
            if (!info || info.type !== 'hls' || !info.player) return false;

            try {
                return Array.isArray(info.player.levels) && info.player.levels.length > 1;
            } catch (e) {
                return false;
            }
        },

        switchLevel(video, delta) {
            if (!this.canChangeQuality(video)) return false;

            const info = PlayerRegistry.get(video);
            const hls = info.player;

            try {
                const levels = hls.levels || [];
                let cur = hls.currentLevel;

                if (typeof cur !== 'number' || cur < 0) {
                    cur = (typeof hls.loadLevel === 'number' && hls.loadLevel >= 0) ? hls.loadLevel : 0;
                }

                const target = cur + delta;
                if (target < 0 || target >= levels.length) return false;

                hls.autoLevelEnabled = false;
                try { hls.nextLevel = target; } catch (e) { }
                try { if ('loadLevel' in hls) hls.loadLevel = target; } catch (e) { }

                return true;
            } catch (e) {
                return false;
            }
        },

        getInfo(video) {
            const info = PlayerRegistry.get(video);

            if (info && info.type === 'hls' && info.player) {
                try {
                    const levels = info.player.levels || [];
                    const cur = info.player.currentLevel;
                    const lv = (typeof cur === 'number' && cur >= 0 && levels[cur]) ? levels[cur] : null;

                    return {
                        level: (typeof cur === 'number') ? cur : -1,
                        total: levels.length,
                        bandwidth: lv ? (lv.bitrate || 0) : estimateBandwidth(),
                        height: lv ? (lv.height || 0) : (video.videoHeight || 0)
                    };
                } catch (e) { }
            }

            return {
                level: -1,
                total: 0,
                bandwidth: estimateBandwidth(),
                height: video.videoHeight || 0
            };
        },

        boost(video) {
            try {
                if (!video || video.nodeName !== 'VIDEO') return;

                video.preload = 'auto';

                const lazy = video.getAttribute && (video.getAttribute('data-src') || video.getAttribute('data-lazy-src'));
                if (lazy && !video.src && /^(https?:)?\/\//i.test(lazy)) video.src = lazy;

                addPreconnect(video.currentSrc || video.src, video.ownerDocument);
            } catch (e) { }
        },

        startLoad(video) {
            const info = PlayerRegistry.get(video);

            if (info && info.type === 'hls' && info.player) {
                try { info.player.startLoad(video.currentTime); } catch (e) { }
            } else {
                try { video.preload = 'auto'; } catch (e) { }
            }
        },

        reloadSegment(video) {
            const info = PlayerRegistry.get(video);

            if (info && info.type === 'hls' && info.player) {
                try { info.player.startLoad(video.currentTime); } catch (e) { }
            } else {
                try {
                    if (isFinite(video.duration) && video.duration > 0) {
                        video.currentTime = clamp(video.currentTime + 0.1, 0, video.duration - 0.1);
                    } else {
                        video.currentTime += 0.1;
                    }
                } catch (e) { }
            }
        },

        trimBack(video, seconds) {
            const info = PlayerRegistry.get(video);
            if (info && info.type === 'hls' && info.player && info.player.config) {
                try { info.player.config.backBufferLength = seconds; } catch (e) { }
            }
        }
    };

    /* ═══════════════════════════════════════════════════════════
       CandidateArbiter
    ═══════════════════════════════════════════════════════════ */

    class CandidateArbiterClass {
        constructor(bus) {
            this.bus = bus;
            this.pool = new WeakMap();
            this.queue = new Set();
            this.scheduled = false;

            this.bus.on('SIGNAL_RAW', (sig) => this.onSignal(sig));
            this.bus.on('PATROL', () => this._evaluateStale());
        }

        onSignal(sig) {
            if (!sig || !sig.video || sig.video.nodeName !== 'VIDEO') return;

            let candidate = this.pool.get(sig.video);
            if (!candidate) {
                candidate = this._createCandidate(sig.video);
                this.pool.set(sig.video, candidate);
            }

            this._mergeSignal(candidate, sig);
            this.queue.add(candidate);
            this._scheduleEvaluate();
        }

        _createCandidate(video) {
            return {
                video: video,
                state: CandidateState.DETECTED,
                score: 0,
                firstSeenAt: NOW(),
                lastSeenAt: NOW(),
                userGestureAt: 0,
                cooldownUntil: 0,
                lastEvaluatedAt: 0,
                signals: {
                    protoSrc: false,
                    protoPlay: false,
                    protoLoad: false,
                    gesture: false,
                    mutation: false,
                    viewport: false,
                    scan: false,
                    iframe: false
                },
                context: {
                    area: 0,
                    visible: false,
                    inViewport: false,
                    hasSrc: false,
                    mediaUrl: false,
                    blob: false,
                    playing: false,
                    duration: 0,
                    live: false,
                    muted: false,
                    loop: false,
                    adLike: false
                }
            };
        }

        _mergeSignal(candidate, sig) {
            candidate.lastSeenAt = sig.ts || NOW();

            if (sig.userGesture) {
                candidate.userGestureAt = NOW();
                UserGesture.mark();
            }

            const s = candidate.signals;

            if (sig.source === 'proto-src') s.protoSrc = true;
            else if (sig.source === 'proto-play') s.protoPlay = true;
            else if (sig.source === 'proto-load') s.protoLoad = true;
            else if (sig.source === 'gesture-pointer') s.gesture = true;
            else if (sig.source === 'mutation') s.mutation = true;
            else if (sig.source === 'viewport' || sig.source === 'viewport-direct') {
                s.viewport = true;
                candidate.context.inViewport = true;
            }
            else if (sig.source === 'scan') s.scan = true;
            else if (sig.source === 'iframe') s.iframe = true;
        }

        _refreshContext(candidate) {
            try {
                const v = candidate.video;
                const ctx = candidate.context;

                ctx.area = videoArea(v);
                ctx.visible = isVisible(v);
                ctx.playing = !v.paused && !v.ended;
                ctx.duration = isFinite(v.duration) ? v.duration : 0;
                ctx.live = isLive(v);
                ctx.muted = !!v.muted;
                ctx.loop = !!v.loop;

                const src = v.currentSrc || v.src || '';
                ctx.hasSrc = !!src;
                ctx.mediaUrl = isVideoResource(src);
                ctx.blob = src.indexOf('blob:') === 0;

                ctx.adLike = false;
                if (ConfigManager.get('adGuard') && v.closest) {
                    try {
                        ctx.adLike = !!v.closest(AD_SELECTOR_STRONG);
                    } catch (e) { }
                }
            } catch (e) { }
        }

        _scheduleEvaluate() {
            if (this.scheduled) return;
            this.scheduled = true;

            const run = () => {
                this.scheduled = false;
                this._evaluate();
            };

            raf(run);
        }

        _evaluate() {
            const now = NOW();

            this.queue.forEach((candidate) => {
                try {
                    if (!candidate.video.isConnected) {
                        this.pool.delete(candidate.video);
                        return;
                    }

                    this._refreshContext(candidate);
                    candidate.score = this.score(candidate);
                    candidate.lastEvaluatedAt = now;

                    if (candidate.context.adLike) {
                        candidate.state = CandidateState.IGNORED;
                        this.bus.emit('CANDIDATE_IGNORED', { candidate: candidate });
                        return;
                    }

                    if (candidate.score >= 70) {
                        if (candidate.cooldownUntil > now) return;
                        if (candidate.video.__vaSession) return;

                        candidate.cooldownUntil = now + VA_TUNING.ARBITER_COOLDOWN_MS;
                        candidate.state = CandidateState.ACTIVE;

                        this.bus.emit('TAKEOVER_DECIDED', {
                            video: candidate.video,
                            candidate: candidate,
                            score: candidate.score,
                            ts: now
                        });

                        Logger.debug('Arbiter', '接管决策 score=' + candidate.score, {
                            src: candidate.video.currentSrc || candidate.video.src || ''
                        });
                    } else if (candidate.score >= VA_TUNING.STANDBY_SCORE) {
                        candidate.state = CandidateState.STANDBY;

                        if (ConfigManager.get('standbyMode')) {
                            this.bus.emit('SIGNAL_BOOST', { video: candidate.video, reason: 'standby' });
                        }

                        this.bus.emit('CANDIDATE_UPDATED', { candidate: candidate });
                    } else {
                        candidate.state = CandidateState.DETECTED;
                    }
                } catch (e) { }
            });

            // 移除已断连视频的残留 candidate，防止内存泄漏
            // 注意：不可在此调用 this.queue.clear()，否则会清空全部在跟踪的候选，
            // 破坏持续监控（原代码的 clear() 即此 bug）
            this.queue = new Set([...this.queue].filter(c => c.video.isConnected));
        }

        _evaluateStale() {
            // 清理已断连视频的残留 candidate，防止内存泄漏
            // 在 PATROL 事件中定期执行，避免每次 _evaluate 都遍历全量
            if (this.queue.size === 0) return;
            const alive = new Set();
            this.queue.forEach(c => {
                if (c.video && c.video.isConnected) alive.add(c);
            });
            if (alive.size !== this.queue.size) {
                const beforeSize = this.queue.size;
                this.queue = alive;
                Logger.debug('CandidateArbiter', 'cleaned stale candidates', { before: beforeSize, after: alive.size });
            }
        }

        score(c) {
            const v = c.video;
            const ctx = c.context;
            const sig = c.signals;

            let score = 0;

            let minArea = ConfigManager.get('minVideoArea') || 0;
            const profile = getSiteProfile();
            if (profile && profile.minVideoArea) minArea = profile.minVideoArea;

            if (v.isConnected) score += 20;
            if (ctx.visible) score += 12;
            if (ctx.inViewport) score += 18;
            if (ctx.area >= minArea) score += 15;
            if (ctx.area > VA_TUNING.LARGE_AREA_PX) score += 6;

            if (ctx.hasSrc) score += 10;
            if (ctx.mediaUrl) score += 12;
            if (ctx.blob) score += 8;

            if (sig.protoSrc) score += 8;
            if (sig.protoLoad) score += 5;
            if (sig.protoPlay) score += 14;
            if (sig.gesture) score += VA_TUNING.GESTURE_BONUS;

            if (ctx.playing) score += 20;
            if (ctx.duration > VA_TUNING.LONG_DURATION_S || ctx.live) score += 10;
            if (ctx.duration > 0 && ctx.duration < VA_TUNING.AD_DURATION_MAX_S && ctx.muted && ctx.loop) score -= VA_TUNING.AD_LIKE_SHORT_PENALTY;
            if (ctx.adLike) score -= VA_TUNING.AD_LIKE_PENALTY;

            try {
                if (
                    typeof SessionManager !== 'undefined' &&
                    SessionManager.hasActiveSessions() &&
                    !v.__vaSession &&
                    !sig.gesture
                ) {
                    score -= 25;
                }
            } catch (e) { }

            if (profile) {
                if (profile.primarySelector && v.closest) {
                    try {
                        if (v.closest(profile.primarySelector)) score += VA_TUNING.PRIMARY_MATCH_BONUS;
                    } catch (e) { }
                }

                if (profile.ignoreSelectors && profile.ignoreSelectors.length && v.closest) {
                    try {
                        if (v.closest(profile.ignoreSelectors.join(','))) score -= VA_TUNING.IGNORE_MATCH_PENALTY;
                    } catch (e) { }
                }
            }

            return score;
        }
    }

    const CandidateArbiter = new CandidateArbiterClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       VideoSession
    ═══════════════════════════════════════════════════════════ */

    let sessionCounter = 0;

    class VideoSession {
        constructor(video, opts) {
            opts = opts || {};

            this.id = ++sessionCounter;
            this.video = video;
            this.info = Adaptor.detect(video);
            this.type = this.info.type;
            this.recoveries = 0;

            this._dead = false;
            this.state = SessionState.ATTACHED;

            this.isSeeking = false;
            this.seekTarget = 0;
            this._seekStartTime = 0;
            this._wasPlayingBeforeSeek = false;

            this._lastTime = -1;
            this._stallStart = 0;
            this._stallLevel = 0;

            this._lastBoost = 0;
            this._lastEmergency = 0;
            this._lastRecoverAt = 0;
            this._lowCount = 0;

            this._playedOnce = false;
            this._userPaused = false;
            this._autoTried = 0;

            this._lastFrameTs = 0;
            this._rvfcRunning = false;
            this._rvfcId = 0;

            this._lastPublishAt = 0;
            this._lastUserGestureAt = opts.userGesture ? NOW() : 0;
            this._programmaticPause = false;

            this._recoveryLevel = 0;
            this._recoveryStartedAt = 0;

            this.listeners = new ListenerBag();

            video.__vaSession = this;

            try { Adaptor.boost(video); } catch (e) { }

            this._bindEvents();

            Scheduler.register('session:' + this.id, {
                fast: () => this._fastTick(),
                normal: () => this._normalTick(),
                slow: () => this._slowTick(),
                ui: () => this._uiTick()
            });

            if (opts.userGesture) this.markUserGesture();

            if (ConfigManager.get('showDetect') && ConfigManager.get('showToast')) {
                Bus.emit('TOAST', { msg: '已接管视频 #' + this.id, kind: 'ok', remote: false });
            }

            Logger.info('Session', '接管视频 #' + this.id, {
                type: this.type,
                reason: opts.reason || 'unknown'
            });

            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        _setState(nextState, reason) {
            if (this._dead || this.state === nextState) return;

            const prev = this.state;
            this.state = nextState;

            Bus.emit('SESSION_STATE_CHANGED', {
                session: this,
                prev: prev,
                next: nextState,
                reason: reason || ''
            });

            Logger.debug('Session', '状态变化 #' + this.id + ' ' + prev + ' -> ' + nextState, {
                reason: reason || ''
            });
        }

        markUserGesture() {
            this._lastUserGestureAt = NOW();
            this._userPaused = false;

            if (this.state === SessionState.USER_PAUSED) {
                this._setState(SessionState.ACTIVE, 'user-gesture');
            }
        }

        canAutoPlay() {
            return ConfigManager.get('autoPlay') &&
                !this._userPaused &&
                !this.video.ended &&
                (
                    UserGesture.recent(5000) ||
                    this.video.muted ||
                    this._playedOnce
                );
        }

        tryPlayByUser() {
            this._programmaticPause = false;
            tryPlay(this.video);
        }

        boostOnly() {
            try { Adaptor.startLoad(this.video); } catch (e) { }
        }

        commandRecover() {
            this._userPaused = false;
            this.engineRecover(true);
        }

        commandReload() {
            this._userPaused = false;
            this.softReload(true);
        }

        _bindEvents() {
            const v = this.video;
            const L = this.listeners;

            this._onSeeking = () => {
                if (!ConfigManager.get('seekGuard')) return;
                this._wasPlayingBeforeSeek = !v.paused;
                this.isSeeking = true;
                this.seekTarget = v.currentTime;
                this._seekStartTime = NOW();
                this._stallLevel = 0;
            };

            this._onSeeked = () => {
                this.isSeeking = false;
                this._stallLevel = 0;
                this._boostAfterSeek();

                if (
                    ConfigManager.get('autoPlay') &&
                    !this._userPaused &&
                    this._wasPlayingBeforeSeek &&
                    v.paused &&
                    !v.ended
                ) {
                    tryPlay(v);
                }
            };

            this._onLoaded = () => this._maybeAutoPlay();
            this._onCanPlay = () => this._maybeAutoPlay();

            this._onWaiting = () => {
                this._stallLevel = Math.max(this._stallLevel, 1);
                if (this.state === SessionState.ACTIVE) {
                    this._setState(SessionState.DEGRADED, 'waiting');
                }
            };

            this._onPause = () => {
                if (this._programmaticPause) {
                    this._programmaticPause = false;
                } else if (this._playedOnce && !v.ended && !this.isSeeking) {
                    let user = false;

                    if (ConfigManager.get('userIntentFirst')) {
                        user = UserGesture.recent(VA_BUFFER.USER_GESTURE_WINDOW_MS);
                    }

                    if (user) {
                        this._userPaused = true;
                        this._setState(SessionState.USER_PAUSED, 'user-pause');
                        Bus.emit('USER_PAUSE', { session: this });
                    } else {
                        this._setState(SessionState.DORMANT, 'pause-no-gesture');
                    }
                }

                this._stopRvfc();
            };

            this._onPlay = () => {
                this._playedOnce = true;
                this._userPaused = false;

                if (this.state !== SessionState.RECOVERING) {
                    this._setState(SessionState.ACTIVE, 'play');
                }

                this._boostLoad();
                this._startRvfc();

                Bus.emit('SESSION_UPDATE', { sessionId: this.id });
            };

            this._onClick = (e) => {
                if (!ConfigManager.get('autoPlay') || !v.paused || v.ended) return;
                if (e && e.defaultPrevented) return;

                try {
                    const t = e.target;
                    if (
                        t &&
                        t.closest &&
                        t.closest('button, input, select, textarea, a, label, [role="button"], [role="slider"], [role="menuitem"]')
                    ) {
                        return;
                    }
                } catch (err) { }

                this.markUserGesture();
                this._boostLoad();
                this.tryPlayByUser();
            };

            this._onError = () => {
                try {
                    if (
                        ConfigManager.get('watchdog') &&
                        !this._userPaused &&
                        !v.ended &&
                        // 排除 MEDIA_ERR_ABORTED（code=1）：用户主动停止/脚本 reload 导致的正常中断，
                        // 不应误触发紧急恢复（M3）
                        v.error && v.error.code !== 1 &&
                        NOW() - this._lastEmergency > VA_TUNING.ERROR_RECOVER_THROTTLE_MS
                    ) {
                        this._lastEmergency = NOW();
                        this._emergencyLoad();
                        Logger.warn('Session', '视频错误，触发紧急恢复 #' + this.id);
                    }
                } catch (e) { }
            };

            L.add(v, 'seeking', this._onSeeking);
            L.add(v, 'seeked', this._onSeeked);
            L.add(v, 'loadedmetadata', this._onLoaded);
            L.add(v, 'canplay', this._onCanPlay);
            L.add(v, 'waiting', this._onWaiting);
            L.add(v, 'pause', this._onPause);
            L.add(v, 'play', this._onPlay);
            L.add(v, 'click', this._onClick);
            L.add(v, 'error', this._onError);
        }

        _maybeAutoPlay() {
            if (
                !ConfigManager.get('autoPlay') ||
                this._userPaused ||
                this._playedOnce ||
                this._autoTried >= 3
            ) return;

            const v = this.video;
            const doc = v.ownerDocument || DOC;

            if (doc.hidden || !v.paused || v.ended) return;

            const ahead = this._bufferAhead();
            const minPre = ConfigManager.get('minPreBuffer') || 2;

            if (
                ahead >= minPre ||
                isLive(v) ||
                v.readyState >= 3 ||
                (this._autoTried === 0 && v.readyState >= 2)
            ) {
                this._autoTried++;
                this._programmaticPause = false;
                tryPlay(v);
            }
        }

        _startRvfc() {
            if (!ConfigManager.get('rvfcMonitor')) return;

            const v = this.video;
            if (!v || this._dead || this._rvfcRunning || typeof v.requestVideoFrameCallback !== 'function') return;

            this._rvfcRunning = true;

            const step = () => {
                if (this._dead) {
                    this._rvfcRunning = false;
                    return;
                }

                try {
                    if (!v.paused && !v.ended) {
                        this._lastFrameTs = NOW();
                        this._lastTime = v.currentTime;
                        this._rvfcId = v.requestVideoFrameCallback(step);
                    } else {
                        this._rvfcRunning = false;
                    }
                } catch (e) {
                    this._rvfcRunning = false;
                }
            };

            try {
                this._rvfcId = v.requestVideoFrameCallback(step);
            } catch (e) {
                this._rvfcRunning = false;
            }
        }

        _stopRvfc() {
            try {
                if (this._rvfcId && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
                    this.video.cancelVideoFrameCallback(this._rvfcId);
                }
            } catch (e) { }

            this._rvfcRunning = false;
            this._rvfcId = 0;
        }

        _fastTick() {
            if (this._dead) return;

            if (this.state === SessionState.RECOVERING || this.state === SessionState.DEGRADED) {
                this._stallCheck();
                this._seekGuardCheck();
            }
        }

        _normalTick() {
            if (this._dead) return;

            if (
                this.state === SessionState.ACTIVE ||
                this.state === SessionState.DEGRADED ||
                this.state === SessionState.RECOVERING
            ) {
                this._bufferCheck();
                this._stallCheck();
                this._seekGuardCheck();
            }
        }

        _slowTick() {
            if (this._dead) return;

            const v = this.video;

            if (!v || !v.isConnected) {
                this.destroy('video-removed');
                return;
            }

            if (Scheduler.isHidden()) {
                if (this.state === SessionState.ACTIVE) {
                    this._setState(SessionState.DORMANT, 'page-hidden');
                }
                this._stopRvfc();
                return;
            }

            if (this.state === SessionState.DORMANT && isVisible(v) && !v.paused) {
                this._setState(SessionState.ACTIVE, 'visible-again');
                this._startRvfc();
            }

            if (this.type === 'unknown' || this.type === 'mse') {
                const newInfo = Adaptor.detect(v);
                if (newInfo.type !== this.type && newInfo.type !== 'unknown') {
                    this.info = newInfo;
                    this.type = newInfo.type;
                }
            }
        }

        _uiTick() {
            if (this._dead) return;

            const now = NOW();
            if (now - this._lastPublishAt >= 500) {
                this._lastPublishAt = now;
                Bus.emit('SESSION_UPDATE', { sessionId: this.id });
            }
        }

        _seekGuardCheck() {
            if (this.isSeeking && ConfigManager.get('seekGuard')) {
                const timeout = ConfigManager.get('seekTimeout') || 5000;
                if (NOW() - this._seekStartTime > timeout) this._forceSeekRecover();
            }
        }

        _bufferCheck() {
            const v = this.video;
            if (!v || this._dead) return;

            const ahead = this._bufferAhead();
            const now = NOW();

            if (ahead < VA_BUFFER.BUFFER_LEVEL_CRITICAL && v.readyState < 3 && !v.paused && !this.isSeeking) {
                if (this.state === SessionState.ACTIVE) {
                    this._setState(SessionState.DEGRADED, 'buffer-low');
                }

                Bus.emit('BUFFER_LOW', { session: this, level: 2, ahead: ahead });

                if (now - this._lastEmergency > VA_BUFFER.EMERGENCY_THROTTLE_MS) {
                    this._lastEmergency = now;
                    this._emergencyLoad();
                    this._lowCount++;

                    if (
                        this._lowCount >= VA_BUFFER.LOW_COUNT_TRIGGER &&
                        ConfigManager.get('autoDowngrade') &&
                        ConfigManager.get('qualityManage')
                    ) {
                        if (Adaptor.switchLevel(v, -1)) {
                            this._lastEmergency = now;
                            Bus.emit('TOAST', { msg: '网络不佳，已降画质', kind: 'warn', remote: false });
                            Bus.emit('QUALITY_CHANGED', { sessionId: this.id, direction: 'down' });
                            Logger.warn('Session', '自动降低画质 #' + this.id);
                        }
                        this._lowCount = 0;
                    }
                }
            } else if (ahead < VA_BUFFER.BUFFER_LEVEL_RECOVER && ahead >= VA_BUFFER.BUFFER_LEVEL_WARNING && !v.paused && !this.isSeeking) {
                Bus.emit('BUFFER_LOW', { session: this, level: 1, ahead: ahead });

                if (now - this._lastBoost > VA_BUFFER.BOOST_THROTTLE_MS) {
                    this._lastBoost = now;
                    this._boostLoad();
                }

            } else {
                this._lowCount = 0;
                if (this.state === SessionState.DEGRADED && ahead > VA_BUFFER.BUFFER_LEVEL_RECOVER) {
                    this._setState(SessionState.ACTIVE, 'buffer-ok');
                }
            }

            const back = this._backBuffer();
            if (back > VA_BUFFER.BACK_BUFFER_MAX_S) Adaptor.trimBack(v, VA_BUFFER.BACK_BUFFER_TRIM_S);
        }

        _stallCheck() {
            if (!ConfigManager.get('watchdog')) return;

            const v = this.video;
            if (!v || this._dead) return;

            const doc = v.ownerDocument || DOC;
            if (doc.hidden) return;

            if (v.paused || v.ended || this.isSeeking || v.playbackRate === 0 || v.readyState < 3) {
                this._lastTime = v.currentTime;
                this._stallStart = 0;
                this._stallLevel = 0;

                if (this.state === SessionState.RECOVERING) {
                    this._setState(SessionState.ACTIVE, 'recovered');
                    Bus.emit('RECOVERY_SUCCESS', { sessionId: this.id, level: this._recoveryLevel });
                }

                return;
            }

            const now = NOW();
            const t = v.currentTime;

            const frameRecent = ConfigManager.get('rvfcMonitor') &&
                this._lastFrameTs &&
                (now - this._lastFrameTs < VA_BUFFER.FRAME_RECENT_WINDOW_MS);

            if (t === this._lastTime && frameRecent) {
                if (!this._stallStart) this._stallStart = NOW();

                const stalled = NOW() - this._stallStart;

                if (stalled >= VA_BUFFER.STALL_LEVEL_1_MS && this._stallLevel === 0) {
                    this._stallLevel = 1;
                    if (this.state === SessionState.ACTIVE) this._setState(SessionState.DEGRADED, 'stall-1');
                    Bus.emit('STALL_DETECTED', { session: this, level: 1 });
                } else if (stalled >= VA_BUFFER.STALL_LEVEL_2_MS && this._stallLevel === 1) {
                    this._stallLevel = 2;
                    Bus.emit('STALL_DETECTED', { session: this, level: 2 });
                } else if (stalled >= VA_BUFFER.STALL_LEVEL_3_MS && this._stallLevel === 2) {
                    this._stallLevel = 3;
                    this._stallStart = 0;
                    Bus.emit('STALL_DETECTED', { session: this, level: 3 });
                }

                if (this.state === SessionState.RECOVERING && now - this._recoveryStartedAt > VA_BUFFER.RECOVERY_TIMEOUT_MS) {
                    this._setState(SessionState.FAILED, 'recovery-timeout');
                    Bus.emit('RECOVERY_FAIL', { sessionId: this.id, level: this._recoveryLevel });
                }
            } else {
                this._stallStart = 0;
                this._stallLevel = 0;
                this._lastTime = t;

                if (this.state === SessionState.RECOVERING) {
                    this._setState(SessionState.ACTIVE, 'recovered');
                    Bus.emit('RECOVERY_SUCCESS', { sessionId: this.id, level: this._recoveryLevel });
                }
            }
        }

        _safeSeek(target) {
            const v = this.video;
            try {
                let hi;
                if (isFinite(v.duration) && v.duration > 0) hi = Math.max(0, v.duration - 0.1);
                else hi = target + 1;
                v.currentTime = clamp(target, 0, hi);
            } catch (e) { }
        }

        _nudge() {
            this._safeSeek(this.video.currentTime + 0.1);
        }

        _reloadSegment() {
            Adaptor.reloadSegment(this.video);
        }

        _forceSeekRecover() {
            this.isSeeking = false;
            this._stallLevel = 0;

            const v = this.video;
            const info = PlayerRegistry.get(v) || this.info;
            const target = (typeof this.seekTarget === 'number' && this.seekTarget >= 0) ? this.seekTarget : v.currentTime;

            try {
                if (info && info.type === 'hls' && info.player) {
                    info.player.startLoad(target);
                } else {
                    if (Math.abs(v.currentTime - target) < 0.1) this._safeSeek(target + 0.1);
                    else this._safeSeek(target);
                }
            } catch (e) { }

            if (
                ConfigManager.get('autoPlay') &&
                !this._userPaused &&
                this._wasPlayingBeforeSeek &&
                v.paused &&
                !v.ended
            ) {
                tryPlay(v);
            }

            Bus.emit('TOAST', { msg: 'Seek超时，已强制恢复', kind: 'warn', remote: false });
            Logger.warn('Session', 'Seek 超时恢复 #' + this.id);
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        _boostAfterSeek() {
            const info = PlayerRegistry.get(this.video) || this.info;

            if (info && info.type === 'hls' && info.player) {
                try { info.player.startLoad(this.video.currentTime); } catch (e) { }
            } else {
                try { this.video.preload = 'auto'; } catch (e) { }
            }
        }

        _bufferAhead() {
            const v = this.video;

            try {
                const t = v.currentTime;

                for (let i = 0; i < v.buffered.length; i++) {
                    const start = v.buffered.start(i);
                    const end = v.buffered.end(i);
                    if (t >= start - 0.3 && t <= end) return Math.max(0, end - t);
                }
            } catch (e) { }

            return 0;
        }

        _backBuffer() {
            const v = this.video;

            try {
                const t = v.currentTime;

                for (let i = 0; i < v.buffered.length; i++) {
                    const start = v.buffered.start(i);
                    const end = v.buffered.end(i);
                    if (t >= start && t <= end) return Math.max(0, t - start);
                }
            } catch (e) { }

            return 0;
        }

        _emergencyLoad() {
            const info = PlayerRegistry.get(this.video) || this.info;

            if (info && info.type === 'hls' && info.player) {
                try { info.player.startLoad(this.video.currentTime); } catch (e) { }
            } else if (this.video.error || this.video.networkState >= 3) {
                this.safeLoad(true);
            } else {
                this._boostLoad();
            }
        }

        _boostLoad() {
            Adaptor.startLoad(this.video);
        }

        safeLoad(force) {
            const v = this.video;
            const info = PlayerRegistry.get(v) || this.info;

            if (info && (info.type === 'hls' || info.type === 'dash')) return;

            const src = v.currentSrc || v.src || '';
            if (src.indexOf('blob:') === 0) return;

            try {
                if (!force && !v.error && v.networkState !== 3) return;

                const target = v.currentTime;
                v.load();

                if (target > 0) {
                    v.addEventListener('loadedmetadata', () => {
                        try { v.currentTime = target; } catch (e) { }
                    }, { once: true });
                }

                if (ConfigManager.get('autoPlay') && !this._userPaused) {
                    v.addEventListener('canplay', () => {
                        tryPlay(v);
                    }, { once: true });
                }
            } catch (e) { }
        }

        softReload(userCommand) {
            const v = this.video;
            const info = PlayerRegistry.get(v) || this.info;
            const src = v.currentSrc || v.src || '';

            try {
                if (info && info.type === 'hls' && info.player) {
                    try { info.player.recoverMediaError(); } catch (e) { }
                    try { info.player.startLoad(v.currentTime); } catch (e) { }
                } else if (info && info.type === 'dash' && info.player) {
                    try {
                        if (typeof info.player.refreshManifest === 'function') info.player.refreshManifest();
                    } catch (e) { }
                } else if (src && src.indexOf('blob:') !== 0) {
                    this.safeLoad(true);
                } else {
                    this._nudge();
                }

                if (ConfigManager.get('autoPlay') && !v.ended && (userCommand || !this._userPaused)) {
                    if (userCommand) this._userPaused = false;
                    tryPlay(v);
                }
            } catch (e) { }

            this._stallLevel = 0;
            Logger.warn('Session', '软重载 #' + this.id);
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        engineRecover(userCommand) {
            const now = NOW();
            if (now - this._lastRecoverAt < 2000) return;

            this._lastRecoverAt = now;
            this.recoveries++;

            const v = this.video;
            const target = (typeof this.seekTarget === 'number' && this.seekTarget >= 0) ? this.seekTarget : v.currentTime;
            const info = PlayerRegistry.get(v) || this.info;

            try {
                if (info && info.type === 'hls' && info.player) {
                    try { info.player.recoverMediaError(); } catch (e) { }
                    try { info.player.startLoad(target); } catch (e) { }
                } else if (info && info.type === 'native' && (v.error || v.networkState === 3)) {
                    this.safeLoad(true);
                } else {
                    this._safeSeek(target + 0.05);
                }

                if (ConfigManager.get('autoPlay') && !v.ended && (userCommand || !this._userPaused)) {
                    if (userCommand) this._userPaused = false;
                    tryPlay(v);
                }
            } catch (e) { }

            this._stallLevel = 0;
            Logger.warn('Session', '引擎恢复 #' + this.id, { recoveries: this.recoveries });
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        getState() {
            const v = this.video;
            const q = Adaptor.getInfo(v);

            return {
                status: v.paused ? (v.ended ? '已停止' : '已暂停') : '播放中',
                statusKey: v.paused ? (v.ended ? 'stop' : 'pause') : 'play',
                sessionState: this.state,
                playerType: this.type,
                playerLabel: PLAYER_LABEL[this.type] || this.type,
                buffer: this._bufferAhead(),
                currentTime: v.currentTime || 0,
                duration: isFinite(v.duration) ? v.duration : 0,
                videoWidth: v.videoWidth || 0,
                videoHeight: v.videoHeight || 0,
                readyState: v.readyState,
                networkType: getNetworkType(),
                quality: q,
                canChangeQuality: Adaptor.canChangeQuality(v),
                bandwidth: q.bandwidth || estimateBandwidth(),
                seeking: this.isSeeking,
                stallLevel: this._stallLevel,
                userPaused: this._userPaused
            };
        }

        destroy(reason) {
            if (this._dead) return;

            this._dead = true;

            Scheduler.unregister('session:' + this.id);
            this._stopRvfc();
            this.listeners.removeAll();

            try { delete this.video.__vaSession; } catch (e) { }

            this._setState(SessionState.DESTROYED, reason || 'destroy');

            Bus.emit('SESSION_DESTROY', { session: this, reason: reason || 'destroy' });
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }
    }

    /* ═══════════════════════════════════════════════════════════
       SessionManager
    ═══════════════════════════════════════════════════════════ */

    class SessionManagerClass {
        constructor(bus) {
            this.bus = bus;
            this.sessions = new Set();
            this.seen = new WeakSet();
            this._lastPublish = 0;
            this._publishTimer = null;
            this._install();
        }

        _install() {
            this.bus.on('TAKEOVER_DECIDED', (payload) => {
                if (!payload || !payload.video) return;
                this._takeOverFromArbiter(payload.video, payload);
            });

            this.bus.on('SIGNAL_BOOST', (payload) => {
                if (!payload || !payload.video) return;
                this.boostVideo(payload.video, payload.reason);
            });

            this.bus.on('CMD', (payload) => {
                if (!payload || !payload.cmd) return;
                this.command(payload.cmd, payload.remote);
            });

            this.bus.on('SESSION_UPDATE', () => {
                this._schedulePublish();
            });

            this.bus.on('SESSION_DESTROY', (payload) => {
                if (!payload || !payload.session) return;
                this.sessions.delete(payload.session);
                this.seen.delete(payload.session.video);
            });

            this.bus.on('PATROL', () => {
                this._patrolCleanup();
                this._publishLocal(true);
            });

            this.bus.on('CONFIG_CHANGE', () => {
                this.applyConfig();
            });
        }

        hasActiveSessions() {
            return this.sessions.size > 0;
        }

        _takeOverFromArbiter(video, payload) {
            if (!video || video.nodeName !== 'VIDEO') return;

            const existing = video.__vaSession;
            if (existing) {
                const gestureRecent = payload.candidate &&
                    payload.candidate.userGestureAt &&
                    NOW() - payload.candidate.userGestureAt < VA_BUFFER.USER_GESTURE_WINDOW_MS;

                if (gestureRecent) {
                    existing.markUserGesture();
                    if (ConfigManager.get('autoPlay') && video.paused && !video.ended) {
                        existing.tryPlayByUser();
                    }
                } else {
                    existing.boostOnly();
                }
                return;
            }

            if (this.seen.has(video)) return;
            if (!video.isConnected) return;

            const userGesture = !!(
                payload.candidate &&
                payload.candidate.userGestureAt &&
                NOW() - payload.candidate.userGestureAt < VA_BUFFER.USER_GESTURE_WINDOW_MS
            );

            if (ConfigManager.get('visibleOnly') && !userGesture) {
                if (!isVisible(video) || videoArea(video) < (ConfigManager.get('minVideoArea') || 0)) {
                    if (video.ownerDocument === DOC && Detector._viewportObs) {
                        Detector.watchViewport(video);
                    }
                    this.seen.add(video);
                    return;
                }
            }

            this.seen.add(video);

            try {
                const session = new VideoSession(video, {
                    reason: 'arbiter',
                    candidate: payload.candidate || null,
                    userGesture: userGesture
                });

                this.sessions.add(session);
                this.bus.emit('SESSION_CREATED', { session: session });
                this._schedulePublish();
            } catch (e) {
                Logger.error('SessionManager', '接管视频失败', e);
                this.seen.delete(video);
            }
        }

        boostVideo(video, reason) {
            try {
                if (!video || video.nodeName !== 'VIDEO') return;

                video.preload = 'auto';

                const lazy = video.getAttribute && (video.getAttribute('data-src') || video.getAttribute('data-lazy-src'));
                if (lazy && !video.src && /^(https?:)?\/\//i.test(lazy)) video.src = lazy;

                addPreconnect(video.currentSrc || video.src, video.ownerDocument);

                const s = video.__vaSession;
                if (s) s.boostOnly();
            } catch (e) { }
        }

        command(cmd, remote) {
            if (cmd === 'recover') {
                this.sessions.forEach(function (s) {
                    try { s.commandRecover(); } catch (e) { }
                });
                Logger.info('Command', '执行恢复播放', { remote: !!remote });
            } else if (cmd === 'reload') {
                this.sessions.forEach(function (s) {
                    try { s.commandReload(); } catch (e) { }
                });
                Logger.info('Command', '执行重新加载', { remote: !!remote });
            } else if (cmd === 'upgrade' || cmd === 'downgrade') {
                let ok = false;
                const delta = cmd === 'upgrade' ? 1 : -1;

                this.sessions.forEach(function (s) {
                    try {
                        if (Adaptor.switchLevel(s.video, delta)) ok = true;
                    } catch (e) { }
                });

                if (!remote && this.sessions.size > 0) {
                    if (ok) {
                        Bus.emit('TOAST', { msg: cmd === 'upgrade' ? '已提升画质' : '已降低画质', kind: 'ok', remote: false });
                    } else {
                        Bus.emit('TOAST', { msg: cmd === 'upgrade' ? '无法提升画质' : '无法降低画质', kind: 'warn', remote: false });
                    }
                }

                Logger.info('Command', cmd === 'upgrade' ? '提升画质' : '降低画质', { ok: ok, remote: !!remote });
            }

            this._publishLocal(true);
        }

        applyConfig() {
            this.sessions.forEach(function (s) {
                try {
                    Adaptor.applyConfig(s.video);
                    s.video.preload = 'auto';
                } catch (e) { }
            });
            this._publishLocal(true);
        }

        _schedulePublish() {
            if (this._publishTimer) return;

            this._publishTimer = setTimeout(() => {
                this._publishTimer = null;
                this._publishLocal(true);
            }, 120);
        }

        _publishLocal(force) {
            const now = NOW();
            if (!force && now - this._lastPublish < 600) return;

            this._lastPublish = now;
            const state = this._collectLocalState();
            this.bus.emit('LOCAL_STATE', state);
        }

        _collectLocalState() {
            let videos = this.sessions.size;
            let recoveries = 0;
            let primary = null;
            let bestScore = -1;

            this.sessions.forEach(function (s) {
                recoveries += s.recoveries || 0;

                const v = s.video;
                if (!v) return;

                let score = 0;
                if (!v.paused) score += 10000;
                if (!v.ended) score += 1000;
                if (v.readyState >= 3) score += 100;
                if (s.state === SessionState.ACTIVE) score += 500;
                score += videoArea(v);

                if (score > bestScore) {
                    bestScore = score;
                    primary = s;
                }
            });

            if (!primary) {
                const idle = StateStore._idle();
                idle.videos = videos;
                idle.recoveries = recoveries;
                return idle;
            }

            const st = primary.getState();
            st.videos = videos;
            st.recoveries = recoveries;
            return st;
        }

        _patrolCleanup() {
            const toDestroy = [];

            this.sessions.forEach((s) => {
                const v = s.video;

                if (!v || s._dead) {
                    toDestroy.push(s);
                    return;
                }

                if (!v.isConnected) {
                    toDestroy.push(s);
                    return;
                }

                if (s.type === 'unknown' || s.type === 'mse') {
                    const newInfo = Adaptor.detect(v);
                    if (newInfo.type !== 'unknown' && newInfo.type !== s.type) {
                        s.info = newInfo;
                        s.type = newInfo.type;
                    }
                }
            });

            toDestroy.forEach(function (s) {
                try { s.destroy('patrol-cleanup'); } catch (e) { }
            });
        }
    }

    const SessionManager = new SessionManagerClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       RecoveryOrchestrator
    ═══════════════════════════════════════════════════════════ */

    class RecoveryOrchestratorClass {
        constructor(bus) {
            this.bus = bus;
            this.budget = new WeakMap();

            this.bus.on('STALL_DETECTED', (payload) => this._onStall(payload));
            this.bus.on('BUFFER_LOW', (payload) => this._onBufferLow(payload));
        }

        _getBudget(session) {
            let b = this.budget.get(session);

            if (!b) {
                b = {
                    count: 0,
                    timestamps: [],
                    cooldownUntil: 0
                };
                this.budget.set(session, b);
            }

            return b;
        }

        _canAttempt(session, level) {
            if (!session || session._dead) return false;
            if (!ConfigManager.get('watchdog')) return false;
            if (session._userPaused) return false;
            if (session.isSeeking) return false;
            if (session.state === SessionState.RECOVERING || session.state === SessionState.FAILED) return false;

            const v = session.video;
            if (!v || v.paused || v.ended) return false;
            if (Scheduler.isHidden()) return false;

            const b = this._getBudget(session);
            const now = NOW();

            if (b.count >= (ConfigManager.get('recoveryBudget') || 8)) return false;
            if (now < b.cooldownUntil) return false;

            b.timestamps = b.timestamps.filter(function (t) { return now - t < 60000; });
            if (b.timestamps.length >= 3) return false;

            return true;
        }

        _record(session, level) {
            const b = this._getBudget(session);
            const now = NOW();

            b.count++;
            b.timestamps.push(now);

            const cooldowns = {
                1: 2000,
                2: 5000,
                3: 10000,
                4: 20000
            };

            b.cooldownUntil = now + (cooldowns[level] || 5000);

            session._recoveryLevel = level;
            session._recoveryStartedAt = now;
        }

        _onBufferLow(payload) {
            if (!payload || !payload.session) return;

            const session = payload.session;

            if (payload.level === 1) {
                if (NOW() - session._lastBoost > 8000) {
                    session._lastBoost = NOW();
                    session._boostLoad();
                }
                return;
            }

            if (payload.level === 2) {
                if (!this._canAttempt(session, 1)) {
                    this.bus.emit('RECOVERY_BLOCKED', { sessionId: session.id, level: 1 });
                    return;
                }

                this._record(session, 1);
                session._setState(SessionState.DEGRADED, 'buffer-recover');
                session._boostLoad();

                this.bus.emit('RECOVERY_ATTEMPT', {
                    sessionId: session.id,
                    level: 0,
                    reason: 'buffer-low'
                });
            }
        }

        _onStall(payload) {
            if (!payload || !payload.session) return;

            const session = payload.session;
            const level = payload.level;

            if (!this._canAttempt(session, level)) {
                this.bus.emit('RECOVERY_BLOCKED', { sessionId: session.id, level: level });
                return;
            }

            this._record(session, level);
            session._setState(SessionState.RECOVERING, 'stall-recover');

            this.bus.emit('RECOVERY_ATTEMPT', {
                sessionId: session.id,
                level: level,
                reason: 'stall'
            });

            try {
                if (level === 1) {
                    if (isLive(session.video)) session._boostLoad();
                    else session._nudge();

                    Logger.info('Recovery', 'L1 轻推 #' + session.id);
                } else if (level === 2) {
                    session._reloadSegment();
                    Logger.warn('Recovery', 'L2 重载切片 #' + session.id);
                } else if (level === 3) {
                    session.engineRecover(false);
                    Logger.warn('Recovery', 'L3 引擎恢复 #' + session.id);
                }
            } catch (e) {
                Logger.error('Recovery', '恢复执行失败 #' + session.id, e);
                this.bus.emit('RECOVERY_FAIL', {
                    sessionId: session.id,
                    level: level,
                    error: String(e)
                });
            }
        }
    }

    const RecoveryOrchestrator = new RecoveryOrchestratorClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       UIManager v2
    ═══════════════════════════════════════════════════════════ */

    class UIManager {
        constructor(bus) {
            this.bus = bus;
            this._state = {};
            this._visible = false;
            this._logs = [];
            this._logFilter = 'all';
            this._timeline = [];
            this._lastStallMarker = 0;
            this._lastRecoveries = 0;
            this._lastTimelineRender = 0;
            this._toastT = null;
            this._depEl = null;

            this._build();
            this._mountWhenReady();
            this._subscribe();
        }

        _build() {
            const existing = DOC.getElementById('va-ui-host');
            if (existing) existing.remove();

            this.host = DOC.createElement('div');
            this.host.id = 'va-ui-host';
            this.host.style.cssText = 'position:fixed;z-index:2147483646;top:0;left:0;width:0;height:0;overflow:visible;';

            this.root = this.host.attachShadow({ mode: 'closed' });

            // 跨脚本保护：同时屏蔽广告拦截器 UI 的 DOM 节点（pro-blocker-ui-host）
            // 防止广告拦截器将视频加速 UI 误判为广告覆盖层
            this._observeAdBlockerUI();

            const style = DOC.createElement('style');
            style.textContent = `
                :host{
                    --va-bg:rgba(12,12,18,.94);
                    --va-card:rgba(255,255,255,.05);
                    --va-border:rgba(255,255,255,.12);
                    --va-text:#e8e8ec;
                    --va-dim:#999;
                    --va-accent:#0a84ff;
                    --va-success:#30d158;
                    --va-warning:#ff9f0a;
                    --va-error:#ff453a;
                    --va-radius:14px;
                    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
                    font-size:13px;
                }
                *{box-sizing:border-box}

                .fab{
                    position:fixed;bottom:18px;right:18px;width:42px;height:42px;border-radius:50%;
                    z-index:2147483646;user-select:none;background:rgba(120,120,120,.5);
                    box-shadow:0 0 0 3px rgba(120,120,120,.35);color:#fff;display:flex;align-items:center;justify-content:center;
                    font-size:18px;cursor:pointer;opacity:.72;transition:opacity .15s,transform .15s;
                }
                .fab:hover{opacity:1;transform:scale(1.06)}
                .fab[data-state=active]{background:rgba(10,132,255,.78);box-shadow:0 0 0 3px rgba(48,209,88,.55)}
                .fab[data-state=degraded]{background:rgba(255,159,10,.78);box-shadow:0 0 0 3px rgba(255,159,10,.5)}
                .fab[data-state=recovering]{background:rgba(255,69,58,.78);box-shadow:0 0 0 3px rgba(255,69,58,.5)}
                .fab[data-state=paused]{background:rgba(142,142,147,.78);box-shadow:0 0 0 3px rgba(142,142,147,.4)}
                .fab[data-state=seek]{background:rgba(191,90,242,.78);box-shadow:0 0 0 3px rgba(191,90,242,.5)}
                .fab[data-state=idle]{background:rgba(120,120,120,.5);box-shadow:0 0 0 3px rgba(120,120,120,.35)}

                .panel{
                    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    z-index:2147483646;
                    background:var(--va-bg);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
                    border:1px solid var(--va-border);border-radius:var(--va-radius);
                    box-shadow:0 20px 60px rgba(0,0,0,.5);
                    width:min(500px,calc(100vw - 24px));max-height:82vh;overflow:hidden;color:var(--va-text);
                    display:flex;flex-direction:column;
                }

                .hdr{
                    display:flex;align-items:center;justify-content:space-between;padding:12px 14px 10px;
                    border-bottom:1px solid rgba(255,255,255,.08);
                }
                .hdr h3{margin:0;font-size:15px;font-weight:600;color:#fff}
                .close-x{
                    background:none;border:none;color:#666;font-size:18px;cursor:pointer;
                    padding:2px 6px;border-radius:6px;
                }
                .close-x:hover{color:#fff;background:rgba(255,255,255,.1)}

                .tabs{
                    display:flex;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);gap:2px;
                }
                .tab{
                    padding:10px 12px;cursor:pointer;font-size:12px;color:#777;
                    border-bottom:2px solid transparent;user-select:none;
                }
                .tab:hover{color:#bbb}
                .tab.active{color:#fff;border-bottom-color:var(--va-accent)}

                .body{padding:12px 14px 14px;overflow-y:auto;flex:1;min-height:0}
                .page{display:none}
                .page.active{display:block}

                .card{
                    background:var(--va-card);border:1px solid rgba(255,255,255,.06);
                    border-radius:12px;padding:10px 12px;margin:8px 0;
                }

                .row{
                    display:flex;justify-content:space-between;align-items:center;
                    font-size:12px;color:var(--va-dim);margin:3px 0;flex-wrap:wrap;gap:8px;
                }
                .row b{color:#fff}

                .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#555}
                .dot.live{background:var(--va-success);box-shadow:0 0 6px var(--va-success)}
                .dot.pause{background:#8e8e93}
                .dot.stop{background:var(--va-warning)}
                .dot.seek{background:#bf5af2;box-shadow:0 0 6px #bf5af2}

                .buf-wrap{margin:8px 0}
                .buf-label{display:flex;justify-content:space-between;font-size:11px;color:#888;margin-bottom:5px}
                .buf-bar{height:6px;background:rgba(255,255,255,.08);border-radius:4px;overflow:hidden}
                .buf-fill{
                    height:100%;background:linear-gradient(90deg,var(--va-accent),var(--va-success));
                    width:0%;transition:width .25s cubic-bezier(0.4,0,.2,1);border-radius:4px;
                }

                .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
                .stat-card{background:rgba(255,255,255,.05);border-radius:10px;padding:8px;text-align:center}
                .stat-card .val{font-size:16px;font-weight:700;color:#fff}
                .stat-card .lbl{font-size:10px;color:#777;margin-top:2px}

                .btn-group{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
                button.act{
                    padding:9px 10px;border:1px solid var(--va-border);border-radius:10px;cursor:pointer;
                    font-size:12px;font-weight:500;flex:1;display:flex;align-items:center;justify-content:center;
                    background:rgba(255,255,255,.07);color:#fff;transition:all .15s;
                }
                button.act:hover:not(:disabled){filter:brightness(1.2);transform:translateY(-1px)}
                button.act:active:not(:disabled){transform:translateY(1px);filter:brightness(0.9)}
                button.act:disabled{opacity:.3;cursor:not-allowed}
                .btn-p{background:rgba(10,132,255,.6)}
                .btn-w{background:rgba(255,159,10,.6)}
                .btn-g{background:rgba(48,209,88,.6)}
                .btn-d{background:rgba(255,69,58,.6)}

                .divider{height:1px;background:rgba(255,255,255,.08);margin:10px 0}
                .sec-title{font-size:11px;color:var(--va-accent);margin:10px 0 6px;font-weight:600}

                label.opt{
                    display:flex;align-items:center;gap:8px;font-size:12px;color:#bbb;
                    margin:6px 0;cursor:pointer;
                }
                label.opt input[type=checkbox]{width:15px;height:15px;accent-color:var(--va-accent);cursor:pointer}
                label.opt input[type=number],label.opt select{
                    width:92px;padding:5px 6px;margin-left:auto;
                    border:1px solid var(--va-border);border-radius:8px;
                    background:rgba(0,0,0,.3);color:#eee;font-size:12px;
                }

                .hint{font-size:11px;color:#666;line-height:1.5;margin-top:8px}

                .toast{
                    position:fixed;top:18px;right:18px;padding:9px 14px;border-radius:12px;
                    background:rgba(28,28,35,.95);border:1px solid var(--va-border);color:#fff;font-size:13px;
                    transform:translateX(120%);transition:transform .25s,opacity .25s;opacity:0;pointer-events:none;z-index:2147483646;
                }
                .toast.show{transform:translateX(0);opacity:1}
                .toast.ok{border-left:3px solid var(--va-success)}
                .toast.warn{border-left:3px solid var(--va-warning)}
                .toast.err{border-left:3px solid var(--va-error)}

                .stall-badge{
                    display:inline-block;padding:2px 6px;border-radius:6px;font-size:10px;margin-left:6px;
                }
                .stall-badge.s1{background:rgba(255,159,10,.3);color:var(--va-warning)}
                .stall-badge.s2{background:rgba(255,69,58,.3);color:var(--va-error)}
                .stall-badge.s3{background:rgba(255,0,0,.4);color:#fff}

                .timeline-wrap{margin:8px 0}
                .timeline{
                    position:relative;height:20px;background:rgba(255,255,255,.06);
                    border-radius:6px;overflow:hidden;
                }
                .tl-item{position:absolute;top:3px;bottom:3px;width:3px;border-radius:1px}
                .tl-stall{background:var(--va-warning)}
                .tl-warn{background:#ffd60a}
                .tl-error{background:var(--va-error)}
                .tl-recover{background:var(--va-success)}

                .log-toolbar{display:flex;align-items:center;gap:6px;margin:8px 0}
                .log-toolbar span{font-size:11px;color:var(--va-accent);font-weight:600}
                .log-toolbar select{
                    margin-left:auto;padding:4px 6px;border:1px solid var(--va-border);
                    border-radius:8px;background:rgba(0,0,0,.3);color:#eee;font-size:11px;
                }

                .mini{
                    padding:4px 8px;border:1px solid var(--va-border);border-radius:8px;
                    background:rgba(255,255,255,.07);color:#fff;cursor:pointer;font-size:11px;
                }

                .logs{
                    height:180px;overflow:auto;background:rgba(0,0,0,.25);
                    border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:7px;
                    font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.45;
                }
                .log-line{white-space:pre-wrap;word-break:break-all}
                .log-line.debug{color:#8e8e93}
                .log-line.info{color:#d0d0d8}
                .log-line.warn{color:#ffd60a}
                .log-line.error{color:var(--va-error)}

                .dep-hint{
                    font-size:11px;color:var(--va-warning);
                    background:rgba(255,159,10,.08);border:1px solid rgba(255,159,10,.25);
                    border-radius:8px;padding:6px 8px;margin:6px 0;
                }
            `;
            this.root.appendChild(style);

            this._toast = DOC.createElement('div');
            this._toast.className = 'toast';
            this.root.appendChild(this._toast);

            this._fab = DOC.createElement('div');
            this._fab.className = 'fab';
            this._fab.dataset.state = 'idle';
            this._fab.textContent = '🎬';
            this._fab.title = '视频加速控制台';
            this._fab.addEventListener('click', () => this.toggle());
            this.root.appendChild(this._fab);

            this._panel = DOC.createElement('div');
            this._panel.className = 'panel';
            this._panel.style.display = 'none';

            this._panel.innerHTML = `
                <div class="hdr"><h3>🎬 视频加速控制台</h3><button class="close-x" data-act="close">✕</button></div>
                <div class="tabs">
                    <div class="tab active" data-tab="monitor">📊 监控</div>
                    <div class="tab" data-tab="settings">⚙️ 策略</div>
                    <div class="tab" data-tab="tools">📦 数据</div>
                </div>
                <div class="body">
                    <div class="page active" id="page-monitor">
                        <div class="card">
                            <div class="row">
                                <span><span class="dot" id="va-dot"></span><b id="va-status">检测中</b><span id="va-stall"></span></span>
                                <span>播放器: <b id="va-type">-</b></span>
                                <span>视频数: <b id="va-count">0</b></span>
                            </div>
                            <div class="row">
                                <span>会话状态: <b id="va-session-state">-</b></span>
                                <span>恢复次数: <b id="va-rec">0</b></span>
                            </div>
                        </div>

                        <div class="card">
                            <div class="buf-wrap">
                                <div class="buf-label"><span>前方缓冲</span><span id="va-buf-time">0s</span></div>
                                <div class="buf-bar"><div class="buf-fill" id="va-buf-fill"></div></div>
                            </div>
                            <div class="row">
                                <span>网络健康: <b id="va-health">-</b></span>
                                <span>网络类型: <b id="va-net">-</b></span>
                            </div>
                            <div class="row">
                                <span>画质: <b id="va-quality">-</b></span>
                                <span>带宽: <b id="va-bw">-</b></span>
                                <span>分辨率: <b id="va-res">-</b></span>
                            </div>
                        </div>

                        <div class="card timeline-wrap">
                            <div class="buf-label"><span>近 60 秒卡顿 / 恢复时间轴</span></div>
                            <div class="timeline" id="va-timeline"></div>
                        </div>

                        <div class="stat-grid">
                            <div class="stat-card"><div class="val" id="va-ready">-</div><div class="lbl">就绪状态</div></div>
                            <div class="stat-card"><div class="val" id="va-progress">--/--</div><div class="lbl">播放进度</div></div>
                        </div>

                        <div class="btn-group">
                            <button class="act btn-p" data-act="recover">恢复播放</button>
                            <button class="act btn-w" data-act="reload">重新加载</button>
                        </div>
                        <div class="btn-group">
                            <button class="act btn-g" data-act="upgrade" id="va-up">提升画质</button>
                            <button class="act btn-d" data-act="downgrade" id="va-down">降低画质</button>
                        </div>

                        <div class="hint">恢复播放：修复卡死 / 错误；重新加载：按播放器类型安全重载。</div>
                    </div>

                    <div class="page" id="page-settings">
                        <div class="sec-title">检测与接管</div>
                        <label class="opt"><input type="checkbox" id="va-proto"> 原型嗅探（src / play / load）</label>
                        <label class="opt"><input type="checkbox" id="va-pointer"> pointerdown 预启动</label>
                        <label class="opt"><input type="checkbox" id="va-fast"> DOM 动态扫描</label>
                        <label class="opt"><input type="checkbox" id="va-visible"> 仅接管可见视频</label>
                        <label class="opt"><input type="checkbox" id="va-userintent"> 用户意图优先</label>
                        <label class="opt"><input type="checkbox" id="va-standby"> 待机观察模式</label>
                        <label class="opt"><input type="checkbox" id="va-adguard"> 广告/预览过滤</label>
                        <label class="opt">最小接管面积 <input type="number" id="va-area" min="0" step="1000"></label>

                        <div class="divider"></div>

                        <div class="sec-title">网络与缓冲</div>
                        <label class="opt"><input type="checkbox" id="va-fetch"> 视频请求高优先级</label>
                        <label class="opt"><input type="checkbox" id="va-preconnect"> DNS / preconnect 预热</label>
                        <label class="opt"><input type="checkbox" id="va-instant"> play() 即时增强</label>
                        <label class="opt"><input type="checkbox" id="va-big"> 超大缓冲</label>
                        <label class="opt">缓冲目标 <input type="number" id="va-btgt" min="10" max="300" step="10"> 秒</label>
                        <label class="opt">预缓冲量 <input type="number" id="va-prebuf" min="1" max="30"> 秒</label>
                        <label class="opt"><input type="checkbox" id="va-quality"> 画质管理（HLS 切换）</label>
                        <label class="opt"><input type="checkbox" id="va-autodown"> 缓冲不足自动降画质</label>
                        <div id="va-dep-down" class="dep-hint" style="display:none">提示：自动降画质依赖“画质管理”。</div>

                        <div class="divider"></div>

                        <div class="sec-title">容错与自愈</div>
                        <label class="opt"><input type="checkbox" id="va-auto"> 自动播放 / 续播</label>
                        <label class="opt"><input type="checkbox" id="va-seek"> Seek 保护（超时恢复）</label>
                        <label class="opt">Seek 超时 <input type="number" id="va-seekto" min="2000" max="15000" step="500"> ms</label>
                        <label class="opt"><input type="checkbox" id="va-watchdog"> 卡死分级恢复</label>
                        <label class="opt"><input type="checkbox" id="va-rvfc"> RVFC 帧级卡顿监控</label>
                        <label class="opt">恢复预算 <input type="number" id="va-budget" min="1" max="20"></label>

                        <div class="divider"></div>

                        <div class="sec-title">UI 与日志</div>
                        <label class="opt"><input type="checkbox" id="va-toast"> 显示操作提示</label>
                        <label class="opt"><input type="checkbox" id="va-detect"> 显示接管通知</label>
                        <label class="opt">日志级别
                            <select id="va-loglevel">
                                <option value="debug">Debug</option>
                                <option value="info">Info</option>
                                <option value="warn">Warn</option>
                                <option value="error">Error</option>
                            </select>
                        </label>
                        <div class="hint">v19：候选评分接管、用户意图保护、恢复预算与冷却、统一调度器。</div>
                    </div>

                    <div class="page" id="page-tools">
                        <div class="btn-group">
                            <button class="act" data-act="exportCfg">导出配置</button>
                            <button class="act" data-act="importCfg">导入配置</button>
                        </div>
                        <div class="btn-group">
                            <button class="act btn-d" data-act="resetAll">恢复默认</button>
                        </div>

                        <div class="log-toolbar">
                            <span>运行日志</span>
                            <select id="va-logfilter">
                                <option value="all">全部</option>
                                <option value="info">Info+</option>
                                <option value="warn">Warn+</option>
                                <option value="error">Error</option>
                            </select>
                            <button class="mini" data-act="clearLogs">清空</button>
                        </div>

                        <div class="logs" id="va-logs"></div>
                        <div class="hint" id="va-hint"></div>
                        <div class="divider"></div>
                        <div class="hint">v19.0：感知-裁决-会话-自愈-观测架构。</div>
                    </div>
                </div>
            `;

            this.root.appendChild(this._panel);

            this._panel.querySelectorAll('.tab').forEach((tab) => {
                tab.addEventListener('click', () => {
                    this._panel.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
                    this._panel.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });

                    tab.classList.add('active');
                    const page = this._panel.querySelector('#page-' + tab.dataset.tab);
                    if (page) page.classList.add('active');
                });
            });

            this._panel.addEventListener('click', (e) => {
                const t = e.target.closest('[data-act]');
                if (!t) return;

                const act = t.getAttribute('data-act');

                if (act === 'close') {
                    this.hide();
                } else if (act === 'exportCfg') {
                    this.bus.emit('CONFIG_EXPORT_REQUEST', {});
                } else if (act === 'importCfg') {
                    this._import();
                } else if (act === 'resetAll') {
                    this.bus.emit('CONFIG_RESET_REQUEST', {});
                    this.toast('已恢复默认', 'ok');
                } else if (act === 'clearLogs') {
                    this._logs = [];
                    this._renderAllLogs();
                } else if (['recover', 'reload', 'upgrade', 'downgrade'].indexOf(act) >= 0) {
                    this.bus.emit('CMD', { cmd: act, remote: false });
                }
            });

            const logFilter = this._panel.querySelector('#va-logfilter');
            if (logFilter) {
                logFilter.addEventListener('change', () => {
                    this._logFilter = logFilter.value;
                    this._renderAllLogs();
                });
            }

            this._bindSettings();
        }

        _subscribe() {
            this.bus.on('STATE_AGGREGATED', (state) => {
                this._maybeAddStateMarkers(state);
                this.update(state);
                this._updateFab(state);
            });

            this.bus.on('LOG_EMIT', (entry) => {
                this._appendLog(entry);
            });

            this.bus.on('TOAST', (payload) => {
                if (payload && payload.msg) this.toast(payload.msg, payload.kind);
            });

            this.bus.on('UI_TOGGLE', () => {
                this.toggle();
            });

            this.bus.on('CONFIG_EXPORT_RESULT', (payload) => {
                if (!payload || !payload.json) return;

                const ta = this._ensureTextarea();
                ta.value = payload.json;
                ta.select();

                let ok = false;
                try { ok = DOC.execCommand('copy'); } catch (e) { }

                if (ok) this.toast('已复制到剪贴板', 'ok');
                else this.toast('请手动复制', 'warn');
            });

            this.bus.on('CONFIG_IMPORT_RESULT', (payload) => {
                const ok = payload && payload.ok;
                const ta = this._panel.querySelector('#va-cfg-ta');
                const hint = this._panel.querySelector('#va-hint');

                if (ok) {
                    if (ta) ta.remove();
                    if (hint) hint.textContent = '';
                    this._syncSettings();
                    this.toast('导入成功', 'ok');
                } else {
                    this.toast('导入失败：JSON 格式错误', 'err');
                }
            });

            this.bus.on('CONFIG_CHANGE', () => {
                this._syncSettings();
            });

            const flushHandler = () => {
                try { this._flushSettings(); } catch (e) { }
            };

            PW.addEventListener('pagehide', flushHandler);
            PW.addEventListener('beforeunload', flushHandler);
        }

        /**
         * 配置映射表：单一定义，三个方法共享，消除 3× 重复（R5 认知负荷优化）
         */
        static _configMap = [
            { id: 'va-proto', key: 'protoHook', type: 'chk' },
            { id: 'va-pointer', key: 'earlyPointer', type: 'chk' },
            { id: 'va-fast', key: 'fastDetect', type: 'chk' },
            { id: 'va-visible', key: 'visibleOnly', type: 'chk' },
            { id: 'va-userintent', key: 'userIntentFirst', type: 'chk' },
            { id: 'va-standby', key: 'standbyMode', type: 'chk' },
            { id: 'va-adguard', key: 'adGuard', type: 'chk' },
            { id: 'va-area', key: 'minVideoArea', type: 'num', def: 0 },
            { id: 'va-fetch', key: 'fetchPriority', type: 'chk' },
            { id: 'va-preconnect', key: 'preconnect', type: 'chk' },
            { id: 'va-instant', key: 'instantPlay', type: 'chk' },
            { id: 'va-big', key: 'bigBuffer', type: 'chk' },
            { id: 'va-btgt', key: 'bufferTarget', type: 'num', def: 60 },
            { id: 'va-prebuf', key: 'minPreBuffer', type: 'num', def: 2 },
            { id: 'va-quality', key: 'qualityManage', type: 'chk' },
            { id: 'va-autodown', key: 'autoDowngrade', type: 'chk' },
            { id: 'va-auto', key: 'autoPlay', type: 'chk' },
            { id: 'va-seek', key: 'seekGuard', type: 'chk' },
            { id: 'va-seekto', key: 'seekTimeout', type: 'num', def: 5000 },
            { id: 'va-watchdog', key: 'watchdog', type: 'chk' },
            { id: 'va-rvfc', key: 'rvfcMonitor', type: 'chk' },
            { id: 'va-budget', key: 'recoveryBudget', type: 'num', def: 8 },
            { id: 'va-toast', key: 'showToast', type: 'chk' },
            { id: 'va-detect', key: 'showDetect', type: 'chk' },
            { id: 'va-loglevel', key: 'logLevel', type: 'str' },
        ];

        _bindSettings() {
            const bus = this.bus;
            const panel = this._panel;

            UIManager._configMap.forEach(function (cfg) {
                const el = panel.querySelector('#' + cfg.id);
                if (!el) return;

                const handler = function () {
                    let value;
                    if (cfg.type === 'num') value = parseInt(el.value, 10) || cfg.def;
                    else if (cfg.type === 'str') value = el.value;
                    else value = el.checked;
                    bus.emit('CONFIG_SET', { key: cfg.key, value: value });
                };

                const isNum = cfg.type === 'num';
                // checkbox 用 change 而非 input：input 在 checked 更新前触发，读到旧值写入 storage（C2）
                if (isNum || cfg.type === 'str') el.addEventListener('input', handler);
                else el.addEventListener('change', handler);
            });
        }

        _flushSettings() {
            // 未打开过面板（_syncSettings 未执行）时，输入框停在 HTML 默认态，
            // 若强行 flush 会把全部配置写成 false 并持久化，导致功能被静默清空（C1）
            if (!this._synced) return;

            const panel = this._panel;
            const patch = {};

            UIManager._configMap.forEach(function (cfg) {
                const el = panel.querySelector('#' + cfg.id);
                if (!el) return;
                let value;
                if (cfg.type === 'num') value = parseInt(el.value, 10) || cfg.def;
                else if (cfg.type === 'str') value = el.value;
                else value = el.checked;
                patch[cfg.key] = value;
            });

            ConfigManager.silentUpdate(patch);
            this._updateDependency();
        }

        _syncSettings() {
            const panel = this._panel;
            this._synced = true;

            UIManager._configMap.forEach(function (cfg) {
                const el = panel.querySelector('#' + cfg.id);
                if (!el) return;
                const v = ConfigManager.get(cfg.key);
                if (cfg.type === 'num') el.value = v != null ? v : cfg.def;
                else if (cfg.type === 'str') el.value = v || cfg.def || '';
                else el.checked = !!v;
            });

            this._updateDependency();
        }

        _updateDependency() {
            const el = this._depEl;
            if (!el) {
                const found = this._panel.querySelector('#va-dep-down');
                if (found) this._depEl = found;
                else return;
            }

            const show = ConfigManager.get('autoDowngrade') && !ConfigManager.get('qualityManage');
            el.style.display = show ? 'block' : 'none';
        }

        _ensureTextarea() {
            let ta = this._panel.querySelector('#va-cfg-ta');

            if (!ta) {
                ta = DOC.createElement('textarea');
                ta.id = 'va-cfg-ta';
                ta.style.cssText = 'width:100%;height:84px;margin-top:8px;background:rgba(0,0,0,.3);color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px;font-size:11px;font-family:ui-monospace,Consolas,monospace;';
                this._panel.querySelector('#page-tools').appendChild(ta);
            }

            return ta;
        }

        _import() {
            let ta = this._panel.querySelector('#va-cfg-ta');
            const hint = this._panel.querySelector('#va-hint');

            if (!ta) {
                ta = this._ensureTextarea();
                ta.placeholder = '粘贴 JSON 配置后再次点击导入';
                if (hint) hint.textContent = '粘贴配置后再次点击“导入配置”。';
                return;
            }

            if (!ta.value.trim()) {
                this.toast('请先粘贴 JSON 配置', 'warn');
                return;
            }

            this.bus.emit('CONFIG_IMPORT_REQUEST', { json: ta.value });
        }

        _mountWhenReady() {
            if (this.host.isConnected) return;

            const doMount = () => {
                try {
                    (DOC.body || DOC.documentElement).appendChild(this.host);
                } catch (e) { }
            };

            if (DOC.body) doMount();
            else DOC.addEventListener('DOMContentLoaded', doMount, { once: true });
        }

        toggle() {
            this._visible ? this.hide() : this.show();
        }

        show() {
            this._mountWhenReady();
            this._syncSettings();
            this._renderAllLogs();
            this._renderTimeline();

            this._panel.style.display = '';
            this._visible = true;

            if (this._fab) this._fab.style.display = 'none';
        }

        hide() {
            this._panel.style.display = 'none';
            this._visible = false;

            if (this._fab) this._fab.style.display = 'flex';
        }

        toast(msg, kind) {
            if (ConfigManager.get('showToast') === false) return;

            this._mountWhenReady();

            this._toast.textContent = msg;
            this._toast.className = 'toast show ' + (kind || '');

            clearTimeout(this._toastT);
            this._toastT = setTimeout(() => {
                this._toast.className = 'toast';
            }, 2000);
        }

        _fmtTime(s) {
            if (!isFinite(s) || s <= 0) return '--:--';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + String(sec).padStart(2, '0');
        }

        _fmtBw(bps) {
            if (!bps || bps <= 0) return '未知';
            if (bps >= 1000000) return (bps / 1000000).toFixed(1) + ' Mbps';
            if (bps >= 1000) return (bps / 1000).toFixed(0) + ' Kbps';
            return bps + ' bps';
        }

        _healthScore(s) {
            let score = 0;

            const bw = s.bandwidth || 0;
            if (bw > 0) score += clamp(Math.round((bw / 8000000) * 45), 0, 45);

            if (s.readyState >= 3) score += 20;
            else if (s.readyState >= 2) score += 10;

            const buf = s.buffer || 0;
            if (buf >= 10) score += 20;
            else if (buf >= 4) score += 12;
            else if (buf >= 1) score += 5;

            if (s.stallLevel >= 3) score -= 25;
            else if (s.stallLevel === 2) score -= 15;
            else if (s.stallLevel === 1) score -= 8;

            if (s.recoveries) score -= Math.min(15, s.recoveries * 2);
            if (s.sessionState === SessionState.FAILED) score -= 20;
            if (s.sessionState === SessionState.RECOVERING) score -= 10;

            return clamp(score, 0, 100);
        }

        _matchesFilter(entry) {
            const f = this._logFilter || 'all';
            if (f === 'all') return true;

            const order = { debug: 10, info: 20, warn: 30, error: 40 };
            return (order[entry.level] || 20) >= (order[f] || 20);
        }

        _appendLog(entry) {
            if (!entry) return;

            this._logs.push(entry);
            if (this._logs.length > VA_BUFFER.LOG_LINE_LIMIT) this._logs.shift();

            if (this._visible && this._matchesFilter(entry)) {
                this._renderLogLine(entry);
            }

            if (entry.level === 'warn' || entry.level === 'error') {
                this._addTimelineMarker(entry.level === 'error' ? 'error' : 'warn', entry.message || entry.level);
            }
        }

        _renderLogLine(entry) {
            const logsEl = this._panel.querySelector('#va-logs');
            if (!logsEl) return;

            const nearBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 40;

            const div = DOC.createElement('div');
            div.className = 'log-line ' + entry.level;

            const time = new Date(entry.ts).toLocaleTimeString();
            const scope = entry.remote ? (entry.scope + ':remote') : entry.scope;

            div.textContent = '[' + time + '] [' + entry.level.toUpperCase() + '] ' + scope + ': ' + entry.message;

            logsEl.appendChild(div);

            while (logsEl.children.length > VA_BUFFER.LOG_LINE_LIMIT) {
                logsEl.removeChild(logsEl.firstChild);
            }

            if (nearBottom) logsEl.scrollTop = logsEl.scrollHeight;
        }

        _renderAllLogs() {
            const logsEl = this._panel.querySelector('#va-logs');
            if (!logsEl) return;

            logsEl.innerHTML = '';

            for (const entry of this._logs) {
                if (this._matchesFilter(entry)) this._renderLogLine(entry);
            }
        }

        _addTimelineMarker(type, label) {
            const now = NOW();

            this._timeline.push({ ts: now, type: type, label: label || '' });
            if (this._timeline.length > 120) this._timeline.shift();

            if (this._visible && now - this._lastTimelineRender > 1000) {
                this._lastTimelineRender = now;
                this._renderTimeline();
            }
        }

        _maybeAddStateMarkers(state) {
            if (!state) return;

            const now = NOW();

            if (state.stallLevel > 0 && now - this._lastStallMarker > VA_BUFFER.STALL_LOG_THROTTLE_MS) {
                this._lastStallMarker = now;
                this._addTimelineMarker('stall', '卡顿等级 ' + state.stallLevel);
            }

            if (state.recoveries && state.recoveries > this._lastRecoveries) {
                this._lastRecoveries = state.recoveries;
                this._addTimelineMarker('recover', '恢复');
            }
        }

        _renderTimeline() {
            const el = this._panel.querySelector('#va-timeline');
            if (!el) return;

            const now = NOW();
            const cutoff = now - 60000;

            this._timeline = this._timeline.filter(function (x) { return x.ts >= cutoff; });

            el.innerHTML = '';

            for (const item of this._timeline) {
                const age = now - item.ts;
                const left = Math.max(0, Math.min(100, (1 - age / 60000) * 100));

                const div = DOC.createElement('div');
                div.className = 'tl-item tl-' + item.type;
                div.style.left = left + '%';
                div.title = new Date(item.ts).toLocaleTimeString() + ' ' + item.label;

                el.appendChild(div);
            }
        }

        _updateFab(state) {
            if (!this._fab) return;

            let st = 'idle';

            if (!state || !state.videos) {
                st = 'idle';
            } else if (state.seeking) {
                st = 'seek';
            } else if (state.sessionState === 'recovering' || state.sessionState === 'failed') {
                st = 'recovering';
            } else if (state.sessionState === SessionState.DEGRADED || (state.buffer || 0) < 2) {
                st = 'degraded';
            } else if (state.statusKey === 'pause' || state.statusKey === 'stop' || state.sessionState === SessionState.USER_PAUSED) {
                st = 'paused';
            } else if (state.statusKey === 'play' || state.sessionState === SessionState.ACTIVE) {
                st = 'active';
            }

            this._fab.dataset.state = st;
        }

        update(state) {
            if (!state) return;

            Object.assign(this._state, state);
            if (!this._visible) return;

            const s = this._state;

            const set = (id, v) => {
                const el = this._panel.querySelector('#' + id);
                if (el) el.textContent = v;
            };

            set('va-status', s.status || '检测中');
            set('va-type', s.playerLabel || s.playerType || '-');
            set('va-session-state', s.sessionState || '-');
            set('va-buf-time', (s.buffer || 0).toFixed(1) + 's');
            set('va-rec', s.recoveries || 0);
            set('va-count', s.videos || 0);
            set('va-res', s.videoWidth && s.videoHeight ? s.videoWidth + '×' + s.videoHeight : '-');
            set('va-progress', this._fmtTime(s.currentTime) + ' / ' + this._fmtTime(s.duration));
            set('va-net', s.networkType || '-');
            set('va-bw', this._fmtBw(s.bandwidth));

            const readyLabels = ['未加载', '元数据', '有帧', '加载中', '可播放'];
            set('va-ready', readyLabels[s.readyState] || '-');

            const health = this._healthScore(s);
            const healthEl = this._panel.querySelector('#va-health');
            if (healthEl) {
                healthEl.textContent = health + ' 分';
                healthEl.style.color = health >= 70 ? '#30d158' : (health >= 40 ? '#ff9f0a' : '#ff453a');
            }

            const q = s.quality || {};
            let qText = '-';

            if (q.level >= 0 && q.total > 0) {
                qText = (q.level + 1) + '/' + q.total + (q.height ? ' ' + q.height + 'p' : '');
            } else if (q.height > 0) {
                qText = q.height + 'p';
            }

            set('va-quality', qText);

            const canQ = s.canChangeQuality === true;
            const upBtn = this._panel.querySelector('#va-up');
            const downBtn = this._panel.querySelector('#va-down');

            if (upBtn) upBtn.disabled = !canQ;
            if (downBtn) downBtn.disabled = !canQ;

            const fill = this._panel.querySelector('#va-buf-fill');
            if (fill) fill.style.width = Math.min(100, ((s.buffer || 0) / 60) * 100) + '%';

            const dot = this._panel.querySelector('#va-dot');
            if (dot) {
                let cls = 'dot';

                if (s.seeking) cls += ' seek';
                else if (s.statusKey === 'play') cls += ' live';
                else if (s.statusKey === 'pause') cls += ' pause';
                else if (s.statusKey === 'stop') cls += ' stop';

                dot.className = cls;
            }

            const stallEl = this._panel.querySelector('#va-stall');
            if (stallEl) {
                if (s.stallLevel >= 3) {
                    stallEl.textContent = '重载中';
                    stallEl.className = 'stall-badge s3';
                } else if (s.stallLevel === 2) {
                    stallEl.textContent = '恢复中';
                    stallEl.className = 'stall-badge s2';
                } else if (s.stallLevel === 1) {
                    stallEl.textContent = '轻推';
                    stallEl.className = 'stall-badge s1';
                } else {
                    stallEl.textContent = '';
                    stallEl.className = '';
                }
            }

            const now = NOW();
            if (now - this._lastTimelineRender > VA_BUFFER.TIMELINE_RENDER_THROTTLE_MS) {
                this._lastTimelineRender = now;
                this._renderTimeline();
            }
        }
    }

    /* ═══════════════════════════════════════════════════════════
       启动
    ═══════════════════════════════════════════════════════════ */

    HookManager.installAll(PW, DOC);
    Detector.start();
    Scheduler.start();

    let ui = null;
    if (IS_TOP) {
        ui = new UIManager(Bus);
    }

    if (IS_TOP) {
        try {
            if (typeof GM_registerMenuCommand === 'function') {
                GM_registerMenuCommand('⚙ 视频控制台', function () { Bus.emit('UI_TOGGLE', {}); });
                GM_registerMenuCommand('🔧 恢复播放', function () { Bus.emit('CMD', { cmd: 'recover', remote: false }); });
                GM_registerMenuCommand('⚡ 重新加载', function () { Bus.emit('CMD', { cmd: 'reload', remote: false }); });
                GM_registerMenuCommand('📈 提升画质', function () { Bus.emit('CMD', { cmd: 'upgrade', remote: false }); });
                GM_registerMenuCommand('📉 降低画质', function () { Bus.emit('CMD', { cmd: 'downgrade', remote: false }); });
            }
        } catch (e) { }
    }

    // 跨脚本保护：监听广告拦截器 UI 的挂载，确保不被误拦截
    // 广告拦截器可能将 video-accelerator 的 UI 误判为广告覆盖层
    try {
        const _observeAdBlockerUI = () => {
            if (typeof MutationObserver === 'undefined') return;
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        // 如果广告拦截器插入了 va-ui-host，确保它不被隐藏
                        if (node.id === 'va-ui-host' && node.style.display === 'none') {
                            node.style.display = '';
                            Logger.warn('Cross-script', 'Ad blocker re-hidden va-ui-host, restored');
                        }
                        // 递归检查子节点
                        if (node.querySelectorAll) {
                            node.querySelectorAll('#va-ui-host').forEach(el => {
                                if (el.style.display === 'none') {
                                    el.style.display = '';
                                }
                            });
                        }
                    }
                }
            });
            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true
            });
        };
        _observeAdBlockerUI();
    } catch (e) { }

    try {
        PW.__VA__ = Object.assign(PW.__VA__ || {}, {
            version: VERSION,
            IS_TOP: IS_TOP,
            bus: Bus,
            config: ConfigManager,
            sessions: function () { return SessionManager.sessions.size; }
        });
    } catch (e) { }

    Logger.info('Boot', 'v19 视频加速引擎已启动', { version: VERSION, top: IS_TOP });
})();