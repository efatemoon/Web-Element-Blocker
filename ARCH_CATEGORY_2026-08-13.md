# iframe 扫描深度/重扫差异 + 嵌套提取能力 + 元素分类准确性

> 日期：2026-08-13 · 目标文件：`web-element-blocker.user.js`（v3.4.9）
> 触发：针对 iframe 扫描「深度 vs 重扫」差异、嵌套 iframe 广告提取能力、以及 9 菜单过滤功能的元素分类准确性三项追问
> 配套图：`architecture-iframe-scan-category.svg`（内联渲染 + 仓库文件）

---

## 一、iframe 深度扫描 vs 重新扫描，有区别吗？

**有区别，且差异真实生效。** 两条按钮的代码路径如下（见 `web-element-blocker.user.js`）：

| 按钮 | 代码路径 | 嵌套递归深度 |
|------|----------|--------------|
| 🔄 重新扫描 (`btn-rescan-iframe`, L5844) | `IframeGuard.forceRescan()` → `rescanAll()`（帧级重分类）+ `runScan()` → `IframeDeepScanner.scanAll()` | 当前配置 `maxDepth`（默认 **3**） |
| 🤖 深度扫描 (`btn-deep-scan`, L5820) | 先把 `IframeDeepScanner.maxDepth = IframeGuard.MAX_DEPTH`(**5**) → 同上同一套 → 扫完恢复 `prevDepth` | 临时拉满 **5** |

**关键事实**：两者最终都走进 `IframeDeepScanner.scanAll()`（帧内元素级扫描），而 `scanFrame` 的递归深度由 `this.maxDepth` 控制。深度扫描只是在扫描前把 `maxDepth` 从 3 临时改成 5，扫描后恢复——所以：
- **重新扫描**：重分类全部 iframe（帧级）+ 元素级扫描到默认 3 层嵌套；
- **深度扫描**：同一套，但嵌套递归到 5 层，**更彻底、更慢**（对已拦截帧跳过、递归更深）。

> 结论：并非两套独立算法，而是「同一套 + 临时加深」。按钮 tooltip「不拉满嵌套深度 / 递归嵌套帧更彻底但更慢」描述准确。`forceRescan` 与 `rescanAll` 语义完全一致（L9705 `forceRescan(){ this.rescanAll(); }`），保留独立入口供外部调用，无 bug。

---

## 二、能提取嵌套 iframe 里的广告元素方便过滤吗？

**能提取，但仅限同源 iframe；跨域嵌套无法提取（浏览器安全限制，非 bug）。**

`IframeDeepScanner.scanFrame`（L9380）递归逻辑：
```js
doc.querySelectorAll('iframe').forEach(inner => {
    const innerRecs = this.scanFrame(inner, inner.contentDocument, frameHost, innerChain, depth + 1);
    results.push(...innerRecs);
    IframeGuard._classifyAndAct(inner, depth + 1); // 帧本身分类
});
```
- **同源嵌套**：`inner.contentDocument` 可访问 → 递归扫描其内部元素，产出**元素级 record**（带 `chain: 'iframe > iframe > div.ad'`、`selector`、`frameHost`、`depth`），可通过 iframe 面板勾选保存为「帧内元素规则」即时隐藏 + 持久化（`blockInFrameNode`）。**即：嵌套同源广告元素可被精确提取并过滤。**
- **跨域嵌套**：访问 `inner.contentDocument` 抛 `SecurityError` → 被 `try/catch` 跳过（不提取帧内元素），但该帧本身在父层经 `_classifyAndAct` 按外链/跨域上报，可整帧拦截或按外链域名封杀。这是浏览器的同源策略硬限制，任何扩展都无法绕过。

> 结论：同源嵌套 iframe 内的图片/脚本/覆盖层/赌博域名等广告元素可被提取并过滤；跨域嵌套只能整帧级处理。

---

## 三、9 菜单过滤功能的元素分类准确性

涉及「实际执行过滤」的菜单项为：选择模式 `selection`、规则面板 `regex`、域名检索 `domain`、覆盖层扫描 `overlay`、iframe 面板 `iframe`（管理面板 `manager` 是规则管理、导出/导入/adguard 不执行过滤）。

### 3.1 修复前发现的分类不准确（已修复）

经逐函数核对 `OverlayScanEngine` 的分类赋值，发现两处真实不准确（用户感知为「分类不准」）：

