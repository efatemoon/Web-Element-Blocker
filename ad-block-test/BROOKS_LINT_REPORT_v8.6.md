# BROOKS 架构复核 + iframe 防线修复报告（v8.6 → 发布 3.3.0）

> 本次聚焦用户反馈的 4 个 iframe 防线问题：白名单无效、深度扫描/重新扫描混淆、拦截后刷新复活、iframe 规则未进「管理规则与防御策略」。
> 经 brooks-harness 架构合规复核 + javascript-testing-patterns 回归守卫，定位根因并逐一定位修复。

## 一、问题根因（先诊断，后修复）

| 用户反馈 | 真实根因 | 证据 |
|---------|---------|------|
| **白名单完全无效** | 真正负责隐藏的守卫 `ProtectedCheck.isProtected`（被 `ElementHider.hideElement`/`collectAll` 调用）**从不查询** `WhitelistStore`；面板的「拦截选中」直接调 `BlockEngine.hideElement` 直穿白名单；且 `rec.manual` 仅存于 `WeakMap`（刷新即失）。白名单只在 `ContentClassifier.classify` 的**自动分类路径**生效，对手动拦截与刷新后重扫毫无约束力。 | `ProtectedCheck` L1347-1364 无 `WhitelistStore` 调用；`IframePanel` 拦截处理器直调 `BlockEngine.hideElement` |
| **拦截后刷新又显示** | 帧级「拦截选中」只做 `BlockEngine.hideElement(iframe)`（内存） + `rec.blocked=true`（`WeakMap`，刷新丢失），**未写入任何持久规则**。下次加载 `IframeGuard` 重扫，`rec.blocked` 已不存在 → iframe 重新出现。 | `IframePanel` 拦截处理器（旧） |
| **iframe 规则不在「管理规则与防御策略」** | 同上——拦截动作未产生 `iframeBlock` 规则，故 `ManagerPanel.buildRecords` 的 `getIframeBlocks()` 读不到它；iframe 防线与管理面板**完全断连**。 | `ManagerPanel` L6079 读 `getIframeBlocks()`；旧拦截处理器未写 |
| **深度扫描 vs 重新扫描 混淆** | 两者都绕过 5s 扫描缓存；唯一差别是「重新扫描」会 `IframeGuard.forceRescan()` 重置守卫状态，而「深度扫描」不会。行为高度重叠、文案无差异，用户无法区分。 | `IframePanel` 旧 `btn-deep-scan`/`btn-rescan-iframe` 处理器 |

## 二、修复清单（v8.6）

### 1. 删除无效白名单（彻底）
- 删除 `WhitelistStore` 模块（`web-element-blocker.user.js` 原 L8866-8918）及其全部引用：
  - `ContentClassifier.classify` 的 `if (WhitelistStore.isWhitelisted(...)) return whitelist` 分支（自动分类不再受白名单干扰）；
  - `IframeGuard._classifyAndAct` 粘性判定中的 `&& !WhitelistStore.isWhitelisted(iframe)`；
  - 删除死分支 `if (result.verdict === 'whitelist')`（classify 不再返回该值）；
  - 删除 `IframeGuard.protectInFrame`（仅白名单用）。
- IframePanel：移除白名单管理区 HTML、`btn-protect-iframe` 按钮、`renderWlList()` 函数及其两处 `protectBtn` 引用（扫描中分支 + 空列表分支）。
- storage 层：移除 export/import 的 `iframeWhitelist` 桶 + `AdGuardExportPanel` 的 `@@||白名单` 导出段 + 桥接注释。
- 残留仅剩文档注释（文件头 ASCII 图、模块列表注释各一处），不影响运行。

### 2. 帧级拦截持久化 + 进入统一管理（核心修复）
- `IframePanel`「拦截选中」对**跨域 iframe** 写入持久规则：
  `this.storage.addIframeRule({ matchType: 'srcDomain', value: u.hostname })`
  - `addIframeRule` 已自动 `IframeGuard.invalidateBlockRules()` + 发 `rule:changed`，下次加载 `_matchesIframeBlockRules` 命中 → `_blockIframe` 自动隐藏 → **刷新持续生效**。
  - 该规则存入 `iframeBlocks` 桶，`ManagerPanel.buildRecords` 以 `type:'iframeBlock'` 列出 → **可被「管理规则与防御策略」读取/删除/禁用统一管理**（删除走 `removeIframeRule` + `rescanAll` 即时还原）。
- 同源 `about:blank`/`srcdoc` 帧无 hostname 时不写 `iframeBlock`（避免误杀同域），由自动分类兜底；帧内**元素级**同域拦截仍经 `blockInFrameNode` 写 `attribute`+`_meta:'iframe-scan'`（管理面板以 🖼帧内 徽章展示），跨域元素受浏览器限制仅内存隐藏（固有限制）。
- 拦截 Toast 文案更新：明确「已写入持久规则（刷新后持续生效，可在管理规则与防御策略统一管理）」。

### 3. 深度扫描 / 重新扫描 厘清
- **重新扫描**：`IframeGuard.forceRescan()`（重置守卫状态）+ 重新采集 → 帧级重新分类、刷新列表（不拉满嵌套深度）。按钮加 tooltip 说明。
- **深度扫描**：在「重新扫描」基础上，临时拉满嵌套深度 `IframeDeepScanner.maxDepth = IframeGuard.MAX_DEPTH` 并强制重跑帧内元素级深扫（递归嵌套帧、识别透明覆盖/赌博域名/肤色等元素），更彻底但更慢。二者差异显式化、文案精确，不再混淆。

## 三、验证

- `node --check`：✅
- `npx jest`：**16 套件 / 76 用例全绿**（新增 3 个 v8.6 回归守卫：白名单删除 / 帧级拦截持久化 / 管理面板消费 iframeBlock）
- 行为等价性：9 面板物理抽离结构 intact；`PanelRegistry`/`OverlayService`/`StorageService` 端口未动。

## 四、影响范围与局限

- **白名单删除**：属用户明确要求的功能移除，无其它模块依赖 `WhitelistStore`（已全量排查）。旧白名单数据 `GM_getValue('iframeWhitelist')` 不再被读取，可安全遗留，不影响新版本。
- **跨域帧内元素级拦截**：因浏览器同源策略，跨域 iframe 内部 DOM 不可写规则，仍只能内存隐藏（刷新后由该 iframe 的 src 域名 `iframeBlock` 规则兜底整体拦截）。这是浏览器固有限制，非缺陷。
- 版本：`web-element-blocker.user.js` 与 `.meta.js` 同步升至 **3.3.0**。
