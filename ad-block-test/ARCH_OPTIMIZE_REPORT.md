# 架构优化分析报告（v3.3.1 → v3.4.0）

> 方法：`review-and-refactor` + `diagram-builder`
> 目标：输出优化前 / 优化后架构，确保功能完全不变，底层结构更清晰、更可维护。
> 结论：**行为零变更**（16 套件 / 76 测试全绿），完成 2 项结构性优化。

---

## 一、优化前架构（现状，含问题热点）

```
┌──────────────────────────────────────────────────────────────────┐
│  UI 层：9 个面板函数（顶层）+ UIManager（上帝类 ~1618 行）          │
│   ├─ SelectionPanel / GlobalDomainPanel / RegexPanel / IframePanel  │
│   ├─ ManagerPanel / ExportPanel / AdGuardExportPanel / OverlayScan  │
│   └─ ImportPanel  （均 XPanel.call(this) 委托，符合 Phase B 接缝）   │
├──────────────────────────────────────────────────────────────────┤
│  Ports 层：OverlayService ✅ | StorageService ✅（端口已 100% 落地） │
├──────────────────────────────────────────────────────────────────┤
│  Engines 层：BlockEngine / OverlayScanEngine / IframeGuard /        │
│   ContentClassifier / DomScanner / NetworkEngine / GlobalDomainScanner│
├──────────────────────────────────────────────────────────────────┤
│  Stores 层：StorageManager(RuleStore/ConfigStore)                  │
├──────────────────────────────────────────────────────────────────┤
│  Bootstrap：init() 分层有序                                         │
└──────────────────────────────────────────────────────────────────┘

问题热点（实测）：
  H1. UIManager 上帝类：1618 行，含 54 个方法，职责混杂
      - A 样式/DOM 宿主  ~120 行
      - B 选择模式交互    ~300 行
      - C 通用 UI 原语    ~150 行
      - D 预览/撤销        ~280 行
      - E 领域逻辑(错层)  ⚠ ~270 行  ← evaluateRuleImpact / generateAdGuardRules /
      │                               _countMatches / _calcImpactScore 本属业务计算
      - F 面板转发        ~500 行
  H2. 领域逻辑错层：规则影响度评估与 AdGuard 导出是纯业务计算，却放在 UI 协调器内，
      违反单一职责；UIManager 同时是「协调器」与「规则计算器」。
  H3. 行尾 100% CRLF：导致若干 `$` 锚定正则测试误判失败（2 个守卫本应通过），
      且跨平台/工具链易再次引发 v8.4 式提取损坏。
  H4.（已存在但本次未动）面板层对 BlockEngine / IframeGuard 的少量直调仍绕过端口接缝，
      属下一步 Ports 收口范围。
```

---

## 二、本次已实施的优化（功能不变）

### 优化 1：规则领域逻辑下沉 → 新模块 `RuleDomain`
- 从 `UIManager` 提取 `evaluateRuleImpact` / `generateAdGuardRules` 及其私有助手
  `_countMatches` / `_calcImpactScore`，下沉到独立模块 `RuleDomain`（位于 `class UIManager` 之前）。
- `RuleDomain` 不持有任何 UI 状态，仅依赖：
  - `storage` 端口（入参注入，DIP）
  - 引擎只读接口 `BlockEngine.isRegexSafe / walkTextNodes`、`ResourceSelectorBuilder`
  - DOM 只读查询 `document.querySelectorAll`
- `UIManager` 保留**薄转发桩**，公开 API 完全不变：
  ```js
  evaluateRuleImpact()      { return RuleDomain.evaluateRuleImpact(this.storage); }
  generateAdGuardRules()    { return RuleDomain.generateAdGuardRules(this.storage); }
  ```
- 净收益：UIManager 减少 ~270 行业务代码；规则计算可独立单测；UI 协调器职责收敛。

### 优化 2：全文件行尾统一为 LF
- 9941 行 CRLF → LF。修复 2 个因 `\r` 破坏 `$` 锚定正则而误失败的守卫测试
  （`defines 9 top-level panel modules` / `each top-level panel module is non-empty`）。
- 与 v8.4 恢复所采用的 LF 规范一致，消除后续 babel/提取类损坏风险。

---

## 三、优化后架构（目标，本次落地的部分用 ✅ 标注）

```
┌──────────────────────────────────────────────────────────────────┐
│  UI 层：9 面板函数 + UIManager（协调器，已瘦身 ~270 行）             │
├──────────────────────────────────────────────────────────────────┤
│  Domain 层（新增 ✅）：RuleDomain                                    │
│   ├─ evaluateRuleImpact(storage)  → 规则影响度评估                  │
│   ├─ generateAdGuardRules(storage)→ AdGuard 导出                    │
│   └─ calcImpactScore / countMatches（纯函数）                       │
├──────────────────────────────────────────────────────────────────┤
│  Ports 层：OverlayService ✅ | StorageService ✅                    │
├──────────────────────────────────────────────────────────────────┤
│  Engines / Stores / Bootstrap（不变）                               │
└──────────────────────────────────────────────────────────────────┘

调用链（优化后）：
  ManagerPanel  → this.evaluateRuleImpact()  → RuleDomain.evaluateRuleImpact(this.storage)
  AdGuardExport → this.generateAdGuardRules()→ RuleDomain.generateAdGuardRules(this.storage)
  ← 对外 API 形态与优化前逐字一致，行为等价。
```

---

## 四、验证结果
- `node --check web-element-blocker.user.js`：✅ 通过
- `jest --config jest.config.js`：✅ **16 套件 / 76 测试全绿**（含 2 个此前因 CRLF 误失败的守卫）
- 转发桩语法与调用点（`ManagerPanel` L6026 / `AdGuardExportPanel` L6438）保持不变。

## 五、建议的后续优化（未实施，低风险分阶段）
| 编号 | 优化 | 收益 | 风险 | 建议 |
|------|------|------|------|------|
| P1 | 面板层 BlockEngine / IframeGuard 直调收口到端口（新增 BlockService 或并入 OverlayService） | 彻底单向依赖 | 中 | 下个迭代 |
| P2 | 注入样式表 `injectStyles` 提取为共享 CSS 常量 | 消除重复、便于主题化 | 低 | 任意时机 |
| P3 | UIManager 选择模式交互(300 行) 抽为 SelectionController | 协调器进一步瘦身 | 中 | 视需要 |

> 本次仅做行为等价、零风险的结构性下沉与规范化，未触碰 P1–P3，以确保「功能不变」。

## 六、版本
- `@version` 3.3.1 → **3.4.0**（web-element-blocker.user.js + .meta.js 同步）
