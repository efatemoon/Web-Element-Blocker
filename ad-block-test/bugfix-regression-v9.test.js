/**
 * v9.0 交互/展示隐藏缺陷修复回归守卫
 *
 * 守卫不变量：以下 6 处交互/展示逻辑修复不得回潮。
 * 每个用例对应 web-element-blocker.user.js 中一次具体的隐藏 bug 修复：
 *   FIX-1  GlobalDomainPanel 渲染时 d.reasons 缺失会抛 TypeError 致面板崩溃
 *   FIX-2  GlobalDomainPanel host 大小写不一致导致过滤漏过滤 + selectedHosts 勾选错位
 *   FIX-3  GlobalDomainPanel “全选”忽略 onlyAds/关键字过滤，勾选隐藏项导致选中数虚高
 *   FIX-4  IframePanel 首次加载不渲染“正在扫描”占位，异步扫描期列表空白误导用户
 *   FIX-5  ManagerPanel “全局域名黑名单”计数混入 iframeBlock 规则被虚高
 *   FIX-6  OverlayScanPanel 深度扫描 Toast 访问 deepExtras 缺失字段会抛 TypeError 崩溃
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

const slicePanel = (name) => content.slice(content.indexOf('function ' + name + 'Panel()'));

describe('v9.0 GlobalDomainPanel 渲染与选择守卫', () => {
    const panel = slicePanel('GlobalDomain');

    it('FIX-1: 渲染时对 d.reasons 做存在性守护，避免缺失字段抛 TypeError', () => {
        // 回归：旧实现直接 `d.reasons.length`，extractResourceDomains 未返回 reasons 时
        // 整个域名面板渲染中断。新实现先判断 d.reasons 存在。
        expect(panel).toContain('(d.reasons && d.reasons.length)');
        // 旧危险写法不应再出现
        expect(panel).not.toContain(': (d.reasons.length ?');
    });

    it('FIX-2: 合并域名时统一小写 host，消除大小写不一致', () => {
        // 回归：与 blockedDomainSet（已小写）过滤对齐，避免大写 host 漏过滤；
        // 同时与点击时 row.dataset.host.toLowerCase() 对齐，避免勾选错位/重复封杀。
        expect(panel).toContain("!blockedDomainSet.has((d.host || '').toLowerCase())");
        expect(panel).toContain("host: (d.host || '').toLowerCase()");
    });

    it('FIX-3: “全选”仅选中当前可见（通过过滤）的域名，而非全部', () => {
        // 回归：旧实现 allDomains.forEach(d => selectedHosts.add(d.host)) 会勾选被
        // onlyAds/关键字过滤隐藏的项，导致选中数虚高、用户却看不到被选中项。
        expect(panel).toContain("const visible = allDomains.filter(d => {");
        expect(panel).toContain('onlyAds && !isAdLike(d)');
        // 断言遍历的是 visible 而非 allDomains（BUG-G4 后 forEach 体内多了
        // manuallyDeselected.delete，故不再锁死整行字面量，只锁遍历源与写入动作）
        expect(panel).toMatch(/visible\.forEach\(d =>[\s\S]{0,120}?selectedHosts\.add\(d\.host\)/);
        // 旧的危险全量写法不应再出现
        expect(panel).not.toContain('allDomains.forEach(d => selectedHosts.add(d.host));');
    });
});

describe('v9.0 IframePanel 首屏反馈守卫', () => {
    const panel = slicePanel('Iframe');

    it('FIX-4: 首次加载调用 runScan(false)，先渲染“正在扫描”占位', () => {
        // 回归：旧实现 runScan(true) 跳过内部 scanning=true+render()，
        // 异步 collectAll 期间 #iframe-list 空白，用户误以为无 iframe。
        expect(panel).toContain('runScan(false);');
        // 旧的跳过渲染写法不应再出现于首屏
        expect(panel).not.toContain('runScan(true);');
    });
});

describe('v9.0 ManagerPanel 统计口径守卫', () => {
    const panel = slicePanel('Manager');

    it('FIX-5: “全局域名黑名单”计数仅含 domainBlock，排除 iframeBlock', () => {
        // 回归：旧实现 records.filter(r => r.scope === 'global').length 把 iframeBlock
        // 规则也算进“域名黑名单”计数，导致计数虚高、与初始 domainBlock.length 不一致。
        expect(panel).toContain("r.scope === 'global' && r.type === 'domainBlock'");
        // 旧的宽泛写法不应再出现于 mgr-domain-count 更新处
        expect(panel).not.toMatch(/countEl\.textContent = records\.filter\(r => r\.scope === 'global'\)\.length;/);
    });
});

describe('v9.0 OverlayScanPanel 深度扫描 Toast 守卫', () => {
    const panel = slicePanel('OverlayScan');

    it('FIX-6: 深度扫描 Toast 对 deepExtras 各字段做空守护，避免缺失字段抛 TypeError', () => {
        // 回归：旧实现直接 ex.viceImages.length / ex.obfuscatedUrls.length 等，
        // 不同 OverlayService 版本返回结构不同时 Toast 渲染崩溃。
        expect(panel).toContain('(ex.viceImages || []).length');
        expect(panel).toContain('(ex.obfuscatedUrls || []).length');
        expect(panel).toContain('(ex.pseudoInjects || []).length');
        expect(panel).toContain('(ex.customFontEls || []).length');
        // 旧的裸字段访问不应再出现
        expect(panel).not.toContain('ex.viceImages.length');
    });
});
