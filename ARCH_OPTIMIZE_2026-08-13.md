# web-element-blocker 架构分析与隐藏 Bug 修复报告

> 日期：2026-08-13 · 目标文件：`web-element-blocker.user.js`（v3.4.9，~10196 行）
> 触发方式：`const MENU_ITEMS = [...]` 驱动的分层架构分析 + 交互/展示问题排查 + 逐个修复隐藏 bug
> 配套图表：分层架构图（9 面板分发链）、选择模式生命周期与预览清理中枢图（本仓库内已渲染）

---

## 一、架构总览（按 MENU_ITEMS 驱动）

`MENU_ITEMS` 定义 9 个菜单项，每项 `[显示名, 面板标题, key]`：

```
['🖱 手动选择屏蔽元素',   '选择模式',   'selection'],
['📝 添加文本/正则/...',  '规则面板',   'regex'],
['🌐 全局检索域名',       '域名检索',   'domain'],
['👁 扫描不可见覆盖层广告','覆盖层扫描', 'overlay'],
['⚙️ 管理规则与防御策略', '管理面板',   'manager'],
['🖼️ iframe 防线管理',    'iframe面板', 'iframe'],
['📤 导出规则',           '导出面板',   'export'],
['🛡️ 导出 AdGuard 规则',  'AdGuard 导出','adguard'],
['📥 导入规则',           '导入面板',   'import']
```

### 纯函数分发链（三层架构 v2.1）
```
GM_registerMenuCommand
   └─ _buildMenu()                 // 遍历 MENU_ITEMS 注册命令
        └─ PanelRegistry[key]      // OCP 扩展点：新增面板只改这张表
             └─ UIManager.method() // 面板实例由 UIManager 统一承载
                  ├─ 服务端口层 (DIP)  OverlayService / StorageService(Proxy) / RuleDomain
                  ├─ 引擎层          BlockEngine / IframeGuard / OverlayScanEngine
                  │                  GlobalDomainScanner / IframeDeepScanner
                  └─ 存储层          StorageManager
```

| 层 | 设计原则 | 说明 |
|----|----------|------|
| 面板层（9 面板） | **OCP** | `PanelRegistry` 是开闭 seam，新增菜单项只需加表项 + Panel 方法，不动 dispatch |
| 服务端口层 | **DIP** | `OverlayService` / `StorageService(Proxy)` / `RuleDomain` 把 UI 与引擎解耦，UI 依赖抽象端口 |
| 引擎层 | SRP | 每个引擎只负责一类匹配/防御/扫描，互不耦合 |
| 存储层 | 单一数据源 | `StorageManager` 收敛所有持久化读写 |

---

## 二、交互与展示问题排查结果

对 9 个面板 + UIManager 交互层（选择生命周期、`clearPanel` 预览清理中枢、冻结/解冻导航配对、错误边界）做了逐文件深读。结论：

- **分发链 / `clearPanel` 预览清理中枢 / 冻结解冻配对 / 5 套预览子系统**：均已硬化，无回归。
  - `_freezeNavigation` ↔ `_unfreezeNavigation` 严格成对；
  - `clearPanel()` 对 `_actionPreview` / `_previewAffectedElements` / `_globalPreview` / `_overlayPreview` / `_iframePreview` 五态全部 `safe` 清零，无幽灵高亮；
  - 错误边界 `_safeCall` → `_showErrorPanel` 已存在（见 G2 修复）。
- **本报告聚焦发现并修复的 2 个真正可达的隐藏 bug**（G1 交互、G2 防御），见下。

> 注：同日早前审计 `ARCH_REVIEW_MENU_2026-08-13.md` 已修复覆盖层/iframe 预览残留（H1/H2，`restoreOverlayPreview`），本次确认其仍在位，未重复处理。

---

## 三、隐藏 Bug 修复清单

### G1 — 同源 iframe 选择上下文未降级，导致顶层元素无法打开动作面板（真实交互 bug）

**现象**：进入同源 iframe 选择上下文（点了帧内元素、`_selectionIframeContext` 被写入并注册帧内监听）后，再点击**顶层文档**元素，动作面板不弹出，Toast 提示「目标元素已失效，请重新选择」。

