# 更新日志

## v0.1.68 — 2026-08-05

### 逐菜单功能复核与检测算法深度优化

逐一检测 9 个菜单功能（手动选择 / 全局检索域名 / 扫描不可见覆盖层 / 添加规则 / 管理规则与防御 / 按网站查看 / 导出 / AdGuard 导出 / 导入），核对代码与功能对应关系，并升级核心检测算法。

#### 算法优化 1：域名匹配 O(n) → O(depth)（scanAndBlockDynamic）

- **原算法**：`domainList.some(d => host === d || host.endsWith('.' + d))`，每个 URL 对黑名单做 O(n) 线性扫描。黑名单 40+ 域名时，单次匹配 O(40)。
- **新算法**：新增 [hostnameBlocked()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L378) —— 缓存 `Set` 做精确匹配 O(1)，未命中再逐级上探父域 O(depth)（`ads.example.com` → `example.com` → 跳过 TLD）。单次匹配降至 O(2~3)。集合与列表同生命周期，`invalidateCache` 一并失效，无重建开销。

#### 算法优化 2：不可见覆盖层检测更全更准（scanInvisibleOverlays）

- **触发源补全**：新增 `data-href`/`data-url`/`data-link` 与 `onmousedown` 作为跳转触发源，覆盖广告 SDK 把跳转地址藏在 data-\* 属性、由 JS 读取后跳转的形态。
- **透明背景识别**：`backgroundColor` 序列化兼容 `'rgba(0,0,0,0)'` 与 `'transparent'` 两种形式，避免漏判。
- **视口相交校验**：离屏定位（如 `left:-9999px`）的覆盖层无法捕获点击，新增视口相交判定，减少误报。
- **iframe 空源过滤**：子 iframe 选择器排除空 `src=""`，避免误判为跨域高风险。

#### 算法优化 3：脚本域名抽取支持子域（extractResourceDomains）

- **原正则**：`[a-z0-9-]+\.(?:TLD)` 不含点号，`"ads.example.com"` 无法匹配，遗漏广告配置中的多级域名引用。
- **新正则**：`[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.(?:TLD)`，首尾为字母数字、中间允许 `./-`，正确捕获子域广告域。

### 代码优雅性改进

#### 触屏处理函数绑定统一到构造期

- **原状**：`_handleMouseOver`/`_handleClick` 在构造期 `.bind(this)`，而 `_handleTouchStart/Move/End` 在 `startSelection` 内每次调用重新 `.bind`（对已绑定函数再次 bind，产生冗余链）。
- **改进**：三个触屏处理函数统一在构造期绑定一次，引用稳定。`startSelection` 重复调用时不再产生新引用，`stopSelection` 移除的始终是同一引用，逻辑更清晰。

#### clearDomain 同步清理自愈计数

- `clearDomain` 现同步清除 `pro_blocker_clean_loads` 中本域的残留计数，避免清除规则后遗留无效状态。

### 9 菜单功能复核结论

| 菜单                    | 复核结论                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| 🖱 手动选择屏蔽元素     | 正确。`startSelection` 先 `stopSelection` 防重复绑定泄漏；触屏拦截防广告跳转；清理链完整。 |
| 🌐 全局检索域名         | 正确（v0.1.67 已修预览泄漏）。域名评分、选择、封杀逻辑闭合。                               |
| 👁 扫描不可见覆盖层广告 | 正确，本轮增强检测算法。选中索引与 records 同步，重扫后重建。                              |
| 📝 添加规则             | 正确。5 模式（包含/正则/积木/属性/路径）校验、预览、保存闭合。                             |
| ⚙️ 管理规则与防御策略   | 正确（v0.1.67 已增强防御策略）。删除/切换/重置/导出入口齐全。                              |
| 🗂 按网站查看所有规则   | 正确（v0.1.66 新增）。坍缩视图 + 筛选 + 跨站删除。                                         |
| 📤 导出规则             | 正确。clipboard + execCommand 双通道，下载 blob。                                          |
| 🛡️ 导出 AdGuard 规则    | 正确（v0.1.67 已修 `:has()` 过度隐藏）。7 类规则 + 域名分段，AND/OR 全覆盖。               |
| 📥 导入规则             | 正确。合并/覆盖双模式，导入后刷新生效。                                                    |

### 验证

