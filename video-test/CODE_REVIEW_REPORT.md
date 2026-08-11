# Code Review — `video-accelerator.user.js`（v19.0.4）

> 审查方法：`code-review-and-qual` 五轴框架（正确性 / 可读性 / 架构 / 安全 / 性能）
> 审查对象：最近 3 个提交对脚本的累计改动（60 插入 / 48 删除）
> 提交：`f2128b4`(R1–R6 13 项) · `07344f2`(深度修复轮 3 项) · `d935125`(UI 渲染修复)
> 角色：独立审查者（Model B），复核 Model A 已落地修复

---

## 上下文（Context）

本次审查评估的是一组**已合并**的修复性提交，目标是消除结构性与功能性缺陷：

- 看门狗失效（Critical）：`_lastTime` 双归属 + `frameRecent` 逻辑倒置
- 安全加固（W5）：`postMessage` 通配源 → 同源目标
- 死代码清除：`canAutoPlay` / `Metrics` / `QUALITY_CHANGE_COOLDOWN_MS`
- 魔法数字提取：`TAKEOVER_SCORE` / `BOOST_THROTTLE_MS`
- UI 渲染修复（C5）：`_observeAdBlockerUI` 移入 UIManager
- 遥测/配置健壮性（F-D1/D2/D3、W3/W4/W9/C1）

改动均为**单文件、无对外接口变更**，符合「小型聚焦变更」标准（< 100 行语义改动）。

---

## 五轴审查（Five-Axis Review）

### 1. 正确性（Correctness）

| 改动 | 结论 | 证据 |
|------|------|------|
| `_lastTime` 单一归属（C2） | ✅ 正确 | 全文仅 `_stallCheck` 两处写入（L2405 基线重置 / L2453 进度更新），RVFC `step` 已不再写入。单一归属成立 |
| `frameRecent` 逻辑倒置（C2） | ✅ 正确 | `if (t === this._lastTime && !frameRecent)`：真卡死时 `frameRecent=false` 才进分支；Firefox 无 RVFC 时 `frameRecent` 恒 false，落回时间比较兜底，看门狗复活 |
| 缓冲阈值缺口（W3） | ✅ 改进（见 Optional） | 旧：`ahead<RECOVER(8) && ahead>=WARNING(5)` → 仅覆盖 5–8s，**1–5s 危险区被丢进 else**。新：`ahead<WARNING(5)` → 覆盖 0–5s |
| `_updateDependency` 空指针（C1） | ✅ 正确 | 先回写 `this._depEl` 再读局部 `el`，首调不再 `TypeError` |
| `_onBufferLow` 遥测等级 0→1（F-D1） | ✅ 正确 | 与同路径 `_record(session,1)` 等级对齐，UI/遥测不再显示错误等级 |
| `_bindSettings` input→change（W4） | ✅ 正确 | number/str 不再每键即写 storage + clamp 回填，可正常键入大值 |
| 死代码移除 | ✅ 无行为变化 | `canAutoPlay`/`Metrics`/`QUALITY_CHANGE_COOLDOWN_MS` 引用计数为 0，移除零风险 |
| 冗余 `this._lastEmergency=now`（F-D3） | ✅ 无行为变化 | 同 tick 内重复赋值，删除无影响 |
| `_canAttempt(session)` 签名清理 | ✅ 无行为变化 | 移除未用 `level` 形参及 2 处实参 |
| `MSG_TARGET`（W5） | ✅ 无功能回退（见安全轴） | 同源拓扑下投递正常；跨源 iframe 各自独立实例，原 `'*'` 亦会被接收侧 `e.origin` 校验拒绝 |

**无发现 Critical/Important 级正确性回归。** 前序修复经重读确认稳定。

### 2. 可读性 & 简洁性（Readability & Simplicity）

- ✅ 魔法数字提取（`TAKEOVER_SCORE`、`BOOST_THROTTLE_MS`）提升调参可见性
- ✅ 高风险修复均附解释性注释（C2/W3/W4/W5/C1），意图清晰，利于后续维护
- ⚠️ **Nit**：`minVideoArea` 上限 `Math.min(100000000, …)` 中的 `100000000` 仍是裸字面量，建议提取为具名常量（如 `MAX_VIDEO_AREA_PX2`）

### 3. 架构（Architecture）

