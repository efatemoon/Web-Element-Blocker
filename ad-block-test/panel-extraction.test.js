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

/**
 * v8.6 iframe 防线修复回归守卫
 * 守卫不变量：
 *  1) 无效的白名单功能已从 iframe 面板彻底删除（WhitelistStore 不再被引用）。
 *  2) 面板「拦截选中」对 iframe 帧必须写入持久 iframeBlock 规则，刷新后自动拦截，
 *     且能被「管理规则与防御策略」统一列出/删除/禁用。
 *  3) 管理面板确实消费 getIframeBlocks() 并归类为 iframeBlock，证明 iframe 规则被集中管理。
 */
describe('iframe 防线修复回归守卫 (v8.6)', () => {
    it('iframe 白名单已从 IframePanel 完全移除（无效功能删除）', () => {
        // 用户反馈：白名单完全无效（ProtectedCheck 从不查白名单，面板手动拦截直穿）。
        // 删除后应无任何白名单 UI / 逻辑残留于 iframe 面板。
        const iframePanel = content.slice(content.indexOf('function IframePanel()'));
        expect(iframePanel).not.toContain('btn-protect-iframe');
        expect(iframePanel).not.toContain('iframe-wl-list');
        expect(iframePanel).not.toContain('renderWlList');
        // 已删除的 WhitelistStore 模块不得在 iframe 面板代码区域被引用
        expect(iframePanel).not.toContain('WhitelistStore');
    });

    it('拦截选中 iframe 帧时写入持久 iframeBlock 规则（刷新持续生效 + 进入管理面板）', () => {
        // 回归：旧实现仅 BlockEngine.hideElement(iframe) + rec.blocked=true（都在内存，刷新即丢失，
        // 也不出现在「管理规则与防御策略」）。新实现对跨域 iframe 写入 srcDomain 持久规则。
        const iframePanel = content.slice(content.indexOf('function IframePanel()'));
        expect(iframePanel).toContain('storage.addIframeRule({ matchType: \'srcDomain\', value: u.hostname })');
        // 不再依赖内存态 rec.blocked 作为唯一拦截手段（仍设置，但规则已持久）
        expect(iframePanel).toContain('IframeGuard._incStat(\'blocked\')');
        // 提示文案说明已写入持久规则、可在管理面板统一管理
        expect(iframePanel).toContain('已写入持久规则');
        expect(iframePanel).toContain('管理规则与防御策略');
    });

    it('管理面板（管理规则与防御策略）消费 iframeBlock 规则并集中管理', () => {
        // 守卫：iframe 防线的拦截规则必须出现在「管理规则与防御策略」列表中（可读/删除/禁用），
        // 否则用户无法统一管理。getIframeBlocks() 返回的规则需被 buildRecords 归类为 iframeBlock。
        const managerPanel = content.slice(content.indexOf('function ManagerPanel()'));
        expect(managerPanel).toContain('this.storage.getIframeBlocks().forEach');
        expect(managerPanel).toContain("type: 'iframeBlock'");
        // 删除/禁用按钮对 iframeBlock 走独立 API（rescanAll 即时生效），证明可管理
        expect(content).toContain('this.storage.removeIframeRule(index)');
        expect(content).toContain('this.storage.toggleIframeRuleDisabled(index)');
    });
});

