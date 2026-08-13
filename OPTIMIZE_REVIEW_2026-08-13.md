# web-element-blocker.user.js 架构优化 / 去冗余 / 降耦合审查报告

> 日期：2026-08-13（第二轮：C2/C4 结构性解耦落地）｜ 文件：`web-element-blocker.user.js`（约 10110 行）
> 方法：brooks-harness QA 门禁（每次改动后 `node --check` + 全量 jest，当前 136/136 通过）
> 锚定：`MENU_ITEMS` 9 项菜单（selection/regex/domain/overlay/manager/iframe/export/adguard/import）

---

## 1. 架构分析（锚定 MENU_ITEMS）

```
MENU_ITEMS(9) → PanelRegistry(OCP 分派 key→UIManager 方法) → UIManager(Shadow-DOM 协调器)
   ↓ .call(this)
9 面板模块：Selection/Regex/GlobalDomain/OverlayScan/Manager/Iframe/Export/AdGuardExport/Import
   ↓ 仅依赖服务端口（DIP）
OverlayService · StorageService(Proxy,唯一写端口) · RuleDomain · EventBus(iframe 解耦)
   ↓
引擎层：BlockEngine · OverlayDetector · IframeGuard+Frame* · DomainBlock
   ↓
StorageManager(GM 持久化)
```

`_buildMenu` 为纯分派（无 if/else 分支），`PanelRegistry` 把菜单 key 映射到 `UIManager` 方法名 —— 符合开闭原则。交互/展示问题集中于覆盖层面板预览态生命周期（前几轮已修复 H1/H2），本轮回溯确认其余 8 个面板预览/清理逻辑无隐藏 bug。

---

## 2. 优化后目标架构图（低耦合）

见 `architecture-web-element-blocker-optimized.svg`（已渲染）。相对现状的三处优化：

1. **PanelHelper 抽离**：覆盖层/选择/正则/全局域名/iframe 5 个面板重复的"预览隐藏循环 + 横幅 + 文案切换 + Toast + 拖拽"收口为单一共享模块，消除 12 处口径漂移风险。
2. **StorageService 收口写路径**：UI 与引擎不再直接 `GM_setValue`/触碰原始 `storage`，所有写经 Proxy 钩子 `invalidateIframeRules`，避免"绕写即失效"一致性缺陷。
3. **UIManager 退化为协调器**：9 面板为独立模块（`.call(UIManager)` 仅借宿主/清理），彼此不直接依赖；依赖方向全部向下、无环。

---

## 3. 冗余代码清理（已落地，安全）

| # | 问题 | 位置 | 动作 | 风险 |
|---|------|------|------|------|
| R1 | 死函数 `safeExecute` | 92（仅定义无调用） | 删除 | 零 |
| R2 | 死门面 `RuleStore`/`ConfigStore` | 299/306 + 949-966（仅赋值、无读取） | 删除整段门面与空对象（`const storage` 保留） | 零 |
| R3 | z-index 魔法数字散落 6 处 | 7422/7634/7662/7681/7690/1070 | 抽为 `UI_CONST.UI_TOP_Z_INDEX=2147483647` / `UI_OVERLAY_Z_INDEX=2147483646` / `HIDE_Z_INDEX=-2147483648`（CSS 模板串内 `${}` 插值） | 低 |
| R4 | 搜索深度 `4` 重复 7 处 | 179/1905/5206/7842/8376/8675/9858 | 抽为 `UI_CONST.WRAPPER_SEARCH_DEPTH=4` | 零 |
| R5 | 高亮色 key/default 重复 3+2 处（拼写漂移风险） | 5895/6367/7966 | 抽为 `UI_CONST.HIGHLIGHT_COLOR_KEY` / `DEFAULT_HIGHLIGHT_COLOR`（去掉裸 `GM_*` 字面量） | 零 |
| R6 | `TIMING.TOAST_DISMISS_MS` 误用于存储落盘防抖 | 335（语义错配） | 拆出 `TIMING.STORAGE_FLUSH_DEBOUNCE_MS=300`，Toast 移除仍用 `TOAST_DISMISS_MS` | 零 |

新增集中常量块 `UI_CONST`（行 129 起），沿用既有 `CONFIG`/`TIMING` 约定。

---

## 4. 耦合问题（分析 + 部分落地 + 待办蓝图）