- ✅ 改动外科式、单文件、无公共接口变更，符合「聚焦变更」原则
- ✅ `_observeAdBlockerUI` 移入 UIManager 类方法，内聚性提升（修复 C5 渲染问题）
- ✅ 未引入新的循环依赖
- ℹ️ 既有架构债（非本次引入，已 tracked）：4125 行上帝模块（MANUAL-A）、`Bus⇄Hook/Frame/Detect` 循环依赖（MANUAL-C）

### 4. 安全（Security）

- ✅ **正向发现**：`MSG_TARGET`（W5）为纵深防御加固。发送侧由 `'*'` 收紧至本源；接收侧本就强制 `e.origin` 校验。跨源 iframe 运行自身脚本实例，无投递损失。不透明源（`file://`/sandbox，origin 为 `'null'`）安全退回 `'*'`
- ✅ `_observeAdBlockerUI` 仅对自有 `va-ui-host` 恢复 `display:''`，无 XSS/注入面
- ✅ 本次改动无密钥泄露、无 SQL 拼接、无外部数据越权使用

### 5. 性能（Performance）

- ⚠️ **Optional**：`_observeAdBlockerUI` 的 `MutationObserver` 现配置 `attributes:true, subtree:true` 于 `document.documentElement`，会**记录整棵文档所有 style/class 属性变更**。在 SPA / 广告密集页上，这是持续开销（浏览器需为每次属性突变排队，回调对绝大多数非 host 目标早退）。建议拆分：
  - 对 `document.documentElement` 仅保留 `childList:true, subtree:true`（捕获 host 被注入）
  - 对具体 `va-ui-host` 节点单独 `observe(host, { attributes:true, attributeFilter:['style','class'] })`（仅监听单节点属性）
- ✅ 其余路径无新增热循环 / 无界操作

---

## 验证情况（Verify the Verification）

| 项 | 结果 |
|----|------|
| `node --check video-accelerator.user.js` | ✅ SYNTAX_OK |
| 单元测试 `unit-tests.js` | ✅ 150/150 |
| 核心模块 `core-module-tests.js` | ✅ 50/50 |
| **测试是否加载生产代码？** | ❌ **否**（grep 确认 0 处 `require/import` 真实产物，逻辑全部内联重实现） |

> ⚠️ **最重要的审查结论**：200 条断言全过，但**对本次审查的 60 行插入 / 48 行删除零覆盖**。上述所有「正确性 ✅」均来自**人工代码阅读**，而非自动化回归。这是一个**既有架构债**（已 tracked 为 MANUAL-B），非本次引入，但意味着这些修复的回归保护目前为 0。

---

## 发现分级（Findings by Severity）

- **(Important · 必跟进项)** 验证缺口：测试套件不加载真实产物（覆盖率幻觉）。需执行 MANUAL-B——重构测试为 `import` 编译产物，并为 `VideoSession` / `RecoveryOrchestrator` / `FrameMesh` 补契约测试。**不阻塞本次合并**（属既有债），但必须 tracked。
- **(Optional)** 缓冲警告带：建议将 `_bufferCheck` 第二分支改为 `ahead < VA_BUFFER.BUFFER_LEVEL_RECOVER`（覆盖 0–8s），在保留 0–5s 修复的同时，恢复原意图中的 5–8s 轻推带（当前写法将 5–8s 落回 else，未做预加载增强）。
- **(Nit)** `minVideoArea` 上限字面量 `100000000` 提取为具名常量。
- **(Optional)** `MutationObserver` 属性监听收窄至 `va-ui-host` 单节点（性能，见性能轴）。
- **(FYI)** `_updateDependency` 仍假设 `this._panel` 非空；加 `_panel` 空值守卫可更健壮（既有，非本次引入）。
- **(FYI)** `MSG_TARGET` 收紧正确，无需动作。

---

## 结论（Verdict）

### ✅ **Approve — 可合并**

本次变更是明确的**净健康度提升**：修复 2 个 Critical 级看门狗 bug、1 项安全加固、清除死代码、提取魔法数字、修正遥测/配置健壮性。改动外科式、注释充分、无接口变更、无正确性回归。

**前置条件（非阻塞）**：将「验证缺口」(MANUAL-B) 继续 tracked 至后续迭代完成；Optional/Nit 项可在下个清理轮处理。

---

*审查完成于 2026-08-11 · 五轴框架 · 独立审查（Model B）*
