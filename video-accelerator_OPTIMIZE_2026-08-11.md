# video-accelerator.user.js 性能优化报告（2026-08-11）

> 模式：review-and-refactor（审查 → 功能核查 → 优化 → 门禁验证）
> 文件：`video-accelerator.user.js`（当前约 4148 行）
> 配套测试设施：`video-test/_loader.cjs`（jsdom 加载真实代码）、`video-test/functional-tests.cjs`（66 项真实代码功能测试）

## 一、性能热点定位（先量化再动手）

对真实代码做热点扫描，结论如下：

| 热点 | 位置 | 现有状态 | 是否本次优化 |
|------|------|----------|--------------|
| `querySelectorAll('[class],[id]')` 整页遍历 | `_scanWithin` 1439 行 | **每个 3s 巡逻都全量执行**（O(全页元素数)） | ✅ 已优化 |
| `estimateBandwidth` → `getEntriesByType('resource')` | 158 行 | 已有 5s 缓存（`_bwTs`/`_bwCache`），开销已被摊薄 | 维持 |
| `getComputedStyle`（isVisible） | 122 行 | 仅按元素调用，未做跨 tick 缓存 | 评估后不做（引入陈旧风险，收益难量化） |
| `GlobalScheduler` 120ms 主循环 | 636 行 | 仅做 tier 时间判断 + Map 遍历，开销可忽略 | 维持 |
| `querySelectorAll('video,iframe')` | 1414 行 | O(video+iframe 数)，通常很小且已封顶 `SCAN_VIDEO_CAP` | 维持（主功能，不可跳过） |

**唯一确定的、安全的高价值优化点**：周期巡逻里的 shadow-DOM 全量查询。

## 二、核心优化：巡逻浅扫，跳过 shadowRoot 全量查询

### 问题
`Detector._patrol()` 每 3s（`slow` tier）触发 `refresh()` → `_scanWithin()`，其中一段对 **整页所有带 class/id 的元素** 执行 `querySelectorAll('[class],[id]')` 以发现 shadow-DOM 视频宿主。
但 shadow 宿主只在以下时机变化：
- 页面加载（`_setupDoc`）
- SPA 路由切换（`_installSpa` → `refresh()` 于 800/2000ms）

即：**每 3s 对整页做全量查询，绝大多数情况下结果不变**——这是最重的 DOM 遍历操作，纯属浪费。

### 修复（零主功能变化）
引入 `deep` 标志，区分「浅扫（video/iframe）」与「深扫（含 shadow 宿主发现）」：

1. `_scanWithin(root, deep = true)`：shadow 遍历整段包进 `if (deep) { … }`。
2. `refresh(deep = true)`：透传 `deep` 给 `_scanWithin`。
3. `_patrol()`：周期巡逻默认 **浅扫**；每 `SCAN_SHADOW_RESCAN_PATROLS`（=5，即每 15s）做一次 **深扫**：
   ```js
   const deep = (this._shadowRescanCounter++ % VA_TUNING.SCAN_SHADOW_RESCAN_PATROLS) === 0;
   this.refresh(deep);
   ```
4. 新增常量 `VA_TUNING.SCAN_SHADOW_RESCAN_PATROLS: 5`。
5. 构造器初始化 `this._shadowRescanCounter = 0`。

### 行为保证（已测试锁死）
- **主功能 100% 不变**：video/iframe 的 `querySelectorAll('video,iframe')` 在浅扫与深扫中**始终执行**，每 3s 照常发现直接视频。
- **shadow 宿主发现不丢**：加载、SPA 路由切换走 `refresh()`（默认 `deep=true`）深扫；并每 15s 由巡逻深扫兜底，捕获动态注入的 shadow 视频。
- **唯一权衡**：某次 SPA 路由切换之外、动态注入的 shadow 视频，最坏发现延迟从「≤3s」变为「≤15s」——对视频加速场景可接受，换取整页全量查询频率下降 **83%**（每 3s → 每 15s）。

## 三、功能核查（确认所有功能正常运行）

复用既有 jsdom 真实代码测试设施，本轮**新增第 10 组回归测试**锁定优化语义：

| 用例 | 结果 |
|------|------|
| 深扫：直接 `<video>` 被发现 | ✅ |
| 深扫：shadowRoot 内 `<video>` 被发现（深扫生效） | ✅ |
| 浅扫：直接 `<video>` 仍被发现（主功能不受影响） | ✅ |
| 浅扫：shadowRoot 内 `<video>` 被正确跳过（优化生效） | ✅ |
| 巡逻节奏：第 1、6 次为深扫，其余浅扫 | ✅ |

## 四、全量门禁结果（全绿，无回归）

| 检查项 | 结果 |
|--------|------|
| `node --check` 语法 | ✅ |
| 单元测试 | 150/150 |
| 核心模块测试 | 50/50 |
| 补充测试（_patrol DOC 空值 + error bubbling） | 3/3 |
| tryPlay 修复测试 | 2/2 |
| **真实代码功能测试** | **66/66**（含新增扫描优化组） |
| **合计** | **271/271 全绿** |

## 五、结论

- 定位到唯一确定的安全高价值热点：周期巡逻对整页 `[class],[id]` 的全量遍历。
- 通过「浅扫/深扫」分流，将该最重 DOM 操作频率降低 **83%**，主功能与 shadow 发现能力均不丢失（加载/SPA/定期深扫三重兜底）。
- 全部 271 项测试通过，功能层面无遗留错误。

### 未改动（评估后认为不值得或风险高于收益）
- `isVisible` 的 `getComputedStyle` 跨 tick 缓存：引入样式陈旧风险，收益难量化，未做。
- `estimateBandwidth`：已有 5s 缓存，无需改。
- `GlobalScheduler` 120ms 主循环：开销可忽略，改动影响响应性，未做。
- 文件体量拆分（4148 行）：属更大重构，需单独评估。