- `node --check` 语法检查通过
- `hostnameBlocked` 与原 `some` 语义等价性核对（精确 + 父域后缀，TLD 单独不计）
- 触屏绑定迁移后 `startSelection`/`stopSelection` 引用一致性核对通过
- 9 菜单调用链与功能逐一对应，无无效代码

---

## v0.1.67 — 2026-08-05

### 深度优化：防御策略（切换防御策略）功能重构

**用户反馈**：不清楚"切换防御策略"到底有什么用。深度审查后发现原实现存在两个核心问题，已一并解决。

#### 问题 1：flashList 永久锁定，"系统评估"名不副实

- **原状**：`detectFlashAndMark` 一旦检测到广告闪现就把域名写入 `flashList`，且**永远不会自动清除**。导致：
  - 域名被永久强制为 preemptive 模式，即使用户后续加规则已消除闪现；
  - 管理面板"系统评估"永远显示"已记录闪现特征"，无法反映规则真实效果；
  - 用户无法手动解除，只能盲操作。
- **修复（自愈机制）**：新增 `pro_blocker_clean_loads` 计数。`load` 事件时若本次加载未检测到闪现（`_flashDetectedThisLoad=false`）则调用 `recordCleanLoad()` 递增；连续 3 次干净加载后自动清除 `flashList` 标记，preemptive 强制启用随之解除。闪现复发时 `markAsFlashing` 立即复位计数，打断自愈进程。
- **手动重置**：管理面板新增 `♻️ 重置闪现标记` 按钮（仅闪现标记存在时显示），确认规则已生效后可手动清除。

#### 问题 2：preemptive 扫描时序覆盖不足

- **原状**：preemptive 模式用 `requestAnimationFrame` 连续 5 帧（约 80ms）重扫，仅能覆盖首屏极早期注入的广告，对 200ms 后异步加载的广告无效。
- **修复**：改为 `0/100/300/700/1500ms` 递增多时序扫描，既保留早期拦截能力，又兜底延迟注入的广告。

#### 状态文案清晰化

- 防御策略状态区分三种：`极速预判（手动开启）` / `极速预判（闪现自动启用）· 自愈进度 N/3` / `智能自动`，每项附带说明文案，用户一眼可知当前模式来源与切换意义。

### 修复的关键 Bug

#### Bug 7：CSS `:has(> a, b, c)` 过度隐藏（选择器作用域错误）

- **位置**：`BlockEngine.applyCSSRules`（domainBlock + pathPattern）、`generateAdGuardRules`（pathPattern）
- **问题**：`:has(> a, b, c)` 中 `>` 组合器**仅作用于第一个选择器** `a`，其余 `b`、`c` 被解析为后代选择器（任意深度匹配）。本意是"直接子节点命中任一资源选择器即隐藏父容器"，实际变成"后代命中也隐藏"，导致非广告的祖先容器被误隐藏。
- **修复**：用 `:is()` 包裹整组选择器 → `*:has(> :is(a, b, c))`，使 `>` 对组内每个选择器均生效，只隐藏直接父容器。`:is()` 兼容性（Chrome 88+）高于 `:has()`（Chrome 105+），不降低既有兼容性。

#### Bug 8：showGlobalDomainPanel 预览泄漏（跨面板切换元素永久隐藏）

- **位置**：`UIManager.showGlobalDomainPanel`
- **问题**：预览状态 `previewActive`/`previewHiddenElements` 为函数内局部变量，`clearPanel` 无法访问。当用户点"预览效果"隐藏若干元素后，不点"取消配置"而是直接打开其他菜单（触发 `clearPanel`），局部闭包丢失，被预览隐藏的元素永久 `display:none` 直到刷新。
- **修复**：预览状态迁移为实例属性 `this._globalPreview = { active, elements }`，`clearPanel` 统一清理（恢复 display/opacity）。封杀按钮点击后直接清空预览状态（这些元素本就应隐藏，不恢复）。

#### Bug 9：`_loggedOverlays` 未声明为静态字段

- **位置**：`BlockEngine`
- **问题**：`_loggedOverlays` 在 `scanInvisibleOverlays` 内懒初始化（`if (!this._loggedOverlays) this._loggedOverlays = new Set()`），与同类 `_loggedDomains`/`_loggedPatterns` 的静态字段声明风格不一致。
- **修复**：补齐 `static _loggedOverlays = new Set();` 声明，移除懒初始化。

### 验证

