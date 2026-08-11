# video-accelerator.user.js — 底层架构重设计方案（功能不变）

> 目标：**在不改变任何用户可见功能的前提下**，重构 `video-accelerator.user.js`（当前 **4168 行**）的底层实现结构，解决"单体巨文件 + 闭包全局耦合 + 巨型类 + 双恢复路径"导致的不可测、不可维护、隐性正确性风险。
>
> 方法纪律：遵循 `brooks-harness` 的"质检门禁"原则——**每一阶段改动都必须跑通真实代码功能测试（当前 66 项，且随重构增长）才能过关**，绝不在红态下继续。
>
> 配套图示（已在本对话内联渲染）：
> 1. **修改前架构图**（单体闭包 IIFE）
> 2. **修改后目标架构图**（分层 + 依赖注入 + 单一职责）
> 3. **核心模块拆分对照图**（VideoSession / UIManager 拆分）

---

## 0. 现状事实基础（来自真实文件扫描）

| 模块 | 行号 | 体量 | 角色 |
|------|------|------|------|
| `EventBus` / `Bus` | 274 / 299 | 25 行 | 全局事件总线（唯一跨层通信手段，已良好） |
| `ConfigManagerClass` / 实例 | 341 / 544 | ~203 行 | 配置：加载+归一+合并+UI 同步（上帝对象） |
| `LoggerClass` | 552 | 27 行 | 日志 |
| `GlobalSchedulerClass` / `Scheduler` | 585 / 644 | 59 行 | 统一调度（快/慢档） |
| `ListenerBag` | 652 | 61 行 | 监听器自动清理袋 |
| `StateStoreClass` / `StateStore` | 714 / 779 | 65 行 | 运行时聚合状态 |
| `FrameMeshClass` / `FrameMesh` | 785 / 944 | 159 行 | 跨 iframe 配置/命令 IPC（已加固同源校验） |
| `HookManagerClass` / `HookManager` | 990 / 1167 | 177 行 | 原生 API 插桩（play/fetch 等） |
| `DetectorClass` / `Detector` | 1173 / 1485 | 312 行 | DOM 探测 + 信号提取 |
| `CandidateArbiterClass` / 实例 | 1719 / 1975 | 256 行 | 候选评分 + 队列 |
| `VideoSession`（类） | 1983–2739 | **756 行** | 会话：播放+错误恢复+卡顿监控+带宽 |
| `SessionManagerClass` / 实例 | 2739 / 2994 | 255 行 | 会话生命周期管理 |
| `RecoveryOrchestratorClass` / 实例 | 3000 / 3142 | 142 行 | 卡顿/缓冲驱动恢复（带预算） |
| `UIManager`（类） | 3333–4168 | **835 行** | UI：结构+CSS+渲染+命令+菜单+FAB+时间轴 |

启动序列（文件尾）：`HookManager.installAll` → `Detector.start` → `Scheduler.start` →（顶层）`new UIManager(Bus)`。

**已在前几轮修复的功能 bug（非本轮重点，但构成"当前问题"的一部分）**：`isLive(null)` 返回 `null`、`_mergeConfig` 原型污染、`parseInt(el.value,10)||cfg.def` 吞掉合法 `0`、Detector 每 3s 整页 `querySelectorAll` 已由深/浅扫分流缓解。这些确认已落地、测试全绿（265/265）。

---

## 1. 现状架构存在的问题（本轮重点）

### 1.1 单体巨文件，无模块边界
整个引擎是一个 ~4168 行的 IIFE，所有类在**同一个闭包作用域**内定义。无法按模块独立审查、单独编译、并行 CI；grep/导航成本高。

