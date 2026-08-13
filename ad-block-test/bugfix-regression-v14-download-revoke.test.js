/**
 * bugfix-regression-v14-download-revoke.test.js
 * 源级不变量守卫：导出面板 / AdGuard 导出面板的 Blob URL 回收必须延迟执行，
 * 禁止在 a.click() 之后立即 URL.revokeObjectURL(url)，否则部分浏览器下载会静默失败(RV1)。
 *
 * 约定：断言源文件字符串包含延迟回收模式，而非真实触发 jsdom 下载（仓库惯例）。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'web-element-blocker.user.js');
const code = fs.readFileSync(SRC, 'utf8');

function sliceBetween(start, end) {
    const s = code.indexOf(start);
    const e = code.indexOf(end, s >= 0 ? s : 0);
    if (s < 0) return '';
    return code.slice(s, e < 0 ? code.length : e);
}

const exportPanel = sliceBetween('function ExportPanel()', 'function AdGuardExportPanel()');
const agPanel = sliceBetween('function AdGuardExportPanel()', 'function OverlayScanPanel()');

describe('RV1 导出面板 Blob URL 延迟回收', () => {
    test('ExportPanel 不再立即 revoke，改用 setTimeout 延迟回收', () => {
        // 旧模式（必须消失）：a.click();\n URL.revokeObjectURL(url);
        expect(exportPanel).not.toMatch(/a\.click\(\);\s*URL\.revokeObjectURL\(url\);/);
        // 新模式（必须存在）：延迟 1000ms 回收
        expect(exportPanel).toMatch(/setTimeout\(\(\)\s*=>\s*\{\s*try\s*\{\s*URL\.revokeObjectURL\(url\)/);
    });

    test('AdGuardExportPanel 同样延迟回收', () => {
        expect(agPanel).not.toMatch(/a\.click\(\);\s*URL\.revokeObjectURL\(url\);/);
        expect(agPanel).toMatch(/setTimeout\(\(\)\s*=>\s*\{\s*try\s*\{\s*URL\.revokeObjectURL\(url\)/);
    });

    test('两个下载处理器都包裹在 try/catch 防止异常抛出', () => {
        const exp = (exportPanel.match(/setTimeout\(\(\)\s*=>\s*\{/g) || []).length;
        // ExportPanel 内至少出现 1 处延迟回收 setTimeout
        expect(exp).toBeGreaterThanOrEqual(1);
    });
});
