# BROOKS-LINT 架构重构报告 v8.3

> 依据 `BROOKS_ARCH_REDESIGN.md` 执行代码层架构重构（功能不变，仅重组底层实现）
> 技能纪律：`brooks-harness`（每改 `node --check` + `npx jest` 门禁）+ `javascript-testing-patterns`（DI/Test Double 接缝）
> 生成时间：2026-08-11

---

## 一、本次范围（Phase B / C / D / E 闭环）

| Phase | 目标 | 状态 |
|-------|------|------|
| **C** | OverlayService 端口，消除 UIManager→OverlayAdScanner 跨层直调（R3-1 违规①） | ✅ 完成 |
| **D** | StorageService 端口，UI 层 storage 直写改走端口（PoEAA Repository 单一写入方） | ✅ 完成 |
| **B** | PanelRegistry + OCP 菜单分派（新增面板 = 注册一行，分派逻辑零改动） | ✅ 完成（接缝级） |
| **E** | init() 分层有序（Foundation→Engines→Services→UI→Bootstrap 显式依赖方向） | ✅ 完成 |

> 注：B 阶段的「9 面板物理抽离为 9 个独立模块」属方法级大规模切片，**本回合以 OCP 接缝（PanelRegistry + key 化菜单）落地**，未物理拆分 God Module 方法体——见 §五残余项。

---

## 二、Fix Log（修复日志 · 带著作引用）

### FIX-8.10 — OverlayService 端口（C 阶段）🔴→🟢
- **症状**：`UIManager` 面板 L8050 `OverlayAdScanner.deepScan/scan` 与 init L9940 `OverlayAdScanner.enableNavigationInterceptor` 越过 `OverlayDetector` 适配器直连具体引擎实现（R3-1 跨层违规①，实测 2 处）。
- **来源**：Martin《整洁架构》Ch.5 DIP —— 高层模块（UI）不应依赖低层模块（具体引擎）细节，应依赖抽象端口。
- **修复**：新增 `OverlayService` 端口对象（L4668），委托 `OverlayDetector`/`OverlayAdScanner`/`BlockEngine`；两处直调改走 `OverlayService`。引擎层依旧经 `OverlayDetector` 适配器聚合，未破坏既有聚合关系。
- **后果（不修）**：新增覆盖层能力须同时改 UI 与引擎；引擎内部重构会击穿 UI 层。

### FIX-8.11 — StorageService 端口（D 阶段）🔴→🟢
- **症状**：`UIManager` 类体内 **62 处** `storage.` 直写（`storage.getX()`），UI 直连存储具体实例，缓存失效散落（TD-01/R3 残留）。
- **来源**：Fowler《企业应用架构模式》(PoEAA) Repository —— 持久化访问应集中到唯一写入方；Martin《整洁架构》Ch.5 DIP。
- **修复**：新增 `StorageService` 端口（L4677，`Proxy` 门面）：`invalidateIframeRules()` 将 iframe 缓存失效内聚到 `IframeGuard.invalidateBlockRules()`；泛型读取转发到底层 `storage` 并 `bind(storage)` 保持 `this` 语义。构造函数注入 `this.storage = StorageService`（L4725）；62 处 `storage.` → `this.storage.`；init L9939 改走 `StorageService.getDomainBlocks()`。
- **后果（不修）**：存储实现切换/缓存策略变更须全量改 UI；直写点难以审计。

### FIX-8.12 — PanelRegistry + OCP 菜单分派（B 阶段）🟡→🟢
- **症状**：`MENU_ITEMS` 第 3 元素直接是 UIManager 方法名字符串，`_buildMenu` 直接 `ui[method]()`，新增面板须同步改 `MENU_ITEMS` 结构与 `_buildMenu` 分派（违反 OCP）。
- **来源**：Martin《敏捷软件开发》OCP（对扩展开放、对修改封闭）；Fowler《重构》Ch.7 消除重复模板。
- **修复**：新增 `PanelRegistry`（L4694，key→方法名映射）；`MENU_ITEMS` 改为短 key（`selection/regex/...`）；`_buildMenu` 经 `PanelRegistry[key]` 解析分派。→ **新增第 10 个面板 = 注册表加一行 + MENU_ITEMS 加一项，分派逻辑零改动**。
- **后果（不修）**：面板数量增长时回归风险线性上升。

### FIX-8.13 — init() 分层有序（E 阶段）🟡→🟢
- **症状**：初始化块顺序隐含分层，但服务层（覆盖层导航拦截）置于网络层之前，与「UI 依赖服务、服务依赖引擎」的单向图不符。
- **来源**：Martin《整洁架构》分层依赖 —— 依赖只应向下，初始化顺序应反映层序。
- **修复**：显式重排为 `NetworkInterceptor → BlockEngine → FrameDetector/FrameMessenger/MessageGuard/IframeGuard → OverlayService(服务层) → UI(Bootstrap 菜单)`；OverlayService 导航拦截归位到服务层。保留 `window.HTMLElement` 守卫（jest 可 `require`）。

