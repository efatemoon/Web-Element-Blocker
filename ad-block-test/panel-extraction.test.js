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
