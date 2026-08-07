// ==UserScript==
// @name         视频加载加速与稳定播放
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  视频秒开·大缓冲·Seek防卡死·自动恢复。配套"网页元素屏蔽器"：广告它来清，加速我来搞。双上下文架构：沙箱世界管理配置与UI，页面世界注入引擎拦截HLS/Dash构造器、强制懒加载、链式fetch提速、缓冲水位管理、Seek三级自愈、卡死看门狗、广告门禁联动跳过。
// @author       EFate
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 【沙箱世界】配置持久化 / 消息桥 / 控制面板 UI
    // ============================================================

    const ConfigStore = {
        defaults: {
            autoPlay: true,
            bigBuffer: true,
            adGateBypass: true,
            seekGuard: true,
            bufferTarget: 60,
            seekTimeout: 8000,
            siteProfiles: {}
        },
        _cache: null,
        load() {
            if (this._cache) return this._cache;
            let raw = null;
            try { raw = GM_getValue('va_config', null); } catch (e) { raw = null; }
            this._cache = Object.assign({}, this.defaults, raw ? raw : {});
            return this._cache;
        },
        save() {
            try { GM_setValue('va_config', this._cache); } catch (e) {}
        },
        get(k) { return this.load()[k]; },
        set(k, v) { this.load()[k] = v; this.save(); },
        getProfile(host) {
            const cfg = this.load();
            return Object.assign({}, cfg, cfg.siteProfiles[host] || {});
        }
    };

    // 沙箱 ⇄ 页面世界消息桥：命名空间事件 va-cmd(下行) / va-evt(上行)
    const MessageBridge = {
        init(onEvent) {
            this._onEvent = onEvent;
            window.addEventListener('va-evt', (e) => {
                try { this._onEvent(e.detail || {}); } catch (err) {}
            });
        },
        send(cmd, payload) {
            try {
                window.dispatchEvent(new CustomEvent('va-cmd', { detail: { cmd, payload } }));
            } catch (e) {}
        }
    };

    // 控制面板：closed Shadow DOM，宿主 #va-ui-host，毛玻璃风格对齐屏蔽器
    class UIManager {
        constructor() {
            this.cfg = ConfigStore.load();
            this._state = { status: '空闲', playerType: '-', buffer: 0, recoveries: 0, adSkipped: 0, seekGuard: true };
            this._panel = null;
            this._visible = false;
            this._build();
        }

        _build() {
            const existing = document.getElementById('va-ui-host');
            if (existing) existing.remove();

            this.host = document.createElement('div');
            this.host.id = 'va-ui-host';
            this.host.style.cssText = 'position: fixed; z-index: 2147483646; top: 0; left: 0; width: 0; height: 0; overflow: visible;';
            this.root = this.host.attachShadow({ mode: 'closed' });

            const style = document.createElement('style');
            style.textContent = `
                :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; }
                .panel {
                    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(25, 25, 30, 0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255,255,255,0.16); padding: 20px; border-radius: 16px;
                    box-shadow: 0 20px 64px rgba(0,0,0,0.42), inset 0 0 0 1px rgba(255,255,255,0.07);
                    width: min(440px, calc(100vw - 48px)); max-width: calc(100vw - 48px);
                    max-height: min(640px, 76vh); overflow-y: auto; color: #eee; text-shadow: 0 1px 2px rgba(0,0,0,0.8);
                    box-sizing: border-box;
                }
                h3 { margin-top: 0; font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 14px;
                    border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 10px; cursor: grab; user-select: none; }
                h3:active { cursor: grabbing; }
                .status-row { display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin: 5px 0; }
                .status-row b { color: #fff; font-weight: 600; }
                .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; vertical-align:middle; background:#888; }
                .dot.live { background:#34c759; box-shadow:0 0 6px #34c759; }
                .dot.wait { background:#ff9500; }
                .dot.err  { background:#ff3b30; }
                .buf-bar { height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; margin:6px 0 12px; }
                .buf-fill { height:100%; background:linear-gradient(90deg,#4aa3ff,#34c759); width:0%; transition:width .3s; }
                .btn-group { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
                button { padding:9px 12px; border:1px solid rgba(255,255,255,0.18); border-radius:8px; cursor:pointer;
                    font-size:13px; font-weight:500; transition:filter .15s, transform .1s; flex:1;
                    display:flex; align-items:center; justify-content:center; line-height:1.2;
                    background:rgba(255,255,255,0.1); color:#fff; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
                    text-shadow:0 1px 2px rgba(0,0,0,0.4); }
                button:hover:not(:disabled){ filter:brightness(1.15); transform:translateY(-1px); }
                button:active:not(:disabled){ transform:translateY(0); filter:brightness(0.95); }
                button:disabled{ opacity:0.3; cursor:not-allowed; }
                .btn-primary{ background:rgba(0,122,255,0.72); }
                .btn-success{ background:rgba(52,199,89,0.72); }
                .btn-warning{ background:rgba(255,149,0,0.72); }
                .btn-danger{ background:rgba(255,59,48,0.72); }
                .divider{ height:1px; background:rgba(255,255,255,0.1); margin:12px 0; }
                label.opt { display:flex; align-items:center; gap:8px; font-size:13px; color:#ddd; margin:7px 0; cursor:pointer; }
                label.opt input[type=checkbox]{ width:18px; height:18px; accent-color:#0a84ff; }
                label.opt input[type=number]{ width:64px; padding:4px 6px; margin-left:6px; border:1px solid rgba(255,255,255,0.14);
                    border-radius:6px; background:rgba(0,0,0,0.25); color:#eee; font-size:12px; }
                .hint { font-size:11px; color:#aaa; line-height:1.5; margin-top:10px; }
                .toast { position:fixed; top:20px; right:20px; z-index:2147483646; padding:12px 18px; border-radius:10px;
                    background:rgba(30,30,35,0.92); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
                    border:1px solid rgba(255,255,255,0.15); color:#fff; font-size:13px; max-width:340px; word-break:break-all;
                    transform:translateX(120%); transition:transform .3s cubic-bezier(.4,0,.2,1); box-shadow:0 8px 32px rgba(0,0,0,0.3); }
                .toast.show{ transform:translateX(0); }
                .toast.warn{ border-left:3px solid #ff9500; }
                .toast.err{ border-left:3px solid #ff3b30; }
                .toast.ok{ border-left:3px solid #34c759; }
                .close-x { position:absolute; top:10px; right:14px; cursor:pointer; color:#aaa; font-size:18px; background:none; border:none; flex:none; padding:0 4px; }
                @media (max-width:480px){ .panel{ padding:16px; border-radius:14px; width:calc(100vw - 56px); max-width:calc(100vw - 56px); } button{ padding:8px 10px; font-size:12px; } }
            `;
            this.root.appendChild(style);

            this._toast = document.createElement('div');
            this._toast.className = 'toast';
            this.root.appendChild(this._toast);

            this._panel = document.createElement('div');
            this._panel.className = 'panel';
            this._panel.style.display = 'none';
            this._panel.innerHTML = `
                <span class="close-x" data-act="close">×</span>
                <h3>🎬 视频加速控制台</h3>
                <div class="status-row"><span><span class="dot" id="va-dot"></span>状态: <b id="va-status">空闲</b></span><span>播放类型: <b id="va-type">-</b></span></div>
                <div class="status-row"><span>Buffer: <b id="va-buf">0s</b></span><span>恢复次数: <b id="va-rec">0</b></span><span>广告跳过: <b id="va-ad">0</b></span></div>
                <div class="buf-bar"><div class="buf-fill" id="va-buf-fill"></div></div>
                <div class="btn-group">
                    <button class="btn-warning" data-act="reload">强制重载</button>
                    <button class="btn-primary" data-act="recover">手动恢复</button>
                    <button class="btn-danger" data-act="downgrade">降低画质</button>
                </div>
                <div class="divider"></div>
                <label class="opt"><input type="checkbox" id="va-auto" > 自动播放</label>
                <label class="opt"><input type="checkbox" id="va-big"> 超大缓冲模式</label>
                <label class="opt"><input type="checkbox" id="va-adgate"> 广告门禁跳过</label>
                <label class="opt"><input type="checkbox" id="va-seek"> Seek防卡死</label>
                <label class="opt">Buffer目标: <input type="number" id="va-btgt" min="10" max="300" step="10"> s</label>
                <label class="opt">Seek超时: <input type="number" id="va-sto" min="3" max="30" step="1"> s</label>
                <div class="hint">提示：本脚本与"网页元素屏蔽器"配套，广告由屏蔽器清理，本脚本负责视频秒开与卡死自愈。配置自动保存。</div>
            `;
            this.root.appendChild(this._panel);

            // 事件绑定
            this._panel.addEventListener('click', (e) => {
                const t = e.target.closest('[data-act]');
                if (!t) return;
                const act = t.getAttribute('data-act');
                if (act === 'close') { this.hide(); }
                else { MessageBridge.send(act); }
            });

            this._panel.querySelector('#va-auto').addEventListener('change', (e) => { ConfigStore.set('autoPlay', e.target.checked); MessageBridge.send('configUpdate', ConfigStore.load()); });
            this._panel.querySelector('#va-big').addEventListener('change', (e) => { ConfigStore.set('bigBuffer', e.target.checked); MessageBridge.send('configUpdate', ConfigStore.load()); });
            this._panel.querySelector('#va-adgate').addEventListener('change', (e) => { ConfigStore.set('adGateBypass', e.target.checked); MessageBridge.send('configUpdate', ConfigStore.load()); });
            this._panel.querySelector('#va-seek').addEventListener('change', (e) => { ConfigStore.set('seekGuard', e.target.checked); MessageBridge.send('configUpdate', ConfigStore.load()); });
            this._panel.querySelector('#va-btgt').addEventListener('change', (e) => { ConfigStore.set('bufferTarget', parseInt(e.target.value) || 60); MessageBridge.send('configUpdate', ConfigStore.load()); });
            this._panel.querySelector('#va-sto').addEventListener('change', (e) => { ConfigStore.set('seekTimeout', (parseInt(e.target.value) || 8) * 1000); MessageBridge.send('configUpdate', ConfigStore.load()); });

            this._syncInputs();
        }

        _syncInputs() {
            this._panel.querySelector('#va-auto').checked = !!this.cfg.autoPlay;
            this._panel.querySelector('#va-big').checked = !!this.cfg.bigBuffer;
            this._panel.querySelector('#va-adgate').checked = !!this.cfg.adGateBypass;
            this._panel.querySelector('#va-seek').checked = !!this.cfg.seekGuard;
            this._panel.querySelector('#va-btgt').value = this.cfg.bufferTarget;
            this._panel.querySelector('#va-sto').value = Math.round(this.cfg.seekTimeout / 1000);
        }

        _mount() {
            if (this.host.isConnected) return;
            (document.body || document.documentElement).appendChild(this.host);
        }

        toggle() { this._visible ? this.hide() : this.show(); }
        show() {
            this._mount();
            this.cfg = ConfigStore.load();
            this._syncInputs();
            this._panel.style.display = '';
            this._visible = true;
        }
        hide() { this._panel.style.display = 'none'; this._visible = false; }

        toast(msg, kind) {
            this._mount();
            this._toast.textContent = msg;
            this._toast.className = 'toast show ' + (kind || '');
            clearTimeout(this._toastT);
            this._toastT = setTimeout(() => { this._toast.className = 'toast ' + (kind || ''); }, 2600);
        }

        update(state) {
            Object.assign(this._state, state);
            if (!this._visible) return;
            const s = this._state;
            const set = (id, v) => { const el = this._panel.querySelector('#' + id); if (el) el.textContent = v; };
            set('va-status', s.status);
            set('va-type', s.playerType);
            set('va-buf', (typeof s.buffer === 'number' ? s.buffer : 0).toFixed(1) + 's');
            set('va-rec', s.recoveries);
            set('va-ad', s.adSkipped);
            const dot = this._panel.querySelector('#va-dot');
            if (dot) {
                dot.className = 'dot' + (s.status === '播放中' ? ' live' : s.status === '缓冲中' ? ' wait' : s.status === '错误' ? ' err' : '');
            }
            const fill = this._panel.querySelector('#va-buf-fill');
            if (fill) fill.style.width = Math.min(100, (s.buffer / Math.max(10, this.cfg.bufferTarget)) * 100) + '%';
        }
    }

    // ============================================================
    // 【页面世界注入引擎】序列化为字符串，document-start 注入
    // ============================================================

    function pageEngine(initialConfig) {
        if (window.__vaInjected) return;
        window.__vaInjected = true;

        const CFG = Object.assign({
            autoPlay: true, bigBuffer: true, adGateBypass: true, seekGuard: true,
            bufferTarget: 60, seekTimeout: 8000
        }, initialConfig || {});

        // 站点特化配置（可扩展）
        const SITE_PROFILES = {
            '_default': { playerType: 'auto', bufferTarget: 60, seekTimeout: 8000 },
            'www.bilibili.com': { containerSel: '.bpx-player-video-area', bufferTarget: 120 },
            'v.qq.com': { adGateBypass: true, bufferTarget: 90 },
            'www.youtube.com': { bufferTarget: 120, seekTimeout: 10000 }
        };
        const host = location.hostname;
        const PROFILE = Object.assign({}, SITE_PROFILES['_default'], SITE_PROFILES[host] || {});

        // 消息桥（页面世界侧）
        const Bridge = {
            send(evt, payload) {
                try { window.dispatchEvent(new CustomEvent('va-evt', { detail: { evt, payload } })); } catch (e) {}
            },
            on(cmd, handler) {
                window.addEventListener('va-cmd', (e) => {
                    const d = e.detail || {};
                    if (d.cmd === cmd) { try { handler(d.payload); } catch (err) {} }
                });
            }
        };

        // ============ 工具 ============
        const throttle = (fn, wait) => {
            let last = 0, timer = null;
            return function () {
                const now = Date.now(), args = arguments, self = this;
                if (now - last >= wait) { last = now; fn.apply(self, args); }
                else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn.apply(self, args); }, wait - (now - last)); }
            };
        };
        const isVideoResource = (url) => /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v)(\?|$)|\/(seg|chunk|frag|segment)s?\//i.test(url || '');

        // ============ PlayerRegistry / IORegistry ============
        const PlayerRegistry = {
            _map: new WeakMap(), // video -> { type, player }
            track(type, inst, video) {
                if (video) this._map.set(video, { type, player: inst });
            },
            get(video) { return this._map.get(video); },
            set(video, info) { this._map.set(video, info); }
        };

        const IORegistry = {
            _list: [],
            track(inst, cb) { this._list.push({ inst, cb }); },
            forEach(fn) { this._list.forEach(o => fn(o.inst, o.cb)); }
        };

        // ============ HLS/Dash/Shaka 默认配置 ============
        const VA_HLS_DEFAULTS = {
            maxBufferLength: 60, maxMaxBufferLength: 300, maxBufferSize: 60 * 1024 * 1024,
            maxBufferHole: 0.5, startFragPrefetch: true, testBandwidth: true, progressive: true,
            backBufferLength: 90, lowLatencyMode: false
        };

        function wrapHls(Orig) {
            if (!Orig || typeof Orig !== 'function' || Orig.__vaPatched) return Orig;
            function HookedHls(cfg) {
                const merged = Object.assign({}, VA_HLS_DEFAULTS, cfg || {});
                if (!CFG.bigBuffer) merged.maxBufferLength = CFG.bufferTarget;
                const inst = new Orig(merged);
                return inst;
            }
            HookedHls.prototype = Orig.prototype;
            try { HookedHls.isSupported = Orig.isSupported ? Orig.isSupported.bind(Orig) : Orig.isSupported; } catch (e) {}
            for (const k of Object.getOwnPropertyNames(Orig)) {
                if (!(k in HookedHls)) { try { HookedHls[k] = Orig[k]; } catch (e) {} }
            }
            HookedHls.__vaPatched = true;
            return HookedHls;
        }

        function installHlsHook() {
            // 轮询式拦截：document-start 阶段 Hls 尚未定义，定时检测并包装
            let tries = 0;
            const tick = () => {
                if (window.Hls && !window.Hls.__vaPatched) {
                    try { window.Hls = wrapHls(window.Hls); } catch (e) {}
                }
                if (window.dashjs && window.dashjs.MediaPlayer && !window.dashjs.__vaPatched) {
                    try {
                        const OrigMP = window.dashjs.MediaPlayer;
                        function WrappedMP() {
                            const factory = OrigMP.apply(this, arguments);
                            const origCreate = factory.create;
                            factory.create = function () {
                                const p = origCreate.apply(this, arguments);
                                try { p.updateSettings({ streaming: {
                                    buffer: { stableBufferTime: 30, bufferTimeAtTopQuality: 60, bufferToKeep: 30 },
                                    abr: { autoSwitchBitrate: { video: true } } } }); } catch (e) {}
                                return p;
                            };
                            return factory;
                        }
                        WrappedMP.prototype = OrigMP.prototype;
                        for (const k of Object.getOwnPropertyNames(OrigMP)) { try { WrappedMP[k] = OrigMP[k]; } catch (e) {} }
                        window.dashjs.MediaPlayer = WrappedMP;
                        window.dashjs.__vaPatched = true;
                    } catch (e) {}
                }
                if (window.shaka && window.shaka.Player && !window.shaka.__vaPatched) {
                    try {
                        const OrigP = window.shaka.Player;
                        function WrappedP(video, dependency) {
                            const p = new OrigP(video, dependency);
                            try { p.configure({ streaming: { rebufferingGoal: 2, bufferingGoal: 60, bufferBehind: 90 } }); } catch (e) {}
                            return p;
                        }
                        WrappedP.prototype = OrigP.prototype;
                        for (const k of Object.getOwnPropertyNames(OrigP)) { try { WrappedP[k] = OrigP[k]; } catch (e) {} }
                        window.shaka.Player = WrappedP;
                        window.shaka.__vaPatched = true;
                    } catch (e) {}
                }
                tries++;
                if (tries < 200) setTimeout(tick, 100); // 20s 内持续探测
            };
            tick();
        }

        function hotPatchHls(hls) {
            if (!hls || !hls.config) return;
            try {
                hls.config.maxBufferLength = CFG.bigBuffer ? VA_HLS_DEFAULTS.maxBufferLength : CFG.bufferTarget;
                hls.config.maxMaxBufferLength = VA_HLS_DEFAULTS.maxMaxBufferLength;
                hls.config.maxBufferHole = VA_HLS_DEFAULTS.maxBufferHole;
                hls.config.startFragPrefetch = true;
                hls.config.backBufferLength = VA_HLS_DEFAULTS.backBufferLength;
                hls.config.lowLatencyMode = false;
            } catch (e) {}
        }

        // ============ IO Hook（懒加载解锁前置登记） ============
        function installIOHook() {
            if (!window.IntersectionObserver || window.IntersectionObserver.__vaPatched) return;
            const Orig = window.IntersectionObserver;
            function HookedIO(cb, opts) {
                const inst = new Orig(cb, opts);
                try { IORegistry.track(inst, cb); } catch (e) {}
                return inst;
            }
            HookedIO.prototype = Orig.prototype;
            for (const k of Object.getOwnPropertyNames(Orig)) { try { HookedIO[k] = Orig[k]; } catch (e) {} }
            HookedIO.__vaPatched = true;
            window.IntersectionObserver = HookedIO;
        }

        // ============ Fetch 链式包装（兼容屏蔽器 __proBlockerHooked） ============
        function installFetchPriority() {
            const base = window.fetch;
            if (!base || base.__vaPatched) return;
            const wrapped = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (isVideoResource(url) && init) {
                        init.priority = 'high';
                        if (!init.credentials) init.credentials = 'include';
                    }
                } catch (e) {}
                return base.apply(this, arguments);
            };
            wrapped.__vaPatched = true;
            window.fetch = wrapped;
        }

        // ============ PlayerTypeDetector ============
        const PlayerTypeDetector = {
            detect(video) {
                if (video.hls || video._hls) {
                    PlayerRegistry.set(video, { type: 'hls', player: video.hls || video._hls });
                    return 'hls';
                }
                if (video.dashjs) {
                    PlayerRegistry.set(video, { type: 'dash', player: video.dashjs });
                    return 'dash';
                }
                // 遍历常见属性名，兼容内联 HLS.js
                for (const k of ['hls', '_hls', '__hls', 'hlsPlayer', 'player']) {
                    const v = video[k];
                    if (v && (v.config || v.startLoad || v.attachMedia)) {
                        PlayerRegistry.set(video, { type: 'hls', player: v });
                        return 'hls';
                    }
                }
                if (window.shaka && video.shakaPlayer) {
                    PlayerRegistry.set(video, { type: 'shaka', player: video.shakaPlayer });
                    return 'shaka';
                }
                const src = video.currentSrc || video.src || '';
                if (src.indexOf('blob:') === 0) {
                    PlayerRegistry.set(video, { type: 'mse', player: null });
                    return 'mse';
                }
                if (src) {
                    PlayerRegistry.set(video, { type: 'native', player: null });
                    return 'native';
                }
                return 'unknown';
            }
        };

        // ============ PreloadAccelerator ============
        const PreloadAccelerator = {
            apply(video, type) {
                try {
                    video.preload = 'auto';
                    if (CFG.autoPlay && video.paused) video.play().catch(() => {});
                    // data-src → src 提前赋值
                    const lazy = video.getAttribute('data-src') || video.getAttribute('data-video') || video.getAttribute('data-lazy-src');
                    if (lazy && !video.src) video.src = lazy;
                    video.removeAttribute('data-src');
                    video.removeAttribute('data-lazy-src');
                } catch (e) {}

                // 网络层预连接
                const src = video.currentSrc || video.src || '';
                if (src) {
                    try { this._preconnect(src); } catch (e) {}
                }

                // 播放器配置热补丁
                const info = PlayerRegistry.get(video);
                if (type === 'hls' || (info && info.type === 'hls')) {
                    const hls = info ? info.player : null;
                    if (hls) hotPatchHls(hls);
                } else if (info && info.type === 'dash' && info.player) {
                    try { info.player.updateSettings({ streaming: { buffer: { stableBufferTime: 30, bufferTimeAtTopQuality: 60, bufferToKeep: 30 } } }); } catch (e) {}
                } else if (info && info.type === 'shaka' && info.player) {
                    try { info.player.configure({ streaming: { rebufferingGoal: 2, bufferingGoal: 60, bufferBehind: 90 } }); } catch (e) {}
                }
            },
            _preconnect(url) {
                try {
                    const u = new URL(url, location.href);
                    if (u.origin === location.origin) return;
                    if (this._connected && this._connected.has(u.origin)) return;
                    (this._connected = this._connected || new Set()).add(u.origin);
                    const link = document.createElement('link');
                    link.rel = 'preconnect'; link.href = u.origin; link.crossOrigin = 'anonymous';
                    (document.head || document.documentElement).appendChild(link);
                } catch (e) {}
            }
        };

        // ============ BufferManager ============
        class BufferManager {
            constructor(session) { this.session = session; this._iv = null; }
            watch() {
                const v = this.session.video;
                const check = () => this._check();
                // 保存节流后的处理器引用，stop() 时才能正确移除，避免 timeupdate 监听器泄漏
                this._onTimeUpdate = throttle(check, 1000);
                v.addEventListener('timeupdate', this._onTimeUpdate);
                this._iv = setInterval(check, 3000);
            }
            _check() {
                const v = this.session.video;
                if (!v.buffered.length || v.paused || v.ended) { this.session.reportBuffer(0); return; }
                const ahead = this.bufferAhead(v);
                this.session.reportBuffer(ahead);
                if (ahead < 2) this.session.emergencyLoad();
                else if (ahead < 8) this.session.boostLoad();
                if (this.backBuffer(v) > 120) this.session.trimBackBuffer(30);
            }
            bufferAhead(video) {
                for (let i = 0; i < video.buffered.length; i++) {
                    if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i))
                        return video.buffered.end(i) - video.currentTime;
                }
                return 0;
            }
            backBuffer(video) {
                try {
                    let back = 0;
                    for (let i = 0; i < video.buffered.length; i++) {
                        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
                            back = video.currentTime - video.buffered.start(i); break;
                        }
                    }
                    return back;
                } catch (e) { return 0; }
            }
            stop() {
                if (this._iv) { clearInterval(this._iv); this._iv = null; }
                if (this._onTimeUpdate) {
                    try { this.session.video.removeEventListener('timeupdate', this._onTimeUpdate); } catch (e) {}
                    this._onTimeUpdate = null;
                }
            }
        }

        // ============ SeekGuard ============
        class SeekGuard {
            constructor(session) {
                this.session = session;
                this.T = CFG.seekTimeout;
                this.retry = 0; this.t = null; this.seekTarget = 0;
                const v = session.video;
                this._onSeeking = () => {
                    if (!CFG.seekGuard) return;
                    this.retry = 0; this.seekTarget = v.currentTime; this.arm();
                };
                this._onSeeked = () => {
                    setTimeout(() => {
                        // seek 完成后仅在已就绪却未播放时轻推一次；卡死由 SeekGuard 看门狗兜底，
                        // 用户主动暂停时不干预，避免 load() 中断正常缓冲
                        if (v.ended || !v.paused) return;
                        if (v.readyState >= 3 && CFG.autoPlay) { try { v.play().catch(() => {}); } catch (e) {} }
                    }, 500);
                };
                this._onCanPlay = () => this.disarm();
                this._onPlaying = () => this.disarm();
                v.addEventListener('seeking', this._onSeeking);
                v.addEventListener('seeked', this._onSeeked);
                v.addEventListener('canplay', this._onCanPlay);
                v.addEventListener('playing', this._onPlaying);
            }
            arm() { clearTimeout(this.t); this.t = setTimeout(() => this.escalate(), CFG.seekTimeout || this.T); }
            disarm() { clearTimeout(this.t); this.retry = 0; }
            escalate() {
                if (!CFG.seekGuard) return;
                // 检查是否已恢复
                const v = this.session.video;
                if (v.readyState >= 3 && !v.paused) { this.disarm(); return; }
                this.retry++;
                if (this.retry === 1) this.session.softRecover();
                else if (this.retry === 2) this.session.engineRecover();
                else if (this.retry === 3) this.session.rebuildVideoElement();
                else { this.session.notify('自动恢复失败，请点击面板"强制重载"'); return; }
                this.arm();
            }
            destroy() {
                clearTimeout(this.t);
                const v = this.session.video;
                v.removeEventListener('seeking', this._onSeeking);
                v.removeEventListener('seeked', this._onSeeked);
                v.removeEventListener('canplay', this._onCanPlay);
                v.removeEventListener('playing', this._onPlaying);
            }
        }

        // ============ StallRecoveryWatchdog ============
        class StallRecoveryWatchdog {
            constructor(session) {
                this.session = session;
                this.lastTime = -1; this.stallStart = 0; this.waitingSince = 0;
                this.stallCount = 0; this._lastStallTime = 0;
                this._iv = null;
                const v = session.video;
                this._onWaiting = () => { this.waitingSince = Date.now(); };
                this._onPlaying = () => { this.waitingSince = 0; this.stallStart = 0; };
                v.addEventListener('waiting', this._onWaiting);
                v.addEventListener('playing', this._onPlaying);
                this._iv = setInterval(() => this._check(), 1000);
            }
            _check() {
                const v = this.session.video;
                if (v.paused || v.ended) { this.lastTime = v.currentTime; return; }
                const t = v.currentTime;
                if (t === this.lastTime) {
                    if (!this.stallStart) this.stallStart = Date.now();
                    if (Date.now() - this.stallStart >= 5000) this._recover('stall');
                } else {
                    this.stallStart = 0; this.lastTime = t;
                }
                if (this.waitingSince && Date.now() - this.waitingSince >= 5000) {
                    this.waitingSince = 0; this._recover('waiting');
                }
                if (v.readyState <= 2 && Date.now() - (this._readyLowSince || Date.now()) >= 5000) {
                    if (!this._readyLowSince) this._readyLowSince = Date.now();
                    else { this._readyLowSince = 0; this._recover('lowready'); }
                } else if (v.readyState > 2) { this._readyLowSince = 0; }
            }
            _recover(reason) {
                this.stallStart = 0;
                const now = Date.now();
                if (now - this._lastStallTime < 60000) this.stallCount++; else this.stallCount = 1;
                this._lastStallTime = now;
                // 60s 内 ≥3 次卡死 → 降一档画质
                if (this.stallCount >= 3) { this.session.downgradeQuality(); this.stallCount = 0; }
                this.session.engineRecover();
            }
            destroy() {
                clearInterval(this._iv);
                const v = this.session.video;
                v.removeEventListener('waiting', this._onWaiting);
                v.removeEventListener('playing', this._onPlaying);
            }
        }

        // ============ AdGateBypass ============
        class AdGateBypass {
            constructor(session) {
                this.session = session;
                this._iv = null; this._swept = false;
            }
            start() {
                if (!CFG.adGateBypass) return;
                this._iv = setInterval(() => this._poll(), 2000);
            }
            _poll() {
                const v = this.session.video;
                if (!v) return;
                const container = this._findContainer(v);
                if (!container) return;
                if (this._isAdState(container, v)) {
                    this.sweep(container);
                    this.session.adSkipped();
                }
            }
            _findContainer(video) {
                let el = video.parentElement;
                let best = null;
                while (el && el !== document.body) {
                    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
                    if (/player|video|media|preroll|ad-/i.test(cls)) { best = el; }
                    el = el.parentElement;
                }
                return best || video.parentElement;
            }
            _isAdState(container, video) {
                if (!container) return false;
                const cls = (container.className && typeof container.className === 'string') ? container.className : '';
                if (/ad-loading|ad-playing|preroll|showing-ad|vast-/i.test(cls)) return true;
                // 倒计时元素
                try {
                    const nodes = container.querySelectorAll('*');
                    for (let i = 0; i < nodes.length && i < 60; i++) {
                        const t = (nodes[i].textContent || '').trim();
                        if (t && /\d+\s*(s|秒)/.test(t) && t.length < 12) return true;
                    }
                } catch (e) {}
                // 跳过广告按钮：仅识别按钮类元素且文案简短，避免误判"跳转到内容"等无障碍链接
                try {
                    const btns = container.querySelectorAll('button,[role="button"],[class*="skip"],[class*="ad-"]');
                    for (let i = 0; i < btns.length && i < 80; i++) {
                        const t = (btns[i].textContent || '').trim();
                        if (t && t.length < 20 && /跳过|skip\s*ad|关闭广告|skip[\s-]?ad/i.test(t)) return true;
                    }
                } catch (e) {}
                // video 存在但无数据且被 overlay 覆盖
                if (video.readyState === 0 && video.paused && video.src) return false;
                return false;
            }
            sweep(container) {
                try {
                    container.classList.remove('ad-loading', 'ad-playing', 'preroll', 'showing-ad');
                    // 移除广告 overlay / 倒计时层（保护 video 本体）
                    container.querySelectorAll('[class*="preroll"],[class*="countdown"],[class*="vast-"]').forEach(el => {
                        if (el.querySelector && el.querySelector('video')) return;
                        el.remove();
                    });
                    // 自动点击"跳过广告"按钮：限定按钮类元素与短文案，防止误点导航链接
                    const skip = Array.from(container.querySelectorAll('button,[role="button"],[class*="skip"],[class*="ad-"]'))
                        .find(el => { const t = (el.textContent || '').trim(); return t.length < 20 && /跳过|skip\s*ad|关闭广告|skip[\s-]?ad/i.test(t); });
                    if (skip) { try { skip.click(); } catch (e) {} }
                    // 强制播放正片
                    const video = container.querySelector('video');
                    if (video) { video.play().catch(() => {}); }
                    // 广播广告结束事件
                    container.dispatchEvent(new Event('adCompleted', { bubbles: true }));
                    container.dispatchEvent(new Event('ads-ad-ended', { bubbles: true }));
                } catch (e) {}
            }
            stop() { if (this._iv) { clearInterval(this._iv); this._iv = null; } }
        }

        // ============ LazyInitUnlocker ============
        const LazyInitUnlocker = {
            forceInit(container) {
                try {
                    IORegistry.forEach((inst, cb) => {
                        try {
                            cb([{ target: container, isIntersecting: true, intersectionRatio: 1,
                                  boundingClientRect: container.getBoundingClientRect() }], inst);
                        } catch (e) {}
                    });
                } catch (e) {}
                try { window.dispatchEvent(new Event('scroll')); } catch (e) {}
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            }
        };

        // ============ VideoSession ============
        let sessionCounter = 0;
        const _allSessions = new Set(); // 全局 session 注册表，供 HealthMonitor 巡检脱离 DOM 的视频
        class VideoSession {
            constructor(video) {
                this.id = ++sessionCounter;
                this.video = video;
                this.type = PlayerTypeDetector.detect(video);
                this.recoveries = 0;
                this._adSkipped = 0;
                this._dead = false;
                this._lastBufReport = 0; this._lastBufVal = -1;
                video.__vaSession = this;
                _allSessions.add(this);

                PreloadAccelerator.apply(video, this.type);

                this.buffer = new BufferManager(this);
                this.seek = new SeekGuard(this);
                this.stall = new StallRecoveryWatchdog(this);
                this.adgate = new AdGateBypass(this);

                this.buffer.watch();
                this.adgate.start();

                this._report();
            }
            _report() {
                Bridge.send('session', {
                    status: this.video.paused ? '空闲' : '播放中',
                    playerType: this.type, buffer: this.buffer.bufferAhead(this.video),
                    recoveries: this.recoveries, adSkipped: this._adSkipped
                });
            }
            reportBuffer(ahead) {
                // 节流：1.5s 内或变化 <1s 不上报，避免多视频时事件洪流冲击沙箱
                const now = Date.now();
                if (this._lastBufReport && now - this._lastBufReport < 1500 && Math.abs(this._lastBufVal - ahead) < 1) return;
                this._lastBufReport = now; this._lastBufVal = ahead;
                const v = this.video;
                Bridge.send('state', { buffer: ahead, status: v.paused ? '已暂停' : '播放中' });
            }
            emergencyLoad() {
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) { info.player.startLoad(); }
                    else { this.video.load(); }
                } catch (e) {}
            }
            boostLoad() {
                // 提权由 NetworkPriorityOptimizer 负责，这里仅触发一次 load 兜底
                const info = PlayerRegistry.get(this.video);
                if (info && info.type === 'hls' && info.player) { try { info.player.startLoad(this.video.currentTime); } catch (e) {} }
            }
            trimBackBuffer(seconds) {
                const info = PlayerRegistry.get(this.video);
                if (info && info.type === 'hls' && info.player && info.player.config) {
                    try { info.player.config.backBufferLength = seconds; } catch (e) {}
                }
            }
            softRecover() {
                this.recoveries++;
                const info = PlayerRegistry.get(this.video);
                try {
                    // HLS.js 场景用 startLoad 续传，避免 video.load() 重置 MSE 导致引擎脱钩
                    if (info && info.type === 'hls' && info.player) {
                        try { info.player.startLoad(this.video.currentTime); } catch (e) { this.video.load(); }
                    } else {
                        this.video.load();
                    }
                    if (CFG.autoPlay) this.video.play().catch(() => {});
                } catch (e) {}
                this._report();
            }
            engineRecover() {
                this.recoveries++;
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) {
                        try { info.player.recoverMediaError(); }
                        catch (e) { try { info.player.startLoad(this.video.currentTime); } catch (e2) {} }
                    } else if (info && info.type === 'dash' && info.player) {
                        info.player.seek(this.video.currentTime); info.player.play();
                    } else {
                        this.video.currentTime = this.video.currentTime; this.video.load();
                    }
                    if (CFG.autoPlay) this.video.play().catch(() => {});
                } catch (e) {}
                this._report();
            }
            downgradeQuality() {
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) {
                        const cur = info.player.currentLevel;
                        if (cur > 0) { info.player.nextLevel = cur - 1; this.notify('自动降一档画质以保持流畅'); }
                    } else if (info && info.type === 'dash' && info.player) {
                        const rep = info.player.getBitrateInfoListFor && info.player.getBitrateInfoListFor('video');
                        const cur = info.player.getQualityFor && info.player.getQualityFor('video');
                        if (rep && cur > 0) { info.player.setQualityFor('video', cur - 1); this.notify('自动降一档画质以保持流畅'); }
                    }
                } catch (e) {}
            }
            rebuildVideoElement() {
                this.recoveries++;
                const old = this.video;
                try {
                    const clone = old.cloneNode(false);
                    // 保留上下文
                    const ctx = {
                        currentTime: old.currentTime, volume: old.volume, muted: old.muted,
                        playbackRate: old.playbackRate, loop: old.loop, crossorigin: old.crossOrigin
                    };
                    // 释放旧引擎
                    const info = PlayerRegistry.get(old);
                    if (info && info.type === 'hls' && info.player) { try { info.player.destroy(); } catch (e) {} }

                    if (old.parentNode) old.parentNode.replaceChild(clone, old);
                    try { delete old.__vaSession; } catch (e) {}
                    clone.currentTime = ctx.currentTime;
                    clone.volume = ctx.volume; clone.muted = ctx.muted;
                    clone.playbackRate = ctx.playbackRate; clone.loop = ctx.loop;
                    if (ctx.crossorigin) clone.crossOrigin = ctx.crossorigin;

                    // 重建引擎（HLS 场景）
                    if (info && info.type === 'hls' && window.Hls && window.Hls.isSupported()) {
                        const hls = new window.Hls();
                        hls.attachMedia(clone);
                        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
                            clone.currentTime = ctx.currentTime;
                            if (CFG.autoPlay) clone.play().catch(() => {});
                        });
                        PlayerRegistry.set(clone, { type: 'hls', player: hls });
                    } else if (info && info.type === 'native') {
                        clone.load();
                        if (CFG.autoPlay) clone.play().catch(() => {});
                    }

                    // 旧 session 销毁监听器，绑定到新元素
                    this.seek.destroy(); this.stall.destroy(); this.buffer.stop(); this.adgate.stop();
                    this.video = clone;
                    this.type = info ? info.type : PlayerTypeDetector.detect(clone);
                    this.seek = new SeekGuard(this);
                    this.stall = new StallRecoveryWatchdog(this);
                    this.buffer = new BufferManager(this);
                    this.adgate = new AdGateBypass(this);
                    this.buffer.watch(); this.adgate.start();
                    clone.__vaSession = this;
                    // 阻止 MutationObserver 为新插入的 clone 重复创建 session
                    VideoDiscoveryEngine._seen.add(clone);
                    this.notify('视频元素已自动重建');
                } catch (e) { this.notify('元素重建失败，请手动重载'); }
                this._report();
            }
            adSkipped() { this._adSkipped++; Bridge.send('adSkip', { count: this._adSkipped }); }
            notify(msg) { Bridge.send('notify', { msg }); }
            destroy() {
                this._dead = true;
                _allSessions.delete(this);
                try { this.seek.destroy(); } catch (e) {}
                try { this.stall.destroy(); } catch (e) {}
                try { this.buffer.stop(); } catch (e) {}
                try { this.adgate.stop(); } catch (e) {}
                try { delete this.video.__vaSession; } catch (e) {}
            }
        }

        // ============ VideoDiscoveryEngine ============
        const VideoDiscoveryEngine = {
            _seen: new WeakSet(),
            _observer: null,
            _attrObserver: null,
            init() {
                this._scanAll();
                this._observer = new MutationObserver((muts) => {
                    for (const m of muts) {
                        for (const node of m.addedNodes) {
                            if (node.nodeType !== 1) continue;
                            if (node.tagName === 'VIDEO') this._takeOver(node);
                            else this._scanWithin(node);
                        }
                    }
                });
                this._observer.observe(document.documentElement, { childList: true, subtree: true });

                // 5s 后仍无 video 的容器 → 强制懒加载
                setTimeout(() => {
                    if (!this._hasAnyVideo()) {
                        const container = document.querySelector(PROFILE.containerSel || 'body');
                        if (container) LazyInitUnlocker.forceInit(container);
                    }
                }, 5000);
            },
            _hasAnyVideo() {
                return !!document.querySelector('video');
            },
            _scanAll() {
                this._scanWithin(document.documentElement);
                this._scanShadows(document.documentElement);
            },
            _scanWithin(root) {
                try {
                    root.querySelectorAll && root.querySelectorAll('video').forEach(v => this._takeOver(v));
                } catch (e) {}
                this._scanShadows(root);
            },
            _scanShadows(root) {
                try {
                    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
                    for (const el of all) {
                        if (el.shadowRoot) this._scanWithin(el.shadowRoot);
                    }
                } catch (e) {}
            },
            _takeOver(video) {
                if (this._seen.has(video)) return;
                this._seen.add(video);
                // rebuildVideoElement 重建后的 clone 已绑定 session，避免重复创建
                if (video.__vaSession) return;
                try {
                    new VideoSession(video);
                } catch (e) {}
                // 属性变化观察：src/data-src 变化时重新检测播放器
                try {
                    const obs = new MutationObserver(() => {
                        const s = video.__vaSession;
                        if (s) s.type = PlayerTypeDetector.detect(video);
                    });
                    obs.observe(video, { attributes: true, attributeFilter: ['src', 'data-src', 'data-video', 'data-lazy-src'] });
                } catch (e) {}
            }
        };

        // ============ HealthMonitor ============
        const HealthMonitor = {
            _iv: null,
            start() {
                this._iv = setInterval(() => this._patrol(), 3000);
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden) this._patrol();
                });
                window.addEventListener('popstate', () => setTimeout(() => VideoDiscoveryEngine._scanAll(), 500));
                window.addEventListener('hashchange', () => setTimeout(() => VideoDiscoveryEngine._scanAll(), 500));
            },
            _patrol() {
                if (document.hidden) return;
                // 通过 session 注册表巡检：querySelectorAll 只能取到在 DOM 内的元素，
                // 无法发现已脱离 DOM 的死视频，必须遍历注册表才能正确回收
                _allSessions.forEach(s => {
                    const v = s.video;
                    if (!v || s._dead) { _allSessions.delete(s); return; }
                    if (!document.documentElement.contains(v)) { s.destroy(); return; }
                    // 内存压力检查
                    if (performance.memory && performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit > 0.9) {
                        try { s.trimBackBuffer(30); } catch (e) {}
                    }
                });
            }
        };

        // ============ 指令处理 ============
        Bridge.on('configUpdate', (cfg) => { Object.assign(CFG, cfg); });
        Bridge.on('reload', () => {
            document.querySelectorAll('video').forEach(v => {
                const s = v.__vaSession;
                if (s) { try { v.load(); if (CFG.autoPlay) v.play().catch(() => {}); } catch (e) {} s._report(); }
            });
        });
        Bridge.on('recover', () => {
            document.querySelectorAll('video').forEach(v => {
                const s = v.__vaSession; if (s) s.engineRecover();
            });
        });
        Bridge.on('downgrade', () => {
            document.querySelectorAll('video').forEach(v => {
                const s = v.__vaSession; if (s) s.downgradeQuality();
            });
        });

        // ============ 启动 ============
        installIOHook();
        installFetchPriority();
        installHlsHook();
        VideoDiscoveryEngine.init();
        HealthMonitor.start();
        Bridge.send('ready', { host });
    }

    // ============================================================
    // 【沙箱世界】注入页面引擎 + 启动 UI
    // ============================================================

    function injectPageWorld() {
        const cfg = ConfigStore.load();
        const script = document.createElement('script');
        script.textContent = '(' + pageEngine.toString() + ')(' + JSON.stringify(cfg) + ');';
        try {
            (document.head || document.documentElement).appendChild(script);
        } catch (e) {
            // 部分极端环境下 documentElement 不可用，延后重试
            setTimeout(() => {
                try { (document.head || document.documentElement).appendChild(script); } catch (e2) {}
            }, 0);
        }
        script.remove();
    }

    // 初始化
    let ui;
    function boot() {
        ui = new UIManager();
        MessageBridge.init((detail) => {
            const { evt, payload } = detail;
            if (evt === 'ready') { ui && ui.toast('视频加速引擎已就绪', 'ok'); }
            else if (evt === 'notify') { ui && ui.toast(payload.msg, 'warn'); }
            else if (evt === 'session' || evt === 'state') { ui && ui.update(payload || {}); }
            else if (evt === 'adSkip') { ui && ui.update({ adSkipped: payload.count }); }
        });

        injectPageWorld();

        // GM 菜单
        try {
            GM_registerMenuCommand('🎬 视频加速控制台', () => ui.toggle());
            GM_registerMenuCommand('⚡ 强制重载当前视频', () => MessageBridge.send('reload'));
            GM_registerMenuCommand('🔧 手动恢复播放', () => MessageBridge.send('recover'));
            GM_registerMenuCommand('📉 降低画质', () => MessageBridge.send('downgrade'));
        } catch (e) {}
    }

    boot();
})();
