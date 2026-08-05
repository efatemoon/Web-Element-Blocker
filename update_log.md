# 更新日志

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
