// 加载真实 video-accelerator.user.js 到 jsdom，导出内部类用于功能测试。
// 仅用于本地功能核查，不影响发布文件。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FILE = path.resolve(__dirname, '..', 'video-accelerator.user.js');
let src = fs.readFileSync(FILE, 'utf8');

// 在 IIFE 末尾导出内部类（注入点 = 最后一个 `})();`）
const inject = `
    try {
        globalThis.__VA_EXPORTS__ = {
            VERSION, clamp, isVideoResource, isLive, isVisible, videoArea, getHost,
            VA_TUNING, VA_BUFFER, ConfigManager, SessionManager, CandidateArbiter,
            VideoSession, UIManager, RecoveryOrchestrator, Detector, Scheduler,
            Bus, FrameMesh, Logger, Storage, estimateBandwidth, tryPlay
        };
    } catch (e) { globalThis.__VA_EXPORT_ERR__ = String(e && e.stack || e); }
`;
const idx = src.lastIndexOf('})();');
if (idx < 0) throw new Error('注入点未找到');
src = src.slice(0, idx) + inject + '\n' + src.slice(idx);

// ---- 构建 jsdom 环境 ----
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
});
const win = dom.window;

// GM_* 存储 stub
const store = {};
const GM = {
    setValue: (k, v) => { store[k] = (typeof v === 'string') ? v : JSON.stringify(v); },
    getValue: (k, d) => (k in store ? store[k] : d),
    registerMenuCommand: () => {},
    deleteValue: (k) => { delete store[k]; }
};

// 暴露为全局自由变量（Tampermonkey 在注入时提供）
global.window = win;
global.document = win.document;
global.unsafeWindow = win;
global.location = win.location;
global.GM_setValue = GM.setValue;
global.GM_getValue = GM.getValue;
global.GM_registerMenuCommand = GM.registerMenuCommand;
global.GM_deleteValue = GM.deleteValue;
global.navigator = win.navigator;
global.requestAnimationFrame = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout;
if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
global.matchMedia = win.matchMedia;
if (typeof win.requestVideoFrameCallback === 'undefined') {
    win.HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) { return setTimeout(() => cb({ mediaTime: 0, presentedFrames: 0 }, 16)); };
    win.HTMLVideoElement.prototype.cancelVideoFrameCallback = function () {};
}
// HTMLMediaElement 关键属性/方法 stub（jsdom 不实现播放）
if (!win.HTMLMediaElement.prototype.play) win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
if (!win.HTMLMediaElement.prototype.pause) win.HTMLMediaElement.prototype.pause = function () {};
if (typeof win.HTMLMediaElement.prototype.load === 'undefined') win.HTMLMediaElement.prototype.load = function () {};

// 执行真实文件（在严格模式下 eval，捕获启动错误）
let loadErr = null;
try {
    // 用 Function 在全局作用域执行；文件内 free vars 已挂到 global
    const runner = new Function(src);
    runner();
} catch (e) {
    loadErr = e;
}

const vaExports = global.__VA_EXPORTS__;
const exportErr = global.__VA_EXPORT_ERR__;

if (loadErr) {
    console.log('LOAD_THROW:', loadErr && loadErr.stack ? loadErr.stack.split('\n').slice(0, 6).join('\n') : loadErr);
    process.exit(2);
}
if (exportErr) {
    console.log('EXPORT_ERR:', exportErr.split('\n').slice(0, 6).join('\n'));
    process.exit(3);
}
if (!vaExports) {
    console.log('NO_EXPORTS (likely early return for non-top frame or load failed silently)');
    process.exit(4);
}
console.log('BOOT_OK keys:', Object.keys(vaExports).join(', '));
module.exports = { vaExports, win, store, dom };
