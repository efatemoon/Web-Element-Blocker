# 架构统一与分类准确性重构报告（2026-08-13）

> 目标：按照 `MENU_ITEMS` 九面板架构，统一元素分类体系（消除散落映射）、逐函数审查检测算法准确性、确认重扫/深度扫描的快速准确，并结合新架构图重构思路。
> 涉及文件：`web-element-blocker.user.js`（当前 10260+ 行）

---

## 一、回答三个核心问题

### Q1. iframe 深度扫描 vs 重新扫描，有区别吗？
**有区别，且真实生效。** 两者共用 `IframeGuard.forceRescan()`（帧级重分类）+ `runScan → IframeDeepScanner.scanAll()`（帧内元素级扫描）。唯一差异在嵌套递归深度：

| 操作 | 嵌套深度 | 行为 |
|------|---------|------|
| 重新扫描（`btn-rescan-iframe`，L5846） | 配置 `maxDepth`（默认 **3**） | `forceRescan()` + `runScan(false)` |
| 深度扫描（`btn-deep-scan`，L5822） | 临时拉满 `MAX_DEPTH=5`（L5836） | 设 `maxDepth=5` → `forceRescan()` → `runScan(false)`（**L5838，在 L5839 恢复前已执行**）→ 恢复 `maxDepth=3` |

关键点（经代码核对）：深度扫描的 `runScan(false)` 在 `maxDepth` 恢复为 3 **之前**调用（L5838 < L5839），所以深度扫描确实以 5 层递归运行，差异不是空壳。两个处理器都已 `resetPreview()` + `_scanCache = null`（L5832/L5849），**强制忽略 5s TTL 缓存重新计算**，因此"重新扫描和深度扫描快速准确"在缓存层本来就是对的。

### Q2. 能提取嵌套 iframe 里的广告元素方便过滤吗？
**能，但仅同源 iframe（跨域受浏览器同源策略限制，非 bug）。**
- `IframeDeepScanner.scanFrame`（L9384）递归 `doc.querySelectorAll('iframe') → inner.contentDocument`（L9441-4448），同源才能读内容文档 → 产出元素级 record（带 `chain: iframe > iframe > div.ad`、`selector`、`frameHost`、`depth`）。
- 这些 record 可在 iframe 面板勾选保存为帧内规则，`blockInFrameNode` 写入即时隐藏 + 经 `StorageService` 持久化。
- 跨域访问 `contentDocument` 抛 `SecurityError` 被 catch 跳过 → 只能整帧拦截或按外链域名封杀（任何扩展都无法绕过同源策略）。

### Q3. 九菜单过滤功能的元素分类准确吗？
**本轮发现并修复两处真实分类误标，并将三套散落标签映射统一为单一事实来源。** 详见第二节。

---

## 二、统一分类体系（重构核心）

### 2.1 问题：三套散落映射
重构前，同一"分类→中文标签"关系散落在三处，易漂移：
1. 覆盖层面板 `categoryLabel`（原 L6666）：`{invisible,overlay,tracking,vice-image,unknown,domain-ad,path-ad}`
2. iframe 面板 `elementReasonLabel`（原 L5491）：含死键 `vice`/`skin`（从未被产出）+ `overlay` 标成"透明覆盖"（与覆盖层面板"覆盖层"不一致）
3. 网络层 `TYPE_MAP`（L3175）：`{script,css,image,xhr,beacon,iframe,media,ws,plugin,other}` —— 键已规范，但缺统一标签出口

### 2.2 重构：单一事实来源
在 `'use strict';` 之后插入（L27+）：
```js
const ELEMENT_CATEGORY = {
  // 广告形态维度（overlay / iframe 系）
  OVERLAY:'overlay', INVISIBLE:'invisible', TRACKING:'tracking',
  VICE_IMAGE:'vice-image', DOMAIN_AD:'domain-ad', PATH_AD:'path-ad', UNKNOWN:'unknown',
  // 资源类型维度（网络层 / 域名检索）
  SCRIPT:'script', CSS:'css', IMAGE:'image', XHR:'xhr', BEACON:'beacon',
  IFRAME:'iframe', MEDIA:'media', WS:'ws', PLUGIN:'plugin', OTHER:'other'
};
const CATEGORY_LABELS = { /* 17 键 → 中文标签 */ };
function categoryLabelOf(cat) { return CATEGORY_LABELS[cat] || '未知'; }
```
- 覆盖层面板：`const categoryLabel = categoryLabelOf;`
- iframe 面板：删除 `elementReasonLabel` 对象，`label = categoryLabelOf(cat)`
- 网络层 `TYPE_MAP` 输出键已与 `CATEGORY_LABELS` 资源类型键对齐，加注释禁止另建第三套映射

