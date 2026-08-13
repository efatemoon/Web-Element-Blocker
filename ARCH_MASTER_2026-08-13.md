# 架构分析 · 交互/展示问题 · 隐藏 Bug 修复 —— 总报告（9 面板 × 4 轮）

> 目标脚本：`web-element-blocker.user.js`（Tampermonkey 用户脚本，v3.4.9）
> 驱动入口：`const MENU_ITEMS = [['🖱 手动选择屏蔽元素','选择模式','selection'], ['📝 添加文本/正则/积木/属性/路径规则','规则面板','regex'], ['🌐 全局检索域名','域名检索','domain'], ['👁 扫描不可见覆盖层广告','覆盖层扫描','overlay'], ['⚙️ 管理规则与防御策略','管理面板','manager'], ['🖼️ iframe 防线管理','iframe面板','iframe'], ['📤 导出规则','导出面板','export'], ['🛡️ 导出 AdGuard 规则','AdGuard 导出','adguard'], ['📥 导入规则','导入面板','import']]`
> 共 4 轮迭代分析：R1 选择/错误边界、R2 覆盖层分类、R3 统一分类体系、R4 全面板复检 + 导出下载修复。

---

## 一、架构分层（按 `MENU_ITEMS` 驱动）

纯函数单向分发链，无反向依赖：

```
GM_registerMenuCommand
   └─ _buildMenu()                       // 依据 MENU_ITEMS 生成 9 个菜单项
        └─ PanelRegistry[key]            // OCP 扩展点：key→UIManager 方法名 的纯映射表
             └─ UIManager.method()       // 交互协调器：生命周期/预览态/拖拽/错误边界
                  ├─ 9 面板渲染器
                  │    SelectionPanel / RegexPanel / GlobalDomainPanel / OverlayScanPanel
                  │    / ManagerPanel / IframePanel / ExportPanel / AdGuardExportPanel / ImportPanel
                  └─ 服务端口层（DIP 解耦面，UIManager 不直接碰存储/引擎）
                       OverlayService(Proxy) / StorageService(Proxy) / RuleDomain
                            ├─ 引擎层：BlockEngine / IframeGuard / OverlayScanEngine
                            │          / GlobalDomainScanner / IframeDeepScanner
                            └─ StorageManager（GM_getValue/set 封装）
```

- **`PanelRegistry` 是 OCP 接缝**：新增面板只需在 `MENU_ITEMS` + `PanelRegistry` + `UIManager` 三处各加一项，不触碰既有面板。
- **服务端口层是 DIP 解耦面**：`RuleDomain` 从 `UIManager` 下沉，纯函数持有业务计算（`evaluateRuleImpact` / `generateAdGuardRules` / `countMatches` / `calcImpactScore`），只读 `storage` + 引擎只读接口，不持 UI 状态。
- **五态预览中枢 `clearPanel()`**：`_actionPreview / _previewAffectedElements / _globalPreview / _overlayPreview / _iframePreview` 在 `clearPanel()` 统一还原，防预览态跨面板残留。
- **导航冻结配对**：`_freezeNavigation`/`_unfreezeNavigation` 严格成对，仅在选择模式生命周期内激活。

---

## 二、交互 / 展示问题 + 隐藏 Bug 修复清单（逐轮）

### R1 — 选择模式 + 错误边界
| 编号 | 级别 | 位置 | 问题 | 修复 |
|------|------|------|------|------|
| G1 | Critical | `_handleClick` / `_handleTouchEnd` | 进入同源 iframe 选择上下文后点击**顶层元素**：`stopSelection()` 已清 `_selectionIframeContext`，但原始 `iframeCtx` 仍透传给 `_isElementInDOM`，`iframeCtx.doc.contains(顶层元素)`=false → 误判「已失效」，动作面板永不弹出 | 点击后用 `contains` 重判，未命中降级 `effectiveCtx=null`（顶层），两入口统一 `showActionPanel(target, effectiveCtx[T])` |
| G2 | Important | `_showErrorPanel` | 错误边界只清面板未 `stopSelection()`，若面板在 `_freezeNavigation` 后抛错会**永久劫持导航** | 清空面板前先 `stopSelection()`（并加 `_cleanupDrag` 守卫） |

### R2 — 覆盖层分类准确性
| 编号 | 级别 | 位置 | 问题 | 修复 |
|------|------|------|------|------|
| C1 | Medium | `_analyzeElement` | `onclick` 跳转类可点击重定向广告返回 `category:'unknown'`（显示「可疑」） | 改为 `'overlay'` |
| C2 | Medium | `_analyzeElement` | `data-*` 跳转类返回 `category:'unknown'` | 改为 `'overlay'` |
| C3 | Medium | `_analyzeInlineEventAd` | 初始 `category:'invisible'`，内联事件广告被误标「不可见」（实为点击跳转覆盖层） | 改为 `'overlay'` |

