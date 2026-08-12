/**
 * 积木（complex）规则条件求值回归测试
 *
 * 覆盖本轮发现并修复的两类隐藏 bug：
 *   FIX-A：not_contains 在目标属性为空（如元素无 class/id）时误返回 false，
 *          导致 AND 规则在「classless / id-less」元素上漏匹配（应为 true，空值恒不含有 X）
 *   FIX-C：class equals 原用整串 className 字符串比较（"header nav" === "header" → false），
 *          多 class 元素永远无法命中 equals 规则；改为按独立 class 词元精确匹配
 *
 * 抽取产物内真实的 evaluateConditions 方法源码做单元回归（行为等价、不重实现）。
 */
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

// 平衡括号抽取指定「方法签名」的真实源码（首个匹配，即 RegexEngine 内的真实实现）
function extractMethod(sig) {
    const start = SOURCE.indexOf(sig);
    if (start === -1) return null;
    let i = SOURCE.indexOf('{', start);
    let depth = 0;
    for (; i < SOURCE.length; i++) {
        if (SOURCE[i] === '{') depth++;
        else if (SOURCE[i] === '}') {
            depth--;
            if (depth === 0) return SOURCE.slice(start, i + 1);
        }
    }
    return null;
}

describe('积木规则条件求值（evaluateConditions）', () => {
    let evaluateConditions;
    beforeAll(() => {
        const src = extractMethod('evaluateConditions(conditions, logic, el) {');
        expect(src).not.toBeNull();
        evaluateConditions = new Function('function ' + src + '\nreturn evaluateConditions;')();
    });

    // ── FIX-C：class equals 必须按词元匹配，多 class 元素应命中 ──
    test('FIX-C: class equals 命中多 class 元素中的某个词元', () => {
        const el = { className: 'header nav', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'header' }], 'AND', el)).toBe(true);
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'nav' }], 'AND', el)).toBe(true);
    });

    test('FIX-C: class equals 子串（非词元）不应误命中', () => {
        const el = { className: 'site-header', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'header' }], 'AND', el)).toBe(false);
        const el2 = { className: 'header-nav', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'header' }], 'AND', el2)).toBe(false);
    });

    test('FIX-C: class equals 单 class 元素保持原行为', () => {
        const el = { className: 'promo', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'promo' }], 'AND', el)).toBe(true);
        expect(evaluateConditions([{ type: 'class', operator: 'equals', value: 'ads' }], 'AND', el)).toBe(false);
    });

    // ── FIX-A：not_contains 对空属性应返回 true（空值恒不含有 X）──
    test('FIX-A: class not_contains 对无 class 的元素返回 true（原误返回 false）', () => {
        const el = { className: '', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'class', operator: 'not_contains', value: 'promo' }], 'AND', el)).toBe(true);
    });

    test('FIX-A: id not_contains 对无 id 的元素返回 true（原误返回 false）', () => {
        const el = { className: '', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'id', operator: 'not_contains', value: 'ad' }], 'AND', el)).toBe(true);
    });

    test('FIX-A: text not_contains 对空文本返回 true（原误返回 false）', () => {
        const el = { className: '', id: '', textContent: '' };
        expect(evaluateConditions([{ type: 'text', operator: 'not_contains', value: '广告' }], 'AND', el)).toBe(true);
    });

    // ── 行为保持：contains 仍为词元子串匹配，不破坏既有规则 ──
    test('class contains 保留子串匹配语义（promo-banner 命中 promo，普通词不误命中）', () => {
        expect(evaluateConditions([{ type: 'class', operator: 'contains', value: 'promo' }], 'AND', { className: 'promo-banner' })).toBe(true);
        expect(evaluateConditions([{ type: 'class', operator: 'contains', value: 'promo' }], 'AND', { className: 'header' })).toBe(false);
        expect(evaluateConditions([{ type: 'class', operator: 'contains', value: 'nav' }], 'AND', { className: 'header nav' })).toBe(true);
    });

    test('not_contains 真实命中时返回 false，且不影响正常 AND 组合', () => {
        const el = { className: 'promo-banner', id: '', textContent: '广告' };
        expect(evaluateConditions([{ type: 'class', operator: 'not_contains', value: 'promo' }], 'AND', el)).toBe(false);
        // AND：class 不含有 x 且 text 含有 广告 → 应命中（classless 元素也能正确参与）
        const el2 = { className: '', id: '', textContent: '这是广告' };
        expect(evaluateConditions([
            { type: 'class', operator: 'not_contains', value: 'promo' },
            { type: 'text', operator: 'contains', value: '广告' }
        ], 'AND', el2)).toBe(true);
    });

    // ── 基线回归：text / id 的三种算子 ──
    test('text / id 算子基线行为不变', () => {
        const el = { className: '', id: 'main-ads', textContent: '欢迎光临' };
        expect(evaluateConditions([{ type: 'text', operator: 'contains', value: '欢迎' }], 'AND', el)).toBe(true);
        expect(evaluateConditions([{ type: 'text', operator: 'equals', value: '欢迎光临' }], 'AND', el)).toBe(true);
        expect(evaluateConditions([{ type: 'id', operator: 'contains', value: 'ads' }], 'AND', el)).toBe(true);
        expect(evaluateConditions([{ type: 'id', operator: 'equals', value: 'main-ads' }], 'AND', el)).toBe(true);
    });

    // ── AND / OR 聚合 ──
    test('AND 全真为真、OR 一真即为真', () => {
        const el = { className: 'header', id: 'x', textContent: '广告推荐' };
        const andCond = [
            { type: 'class', operator: 'equals', value: 'header' },
            { type: 'text', operator: 'contains', value: '广告' }
        ];
        expect(evaluateConditions(andCond, 'AND', el)).toBe(true);
        expect(evaluateConditions([
            { type: 'class', operator: 'equals', value: 'footer' }, // 假
            { type: 'text', operator: 'contains', value: '广告' }
        ], 'AND', el)).toBe(false);
        expect(evaluateConditions([
            { type: 'class', operator: 'equals', value: 'footer' }, // 假
            { type: 'text', operator: 'contains', value: '广告' }  // 真
        ], 'OR', el)).toBe(true);
    });
});