| # | 违规 | 位置 | 本轮回溯处置 | 状态 |
|---|------|------|--------------|------|
| C1 | UI 直调 `GM_getValue/GM_setValue` 高亮色 | 5895/6367/7966 | 字面量集中到 `UI_CONST`（解耦第一步：key 单一归属） | **部分（蓝图上：经 StorageService 路由）** |
| C2 | 引擎直写 `GM_setValue('iframeConfig',…)` 绕过 StorageService 钩子 | 9573/9582/9584 | 新增 `StorageManager.setIframeConfig` 端口（`_markDirty` + EventBus 失效）；IframeGuard._loadConfig/setMaxDepth 经 `this.storage` 端口（新增 `_cfgGet/_cfgSet`，端口缺失时回退 GM 兼容 node） | **✅ 已落地（行为等价，136 测试绿）** |
| C3 | 引擎/UI 直连原始 `storage` 而非 `StorageService` Proxy | CSSInjector/RegexEngine/DomScanner/RuleDomain/BlockEngine 多处 | 设计已支持（`IframeDeepScanner.storage = StorageService` 范式），待批量注入 | **待办** |
| C4 | `StorageManager`/`StorageService` 直连 `IframeGuard.invalidateBlockRules` | 801/840/850/859 + Proxy 4603 | StorageManager 4 处 + StorageService 端口均改 `EventBus.emit('iframe:rules-changed')`；模块级订阅接线 `IframeGuard`（EventBus.emit 同步派发，行为等价） | **✅ 已落地（仅余 2 处引用：内部调用 + EventBus 订阅）** |
| C5 | UIManager 神类（~1438 行，含 9 面板方法 + 选择链 ~670 行） | 7400-8838 | 目标架构已画出；拆分为 `SelectionController` + `UINotify` + 独立面板模块 | **待办（结构性，高风险）** |

> 决策：C2/C4 已实现安全可验证的端口化 + EventBus 解耦（行为等价，全量 jest 136 绿，含 5 个新增源级守卫）。C3（其余引擎批量注入 StorageService）/ C5（UIManager 神类拆分）仍属**结构性重组**，会改变运行时依赖与选择器/失效语义，本环境无浏览器端到端验证，**继续作为明确蓝图留给带浏览器回归的下一阶段**——不静默改写 1 万行生产脚本。

---

## 5. 隐藏 bug 复检（重构过程中）

- 对 R1-R6 每处改动做闭包/TDZ/异步预览态复核：新增 `UI_CONST` 为顶层 `const`，所有引用点均在运行时调用（晚于定义），无 TDZ；`findSingleChildWrapper` 默认 `6`、调用点 `4` 语义不变；z-index 模板串插值产出字符串与原字面量逐字符等价。
- 未引入新 bug。全程 `node --check` 通过。

---

## 6. 测试结果（QA 门禁）

- `node --check web-element-blocker.user.js` → SYNTAX_OK
- 全量 jest：**23 套件 / 136 测试全部通过**（131 既有 + 5 新增 C2/C4 端口级源级守卫）
- 新增 `ad-block-test/ports.test.js` 的 C2/C4 契约测试：setIframeConfig 端口存在且经 `_markDirty`+EventBus 失效；IframeGuard 经 `this.storage` 端口读写、不再裸调 GM；StorageManager/StorageService 不再直连 IframeGuard（仅 2 处引用：内部调用 + EventBus 订阅）；EventBus 失效缝 emit→handler 端到端可触发。
- C2/C4 改动行为等价：EventBus.emit 为同步派发（handler 立即执行），缓存失效时机与原直调一致；_cfgGet 默认 `{maxDepth:3}` 与原 GM 默认 `{}` 在 `setMaxDepth` 语义下等价（均归一到 3）。

---

## 7. 残留建议（按收益/风险）

1. **高优先·待浏览器**：C2 新增 `StorageService.setIframeConfig` 并路由 9604/9613/9615；C4 改 `get` 陷阱为 EventBus。
2. **中优先**：C3 引擎统一注入 `StorageService`；R7 两段 `_buildSelector` 回退（OverlayScanEngine 4312 / IframeGuard 9482）统一委托 `BlockEngine.generateOptimalSelector`（注意会改变规则选择器口径，需评估既有持久规则）。
3. **结构级**：C5 拆分 UIManager 神类，落地图 2 目标架构；大面板（ManagerPanel ~533 / OverlayScanPanel ~531 / IframePanel ~446 行）按 `render*/bind*/_runModePreview` 拆子功能。

---

## 产出物

- `architecture-web-element-blocker-optimized.svg` —— 优化后低耦合目标架构图
- 本文件 —— 优化/去冗余/降耦合审查报告
- 代码改动：`web-element-blocker.user.js`（R1-R6 + C1 第一步，约 -37 行净减）
