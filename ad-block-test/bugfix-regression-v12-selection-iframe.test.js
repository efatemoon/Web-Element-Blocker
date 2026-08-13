/**
 * v12.0 选择模式（iframe 上下文）隐藏 bug 修复回归守卫
 *
 * 本轮聚焦前几轮未覆盖的「手动选择屏蔽元素」面板：用户从同源 iframe 内选中广告元素后，
 * 动作面板（showActionPanel）的「彻底封杀域名」「预览效果」「放大层级」等路径会错误判定
 * 元素为"已从页面移除"而中止操作——根因是 stopSelection() 已清空 this._selectionIframeContext，
 * 而这些路径未拿到透传的 iframeCtx，也没在动作面板生命周期内持久化 iframe 上下文。
 *
 * 守卫不变量：同源 iframe 内选中的元素，动作面板全生命周期内判定存活、可封杀、可预览。
 *
 *   BUG-S1(a) showActionPanel 未把 iframeCtx 持久化到实例（stopSelection 已清 _selectionIframeContext）
 *   BUG-S1(b) btn-domain 的 _isElementInDOM 漏传 iframeCtx → 点"彻底封杀域名"误判元素失效而中止
 *   BUG-S1(c) btn-preview 的 _isElementInDOM 漏传 iframeCtx → 点"预览效果"误判元素失效而中止
 *   BUG-S1(d) _isElementInDOM 回退链未含 _actionIframeContext → _resetActionPreview/_applyActionPreviewHiding/zoom-in 对 iframe 元素失效
 *   BUG-S1(e) stopSelection 未清空 _actionIframeContext → 残留旧 iframe 上下文污染下次选择
 *
 * 展示修复 D1：导出 / AdGuard 文本框无高度上限，规则量大时复制/下载按钮被顶出可视区。
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

const sliceBetween = (startAnchor, endAnchor) => {
    const s = content.indexOf(startAnchor);
    expect(s).toBeGreaterThan(-1);
    const e = content.indexOf(endAnchor, s);
    return content.slice(s, e === -1 ? content.length : e);
};

const ap = sliceBetween('showActionPanel(element, iframeCtx) {', 'showGlobalDomainPanel() {');
const im = sliceBetween('        _isElementInDOM(el, ctx) {', '        _applySelectionHighlight(element) {');
const ss = sliceBetween('        stopSelection() {', '        _trackDoc(type, handler, opts) {');

describe('BUG-S1(a) 动作面板持久化 iframe 上下文', () => {
    it('showActionPanel 把 iframeCtx 持久化到 this._actionIframeContext', () => {
        // 关键：stopSelection 已清空 _selectionIframeContext，动作面板子方法若只依赖它，
        // 同源 iframe 内元素会被误判失效。此处必须把上下文存到独立字段。
        expect(ap).toContain('this._actionIframeContext = iframeCtx || null;');
    });
});

describe('BUG-S1(b) 彻底封杀域名按钮传入 iframeCtx', () => {
    it('btn-domain 的 _isElementInDOM 调用带 iframeCtx', () => {
        // 旧实现：this._isElementInDOM(this.currentSelectedEl) 缺 ctx → iframe 元素误判"已移除"而中止封杀
        // 与 btn-static/dynamic/struct 口径一致，必须带 iframeCtx
        expect(ap).toContain('this._isElementInDOM(this.currentSelectedEl, iframeCtx)');
        // 旧的错误写法不应再出现（不带 ctx 的那一版）
        expect(ap).not.toMatch(/this\._isElementInDOM\(this\.currentSelectedEl\)\s*\)\s*\{\s*\n\s*this\.showToast\('目标元素已从页面移除/);
    });
});

describe('BUG-S1(c) 预览效果按钮传入 iframeCtx', () => {
    it('btn-preview 的 _isElementInDOM 调用带 iframeCtx', () => {
        expect(ap).toContain('this._isElementInDOM(el, iframeCtx)');
    });
});

describe('BUG-S1(d) _isElementInDOM 回退链含动作面板上下文', () => {
    it('优先 ctx > 动作面板上下文 > 选择模式上下文', () => {
        expect(im).toContain('const c = ctx || this._actionIframeContext || this._selectionIframeContext;');
    });
});

describe('BUG-S1(e) stopSelection 清空动作面板上下文', () => {
    it('stopSelection 末尾重置 this._actionIframeContext = null', () => {
        expect(ss).toContain('this._actionIframeContext = null;');
    });
});

describe('D1 导出文本框限高，按钮常驻可见', () => {
    it('injectStyles 含导出文本框 max-height 上限', () => {
        expect(content).toContain('textarea.export-box, textarea#export-text { max-height: 50vh; }');
    });
});