| 编号 | 位置 | 问题 | 修复 |
|------|------|------|------|
| C1 | `_analyzeElement` 阶段1（L3905） | 元素带 `onclick=window.open/location` 明确可点击跳转广告，却只加 suspicion、category 仍为 `'unknown'` → 面板显示「可疑」而非「覆盖层」 | 该分支补 `f.category = 'overlay';` |
| C2 | `_analyzeElement` 阶段1（L3923） | `data-href/data-url/data-link` 跳转广告同样被归为 `'unknown'` | 该分支补 `f.category = 'overlay';` |
| C3 | `_analyzeInlineEventAd`（L4043） | 内联事件广告初始 `category: 'invisible'`（误标「不可见」，实为点击跳转覆盖层） | 初始 `category` 改为 `'overlay'` |

此外补齐面板标签映射，使合并列表展示一致中文（修复「同一类跨面板叫法不一」）：
- 覆盖层 `categoryLabel`（L6664）补 `'unknown'→其他可疑`、`'domain-ad'→域名封杀`、`'path-ad'→路径匹配`；
- iframe 面板 `elementReasonLabel`（L5489）补 `'invisible'→不可见`、`'tracking'→追踪像素`、`'vice-image'→博彩色情图`、`'unknown'→其他可疑`。

### 3.2 规范分类体系（修复后统一映射）

修复后仍保留三套引擎词汇，但 UI 展示已统一为中文标签：

| 来源面板 | 原始 category / type 词汇 | 规范中文标签 |
|----------|---------------------------|--------------|
| 覆盖层扫描 `overlay` | `invisible` | 不可见 |
| | `overlay` | 覆盖层 |
| | `tracking` | 追踪像素 |
| | `vice-image` | 🚫博彩色情图 |
| | `unknown` | 其他可疑 |
| iframe 面板 `iframe` | `domain-ad` | 域名封杀 |
| | `path-ad` | 路径匹配 |
| | （复用 overlay 系） | 同覆盖层 |
| 域名检索 `domain`（网络层 TYPE_MAP, L3175） | `image` | 图片 |
| | `script` | 脚本 |
| | `iframe` / `subdocument` / `frame` | iframe 嵌入 |
| | `css` / `link` | 样式表 |
| | `video` / `audio` | 媒体 |
| | `xhr` / `fetch` / `beacon` | 网络请求 |
| | `ws` | WebSocket |
| | `embed` / `object` | 插件 |
| | `other` | 其他 |

> 说明：覆盖层/iframe 分类按「广告形态/行为」命名，网络层按「资源类型」命名，二者维度不同（同一 `<img>` 在覆盖层里可能是 `overlay`，在域名检索里是 `image`）——这是合理的双层视角，已在面板标签层统一为中文，避免英文裸词/undefined。

### 3.3 各过滤菜单能过滤的元素类别

- **选择模式 `selection`**：用户手动指定任意 DOM 元素（div/img/iframe/video/script/文本节点…），按属性/文本/选择器隐藏——类别由用户决定，最通用。
- **规则面板 `regex`**：文本/正则/积木/属性/路径规则，可命中任意元素（文本广告、按属性/路径匹配的容器）。
- **域名检索 `domain`**：按资源域名封杀，覆盖 `image/script/iframe/css/media/xhr/beacon/ws/plugin` 全部资源类型。
- **覆盖层扫描 `overlay`**：不可见元素、覆盖层、追踪像素、博彩色情图、可点击跳转广告。
- **iframe 面板 `iframe`**：整帧广告（按 verdict 拦截）+ 帧内元素级（域名封杀/路径匹配/覆盖层/博彩色情图），同源嵌套可提取。

---

## 四、验证

- `node --check web-element-blocker.user.js` → `SYNTAX_OK`
- `npx jest` → **26 套件 / 171 用例全过（0 失败）**
- 新增 `ad-block-test/bugfix-regression-v13-category.test.js`（C1–C5 共 9 条源级不变量守卫）：
  - C1 `_analyzeElement` onclick 跳转分支置 `category='overlay'`
  - C2 `_analyzeElement` data-* 跳转分支置 `category='overlay'`
  - C3 `_analyzeInlineEventAd` 初始 `category='overlay'`（无残留 `'invisible'`）
  - C4 覆盖层 `categoryLabel` 覆盖 `unknown/domain-ad/path-ad`
  - C5 iframe `elementReasonLabel` 覆盖 `invisible/tracking/vice-image/unknown`

## 五、结论

1. 深度扫描 ≠ 重新扫描：**差异真实且仅在嵌套深度（3↔5）**，两者都产出可过滤的帧内元素级 record。
2. 嵌套 iframe 广告元素**同源可提取并过滤，跨域仅整帧级处理**（浏览器安全限制）。
3. 分类此前存在两处真实不准确（可点击跳转广告被标「未知/不可见」），已全部修复并补齐面板中文标签映射，现三套词汇在 UI 层统一为中文、无 undefined/英文裸词。
