/**
 * v10.0 第二轮深度扫描隐藏缺陷修复回归守卫
 *
 * 守卫不变量：以下 5 处隐藏 bug 修复不得回潮（在 v9.0 六处修复之外的第二轮深挖）。
 * 每个用例对应 web-element-blocker.user.js 中一次具体的隐藏 bug 修复：
 *   FIX-A  自身 UI 保护 split(',') 破坏 :is()/:has() 括号层级，父级隐藏规则全部静默失效（CRITICAL）
 *   FIX-B  GlobalDomainPanel 深度扫描合并时 g.hostname 未小写/未空守护，导致重复统计与整页预览误伤
 *   FIX-C  _showErrorPanel 清空 shadowRoot 前未回收拖拽监听，document 级 mousemove/mouseup 永久泄漏
 *   FIX-D  v1.0 导出 AdGuard 规则未补全 type 字段，convertRule 返回 null 致全部站点规则丢失
 *   FIX-E  RegexPanel 预览 builder/regex 分支缺 try/catch，畸形选择器/遍历异常抛错致 UI 状态不一致
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

const slicePanel = (name) => content.slice(content.indexOf('function ' + name + 'Panel()'));

describe('v10.0 自身 UI 保护：括号感知的顶层逗号拆分（CRITICAL）', () => {
    it('FIX-A: 引入 splitTopLevelCommas，替换会破坏 :is()/:has() 的 s.split(","）', () => {
        expect(content).toContain('const splitTopLevelCommas = (s) => {');
        // 旧的危险写法（naive s.split(',')）不应再出现于 SELF_PROTECT 应用处
        expect(content).not.toContain('return s.split(\',\').map(part => part.trim() + SELF_PROTECT).join(\', \');');
    });

    it('FIX-A 行为：顶层逗号才分割，:is()/:has() 内部逗号保持完整', () => {
        const startIdx = content.indexOf('const splitTopLevelCommas = (s) => {');
        const endIdx = content.indexOf('};', startIdx);
        const fnText = content.slice(startIdx, endIdx + 2)
            .replace('const splitTopLevelCommas =', '')
            .replace(/;\s*$/, '');
        const splitTopLevelCommas = eval('(' + fnText + ')');

        // 普通多通道选择器：顶层逗号应正常拆分
        const plain = splitTopLevelCommas('[src*="a"], [href*="a"]');
        expect(plain.length).toBe(2);
        expect(plain[0].trim()).toBe('[src*="a"]');

        // :is() 内部逗号必须被括号层级吞掉，整体作为单条返回
        const nested = splitTopLevelCommas('*:has(> :is([src*="a"], [href*="a"], [src*="b"]))');
        expect(nested.length).toBe(1);
        expect(nested[0]).toBe('*:has(> :is([src*="a"], [href*="a"], [src*="b"]))');

        // 更深嵌套：三层括号中的逗号也不应被拆开
        const deep = splitTopLevelCommas('a:is(b, :not(c, d))');
        expect(deep.length).toBe(1);
    });
});

describe('v10.0 GlobalDomainPanel 深度扫描合并守卫', () => {
    const panel = slicePanel('GlobalDomain');

    it('FIX-B: 合并 GDS 结果时 g.hostname 统一小写 + 空守护，避免重复/整页误伤', () => {
        // 回归：旧实现直接用 g.hostname（大小写敏感、可能为空），
        // 与 existingMap（已小写）不匹配导致重复统计；空 host 经 buildDomainAttr 生成 [src*=""] 误伤整页。
        expect(panel).toContain("(g.hostname || '').toLowerCase()");
        // 旧的裸 g.hostname 不应再出现于过滤/查找/构造三处
        const bareCount = (panel.match(/currentBlocked\.has\(g\.hostname\)/g) || []).length
            + (panel.match(/existingMap\.get\(g\.hostname\)/g) || []).length
            + (panel.match(/host: g\.hostname,/g) || []).length;
        expect(bareCount).toBe(0);
    });
});

describe('v10.0 错误兜底面板监听泄漏守卫', () => {
    it('FIX-C: _showErrorPanel 清空 shadowRoot 前回收当前面板拖拽监听', () => {
        // 回归：旧实现直接 this.shadowRoot.innerHTML = ''，使 makeDraggable 注册的
        // document 级 mousemove/mouseup 监听永不移除，每次面板抛错泄漏一组。
        expect(content).toContain("const _curPanel = this.shadowRoot.querySelector('.panel');");
        expect(content).toContain('_curPanel._cleanupDrag();');
        // 回收逻辑须位于 innerHTML 清空之前
        const clearIdx = content.indexOf("this.shadowRoot.innerHTML = '';");
        const cleanupIdx = content.indexOf('_curPanel._cleanupDrag();');
        expect(cleanupIdx).toBeGreaterThan(0);
        expect(cleanupIdx).toBeLessThan(clearIdx);
    });
});

describe('v10.0 v1.0 AdGuard 导出补全 type 守卫', () => {
    const fnIdx = content.indexOf('function generateAdGuardRules');
    const exportFn = content.slice(fnIdx, fnIdx + 4000);

    it('FIX-D: v1.0 分支为各桶规则补全 type 字段，避免 convertRule 返回 null 丢失站点规则', () => {
        // 回归：旧实现 v1.0 直接用平铺字典，规则无 type，convertRule switch 全返 null。
        expect(exportFn).toContain('V1_BUCKET_TO_TYPE');
        expect(exportFn).toContain('type: V1_BUCKET_TO_TYPE[bucket]');
        // 旧的“直接用平铺字典”注释不应再出现
        expect(exportFn).not.toContain('// v1.0 兼容：直接用平铺字典');
    });
});

describe('v10.0 RegexPanel 预览异常守卫', () => {
    const panel = slicePanel('Regex');

    it('FIX-E: builder 与 regex/contains 预览分支包裹 try/catch，异常不再逸出点击处理', () => {
        // 回归：旧实现 querySelectorAll / walkTextNodes 无 try/catch，畸形选择器或遍历异常
        // 会抛错中断点击处理，使已隐藏元素无法恢复 UI 且状态不一致。
        expect(panel).toContain('校验失败：积木选择器无效。');
        expect(panel).toContain('校验失败：文本节点遍历异常。');
        // 两条 catch 均应接在 walkTextNodes / querySelectorAll 之后
        expect(panel).toContain('BlockEngine.walkTextNodes(document.body, (node) => {');
        // 旧写法（无 try 直接遍历）的语义已被包裹：确认存在 try 包裹块
        expect((panel.match(/try\s*{/g) || []).length).toBeGreaterThanOrEqual(3);
    });
});