- `node --check` 语法检查通过
- `:has(> :is(...))` 选择器语义与 JS 侧 `findSingleChildWrapper` 直接父容器逻辑一致
- 自愈/重置/手动切换三条路径互不冲突，`_flashDetectedThisLoad` 生命周期（fastInject 重置 → detectFlashAndMark 置位 → load 读取）闭合
- 预览清理链：`_actionPreview` / `_previewAffectedElements` / `_globalPreview` 三处均在 `clearPanel` 统一收口，无残留分支

---

## v0.1.66 — 2026-08-05

### 新功能

- **按网站查看所有规则**（`showAllSitesPanel`）：坍缩视图，一次性列出所有"按域名隔离"的规则（静态/动态/正则/属性/位置/积木/路径 7 类），每条带 `[网站][类型][内容][删除]`，顶部支持按关键字与类型筛选。便于跨站管理误加的网站专属规则。
  - 入口：菜单 `🗂 按网站查看所有规则`，以及"管理规则与防御策略"面板内新增 `🗂 按网站查看规则` 按钮。
  - 全局域名黑名单（`domainBlock`）不区分网站，按用户要求不在本面板出现，仍由"管理规则"维护。
- **StorageManager 新增两个方法**：
  - `getAllSiteRules()`：遍历 7 个按域名隔离的存储字典，扁平化输出 `{domain, index, type, label, tag, rule}` 记录。
  - `removeRuleForDomain(domain, type, index)`：跨域名删除任意站点下的单条规则，删除后若该域名规则清空则移除域名键，避免空键残留；并按类型触发 `applyCSSRules`/`applyRegexRules`/`applyComplexRules` 即时生效。

### 修复的关键 Bug

#### Bug 5 复核：showGlobalDomainPanel 预览泄漏

- 沿用 v0.1.65 的实例属性 `_globalPreviewHidden` 方案，`clearPanel` 中已统一清理预览状态，本版本未引入回归。

#### Bug 6：showAllSitesPanel 重复 makeDraggable 导致 document 监听器泄漏（设计规避）

- **风险点**：若面板内部在筛选/删除后重置整个 `panel.innerHTML` 并再次调用 `makeDraggable`，旧 `_cleanupDrag` 不会被调用，`document` 上的 `mousemove`/`mouseup` 监听器会逐次累积泄漏。
- **规避设计**：
  1. `showAllSitesPanel` 开头调用 `this.clearPanel()`，由 `clearPanel` 统一调用旧 panel 的 `_cleanupDrag()` 后再清空 `shadowRoot`，保证进入新面板前旧拖拽监听器已释放。
  2. 筛选与删除只重渲染列表容器 `#as-list` 的 `innerHTML`，**不重置整个 panel**，`makeDraggable` 全程只调用一次，从根源杜绝重复绑定。
  3. 删除采用事件委托（绑在 `#as-list` 上），删除后即时 `records = storage.getAllSiteRules()` 重建索引再渲染，避免索引错位。

### 行为说明

- 正则/积木规则删除后，已作用于元素的 inline `display:none` 不会自动清除（与"管理规则"面板一致），需刷新页面恢复显示；本面板为支持连续批量删除误加规则，删除后不强制刷新，仅即时刷新列表与索引，规则本身已从存储移除，下次加载即不再生效。

### 验证

- `node --check` 语法检查通过
- 入口（菜单 + 管理面板按钮）与既有面板调用链一致性核对通过
- `clearPanel` → `_cleanupDrag` 清理链复核通过，无新增监听器泄漏

---

## v0.1.65 — 2026-08-05

### 修复的关键 Bug

#### Bug 1：闪现检测永远失败（逻辑错误）

- **位置**：`BlockEngine.scanAndBlockDynamic`
- **问题**：`detectFlashAndMark` 在 `target.style.setProperty('display', 'none', ...)` **之后**调用。`display:none` 会使元素的 `getBoundingClientRect()` 返回 0×0，导致闪现检测条件 `rect.width < 50` 永远成立而被 `return`，`markAsFlashing` 永远不会被真正触发。
- **影响**：flashList 闪现标记功能完全失效，"下次自动启用极速注入"承诺无法兑现。
- **修复**：将 `detectFlashAndMark` 调用移到设置 `display:none` **之前**，确保读取的是元素被隐藏前的真实渲染尺寸。

#### Bug 2：flashList 标记不触发 preemptive 模式（逻辑断层）

