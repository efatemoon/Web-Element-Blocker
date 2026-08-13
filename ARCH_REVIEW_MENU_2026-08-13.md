# web-element-blocker.user.js · 架构分析与隐藏 bug 修复报告

> 对象：`web-element-blocker.user.js`（v3.4.9，10127 行）
> 锚点：`MENU_ITEMS`（9 个菜单项）
> 方法：架构图（diagram-builder）+ 逐面板交互/展示审查（brooks-lint 思路）+ 回归测试（jest）
> 日期：2026-08-13

---

## 1. 架构分析（按 MENU_ITEMS 驱动）

菜单数组定义了 9 个入口，经一条**纯函数分派链**映射到面板，整体符合 OCP / DIP / SRP：

```
GM 菜单(9 项) ──_buildMenu()──▶ PanelRegistry(key→方法名) ──▶ UIManager.方法()
                                                          │
                  UIManager ── 9 个 Phase-B 面板模块(Selection/Regex/GlobalDomain/
                          Overlay/Manager/Iframe/Export/AdGuard/Import)
                                  │ 经服务端口
                                  ▼
        OverlayService · StorageService(Proxy) · RuleDomain   ──▶ 引擎层 / iframe 防线 ──▶ StorageManager
```

分层（见附图 `architecture-web-element-blocker-menu.svg`）：

| 层 | 模块 | 职责 | 接缝 |
|----|------|------|------|
| 入口 | `_buildMenu` + `GM_registerMenuCommand` | 把 MENU_ITEMS 注册到任意 register（GM / 测试桩） | 纯函数，0% 覆盖缺口已补 |
| 注册表 | `PanelRegistry` | `key → UIManager 方法名`（OCP：新增面板=注册一行+MENU_ITEMS 加一项） | — |
| UI 协调器 | `UIManager`（Shadow DOM 宿主）+ 9 面板模块 | 渲染、拖拽、Toast/Confirm、预览横幅、导航冻结 | `clearPanel` 统一清理 |
| 服务端口(L2) | `OverlayService` / `StorageService` / `RuleDomain` | UI 只依赖端口，不直连引擎/存储 | DIP |
| 引擎(L3) | `BlockEngine` / `OverlayScanEngine`+`OverlayDetector` / `GlobalDomainScanner` / `IframeDeepScanner` | 实际拦截、隐藏、评分 | — |
| iframe 防线 | `FrameDetector`/`FrameMessenger`/`MessageGuard`/`IframeGuard`/`ContentClassifier` + `EventBus` | 动态 iframe 广告双层决策 | 事件解耦 |
| 持久化 | `StorageManager` | GM storage 读写 | `StorageService` 代理 |

**横切关注**：`ProtectedCheck`（脚本自身 UI 永不误伤）、`Log`、`NetworkInterceptor`（网络层拦截）、`EventBus`（iframe 模块解耦）。

### 各面板交互/数据流要点

- **selection（手动选择）**：`SelectionPanel` → 冻结页面导航 → 拦截 pointerdown/click/touch* → 命中元素 → `showActionPanel`（静态/动态/结构/域名封杀 + 实时预览）。`stopSelection` 统一注销帧内/文档监听、解冻导航。
- **regex（规则面板）**：`contains`/`regex`/`builder`/`attribute`/`path`/`iframeBlock` 六模式，预览口径与 `applyCSSRules` 严格一致（4 属性隐藏），含 ReDoS 预检。
- **domain（全局域名）**：双引擎（DOM 资源 + 6 通道性能 API + 12 维评分）合并，过滤已封杀域名，初始 + 深度扫描均自动勾选高风险域并**同步实时预览**。
- **overlay（覆盖层）**：异步时间分片扫描，跨扫描保留已拦截指纹，预览实时联动。
- **manager（管理面板）**：全局黑名单 + 本站 + 跨站规则汇总，按影响度排序、启用/禁用、单条/批量删除 + 撤销栈、策略切换。
- **iframe（防线）**：帧级 + 帧内元素级合并，深度扫描拉满嵌套深度，预览 + 批量拦截。
- **export / adguard / import**：导出 JSON / AdGuard 文本（剪贴板 + 下载）、导入（合并/覆盖，覆盖前确认）。

---

## 2. 交互与展示问题审查结论

逐面板走查后，架构骨架与绝大多数交互已高度硬化（先前 brooks-lint 多轮已修复 BUG-X / BUG-Y 系列）。本次未发现 `StorageManager`/引擎层级的崩溃性缺陷。

**但发现 1 处确定崩潰性隐藏 bug + 1 处同源状态丢失 bug，全部位于 `OverlayScanPanel` 的「重新扫描 / 深度扫描」与预览的交互闭环**——正是用户要求的「预览与刷新后效果一致、无隐藏逻辑 bug」防线最薄弱处。

