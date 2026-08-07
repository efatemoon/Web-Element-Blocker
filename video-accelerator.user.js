// ==UserScript==
// @name         视频加载加速与稳定播放 + 自定义播放器
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  视频秒开·大缓冲·Seek防卡死·自动恢复·自定义播放器（倍速/横竖屏旋转/全屏快进快退/手势/快捷键）。配套"网页元素屏蔽器"：广告它来清，加速我来搞，播放器我来换。双上下文架构：沙箱世界管理配置与UI，页面世界注入引擎拦截HLS/Dash构造器、链式fetch提速、缓冲水位管理、Seek三级自愈、卡死看门狗、广告门禁联动跳过，并叠加毛玻璃自定义控制栏。
// @author       EFate
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// @downloadURL  https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/video-accelerator.user.js
// @updateURL    https://raw.githubusercontent.com/efatemoon/Web-Element-Blocker/refs/heads/main/video-accelerator.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 【沙箱世界】配置持久化 / 消息桥 / 全局控制面板
    // ============================================================

    const ConfigStore = {
        defaults: {
            autoPlay: true,
            bigBuffer: true,
            adGateBypass: true,
            seekGuard: true,
            bufferTarget: 60,
            seekTimeout: 8000,
            takeoverMode: 'overlay',          // overlay | extract | accel-only
            speedMemory: true,
            rememberRate: 1,
            rotation: true,
            fastSeek: true,
            gesture: true,
            keyboard: true,
            siteProfiles: {}
        },
        _cache: null,
        load() {
            if (this._cache) return this._cache;
            let raw = null;
            try { raw = GM_getValue('va_config', null); } catch (e) { raw = null; }
            this._cache = Object.assign({}, this.defaults, raw || {});
            return this._cache;
        },
        save() { try { GM_setValue('va_config', this._cache); } catch (e) { } },
        get(k) { return this.load()[k]; },
        set(k, v) { this.load()[k] = v; this.save(); }
    };

    // 沙箱 ⇄ 页面世界消息桥：命名空间事件 va-cmd(下行) / va-evt(上行)
    const MessageBridge = {
        init(onEvent) {
            this._onEvent = onEvent;
            window.addEventListener('va-evt', (e) => {
                try { this._onEvent(e.detail || {}); } catch (err) { }
            });
        },
        send(cmd, payload) {
            try { window.dispatchEvent(new CustomEvent('va-cmd', { detail: { cmd, payload } })); } catch (e) { }
        }
    };

    // 全局控制面板：closed Shadow DOM，宿主 #va-ui-host，毛玻璃风格对齐屏蔽器
    class UIManager {
        constructor() {
            this.cfg = ConfigStore.load();
            this._state = { status: '空闲', playerType: '-', buffer: 0, recoveries: 0, adSkipped: 0, takeover: false };
            this._panel = null; this._visible = false;
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
                .panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: rgba(25, 25, 30, 0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255,255,255,0.16); padding: 20px; border-radius: 16px;
                    box-shadow: 0 20px 64px rgba(0,0,0,0.42), inset 0 0 0 1px rgba(255,255,255,0.07);
                    width: min(440px, calc(100vw - 48px)); max-width: calc(100vw - 48px);
                    max-height: min(680px, 80vh); overflow-y: auto; color: #eee; text-shadow: 0 1px 2px rgba(0,0,0,0.8); box-sizing: border-box; }
                h3 { margin-top: 0; font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 14px;
                    border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 10px; cursor: grab; user-select: none; }
                h3:active { cursor: grabbing; }
                .row { display:flex; justify-content:space-between; font-size:12px; color:#ccc; margin:5px 0; }
                .row b { color:#fff; font-weight:600; }
                .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; vertical-align:middle; background:#888; }
                .dot.live{ background:#34c759; box-shadow:0 0 6px #34c759; } .dot.wait{ background:#ff9500; } .dot.err{ background:#ff3b30; }
                .buf-bar{ height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden; margin:6px 0 12px; }
                .buf-fill{ height:100%; background:linear-gradient(90deg,#4aa3ff,#34c759); width:0%; transition:width .3s; }
                .btn-group{ display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
                button{ padding:9px 12px; border:1px solid rgba(255,255,255,0.18); border-radius:8px; cursor:pointer; font-size:13px; font-weight:500;
                    transition:filter .15s, transform .1s; flex:1; display:flex; align-items:center; justify-content:center; line-height:1.2;
                    background:rgba(255,255,255,0.1); color:#fff; backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); text-shadow:0 1px 2px rgba(0,0,0,0.4); }
                button:hover:not(:disabled){ filter:brightness(1.15); transform:translateY(-1px); }
                button:active:not(:disabled){ transform:translateY(0); filter:brightness(0.95); }
                button:disabled{ opacity:0.3; cursor:not-allowed; }
                .btn-primary{ background:rgba(0,122,255,0.72); } .btn-success{ background:rgba(52,199,89,0.72); }
                .btn-warning{ background:rgba(255,149,0,0.72); } .btn-danger{ background:rgba(255,59,48,0.72); }
                .divider{ height:1px; background:rgba(255,255,255,0.1); margin:12px 0; }
                label.opt{ display:flex; align-items:center; gap:8px; font-size:13px; color:#ddd; margin:7px 0; cursor:pointer; }
                label.opt input[type=checkbox]{ width:18px; height:18px; accent-color:#0a84ff; }
                label.opt input[type=number]{ width:64px; padding:4px 6px; margin-left:6px; border:1px solid rgba(255,255,255,0.14); border-radius:6px; background:rgba(0,0,0,0.25); color:#eee; font-size:12px; }
                .radio-group{ display:flex; gap:14px; margin:7px 0; font-size:13px; color:#ddd; }
                .radio-group label{ display:flex; align-items:center; gap:4px; cursor:pointer; }
                .hint{ font-size:11px; color:#aaa; line-height:1.5; margin-top:10px; }
                .toast{ position:fixed; top:20px; right:20px; z-index:2147483646; padding:12px 18px; border-radius:10px;
                    background:rgba(30,30,35,0.92); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
                    border:1px solid rgba(255,255,255,0.15); color:#fff; font-size:13px; max-width:340px; word-break:break-all;
                    transform:translateX(120%); transition:transform .3s cubic-bezier(.4,0,.2,1); box-shadow:0 8px 32px rgba(0,0,0,0.3); }
                .toast.show{ transform:translateX(0); } .toast.warn{ border-left:3px solid #ff9500; }
                .toast.err{ border-left:3px solid #ff3b30; } .toast.ok{ border-left:3px solid #34c759; }
                .close-x{ position:absolute; top:10px; right:14px; cursor:pointer; color:#aaa; font-size:18px; background:none; border:none; flex:none; padding:0 4px; }
                @media (max-width:480px){ .panel{ padding:16px; border-radius:14px; width:calc(100vw - 56px); max-width:calc(100vw - 56px); } button{ padding:8px 10px; font-size:12px; } }
            `;
            this.root.appendChild(style);

            this._toast = document.createElement('div'); this._toast.className = 'toast'; this.root.appendChild(this._toast);

            this._panel = document.createElement('div'); this._panel.className = 'panel'; this._panel.style.display = 'none';
            this._panel.innerHTML = `
                <span class="close-x" data-act="close">×</span>
                <h3>🎬 视频加速控制台</h3>
                <div class="row"><span><span class="dot" id="va-dot"></span>状态: <b id="va-status">空闲</b></span><span>播放器: <b id="va-type">-</b></span></div>
                <div class="row"><span>Buffer: <b id="va-buf">0.0s</b></span><span>恢复: <b id="va-rec">0</b></span><span>广告跳过: <b id="va-ad">0</b></span></div>
                <div class="buf-bar"><div class="buf-fill" id="va-buf-fill"></div></div>
                <div class="row"><span>接管: <b id="va-takeover">否</b></span><span>倍速: <b id="va-rate">1.0x</b></span></div>
                <div class="btn-group">
                    <button class="btn-warning" data-act="reload">强制重载</button>
                    <button class="btn-primary" data-act="recover">手动恢复</button>
                    <button class="btn-danger" data-act="downgrade">降低画质</button>
                </div>
                <div class="divider"></div>
                <div class="radio-group">
                    <label><input type="radio" name="va-mode" value="overlay" > 控件覆盖</label>
                    <label><input type="radio" name="va-mode" value="extract"> 提取播放</label>
                    <label><input type="radio" name="va-mode" value="accel-only"> 仅加速</label>
                </div>
                <label class="opt"><input type="checkbox" id="va-speedmem"> 倍速记忆</label>
                <label class="opt"><input type="checkbox" id="va-rotation"> 横竖屏旋转</label>
                <label class="opt"><input type="checkbox" id="va-fastseek"> 全屏快进快退</label>
                <label class="opt"><input type="checkbox" id="va-gesture"> 手势操作</label>
                <label class="opt"><input type="checkbox" id="va-kb"> 快捷键</label>
                <label class="opt"><input type="checkbox" id="va-auto"> 自动播放</label>
                <label class="opt"><input type="checkbox" id="va-big"> 超大缓冲</label>
                <label class="opt"><input type="checkbox" id="va-adgate"> 广告门禁跳过</label>
                <label class="opt"><input type="checkbox" id="va-seek"> Seek防卡死</label>
                <label class="opt">Buffer目标: <input type="number" id="va-btgt" min="10" max="300" step="10"> s</label>
                <label class="opt">Seek超时: <input type="number" id="va-sto" min="3" max="30" step="1"> s</label>
                <div class="hint">提示：本脚本与"网页元素屏蔽器"配套。屏蔽器清广告，本脚本负责视频秒开、卡死自愈与自定义播放器。配置自动保存。</div>
            `;
            this.root.appendChild(this._panel);

            this._panel.addEventListener('click', (e) => {
                const t = e.target.closest('[data-act]'); if (!t) return;
                const act = t.getAttribute('data-act');
                if (act === 'close') this.hide(); else MessageBridge.send(act);
            });
            const bind = (id, key, transform) => {
                this._panel.querySelector('#' + id).addEventListener('change', (e) => {
                    ConfigStore.set(key, transform ? transform(e.target) : e.target.checked);
                    MessageBridge.send('configUpdate', ConfigStore.load());
                });
            };
            this._panel.querySelectorAll('input[name="va-mode"]').forEach(r => r.addEventListener('change', (e) => {
                if (e.target.checked) { ConfigStore.set('takeoverMode', e.target.value); MessageBridge.send('configUpdate', ConfigStore.load()); }
            }));
            bind('va-speedmem', 'speedMemory');
            bind('va-rotation', 'rotation');
            bind('va-fastseek', 'fastSeek');
            bind('va-gesture', 'gesture');
            bind('va-kb', 'keyboard');
            bind('va-auto', 'autoPlay');
            bind('va-big', 'bigBuffer');
            bind('va-adgate', 'adGateBypass');
            bind('va-seek', 'seekGuard');
            bind('va-btgt', 'bufferTarget', t => parseInt(t.value) || 60);
            bind('va-sto', 'seekTimeout', t => (parseInt(t.value) || 8) * 1000);
            this._syncInputs();
        }
        _syncInputs() {
            const c = this.cfg;
            this._panel.querySelector('#va-auto').checked = !!c.autoPlay;
            this._panel.querySelector('#va-big').checked = !!c.bigBuffer;
            this._panel.querySelector('#va-adgate').checked = !!c.adGateBypass;
            this._panel.querySelector('#va-seek').checked = !!c.seekGuard;
            this._panel.querySelector('#va-speedmem').checked = !!c.speedMemory;
            this._panel.querySelector('#va-rotation').checked = !!c.rotation;
            this._panel.querySelector('#va-fastseek').checked = !!c.fastSeek;
            this._panel.querySelector('#va-gesture').checked = !!c.gesture;
            this._panel.querySelector('#va-kb').checked = !!c.keyboard;
            this._panel.querySelector('#va-btgt').value = c.bufferTarget;
            this._panel.querySelector('#va-sto').value = Math.round(c.seekTimeout / 1000);
            const modeRadio = this._panel.querySelector('input[name="va-mode"][value="' + (c.takeoverMode || 'overlay') + '"]');
            if (modeRadio) modeRadio.checked = true;
        }
        _mount() { if (this.host.isConnected) return; (document.body || document.documentElement).appendChild(this.host); }
        toggle() { this._visible ? this.hide() : this.show(); }
        show() { this._mount(); this.cfg = ConfigStore.load(); this._syncInputs(); this._panel.style.display = ''; this._visible = true; }
        hide() { this._panel.style.display = 'none'; this._visible = false; }
        toast(msg, kind) {
            this._mount(); this._toast.textContent = msg;
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
            set('va-rec', s.recoveries); set('va-ad', s.adSkipped);
            set('va-takeover', s.takeover ? '是' : '否');
            set('va-rate', (s.rate || 1).toFixed(1) + 'x');
            const dot = this._panel.querySelector('#va-dot');
            if (dot) dot.className = 'dot' + (s.status === '播放中' ? ' live' : s.status === '缓冲中' ? ' wait' : s.status === '错误' ? ' err' : '');
            const fill = this._panel.querySelector('#va-buf-fill');
            if (fill) fill.style.width = Math.min(100, ((typeof s.buffer === 'number' ? s.buffer : 0) / Math.max(10, this.cfg.bufferTarget)) * 100) + '%';
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
            bufferTarget: 60, seekTimeout: 8000, takeoverMode: 'overlay',
            speedMemory: true, rememberRate: 1, rotation: true, fastSeek: true,
            gesture: true, keyboard: true
        }, initialConfig || {});

        const SITE_PROFILES = {
            '_default': { containerSel: null, bufferTarget: 60, seekTimeout: 8000 },
            'www.bilibili.com': { containerSel: '.bpx-player-video-area', bufferTarget: 120 },
            'v.qq.com': { adGateBypass: true, bufferTarget: 90 },
            'www.youtube.com': { bufferTarget: 120, seekTimeout: 10000 }
        };
        const PROFILE = Object.assign({}, SITE_PROFILES['_default'], SITE_PROFILES[location.hostname] || {});

        // 消息桥（页面世界侧）
        const Bridge = {
            send(evt, payload) { try { window.dispatchEvent(new CustomEvent('va-evt', { detail: { evt, payload } })); } catch (e) { } },
            on(cmd, handler) {
                window.addEventListener('va-cmd', (e) => {
                    const d = e.detail || {};
                    if (d.cmd === cmd) { try { handler(d.payload); } catch (err) { } }
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

        // ============ Registry ============
        const PlayerRegistry = {
            _map: new WeakMap(),   // video -> { type, player }
            get(v) { return this._map.get(v); },
            set(v, info) { this._map.set(v, info); }
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
                return new Orig(merged);
            }
            HookedHls.prototype = Orig.prototype;
            try { HookedHls.isSupported = Orig.isSupported ? Orig.isSupported.bind(Orig) : Orig.isSupported; } catch (e) { }
            for (const k of Object.getOwnPropertyNames(Orig)) { if (!(k in HookedHls)) { try { HookedHls[k] = Orig[k]; } catch (e) { } } }
            HookedHls.__vaPatched = true;
            return HookedHls;
        }

        function installHlsHook() {
            let tries = 0;
            const tick = () => {
                if (window.Hls && !window.Hls.__vaPatched) { try { window.Hls = wrapHls(window.Hls); } catch (e) { } }
                if (window.dashjs && window.dashjs.MediaPlayer && !window.dashjs.__vaPatched) {
                    try {
                        // dashjs.MediaPlayer 是工厂函数，调用返回实例；需包装工厂本身，
                        // 不能在临时实例上改 create（其他调用方拿不到补丁）
                        const OrigMP = window.dashjs.MediaPlayer;
                        function WrappedMP() {
                            const inst = OrigMP.apply(this, arguments);
                            const origCreate = inst.create;
                            inst.create = function () {
                                const p = origCreate.apply(this, arguments);
                                try { p.updateSettings({ streaming: { buffer: { stableBufferTime: 30, bufferTimeAtTopQuality: 60, bufferToKeep: 30 }, abr: { autoSwitchBitrate: { video: true } } } }); } catch (e) { }
                                return p;
                            };
                            return inst;
                        }
                        WrappedMP.prototype = OrigMP.prototype;
                        for (const k of Object.getOwnPropertyNames(OrigMP)) { try { WrappedMP[k] = OrigMP[k]; } catch (e) { } }
                        window.dashjs.MediaPlayer = WrappedMP;
                        window.dashjs.__vaPatched = true;
                    } catch (e) { }
                }
                if (window.shaka && window.shaka.Player && !window.shaka.__vaPatched) {
                    try {
                        const OrigP = window.shaka.Player;
                        function WrappedP(video, dependency) {
                            const p = new OrigP(video, dependency);
                            try { p.configure({ streaming: { rebufferingGoal: 2, bufferingGoal: 60, bufferBehind: 90 } }); } catch (e) { }
                            return p;
                        }
                        WrappedP.prototype = OrigP.prototype;
                        for (const k of Object.getOwnPropertyNames(OrigP)) { try { WrappedP[k] = OrigP[k]; } catch (e) { } }
                        window.shaka.Player = WrappedP;
                        window.shaka.__vaPatched = true;
                    } catch (e) { }
                }
                tries++;
                if (tries < 200) setTimeout(tick, 100);
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
            } catch (e) { }
        }

        // ============ IO Hook ============
        function installIOHook() {
            if (!window.IntersectionObserver || window.IntersectionObserver.__vaPatched) return;
            const Orig = window.IntersectionObserver;
            function HookedIO(cb, opts) { const inst = new Orig(cb, opts); try { IORegistry.track(inst, cb); } catch (e) { } return inst; }
            HookedIO.prototype = Orig.prototype;
            for (const k of Object.getOwnPropertyNames(Orig)) { try { HookedIO[k] = Orig[k]; } catch (e) { } }
            HookedIO.__vaPatched = true;
            window.IntersectionObserver = HookedIO;
        }

        // ============ Fetch 链式包装（兼容屏蔽器） ============
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
                } catch (e) { }
                return base.apply(this, arguments);
            };
            wrapped.__vaPatched = true;
            window.fetch = wrapped;
        }

        // ============ PlayerTypeDetector ============
        const PlayerTypeDetector = {
            detect(video) {
                if (video.hls || video._hls) { PlayerRegistry.set(video, { type: 'hls', player: video.hls || video._hls }); return 'hls'; }
                if (video.dashjs) { PlayerRegistry.set(video, { type: 'dash', player: video.dashjs }); return 'dash'; }
                for (const k of ['hls', '_hls', '__hls', 'hlsPlayer', 'player']) {
                    const v = video[k];
                    if (v && (v.config || v.startLoad || v.attachMedia)) { PlayerRegistry.set(video, { type: 'hls', player: v }); return 'hls'; }
                }
                if (window.shaka && video.shakaPlayer) { PlayerRegistry.set(video, { type: 'shaka', player: video.shakaPlayer }); return 'shaka'; }
                const src = video.currentSrc || video.src || '';
                if (src.indexOf('blob:') === 0) { PlayerRegistry.set(video, { type: 'mse', player: null }); return 'mse'; }
                if (src) { PlayerRegistry.set(video, { type: 'native', player: null }); return 'native'; }
                return 'unknown';
            }
        };

        // ============ PreloadAccelerator ============
        const PreloadAccelerator = {
            _connected: new Set(),
            apply(video, type) {
                try {
                    video.preload = 'auto';
                    const lazy = video.getAttribute('data-src') || video.getAttribute('data-video') || video.getAttribute('data-lazy-src');
                    if (lazy && !video.src) video.src = lazy;
                    video.removeAttribute('data-src'); video.removeAttribute('data-lazy-src');
                } catch (e) { }
                const src = video.currentSrc || video.src || '';
                if (src) { try { this._preconnect(src); } catch (e) { } }
                const info = PlayerRegistry.get(video);
                if ((type === 'hls') || (info && info.type === 'hls')) { if (info && info.player) hotPatchHls(info.player); }
                else if (info && info.type === 'dash' && info.player) { try { info.player.updateSettings({ streaming: { buffer: { stableBufferTime: 30, bufferTimeAtTopQuality: 60, bufferToKeep: 30 } } }); } catch (e) { } }
                else if (info && info.type === 'shaka' && info.player) { try { info.player.configure({ streaming: { rebufferingGoal: 2, bufferingGoal: 60, bufferBehind: 90 } }); } catch (e) { } }
            },
            _preconnect(url) {
                try {
                    const u = new URL(url, location.href);
                    if (u.origin === location.origin || this._connected.has(u.origin)) return;
                    this._connected.add(u.origin);
                    const link = document.createElement('link');
                    link.rel = 'preconnect'; link.href = u.origin; link.crossOrigin = 'anonymous';
                    (document.head || document.documentElement).appendChild(link);
                } catch (e) { }
            }
        };

        // ============ BufferManager ============
        class BufferManager {
            constructor(session) { this.session = session; this._iv = null; this._onTimeUpdate = null; }
            watch() {
                const v = this.session.video;
                const check = () => this._check();
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
                    for (let i = 0; i < video.buffered.length; i++) {
                        if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i))
                            return video.currentTime - video.buffered.start(i);
                    }
                } catch (e) { }
                return 0;
            }
            stop() {
                if (this._iv) { clearInterval(this._iv); this._iv = null; }
                if (this._onTimeUpdate) { try { this.session.video.removeEventListener('timeupdate', this._onTimeUpdate); } catch (e) { } this._onTimeUpdate = null; }
            }
        }

        // ============ SeekGuard ============
        class SeekGuard {
            constructor(session) {
                this.session = session;
                this.retry = 0; this.t = null; this.seekTarget = 0;
                const v = session.video;
                this._onSeeking = () => { if (!CFG.seekGuard) return; this.retry = 0; this.seekTarget = v.currentTime; this.arm(); };
                this._onSeeked = () => {
                    setTimeout(() => {
                        if (v.ended || !v.paused) return;
                        if (v.readyState >= 3 && CFG.autoPlay) { try { v.play().catch(() => { }); } catch (e) { } }
                    }, 500);
                };
                this._onCanPlay = () => this.disarm();
                this._onPlaying = () => this.disarm();
                v.addEventListener('seeking', this._onSeeking);
                v.addEventListener('seeked', this._onSeeked);
                v.addEventListener('canplay', this._onCanPlay);
                v.addEventListener('playing', this._onPlaying);
            }
            arm() { clearTimeout(this.t); this.t = setTimeout(() => this.escalate(), CFG.seekTimeout || 8000); }
            disarm() { clearTimeout(this.t); this.retry = 0; }
            escalate() {
                if (!CFG.seekGuard) return;
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
                this.stallCount = 0; this._lastStallTime = 0; this._readyLowSince = 0; this._iv = null;
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
                    if (Date.now() - this.stallStart >= 5000) this._recover();
                } else { this.stallStart = 0; this.lastTime = t; }
                if (this.waitingSince && Date.now() - this.waitingSince >= 5000) { this.waitingSince = 0; this._recover(); }
                if (v.readyState <= 2) {
                    if (!this._readyLowSince) this._readyLowSince = Date.now();
                    else if (Date.now() - this._readyLowSince >= 5000) { this._readyLowSince = 0; this._recover(); }
                } else { this._readyLowSince = 0; }
            }
            _recover() {
                this.stallStart = 0;
                const now = Date.now();
                if (now - this._lastStallTime < 60000) this.stallCount++; else this.stallCount = 1;
                this._lastStallTime = now;
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
            constructor(session) { this.session = session; this._iv = null; }
            start() { if (!CFG.adGateBypass) return; this._iv = setInterval(() => this._poll(), 2000); }
            _poll() {
                const v = this.session.video; if (!v) return;
                const container = this._findContainer(v); if (!container) return;
                if (this._isAdState(container, v)) { this.sweep(container); this.session.adSkipped(); }
            }
            _findContainer(video) {
                let el = video.parentElement, best = null;
                while (el && el !== document.body) {
                    const cls = (typeof el.className === 'string') ? el.className : '';
                    if (/player|video|media|preroll|ad-/i.test(cls)) best = el;
                    el = el.parentElement;
                }
                return best || video.parentElement;
            }
            _isAdState(container, video) {
                if (!container) return false;
                const cls = (typeof container.className === 'string') ? container.className : '';
                if (/ad-loading|ad-playing|preroll|showing-ad|vast-/i.test(cls)) return true;
                try {
                    const nodes = container.querySelectorAll('*');
                    for (let i = 0; i < nodes.length && i < 60; i++) {
                        const t = (nodes[i].textContent || '').trim();
                        if (t && /\d+\s*(s|秒)/.test(t) && t.length < 12) return true;
                    }
                } catch (e) { }
                try {
                    const btns = container.querySelectorAll('button,[role="button"],[class*="skip"],[class*="ad-"]');
                    for (let i = 0; i < btns.length && i < 80; i++) {
                        const t = (btns[i].textContent || '').trim();
                        if (t && t.length < 20 && /跳过|skip\s*ad|关闭广告|skip[\s-]?ad/i.test(t)) return true;
                    }
                } catch (e) { }
                return false;
            }
            sweep(container) {
                try {
                    container.classList.remove('ad-loading', 'ad-playing', 'preroll', 'showing-ad');
                    container.querySelectorAll('[class*="preroll"],[class*="countdown"],[class*="vast-"]').forEach(el => {
                        if (el.querySelector && el.querySelector('video')) return; el.remove();
                    });
                    const skip = Array.from(container.querySelectorAll('button,[role="button"],[class*="skip"],[class*="ad-"]'))
                        .find(el => { const t = (el.textContent || '').trim(); return t.length < 20 && /跳过|skip\s*ad|关闭广告|skip[\s-]?ad/i.test(t); });
                    if (skip) { try { skip.click(); } catch (e) { } }
                    const video = container.querySelector('video');
                    if (video) { try { video.play().catch(() => { }); } catch (e) { } }
                    container.dispatchEvent(new Event('adCompleted', { bubbles: true }));
                    container.dispatchEvent(new Event('ads-ad-ended', { bubbles: true }));
                } catch (e) { }
            }
            stop() { if (this._iv) { clearInterval(this._iv); this._iv = null; } }
        }

        // ============ LazyInitUnlocker ============
        const LazyInitUnlocker = {
            forceInit(container) {
                try { IORegistry.forEach((inst, cb) => { try { cb([{ target: container, isIntersecting: true, intersectionRatio: 1, boundingClientRect: container.getBoundingClientRect() }], inst); } catch (e) { } }); } catch (e) { }
                try { window.dispatchEvent(new Event('scroll')); } catch (e) { }
                try { window.dispatchEvent(new Event('resize')); } catch (e) { }
            }
        };

        // ============================================================
        // 【播放器接管层】CustomPlayerControls / Speed / Rotation / Gesture / Keyboard / Extract / Skin
        // ============================================================

        const PlayerSkin = {
            css: `
                :host { all: initial; }
                * { box-sizing: border-box; }
                .va-wrap { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
                .va-wrap video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
                .va-wrap.va-portrait video { transform: rotate(90deg); transform-origin: center center; object-fit: contain; }
                .va-gesture { position: absolute; inset: 0; display: flex; z-index: 5; }
                .va-zone { flex: 1; }
                .va-center-fb { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 9;
                    padding: 14px 22px; border-radius: 14px; background: rgba(0,0,0,0.55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                    color: #fff; font-size: 22px; font-weight: 600; opacity: 0; transition: opacity .25s; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
                .va-center-fb.show { opacity: 1; }
                .va-top-bar { position: absolute; top: 0; left: 0; right: 0; z-index: 8; display: flex; justify-content: space-between; align-items: center;
                    padding: 10px 14px; background: linear-gradient(180deg, rgba(0,0,0,0.5), transparent); color: #fff; font-size: 13px;
                    transition: opacity .3s; }
                .va-top-bar.va-hidden { opacity: 0; pointer-events: none; }
                .va-top-bar button { background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 8px;
                    padding: 6px 10px; font-size: 12px; cursor: pointer; margin-left: 6px; }
                .va-top-bar button:hover { background: rgba(255,255,255,0.2); }
                .va-loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 7; width: 54px; height: 54px;
                    border: 4px solid rgba(255,255,255,0.2); border-top-color: #4aa3ff; border-radius: 50%; animation: va-spin 0.9s linear infinite; }
                @keyframes va-spin { to { transform: translate(-50%,-50%) rotate(360deg); } }
                .va-ctrl { position: absolute; bottom: 0; left: 0; right: 0; z-index: 8; padding: 10px 14px;
                    background: linear-gradient(0deg, rgba(0,0,0,0.6), transparent);
                    display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: #fff;
                    transition: opacity .3s, transform .3s; }
                .va-ctrl.va-hidden { opacity: 0; transform: translateY(8px); pointer-events: none; }
                .va-ctrl .va-bar-bg { background: rgba(25,25,30,0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
                    border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                    padding: 8px 12px; display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
                .va-btn { background: none; border: none; color: #fff; cursor: pointer; font-size: 16px; padding: 4px 6px; border-radius: 6px; flex: none;
                    display: flex; align-items: center; justify-content: center; min-width: 28px; min-height: 28px; }
                .va-btn:hover { background: rgba(255,255,255,0.18); }
                .va-time { font-size: 12px; color: #ddd; font-variant-numeric: tabular-nums; white-space: nowrap; }
                .va-progress { position: relative; flex: 1; height: 4px; background: rgba(255,255,255,0.18); border-radius: 2px; cursor: pointer; min-width: 80px; }
                .va-progress:hover { height: 8px; }
                .va-buffered { position: absolute; left: 0; top: 0; height: 100%; background: rgba(255,255,255,0.25); border-radius: 2px; }
                .va-played { position: absolute; left: 0; top: 0; height: 100%; background: linear-gradient(90deg, #007AFF, #4aa3ff); border-radius: 2px; }
                .va-thumb { position: absolute; top: 50%; width: 14px; height: 14px; border-radius: 50%; background: #fff;
                    box-shadow: 0 0 8px rgba(74,163,255,0.8); transform: translate(-50%,-50%); pointer-events: none; }
                .va-vol-wrap { display: flex; align-items: center; gap: 4px; }
                .va-vol { width: 60px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 2px; cursor: pointer; }
                .va-vol-fill { height: 100%; background: #fff; border-radius: 2px; }
                .va-rate-menu { position: absolute; bottom: 48px; right: 14px; z-index: 9; background: rgba(25,25,30,0.92);
                    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.16); border-radius: 10px;
                    padding: 6px; display: none; min-width: 90px; }
                .va-rate-menu.show { display: block; }
                .va-rate-menu div { padding: 6px 12px; color: #fff; font-size: 13px; cursor: pointer; border-radius: 6px; text-align: center; }
                .va-rate-menu div:hover { background: rgba(255,255,255,0.15); }
                .va-rate-menu div.active { background: rgba(74,163,255,0.5); }
                .va-lock { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); z-index: 15; font-size: 32px; color: #fff;
                    opacity: 0; transition: opacity .3s; pointer-events: none; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
                .va-lock.show { opacity: 0.9; }
                @media (max-width: 600px) { .va-time { font-size: 11px; } .va-btn { font-size: 14px; min-width: 24px; } .va-vol { width: 44px; } }
            `
        };

        // SpeedController：倍速 + 看门狗防站点重置
        class SpeedController {
            constructor(session) {
                this.session = session; this.video = session.video;
                this.RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
                this.rate = CFG.speedMemory ? CFG.rememberRate : 1;
                this._iv = null;
                try { this.video.playbackRate = this.rate; this.video.preservesPitch = true; } catch (e) { }
                this._iv = setInterval(() => {
                    try {
                        if (!this.video.paused && Math.abs(this.video.playbackRate - this.rate) > 0.01) {
                            this.video.playbackRate = this.rate;
                        }
                    } catch (e) { }
                }, 2000);
            }
            set(rate) {
                this.rate = rate;
                try { this.video.playbackRate = rate; this.video.preservesPitch = true; } catch (e) { }
                if (CFG.speedMemory) { CFG.rememberRate = rate; Bridge.send('rateChange', { rate }); }
            }
            step(delta) {
                let idx = this.RATES.indexOf(this.rate);
                if (idx < 0) idx = this.RATES.indexOf(1);
                idx = Math.max(0, Math.min(this.RATES.length - 1, idx + delta));
                this.set(this.RATES[idx]);
            }
            destroy() { if (this._iv) clearInterval(this._iv); }
        }

        // RotationController：横竖屏旋转
        class RotationController {
            constructor(session) { this.session = session; this.video = session.video; this.portrait = false; }
            toggle() {
                if (!CFG.rotation) return;
                this.portrait = !this.portrait;
                const wrap = this.session.takeover && this.session.takeover.wrap;
                if (!wrap) return;
                if (this.portrait) {
                    const rect = wrap.getBoundingClientRect();
                    const W = rect.width, H = rect.height;
                    const v = this.video;
                    v.style.transform = 'rotate(90deg)'; v.style.transformOrigin = 'center center';
                    v.style.width = H + 'px'; v.style.height = W + 'px';
                    v.style.position = 'absolute';
                    v.style.left = (W - H) / 2 + 'px'; v.style.top = (H - W) / 2 + 'px';
                    wrap.classList.add('va-portrait');
                } else {
                    const v = this.video;
                    v.style.transform = ''; v.style.width = ''; v.style.height = '';
                    v.style.position = ''; v.style.left = ''; v.style.top = '';
                    wrap.classList.remove('va-portrait');
                }
            }
        }

        // CustomPlayerControls：控制栏 + 进度条 + 播放暂停 + 倍速菜单
        class CustomPlayerControls {
            constructor(session) {
                this.session = session; this.video = session.video;
                this.speed = new SpeedController(session);
                this.rotation = new RotationController(session);
                this._hideTimer = null; this._rateMenuOpen = false;
                this._build();
                this._bind();
                this._autoHide(3000);
            }
            _build() {
                const host = this.session.takeover.host;
                // closed Shadow DOM 的 host.shadowRoot 返回 null，必须用 TakeoverController 缓存的 root
                const root = this.session.takeover.root;
                const wrap = document.createElement('div'); wrap.className = 'va-wrap';
                // 将原 video 移入 wrap（移动不破坏 MSE 绑定，只有替换/删除才会）
                const video = this.video;
                wrap.appendChild(video);
                this._wrap = wrap;

                const gesture = document.createElement('div'); gesture.className = 'va-gesture';
                const zoneL = document.createElement('div'); zoneL.className = 'va-zone';
                const zoneR = document.createElement('div'); zoneR.className = 'va-zone';
                gesture.appendChild(zoneL); gesture.appendChild(zoneR);
                this._zoneL = zoneL; this._zoneR = zoneR;

                const centerFb = document.createElement('div'); centerFb.className = 'va-center-fb';
                this._centerFb = centerFb;

                const topBar = document.createElement('div'); topBar.className = 'va-top-bar va-hidden';
                topBar.innerHTML = `<span class="va-title">视频加速播放器</span><span><button data-act="extract">提取播放</button><button data-act="restore">恢复原播放器</button><button data-act="pip">画中画</button></span>`;
                this._topBar = topBar;

                const loading = document.createElement('div'); loading.className = 'va-loading'; loading.style.display = 'none';
                this._loading = loading;

                const lock = document.createElement('div'); lock.className = 'va-lock'; lock.textContent = '🔒';
                this._lock = lock; this._locked = false;

                const ctrl = document.createElement('div'); ctrl.className = 'va-ctrl va-hidden';
                ctrl.innerHTML = `
                    <div class="va-bar-bg">
                        <button class="va-btn" data-act="play">▶</button>
                        <button class="va-btn" data-act="back">⏪</button>
                        <button class="va-btn" data-act="fwd">⏩</button>
                        <span class="va-time va-cur">0:00</span>
                        <div class="va-progress"><div class="va-buffered"></div><div class="va-played"></div><div class="va-thumb"></div></div>
                        <span class="va-time va-dur">0:00</span>
                        <div class="va-vol-wrap"><button class="va-btn" data-act="mute">🔊</button><div class="va-vol"><div class="va-vol-fill"></div></div></div>
                        <button class="va-btn" data-act="rate">1.0x</button>
                        <button class="va-btn" data-act="rotate">🔄</button>
                        <button class="va-btn" data-act="lock">🔒</button>
                        <button class="va-btn" data-act="fs">⛶</button>
                    </div>
                `;
                this._ctrl = ctrl;

                const rateMenu = document.createElement('div'); rateMenu.className = 'va-rate-menu';
                this.RATES = this.speed.RATES;
                rateMenu.innerHTML = this.RATES.map(r => `<div data-rate="${r}">${r}x</div>`).join('');
                this._rateMenu = rateMenu;

                wrap.appendChild(gesture); wrap.appendChild(centerFb); wrap.appendChild(topBar);
                wrap.appendChild(loading); wrap.appendChild(lock); wrap.appendChild(ctrl); wrap.appendChild(rateMenu);
                root.appendChild(wrap);

                this.session.takeover.wrap = wrap;
                this._onProgress();
                this._updateVolFill(this.video.volume);
            }
            _bind() {
                const v = this.video;
                v.addEventListener('play', () => this._setPlayBtn('⏸'));
                v.addEventListener('pause', () => this._setPlayBtn('▶'));
                v.addEventListener('timeupdate', () => this._onProgress());
                v.addEventListener('durationchange', () => this._onProgress());
                v.addEventListener('progress', () => this._onProgress());
                v.addEventListener('waiting', () => { this._loading.style.display = ''; });
                v.addEventListener('playing', () => { this._loading.style.display = 'none'; });
                v.addEventListener('canplay', () => { this._loading.style.display = 'none'; });
                v.addEventListener('ratechange', () => { this._ctrl.querySelector('[data-act=rate]').textContent = v.playbackRate.toFixed(2).replace(/0$/, '') + 'x'; });

                this._ctrl.addEventListener('click', (e) => this._onCtrlClick(e));
                this._rateMenu.addEventListener('click', (e) => {
                    const t = e.target.closest('[data-rate]'); if (!t) return;
                    this.speed.set(parseFloat(t.dataset.rate));
                    this._rateMenu.classList.remove('show'); this._rateMenuOpen = false;
                });
                this._topBar.addEventListener('click', (e) => {
                    const t = e.target.closest('[data-act]'); if (!t) return;
                    const act = t.dataset.act;
                    if (act === 'restore') this.session.takeover.disable();
                    else if (act === 'pip') { try { if (document.pictureInPictureElement) document.exitPictureInPicture(); else v.requestPictureInPicture && v.requestPictureInPicture(); } catch (e) { } }
                    else if (act === 'extract') this.session.takeover.openExtract();
                });

                // 进度条拖拽（handler 保存到实例以便 destroy 移除，避免 window 监听器泄漏）
                const prog = this._ctrl.querySelector('.va-progress');
                this._prog = prog;
                let dragging = false;
                const seekTo = (clientX) => {
                    const rect = prog.getBoundingClientRect();
                    let ratio = (clientX - rect.left) / rect.width;
                    ratio = Math.max(0, Math.min(1, ratio));
                    if (isFinite(v.duration) && v.duration > 0) v.currentTime = ratio * v.duration;
                };
                this._onProgDown = (e) => { dragging = true; seekTo(e.clientX); e.preventDefault(); };
                this._onProgMove = (e) => { if (dragging) seekTo(e.clientX); };
                this._onUp = () => { dragging = false; volDrag = false; };
                prog.addEventListener('mousedown', this._onProgDown);
                window.addEventListener('mousemove', this._onProgMove);
                window.addEventListener('mouseup', this._onUp);

                // 音量
                const vol = this._ctrl.querySelector('.va-vol');
                let volDrag = false;
                const setVol = (clientX) => {
                    const rect = vol.getBoundingClientRect();
                    let ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                    v.volume = ratio; v.muted = false;
                    this._updateVolFill(ratio);
                };
                this._onVolDown = (e) => { volDrag = true; setVol(e.clientX); e.preventDefault(); };
                this._onVolMove = (e) => { if (volDrag) setVol(e.clientX); };
                vol.addEventListener('mousedown', this._onVolDown);
                window.addEventListener('mousemove', this._onVolMove);

                // 手势（双击/长按）
                if (CFG.gesture) this._bindGesture();
            }
            _bindGesture() {
                let longPressT = null;
                // 每个区域独立 lastTap，避免左/右区连击串扰误触发对侧 seek
                const handle = (zone, delta) => {
                    let lastTap = 0;
                    zone.addEventListener('click', () => {
                        const now = Date.now();
                        if (now - lastTap < 300) { this.session.seekBy(delta); this._feedback(delta > 0 ? '⏩ +' + delta + 's' : '⏪ ' + delta + 's'); lastTap = 0; }
                        else { lastTap = now; this._wake(); }
                    });
                };
                handle(this._zoneL, -10); handle(this._zoneR, 10);
                // 长按 3x 快进
                const startLong = () => { longPressT = setTimeout(() => { this._savedRate = this.speed.rate; this.speed.set(3); this._feedback('⏩ 3x 快进中'); }, 1000); };
                const cancelLong = () => { if (longPressT) { clearTimeout(longPressT); longPressT = null; } if (this._savedRate) { this.speed.set(this._savedRate); this._savedRate = null; } };
                this._zoneR.addEventListener('mousedown', startLong); this._zoneR.addEventListener('mouseup', cancelLong);
                this._zoneR.addEventListener('touchstart', startLong); this._zoneR.addEventListener('touchend', cancelLong);
            }
            _onCtrlClick(e) {
                const t = e.target.closest('[data-act]'); if (!t) return;
                const act = t.dataset.act;
                this._wake();
                if (act === 'play') { if (this.video.paused) this.video.play().catch(() => { }); else this.video.pause(); }
                else if (act === 'back') this.session.seekBy(-10);
                else if (act === 'fwd') this.session.seekBy(10);
                else if (act === 'mute') { this.video.muted = !this.video.muted; t.textContent = this.video.muted ? '🔇' : '🔊'; }
                else if (act === 'rate') { this._rateMenu.classList.toggle('show'); this._rateMenuOpen = !this._rateMenuOpen; this._updateRateMenu(); }
                else if (act === 'rotate') this.rotation.toggle();
                else if (act === 'lock') { this._locked = !this._locked; this._lock.classList.toggle('show', this._locked); }
                else if (act === 'fs') this._toggleFullscreen();
            }
            _toggleFullscreen() {
                const wrap = this._wrap;
                try {
                    if (document.fullscreenElement) document.exitFullscreen();
                    else wrap.requestFullscreen && wrap.requestFullscreen();
                } catch (e) { }
            }
            _updateRateMenu() {
                const cur = this.speed.rate;
                this._rateMenu.querySelectorAll('[data-rate]').forEach(d => {
                    d.classList.toggle('active', Math.abs(parseFloat(d.dataset.rate) - cur) < 0.01);
                });
            }
            _updateVolFill(ratio) {
                const fill = this._ctrl.querySelector('.va-vol-fill');
                if (fill) fill.style.width = (ratio * 100) + '%';
            }
            _onProgress() {
                const v = this.video;
                const cur = this._ctrl.querySelector('.va-cur'), dur = this._ctrl.querySelector('.va-dur');
                const played = this._ctrl.querySelector('.va-played'), buffered = this._ctrl.querySelector('.va-buffered'), thumb = this._ctrl.querySelector('.va-thumb');
                cur.textContent = this._fmt(v.currentTime);
                if (isFinite(v.duration) && v.duration > 0) {
                    dur.textContent = this._fmt(v.duration);
                    const pct = (v.currentTime / v.duration) * 100;
                    played.style.width = pct + '%'; thumb.style.left = pct + '%';
                } else { dur.textContent = '直播'; played.style.width = '0%'; thumb.style.left = '0%'; }
                // 多段 buffered 渲染（取覆盖当前进度的一段简化）
                if (v.buffered.length) {
                    let end = 0;
                    for (let i = 0; i < v.buffered.length; i++) {
                        if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) { end = v.buffered.end(i); break; }
                    }
                    if (end && isFinite(v.duration) && v.duration > 0) buffered.style.width = (end / v.duration) * 100 + '%';
                }
            }
            _fmt(s) { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; }
            _setPlayBtn(t) { const b = this._ctrl.querySelector('[data-act=play]'); if (b) b.textContent = t; }
            _feedback(msg) { this._centerFb.textContent = msg; this._centerFb.classList.add('show'); clearTimeout(this._fbT); this._fbT = setTimeout(() => this._centerFb.classList.remove('show'), 700); }
            _wake() { this._ctrl.classList.remove('va-hidden'); this._topBar.classList.remove('va-hidden'); this._autoHide(3000); }
            _autoHide(ms) { clearTimeout(this._hideTimer); this._hideTimer = setTimeout(() => { if (!this.video.paused) { this._ctrl.classList.add('va-hidden'); this._topBar.classList.add('va-hidden'); } }, ms); }
            show() { this._ctrl.classList.remove('va-hidden'); this._topBar.classList.remove('va-hidden'); }
            destroy() {
                this.speed.destroy();
                clearTimeout(this._hideTimer); clearTimeout(this._fbT);
                // 移除 window 级拖拽监听器，避免泄漏
                try {
                    if (this._onProgMove) window.removeEventListener('mousemove', this._onProgMove);
                    if (this._onVolMove) window.removeEventListener('mousemove', this._onVolMove);
                    if (this._onUp) window.removeEventListener('mouseup', this._onUp);
                } catch (e) { }
                // 将 video 移回原位，移除 wrap
                try {
                    const host = this.session.takeover.host;
                    const wrap = this._wrap;
                    const video = this.video;
                    if (wrap && wrap.contains(video)) {
                        // 恢复 video 原样式（旋转/尺寸）
                        video.style.transform = ''; video.style.width = ''; video.style.height = '';
                        video.style.position = ''; video.style.left = ''; video.style.top = '';
                        if (host && host.parentNode) host.parentNode.insertBefore(video, host);
                    }
                    if (wrap && wrap.parentNode) wrap.remove();
                } catch (e) { }
            }
        }

        // KeyboardController：快捷键（仅在接管态且视频/控件聚焦或全屏时生效，避免劫持全页按键）
        class KeyboardController {
            constructor(session) {
                this.session = session; this.video = session.video;
                this._hovered = false;
                this._onKey = (e) => this._handle(e);
                document.addEventListener('keydown', this._onKey, true);
            }
            setHover(v) { this._hovered = !!v; }
            _active() {
                if (!CFG.keyboard || !this.session.takeover || !this.session.takeover.enabled) return false;
                // 全屏中、鼠标悬停播放器、或 video 为当前焦点时生效
                const fs = document.fullscreenElement;
                const inOurFs = fs && this.session.takeover.wrap && this.session.takeover.wrap.contains(fs);
                const focused = document.activeElement === this.video;
                return inOurFs || this._hovered || focused;
            }
            _handle(e) {
                if (!this._active()) return;
                // 避免在输入框中触发
                const tag = (e.target && e.target.tagName) || '';
                if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
                const v = this.video;
                const controls = this.session.controls;
                const key = e.key;
                if (key === ' ') { e.preventDefault(); if (v.paused) v.play().catch(() => { }); else v.pause(); }
                else if (key === 'ArrowLeft') { e.preventDefault(); this.session.seekBy(e.shiftKey ? -30 : -5); }
                else if (key === 'ArrowRight') { e.preventDefault(); this.session.seekBy(e.shiftKey ? 30 : 5); }
                else if (key === 'j' || key === 'J') { e.preventDefault(); this.session.seekBy(-10); }
                else if (key === 'l' || key === 'L') { e.preventDefault(); this.session.seekBy(10); }
                else if (key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); if (controls) controls._updateVolFill(v.volume); }
                else if (key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); if (controls) controls._updateVolFill(v.volume); }
                else if (key === 'm' || key === 'M') { e.preventDefault(); v.muted = !v.muted; }
                else if (key === '[') { e.preventDefault(); if (controls) controls.speed.step(-1); }
                else if (key === ']') { e.preventDefault(); if (controls) controls.speed.step(1); }
                else if (key === 'r' || key === 'R') { e.preventDefault(); if (controls) controls.rotation.toggle(); }
                else if (key === 'f' || key === 'F') { e.preventDefault(); if (controls) controls._toggleFullscreen(); }
                else if (key === 'p' || key === 'P') { e.preventDefault(); try { if (document.pictureInPictureElement) document.exitPictureInPicture(); else v.requestPictureInPicture && v.requestPictureInPicture(); } catch (e2) { } }
                else if (key === 'Escape') { /* 浏览器自动处理全屏退出 */ }
                else if (/^[0-9]$/.test(key)) { e.preventDefault(); if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration * (parseInt(key) / 10); }
            }
            destroy() { document.removeEventListener('keydown', this._onKey, true); }
        }

        // ExtractPlayer：提取播放弹窗（仅 http(s) 直接 src）
        class ExtractPlayer {
            constructor(session) { this.session = session; this.video = session.video; this._modal = null; }
            canExtract() {
                const src = this.video.currentSrc || this.video.src || '';
                return src.indexOf('http') === 0 && src.indexOf('blob:') !== 0;
            }
            open() {
                if (!this.canExtract()) { this.session.notify('MSE/blob 视频无法提取，已使用覆盖模式'); return; }
                if (this._modal) return;
                const src = this.video.currentSrc || this.video.src;
                const modal = document.createElement('div');
                modal.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;';
                const nv = document.createElement('video');
                nv.src = src; nv.style.cssText = 'max-width:95vw;max-height:90vh;';
                nv.currentTime = this.video.currentTime; nv.volume = this.video.volume; nv.playbackRate = this.video.playbackRate;
                modal.appendChild(nv);
                const closeBtn = document.createElement('button');
                closeBtn.textContent = '✕ 关闭';
                closeBtn.style.cssText = 'position:fixed;top:20px;right:20px;padding:10px 16px;background:rgba(255,255,255,0.15);color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;';
                closeBtn.onclick = () => this.close();
                modal.appendChild(closeBtn);
                document.body.appendChild(modal);
                this._modal = modal; this._nv = nv;
                try { nv.play().catch(() => { }); } catch (e) { }
            }
            close() {
                if (!this._modal) return;
                try { this.video.currentTime = this._nv.currentTime; } catch (e) { }
                this._modal.remove(); this._modal = null; this._nv = null;
            }
        }

        // PlayerTakeoverController：接管决策
        class PlayerTakeoverController {
            constructor(session) {
                this.session = session; this.video = session.video;
                this.enabled = false; this.wrap = null; this.controls = null; this.kb = null; this.extract = null;
                this.host = null;
            }
            enable() {
                if (this.enabled) return;
                if (CFG.takeoverMode === 'accel-only') return;
                const src = this.video.currentSrc || this.video.src || '';
                if (CFG.takeoverMode === 'extract' && src.indexOf('http') === 0 && src.indexOf('blob:') !== 0) {
                    this.extract = new ExtractPlayer(this.session); this.extract.open(); this.enabled = true; return;
                }
                // overlay 模式
                this._buildOverlay();
                this.enabled = true;
            }
            _buildOverlay() {
                const host = document.createElement('div');
                host.id = 'va-player-host-' + this.session.id;
                host.style.cssText = 'position: relative; width: 100%; height: 100%; z-index: 2147483547;';
                const root = host.attachShadow({ mode: 'closed' });
                const style = document.createElement('style'); style.textContent = PlayerSkin.css; root.appendChild(style);
                this.host = host; this.root = root;

                // 插入到 video 父级，使 video 可移入 wrap
                const parent = this.video.parentElement || document.body;
                parent.appendChild(host);

                this.controls = new CustomPlayerControls(this.session);
                this.kb = new KeyboardController(this.session);
                this.session.controls = this.controls;
                // 鼠标悬停播放器区域时激活快捷键，离开时关闭，避免劫持页面其余按键
                if (this.controls._wrap) {
                    this.controls._wrap.addEventListener('mouseenter', () => { if (this.kb) this.kb.setHover(true); });
                    this.controls._wrap.addEventListener('mouseleave', () => { if (this.kb) this.kb.setHover(false); });
                }
                Bridge.send('takeover', { takeover: true });
            }
            disable() {
                if (!this.enabled) return;
                if (this.extract) { this.extract.close(); this.extract = null; }
                if (this.controls) { this.controls.destroy(); this.controls = null; }
                if (this.kb) { this.kb.destroy(); this.kb = null; }
                if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
                this.host = null; this.wrap = null;
                this.enabled = false;
                Bridge.send('takeover', { takeover: false });
            }
            openExtract() { if (!this.extract) this.extract = new ExtractPlayer(this.session); this.extract.open(); }
        }

        // ============================================================
        // 【VideoSession】单视频生命周期
        // ============================================================
        let sessionCounter = 0;
        const _allSessions = new Set();
        class VideoSession {
            constructor(video) {
                this.id = ++sessionCounter;
                this.video = video;
                this.type = PlayerTypeDetector.detect(video);
                this.recoveries = 0; this._adSkipped = 0; this._dead = false;
                this._lastBufReport = 0; this._lastBufVal = -1;
                video.__vaSession = this;
                _allSessions.add(this);

                PreloadAccelerator.apply(video, this.type);

                this.buffer = new BufferManager(this);
                this.seek = new SeekGuard(this);
                this.stall = new StallRecoveryWatchdog(this);
                this.adgate = new AdGateBypass(this);
                this.takeover = new PlayerTakeoverController(this);
                this.controls = null;

                this.buffer.watch();
                this.adgate.start();

                // 默认接管（overlay 模式）
                try { this.takeover.enable(); } catch (e) { }

                this._report();
            }
            _report() {
                Bridge.send('session', {
                    status: this.video.paused ? '空闲' : '播放中',
                    playerType: this.type, buffer: this.buffer.bufferAhead(this.video),
                    recoveries: this.recoveries, adSkipped: this._adSkipped,
                    takeover: this.takeover.enabled, rate: this.video.playbackRate
                });
            }
            reportBuffer(ahead) {
                const now = Date.now();
                if (this._lastBufReport && now - this._lastBufReport < 1500 && Math.abs(this._lastBufVal - ahead) < 1) return;
                this._lastBufReport = now; this._lastBufVal = ahead;
                const v = this.video;
                Bridge.send('state', { buffer: ahead, status: v.paused ? '已暂停' : '播放中' });
            }
            seekBy(delta) {
                const v = this.video;
                if (!isFinite(v.duration) || v.duration <= 0) return; // 直播流不支持 seek
                const target = Math.max(0, Math.min(v.duration, v.currentTime + delta));
                v.currentTime = target;
            }
            emergencyLoad() {
                const info = PlayerRegistry.get(this.video);
                try { if (info && info.type === 'hls' && info.player) info.player.startLoad(); else this.video.load(); } catch (e) { }
            }
            boostLoad() {
                const info = PlayerRegistry.get(this.video);
                if (info && info.type === 'hls' && info.player) { try { info.player.startLoad(this.video.currentTime); } catch (e) { } }
            }
            trimBackBuffer(seconds) {
                const info = PlayerRegistry.get(this.video);
                if (info && info.type === 'hls' && info.player && info.player.config) { try { info.player.config.backBufferLength = seconds; } catch (e) { } }
            }
            softRecover() {
                this.recoveries++;
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) { try { info.player.startLoad(this.video.currentTime); } catch (e) { this.video.load(); } }
                    else this.video.load();
                    if (CFG.autoPlay) this.video.play().catch(() => { });
                } catch (e) { }
                this._report();
            }
            engineRecover() {
                this.recoveries++;
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) { try { info.player.recoverMediaError(); } catch (e) { try { info.player.startLoad(this.video.currentTime); } catch (e2) { } } }
                    else if (info && info.type === 'dash' && info.player) { info.player.seek(this.video.currentTime); info.player.play(); }
                    else { this.video.currentTime = this.video.currentTime; this.video.load(); }
                    if (CFG.autoPlay) this.video.play().catch(() => { });
                } catch (e) { }
                this._report();
            }
            downgradeQuality() {
                const info = PlayerRegistry.get(this.video);
                try {
                    if (info && info.type === 'hls' && info.player) {
                        const cur = info.player.currentLevel;
                        if (cur > 0) { info.player.nextLevel = cur - 1; this.notify('自动降一档画质以保持流畅'); }
                    } else if (info && info.type === 'dash' && info.player) {
                        const cur = info.player.getQualityFor && info.player.getQualityFor('video');
                        if (cur > 0) { info.player.setQualityFor('video', cur - 1); this.notify('自动降一档画质以保持流畅'); }
                    }
                } catch (e) { }
            }
            rebuildVideoElement() {
                this.recoveries++;
                const old = this.video;
                try {
                    const wasTakeover = this.takeover.enabled;
                    if (wasTakeover) this.takeover.disable();
                    const clone = old.cloneNode(false);
                    const ctx = { currentTime: old.currentTime, volume: old.volume, muted: old.muted, playbackRate: old.playbackRate, loop: old.loop, crossorigin: old.crossOrigin };
                    const info = PlayerRegistry.get(old);
                    if (info && info.type === 'hls' && info.player) { try { info.player.destroy(); } catch (e) { } }
                    if (old.parentNode) old.parentNode.replaceChild(clone, old);
                    try { delete old.__vaSession; } catch (e) { }
                    clone.currentTime = ctx.currentTime; clone.volume = ctx.volume; clone.muted = ctx.muted;
                    clone.playbackRate = ctx.playbackRate; clone.loop = ctx.loop;
                    if (ctx.crossorigin) clone.crossOrigin = ctx.crossorigin;

                    if (info && info.type === 'hls' && window.Hls && window.Hls.isSupported()) {
                        const hls = new window.Hls();
                        hls.attachMedia(clone);
                        hls.on(window.Hls.Events.MANIFEST_PARSED, () => { clone.currentTime = ctx.currentTime; if (CFG.autoPlay) clone.play().catch(() => { }); });
                        PlayerRegistry.set(clone, { type: 'hls', player: hls });
                    } else if (info && info.type === 'native') {
                        clone.load(); if (CFG.autoPlay) clone.play().catch(() => { });
                    }

                    this.seek.destroy(); this.stall.destroy(); this.buffer.stop(); this.adgate.stop();
                    this.video = clone;
                    this.type = info ? info.type : PlayerTypeDetector.detect(clone);
                    this.seek = new SeekGuard(this); this.stall = new StallRecoveryWatchdog(this);
                    this.buffer = new BufferManager(this); this.adgate = new AdGateBypass(this);
                    this.takeover = new PlayerTakeoverController(this);
                    this.buffer.watch(); this.adgate.start();
                    clone.__vaSession = this;
                    VideoDiscoveryEngine._seen.add(clone);
                    if (wasTakeover) { try { this.takeover.enable(); } catch (e) { } }
                    this.notify('视频元素已自动重建');
                } catch (e) { this.notify('元素重建失败，请手动重载'); }
                this._report();
            }
            adSkipped() { this._adSkipped++; Bridge.send('adSkip', { count: this._adSkipped }); }
            notify(msg) { Bridge.send('notify', { msg }); }
            destroy() {
                this._dead = true; _allSessions.delete(this);
                try { this.seek.destroy(); } catch (e) { }
                try { this.stall.destroy(); } catch (e) { }
                try { this.buffer.stop(); } catch (e) { }
                try { this.adgate.stop(); } catch (e) { }
                try { this.takeover.disable(); } catch (e) { }
                try { delete this.video.__vaSession; } catch (e) { }
            }
        }

        // ============ VideoDiscoveryEngine ============
        const VideoDiscoveryEngine = {
            _seen: new WeakSet(),
            _observer: null,
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
                setTimeout(() => {
                    if (!this._hasAnyVideo()) {
                        const container = document.querySelector(PROFILE.containerSel || 'body');
                        if (container) LazyInitUnlocker.forceInit(container);
                    }
                }, 5000);
            },
            _hasAnyVideo() { return !!document.querySelector('video'); },
            _scanAll() { this._scanWithin(document.documentElement); },
            _scanWithin(root) {
                try { root.querySelectorAll && root.querySelectorAll('video').forEach(v => this._takeOver(v)); } catch (e) { }
                try {
                    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
                    for (const el of all) { if (el.shadowRoot) this._scanWithin(el.shadowRoot); }
                } catch (e) { }
            },
            _takeOver(video) {
                if (this._seen.has(video)) return;
                this._seen.add(video);
                if (video.__vaSession) return;
                try { new VideoSession(video); } catch (e) { }
                try {
                    new MutationObserver(() => { const s = video.__vaSession; if (s) s.type = PlayerTypeDetector.detect(video); })
                        .observe(video, { attributes: true, attributeFilter: ['src', 'data-src', 'data-video', 'data-lazy-src'] });
                } catch (e) { }
            }
        };

        // ============ HealthMonitor ============
        const HealthMonitor = {
            _iv: null,
            start() {
                this._iv = setInterval(() => this._patrol(), 3000);
                document.addEventListener('visibilitychange', () => { if (!document.hidden) this._patrol(); });
                window.addEventListener('popstate', () => setTimeout(() => VideoDiscoveryEngine._scanAll(), 500));
                window.addEventListener('hashchange', () => setTimeout(() => VideoDiscoveryEngine._scanAll(), 500));
            },
            _patrol() {
                if (document.hidden) return;
                _allSessions.forEach(s => {
                    const v = s.video;
                    if (!v || s._dead) { _allSessions.delete(s); return; }
                    if (!document.documentElement.contains(v)) { s.destroy(); return; }
                    if (performance.memory && performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit > 0.9) { try { s.trimBackBuffer(30); } catch (e) { } }
                });
            }
        };

        // ============ 指令处理 ============
        Bridge.on('configUpdate', (cfg) => { Object.assign(CFG, cfg); });
        Bridge.on('reload', () => {
            _allSessions.forEach(s => { try { s.video.load(); if (CFG.autoPlay) s.video.play().catch(() => { }); s._report(); } catch (e) { } });
        });
        Bridge.on('recover', () => { _allSessions.forEach(s => s.engineRecover()); });
        Bridge.on('downgrade', () => { _allSessions.forEach(s => s.downgradeQuality()); });

        // ============ 启动 ============
        installIOHook();
        installFetchPriority();
        installHlsHook();
        VideoDiscoveryEngine.init();
        HealthMonitor.start();
        Bridge.send('ready', { host: location.hostname });
    }

    // ============================================================
    // 【沙箱世界】注入页面引擎 + 启动 UI
    // ============================================================
    function injectPageWorld() {
        const cfg = ConfigStore.load();
        const script = document.createElement('script');
        script.textContent = '(' + pageEngine.toString() + ')(' + JSON.stringify(cfg) + ');';
        try { (document.head || document.documentElement).appendChild(script); }
        catch (e) { setTimeout(() => { try { (document.head || document.documentElement).appendChild(script); } catch (e2) { } }, 0); }
        script.remove();
    }

    let ui;
    function boot() {
        ui = new UIManager();
        MessageBridge.init((detail) => {
            const { evt, payload } = detail;
            if (evt === 'ready') { ui && ui.toast('视频加速引擎已就绪', 'ok'); }
            else if (evt === 'notify') { ui && ui.toast(payload.msg, 'warn'); }
            else if (evt === 'session' || evt === 'state') { ui && ui.update(payload || {}); }
            else if (evt === 'adSkip') { ui && ui.update({ adSkipped: payload.count }); }
            else if (evt === 'takeover') { ui && ui.update({ takeover: payload.takeover }); }
            else if (evt === 'rateChange') { ui && ui.update({ rate: payload.rate }); }
        });
        injectPageWorld();
        try {
            GM_registerMenuCommand('🎬 视频加速控制台', () => ui.toggle());
            GM_registerMenuCommand('⚡ 强制重载当前视频', () => MessageBridge.send('reload'));
            GM_registerMenuCommand('🔧 手动恢复播放', () => MessageBridge.send('recover'));
            GM_registerMenuCommand('📉 降低画质', () => MessageBridge.send('downgrade'));
        } catch (e) { }
    }

    boot();
})();
