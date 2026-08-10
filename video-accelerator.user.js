// ==UserScript==
// @name         视频快速检测与稳定播放 (微内核事件驱动版)
// @namespace    http://tampermonkey.net/
// @version      18.1.0
// @description  v18.1：微内核 + EventBus 架构；原型嗅探、pointerdown 预启动、RVFC 帧级监控、DNS/preconnect 预热、批量 DOM 扫描、iframe 穿透、HLS 优化、Seek 保护、卡死恢复、日志流、网络健康评分与卡顿时间轴。修复配置持久化（GM 存储 + localStorage 兜底 + pagehide 刷新前保存）。
// @author       EFate (Refactored by AI)
// @match        http://*/*
// @match        https://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/video-accelerator.user.js
// @updateURL    https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/video-accelerator.user.js
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '18.1.0';
    const PW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const DOC = PW.document || document;
    const LOC = PW.location || location;
    const NOW = function () { return Date.now(); };

    let IS_TOP = true;
    try { if (PW.self !== PW.top) IS_TOP = false; } catch (e) { IS_TOP = false; }

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

    const clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };

    const VIDEO_RE = /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v|flv|mp3|aac)(\?|$)|\/(seg|chunk|frag|segment|video|audio|media)s?\//i;
    const isVideoResource = function (url) { return VIDEO_RE.test(url || ''); };

    const isLive = function (v) {
        try { return v && v.duration === Infinity; } catch (e) { return false; }
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

    function estimateBandwidth() {
        try {
            const perf = PW.performance || performance;
            if (!perf || !perf.getEntriesByType) return 0;
            const entries = perf.getEntriesByType('resource')
                .filter(function (e) {
                    return isVideoResource(e.name) && (e.transferSize || 0) > 0 && (e.duration || 0) > 0;
                })
                .sort(function (a, b) { return b.startTime - a.startTime; })
                .slice(0, 5);
            if (!entries.length) return 0;
            const bytes = entries.reduce(function (s, e) { return s + e.transferSize; }, 0);
            const ms = entries.reduce(function (s, e) { return s + e.duration; }, 0);
            return Math.round((bytes * 8) / (ms / 1000));
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
            if (p && typeof p.catch === 'function') p.catch(function () { });
        } catch (e) { }
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

    /* ═══════════════════════════════════════════════════════════
       EventBus 事件总线
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

    /* ═══════════════════════════════════════════════════════════
       Storage 持久化存储（GM 优先，localStorage 兜底）
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
       ConfigManager 配置中心
    ═══════════════════════════════════════════════════════════ */

    const STORAGE_KEY = 'va_config_v18_0';

    class ConfigManagerClass {
        constructor(bus) {
            this.bus = bus;
            this._cache = null;
            this.defaults = {
                // 稳定播放
                autoPlay: true,
                bigBuffer: true,
                seekGuard: true,
                watchdog: true,
                autoDowngrade: true,
                bufferTarget: 60,
                seekTimeout: 5000,

                // UI / 日志
                showToast: true,
                showDetect: true,
                logLevel: 'info', // debug / info / warn / error

                // 识别与网络
                minPreBuffer: 2,
                fastDetect: true,
                fetchPriority: true,
                visibleOnly: true,
                minVideoArea: 8000,

                // 极速接管
                protoHook: true,
                earlyPointer: true,
                preconnect: true,
                rvfcMonitor: true,
                instantPlay: true,

                // 画质管理
                qualityManage: true
            };
            this._installRequests();
        }

        load() {
            if (this._cache) return this._cache;
            let raw = null;
            try { raw = Storage.get(STORAGE_KEY, null); } catch (e) { }

            let obj = null;
            if (typeof raw === 'string') {
                try { obj = JSON.parse(raw); } catch (e) { obj = null; }
            } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                obj = raw;
            }

            this._cache = Object.assign({}, this.defaults, obj || {});
            this._normalize();
            return this._cache;
        }

        _normalize() {
            const c = this._cache;
            delete c.siteProfiles;

            c.bufferTarget = clamp(parseInt(c.bufferTarget, 10) || 60, 10, 300);
            c.minPreBuffer = clamp(parseInt(c.minPreBuffer, 10) || 2, 1, 30);
            c.seekTimeout = clamp(parseInt(c.seekTimeout, 10) || 5000, 2000, 15000);

            const mva = parseInt(c.minVideoArea, 10);
            c.minVideoArea = isNaN(mva) ? 8000 : Math.max(0, mva);

            const levels = ['debug', 'info', 'warn', 'error'];
            if (levels.indexOf(c.logLevel) < 0) c.logLevel = 'info';

            const boolKeys = [
                'autoPlay', 'bigBuffer', 'seekGuard', 'watchdog', 'autoDowngrade',
                'showToast', 'showDetect', 'fastDetect', 'fetchPriority', 'visibleOnly',
                'protoHook', 'earlyPointer', 'preconnect', 'rvfcMonitor', 'instantPlay',
                'qualityManage'
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
            this.bus.emit('CONFIG_CHANGE', { key: k, value: this.get(k), config: this.load(), local: true });
        }

        update(patch) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
            const c = this.load();
            Object.assign(c, patch);
            this._normalize();
            this.save();
            this.bus.emit('CONFIG_CHANGE', { batch: true, config: this.load(), local: true });
        }

        silentUpdate(patch) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
            const c = this.load();
            Object.assign(c, patch);
            this._normalize();
            this.save();
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
       Logger 日志系统
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

    /* ═══════════════════════════════════════════════════════════
       StateStore 状态聚合器
    ═══════════════════════════════════════════════════════════ */

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
            return {
                status: '未检测到视频',
                statusKey: 'idle',
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
                stallLevel: 0
            };
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
       CrossWindowBridge 跨窗口通信桥
    ═══════════════════════════════════════════════════════════ */

    class CrossWindowBridge {
        constructor(bus) {
            this.bus = bus;
            this._initListener();
            this._install();
        }

        _postTop(type, payload) {
            if (!IS_TOP && PW.top) {
                try {
                    PW.top.postMessage(Object.assign({
                        __va_msg: true,
                        type: type,
                        iframeId: IFRAME_ID
                    }, payload || {}), '*');
                } catch (e) { }
            }
        }

        broadcastToFrames(type, payload) {
            try {
                const msg = Object.assign({ __va_msg: true, type: type }, payload || {});
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

        _initListener() {
            PW.addEventListener('message', (e) => {
                const d = e.data;
                if (!d || typeof d !== 'object' || !d.__va_msg) return;
                this._handle(d, e.source);
            });
        }

        _handle(d, source) {
            if (IS_TOP) {
                if (d.type === 'VA_STATE_UPDATE') {
                    this.bus.emit('REMOTE_STATE', { iframeId: d.iframeId, state: d.state });
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
                            type: 'VA_CFG_SYNC',
                            config: ConfigManager.load()
                        }, '*');
                    } catch (e) { }
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
            // 子 iframe 上报本地状态
            this.bus.on('LOCAL_STATE', (state) => {
                if (!IS_TOP) this._postTop('VA_STATE_UPDATE', { state: state });
            });

            // 子 iframe 上报日志
            this.bus.on('LOG_EMIT', (entry) => {
                if (!IS_TOP && entry && !entry.remote) this._postTop('VA_LOG', { entry: entry });
            });

            // 子 iframe 请求 Toast
            this.bus.on('TOAST', (payload) => {
                if (!IS_TOP && payload && !payload.remote) this._postTop('VA_TOAST', payload);
            });

            // 顶层配置变化同步到子 iframe
            this.bus.on('CONFIG_CHANGE', (payload) => {
                if (IS_TOP && !(payload && payload.remote)) {
                    this.broadcastToFrames('VA_CFG_SYNC', { config: ConfigManager.load() });
                }
            });

            // 顶层命令下发到子 iframe
            this.bus.on('CMD', (payload) => {
                if (IS_TOP && !(payload && payload.remote)) {
                    this.broadcastToFrames('VA_CMD', { cmd: payload && payload.cmd });
                }
            });

            // 子 iframe 启动时请求配置
            if (!IS_TOP) {
                this._postTop('VA_REQ_CFG', {});
            }
        }
    }

    const Bridge = new CrossWindowBridge(Bus);

    /* ═══════════════════════════════════════════════════════════
       preconnect / fetch 工具
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
       HookManager：原型 / fetch / 手势
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
                                    bus.emit('VIDEO_FOUND', { video: this, reason: 'src', force: true });
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
                                bus.emit('VIDEO_FOUND', { video: this, reason: 'play', force: true });
                            }
                            if (ConfigManager.get('instantPlay')) {
                                bus.emit('VIDEO_BOOST', { video: this, reason: 'play' });
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
                                bus.emit('VIDEO_FOUND', { video: this, reason: 'load', force: false });
                            }
                            bus.emit('VIDEO_BOOST', { video: this, reason: 'load' });
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

                        bus.emit('VIDEO_FOUND', { video: video, reason: 'pointer', force: true });
                        bus.emit('VIDEO_BOOST', { video: video, reason: 'pointer' });

                        if (ConfigManager.get('autoPlay') && video.paused && !video.ended) {
                            const s = video.__vaSession;
                            if (!s || !s._userPaused) {
                                tryPlay(video);
                            }
                        }
                    } catch (err) { }
                };

                ['pointerdown', 'mousedown', 'touchstart'].forEach(function (ev) {
                    doc.addEventListener(ev, handler, { capture: true, passive: true });
                });
            } catch (e) { }
        }
    }

    const HookManager = new HookManagerClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       Detector：DOM / iframe / 可见性检测
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
            this._patrolIv = null;
            this._initViewportObserver();
        }

        start() {
            this._setupDoc(DOC, PW);

            try {
                DOC.addEventListener('load', (e) => {
                    const t = e.target;
                    if (t && t.nodeName === 'IFRAME') this._hookIframe(t);
                }, true);
            } catch (e) { }

            this._patrolIv = setInterval(() => this._patrol(), 2500);
        }

        _setupDoc(doc, win) {
            if (!doc) return;
            win = win || (doc.defaultView || PW);

            try { HOOKED_DOCS.add(doc); } catch (e) { }

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
                        this.bus.emit('VIDEO_FOUND', { video: entry.target, reason: 'viewport', force: true });
                        try {
                            this._viewportObs.unobserve(entry.target);
                            this._viewportTargets.delete(entry.target);
                        } catch (e) { }
                    }
                }
            }, { rootMargin: '300px' });
        }

        watchViewport(video) {
            if (!video) return;
            if (this._viewportTargets.has(video)) return;

            if (this._viewportObs && video.ownerDocument === DOC) {
                this._viewportTargets.add(video);
                try { this._viewportObs.observe(video); } catch (e) { }
            } else {
                this.bus.emit('VIDEO_FOUND', { video: video, reason: 'viewport-direct', force: false });
            }
        }

        _onMutations(muts) {
            if (!ConfigManager.get('fastDetect')) return;

            let need = false;

            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;

                    if (node.nodeName === 'VIDEO') {
                        this.bus.emit('VIDEO_FOUND', { video: node, reason: 'mutation', force: false });
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

            try {
                const raf = PW.requestAnimationFrame
                    ? PW.requestAnimationFrame.bind(PW)
                    : function (cb) { return PW.setTimeout(cb, 50); };
                raf(flush);
            } catch (e) {
                PW.setTimeout(flush, 50);
            }
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
                    this.bus.emit('VIDEO_FOUND', { video: root, reason: 'scan', force: false });
                } else if (name === 'IFRAME') {
                    this._hookIframe(root);
                }

                if (root.querySelectorAll) {
                    const els = root.querySelectorAll('video,iframe');
                    const limit = Math.min(els.length, 800);
                    for (let i = 0; i < limit; i++) {
                        const el = els[i];
                        if (el.nodeName === 'VIDEO') {
                            this.bus.emit('VIDEO_FOUND', { video: el, reason: 'scan', force: false });
                        } else if (el.nodeName === 'IFRAME') {
                            this._hookIframe(el);
                        }
                    }
                }
            } catch (e) { }

            try {
                if (root.querySelectorAll) {
                    const all = root.querySelectorAll('*');
                    const limit = Math.min(all.length, 250);
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
            if (DOC.hidden) return;
            try { this.refresh(); } catch (e) { }
            this.bus.emit('PATROL', {});
        }
    }

    const Detector = new DetectorClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       播放器适配器
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

            hls.config.maxBufferLength = big ? 120 : Math.max(30, target);
            hls.config.maxMaxBufferLength = big ? 600 : 300;
            hls.config.maxBufferHole = 0.2;
            hls.config.startFragPrefetch = true;
            hls.config.backBufferLength = big ? 90 : 30;
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
            try { return this._map.get(v); } catch (e) { return undefined; }
        },
        set(v, info) {
            try { this._map.set(v, info); } catch (e) { }
        }
    };

    const Adaptor = {
        detect(video) {
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
       VideoSession 单视频会话
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
            this.isSeeking = false;
            this.seekTarget = 0;
            this._seekStartTime = 0;
            this._wasPlayingBeforeSeek = false;

            this._bufferIv = null;
            this._stallIv = null;

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

            video.__vaSession = this;

            try {
                Adaptor.boost(video);
            } catch (e) { }

            this._bindEvents();

            this._bufferIv = setInterval(() => this._bufferCheck(), 700);
            this._stallIv = setInterval(() => this._stallCheck(), 450);

            if (opts.force) {
                this._userPaused = false;
                this._boostLoad();
            }

            this._startRvfc();

            if (ConfigManager.get('showDetect') && ConfigManager.get('showToast')) {
                Bus.emit('TOAST', { msg: '已接管视频 #' + this.id, kind: 'ok', remote: false });
            }

            Logger.info('Session', '接管视频 #' + this.id, { type: this.type, reason: opts.reason || 'unknown' });
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        _bindEvents() {
            const v = this.video;

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
            this._onWaiting = () => { this._stallLevel = Math.max(this._stallLevel, 1); };

            this._onPause = () => {
                if (this._playedOnce && !v.ended) this._userPaused = true;
                this._stopRvfc();
            };

            this._onPlay = () => {
                this._playedOnce = true;
                this._userPaused = false;
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

                this._userPaused = false;
                this._autoTried = 0;
                this._boostLoad();
                tryPlay(v);
            };

            this._onError = () => {
                try {
                    if (
                        ConfigManager.get('watchdog') &&
                        !this._userPaused &&
                        !v.ended &&
                        NOW() - this._lastEmergency > 2500
                    ) {
                        this._lastEmergency = NOW();
                        this._emergencyLoad();
                        Logger.warn('Session', '视频错误，触发紧急恢复 #' + this.id);
                    }
                } catch (e) { }
            };

            v.addEventListener('seeking', this._onSeeking);
            v.addEventListener('seeked', this._onSeeked);
            v.addEventListener('loadedmetadata', this._onLoaded);
            v.addEventListener('canplay', this._onCanPlay);
            v.addEventListener('waiting', this._onWaiting);
            v.addEventListener('pause', this._onPause);
            v.addEventListener('play', this._onPlay);
            v.addEventListener('click', this._onClick, true);
            v.addEventListener('error', this._onError, true);
        }

        _maybeAutoPlay() {
            if (!ConfigManager.get('autoPlay') || this._userPaused || this._playedOnce || this._autoTried >= 3) return;

            const v = this.video;
            const doc = v.ownerDocument || DOC;
            if (doc.hidden || !v.paused || v.ended) return;

            const ahead = this._bufferAhead();
            const minPre = ConfigManager.get('minPreBuffer') || 2;

            if (ahead >= minPre || isLive(v) || v.readyState >= 3 || (this._autoTried === 0 && v.readyState >= 2)) {
                this._autoTried++;
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
                        Bus.emit('SESSION_UPDATE', { sessionId: this.id });
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

        _bufferCheck() {
            const v = this.video;
            if (!v || this._dead) return;

            const ahead = this._bufferAhead();
            const now = NOW();

            if (ahead < 1 && v.readyState < 3 && !v.paused && !this.isSeeking) {
                if (now - this._lastEmergency > 3000) {
                    this._lastEmergency = now;
                    this._emergencyLoad();
                    this._lowCount++;

                    if (
                        this._lowCount >= 2 &&
                        ConfigManager.get('autoDowngrade') &&
                        ConfigManager.get('qualityManage')
                    ) {
                        if (Adaptor.switchLevel(v, -1)) {
                            Bus.emit('TOAST', { msg: '网络不佳，已降画质', kind: 'warn', remote: false });
                            Logger.warn('Session', '自动降低画质 #' + this.id);
                        }
                        this._lowCount = 0;
                    }
                }
            } else if (ahead < 8 && !v.paused && !this.isSeeking) {
                if (now - this._lastBoost > 8000) {
                    this._lastBoost = now;
                    this._boostLoad();
                }
                if (ahead > 5) this._lowCount = 0;
            } else {
                this._lowCount = 0;
            }

            const back = this._backBuffer();
            if (back > 120) Adaptor.trimBack(v, 30);

            if (this.isSeeking && ConfigManager.get('seekGuard')) {
                const timeout = ConfigManager.get('seekTimeout') || 5000;
                if (NOW() - this._seekStartTime > timeout) this._forceSeekRecover();
            }

            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
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
                return;
            }

            const now = NOW();
            const t = v.currentTime;

            const frameRecent = ConfigManager.get('rvfcMonitor') &&
                this._lastFrameTs &&
                (now - this._lastFrameTs < 1200);

            if (t === this._lastTime && !frameRecent) {
                if (!this._stallStart) this._stallStart = NOW();

                const stalled = NOW() - this._stallStart;

                if (stalled >= 1800 && this._stallLevel === 0) {
                    this._stallLevel = 1;
                    Bus.emit('STALL_DETECTED', { session: this, level: 1 });
                } else if (stalled >= 3800 && this._stallLevel === 1) {
                    this._stallLevel = 2;
                    Bus.emit('STALL_DETECTED', { session: this, level: 2 });
                } else if (stalled >= 6500 && this._stallLevel === 2) {
                    this._stallLevel = 3;
                    this._stallStart = 0;
                    Bus.emit('STALL_DETECTED', { session: this, level: 3 });
                }
            } else {
                this._stallStart = 0;
                this._stallLevel = 0;
                this._lastTime = t;
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
            } else if (this.video.error || this.video.networkState === 3) {
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

        softReload() {
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

                if (ConfigManager.get('autoPlay') && !v.ended) {
                    this._userPaused = false;
                    tryPlay(v);
                }
            } catch (e) { }

            this._stallLevel = 0;
            Logger.warn('Session', '软重载 #' + this.id);
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }

        engineRecover() {
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

                if (ConfigManager.get('autoPlay') && !v.ended) {
                    this._userPaused = false;
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
                stallLevel: this._stallLevel
            };
        }

        destroy() {
            this._dead = true;

            if (this._bufferIv) { clearInterval(this._bufferIv); this._bufferIv = null; }
            if (this._stallIv) { clearInterval(this._stallIv); this._stallIv = null; }

            this._stopRvfc();

            try {
                this.video.removeEventListener('seeking', this._onSeeking);
                this.video.removeEventListener('seeked', this._onSeeked);
                this.video.removeEventListener('loadedmetadata', this._onLoaded);
                this.video.removeEventListener('canplay', this._onCanPlay);
                this.video.removeEventListener('waiting', this._onWaiting);
                this.video.removeEventListener('pause', this._onPause);
                this.video.removeEventListener('play', this._onPlay);
                this.video.removeEventListener('click', this._onClick, true);
                this.video.removeEventListener('error', this._onError, true);
            } catch (e) { }

            try { delete this.video.__vaSession; } catch (e) { }

            Bus.emit('SESSION_DESTROY', { session: this });
            Bus.emit('SESSION_UPDATE', { sessionId: this.id });
        }
    }

    /* ═══════════════════════════════════════════════════════════
       SessionManager 会话管理器
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
            this.bus.on('VIDEO_FOUND', (payload) => {
                if (!payload || !payload.video) return;
                this._queueTakeOver(payload.video, payload);
            });

            this.bus.on('VIDEO_BOOST', (payload) => {
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
                try { this.seen.delete(payload.session.video); } catch (e) { }
            });

            this.bus.on('PATROL', () => {
                this._patrolCleanup();
                this._publishLocal(true);
            });

            this.bus.on('CONFIG_CHANGE', () => {
                this.applyConfig();
            });
        }

        _queueTakeOver(video, opts) {
            opts = opts || {};
            if (!video || video.nodeName !== 'VIDEO') return;

            const s = video.__vaSession;
            if (s) {
                if (opts.force) {
                    s._userPaused = false;
                    s._boostLoad();
                    if (ConfigManager.get('autoPlay') && video.paused && !video.ended) {
                        tryPlay(video);
                    }
                }
                return;
            }

            if (this.seen.has(video)) return;
            if (!video.isConnected && !opts.force) return;

            if (
                ConfigManager.get('visibleOnly') &&
                !opts.force &&
                video.ownerDocument === DOC &&
                Detector._viewportObs
            ) {
                Detector.watchViewport(video);
                return;
            }

            this._takeOver(video, opts);
        }

        _takeOver(video, opts) {
            opts = opts || {};

            if (this.seen.has(video) || video.__vaSession) return;
            if (!video || (!video.isConnected && !opts.force)) return;

            if (ConfigManager.get('visibleOnly') && !opts.force) {
                if (!isVisible(video) || videoArea(video) < (ConfigManager.get('minVideoArea') || 0)) return;
            }

            this.seen.add(video);

            try {
                const session = new VideoSession(video, opts);
                this.sessions.add(session);
                this.bus.emit('SESSION_CREATED', { session: session });
                this._schedulePublish();
            } catch (e) {
                Logger.error('SessionManager', '接管视频失败', e);
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
                if (s) {
                    s._userPaused = false;
                    s._boostLoad();
                }
            } catch (e) { }
        }

        command(cmd, remote) {
            if (cmd === 'recover') {
                this.sessions.forEach(function (s) {
                    try { s._userPaused = false; s.engineRecover(); } catch (e) { }
                });
                Logger.info('Command', '执行恢复播放', { remote: !!remote });
            } else if (cmd === 'reload') {
                this.sessions.forEach(function (s) {
                    try { s._userPaused = false; s.softReload(); } catch (e) { }
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
                score += videoArea(v);

                if (score > bestScore) {
                    bestScore = score;
                    primary = s;
                }
            });

            if (!primary) {
                return {
                    status: '未检测到视频',
                    statusKey: 'idle',
                    playerType: 'unknown',
                    playerLabel: '-',
                    buffer: 0,
                    recoveries: recoveries,
                    videos: videos,
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
                    stallLevel: 0
                };
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
                try { s.destroy(); } catch (e) { }
            });
        }
    }

    const SessionManager = new SessionManagerClass(Bus);

    /* ═══════════════════════════════════════════════════════════
       RecoveryStrategy 分级恢复策略
    ═══════════════════════════════════════════════════════════ */

    const RecoveryStrategy = {
        init() {
            Bus.on('STALL_DETECTED', (payload) => {
                if (!payload || !payload.session || payload.session._dead) return;

                const session = payload.session;
                const level = payload.level;

                try {
                    if (level === 1) {
                        session._nudge();
                        Logger.info('Recovery', 'L1 轻推 #' + session.id);
                    } else if (level === 2) {
                        session._reloadSegment();
                        Logger.warn('Recovery', 'L2 重载切片 #' + session.id);
                    } else if (level === 3) {
                        session.engineRecover();
                        Logger.warn('Recovery', 'L3 引擎恢复 #' + session.id);
                    }
                } catch (e) {
                    Logger.error('Recovery', '恢复执行失败 #' + session.id, e);
                }
            });
        }
    };

    RecoveryStrategy.init();

    /* ═══════════════════════════════════════════════════════════
       UIManager 控制台
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

            const style = DOC.createElement('style');
            style.textContent = `
                :host{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px}
                *{box-sizing:border-box}
                .panel{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    background:rgba(12,12,18,.94);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
                    border:1px solid rgba(255,255,255,.12);border-radius:14px;
                    box-shadow:0 20px 60px rgba(0,0,0,.5);
                    width:min(460px,calc(100vw - 24px));max-height:80vh;overflow:hidden;color:#e8e8ec;
                    display:flex;flex-direction:column}
                .hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;
                    border-bottom:1px solid rgba(255,255,255,.08)}
                .hdr h3{margin:0;font-size:15px;font-weight:600;color:#fff}
                .close-x{background:none;border:none;color:#666;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:5px}
                .close-x:hover{color:#fff;background:rgba(255,255,255,.1)}
                .tabs{display:flex;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);gap:2px}
                .tab{padding:9px 12px;cursor:pointer;font-size:12px;color:#777;border-bottom:2px solid transparent;user-select:none}
                .tab:hover{color:#bbb}
                .tab.active{color:#fff;border-bottom-color:#0a84ff}
                .body{padding:10px 14px 12px;overflow-y:auto;flex:1;min-height:0}
                .page{display:none}
                .page.active{display:block}
                .row{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#999;margin:3px 0;flex-wrap:wrap}
                .row b{color:#fff}
                .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;background:#555}
                .dot.live{background:#30d158;box-shadow:0 0 6px #30d158}
                .dot.pause{background:#8e8e93}
                .dot.stop{background:#ff9f0a}
                .dot.seek{background:#bf5af2;box-shadow:0 0 6px #bf5af2}
                .buf-wrap{margin:8px 0}
                .buf-label{display:flex;justify-content:space-between;font-size:11px;color:#888;margin-bottom:4px}
                .buf-bar{height:5px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden}
                .buf-fill{height:100%;background:linear-gradient(90deg,#0a84ff,#30d158);width:0%;transition:width .25s cubic-bezier(0.4,0,.2,1);border-radius:3px}
                .info-box{background:rgba(255,255,255,.04);border-radius:8px;padding:6px 10px;margin:5px 0;font-size:12px;color:#999;line-height:1.6}
                .info-box span{color:#ddd;font-weight:500}
                .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin:8px 0}
                .stat-card{background:rgba(255,255,255,.05);border-radius:8px;padding:6px 8px;text-align:center}
                .stat-card .val{font-size:15px;font-weight:700;color:#fff}
                .stat-card .lbl{font-size:10px;color:#777}
                .btn-group{display:flex;gap:5px;flex-wrap:wrap;margin:6px 0}
                button.act{padding:8px 10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;
                    font-size:12px;font-weight:500;flex:1;display:flex;align-items:center;justify-content:center;
                    background:rgba(255,255,255,.07);color:#fff;transition:all .15s}
                button.act:hover:not(:disabled){filter:brightness(1.2);transform:translateY(-1px)}
                button.act:active:not(:disabled){transform:translateY(1px);filter:brightness(0.9)}
                button.act:disabled{opacity:.3;cursor:not-allowed}
                .btn-p{background:rgba(10,132,255,.6)}
                .btn-w{background:rgba(255,159,10,.6)}
                .btn-g{background:rgba(48,209,88,.6)}
                .btn-d{background:rgba(255,69,58,.6)}
                .divider{height:1px;background:rgba(255,255,255,.08);margin:8px 0}
                .sec-title{font-size:11px;color:#0a84ff;margin:8px 0 4px;font-weight:600}
                label.opt{display:flex;align-items:center;gap:7px;font-size:12px;color:#bbb;margin:5px 0;cursor:pointer}
                label.opt input[type=checkbox]{width:15px;height:15px;accent-color:#0a84ff;cursor:pointer}
                label.opt input[type=number],label.opt select{width:88px;padding:4px 6px;margin-left:auto;border:1px solid rgba(255,255,255,.12);
                    border-radius:6px;background:rgba(0,0,0,.3);color:#eee;font-size:12px}
                .hint{font-size:11px;color:#666;line-height:1.5;margin-top:8px}
                .toast{position:fixed;top:18px;right:18px;padding:8px 14px;border-radius:10px;
                    background:rgba(28,28,35,.95);border:1px solid rgba(255,255,255,.12);color:#fff;font-size:13px;
                    transform:translateX(120%);transition:transform .25s,opacity .25s;opacity:0;pointer-events:none;z-index:10}
                .toast.show{transform:translateX(0);opacity:1}
                .toast.ok{border-left:3px solid #30d158}
                .toast.warn{border-left:3px solid #ff9f0a}
                .toast.err{border-left:3px solid #ff453a}
                .stall-badge{display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:6px}
                .stall-badge.s1{background:rgba(255,159,10,.3);color:#ff9f0a}
                .stall-badge.s2{background:rgba(255,69,58,.3);color:#ff453a}
                .stall-badge.s3{background:rgba(255,0,0,.4);color:#fff}
                .fab{position:fixed;bottom:18px;right:18px;width:38px;height:38px;border-radius:50%;
                    background:rgba(10,132,255,.75);color:#fff;display:flex;align-items:center;justify-content:center;
                    font-size:18px;cursor:pointer;opacity:.45;transition:opacity .15s,transform .15s;z-index:9;user-select:none}
                .fab:hover{opacity:1;transform:scale(1.06)}
                .timeline-wrap{margin:8px 0}
                .timeline{position:relative;height:18px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden}
                .tl-item{position:absolute;top:2px;bottom:2px;width:3px;border-radius:1px}
                .tl-stall{background:#ff9f0a}
                .tl-warn{background:#ffd60a}
                .tl-error{background:#ff453a}
                .tl-recover{background:#30d158}
                .log-toolbar{display:flex;align-items:center;gap:6px;margin:8px 0}
                .log-toolbar span{font-size:11px;color:#0a84ff;font-weight:600}
                .log-toolbar select{margin-left:auto;padding:3px 6px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:rgba(0,0,0,.3);color:#eee;font-size:11px}
                .mini{padding:3px 8px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:rgba(255,255,255,.07);color:#fff;cursor:pointer;font-size:11px}
                .logs{height:160px;overflow:auto;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:6px;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.45}
                .log-line{white-space:pre-wrap;word-break:break-all}
                .log-line.debug{color:#8e8e93}
                .log-line.info{color:#d0d0d8}
                .log-line.warn{color:#ffd60a}
                .log-line.error{color:#ff453a}
                .dep-hint{font-size:11px;color:#ff9f0a;background:rgba(255,159,10,.08);border:1px solid rgba(255,159,10,.25);border-radius:6px;padding:5px 8px;margin:4px 0}
            `;
            this.root.appendChild(style);

            this._toast = DOC.createElement('div');
            this._toast.className = 'toast';
            this.root.appendChild(this._toast);

            this._fab = DOC.createElement('div');
            this._fab.className = 'fab';
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
                    <div class="tab active" data-tab="monitor">📊 实时监控</div>
                    <div class="tab" data-tab="settings">⚙️ 功能设置</div>
                    <div class="tab" data-tab="tools">📦 数据管理</div>
                </div>
                <div class="body">
                    <div class="page active" id="page-monitor">
                        <div class="row">
                            <span><span class="dot" id="va-dot"></span><b id="va-status">检测中</b><span id="va-stall"></span></span>
                            <span>播放器: <b id="va-type">-</b></span>
                            <span>视频数: <b id="va-count">0</b></span>
                        </div>

                        <div class="buf-wrap">
                            <div class="buf-label"><span>前方缓冲</span><span id="va-buf-time">0s</span></div>
                            <div class="buf-bar"><div class="buf-fill" id="va-buf-fill"></div></div>
                        </div>

                        <div class="info-box">
                            画质: <span id="va-quality">-</span> · 带宽: <span id="va-bw">-</span> · 分辨率: <span id="va-res">-</span><br>
                            网络健康: <span id="va-health">-</span> · 网络类型: <span id="va-net">-</span>
                        </div>

                        <div class="timeline-wrap">
                            <div class="buf-label"><span>近 60 秒卡顿 / 恢复时间轴</span></div>
                            <div class="timeline" id="va-timeline"></div>
                        </div>

                        <div class="stat-grid">
                            <div class="stat-card"><div class="val" id="va-rec">0</div><div class="lbl">恢复次数</div></div>
                            <div class="stat-card"><div class="val" id="va-ready">-</div><div class="lbl">就绪状态</div></div>
                        </div>

                        <div class="info-box">进度: <span id="va-progress">--/--</span></div>

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
                        <div class="sec-title">注入与嗅探策略</div>
                        <label class="opt"><input type="checkbox" id="va-proto"> 原型嗅探（src / play / load）</label>
                        <label class="opt"><input type="checkbox" id="va-pointer"> pointerdown 预启动</label>
                        <label class="opt"><input type="checkbox" id="va-fast"> DOM 动态扫描</label>
                        <label class="opt"><input type="checkbox" id="va-visible"> 仅接管可见视频</label>
                        <label class="opt">最小接管面积 <input type="number" id="va-area" min="0" step="1000"></label>

                        <div class="divider"></div>

                        <div class="sec-title">网络与缓冲策略</div>
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

                        <div class="sec-title">容错与自愈策略</div>
                        <label class="opt"><input type="checkbox" id="va-auto"> 自动播放 / 续播</label>
                        <label class="opt"><input type="checkbox" id="va-seek"> Seek 保护（超时恢复）</label>
                        <label class="opt">Seek 超时 <input type="number" id="va-seekto" min="2000" max="15000" step="500"> ms</label>
                        <label class="opt"><input type="checkbox" id="va-watchdog"> 卡死分级恢复</label>
                        <label class="opt"><input type="checkbox" id="va-rvfc"> RVFC 帧级卡顿监控</label>

                        <div class="divider"></div>

                        <div class="sec-title">检测与提示</div>
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

                        <div class="hint">v18 优先使用原型嗅探 + 手势预启动；缓冲 / 自动降画质主要对 HLS.js 生效。</div>
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
                        <div class="hint">v18.0：微内核架构、事件总线、日志流、网络健康评分、卡顿时间轴。</div>
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

        _bindSettings() {
            const bus = this.bus;

            const bind = (id, key, transform) => {
                const el = this._panel.querySelector('#' + id);
                if (!el) return;

                const handler = () => {
                    const value = transform ? transform(el) : el.checked;
                    bus.emit('CONFIG_SET', { key: key, value: value });
                };

                const isNumeric = el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'text');

                if (isNumeric) {
                    el.addEventListener('change', handler);
                } else {
                    el.addEventListener('input', handler);
                }
            };

            // 注入与嗅探
            bind('va-proto', 'protoHook');
            bind('va-pointer', 'earlyPointer');
            bind('va-fast', 'fastDetect');
            bind('va-visible', 'visibleOnly');
            bind('va-area', 'minVideoArea', function (el) { return parseInt(el.value, 10) || 0; });

            // 网络与缓冲
            bind('va-fetch', 'fetchPriority');
            bind('va-preconnect', 'preconnect');
            bind('va-instant', 'instantPlay');
            bind('va-big', 'bigBuffer');
            bind('va-btgt', 'bufferTarget', function (el) { return parseInt(el.value, 10) || 60; });
            bind('va-prebuf', 'minPreBuffer', function (el) { return parseInt(el.value, 10) || 2; });
            bind('va-quality', 'qualityManage');
            bind('va-autodown', 'autoDowngrade');

            // 容错与自愈
            bind('va-auto', 'autoPlay');
            bind('va-seek', 'seekGuard');
            bind('va-seekto', 'seekTimeout', function (el) { return parseInt(el.value, 10) || 5000; });
            bind('va-watchdog', 'watchdog');
            bind('va-rvfc', 'rvfcMonitor');

            // 检测与提示
            bind('va-toast', 'showToast');
            bind('va-detect', 'showDetect');
            bind('va-loglevel', 'logLevel', function (el) { return el.value; });
        }

        _flushSettings() {
            const patch = {};
            const read = (id, key, transform) => {
                const el = this._panel.querySelector('#' + id);
                if (!el) return;
                patch[key] = transform ? transform(el) : el.checked;
            };

            read('va-proto', 'protoHook');
            read('va-pointer', 'earlyPointer');
            read('va-fast', 'fastDetect');
            read('va-visible', 'visibleOnly');
            read('va-area', 'minVideoArea', function (el) { return parseInt(el.value, 10) || 0; });

            read('va-fetch', 'fetchPriority');
            read('va-preconnect', 'preconnect');
            read('va-instant', 'instantPlay');
            read('va-big', 'bigBuffer');
            read('va-btgt', 'bufferTarget', function (el) { return parseInt(el.value, 10) || 60; });
            read('va-prebuf', 'minPreBuffer', function (el) { return parseInt(el.value, 10) || 2; });
            read('va-quality', 'qualityManage');
            read('va-autodown', 'autoDowngrade');

            read('va-auto', 'autoPlay');
            read('va-seek', 'seekGuard');
            read('va-seekto', 'seekTimeout', function (el) { return parseInt(el.value, 10) || 5000; });
            read('va-watchdog', 'watchdog');
            read('va-rvfc', 'rvfcMonitor');

            read('va-toast', 'showToast');
            read('va-detect', 'showDetect');
            read('va-loglevel', 'logLevel', function (el) { return el.value; });

            ConfigManager.silentUpdate(patch);
        }

        _syncSettings() {
            const chk = (id, v) => {
                const el = this._panel.querySelector('#' + id);
                if (el) el.checked = !!v;
            };
            const set = (id, v) => {
                const el = this._panel.querySelector('#' + id);
                if (el) el.value = v;
            };

            chk('va-proto', ConfigManager.get('protoHook'));
            chk('va-pointer', ConfigManager.get('earlyPointer'));
            chk('va-fast', ConfigManager.get('fastDetect'));
            chk('va-visible', ConfigManager.get('visibleOnly'));
            set('va-area', ConfigManager.get('minVideoArea'));

            chk('va-fetch', ConfigManager.get('fetchPriority'));
            chk('va-preconnect', ConfigManager.get('preconnect'));
            chk('va-instant', ConfigManager.get('instantPlay'));
            chk('va-big', ConfigManager.get('bigBuffer'));
            set('va-btgt', ConfigManager.get('bufferTarget'));
            set('va-prebuf', ConfigManager.get('minPreBuffer'));
            chk('va-quality', ConfigManager.get('qualityManage'));
            chk('va-autodown', ConfigManager.get('autoDowngrade'));

            chk('va-auto', ConfigManager.get('autoPlay'));
            chk('va-seek', ConfigManager.get('seekGuard'));
            set('va-seekto', ConfigManager.get('seekTimeout'));
            chk('va-watchdog', ConfigManager.get('watchdog'));
            chk('va-rvfc', ConfigManager.get('rvfcMonitor'));

            chk('va-toast', ConfigManager.get('showToast'));
            chk('va-detect', ConfigManager.get('showDetect'));
            set('va-loglevel', ConfigManager.get('logLevel'));

            this._updateDependency();
        }

        _updateDependency() {
            const el = this._panel.querySelector('#va-dep-down');
            if (!el) return;
            const show = ConfigManager.get('autoDowngrade') && !ConfigManager.get('qualityManage');
            el.style.display = show ? 'block' : 'none';
        }

        _ensureTextarea() {
            let ta = this._panel.querySelector('#va-cfg-ta');
            if (!ta) {
                ta = DOC.createElement('textarea');
                ta.id = 'va-cfg-ta';
                ta.style.cssText = 'width:100%;height:80px;margin-top:8px;background:rgba(0,0,0,.3);color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;font-size:11px;font-family:ui-monospace,Consolas,monospace;';
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

            if (DOC.body) {
                doMount();
            } else {
                DOC.addEventListener('DOMContentLoaded', doMount, { once: true });
            }
        }

        _mount() {
            this._mountWhenReady();
        }

        toggle() {
            this._visible ? this.hide() : this.show();
        }

        show() {
            this._mount();
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

            this._mount();
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
            if (this._logs.length > 300) this._logs.shift();

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

            while (logsEl.children.length > 300) {
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

            if (state.stallLevel > 0 && now - this._lastStallMarker > 2000) {
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
                if (s.stallLevel >= 3) stallEl.innerHTML = '<span class="stall-badge s3">重载中</span>';
                else if (s.stallLevel === 2) stallEl.innerHTML = '<span class="stall-badge s2">恢复中</span>';
                else if (s.stallLevel === 1) stallEl.innerHTML = '<span class="stall-badge s1">轻推</span>';
                else stallEl.innerHTML = '';
            }

            const now = NOW();
            if (now - this._lastTimelineRender > 1000) {
                this._lastTimelineRender = now;
                this._renderTimeline();
            }
        }
    }

    /* ═══════════════════════════════════════════════════════════
       启动
    ═══════════════════════════════════════════════════════════ */

    // 尽早安装钩子，保证 document-start 阶段开始嗅探
    HookManager.installAll(PW, DOC);

    let ui = null;
    if (IS_TOP) {
        ui = new UIManager(Bus);
    }

    Detector.start();

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

    try {
        PW.__VA__ = Object.assign(PW.__VA__ || {}, {
            version: VERSION,
            IS_TOP: IS_TOP,
            bus: Bus,
            config: ConfigManager,
            sessions: function () { return SessionManager.sessions.size; }
        });
    } catch (e) { }

    Logger.info('Boot', '微内核视频加速引擎已启动', { version: VERSION, top: IS_TOP });

})();