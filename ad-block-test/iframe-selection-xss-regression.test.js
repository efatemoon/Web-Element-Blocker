/**
 * iframe 选择上下文（BUG-Y2）+ 管理面板 XSS（BUG-XSS）回归守卫
 *
 * 守卫不变量：
 *  - BUG-Y2：_handleClick / _handleTouchEnd 必须在 this.stopSelection() 之前捕获同源 iframe 上下文，
 *    并透传给 showActionPanel；否则 iframe 内选中元素会被判"已失效"且规则落到外层 host（刷新后广告复活）。
 *  - BUG-XSS：ManagerPanel 渲染 iframeBlock 规则时，matchType 的未知回退值必须 escapeHTML，
 *    否则导入恶意 matchType 造成存储型 XSS。
 * 与 panel-extraction.test.js 同属"内容契约守卫"，用于阻止缺陷回潮。
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

describe('BUG-Y2: iframe 选择上下文在 stopSelection 前捕获', () => {
    it('_handleClick 捕获 iframeCtx 并透传给 showActionPanel', () => {
        // 捕获点存在（早于 stopSelection 使用）
        expect(content).toContain('const iframeCtx = this._selectionIframeContext || null;');
        // 透传：点击路径的 showActionPanel 必须带上下文参数（G1 后改为 effectiveCtx 降级透传）
        expect(content).toContain('this.showActionPanel(e.target, effectiveCtx);');
    });

    it('_handleTouchEnd 同样在 stopSelection 前捕获并透传上下文（G1 后改为 effectiveCtxT）', () => {
        expect(content).toContain('this.showActionPanel(target, effectiveCtxT);');
    });

    it('showActionPanel 签名接收 iframeCtx，ctxHost 取自 iframeCtx.host', () => {
        expect(content).toContain('showActionPanel(element, iframeCtx) {');
        expect(content).toContain('const ctxHost = iframeCtx ? iframeCtx.host : null;');
    });

    it('旧版 BUG-Y2 写法已移除（直接读取已被清空的 _selectionIframeContext.iframe.src）', () => {
        expect(content).not.toContain(
            'const ctxHost = this._selectionIframeContext ? safeURLHostname(this._selectionIframeContext.iframe.src) : null;'
        );
    });

    it('iframe 上下文对象携带已解析的 host（srcdoc 回退父页 host）', () => {
        expect(content).toContain('host: iframeHost');
    });

    it('iframe 进入分支去重，避免重复注册帧内监听', () => {
        expect(content).toContain('if (iframeCtx && iframeCtx.iframe === targetIframe) return;');
    });

    it('srcdoc/无 src 同源 iframe 也能进入上下文（不再要求 iframeSrc 非空）', () => {
        expect(content).toContain('const iframeHost = iframeSrc ? safeURLHostname(iframeSrc) : window.location.hostname;');
        expect(content).not.toContain('if (iframeDoc && iframeSrc) {');
    });

    it('_isElementInDOM 回退链优先 ctx > 动作面板上下文 > 选择模式上下文', () => {
        // 兼容 stopSelection 后判定 iframe 内元素：显式 ctx 优先，其次动作面板持久化的
        // _actionIframeContext（stopSelection 清空 _selectionIframeContext 后的唯一可用来源），
        // 最后才是 _selectionIframeContext。
        expect(content).toContain('const c = ctx || this._actionIframeContext || this._selectionIframeContext;');
        expect(content).toContain('this._actionIframeContext = iframeCtx || null;');
    });
});

describe('BUG-XSS: 管理面板 iframeBlock.matchType 转义', () => {
    it('iframeBlock 分支对回退 matchType 做 escapeHTML，杜绝存储型 XSS', () => {
        expect(content).toContain('escapeHTML(r.matchType)');
    });

    it('旧版未转义回退（: r.matchType)) 已不存在', () => {
        expect(content).not.toContain(': r.matchType));');
    });

    it('value 始终 escapeHTML（与 matchType 同口径）', () => {
        // 该分支返回的模板必须同时转义 r.value
        const branch = content.slice(content.indexOf("case 'iframeBlock':"), content.indexOf("case 'complex':"));
        expect(branch).toContain('escapeHTML(r.value ||');
    });
});

describe('BUG-Y3: 全局域名面板深度扫描须同步实时预览', () => {
    it('深度扫描自动勾选新域名后调用 updateGlobalPreview()', () => {
        // 在深度扫描回调区间内（自动勾选循环 → 完成 toast）应同时出现 renderDomains 与 updateGlobalPreview
        const deepRegion = content.slice(
            content.indexOf('selectedHosts.add(d.host)'),
            content.indexOf('深度扫描完成，域名列表已刷新')
        );
        expect(deepRegion).toContain('renderDomains();');
        expect(deepRegion).toContain('updateGlobalPreview();');
    });
});

describe('BUG-Y4: 管理面板撤销恢复 domainBlock 保留元数据', () => {
    it('撤销 domainBlock 时保留 _ts 与 _disabled', () => {
        expect(content).toContain('_ts: it.rule._ts');
        expect(content).toContain('_disabled: it.rule._disabled');
    });
});

describe('BUG-Y5: 积木"包含"大小写口径与正则面板一致', () => {
    it('evaluateConditions 的 contains / not_contains 走 toLowerCase 比较', () => {
        expect(content).toContain("(val.toLowerCase()).includes((c.value || '').toLowerCase())");
        expect(content).toContain("!(val.toLowerCase()).includes((c.value || '').toLowerCase())");
    });
});

describe('BUG-Y6: 覆盖层面板重扫/深度扫描期间预览竞态', () => {
    it('rescan 在异步扫描完成后按原预览状态重新应用预览（旧版误调用未定义的 updateOverlayPreview，已修复为 restoreOverlayPreview）', () => {
        expect(content).toContain('runScan(false, { deep: false }).then(() => {');
        expect(content).toContain('if (wasPreview) restoreOverlayPreview();');
    });
    it('深度扫描同样在扫描完成后复原预览态（旧版静默丢弃预览）', () => {
        expect(content).toContain('runScan(false, { deep: true }).then(ok => {');
        // 深度扫描与重新扫描各一处，共 2 处 restoreOverlayPreview 调用
        expect(content.split('if (wasPreview) restoreOverlayPreview();').length - 1).toBe(2);
    });
    it('已彻底移除对未定义函数 updateOverlayPreview 的调用', () => {
        // 仅允许出现在修复说明注释中，不允许出现函数调用语句 updateOverlayPreview();
        expect(content).not.toContain('updateOverlayPreview();');
    });
    it('restoreOverlayPreview 已定义并按 updatePreview 口径重建预览', () => {
        expect(content).toContain('const restoreOverlayPreview = () => {');
        expect(content).toContain('this._overlayPreview = { active: true, elements: [], hiddenDomains: new Set() };');
        expect(content).toContain('this._showPreviewBanner(() => resetOverlayPreview());');
        expect(content).toContain('updatePreview();');
    });
});

describe('BUG-Y7: 选择面板拦截按钮须先校验元素存活', () => {
    it('btn-static / btn-dynamic / btn-struct 均先 _isElementInDOM 校验', () => {
        const guard = 'if (!this._isElementInDOM(this.currentSelectedEl, iframeCtx)) {';
        const count = content.split(guard).length - 1;
        expect(count).toBeGreaterThanOrEqual(3);
    });
});

describe('G1: 进入 iframe 上下文后点击主文档元素须能打开动作面板（上下文降级）', () => {
    it('_handleClick 非 iframe 路径按 iframeCtx.doc.contains 降级上下文，透传 effectiveCtx', () => {
        // 降级判定：若记录的 iframe 上下文并不包含点击目标，则降级为顶层文档上下文
        expect(content).toContain('const _inCtx = (iframeCtx && iframeCtx.doc && iframeCtx.doc.contains(e.target));');
        expect(content).toContain('const effectiveCtx = _inCtx ? iframeCtx : null;');
        // 校验与展示动作面板均使用降级后的 effectiveCtx，而非原始 iframeCtx
        expect(content).toContain('if (!this._isElementInDOM(e.target, effectiveCtx))');
        expect(content).toContain('this.showActionPanel(e.target, effectiveCtx);');
    });

    it('_handleTouchEnd 同样降级上下文，透传 effectiveCtxT', () => {
        expect(content).toContain('const _inCtxT = (iframeCtx && iframeCtx.doc && iframeCtx.doc.contains(target));');
        expect(content).toContain('const effectiveCtxT = _inCtxT ? iframeCtx : null;');
        expect(content).toContain('if (!this._isElementInDOM(target, effectiveCtxT))');
        expect(content).toContain('this.showActionPanel(target, effectiveCtxT);');
    });

    it('上下文降级根因：_isElementInDOM 显式 ctx 会回退到选择模式上下文，故 raw iframeCtx 不可直接透传', () => {
        // 回退链：ctx || _actionIframeContext || _selectionIframeContext。
        // 若透传 raw iframeCtx（且 stopSelection 已清空 _selectionIframeContext），_isElementInDOM
        // 会拿 iframeCtx.doc.contains(主文档元素) → false → 误判"已失效"，动作面板打不开。
        expect(content).toContain('const c = ctx || this._actionIframeContext || this._selectionIframeContext;');
    });
});

describe('G2: 错误边界须解除选择态（导航冻结 / 文档监听）', () => {
    it('_showErrorPanel 在清空面板前调用 stopSelection，避免渲染异常后页面无法跳转', () => {
        // stopSelection 解除 _freezeNavigation 劫持并注销 _trackDoc 注册的 document 级监听
        const re = /this\.stopSelection\(\);\s*this\.shadowRoot\.innerHTML = '';/;
        expect(re.test(content)).toBe(true);
    });
});