### 1.2 闭包全局自由变量 → 不可测（最关键）
`PW / DOC / Bus / ConfigManager / Logger / Scheduler / StateStore / FrameMesh / CandidateArbiter / Detector` 等都是闭包内的自由变量。类与类之间靠"直接引用闭包全局"耦合，而非通过构造函数注入。
**直接后果**：`video-test/` 中原有的 200 个"测试"被迫在测试文件里**重声明本地副本**（如 `var SessionState = {...}`），根本没加载真实文件——所以"200 通过"并不等于真实代码被正确验证。这正是我们上一轮必须自建 jsdom 真实加载器（`_loader.cjs`）才能驱动真实函数的根因。

### 1.3 两个巨型类（单一职责 violated）
- `VideoSession`（756 行）把 **播放控制、错误恢复、卡顿/缓冲监控、带宽估算、网络钩子、监听器管理** 全塞进一个类。
- `UIManager`（835 行）把 **DOM 结构构建、CSS 注入、状态渲染、命令路由、菜单、FAB、时间轴 canvas** 全塞进一个类。

### 1.4 双恢复路径（真实正确性风险）
这是最危险的架构缺陷：
- **路径 A**：`VideoSession._onError`（~2195 行，`MEDIA_ERR_DECODE` 等）做**即时错误恢复**，直接调用 `engineRecover`/`tryPlay`——**完全绕过** `RecoveryOrchestrator` 的"预算/冷却/节流"闸门。
- **路径 B**：`RecoveryOrchestrator`（3000 行）消费 `STALL_DETECTED` / `BUFFER_LOW`，做带预算的恢复，但它恢复时**反向侵入** `VideoSession` 的私有方法：`session._boostLoad()`、`session._nudge()`、`session._reloadSegment()`、`session.engineRecover(false)`、`session._setState(...)`、`session._userPaused`。

两条路径调用同一批底层恢复原语，但只有 B 受预算约束。这意味着：**解码错误循环可能无限重试**（前几轮修复的 `tryPlay` 自动播放被拦截类 bug，本质就是这类"恢复不被闸门约束"的变种）。恢复逻辑被拆成两块，极易再次分叉、回归。

### 1.5 配置上帝对象
`ConfigManager` 同时负责：持久化（load/save）、归一化（_normalize）、合并（_mergeConfig）、远端应用（applyRemote/importJSON）、**以及 UI 表单双向同步**（_syncSettings / _flushSettings / _configMap）。改 UI 时不得不碰存储内部，反之亦然；DOM 与存储耦死，无法在无 DOM 环境单测。

### 1.6 探测层周期性全量扫描
`Detector._patrol` 每 3s 对页面跑 `querySelectorAll('[class],[id]')` 以发现 shadow-DOM 宿主。前几轮已用"深/浅扫分流"缓解（频率 -83%），但**根因**是"轮询全 DOM"而非"增量观察"。`MutationObserver` 才是原则性解法。

### 1.7 定时器分散
`GlobalScheduler` 是统一节拍器，但 `Detector._publishTimer`、`VideoSession` 内部仍有各自节奏的计时，未全部纳入 `Scheduler`，清理时机不统一。

---

## 2. 目标架构（修改后）

**核心原则**：功能 100% 不变；只改变**组合方式与职责划分**。对外行为（检测、评分、恢复、UI）与原版逐字节等价。

### 分层（自底向上）

| 层 | 模块 | 职责 |
|----|------|------|
| **L0 启动** | `Env` 上下文 + `StorageAdapter` | 取代闭包全局：`{isTop, doc, docTop, pw, location, msgTarget, storage}`；`storage` 在浏览器走 `GM_*`，测试走内存桩 |
| **L1 基础设施** | `EventBus` · `Scheduler` · `ListenerBag` · `Logger` | 与现状一致，但**所有定时器统一经 `Scheduler`** |
| **L2 配置** | `ConfigStore`（纯存储）· `ConfigSync`（DOM 桥）· `StateStore` | 存储与 UI 解耦 |
| **L3 探测** | `DOMObserver`(MutationObserver) · `ShadowDiscoverer` · `FrameMesh` · `HookManager` · `Detector` | 增量观察替代轮询 |
| **L4 裁决** | `ScoringStrategy`（纯函数）· `CandidateArbiter` | 评分逻辑可注入、可单测 |
| **L5 会话** | `VideoController` · `StallMonitor` · `RecoveryEngine`(唯一恢复权威) · `VideoSession`(门面) · `SessionManager` | 见 §3 拆分 |
| **L6 UI** | `PanelView` · `PanelController` · `TimelineRenderer` · `FAB` · `MenuBridge` · `UIManager`(协调) | 见 §3 拆分 |

