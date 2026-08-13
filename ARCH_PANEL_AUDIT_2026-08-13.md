# 架构分析 + 面板交互/展示审计 + 隐藏 bug 修复报告

> 脚本：`web-element-blocker.user.js`（Tampermonkey 广告拦截，10197 行）
> 驱动入口：用户给定的 `MENU_ITEMS`（9 项菜单）
> 方法：`架构图与流程图绘制专家`(diagram-builder) + `javascript-testing-patterns` + `brooks-harness`(纪律门禁)
> 日期：2026-08-13

---

## 一、架构结论（MENU_ITEMS 驱动）

分派链**单向无环**，新增面板只需改 `MENU_ITEMS` + `PanelRegistry` 两处（OCP 达标）：

```
MENU_ITEMS ×9
  → _buildMenu()（纯函数，GM_registerMenuCommand / 测试桩可注入）
    → PanelRegistry（key → UIManager 方法名）
      → UIManager（Shadow DOM 宿主：拖动 / 横幅 / 预览态 / 选择模式）
        → 9 个面板模块（Phase-B 经 XPanel.call(this) 注入 this）
          → 服务端口层：OverlayService（覆盖层拦截）/ StorageService（唯一写入端口）/ RuleDomain（影响度+AdGuard导出）
            → 引擎层：BlockEngine / OverlayScan / IframeGuard / RegexEngine / DomainAnalyzer
              → StorageManager（GM 存储）
横切关注点（不参与分派）：EventBus / ProtectedCheck / CSSInjector / NetworkEngine
```

预览态生命周期契约（5 类 × 5 阶段）是本轮分析的核心透镜：
- 5 类预览态：`_actionPreview` / `_previewAffectedElements` / `_globalPreview` / `_overlayPreview` / `_iframePreview`
- 5 阶段：进入（校验+置位+横幅）→ 联动（选择实时更新）→ 重扫（wasPreview→reset→scan→restore）→ 重绘（保留 scrollTop）→ 还原（clearPanel 兜底）

所有隐藏缺陷都精确落在**「进入校验 / 重扫复原 / 重绘滚动」三处断裂点**。

---

## 二、本轮新修复（选择 / 导出 / AdGuard / 导入 4 面板）

前几轮已修 domain/regex/iframe/manager/overlay 共 10+ 项；本轮聚焦剩余 4 面板，发现 1 个 Critical 隐藏 bug + 1 个展示问题。

### BUG-S1（Critical）选择模式 iframe 上下文断裂 —— iframe 广告封杀无效的根因

**现象**：用户在**同源 iframe** 内选中广告元素后，动作面板（showActionPanel）的「彻底封杀域名」「预览效果」「放大层级」全部失效——
点「彻底封杀域名」弹"目标元素已从页面移除，请重新选择"，预览也直接中止。

**根因**：Y2 修复时 `btn-static`/`btn-dynamic`/`btn-struct` 已正确把 `iframeCtx` 透传给 `_isElementInDOM`，
但 `stopSelection()` 在进入动作面板前就已清空 `this._selectionIframeContext`。剩下两处调用漏传了 `iframeCtx`：
- `btn-domain`（8662 行）：`this._isElementInDOM(this.currentSelectedEl)` —— 缺 ctx
- `btn-preview`（8722 行）：`this._isElementInDOM(el)` —— 缺 ctx

且 `_resetActionPreview`(8367) / `_applyActionPreviewHiding`(8381) / `btn-zoom-in`(8555) 依赖已被清空的
`this._selectionIframeContext` 判定元素存活，对 iframe 内元素一律返回 `document.contains(el) === false`（元素在 iframeDoc 而非顶层 doc），于是误判失效。

**修复**（最小、行为等价）：
1. `showActionPanel` 把 iframe 上下文持久化到独立实例字段 `this._actionIframeContext = iframeCtx || null;`
   （不被 `stopSelection` 清除，动作面板生命周期内始终可用）
2. `_isElementInDOM` 回退链改为 `const c = ctx || this._actionIframeContext || this._selectionIframeContext;`
3. `stopSelection` 末尾补 `this._actionIframeContext = null;`（避免下次选择残留旧上下文）
4. `btn-domain` / `btn-preview` 补传 `iframeCtx`（与另三个按钮口径一致）

修复后：同源 iframe 内选中的元素，动作面板全生命周期内判定存活、可封杀、可预览、可放大。

### D1（Minor）导出 / AdGuard 文本框无高度上限

**现象**：规则量很大时，文本框高度撑满，`复制 / 下载` 按钮被顶出面板可视区，需滚动整个面板才能点到。
**修复**：`injectStyles` 增加 `textarea.export-box, textarea#export-text { max-height: 50vh; }`，按钮常驻可见，文本框自身内部滚动。

---

## 三、非缺陷核实（未改动）

- **ExportPanel / AdGuardExportPanel / ImportPanel** 结构干净：规则文本均走 `textarea.value` 赋值，**无 innerHTML 注入面**；
  复制（clipboard + execCommand 兜底）、下载（Blob + revokeObjectURL）、返回（showManager）、覆盖导入确认（showConfirm）路径均正常；
  ImportPanel 的 `importAll` 有 `try/catch`，非法 JSON 仅提示不崩溃。
- 选择模式其余路径（static/dynamic/struct 存活校验、iframe 进入去重、srcdoc 同源回退）在过往轮次已正确。

---

## 四、验证

| 项 | 结果 |
|----|------|
| `node --check` | SYNTAX_OK（10197 行） |
| 全量 jest | **162 / 162 通过（25 suites）** |
| 新增回归 | `ad-block-test/bugfix-regression-v12-selection-iframe.test.js`（6 断言：S1a~S1e + D1） |
| 旧测试修复 | `iframe-selection-xss-regression.test.js` 第 56 行原锁死 `_isElementInDOM` 旧字面量，改为含 `_actionIframeContext` 的新不变量 |

> 第三次踩到同一坑：源级字符串断言锁「完整字面量行」，行为变更后必回潮。规则——永远锁**不变量**（含新增行为），不锁字面量。

---

## 五、交付物

- `architecture-web-element-blocker-menu.svg` —— 9 菜单项驱动的分层架构全景图（内联已渲染）
- `architecture-preview-lifecycle.svg` —— 预览态生命周期契约图（内联已渲染）
- `ARCH_PANEL_AUDIT_2026-08-13.md` —— 本报告
- `bugfix-regression-v12-selection-iframe.test.js` —— S1/D1 回归守卫

---

## 六、遗留项（需浏览器端到端回归，未动）

- C3 其余引擎批量注入 StorageService（CSSInjector/RegexEngine/DomScanner/RuleDomain/BlockEngine）
- C5 UIManager 神类拆分（SelectionController + UINotify + 独立面板模块）
- 长列表虚拟化（超大域名/覆盖层列表渲染开销）
- iframe 选中元素的**预览隐藏**精度：`_applyActionPreviewHiding` 仍主要基于顶层 `document` 查询资源域，iframe 内部资源域提取可能不全（域名为空时预览"隐藏范围"偏少，但封杀路径已正常）。属预览口径增强，非阻断 bug。