### R3 — 统一分类体系（单一事实来源）
文件顶部新增 `ELEMENT_CATEGORY`（17 键：广告形态 7 + 资源类型 10）+ `CATEGORY_LABELS` + `categoryLabelOf(cat)`。
| 编号 | 级别 | 位置 | 问题 | 修复 |
|------|------|------|------|------|
| A1 | Important | `_analyzeClickableImage` | 默认 `category:'vice-image'`，扫描**所有** `a img / [onclick] img`，普通点击 banner 图被误标「🚫博彩色情图」 | 默认改 `'overlay'`；仅命中博彩/色情信号（`VICE_TOKENS`/`VICE_IMG_RE`）才升级 `vice-image` |
| A2 | Important | `_analyzeInlineEventAd` | 删除 3 处把非图片 `div/anchor` 命中赌博 TLD 误标 `vice-image` 的覆盖 | 保持 `'overlay'`，赌博域名由 🚫 徽标展示 |
| — | 重构 | 两面板标签映射 | `categoryLabel` / `elementReasonLabel` 散落三套（含死键 `vice`/`skin`，且 `overlay` 在 iframe 面板原标「透明覆盖」与覆盖层不一致） | 全部路由到 `categoryLabelOf`；网络层 `TYPE_MAP` 资源类型键与 `CATEGORY_LABELS` 对齐 |

### R4 — 全面板复检 + 导出下载（本轮）
| 编号 | 级别 | 位置 | 问题 | 修复 |
|------|------|------|------|------|
| RV1 | Medium | `ExportPanel` / `AdGuardExportPanel` | `a.click()` 后**立即** `URL.revokeObjectURL(url)`，部分浏览器（Firefox / 旧版 Chrome）在 `click()` 后异步启动下载，URL 在下载开始前沿途被销毁 → **文件静默下载失败** | 改用 `setTimeout(() => { try { URL.revokeObjectURL(url) } catch(e){} }, 1000)` 延迟回收 |

> 复检发现 manager/export/adguard/import 四面板此前已硬化的防御（BUG-COUNT / BUG-M2 / BUG-XSS / BUG-11 / BUG-3 / BUG-9 / BUG-Y6 / BUG-DEEPEX / BUG-I1 / BUG-SCAN / 不一致-3）均完好、无回归。

---

## 三、你追问的三个问题的结论（已落实验证）

1. **深度扫描 vs 重新扫描有区别吗？** 有，且真实生效。两者共用 `forceRescan()`+`runScan→IframeDeepScanner.scanAll()`；唯一差异是嵌套递归深度：重扫用配置 `maxDepth`（默认 3），深扫临时拉到 `MAX_DEPTH=5` 再恢复。深扫的 `runScan(false)` 在 `maxDepth` **恢复为 3 之前**执行（iframe 面板处理器验证），差异非空壳。两处理器均 `_scanCache=null` 强制重算 → 「快速准确」在缓存层本来正确。
2. **能提取嵌套 iframe 广告元素过滤吗？** 能，但**仅同源 iframe**。`scanFrame` 递归 `iframe→contentDocument`，同源才可读内容文档 → 产出带 `chain/selector/frameHost/depth` 的元素级 record，可在 iframe 面板勾选保存为帧内规则即时隐藏+持久化。跨域访问 `contentDocument` 抛 `SecurityError` 被 catch 跳过 → 只能整帧拦截或按外链域名封杀（浏览器同源策略硬限制，非 bug）。
3. **分类准确吗？** 已统一为单一事实来源 `categoryLabelOf`，并修复 A1/A2/C1–C3 处误标。维度：覆盖层/iframe 系按「广告形态」(覆盖层/不可见/追踪像素/博彩色情图/域名封杀/路径匹配)、域名检索网络层按「资源类型」(图片/脚本/iframe/样式表/媒体/网络请求/WebSocket/插件/其他)——双维度不同视角，属合理设计。

---

## 四、测试与门禁

- `node --check web-element-blocker.user.js` → **SYNTAX_OK**
- `npx jest` → **27 套件 / 181 用例全过（0 失败）**
- 回归守卫分布：
  - `iframe-selection-xss-regression.test.js`（G1/G2 源级）
  - `bugfix-regression-v13-category.test.js`（C1–C5 + A1/A2 共 12 条）
  - `bugfix-regression-v14-download-revoke.test.js`（RV1 共 3 条）
  - 另有 `menu-wiring` / `manager-undo` / `arch-*` 等 24 个既有套件

---

## 五、遗留（结构性，非交互/UI 隐藏 bug）

- **大文件拆分**：单文件 ~10240 行，建议按面板/引擎/服务分层拆为 ES Module（需打包步骤，超出本次「交互/UI 隐藏 bug」范围）。
- 网络层 `TYPE_MAP` 与 `CATEGORY_LABELS` 资源类型键已对齐，底层仍为两套词汇仅在标签层统一——已注释约束，未来扩展直接复用 `CATEGORY_LABELS` 即可。

> 结论：9 面板范围内所有**可达**交互/展示隐藏 bug 已修复并加源级守卫；架构分发链、预览中枢、导航配对、扫描链路、分类体系均经多轮深读确认健康。