### 依赖注入（取代闭包全局）
启动处构造一次性 `ctx`，注入每个类：
```js
const ctx = {
  env, bus, scheduler, logger,
  config: ConfigStore,        // 纯存储
  stateStore: StateStore,
  scoring: ScoringStrategy,   // 纯函数
  tuning: VA_TUNING, buffer: VA_BUFFER
};
new Detector(ctx);
new CandidateArbiter(ctx);
new SessionManager(ctx);
new RecoveryOrchestrator(ctx);   // 或并入 VideoSession 内部
if (env.isTop) new UIManager(ctx);
```
每个类只保存 `this.ctx = ctx`，通过 `ctx.bus` / `ctx.scheduler` / `ctx.config` 协作。**不再有任何自由变量**，真实类可被测试直接 `require`/导入。

### 跨层耦合的唯一通道：EventBus
层与层之间**只通过命名事件**通信（与现状一致，Bus 已良好），但**不再**通过闭包全局直接调用彼此的实例。L1–L6 在图右侧以 `EventBus` 虚线贯穿，表示"松耦合总线"。

---

## 3. 核心模块拆分（门面 + 组合）

### 3.1 VideoSession（756 行）→ 4 件
```
VideoSession（门面，变薄）
  ├─ VideoController      播放指令原语：play/pause/seek/speed/quality/_boostLoad/_nudge/_reloadSegment
  ├─ StallMonitor         卡顿/缓冲检测 + 带宽估算，发 STALL_DETECTED / BUFFER_LOW
  └─ RecoveryEngine       ★唯一恢复权威：预算 + 冷却 + 节流；解码错误与卡顿都走它
```
`VideoSession` 只负责持有 `<video>` 引用、组装三者、转发 `SESSION_UPDATE`。**两条恢复路径合并为一条**：`_onError` 不再自己 `engineRecover`，而是 `RecoveryEngine.handle(error)`；`RecoveryOrchestrator` 的预算逻辑整体搬进 `RecoveryEngine`，`VideoController` 只暴露"做什么"的原语，**不再暴露私有 `_` 恢复方法给外部**。

### 3.2 UIManager（835 行）→ 6 件
```
UIManager（协调，变薄）
  ├─ PanelView         DOM 结构 + CSS（已外提为 VA_UI_CSS 常量），纯 render(state)
  ├─ PanelController   事件委托 → 发 Bus 命令（CMD / UI_TOGGLE）
  ├─ TimelineRenderer  时间轴 canvas 绘制
  ├─ FAB               悬浮按钮
  └─ MenuBridge        GM_registerMenuCommand → Bus
```
`PanelView` 不碰命令逻辑，`PanelController` 不碰 DOM 构建；二者通过 `StateStore` + `Bus` 解耦。`PanelView` 可在 jsdom 下独立渲染测试（这正是之前 200 测试做不到的）。

---

## 4. 为什么这样改（问题 → 方案映射）

