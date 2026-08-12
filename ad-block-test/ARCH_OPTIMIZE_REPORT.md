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

---

## 七、本轮新增：导航拦截误杀修复（v3.4.1）

### 现象（用户上报，OpenList 类自托管后台）
开启脚本后：
1. **链接点不动** —— 站内 SPA 链接/按钮点击无反应；
2. **正常元素点击后整块消失** —— 如「设置子菜单」「SSH 密钥-添加」按钮，Element-Plus 的 `.el-overlay`/`.el-drawer` 被 `remove()`。

### 根因
`OverlayScanEngine.enableNavigationInterceptor` 注册全局 `click` 捕获监听，对命中 `_checkNav(href)` 的目标执行 `e.preventDefault()` + 最近 `[class*="overlay"]` 祖先 `container.remove()`。而 `_isBlockedNav` 有两处过宽判定：

| 行 | 旧逻辑 | 问题 |
|----|--------|------|
| 4307（修复前 4304） | `if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;` 裸 IPv4 即拦截 | 自托管后台几乎都以 LAN IPv4 访问（如 `http://192.168.x.x:5244`），**所有站内链接/按钮 hostname 即该 IPv4** → 全站误杀 |
| 4303（新增） | `if (h === location.hostname) return false;` 同 host 豁免 | （本行即修复①，原缺失） |

→ 触发条件：点击发生在「脚本自身 UI 之外」的页面元素，且目标链接触达 IPv4（OpenList 站内 SPA 必然满足）。

### 修复（行为等价、功能不变）
1. **同 host 豁免**（`_isBlockedNav`）：导航到「当前站点自身」永不拦截 —— 直接解决用户自托管后台的站内链接/按钮误杀。
2. **移除裸 IPv4 启发式**（`_isBlockedNav`）：裸 IP 不是广告证据，内网/自托管常以 IPv4 互链；真实 IP 型广告服务器改由用户在 `blockedDomains` 显式封禁。消除「跨 host IPv4」整类误杀。
3. **容器移除加护栏**（全局 click 处理器，v3.4.1）：仅当命中容器确为「博彩/广告词类名」（`_isAdOverlayContainer`，基于 `VICE_CONTAINER_RE`）才 `remove()`；否则仅阻断跳转、保留页面 UI。

> ⚠️ **复审更正（v3.4.2）**：第 3 点护栏经复审发现**形同虚设**——`VICE_CONTAINER_RE` 同时含 `overlay|modal|mask|cover|layer|popup|banner|float|sticky` 等通用框架词，Element-Plus 的 `.el-overlay`/`.el-drawer` 类命中 `(\s|-)overlay(\s|_|$)` 仍判 `true`，`container.remove()` 依旧整块误删框架弹窗。v3.4.2 已**彻底移除** click 处理器的破坏性 `container.remove()`，仅保留跳转拦截；DOM 隐藏交由覆盖层扫描引擎（透明门控 autoBlock）统一处理。详见第九节。

### 验证
- 新增回归测试 `ad-block-test/navigation-false-positive.test.js`：**5 项断言全绿**（同 host IPv4 不拦 / 跨 host IPv4 不拦 / 博彩域名仍拦 / 短词跳转需叠加博彩 TLD / 非封禁域名不误杀）。
- 真实 `blockedDomains` `.has` 判定在 node 直跑已验证仍返回 `true`（保留真实封禁能力）。
- 全量 `jest`：**17 套件 / 81 测试全绿**；`node --check` 通过。
- 测试数：16 → 17 套件，76 → 81 用例。

### 架构收益（"底层更好"）
- 拦截决策从「IP 形态启发式」收敛为「显式名单 + 词集/TLD 语义」，误杀面显著下降；
- click 处理器对 DOM 的破坏性操作被 `_isAdOverlayContainer` 护栏约束（v3.4.1），并在 v3.4.2 进一步**结构性根除**。

---

## 九、隐藏 bug 复审（v3.4.2 · review-and-refactor）

按 `javascript-testing-patterns` 对架构与功能代码做复审，发现并修复 **2 个隐藏 bug**（均非用户直接报告，但影响功能正确性/性能）。

### Bug A：点击拦截器误删正常页面 UI 的护栏失效
- **位置**：`OverlayScanEngine.enableNavigationInterceptor` 全局 `click` 监听（v3.4.1 引入的 `_isAdOverlayContainer` 护栏）。
- **根因**：`VICE_CONTAINER_RE` 含 `overlay|modal|mask|cover|layer` 等通用 UI 词，`.el-overlay`（-overlay 边界命中）被判为广告容器 → `container.remove()` 仍会整块删除 Element-Plus 弹窗（「设置子菜单」「SSH 密钥-添加」等）。护栏未能达成其承诺的防护。
- **修复**：click 处理器**只阻断跳转**（`preventDefault`/`stopPropagation`），**彻底移除 `container.remove()` 与 `_isAdOverlayContainer`**。DOM 隐藏本就由覆盖层扫描引擎（透明门控 autoBlock）负责，无需在点击路径重复做破坏性操作。从结构上消除「正常元素点击后消失」整类问题。
- **验证**：`navigation-false-positive.test.js` 新增结构性锁——click 监听源码内不得再出现 `container.remove()` / `_isAdOverlayContainer`（已加）。

### Bug B：debounce 首帧同步触发（性能/语义缺陷）
- **位置**：工具函数 `debounce(func, wait, maxWait)`（第 78 行）。
- **根因**：`let lastExec = 0`，首帧调用时 `now - 0 >= maxWait` 恒成立 → **第一次去抖调用在 MutationObserver 首帧同步执行**，而非等待 `wait` 毫秒。破坏尾沿去抖语义并造成首屏主线程卡顿。
- **修复**：`lastExec` 初始为 `null`；仅当 `lastExec !== null && now - lastExec >= maxWait` 才立即触发，首次调用必走 `setTimeout(wait)`。`maxWait` 兜底语义（空闲超阈值后下一次立即执行）完整保留。
- **影响面**：仅一处使用方 `DomScanner.startObserver` 的 `debouncedDynamicApply(120, 600)`（正则/积木/覆盖层规则重扫去抖）——修复后首次 DOM 变更不再同步重扫，首屏更顺滑。
- **验证**：新增 `ad-block-test/debounce.test.js`，用 `jest.useFakeTimers()` 抽取真实 `debounce` 源码单测——首帧延迟、连续折叠、maxWait 兜底三条均通过。

### 验证汇总（v3.4.2）
- `node --check` ✅
- `jest`：**18 套件 / 85 测试全绿**（16→18 套件，81→85 用例；新增 debounce.test.js + navigation 结构锁）。

## 十、版本
- `@version` 3.4.1 → **3.4.2**（web-element-blocker.user.js + .meta.js 同步；本地提交待 push）
