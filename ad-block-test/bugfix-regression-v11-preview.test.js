/**
 * v11.0 面板交互 / 展示隐藏缺陷修复回归守卫
 *
 * 本轮基于「MENU_ITEMS 驱动的架构全景 + 预览态生命周期契约」逐面板审查，
 * 修复 8 处隐藏缺陷。守卫不变量：以下修复不得回潮。
 *
 *   BUG-G1  GlobalDomainPanel 列表重绘丢失 scrollTop，长列表勾选一次跳回顶部
 *   BUG-G2  GlobalDomainPanel 深度扫描异步回调缺面板存活守卫，面板关闭后仍渲染并弹 Toast
 *   BUG-G3  GlobalDomainPanel 来源字段未转义，未知来源键可注入标记
 *   BUG-G4  GlobalDomainPanel 深度扫描自动补勾覆盖用户手动取消的域名
 *   BUG-R1  RegexPanel 零命中仍进入预览态，按钮文案与横幅与实际不符
 *   BUG-I1  IframePanel 重扫/深扫未还原预览，隐藏集与选中集脱节且污染冻结几何测量
 *   BUG-I2  IframePanel blockedFingerprints 只写不读的死代码
 *   BUG-I3  IframePanel 列表重绘丢失 scrollTop
 *   BUG-M1  showConfirm 正文折叠换行，多行确认信息挤成一行
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

/** 取两个锚点之间的代码区段，避免 not.toContain 误伤后续面板 */
const sliceBetween = (startAnchor, endAnchor) => {
    const s = content.indexOf(startAnchor);
    expect(s).toBeGreaterThan(-1);
    const e = content.indexOf(endAnchor, s);
    return content.slice(s, e === -1 ? content.length : e);
};

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const gd = sliceBetween('function GlobalDomainPanel()', 'function RegexPanel()');
const rp = sliceBetween('function RegexPanel()', 'function IframePanel()');
const ip = sliceBetween('function IframePanel()', 'function ManagerPanel()');
const mp = sliceBetween('function ManagerPanel()', 'function ExportPanel()');
const op = sliceBetween('function OverlayScanPanel()', 'function ImportPanel()');

describe('BUG-G1 / BUG-I3 列表重绘保持滚动位置', () => {
    it('GlobalDomainPanel.renderDomains 渲染前后保存并回填 scrollTop', () => {
        // 回归：box.innerHTML = ... 会把 scrollTop 复位为 0，
        // 用户在长列表中勾选一项后视口跳回顶部，无法连续勾选。
        expect(gd).toContain('const prevScroll = box.scrollTop;');
        expect(gd).toContain('box.scrollTop = prevScroll;');
    });

    it('IframePanel.render 渲染前后保存并回填 scrollTop', () => {
        // iframe 列表 max-height:320px 必然出现滚动，同因同修。
        expect(ip).toContain('const prevScroll = box.scrollTop;');
        expect(ip).toContain('box.scrollTop = prevScroll;');
    });

    it('OverlayScanPanel.render 渲染前后保存并回填 scrollTop', () => {
        expect(op).toContain('const prevScroll = box.scrollTop;');
        expect(op).toContain('box.scrollTop = prevScroll;');
    });

    it('ManagerPanel.renderList 对真正的滚动容器（ul 的父级）保存并回填 scrollTop', () => {
        // 关键：#mgr-list 是 <ul>，自身无 overflow；滚动容器是父级 .selection-info。
        // 若误取 list.scrollTop 则恒为 0，修复无效。
        expect(mp).toContain('const scroller = list.parentElement;');
        expect(mp).toContain('const prevScroll = scroller ? scroller.scrollTop : 0;');
        expect(mp).toContain('if (scroller) scroller.scrollTop = prevScroll;');
    });
});