---

## 3. 隐藏 bug 与修复

### H1（崩溃）· 重新扫描 + 预览 → 未定义函数 ReferenceError
- **位置**：`OverlayScanPanel` 重新扫描回调（原第 7013 行）。
- **现象**：先开启覆盖层预览，再点「🔄 重新扫描」，`runScan(...).then(() => { if (wasPreview) updateOverlayPreview(); })` 调用 `updateOverlayPreview`——该面板中**此函数从未定义**（面板内函数名为 `updatePreview`）。抛出未捕获 `ReferenceError`，控制台报错，预览无法复原。
- **根因**：异步回调里引用了重命名/删除后遗留的死函数名；既有回归测试 `BUG-Y6` 竟把这句**错误代码**当不变量断言（`expect(content).toContain('if (wasPreview) updateOverlayPreview();')`），等于把 bug 固化进测试。
- **修复**：新增 `restoreOverlayPreview()`（按 `updatePreview` 口径重建：`active=true` + `_showPreviewBanner` + `updatePreview()`），重新扫描与深度扫描均改为 `if (wasPreview) restoreOverlayPreview();`。

### H2（状态丢失）· 深度扫描静默丢弃预览态
- **位置**：`OverlayScanPanel` 深度扫描回调（原第 6986 行）。
- **现象**：深度扫描先 `resetOverlayPreview()` 丢弃预览，但 `.then` 只弹完成 Toast，**不复原预览**——与「重新扫描」注释（BUG-Y6："扫描完成后再重新应用预览"）意图矛盾，且比重新扫描更隐蔽（连 ReferenceError 都没有，只是预览悄悄没了）。
- **修复**：深度扫描同样在 `runScan(...).then` 中 `if (wasPreview) restoreOverlayPreview();`。

### 修复代码片段（OverlayScanPanel）
```js
const restoreOverlayPreview = () => {
    if (this._overlayPreview.active) return;
    this._overlayPreview = { active: true, elements: [], hiddenDomains: new Set() };
    this._showPreviewBanner(() => resetOverlayPreview());
    if (previewBtn) previewBtn.textContent = '👁 恢复显示';
    updatePreview();
};
// 深度扫描
runScan(false, { deep: true }).then(ok => { /* …Toast… */ if (wasPreview) restoreOverlayPreview(); });
// 重新扫描
runScan(false, { deep: false }).then(() => { if (wasPreview) restoreOverlayPreview(); });
```

### 同源加固（顺带验证，无改动）
- `clearPanel` 已统一清理 5 类预览态（`_actionPreview`/`_previewAffectedElements`/`_globalPreview`/`_overlayPreview`/`_iframePreview`）+ 选择横幅 + 预览横幅 + iframe EventBus 退订 —— 跨面板切换无残留。
- `makeDraggable` 的 `mousemove`/`mouseup` 全局监听经 `panel._cleanupDrag` 在 `clearPanel` 统一注销 —— 无泄漏。
- 全文件 `this._*` 辅助方法（`_resetActionPreview`/`_updateActionPreview`/`_previewHideDomainResources` 等）均存在定义 —— 无其它"called-but-undefined"闭包。

---

## 4. 回归测试

- 更新 `ad-block-test/iframe-selection-xss-regression.test.js` 的 `BUG-Y6` 段，使其断言**修复后**行为：
  - 重新扫描 / 深度扫描均 `if (wasPreview) restoreOverlayPreview();`（共 2 处）；
  - `restoreOverlayPreview` 已定义并按 `updatePreview` 口径重建预览；
  - 彻底移除对未定义函数 `updateOverlayPreview();` 的调用断言。
- 语法校验：`node --check web-element-blocker.user.js` ✅
- 全量测试：`jest` → **23 套 / 131 用例全部通过**（无回归）。

---

## 5. 验证与遗留

- ✅ 语法 OK；✅ 131/131 测试通过；✅ 既有 BUG-Y6 测试已同步为修复态。
- 遗留/建议（非本次崩溃级，供后续迭代）：
  1. `IframePanel` 深度扫描 / 重新扫描未刷新预览（仅丢弃，不重建）——与覆盖层面板修复对齐可进一步增强一致性，但当前无崩溃。
  2. 既有 `BUG-Y*` 回归测试多为"源码片段包含断言"，建议逐步迁移为真实 jsdom 行为断言，避免再次出现"把 bug 当不变量"的情况。
  3. 覆盖率阈值 50%，面板交互层（Shadow DOM 渲染、拖拽、预览横幅 DOM）仍建议补真实 DOM 行为测试。
