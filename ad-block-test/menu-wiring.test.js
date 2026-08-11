/**
 * GM 菜单链路 UI 契约测试（关闭 TD-08 / T5 的 0% 覆盖缺口）
 *
 * 直接对抽离的纯函数 _buildMenu + MENU_ITEMS 做契约断言，无需构建管线。
 * 菜单项现以「面板 key」表达，经 PanelRegistry 解析为 UIManager 方法（OCP 接缝），
 * 新增第 10 个面板 = 注册表加一行 + MENU_ITEMS 加一项，分派逻辑零改动。
 * 参考：xUnit Test Patterns（可测缝）；Martin《敏捷软件开发》OCP；Fowler《重构》Ch.7。
 */
const { MENU_ITEMS, _buildMenu, PanelRegistry } = require('../web-element-blocker.user.js');

describe('GM 菜单注册链路（TD-08 / T5）', () => {
    test('MENU_ITEMS 含 9 项，每项结构为 [label, title, key]，key 均可在 PanelRegistry 解析', () => {
        expect(Array.isArray(MENU_ITEMS)).toBe(true);
        expect(MENU_ITEMS).toHaveLength(9);
        MENU_ITEMS.forEach(([label, title, key]) => {
            expect(typeof label).toBe('string');
            expect(typeof title).toBe('string');
            expect(typeof key).toBe('string');
            expect(typeof PanelRegistry[key]).toBe('string'); // OCP：key → 方法名
        });
    });

    test('全部 9 个菜单项注册到 register，且点击回调经 PanelRegistry 分派到正确的 UIManager 方法', () => {
        const registered = [];
        const fakeUI = { _safeCall: (title, fn) => fn() };
        // 为每个被解析出的方法名准备桩：DI 测试替身
        MENU_ITEMS.forEach(([, , key]) => { fakeUI[PanelRegistry[key]] = jest.fn(); });

        _buildMenu((label, cb) => registered.push({ label, cb }), () => fakeUI);

        expect(registered).toHaveLength(9);
        registered.forEach((r, i) => {
            const key = MENU_ITEMS[i][2];
            const method = PanelRegistry[key];
            expect(r.label).toBe(MENU_ITEMS[i][0]);
            r.cb(); // 模拟用户点击菜单项
            expect(fakeUI[method]).toHaveBeenCalledTimes(1);
        });
    });

    test('_safeCall 错误边界：handler 抛错时回调不向外冒泡', () => {
        const registered = [];
        const boom = new Error('boom');
        const fakeUI = {
            _safeCall: (title, fn) => { try { fn(); } catch (e) { /* 模拟错误面板，吞掉 */ } },
            startSelection: () => { throw boom; }
        };
        _buildMenu((label, cb) => registered.push({ label, cb }), () => fakeUI);
        expect(() => registered[0].cb()).not.toThrow();
    });
});
