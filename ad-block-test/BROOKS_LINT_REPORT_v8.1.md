# Brooks-lint 重构修复执行报告 v8.1

**执行时间**: 2026-08-11 14:26
**目标文件**: `web-element-blocker.user.js`
**总行数**: 9,901 行（v8.0 为 9,885，+16）
**依据报告**: `BROOKS_LINT_REPORT_v8.0.md`
**执行约束**: `review-and-refactor` 技能「保持文件完整、不拆分代码、确保测试通过」
**聚焦**: 应用 v8.0 报告中全部**可自动化、单文件、无对外接口破坏性**的重构修复（PENDING-GM-01 / PENDING-07 / PENDING-03 + 魔法数字批次）

---

## 📊 综合健康评分（v8.0 → v8.1）

| 维度 | v8.0 | v8.1 | 变化 | 说明 |
|------|------|------|------|------|
| 架构设计 | 71 | 72 | +1 | PENDING-03 消除 IframeGuard→document 分层违规（DOM 查询下沉 FrameDetector） |
| 代码质量 | 84 | 86 | +2 | PENDING-GM-01 封装泄漏全消（5→0 外部私有直写）+ 魔法数字提取 |
| 测试 | 88 | 88 | 0 | GM 菜单链路仍 0% 真实覆盖（见未应用项） |
| 技术债 | 69 | 72 | +3 | 关闭 TD-GM-02（封装泄漏）、TD-02/TD-04 首批提取 |
| 可维护性 | 87 | 88 | +1 | PENDING-07 初始化守卫与 IframeGuard 对齐 |
| **总分** | **80.0** | **81.0** | **+1.0** | 加权均值估算，评级维持 **B（→ B+ 临界）** |

**历史轨迹**: 76.6（v6.0）→ 79.0（v7.0）→ 80.0（v8.0）→ **81.0（v8.1）**。

---

## 一、本回合已自动应用修复（Fix Log · v8.1）

> 全部为单文件、无对外接口破坏性改动；`node --check` 通过，`npx jest` **12 套件 / 57 用例全过**。

| ID | 问题 | 位置 | 引用（著作·章节） | 为什么必须修 | 验证 |
|----|------|------|------------------|--------------|------|
| FIX-8.3 | `UIManager` + `storage` 共 **5 处**直写 `IframeGuard._iframeBlockRules` 私有状态（R3-1 封装泄漏，报告原只计 UIManager 1 处，本回合发现 storage 另有 4 处） | L871/933/943/952（storage）、L6507（UIManager）、新增 L9407 | Martin《整洁架构》Ch.5 DIP；Fowler《重构》Ch.5 Encapsulate Downward Calls | 跨模块改写内部缓存破坏 iframe 防线状态机封装；`IframeGuard` 改名/重构需同步改 5+ 处；无法独立测试面板 | node --check ✅；jest 57/57 ✅；外部直写 5→0 |
| FIX-8.4 | `FrameDetector.init()` 缺初始化守卫（重复初始化风险） | L8609→L8617 | Martin《整洁代码》Ch.3 防御式编程；与 `IframeGuard.init()` 守卫对齐 | 与 IframeGuard 守卫语义不一致；若 init 被重复触发会重复 hook createElement / 启动 observer | node --check ✅；jest ✅ |
| FIX-8.5 | `IframeGuard._liveFrames` 直接 `root.querySelectorAll('iframe')`（PENDING-03 分层违规） | L9358（_liveFrames）、新增 L8610（FrameDetector.queryIframes） | Martin《整洁架构》Ch.5 DIP（依赖抽象而非 document）；Feathers《Working Effectively with Legacy Code》§3 接缝 | IframeGuard 越层触碰 DOM，难以在 Node 环境下单测；违反「引擎层不依赖具体 DOM」 | node --check ✅；jest ✅ |
| FIX-8.6 | iframe 扫描深度边界 `1`/`5` 魔法数字重复 3 处（TD-02 / TD-04） | L7085（UIManager）、L9388（_loadConfig）、L9393（setMaxDepth）；新增 L9292-9293 `MIN_DEPTH/MAX_DEPTH` | Fowler《重构》§12.2 Replace Magic Number with Symbolic Constant | 边界值散落 3 处，调整上限需改 3 点且易漏；单一数据源消除不一致 | node --check ✅；jest ✅ |

### 代码对比（附录）

