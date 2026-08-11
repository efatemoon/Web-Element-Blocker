/**
 * PanelRegistry 契约测试（OCP 接缝 / DI 可注入）
 *
 * PanelRegistry 是 UI 层与具体面板方法之间的纯映射表，天然可测试、可替换。
 * 验证：9 个面板 key 全部映射到非空方法名；MENU_ITEMS 的每个 key 均能解析。
 * 参考：xUnit Test Patterns（Test Double / 纯函数契约）；Martin《敏捷软件开发》OCP。
 */
const { PanelRegistry, MENU_ITEMS } = require('../web-element-blocker.user.js');

describe('PanelRegistry（OCP 接缝）', () => {
    const EXPECTED = {
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

    test('9 个面板 key 全部映射到预期的 UIManager 方法名', () => {
        expect(Object.keys(PanelRegistry)).toHaveLength(9);
        Object.entries(EXPECTED).forEach(([key, method]) => {
            expect(PanelRegistry[key]).toBe(method);
        });
    });

    test('MENU_ITEMS 的每个 key 都能在 PanelRegistry 解析（新增面板 = 注册一行）', () => {
        MENU_ITEMS.forEach(([, , key]) => {
            expect(typeof PanelRegistry[key]).toBe('string');
            expect(PanelRegistry[key].length).toBeGreaterThan(0);
        });
    });

    test('PanelRegistry 不含未登记的多余/空 key', () => {
        Object.values(PanelRegistry).forEach(method => {
            expect(typeof method).toBe('string');
            expect(method).not.toBe('');
        });
    });
});