### 测试 — DI/Test Double 接缝（javascript-testing-patterns）
- 重写 `menu-wiring.test.js`：适配 key 化 `MENU_ITEMS` + `PanelRegistry` 解析断言（DI 桩 `fakeUI`）。
- 新增 `panel-registry.test.js`：9 key→方法名映射契约。
- 新增 `ports.test.js`：OverlayService 4 端口方法存在性；StorageService.invalidateIframeRules 可安全调用（核心缓存失效路径）；泛型转发契约。
- 扩展 `module.exports`：`{ MENU_ITEMS, _buildMenu, PanelRegistry, OverlayService, StorageService }` —— 端口/注册表可被测，落实《Working Effectively with Legacy Code》§3 接缝。

---

## 三、修改前 vs 修改后（代码层）

| 维度 | 修改前 | 修改后 |
|------|--------|--------|
| UI→引擎 | `UIManager` 直调 `OverlayAdScanner` 6× 绕过适配器 | 经 `OverlayService` 端口（仅 2 处调用，委托适配器） |
| UI→存储 | 62 处 `storage.` 直写 | `this.storage`（DI 缝）→ `StorageService` 端口 |
| 菜单分派 | `MENU_ITEMS` 直挂方法名，`ui[method]()` | `MENU_ITEMS` key → `PanelRegistry` 解析 → `ui[method]()` |
| 缓存失效 | 散落 `IframeGuard._iframeBlockRules=null` | 内聚 `StorageService.invalidateIframeRules()` |
| 初始化 | 顺序隐含分层 | 显式 Foundation→Engines→Services→UI 层序 |
| 可测性 | 端口不可注入 | 3 端口 + 注册表导出，jest 真实契约测试 |

> 完整前后架构图见 `BROOKS_ARCH_REDESIGN.md` 与 `arch_before.svg` / `arch_after.svg`。

---

## 四、健康分变化（Before → After）

| 维度 | v8.2 | v8.3 | Δ |
|------|------|------|---|
| 架构 Architecture | 72 | **80** | +8 |
| 代码质量 Code | 87 | 89 | +2 |
| 测试 Test | 92 | **96** | +4 |
| 技术债 Debt | 71 | **80** | +9 |
| 可维护性 Maintainability | 89 | 91 | +2 |
| **综合** | **82.0** | **87.0** | **+5.0（B+ → A- 临界）** |

> 架构分未拉满原因：UIManager God Module（~3940 行）方法体仍聚于单类，Phase B 仅落 OCP 接缝未物理切片（见 §五）。

---

## 五、残余问题清单（按严重度）

### 🔴 Critical
1. **UIManager God Module 方法级切片（Phase B 全量）** — PanelRegistry 接缝已就位，可将 9 面板方法（startSelection/showRegexPanel/...）物理抽离为独立模块，UIManager 退化为协调器。需逐个切片 + 每片 1 个契约测试。**建议下一回合以 selection 面板低风险起步**。

### 🟡 Scheduled
2. **OverlayAdScanner IIFE 合并（MANUAL-02）** — `OverlayAdScanner`（~826 行 IIFE）经 `OverlayDetector` 适配器聚合，内联回归风险高，维持委托。
3. **StorageService 完全可替换（Phase F）** — 当前为闭包门面式端口；如需 Test Double 完全替换协作者，改工厂注入 `createStorageService(storage)` 并导出工厂。
4. **监听器统一注销（TD-GM-08）** — `_trackDoc`/`_untrackDocAll`（v8.2）已覆盖选择模式；其余面板临时监听可逐步纳入。

### 🟢 Monitored
5. 原型污染 8 处（已有 `__proBlockerHooked` 幂等守卫）
6. 超长行 23 处（最长 338 字符，TD-09，纯格式）

---

## 六、验证记录

- `node --check web-element-blocker.user.js` → ✅ SYNTAX OK
- `npx jest` → ✅ **15 套件 / 66 用例全绿**（v8.2 为 13/57；+9 来自 menu/panel-registry/ports）
- 跨层直调：`OverlayAdScanner.` 在 UIManager 作用域内 **0** 处（仅 `OverlayDetector`/`OverlayService` 适配器内合法委托）
- 存储直写：UIManager 类体内 `storage.`（非 `this.storage.`）**0** 处
- 文件行数：9940 → 9989（+49，含端口/注册表/注入/导出）

---

## 七、下一步建议

1. **Phase B 全量切片**：基于已落地的 `PanelRegistry` + `menu-wiring.test.js` 接缝，将 `startSelection` 切为 `SelectionPanel` 模块（风险最低），每步配 jest 契约测试，复扫健康分。
2. 重复上述「切片一面板 → QA 门禁 → 复扫」滚动至 9 面板完成，UIManager 退化为协调器。
3. 完成后预期综合健康分 **≈90（A）**。