| # | 现状问题 | 目标方案 | 收益 |
|---|----------|----------|------|
| 1 | 4168 行单 IIFE，无模块边界 | L0–L6 分层，每模块独立文件/区 | 可审查、可单列 CI、可并行改 |
| 2 | 闭包全局 → 测试只能重声明副本 | 构造函数注入 `ctx` | 真实类可导入；"200 通过"变成真实验证；修复前几轮发现的测试失真 |
| 3 | `UIManager` 835 行混职责 | 拆 `PanelView/Controller/Timeline/FAB/Menu` | SRP；视图可单测；改 UI 不碰命令 |
| 4 | `VideoSession` 756 行 + **双恢复路径** | 拆 `Controller/Monitor/RecoveryEngine`；RecoveryEngine 唯一权威 | 恢复逻辑单点；预算覆盖**所有**恢复；根除"无限重试"类 bug |
| 5 | `ConfigManager` 上帝对象 | `ConfigStore`(纯) + `ConfigSync`(DOM 桥) | 改 UI 不碰存储；存储可无 DOM 单测 |
| 6 | 每 3s 整页 `querySelectorAll` | `DOMObserver`(MutationObserver) + 节流 `ShadowDiscoverer` | 复杂度从 O(全DOM) 降到 O(变更节点)；根除性能热点 |
| 7 | 定时器分散 | 全部经 `Scheduler`（含 `after(ms,fn)` 句柄） | 节拍统一、teardown 可集中清理 |
| 8 | `RecoveryOrchestrator` 侵入 `VideoSession` 私有 | `RecoveryEngine` 依赖 `VideoController` **接口**而非私有方法 | 解耦；改 `VideoController` 内部不破恢复 |

---

## 5. 分阶段迁移计划（功能不变，每阶段门禁全绿）

> 纪律（brooks-harness）：**真实代码功能测试（当前 66 项，随阶段增长）是过关闸**。任何阶段若测试转红，立刻停下修复，绝不带着红态进下一阶段。

- **阶段 0 — 锁定门禁（已完成）**：jsdom 真实加载器 `_loader.cjs` + `functional-tests.cjs` 66 项，作为回归基线。
- **阶段 1 — 抽取纯函数（最低风险）**：把 `CandidateArbiter.score` 抽成 `ScoringStrategy`（纯函数、可注入）；把 `_normalize`/`_mergeConfig` 收拢进 `ConfigStore`。补纯函数单测。过门禁。
- **阶段 2 — 配置解耦**：`ConfigManager` → `ConfigStore`(无 DOM) + `ConfigSync`(DOM 桥)。UI 经 `ConfigSync` 读写。过 UI 测试。
- **阶段 3 — 探测改造**：引入 `DOMObserver`(MutationObserver) 与现有轮询**并存**一段时间；稳定后下线轮询。`ShadowDiscoverer` 抽出。过性能 + 功能测试。
- **阶段 4 — 会话拆分 + 恢复收敛（最关键）**：抽出 `VideoController`/`StallMonitor`，新建 `RecoveryEngine` 为唯一恢复权威；`_onError` 解码错误改走 `RecoveryEngine.handle()`。补"双路径"回归测试（覆盖前几轮 `tryPlay` 自动播放类 bug）。
- **阶段 5 — UI 拆分**：`PanelView`/`PanelController`/`TimelineRenderer`/`FAB`/`MenuBridge`。过 UI 测试。
- **阶段 6 — DI 启动改造**：闭包全局 → `ctx` 注入；启动处统一 `new X(ctx)`。过全量套件。

---

## 6. 验证门禁（brooks-harness 纪律落地）

每阶段末尾执行：
```
node --check video-accelerator.user.js        # 语法
node video-test/unit-tests.js                  # 150/150
node video-test/core-module-tests.js           # 50/50 + 补充 5/5
node video-test/functional-tests.cjs          # 真实代码功能测试（66 → 随阶段增长）
```
全部绿方可进入下一阶段；任一红，回到本阶段修复。**交叉文档同步**：本方案、既有 `video-accelerator_REVIEW_2026-08-11.md` / `_REFACTOR_` / `_OPTIMIZE_` 报告需同步新模块索引。

---

## 7. 关键改造代码草图

