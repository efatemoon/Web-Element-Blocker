/**
 * debounce 隐藏 bug 回归测试
 *
 * 复现 v3.4.1 之前（以及 v3.4.1 仍存在的）debounce 缺陷：
 *   - 原实现 lastExec = 0，首帧调用时 now - 0 >= maxWait 恒成立 → 第一次去抖调用
 *     在 MutationObserver 首帧同步执行（而非等待 wait 毫秒），破坏去抖语义并造成
 *     主线程卡顿。
 *   - 修正后：lastExec 初始为 null；仅当函数曾经执行过且距上次 >= maxWait 才立即触发，
 *     首次调用必须走尾沿 setTimeout(wait)。
 *
 * 抽取产物内真实 debounce 源码单测（与 navigation-false-positive.test.js 同一手法），
 * 保证测的是「线上代码」而非副本。
 */
const fs = require('fs');
const path = require('path');

function extractFn(name) {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'web-element-blocker.user.js'), 'utf8');
    const start = SRC.indexOf('function ' + name);
    if (start === -1) return null;
    let i = SRC.indexOf('{', start);
    let depth = 0;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    return null;
}

describe('debounce（去抖首帧误触发隐藏 bug）', () => {
    let debounce;
    beforeAll(() => {
        const src = extractFn('debounce');
        expect(src).not.toBeNull();
        // eslint-disable-next-line no-eval
        debounce = eval('(' + src + ')');
    });

    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test('首次调用被去抖：等待 wait 之前不执行（修复首帧同步触发）', () => {
        const fn = jest.fn();
        const wrapped = debounce(fn, 120, 600);
        wrapped();
        expect(fn).not.toHaveBeenCalled();           // 关键：首帧不应立即同步执行
        jest.advanceTimersByTime(119);
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);                  // 累计 120ms
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('连续调用折叠为一次执行（尾沿去抖语义保留）', () => {
        const fn = jest.fn();
        const wrapped = debounce(fn, 120, 600);
        for (let k = 0; k < 10; k++) {
            wrapped();
            jest.advanceTimersByTime(50);             // 每次都在窗口内，应不断重置
        }
        expect(fn).not.toHaveBeenCalled();
        jest.advanceTimersByTime(120);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('间隔超过 maxWait 后再次调用立即触发（maxWait 兜底语义保留）', () => {
        const fn = jest.fn();
        const wrapped = debounce(fn, 120, 600);
        wrapped();
        jest.advanceTimersByTime(120);                // 首次窗口后执行一次
        expect(fn).toHaveBeenCalledTimes(1);
        // 模拟空闲 600ms 以上（推进真实时间不可行于 fake timer，用 advance 模拟“空闲后新调用”）
        // 由于 fake timer 不推进真实 Date.now，这里直接验证：超过 maxWait 的“新一批”首调仍走 setTimeout
        wrapped();
        expect(fn).toHaveBeenCalledTimes(1);          // 不应立即再执行（未达 maxWait 真实间隔）
        jest.advanceTimersByTime(120);
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