**根因**：`_isElementInDOM(el, ctx)` 的 ctx 解析顺序是 `ctx || _actionIframeContext || _selectionIframeContext`。`stopSelection()` 已清空 `_selectionIframeContext`，但点击处理器仍把原始 `iframeCtx` 透传给 `_isElementInDOM`；此时 `iframeCtx.doc.contains(顶层元素)` 返回 `false` → 判定「已失效」→ `showActionPanel` 永不调用。

**修复**：在 `_handleClick` 与 `_handleTouchEnd` 两个入口，点击后用 `iframeCtx.doc.contains(target)` 重新判定，命中则保留 `iframeCtx`，否则降级为 `null`（顶层上下文）：

```js
// _handleTouchEnd (≈L8228)
const iframeCtx = this._selectionIframeContext || null;
this.stopSelection();
const _inCtxT = (iframeCtx && iframeCtx.doc && iframeCtx.doc.contains(target));
const effectiveCtxT = _inCtxT ? iframeCtx : null;
if (!this._isElementInDOM(target, effectiveCtxT)) {
    this.showToast('目标元素已失效，请重新选择。', 'warning');
    return;
}
this.showActionPanel(target, effectiveCtxT);

// _handleClick 非 iframe 路径 (≈L8342)
this.stopSelection();
const _inCtx = (iframeCtx && iframeCtx.doc && iframeCtx.doc.contains(e.target));
const effectiveCtx = _inCtx ? iframeCtx : null;
if (!this._isElementInDOM(e.target, effectiveCtx)) {
    this.showToast('目标元素已失效，请重新选择。', 'warning');
    return;
}
this.showActionPanel(e.target, effectiveCtx);
```

**影响面**：交互逻辑 + 回归测试断言字符串（`showActionPanel(e.target, iframeCtx)` → `effectiveCtx`）。

### G2 — 错误边界未退出选择模式，可能永久劫持导航（防御性 bug）

**现象**：若某个面板在 `_freezeNavigation` 之后抛出异常（SelectionPanel 路径可达），`_showErrorPanel` 直接 `shadowRoot.innerHTML=''` 清面板，但**未调用 `stopSelection()`** → 页面导航被永久劫持、document 点击拦截未注销。

**修复**：`_showErrorPanel` 在清空面板前先 `stopSelection()`：

```js
_showErrorPanel(title, detail, onRetry) {
    const _curPanel = this.shadowRoot.querySelector('.panel');
    if (_curPanel && typeof _curPanel._cleanupDrag === 'function') {
        try { _curPanel._cleanupDrag(); } catch (e) { Log.warn(e.message || e); }
    }
    this.stopSelection();              // G2：错误边界必须退出选择模式
    this.shadowRoot.innerHTML = '';
    ...
}
```

---

## 四、回归测试

仓库约定：测试断言**源码字符串/修复不变量**（非真实 jsdom 行为）。已更新 `ad-block-test/iframe-selection-xss-regression.test.js`：

- 修正 2 处过期断言（`iframeCtx` → `effectiveCtx` / `effectiveCtxT`）；
- 新增 `G1` describe：断言 `_inCtx` / `effectiveCtx` / `effectiveCtxT` 降级逻辑与 `_isElementInDOM` 回退链；
- 新增 `G2` describe：断言 `_showErrorPanel` 在 `shadowRoot.innerHTML=''` 之前调用 `stopSelection()`。

**验证结果**
- `node --check web-element-blocker.user.js` → `SYNTAX_OK`
- `npx jest` → **25 套件 / 166 用例全绿，0 失败**（含 G1/G2 新增守卫）

---

## 五、结论

- 架构分层清晰，`PanelRegistry`（OCP）与 `StorageService/OverlayService/RuleDomain`（DIP）构成健康扩展面；
- 本次新发现并修复 2 个隐藏 bug：G1（同源 iframe 上下文未降级导致顶层选择失效，真实交互缺陷）、G2（错误边界未退出选择模式，防御性缺陷）；
- 全部 9 面板 + 预览清理中枢 + 导航冻结配对经深读确认无其余隐藏逻辑 bug；
- 测试全绿，语法通过。
