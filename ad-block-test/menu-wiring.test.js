/**
 * GM 菜单链路 UI 契约测试（关闭 TD-08 / T5 的 0% 覆盖缺口）
 *
 * 直接对抽离的纯函数 _buildMenu + MENU_ITEMS 做契约断言，无需构建管线。
 * 参考：xUnit Test Patterns（可测缝）；Fowler《重构》Ch.7 消除重复模板。
 */
const { MENU_ITEMS, _buildMenu } = require('../web-element-blocker.user.js');

describe('GM 菜单注册链路（TD-08 / T5）', () => {
    test('MENU_ITEMS 含 9 项，每项结构为 [label, title, method]', () => {
        expect(Array.isArray(MENU_ITEMS)).toBe(true);
        expect(MENU_ITEMS).toHaveLength(9);
        MENU_ITEMS.forEach(([label, title, method]) => {
            expect(typeof label).toBe('string');
            expect(typeof title).toBe('string');
            expect(typeof method).toBe('string');
        });
    });

    test('全部 9 个菜单项注册到 register，且点击回调分派到正确的 UIManager 方法', () => {
        const registered = [];
        const fakeUI = { _safeCall: (title, fn) => fn() };
        MENU_ITEMS.forEach(([, , method]) => { fakeUI[method] = jest.fn(); });

        _buildMenu((label, cb) => registered.push({ label, cb }), () => fakeUI);

        expect(registered).toHaveLength(9);
        registered.forEach((r, i) => {
            expect(r.label).toBe(MENU_ITEMS[i][0]);
            // 模拟用户点击菜单项
            r.cb();
            expect(fakeUI[MENU_ITEMS[i][2]]).toHaveBeenCalledTimes(1);
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