describe('BUG-G2 深度扫描异步回调的面板存活守卫', () => {
    it('runDeep 入口即判断 panel.isConnected', () => {
        // 回归：runDeep 经 requestIdleCallback / setTimeout 延迟执行，
        // 期间用户可能已 clearPanel，旧实现仍会 renderDomains + updateGlobalPreview + showToast。
        expect(gd).toMatch(/const runDeep = \(\) => \{[\s\S]{0,400}?if \(!panel\.isConnected\) return;/);
    });
});

describe('BUG-G3 域名来源字段转义', () => {
    it('来源字段经 escapeHTML 输出', () => {
        expect(gd).toContain('来源：${escapeHTML(sources)}');
        // 旧的裸插值不应再出现
        expect(gd).not.toContain('来源：${sources}');
    });
});

describe('BUG-G4 深度扫描不得覆盖用户手动取消的勾选', () => {
    it('存在 manuallyDeselected 集合记录显式意图', () => {
        expect(gd).toContain('const manuallyDeselected = new Set();');
    });

    it('行点击取消勾选时写入 manuallyDeselected，重新勾选时移除', () => {
        expect(gd).toContain('selectedHosts.delete(host); manuallyDeselected.add(host);');
        expect(gd).toContain('selectedHosts.add(host); manuallyDeselected.delete(host);');
    });

    it('"清空"按钮把当前选中项全部记入 manuallyDeselected', () => {
        expect(gd).toContain('selectedHosts.forEach(h => manuallyDeselected.add(h));');
    });

    it('深度扫描自动补勾时跳过 manuallyDeselected', () => {
        // 回归：旧实现无条件 selectedHosts.add(d.host)，用户取消勾选的高分域被静默勾回，
        // 预览与最终封杀名单出现用户未察觉的差异。
        expect(gd).toMatch(/!selectedHosts\.has\(d\.host\) && !manuallyDeselected\.has\(d\.host\)/);
    });
});

describe('BUG-R1 RegexPanel 零命中不得进入预览态', () => {
    it('存在统一的 enterPreview 命中校验入口', () => {
        expect(rp).toContain('const enterPreview = (btn) => {');
        expect(rp).toContain('if (this._previewAffectedElements.length === 0)');
    });

    it('path / attribute / builder+contains+regex 三条分支均走 enterPreview', () => {
        expect(countOf(rp, 'enterPreview(btn);')).toBe(3);
    });

    it('isPreviewing 只在 enterPreview 内部置位，不存在旁路', () => {
        // 回归：旧实现 attribute 与 builder/contains/regex 分支直接置 isPreviewing = true，
        // 0 命中也会弹预览横幅并把按钮改成"👁 恢复显示"。
        expect(countOf(rp, 'isPreviewing = true;')).toBe(1);
    });
});

describe('BUG-I1 IframePanel 重扫 / 深扫的预览态收敛', () => {
    it('存在共用的 enterPreview 执行器', () => {
        expect(ip).toContain('const enterPreview = () => {');
    });

    it('深度扫描与重新扫描均先记录 wasPreview 并 resetPreview', () => {
        expect(countOf(ip, 'const wasPreview = this._iframePreview.active;')).toBe(2);
    });

    it('扫描完成后按新的选中集重建预览', () => {
        // 回归：旧实现扫描后 records 重建、selectedSet 重置，
        // 但预览态仍为 active 且隐藏的是旧元素；同时 display:none 的 iframe
        // 会污染 IframeGuard 的冻结几何测量导致重新分类失真。
        expect(countOf(ip, 'if (wasPreview) enterPreview();')).toBe(2);
    });
});

describe('BUG-I2 IframePanel 死代码清除', () => {
    it('不再声明只写不读的 blockedFingerprints WeakSet', () => {
        expect(ip).not.toContain('const blockedFingerprints = new WeakSet();');
        expect(ip).not.toContain('blockedFingerprints.add(iframe);');
    });

    it('不再对帧内元素调用恒为 null 的 closest(iframe)', () => {
        expect(ip).not.toContain("const targetIframe = elRec.el?.closest('iframe');");
    });

    it('OverlayScanPanel 中同名但有效的 blockedFingerprints 未被误删', () => {
        // 覆盖层面板的 Set 版本是真正被读取的（fingerprintOf 指纹回填），必须保留。
        expect(content).toContain('let blockedFingerprints = new Set();');
        expect(content).toContain('blockedFingerprints.has(fingerprintOf(r))');
    });
});

describe('BUG-M1 确认弹窗保留换行', () => {
    it('pro-confirm-body 使用 pre-wrap 保留 \\n', () => {
        // 回归：showConfirm 以 DIV 渲染 escapeHTML(message)，默认 white-space 折叠换行，
        // 封杀域名确认框里的域名列表全部挤成一行，批量删除提示的空行也消失。
        expect(content).toContain('class="pro-confirm-body" style="white-space:pre-wrap;"');
    });
});
