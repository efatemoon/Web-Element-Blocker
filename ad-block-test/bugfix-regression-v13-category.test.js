/**
 * v13.0 元素分类准确性 + 统一分类体系回归守卫
 *
 * 本轮聚焦「覆盖层扫描（overlay）/ iframe 面板（iframe）/ 域名检索网络层」的元素分类：
 *  - 此前 _analyzeElement 对 onclick 跳转 / data-* 跳转仍返回 category:'unknown'（"可疑"），
 *    _analyzeInlineEventAd 初始 category:'invisible'（实为点击跳转覆盖层）——均已修复。
 *  - 本轮新增：统一分类体系（ELEMENT_CATEGORY / CATEGORY_LABELS / categoryLabelOf 单一事实来源），
 *    并修复两处真实分类误标：
 *      A1 _analyzeClickableImage 默认 category 由 'vice-image' 改为 'overlay'（仅真实博彩/色情图升级 vice-image）；
 *         普通点击 banner 图之前被误标"博彩色情图"。
 *      A2 _analyzeInlineEventAd 命中赌博 TLD 时把非图片的 div/anchor 也标 'vice-image'（应为 overlay，
 *         赌博域名已由 features.viceTarget 经 🚫 徽标展示）——三处覆盖已删除。
 *
 * 不变量：
 *   C1 _analyzeElement 的 onclick 跳转分支必须把 category 置为 'overlay'
 *   C2 _analyzeElement 的 data-* 跳转分支必须把 category 置为 'overlay'
 *   C3 _analyzeInlineEventAd 初始 category 必须为 'overlay'（非 'invisible'）
 *   C4 CATEGORY_LABELS 单一事实来源须覆盖全部 17 个键（两维度：广告形态 7 + 资源类型 10）
 *   C5 覆盖层/iframe 两面板标签必须路由到 categoryLabelOf（删除散落 map）
 *   A1 _analyzeClickableImage 默认 'overlay'，且仅在博彩/色情信号下升级 'vice-image'
 *   A2 _analyzeInlineEventAd 整体不得出现 f.category = 'vice-image'（非图片元素不标博彩色情图）
 */
const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(
    path.join(__dirname, '..', 'web-element-blocker.user.js'),
    'utf8'
);

const sliceBetween = (startAnchor, endAnchor) => {
    const s = content.indexOf(startAnchor);
    expect(s).toBeGreaterThan(-1);
    const e = content.indexOf(endAnchor, s);
    return content.slice(s, e === -1 ? content.length : e);
};

const analyzeElement = sliceBetween('function _analyzeElement(el) {', 'function _analyzeOverlay(el, cs) {');
const clickableImage = sliceBetween('function _analyzeClickableImage(img) {', 'function _analyzeInlineEventAd(el) {');
const inlineEventAd = sliceBetween('function _analyzeInlineEventAd(el) {', '        return { scan, deepScan,');
const categoryLabels = sliceBetween('const CATEGORY_LABELS = {', '};');

describe('C1 _analyzeElement 的 onclick 跳转归入覆盖层', () => {
    it('onclick 跳转分支（window.open/location）设置 category=overlay', () => {
        expect(analyzeElement).toMatch(
            /f\.reasons\.push\('onclick跳转'\)[\s\S]{0,120}?f\.category = 'overlay';/
        );
    });
});

describe('C2 _analyzeElement 的 data-* 跳转归入覆盖层', () => {
    it('data-href/data-url/data-link 跳转分支设置 category=overlay', () => {
        expect(analyzeElement).toMatch(
            /f\.reasons\.push\('data-\*跳转'\)[\s\S]{0,120}?f\.category = 'overlay';/
        );
    });
});

describe('C3 _analyzeInlineEventAd 初始类别为覆盖层', () => {
    it('内联事件广告初始 category 为 overlay（非 invisible）', () => {
        expect(inlineEventAd).toContain(
            "const f = { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };"
        );
        expect(inlineEventAd).toContain(
            "if (ProtectedCheck.isProtected(el)) return { el, suspicion: 0, reasons: [], features: {}, category: 'overlay' };"
        );
        expect(inlineEventAd).not.toContain("category: 'invisible' };");
    });
});

describe('C4 CATEGORY_LABELS 单一事实来源覆盖全部 17 键', () => {
    it('覆盖广告形态维度（overlay 系）', () => {
        expect(categoryLabels).toContain("'overlay': '覆盖层'");
        expect(categoryLabels).toContain("'invisible': '不可见'");
        expect(categoryLabels).toContain("'tracking': '追踪像素'");
        expect(categoryLabels).toContain("'vice-image': '🚫博彩色情图'");
        expect(categoryLabels).toContain("'domain-ad': '域名封杀'");
        expect(categoryLabels).toContain("'path-ad': '路径匹配'");
        expect(categoryLabels).toContain("'unknown': '其他可疑'");
    });
    it('覆盖资源类型维度（网络层）', () => {
        expect(categoryLabels).toContain("'script': '脚本'");
        expect(categoryLabels).toContain("'css': '样式表'");
        expect(categoryLabels).toContain("'image': '图片'");
        expect(categoryLabels).toContain("'xhr': '网络请求'");
        expect(categoryLabels).toContain("'beacon': '网络请求'");
        expect(categoryLabels).toContain("'iframe': 'iframe'");
        expect(categoryLabels).toContain("'media': '媒体'");
        expect(categoryLabels).toContain("'ws': 'WebSocket'");
        expect(categoryLabels).toContain("'plugin': '插件'");
        expect(categoryLabels).toContain("'other': '其他'");
    });
    it('categoryLabelOf 统一取标签函数存在', () => {
        expect(content).toContain('function categoryLabelOf(cat) {');
    });
});

describe('C5 两面板标签路由到 categoryLabelOf（散落 map 已删除）', () => {
    it('覆盖层面板 categoryLabel 指向 categoryLabelOf', () => {
        expect(content).toContain('const categoryLabel = categoryLabelOf;');
    });
    it('iframe 面板使用 categoryLabelOf(cat)', () => {
        expect(content).toContain('const label = categoryLabelOf(cat);');
    });
    it('旧的 elementReasonLabel 散落对象已移除', () => {
        expect(content).not.toContain('const elementReasonLabel = {');
    });
});

describe('A1 _analyzeClickableImage 默认 overlay，仅博彩/色情信号升级 vice-image', () => {
    it('初始 category 为 overlay（普通点击 banner 图不再误标博彩色情图）', () => {
        expect(clickableImage).toContain(
            "const f = { el: img, suspicion: 0, reasons: [], features: {}, category: 'overlay' };"
        );
        expect(clickableImage).toContain(
            "if (ProtectedCheck.isProtected(img)) return { el: img, suspicion: 0, reasons: [], features: {}, category: 'overlay' };"
        );
    });
    it('vice-image 升级被博彩/色情词元或图片命名门控', () => {
        // 升级语句必须存在（真实博彩/色情图才标），且绑定 VICE_TOKENS / VICE_IMG_RE
        expect(clickableImage).toContain("f.category = 'vice-image';");
        expect(clickableImage).toContain('GlobalDomainScanner.VICE_TOKENS.has');
        expect(clickableImage).toContain('VICE_IMG_RE.test');
    });
});

describe('A2 _analyzeInlineEventAd 非图片元素绝不标 vice-image', () => {
    it('函数体内不得出现 f.category = \'vice-image\'（赌博 TLD 保持 overlay，域名由 🚫 徽标展示）', () => {
        expect(inlineEventAd).not.toContain("f.category = 'vice-image';");
    });
});
