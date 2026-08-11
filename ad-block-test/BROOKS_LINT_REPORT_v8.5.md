# Brooks-Lint 报告 v8.5 — 架构合规性确认 + 隐藏缺陷修复

**日期**：2026-08-11
**目标文件**：`web-element-blocker.user.js`（10035 行）
**基线**：v8.4（Phase B 面板物理抽离完成，16 套件 / 70 用例全绿）
**本轮**：按 `BROOKS_ARCH_REDESIGN.md` 复核架构合规性，并做代码审查（code review）定位 + 修复隐藏缺陷。

---

## 0. 结论

- **架构已按新架构落地**：Phase A/B/C/D/E 全部到位。UI（9 个面板 + UIManager 协调器）只经 `OverlayService` / `StorageService` 端口触达引擎；`OverlayAdScanner` 已重命名为 **`OverlayScanEngine`** 以对齐设计命名（`OverlayService = OverlayDetector 门面 + OverlayScanEngine 实现 + 端口`），UI 对 `OverlayScanEngine.` 的直接调用为 **0 处**（仅 `OverlayDetector` / `OverlayService` 适配器内合法委托）。
- **代码审查发现并修复 4 个隐藏缺陷**（1 个 HIGH、1 个 MEDIUM、2 个 LOW），其中 1 个是我方清理过程中险些引入的 `ReferenceError`（已在门禁前捕获）。
- **门禁全绿**：`node --check` 通过；`npx jest` **16 套件 / 73 用例**（新增 3 个回归守卫）全绿。

---

## 1. 架构合规性复核（vs BROOKS_ARCH_REDESIGN.md）

| 阶段 | 设计要求 | v8.5 状态 | 证据 |
|------|----------|-----------|------|
| A | TIMING / _trackDoc / invalidateBlockRules / queryIframes / _buildMenu 接缝 | ✅ | 既有 |
| B | 9 面板抽离为独立模块 + UIManager 退化为协调器 | ✅ | 9 个顶层 `XPanel()` + `return XPanel.call(this)` 桩；UIManager 1624 行 |
| C | 折叠 OverlayAdScanner → OverlayService（Detector+ScanEngine）；消除 UI 跨层直调 | ✅ | `OverlayScanEngine`（重命名）+ `OverlayDetector` 门面 + `OverlayService` 端口；grep `OverlayScanEngine.` 在 UIManager 作用域内 **0 处** |
| D | StorageService 为唯一写入端口；UI 经 `this.storage`（=StorageService Proxy）读写 | ✅ | `this.storage = StorageService`（Proxy），195 处 `this.storage.` 经端口转发 |
| E | init() 分层有序 + HTMLElement 守卫；最终复扫 | ✅ | `init()` 网络→引擎→帧→服务→菜单，守卫完整 |

**抽离正确性验证（关键）**：9 个面板为**逐字搬移** + `XPanel.call(this)`，已交叉核对所有 `IframeGuard.*` / `BlockEngine.*` / `OverlayService.*` / `storage.*` / `this.*`（UIManager）调用均能解析到真实成员（详见 §3 审查第 ④ 项）——**无缺失引用、无 `this` 误绑定**。`async` 安全性：`node --check` 通过证明所有 `await` 均位于嵌套 `async` 箭头内，面板函数本身无需 `async`（原类方法亦非 async），**无 async 丢失缺陷**。

---

## 2. 隐藏缺陷清单（code review 结果）

审查方法：两轮 `Explore` 只读代理（OverlayAdScanner IIFE + 9 面板 + IframeGuard + init 交叉核对）+ 自验 `await`/`super.`/TDZ/参数丢失。

| 编号 | 严重度 | 位置 | 缺陷 | 修复 |
|------|--------|------|------|------|
| **HD-1** | 🔴 HIGH | `IframePanel` `renderScanList` (L5666) | **监听器泄漏**：`list` 是复用 DOM 节点，`list.innerHTML = ...` 只替换子节点、不移除绑定在 `list` 自身的监听器；每次 `renderScanList` 都 `list.addEventListener('click', ...)`，导致点击 N 次后累计 2^N 个监听器，每次点击触发 2^N 次重渲染 → 面板卡死（重构前既有缺陷，抽取未引入但确实存在） | 用 `if (!list._scanClickBound) { addEventListener(...); list._scanClickBound = true; }` 仅绑定一次（递归调用 `renderScanList()` 仍正常） |
| **HD-2** | 🟠 MEDIUM | `OverlayScanEngine.scan` (L3855) | **契约破裂（潜伏）**：`scan()` 声明无参，但调用链 `OverlayDetector.scan(root, options)` / `OverlayService.scan(root, options)` 传入 `root`；函数体 4 处 `document.querySelectorAll` 忽略 `root`，任何传 root 的调用方都静默扫描顶层 `document` | 改为 `function scan(root, options)`，引入 `const scope = (root && typeof root.querySelectorAll === 'function') ? root : document;`，4 处查询改 `scope.querySelectorAll`（无 root 时行为不变） |
| **HD-3** | 🟡 LOW | `OverlayScanEngine` nav 拦截 (L4202/4230/4248/4273/4293/4311) | **内存泄漏（死累加器）**：`_navBlocked` 数组 5 处 `.push` 但全文件无任何读取/清空逻辑，长会话无限增长；数据从未被消费 | 移除声明 + 5 处 `.push`（保留 `Log.warn` 拦截日志副作用） |
| **HD-4** | 🟡 LOW | 注释 (L9265 一带) | **陈旧/矛盾注释**：「删除 OverlayAdScanner.deepScan 整段」与实际代码矛盾——`deepScan` 仍存在且被 `OverlayService.deepScan({deep:true})` 调用 | 改写为准确描述：deepScan 保留，高阶特征仅在 `opts.deep` 启用且肤色采样限定可点击图片（H3 性能约束） |
| **HD-5** | 🔴 险些引入 | `OverlayScanEngine` 清理过程 | **`ReferenceError` 风险**：移除 `_navBlocked` 声明时漏删 `window.open` 拦截器内一处 `.push`，运行时会抛 `_navBlocked is not defined`（仅浏览器拦截被封域名跳转时触发，测试覆盖不到） | 门禁前 `grep` 复核发现并删除该残留 push；现 `_navBlocked` 仅存于解释注释，代码引用 0 |

