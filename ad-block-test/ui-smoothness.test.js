/**
 * UI 丝滑优化 · 结构锁回归测试
 * 校验 v3.4.4 引入的面板开关动画 / 列表行级过渡 / 筛选去抖 关键标记存在，
 * 防止后续重构误删。动画为纯 CSS/DOM 时序，无法在 node 环境做真实渲染断言，故用源码锁。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '../web-element-blocker.user.js'), 'utf8');

describe('UI 丝滑优化（面板动画 + 列表过渡 + 筛选去抖）', () => {
    test('injectStyles 含面板入场/退场 keyframes 与退场类', () => {
        expect(SRC).toMatch(/@keyframes pro-panel-in/);
        expect(SRC).toMatch(/@keyframes pro-panel-out/);
        expect(SRC).toMatch(/\.panel\.pro-panel-closing/);
    });

    test('injectStyles 含列表行级过渡（pro-row-in）', () => {
        expect(SRC).toMatch(/@keyframes pro-row-in/);
        expect(SRC).toMatch(/\.gd-domain-row, \.rule-item \{ animation: pro-row-in/);
    });

    test('injectStyles 尊重 prefers-reduced-motion（关闭动画）', () => {
        expect(SRC).toMatch(/prefers-reduced-motion: reduce/);
    });

    test('clearPanel 对当前面板加退场类并延时移除（交叉淡入）', () => {
        expect(SRC).toMatch(/\.panel:not\(\.pro-panel-closing\)/);
        expect(SRC).toMatch(/classList\.add\('pro-panel-closing'\)/);
    });

    test('全局域名面板筛选输入已去抖（debounce 120ms）', () => {
        expect(SRC).toContain("panel.querySelector('#gd-filter').addEventListener('input', debounce(");
        expect(SRC).toMatch(/debounce\(\([\s\S]*?\}, 120\)/);
    });
});