**结果**：所有面板统一经 `categoryLabelOf` 取中文标签，`overlay` 在两面板一致为"覆盖层"，死键 `vice`/`skin` 移除。维度不同（广告形态 vs 资源类型）属合理双层视角，但标签集中一处，不再漂移。

### 2.3 分类准确性修复（A1 / A2）
| 编号 | 函数 | 问题 | 修复 |
|------|------|------|------|
| **A1** | `_analyzeClickableImage`（阶段3） | 默认 `category:'vice-image'`，但它扫描**所有** `a img / [onclick] img`，普通点击 banner 图被误标"🚫博彩色情图" | 默认改 `overlay`；仅命中 `VICE_TOKENS` 词元或 `VICE_IMG_RE` 图片命名时升级 `vice-image` |
| **A2** | `_analyzeInlineEventAd`（阶段4） | 命中赌博 TLD 时把非图片的 `div/anchor` 也标 `vice-image`（应为 overlay） | 删除三处 `f.category='vice-image'` 覆盖；赌博域名由 `features.viceTarget` 经 🚫 徽标展示，分类保持 `overlay` |

（延续上轮已修复：C1/C2 `_analyzeElement` 的 onclick/data-* 跳转归 `overlay`；C3 `_analyzeInlineEventAd` 初始 `overlay`。）

---

## 三、逐函数检测算法审查结论

对 9 面板对应的检测算法做了一一核对：

- **覆盖层扫描（overlay）**：`OverlayScanEngine` 四阶段（快速选择器 / 定位元素 / 可点击图片 / 内联事件）经 `seen` Set 去重，无重复分析；分类键完整。A1/A2 修复后，分类全部准确。
- **iframe 面板（iframe）**：`IframeDeepScanner._classifyElement` 按命名/文本/src 域名/几何评分，≥20 才产出；嵌套递归受 `maxDepth` 门控。
- **域名检索（domain）**：`GlobalDomainScanner` 六通道采集（Performance API / DOM 资源 / iframe 递归 / WS / 伪元素 / 沙箱解码），`TYPE_MAP` 资源类型键规范。
- **选择模式 / 规则面板 / 管理 / 导出 / AdGuard 导出 / 导入**：入口分发（`_buildMenu → PanelRegistry → UIManager`），无分类相关逻辑，无回归。

**未改动且健康的链路**：分发链、`clearPanel` 五态预览清理、`_freezeNavigation/_unfreezeNavigation` 配对、iframe 粘性记录（`blocked/manual` 永不复活）、扫描指纹保留（`blockedFingerprints`）、显式扫描 `_scanCache=null` 强制重算。

---

## 四、架构重构思路（结合新架构图）

新架构图（`architecture-unified-category.svg`）表达三层单向流：

```
检测引擎层（产出 canonical category 键）
   ├─ OverlayScanEngine      → overlay/invisible/tracking/vice-image/unknown
   ├─ IframeDeepScanner      → domain-ad/path-ad + 帧内 overlay
   └─ GlobalDomainScanner    → TYPE_MAP 资源类型键
            │
            ▼
统一分类事实来源（ELEMENT_CATEGORY / CATEGORY_LABELS / categoryLabelOf）
   · 单一事实来源，消除 3 套散落映射
   · 双维度：广告形态（7）+ 资源类型（10）= 17 键
            │
            ▼
面板渲染层（覆盖层 / iframe / 域名检索 三面板统一 categoryLabelOf）
```

**优化要点**：
1. 分类语义（category 键）与中文展示（CATEGORY_LABELS）解耦，新增分类只需在 `ELEMENT_CATEGORY` + `CATEGORY_LABELS` 各加一行，三面板自动生效，符合 OCP。
2. 检测算法只产出规范键，不再内联中文标签，符合 SRP；展示层单一出口，符合 DIP。
3. 资源类型键直接复用 `TYPE_MAP`，与网络层零重复映射。

---

## 五、验证

- `node --check web-element-blocker.user.js` → **SYNTAX_OK**
- `npx jest` → **26 套件 / 178 用例全过（0 失败）**（本轮 +7 条 C4/C5/A1/A2 守卫）
- 回归守卫 `bugfix-regression-v13-category.test.js` 单跑 12/12 通过

## 六、交付物
- `web-element-blocker.user.js`：+统一常量 + A1/A2 修复 + 标签路由统一
- `ad-block-test/bugfix-regression-v13-category.test.js`：C1–C5 + A1/A2 共 12 条源级不变量守卫
- `architecture-unified-category.svg`：统一分类体系架构图（已内联渲染）
- 本报告

## 七、遗留与建议
- 当前 17 键分类已覆盖用户列出的全部维度；如需把"网络层资源类型"在域名检索面板做实时的 per-host 类型标签展示，可直接调用 `categoryLabelOf`（已就绪，无需新映射）。
- 结构项（B3 大文件拆分、OverlayScanEngine 4766 行等）仍建议后续专项重构，本轮未触及。