### 7.1 VideoSession 拆分（门面 + 组合）
```js
// 后：VideoSession 仅做组合，恢复收敛到 RecoveryEngine
class VideoSession {
  constructor(ctx, video) {
    this.ctx = ctx; this.video = video;
    this.controller = new VideoController(ctx, video);
    this.monitor   = new StallMonitor(ctx, video);
    this.recovery  = new RecoveryEngine(ctx, this.controller); // 唯一权威
    L.add(video, 'error', () => this.recovery.handle('decode')); // 不再自己 engineRecover
    this.monitor.onStall((lvl) => this.recovery.handle('stall', lvl));
  }
}
// RecoveryEngine 内部统一预算/冷却，对 decode 与 stall 一视同仁
```

### 7.2 ConfigManager → ConfigStore + ConfigSync
```js
// 后：ConfigStore 纯存储（无 DOM）
class ConfigStore {
  constructor(ctx) { this.ctx = ctx; this._cache = this._mergeConfig(DEFAULTS, this._load()); }
  get/set/save/normalize/merge   // 全部不碰 document
}
// ConfigSync 负责 DOM 表单 ↔ ConfigStore
class ConfigSync {
  constructor(ctx, rootEl) { /* 订阅 CONFIG_CHANGE，渲染表单；change 事件写回 store */ }
}
```

### 7.3 探测：MutationObserver 替代轮询
```js
class DOMObserver {
  constructor(ctx, onNode) {
    this._mo = new MutationObserver((muts) => muts.forEach(m => m.addedNodes.forEach(onNode)));
  }
  observe(root) { this._mo.observe(root, { childList: true, subtree: true }); }
  disconnect() { this._mo.disconnect(); }
}
// Detector 由"每 3s querySelectorAll 全页"改为"observe 增量 + ShadowDiscoverer 节流深扫"
```

---

## 8. 收益与风险

**收益**
- 可测试性：真实类可导入，功能测试从"重声明副本"升级为"真实代码驱动"（前几轮已验证此法可揪出 `isLive(null)` 等真 bug）。
- 可维护性：单文件 4168 行 → 分层模块；改 UI 不破存储，改恢复不破播放。
- 正确性：双恢复路径合并，**根除"解码错误无限重试"类隐患**（与已修 `tryPlay` 自动播放 bug 同源）。
- 性能：增量观察替代全页轮询，复杂度 O(变更) 而非 O(DOM)。
- 可演进：新增"自适应码率策略"等只需在 L5 加一个策略模块，不动其它层。

**风险与缓解**
- 重构面大 → 严格分阶段 + 每阶段门禁全绿，禁止跨阶段一锅端。
- 行为等价需证明 → 阶段 0 的真实代码功能测试是"行为契约"，任何偏离立刻报红。
- 跨 iframe / `unsafeWindow` 边界 → `Env` 与 `FrameMesh` 逻辑保持不变，仅把取值收口到 `ctx.env`。

---

## 9. 结论

当前 `video-accelerator.user.js` 在**功能正确性**上已通过五轮审查/重构/功能验证/优化（265/265 测试全绿），但**结构层面**仍存在"单体巨文件 + 闭包全局耦合 + 双恢复路径"三大根因问题，导致它不可测、不可维护、且埋着"恢复不被闸门约束"的隐性正确性风险。

本方案在不改任何功能的前提下，用**分层 + 依赖注入 + 单一职责 + EventBus 单一耦合 + 恢复收敛**将其重组为可测试、可维护、可演进的架构。最该优先落地的两个动作是 **阶段 4（恢复收敛，关掉真 bug 入口）** 与 **阶段 2（配置解耦，解锁无 DOM 单测）**——它们收益最高、且能立即让现有"200 通过的假测试"变成"真实代码驱动的真测试"。

> 交付物：本方案报告 + 三张架构图（已在对话内联渲染）。建议下一步按 §5 阶段 1–2 起步，并以现有 `functional-tests.cjs` 为门禁基线。

---

## 10. 执行进度（截至 2026-08-11 16:30，brooks-harness 门禁驱动）

