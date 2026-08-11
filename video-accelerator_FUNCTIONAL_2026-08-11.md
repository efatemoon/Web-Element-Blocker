# video-accelerator.user.js — 功能验证报告（驱动真实代码）

日期：2026-08-11
文件：video-accelerator.user.js（4141 行）
方法：javascript-testing-patterns（AAA + 边界用例 + 依赖 mock）+ brooks-harness 质检门禁纪律
      **关键差异**：用 jsdom 真实加载文件（在 IIFE 末尾导出内部类后 eval），直接驱动真实函数，
      而非既有套件"在测试文件内重声明本地副本"的做法。

## 验证基础设施
- `video-test/_loader.cjs`：jsdom 注入 window/document/GM_*/location 等浏览器全局，
  在文件 IIFE 末尾注入 `globalThis.__VA_EXPORTS__`，导出全部内部类后 eval 真实源码。
  真实文件成功启动（BOOT_OK，导出 22 个内部标识符）。
- `video-test/functional-tests.cjs`：require loader，对真实导出的类/函数逐个模块写边界测试。

## 逐项功能核查（9 组 / 60 断言，全部通过）

| # | 模块 | 验证点 | 结果 |
|---|------|--------|------|
| 1 | 纯函数 clamp / isVideoResource / isLive / isVisible / videoArea / getHost | clamp 边界与 NaN→下限；视频资源正则；isLive；可见性；面积；host 解析 | ✅ |
| 2 | ConfigManager._mergeConfig | `__proto__`/`constructor`/`prototype` 注入被剥离（原型污染防御）；null override 安全 | ✅ |
| 3 | ConfigManager._normalize | 各数值 clamp 上下限；`minVideoArea=0` 保留（不被吞）；logLevel 白名单回退；bool 强制 | ✅ |
| 4 | ConfigManager 导入导出 | importJSON 合法/数组拒绝/非法 JSON 不抛/`__proto__` 不污染；applyRemote；set/get；save→Storage 持久化 | ✅ |
| 5 | estimateBandwidth | 无资源时返回有限数字（0），不抛 | ✅ |
| 6 | SessionManager.hasActiveSessions | 初始 false；加入→true；移除→false（C2 守卫） | ✅ |
| 7 | CandidateArbiter.score | 评分数学精确校验（清晰视频=137）；有活动会话且无 gesture → 扣 25；gesture 豁免并加奖励=162 | ✅ |
| 8 | CandidateArbiter._evaluate | 在线候选被评估；断连候选自动移出 queue（防泄漏） | ✅ |
| 9 | UIManager._flushSettings | `minVideoArea=0` 经设置层端到端保留（验证之前修复生效）；数字/checkbox 正确写入 | ✅ |

## 发现并修复的真实 Bug（1 项）
**`isLive(null)` 返回 `null` 而非 `false`（契约违反）**
- 位置：70 行 `isLive`
- 原：`return v && v.duration === Infinity;` —— 当 `v` 为 `null` 时，`null && x` 结果为 `null`（非布尔）。
- 影响：boolean 上下文中 `null` 为假值，实际使用（如 `ctx.live`）无害；但函数契约声明"非视频返回 false"，类型不严谨。
- 修复：改为 `return !!(v && v.duration === Infinity);`（始终返回布尔）。
- 验证：纳入功能测试组 1，重跑通过。

## 测试桩校准记录（非代码 bug，仅 jsdom 限制）
初次跑出 7 项失败，经分析 6 项属测试桩问题，已修正：
- `isVisible` 未挂载元素 `isConnected=false` → 直接返回 false：测试元素须 `appendChild` 到 document。
- `videoArea` 读 `getBoundingClientRect`：mock 须覆盖该方法而非 `offsetWidth`。
- `getHost('not a url')` 被 `new URL(rel, base)` 当相对 URL 解析为 `example.com`（行为正确）：
  改用绝对非法 URL `'http://'` 验证"非法→空串"。
- Storage key：用真实常量 `va_config_v19_0`（原猜错）。
- gesture 评分：忘了 gesture 还叠加 `GESTURE_BONUS`，断言改为 `expected + GESTURE_BONUS`。
- `isLive(null)` 即上方真实修复。

## 最终质检门禁（brooks-harness 纪律）
| 项 | 结果 |
|----|------|
| `node --check` 语法 | ✅ |
| 单元测试 `unit-tests.js` | ✅ 150/150 |
| 核心模块 `core-module-tests.js` | ✅ 50/50 + 补充 3/3 + tryPlay 2/2 |
| 功能测试 `functional-tests.cjs`（真实代码） | ✅ 60/60 |
| **合计** | **265/265 全绿，无回归** |

## 结论
对真实代码逐模块功能核查：**发现并修复 1 个真实小 bug（isLive 返回类型）**，
其余功能路径（配置合并/归一化/导入导出、评分仲裁、会话守卫、UI 设置 0 值保留、
断连清理）均验证正常。功能层面无遗留错误。

> 既有"重声明副本"式测试（unit/core）仍保留并全绿；新增 `functional-tests.cjs` 直接驱动
> 真实代码，作为后续回归基线。