- **位置**：`BlockEngine.fastInject`
- **问题**：`detectFlashAndMark` 注释写"一旦标记，下次进入该域会自动启用 preemptive 模式"，但 `fastInject` 只读 `config.mode`，从不检查 `flashList`。`markAsFlashing` 写入的标记无人消费，`showManager` 中"已记录闪现特征，系统采用极速注入"文案为虚假陈述。
- **影响**：闪现自动升级机制名存实亡，无效代码。
- **修复**：`fastInject` 的 preemptive 判定改为 `mode === 'preemptive' || !!storage.flashList[storage.domain]`，让被标记的域名即使 config.mode 是 auto 也按 preemptive 多帧重扫逻辑运行。

#### Bug 3：about:blank iframe 误判为跨域高风险

- **位置**：`BlockEngine.scanInvisibleOverlays`
- **问题**：`childIframe = el.querySelector('iframe[src]')` 会匹配 `src="about:blank"` 的 iframe。`new URL('about:blank')` 的 hostname 为空字符串，`'' !== selfHost` → `crossDomain = true` → 触发高风险自动拦截，误杀正常容器。
- **修复**：选择器改为 `iframe[src]:not([src="about:blank"])`。

#### Bug 4：hash 锚点误判为跳转

- **位置**：`BlockEngine.scanInvisibleOverlays`
- **问题**：`<a href="#">` 的 `el.href` 会被浏览器解析为"当前页面 URL + #"（非字面 `'#'`），原判定 `el.href !== '#'` 通过，把同页锚点当成跳转广告。`<a href="">` 同理被解析为当前 URL。
- **修复**：改用 `getAttribute('href')` 读取原始值，排除 `null`/空字符串/`#` 开头的锚点；`childLink` 选择器同步增加 `:not([href^="#"]):not([href=""])`。

### 验证

- `node --check` 语法检查通过
- 全部修复点与既有功能调用链一致性验证通过
- 版本号 0.1.64 → 0.1.65（user.js + meta.js 同步）

---

## v0.1.64 — 2026-08-05

### 新功能

- **不可见覆盖层广告扫描**（`scanInvisibleOverlays`）：检测"触碰到就跳转但看不见"的透明 overlay 广告。特征：`position:fixed/absolute` + `opacity:0`/`visibility:hidden`/透明背景 + `pointer-events:auto` + 大面积 + 跨域跳转能力。高风险项自动拦截。
- **新增菜单**：`👁 扫描不可见覆盖层广告`，列出所有可疑覆盖层（尺寸/触发 URL/跨域标记），支持逐项选择拦截，拦截时自动把跨域跳转域名加入全局黑名单。
- **横幅广告父容器隐藏**：`applyCSSRules` 对 `domainBlock` 和 `pathPattern` 规则额外生成 `*:has(> ${sel})` 规则，同时隐藏直接父容器，解决横幅广告仅隐藏 iframe 后留下空白占位的问题。AdGuard 导出同步使用 `#?#*:has(> ...)`。
- **preemptive 模式真正生效**：用 `requestAnimationFrame` 连续 5 帧重扫 CSS + 动态扫描 + 覆盖层扫描。
- **闪现自动检测**（`detectFlashAndMark`）：动态拦截时检测元素是否已渲染出非零尺寸 + 含广告关键词域名 → 自动标记闪现域。

### 修复

- **observer 泄漏**：`_whenBodyReady` 的 observer 持有为 `this._bodyReadyObserver`，`stopSelection` 开头先 `disconnect()`，防止停止后仍触发绑定导致监听器泄漏。
- **空指针崩溃**：`applyRegexRules` 中 `node.parentElement` 可能为 null（脱离 DOM 的文本节点），增加 `if (!element) continue;`。
- **懒加载属性覆盖**：`MutationObserver` 属性过滤器和 `scanAndBlockDynamic` URL 收集新增 `data-href`/`data-url`/`data-link`/`data-lazy`/`data-lazy-src`/`data-srcset`。
- **AdGuard 导出**：`pathPattern` 用 `#?#*:has(> ...)` 标记扩展 CSS；regex/complex 用 `#?#` 标记；正则转义完整化；domainBlock 拆分浏览器扩展版（`$third-party`）与 DNS 兼容版（无修饰符）。

### 接入点

不可见覆盖层扫描已接入：初始扫描、DOMContentLoaded、load、SPA 路由变化（popstate/hashchange/pushState/replaceState 劫持）、MutationObserver 去抖窗口、preemptive 多帧重扫。
