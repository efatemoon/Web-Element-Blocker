# 代码审查报告 · video-accelerator.user.js（独立复核）

> 审查方式：五轴框架（正确性 / 安全 / 架构 / 可读性 / 性能）+ `node --check` 语法校验 + 测试套件 + 针对性复核（验证既有修复是否真正落地、检索新引入问题）。
> 审查日期：2026-08-11
> 文件：`D:\github repositories\ad-block\video-accelerator.user.js`
> 行数：**4141**（既有审查覆盖 4008，本次较之上次 +133 行）

---

## 一、方法论与验证基础

| 验证项 | 结果 |
|--------|------|
| `node --check` 语法校验 | ✅ 通过 |
| 单元测试 `video-test/unit-tests.js` | ✅ 150/150 通过 |
| 核心模块测试 `video-test/core-module-tests.js` | ✅ 50/50 通过 |
| 既有修复落地复核（C1/C2/M1-M4/P4） | ✅ 全部确认已落地（见第二节） |
| 常量引用一致性（VA_TUNING / VA_BUFFER，34 键） | ✅ 定义 34 / 引用 34 / 缺失 0 / 未用 0 |
| XSS 面扫描（innerHTML / eval / new Function） | ✅ 无动态数据注入 |

> 注：既有审查报告声称「未发现针对本文件的单元测试」，该结论已过时——当前仓库已有 `video-test/unit-tests.js` 与 `core-module-tests.js` 共 200 个用例，且全部通过，覆盖 `VideoSession`、`CandidateArbiter`、`SessionManager`、`ConfigManager` 等关键模块。

---

## 二、既有问题复核（已全部修复并确认落地）

| 编号 | 位置 | 修复内容 | 复核结论 |
|------|------|----------|----------|
| C1 | `_flushSettings` 3715 / `_syncSettings` 3736 | 未打开过面板时 `_synced` 为 false，`_flushSettings` 直接 return，杜绝配置被静默清空并持久化 | ✅ 已落地，`if (!this._synced) return;` 在 3715 行核验存在 |
| C2 | `score()` 1922-1930 | `this.sessions.size` → `SessionManager.hasActiveSessions()`，并加 `typeof SessionManager !== 'undefined'` 守卫。**既有审查曾担心该修复回归，本次复核确认已正确落地** | ✅ 已落地，降权逻辑重新生效 |
| M1 | `CandidateArbiter._evaluate` 1873 | 删除会清空全部在跟踪候选的 `queue.clear()`，仅保留「过滤已断连候选」 | ✅ 已落地 |
| M2 | `_evaluateStale` 1885-1887 | 先缓存 `beforeSize` 再覆盖 `this.queue`，日志 before/after 计数正确 | ✅ 已落地 |
| M3 | `_onError` 2179 | 排除 `MEDIA_ERR_ABORTED`（code=1），避免用户主动停止误触发紧急恢复 | ✅ 已落地 |
| M4 | `FrameMesh._initListener` 837 | 接收侧增加 `e.origin !== PW.location.origin` 同源校验 | ✅ 已落地 |
| P4（扫描） | Detector 1424 | `querySelectorAll('*')` 全量遍历改为 `querySelectorAll('[class],[id]')` | ✅ 仅剩注释，全量扫描已消除 |
| P4（常量） | 顶部 VA_TUNING/VA_BUFFER（75-116） | 31 项魔法数字集中为命名常量 | ✅ 已落地，34 键全部被引用且无悬空 |
| FIX-9 | `_bindSettings` 3708 | checkbox 由 `input` 事件改为 `change` 事件，修正读到旧 checked 值 | ✅ 已落地 |

---

## 三、五轴评估

### 1. 正确性 — **B+（良好）**
- 配置层 `ConfigManager._normalize()` 对数值 `clamp`、对 `logLevel` 白名单、对布尔键强制 `!!`，迁移（v18→v19）完备，输入校验严谨。
- 恢复路径多重节流：`ERROR_RECOVER_THROTTLE_MS`(2500) + `_lastEmergency` 闸门；`_autoTried >= 3` 上限防止自动播放死循环；`_onError` 排除 `MEDIA_ERR_ABORTED`。
- 监听生命周期正确：`const L = this.listeners`（2078），`destroy()` 调 `this.listeners.removeAll()`（2700）；会话在视频移除（2303）与巡逻清理（2965）时均被销毁，**无监听器泄漏**。
- **[Nit] 数值 0 被吞**：`_syncSettings`/`_flushSettings` 中 `parseInt(el.value, 10) || cfg.def`，当用户有意将 `minVideoArea` 设为 `0`（语义为「忽略面积门槛」）时，`0 || cfg.def` 会回退为 `cfg.def`(8000)，丢失用户意图。建议改为 `const n = parseInt(el.value,10); value = isNaN(n) ? cfg.def : n;`。属边缘场景，不影响崩溃。