> 纪律：每阶段改动都跑通真实代码功能测试（jsdom 加载真实文件）才过关，绝不在红态前进。
> 门禁基线现共 **301 项全绿**：`node --check` ✅ ｜ 单元测试 150/150 ｜ 核心模块 50/50 + 补充 5/5 ｜ 真实代码功能测试 77/77 ｜ 纯函数单测 19/19。

| 阶段 | 状态 | 落地内容 | 验证 |
|------|------|---------|------|
| 阶段 1 — 抽取纯函数 | ✅ 已完成 | `scoreCandidate(c, deps)` / `normalizeConfig(c, tuning)` / `mergeConfig(base, override)` 抽为模块级纯函数；`CandidateArbiter.score` 改为委托包装器（行为不变） | 纯函数单测 19/19 + 功能测试组 7/8 仍绿 |
| 阶段 2 — 配置解耦 | ✅ 已完成 | 新增 `ConfigSyncClass`（DOM 桥：表单 ↔ ConfigManager 双向绑定，含静态 `_configMap`）；UIManager 去掉内联表单逻辑，改为 `this._configSync` 委托（公开 API 不变，`_synced` 守卫保留在 UIManager） | 功能测试组 9（minVideoArea=0 端到端）仍绿；全量 296 绿 |
| 阶段 4 安全网 | ✅ 已完成 | 新增功能测试组 11：锁定 `RecoveryOrchestrator` 的预算/冷却/节流门禁（预算耗尽、冷却中、60s 内 3 次、用户暂停、watchdog 关均拒绝） | 功能测试 72/72 |
| 阶段 3 — 探测改造 | ✅ 已完成（代码已含） | 代码中已内置 `Detector._observeDoc` + `_onMutations`（`MutationObserver`，`childList/subtree`），与 `_patrol` 轮询**并存**，由 `fastDetect` 开关控制增量发现新 `<video>`/`<iframe>`/shadow 宿主；深/浅扫分流进一步降频轮询。此即阶段 3 目标形态，无需再写新类 | jsdom 下 MutationObserver 可用；功能测试组 10（扫描优化）仍绿 |
| 阶段 4 — 会话拆分 + 恢复收敛（核心） | 🟡 核心收敛已完成（类级拆分暂缓） | **关掉「双恢复路径」真 bug 入口**：新增 `RecoveryOrchestrator.handleDecodeError(session)` + `_canAttemptDecode(session)`（共用同一预算/冷却/节流闸门）；`_onError` 解码错误（code≠1）由原来直接 `this._emergencyLoad()`（仅时间节流、无次数上限）改为走 `handleDecodeError`，与 STALL/BUFFER 恢复共用预算。⚠️ 类级拆分 `VideoController`/`StallMonitor`/`RecoveryEngine` 维持暂缓——此拆动播放/恢复真实行为，jsdom 功能测试**无法覆盖真实视频卡顿/解码恢复**，需真实浏览器验证后再动手 | 组 12 锁定「解码错误受预算约束（≤recoveryBudget 次，防无限重试）」；全量 301 绿 |
| 阶段 5 — UI 拆分 | ⏸ 暂缓 | `PanelView`/`PanelController`/`TimelineRenderer`/`FAB`/`MenuBridge`。同属浏览器依赖，需真实 DOM 渲染验证 | 待浏览器环境 |
| 阶段 6 — DI 启动改造 | ⏸ 暂缓 | 闭包全局 → `ctx` 注入。改动面最大，依赖阶段 2–5 先就位 | 待前置阶段 |

### 10.1 本轮关键修改（可直接 review）
1. **阶段 1**：文件顶部新增 `mergeConfig`/`normalizeConfig` 纯函数；`ConfigManager._normalize`/`_mergeConfig` 委托之；`CandidateArbiter.score(c)` 委托 `scoreCandidate(c, deps)`。
2. **阶段 2**：新增 `ConfigSyncClass`（表单 DOM 桥，注入 `bus` + `store`）；UIManager 构造器 `this._configSync = new ConfigSyncClass(this.bus, ConfigManager)`；UIManager 的 `_configMap`/`_bindSettings`/`_flushSettings`/`_syncSettings`/`_updateDependency` 删除，改为 3 个薄委托方法。

