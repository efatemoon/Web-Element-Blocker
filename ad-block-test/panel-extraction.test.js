/**
 * Phase B 面板物理抽离契约测试（god-module 切片回归守卫）
 *
 * 守卫不变量：9 个面板已从 UIManager 抽离为独立顶层函数模块，
 * UIManager 仅保留 `return XPanel.call(this)` 分派桩，退化为协调器。
 * 若有人把面板体重新内联回类方法，本测试应失败。
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);
const lines = content.split('\n');

const PANELS = [
    'Selection', 'GlobalDomain', 'Regex', 'Iframe', 'Manager',
    'Export', 'AdGuardExport', 'OverlayScan', 'Import'
];

describe('Phase B Panel Extraction (god-module slice)', () => {
    it('defines 9 top-level panel modules outside UIManager', () => {
        PANELS.forEach(name => {
            const re = new RegExp('^    function ' + name + 'Panel\\(\\) \\{$');
            const defined = lines.some(l => re.test(l));
            expect(defined).toBe(true);
        });
    });

    it('wires each panel as a delegation stub inside UIManager', () => {
        PANELS.forEach(name => {
            expect(content).toContain('return ' + name + 'Panel.call(this);');
        });
    });

    it('each top-level panel module is non-empty (real body, not a stub)', () => {
        PANELS.forEach(name => {
            const re = new RegExp('^    function ' + name + 'Panel\\(\\) \\{$');
            const start = lines.findIndex(l => re.test(l));
            expect(start).toBeGreaterThan(-1);
            // 函数体应至少含有一行 this.* 调用或声明，而非立即闭合
            const body = lines.slice(start + 1, start + 6).join('\n');
            expect(body).toMatch(/this\./);
        });
    });

    it('PanelRegistry maps all 9 keys to the corresponding UIManager method', () => {
        const expected = {
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
        Object.entries(expected).forEach(([key, method]) => {
            expect(content).toContain("        " + key + ": '" + method + "'");
        });
    });
});

/**
 * Phase C/D 隐藏缺陷回归守卫（v8.5 修复）
 * 守卫不变量：抽取/端口化过程引入或遗留的运行时缺陷不得回潮。
 */
describe('Hidden-defect regression guards (v8.5)', () => {
    it('IframePanel binds the list click listener ONCE outside render() (guards listener leak)', () => {
        // 旧实现：renderScanList() 每次重渲染都对复用节点 list 重新 addEventListener，
        // 导致监听器指数级累积、面板卡死。
        // 新实现（与 OverlayScanPanel 一致）：面板创建时一次性绑定在 #iframe-list 容器上，
        // 渲染只替换子节点，不存在重复绑定。
        expect(content).toContain("panel.querySelector('#iframe-list').addEventListener('click'");
        expect(content).not.toContain('if (!list._scanClickBound)');
    });

    it('OverlayScanEngine.scan honors root scope (no silent full-document scan)', () => {
        // 回归：scan(root, options) 契约——调用方传入的 root 子树作用域必须被尊重，
        // 旧实现忽略 root 始终扫描顶层 document，是潜性的契约破裂。
        expect(content).toMatch(/function scan\(root, options\) \{/);
        expect(content).toContain('const scope = (root && typeof root.querySelectorAll ===');
        expect(content).toContain('scope.querySelectorAll(QUICK_SEL)');
    });

    it('no dead _navBlocked accumulator (unbounded memory leak removed)', () => {
        // 回归：_navBlocked 累加器从不被读取/清空，长会话无限增长。仅允许出现在解释性注释中。
        const codeRefs = lines.filter(l => /_navBlocked/.test(l) && !/^\s*\/\//.test(l));
        expect(codeRefs.length).toBe(0);
    });
});