### 2. 安全性 — **B+（良好）**
- **无 XSS 面**：全文件仅 3 处 `innerHTML`，其中 3359 行为**静态模板字面量（零 `${}` 插值）**，3933/3977 行为空字符串清空——均不注入动态数据。其余 UI 一律 `textContent`/`className`/`dataset`。
- `postMessage` 收端已强制同源校验（837）；发送端在 `MSG_TARGET` 收紧为本源、不透明源退化为 `'*'`（54-59）。`VA_REQ_CFG` 响应仅向通过 origin 校验的 `e.source` 回发。
- `importJSON`/`applyRemote` 均校验「对象且非数组」，阻断直接注入。
- **[Consider · 低危防御加固] 原型污染**：`importJSON`(483) 与 `applyRemote`(502) 使用 `Object.assign({}, this.defaults, obj)`。若导入 JSON 含 `__proto__` 键，V8 的 `Object.assign` 会将该键视为原型 setter，污染 `this._cache` 对象的原型。影响有限（输入仅来自用户粘贴或同源帧，且仅作用于缓存对象、不波及全局 `Object.prototype`，且 `_normalize` 只读写已知键），仍建议改用 `Object.create(null)` 作目标或解析时剔除 `__proto__`，属纵深防御。
- 空 `catch {}` 共 **103 处**：经抽样，绝大多数包裹跨文档（`contentDocument`）、跨域 `postMessage`、`GM_*` 存储、`hls.js` player 方法、iframe 属性访问——在「注入任意页面」的 userscript 中属**有意为之的防御性容错**（跨域访问抛 `SecurityError` 是常态），删除会引入回归。**不视为缺陷**。

### 3. 架构 — **B+（良好）**
- 分层清晰：感知(Detector) → 裁决(CandidateArbiter) → 会话(SessionManager/VideoSession) → 自愈(RecoveryOrchestrator) → 观测(UIManager)，EventBus 解耦。
- `WeakMap`/`WeakSet`（PlayerRegistry、pool、seen、remote）GC 友好；`ListenerBag` 集中管理监听增删。
- 调度器 `GlobalScheduler` 120ms 自调度轮询，idle 时无视频仍空转——属设计取舍，开销可控，非缺陷。

### 4. 可读性 — **B（良好）**
- 命名清晰、分区注释到位、`VA_TUNING`/`VA_BUFFER` 常量语义自解释。
- **[Optional]** `UIManager` 约 1017 行，内联 CSS（~300 行）与逻辑混于构造器，可单独抽取便于维护，但非必须。
- 魔法数字已从散落字面量集中为命名常量（34 项），可维护性较初版显著提升。

### 5. 性能 — **B（良好）**
- 扫描上限 `SCAN_VIDEO_CAP=800` / `SCAN_SHADOW_CAP=250`，shadowRoot 宿主仅遍历带 `class/id` 元素，避免超大 DOM 全量遍历。
- 带宽探测 `estimateBandwidth` 有 5s 缓存；`FrameMesh` 按 `frameId` 30/s 限流。
- **[Optional]** Detector 在加载时 `setTimeout(refresh, 800/2000)` 进行两次刷新，大页面下为轻微重复开销，无功能影响。

---

## 四、本次复核新增发现（非阻塞）

| 级别 | 位置 | 问题 | 建议 |
|------|------|------|------|
| **Nit** | `_syncSettings` 3742 / `_flushSettings` 3724 | `parseInt(el.value,10) || cfg.def` 将合法的 `0` 吞掉（`minVideoArea=0` 语义丢失） | 改用 `isNaN` 判断：`const n=parseInt(el.value,10); value = isNaN(n)?cfg.def:n;` |
| **Consider（低危）** | `importJSON` 483 / `applyRemote` 502 | `Object.assign({}, defaults, obj)` 在 obj 含 `__proto__` 键时污染缓存对象原型 | 目标改用 `Object.create(null)`，或解析时剔除 `__proto__`（纵深防御，影响有限） |

---

## 五、验证情况

- ✅ `node --check video-accelerator.user.js` → 语法通过
- ✅ `node video-test/unit-tests.js` → 150/150 通过
- ✅ `node video-test/core-module-tests.js` → 50/50 通过
- ✅ 跨模块数据流（Detector→Arbiter→SessionManager→RecoveryOrchestrator→UIManager）关键路径与监听生命周期已抽样追踪
- ✅ 既有 6 项问题（C1/C2/M1-M4）+ P4 可维护性优化经本次复核**确认全部真实落地，无回归**

---

## 六、结论（Verdict）

**Approve — 可合入日常使用。**

代码经过多轮审查与修复后处于健康状态：既有报告所指出的正确性/安全问题均已确证修复且无回归；架构分层清晰、安全面（XSS + 跨帧同源校验）到位、常量管理规范、测试覆盖充分（200/200 通过）。本次独立复核未发现有阻塞性的新缺陷，仅提出 1 项边缘正确性 Nit 与 1 项低危纵深防御建议，两者均可在后续迭代中顺手处理，不阻碍本次发布。

> 整体健康评分维持 **85/100（B+）** 区间合理。