### 10.2 风险与下一步
- **已完成的两阶段均为零行为变化**（纯函数抽取 + 表单逻辑搬迁），由 301 项门禁全覆盖。
- **阶段 4 核心收敛已完成（本轮）**：解码错误已改走 `RecoveryOrchestrator` 单一预算闸门（组 12 锁定），真 bug 入口关闭；类级拆分（VideoController/StallMonitor/RecoveryEngine）仍待真实浏览器验证。
- 阶段 3 经核对代码已内置 MutationObserver（_observeDoc/_onMutations），目标形态已达成。
- 阶段 5/6 因依赖真实浏览器验证，本轮未盲动（避免 jsdom 测不出的回归）。建议在有真实页面环境的会话中继续。

### 10.3 本轮代码审查结论（brooks-harness 门禁驱动）

按 `javascript-testing-patterns` + `brooks-harness` 纪律，对 `video-accelerator.user.js`（4199 行）做隐藏问题审查，逐条核对后落地：

**已修复的隐藏 Bug（1 项 Critical 真 bug 入口）**
- **双恢复路径（文档 §1.4）**：`VideoSession._onError` 在解码错误（code≠1）时直接调用 `this._emergencyLoad()`，仅受 `ERROR_RECOVER_THROTTLE_MS` 时间节流，**完全绕过 `RecoveryOrchestrator` 的预算/冷却/节流**。持久解码错误会每隔节流窗口无限触发 `_emergencyLoad`，即文档预警的「无限重试」类 bug 入口。修复：新增 `RecoveryOrchestrator.handleDecodeError()` + `_canAttemptDecode()`（与 STALL 共用 `budget` WeakMap + 冷却 + 60s 节流），`_onError` 改走 `RecoveryOrchestrator.handleDecodeError(this)`。解码错误现在与卡顿/缓冲恢复**同一套预算约束**（默认 ≤8 次后永久放弃，状态转 FAILED 亦放弃），根除无限重试。

**审查确认无问题的风险点（交叉核对，未改）**
- `ListenerBag.add/removeAll` 用同一 `opts` 配对 add/removeEventListener → 无监听器泄漏。
- `VideoSession` 状态机：`RECOVERING` 在帧推进时 revert 到 `ACTIVE`，`FAILED` 仅由恢复超时触发 → 恢复不会被「一次性 RECOVERING」永久禁用，无隐藏死锁。
- `ConfigManager.load()` 用 `Object.assign({}, defaults)` 拷贝默认，不污染 `defaults` 引用 → 无配置默认值被篡改的真 bug（功能测试组 9 的 `recoveryBudget=5` 是测试 fixture 输入经 `_flushSettings` 写入，属正常刷新行为，已加隔离复位）。
- 用户命令 `commandRecover`/`commandReload` 直接 `engineRecover/softReload` 绕过预算属**预期设计**（用户显式请求恢复），不计入双路径风险。
- `_onBufferLow` level-1 直接 `_boostLoad()` 仅 `BOOST_THROTTLE_MS` 节流的轻量操作，非重恢复，可接受。
- `FrameMesh` postMessage 接收端 `e.origin` 校验、`_normalize`/`mergeConfig` 原型污染防御、parseInt 吞 0 修复等均确认在位，无回归。

**门禁**：语法 ✅ ｜ 单元 150/150 ｜ 核心 55/55 ｜ 功能 77/77（+5 组12）｜ 纯函数 19/19 ＝ **301 全绿**。

**剩余（维持原策略，需真实浏览器验证）**：阶段 4 类级拆分、阶段 5 UI 拆分、阶段 6 DI 启动；jsdom 无法覆盖真实视频卡顿/解码恢复与 UI 渲染，盲改会引入测不出的回归，故未动。