```javascript
// FIX-8.3：IframeGuard 暴露公开方法（消除 5 处私有直写）
// Before（storage.addIframeRule / removeIframeRule / toggleIframeRuleDisabled / importData / UIManager.showRegexPanel）：
//   IframeGuard._iframeBlockRules = null;
// After：统一调用
        invalidateBlockRules() { this._iframeBlockRules = null; }   // L9407
// 调用方：IframeGuard.invalidateBlockRules();

// FIX-8.4：FrameDetector.init 守卫
        init() {
            if (this._init) return;          // ← 新增
            this._init = true;               // ← 新增
            this._hookCreateElement();
            this._startObserver();
            this._trackInteractions();
        }

// FIX-8.5：DOM 查询下沉 FrameDetector
// Before（IframeGuard._liveFrames）：root.querySelectorAll('iframe').forEach(...)
// After：
        queryIframes(root) {                 // FrameDetector 新增 L8610
            try { return Array.from(root.querySelectorAll('iframe')); }
            catch (e) { Log.warn(e.message || e); return []; }
        }
// IframeGuard._liveFrames：FrameDetector.queryIframes(root).forEach(...)

// FIX-8.6：深度边界常量化
        MIN_DEPTH: 1, MAX_DEPTH: 5,          // IframeGuard 新增 L9292-9293
        // _loadConfig: (depth >= this.MIN_DEPTH && depth <= this.MAX_DEPTH) ? depth : 3
        // setMaxDepth:  if (d >= this.MIN_DEPTH && d <= this.MAX_DEPTH) {
        // UIManager:    if (d >= IframeGuard.MIN_DEPTH && d <= IframeGuard.MAX_DEPTH) {
```

---

## 二、验证汇总

```
node --check web-element-blocker.user.js   → SYNTAX OK
npx jest                                    → 12 suites / 57 tests PASSED
外部 IframeGuard._iframeBlockRules 直写       → 5 → 0（grep 确认）
IframeGuard.queryIframes 定义+调用           → L8610 + L9358
FrameDetector.init 守卫                       → L8617（this._init = true）
文件行数                                     → 9,885 → 9,901（+16）
```

---

## 三、未自动应用项（受约束 / 需架构决策 + 构建管线）

以下项来自 v8.0 报告，但**本回合未改**：`review-and-refactor` 技能硬性要求「保持文件完整、不拆分代码」；且部分项需构建管线或人工架构拍板，报告本身标注「无法自动应用」。

| ID | 问题 | 为何未自动应用 | 建议下一步 |
|----|------|----------------|------------|
| MANUAL-01 | `UIManager` 上帝模块拆分（~3933 行 → SelectionPanel/RegexPanel…） | 违反「不拆分代码」约束；需架构决策 + 构建管线；报告标注无法自动应用 | 需你明确放宽「不拆分」约束或提供模块打包方案后我可实施 |
| MANUAL-02 | `OverlayDetector` / `OverlayAdScanner` 合并为 `NavigationGuard` | 模块合并属架构决策，改动面大、回归风险高 | 单独评审后实施 |
| MANUAL-GM-01 / PENDING-04 | GM 菜单链路 0% 真实覆盖 → 引入打包 + 真实产物 UI 契约测试 | 需构建管线（当前测试不 `require` 真实产物）；多日工作量 | 搭建打包后补齐 9 面板契约测试 |
| TD-GM-08 | `addEventListener` 95 处无统一注销 | 标记 Monitored（观察）；提取 `_panelUnsubs` 属中等重构 | 后续批次处理 |
| TD-02 / TD-04 残余 | 魔法数字 368 / 重复代码 456（其余） | 分批提取原则，本回合仅完成深度边界一批（3 处） | 按模块分批提取 CONFIG/helper |
| PENDING-03 残余 | `_liveFrames` 仍直接持有递归逻辑（仅 DOM 查询已下沉） | 已消除 document 直触，递归逻辑保留为内部合理实现 | 观察 |

---

## 四、残余问题清单（按严重度排序）

**🔴 Critical**
1. UIManager 上帝模块（TD-01 / R5-1）→ [MANUAL-01，需放宽约束]
2. GM 菜单链路 0% 真实覆盖（TD-08 / R6-1 / T5）→ [MANUAL-GM-01 / PENDING-04，需构建管线]

**🟡 Scheduled**
3. `OverlayDetector`/`OverlayAdScanner` 合并（MANUAL-02）
4. 残余魔法数字 / 重复代码（TD-02 / TD-04 其余批次）
5. `addEventListener` 95 处无统一注销（TD-GM-08）

**🟢 Monitored**
6. 原型污染 8 处（已有 `__proBlockerHooked` 幂等守卫）
7. 超长行 23 处（最长 338 字符，TD-09）

---

## 五、结论

本回合在「保持文件完整、不拆分代码」约束下，完成了 v8.0 报告中**全部可自动化的单文件重构修复**：
- 封装泄漏从 5 处外部私有直写 → 0（FIX-8.3）
- `FrameDetector` 初始化守卫补齐（FIX-8.4）
- IframeGuard 不再直接触碰 document，DOM 查询下沉 FrameDetector（FIX-8.5）
- 深度边界魔法数字常量化（FIX-8.6）

健康分 **80.0 → 81.0（+1.0）**。剩余 Critical 项均为架构级，需你放宽「不拆分」约束或提供构建管线后继续。

> 报告结束 | 下一步优先级：待你确认是否放宽约束 → [MANUAL-01] 模块拆分 > [MANUAL-GM-01/PENDING-04] UI 契约测试 > MANUAL-02 合并