**已核实为误报 / 不修复**：
- `protectInFrame({ iframe, el: iframe })` 传入空 `frameHost`/`selector`：经读 `WhitelistStore.isWhitelisted`/`_getAll` 确认——`isWhitelisted` 仅当 `entry.selector`（via `iframe.matches`）或 `entry.domain`（via hostname）为真才匹配；`_getAll` 还会 `filter(e => e.selector || e.domain)` 滤除空条目。故空条目**不会被误判为全局白名单**，非缺陷。
- `extractPseudoContent` 双推（url + text 项）：轻微重复，不致命，不修复。
- 空 `catch` 体（L4221 / L4463 / L4347）：均有注释且为有意降级（BlockEngine 未就绪回退快照 / 解码失败忽略 / 安全默认 false），非缺陷。

---

## 3. 代码审查交叉核对（引用完整性）

| 核对项 | 结果 |
|--------|------|
| `IframePanel` 调用的全部 `IframeGuard.*`（`getStats`/`_frameRecords`/`_liveFrames`/`_ensureRecord`/`_incStat`/`protectInFrame`/`blockInFrameNode`/`rescanAll`/`forceRescan`/`MIN_DEPTH`/`MAX_DEPTH`/`setMaxDepth`/`reapplyInFrames`/`invalidateBlockRules`） | ✅ 全部存在 |
| `OverlayScanPanel` 关键引用：`collectAll`（面板内局部闭包，非缺失）、`OverlayService.scan/deepScan`、`BlockEngine.scanInvisibleOverlaysAsync/showElement/hideElement/...` | ✅ 全部存在 |
| `ManagerPanel`/`SelectionPanel`：`BlockEngine._selectionNavLocked`（L1861 静态属性 + getter/setter 转发）、`storage.*` 全部方法 | ✅ 存在 |
| 面板内所有 `this.foo()` 对应 UIManager 真实方法（`clearPanel`/`makeDraggable`/`showToast`/`_trackDoc`/`shadowRoot`/...） | ✅ 无不存在的 `this` 方法 |
| 全文件 `super.` 引用 | ✅ 0（面板为普通函数，无类继承残留） |

---

## 4. 关键指标对比

| 指标 | v8.4 | v8.5 | 变化 |
|------|------|------|------|
| 文件总行数 | 10031 | 10035 | +4（注释/守卫，非膨胀） |
| 测试套件 / 用例 | 16 / 70 | **16 / 73** | +3（回归守卫） |
| `node --check` | ✅ | ✅ | — |
| UI 直接调用 `OverlayScanEngine.` | 0 | 0 | 保持（命名对齐） |
| 隐藏缺陷（HIGH/MED/LOW） | — | **4 修复 / 1 险些引入已拦截** | — |

---

## 5. 新增回归守卫（panel-extraction.test.js）

- `IframePanel.renderScanList binds the list click listener ONLY ONCE` —— 锁定 HD-1 修复（防监听器泄漏回潮）
- `OverlayScanEngine.scan honors root scope` —— 锁定 HD-2 修复（防 `scope` 回退为 `document`）
- `no dead _navBlocked accumulator` —— 锁定 HD-3 修复（防死累加器回潮）

---

## 6. 下一步建议（非本轮范围）

- **OverlayRuleSuggester 拆分**：设计 §3.5 列出 `OverlayRuleSuggester`，当前规则建议逻辑散布于面板 UI 层，未独立成模块。可后续抽离，但非必须（layering 已满足）。
- **`OverlayScanEngine` 体积**：仍是 ~826 行 IIFE，仅经 `OverlayDetector` 适配器聚合。与设计 v8.2「MANUAL-02 维持委托」一致——内联回归风险高，保持委托形态为务实选择。
- **其余面板 `await` 性能**：面板内 `await` 均位于事件处理器（点击/复制），无顶层阻塞，无需改造。
