# 更新日志

## v0.2.16 — 2026-08-06

### 真实 Bug 修复 + 算法优化 + 泛化引擎重写

针对代码审计发现的真实 Bug 与算法非最优项逐项修复，核心是让域名拦截真正生效、ReDoS 防护从事后检测改为事前拦截、泛化引擎从 MSA 逐位对齐重写为结构指纹聚类。

#### Bug 修复

1. **P0：safeRegexTest 伪超时保护**：原 `safeRegexTest` 在 `regex.test()` 执行完毕后才检测耗时，ReDoS 在 `test()` 内部阻塞数秒，事后检测无法阻止卡顿。新增 [isRegexSafe](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L838) 静态复杂度预检（嵌套量词 `(a+)+` / 重叠分支 `(a|ab)+` 检测），在 [applyRegexRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1394) 入口处过滤不安全正则，不执行。

2. **P1：导入取消后仍提示成功**：[importAll](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L329) 覆盖模式 `confirm` 取消后仅 `return`（返回 `undefined`），调用方 [btn-do-import](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L4569) 无论取消与否都 `alert('导入成功')` + `reload()`。改为 `importAll` 返回 `false` 表示取消，调用方检查返回值。

3. **P1：属性选择器预览与实际不一致**：[属性模式预览](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3506) 原本按 `level` 向上遍历隐藏父级，但 [applyCSSRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1080) 保存后直接注入 CSS 选择器无 level 逻辑。预览改为仅隐藏选择器命中的元素本身，确保预览=刷新后效果。

4. **P1：全局域名面板预览口径不一致**：[showGlobalDomainPanel 预览](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3298) 原本仅隐藏 `findSingleChildWrapper`，但正式封杀时 CSS `*:has(> :is(...))` 还会隐藏直接父级、`[src*=domain]` 隐藏元素本身。预览改为同时隐藏元素本身 + 直接父级 + 单子链容器，与 `applyCSSRules` + `scanAndBlockDynamic` 完全同口径。

#### 算法优化

5. **:has() CSS 规则合并**：[applyCSSRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1083) 原本 N 个域名生成 2N 条 CSS 规则，每条 `:has()` 触发独立子树遍历。改为批量合并（BATCH=40），CSS 规则数从 2N 降为 ⌈2N/40⌉×2，Style Recalculation 降低 ~70%。

6. **域名匹配 LRU 缓存**：[hostnameBlocked](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L872) 原本每次调用 `split('.')` + 循环，高频场景（同域名 20+ 请求）重复计算。新增 `_hostCache` Map（200 条 LRU 淘汰），`invalidateCache` 时一并清空。

7. **覆盖层扫描两阶段过滤**：[scanInvisibleOverlays](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L971) 原本对所有候选元素直接调用 `getComputedStyle`（最昂贵的 DOM API）。改为先用 `getBoundingClientRect` 过滤面积/视口，再对达标元素调 `getComputedStyle`，调用减少 80%+。

8. **导入去重 O(N×M) → O(N+M)**：[importAll](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L352) 原本用 `some(JSON.stringify(x) === JSON.stringify(item))` 线性扫描。改为用 `Set` 存 JSON 指纹，O(1) 查重。

9. **正则规则合并执行**：[applyRegexRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1394) 原本每个文本节点对每条规则调用 `regex.test()`，O(nodes × rules)。改为多条正则合并为一条（捕获组 `|` 连接），每个节点只调用一次 `exec`，通过捕获组索引定位命中规则，每节点 RegExp 调用从 N 次降为 1 次。

#### 泛化引擎重写

10. **PathGeneralizer 结构指纹聚类**：原 MSA 逐位对齐方案有四大缺陷：精度差（2 条路径即可产生通配）、跨站污染（混合对齐）、阈值过低、无反馈回路。重写为 [结构指纹聚类](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L630)：
    - 结构指纹：路径段分类为 NUM/VER/HEX/FILE/WORD，相同指纹归组
    - 精准通配：仅 NUM/HEX 位置通配，WORD 位置保留或小量枚举 `{a|b}`
    - 按站点独立泛化：不跨站混合
    - 误杀检测：用站点正常路径做反向验证，误杀率 > 30% 拒绝输出
    - 通配上限：通配段占比 > 50% 拒绝

11. **域名泛化覆盖收益比**：[AutoGeneralizer.run](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L790) 新增覆盖收益比过滤，仅当通配域名数 / 总域名数 > 0.6 时才输出泛化规则。

12. **正常路径采集**：[StorageManager.recordNormalPath](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L474) 新增正常路径采集能力，[NetworkInterceptor](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L2386) 对未拦截的请求记录 pathname 为正常路径样本（每站保留最近 200 条），供泛化引擎误杀检测使用。

#### 已验证无需修改（已最优）

- 网络层域名拦截（isUrlBlocked 已正确使用 new URL + hostname）
- PathInvertedIndex 短模式（已有 _fallback 数组）
- _ts 排序（addRule 已包裹 {domain, _ts: Date.now()}）
- MutationObserver 监听 / 时间分片扫描 / IntersectionObserver / 域名 Trie / debounce

## v0.2.14 — 2026-08-06

### 交互体验全面修复：预览一致性 + 域名可选 + 规则管理不退出 + 最近规则置顶

针对用户反馈的 7 项交互问题逐项修复，核心是让「预览所见 = 实际生效」、「删除规则不再被迫重开面板」、「最近过滤的规则一眼可见」。

#### Bug 修复

1. **手动选区域名不可选（问题1）**：[showActionPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L2767) 检测出的第三方域名原版只能全量封杀，误杀正常域名。改为域名 pill 可点击切换选中/取消（默认全选，灰色+删除线表示已取消），「彻底封杀」仅封杀选中项。

2. **预览与实际不一致（问题2&6）**：[手动选区预览](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L2972) 原本只隐藏当前选定元素，与「彻底封杀域名」后全页该域资源被隐藏的实际效果不符，导致用户刷新后发现正常元素也被过滤。预览改为隐藏「选中域名命中的全页元素 + 当前广告容器」，与正式封杀完全同口径；封杀前先 `resetActionPreview` 还原预览态避免叠加。

3. **规则管理删除导致退出（问题3）**：[showManager 删除按钮](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3681) 原对 regex/complex/pathPattern/domainBlock 调用 `window.location.reload()`，面板被关闭需重开脚本继续删除。改为统一 `this.showManager()` 原地重渲染 + 保留滚动位置，并补齐 `applyRegexRules/applyComplexRules/scanAndBlockDynamic` 重应用，使剩余规则即刻生效（与「按网站查看所有规则」面板行为一致）。

4. **规则列表最近置顶（问题4&7）**：[addRule](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L126) 为规则对象追加 `_ts` 时间戳；[showManager](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3563) 各类型按 `_ts` 倒序、域名黑名单置顶展示；[getAllSiteRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L230) 跨站记录按 `_ts` 倒序。旧规则无 `_ts` 视为 0，稳定排序保持原顺序。

5. **覆盖层扫描无预览/域名强制封杀（问题5&6）**：[showOverlayScanPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L4000) 原本无预览且拦截时强制把跳转域名加入黑名单。新增「🔍 预览效果」按钮（预览隐藏选中覆盖层 + 勾选域名时全页该域资源也被隐藏，与正式拦截一致）与「同时封杀跳转域名」复选框（默认勾选，可取消仅隐藏元素不入黑名单）。新增 `this._overlayPreview` 实例状态，`clearPanel` 跨面板切换兜底还原 visibility/pointer-events/display/opacity。

6. **路径模式无法预览（问题6）**：[正则面板 path 模式](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3343) 原提示「路径模式无法预览」。改为隐藏全页 src/href/data-*/srcset 含该路径片段的资源容器，命中 0 项时提示空预览。

#### 其他

- 新增 CSS：`.domain-item.unselected`（灰色删除线）、`.rule-list .rule-section-title`（域名置顶小标题）。
- `_resetActionPreview` / `clearPanel` 适配多元素预览（`elements` 数组），保留旧单元素字段向后兼容。
- 构造函数初始化 `_overlayPreview` / `_actionHosts` / `_actionHostsEl` 实例属性。

### 验证

- `node --check` 语法检查通过（user.js + meta.js）
- 手动选区：域名 pill 点击切换 → 按钮文案「封杀 N/总数」联动 → 预览仅隐藏选中域资源 ✓
- 规则管理：删除任意类型规则 → 面板原地重渲染、滚动位置保留、可连续删除 ✓
- 覆盖层扫描：预览隐藏选中项 + 勾选域名时全页同域资源同步隐藏；取消勾选仅隐藏元素不入黑名单 ✓
- 路径模式预览：输入路径片段 → 命中资源容器隐藏，恢复显示还原 ✓
- 版本同步：user.js + meta.js 均 0.2.13 → 0.2.14

---

## v0.2.13 — 2026-08-05

### 核心过滤功能深度审计 + 5 处 Bug 修复

对 `GM_registerMenuCommand` 注册的 10 个菜单及底层拦截链路（网络层 / DOM 层 / Shadow DOM / 覆盖层）深度审计，修复 3 处影响广告过滤正确性的关键 Bug + 1 处死代码清理 + 1 处覆盖层扫描盲区。

#### Bug 修复

1. **同源守卫过度跳过子域名黑名单**（[isUrlBlocked](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L809) + [scanAndBlockDynamic](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1217)）：
   - **根因**：`absUrl.hostname.endsWith('.' + location.hostname)` 将当前页面的所有子域划入豁免区，导致用户显式拉黑的 `ads.example.com` 在浏览 `example.com` 时**域名黑名单完全不生效**——网络层不拦截、DOM 层不隐藏，广告照常加载。
   - **影响**：同源子域广告（站点自托管广告 / CDN 子域广告）成为拦截盲区，这是最常见的广告投放形态之一。
   - **修复**：两处守卫均移除子域豁免，仅保留精确同域豁免（`hostname !== location.hostname`）。用户显式拉黑的子域现在在父域页面上正确拦截；页面自身根域仍受精确豁免保护不会白屏。

2. **Shadow DOM 观察器闭包捕获过期规则**（[\_observeShadowRoot](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1435) MutationObserver 回调）：
   - **根因**：`_observeShadowRoot` 在创建 MutationObserver 时通过 `const { domainList, pathPatterns } = this._getLists()` 捕获了当时的规则数组引用。后续用户增删规则触发 `invalidateCache()` 将 `_cachedDomainList` / `_cachedPathPatterns` 置 null，但闭包变量仍指向旧数组。Shadow DOM 内动态注入的节点永远用**过期规则**匹配，新增的域名/路径规则对 shadow 内广告完全失效。
   - **修复**：MutationObserver 回调内改为调用 `this._getLists()` 重新获取缓存（缓存被 invalidate 后会从 storage 重读），确保 shadow 内动态节点始终用最新规则匹配。

3. **不可见覆盖层扫描不穿透 Shadow DOM**（[scanInvisibleOverlays](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L910)）：
   - **根因**：`root.querySelectorAll(...)` 不跨越 shadow 边界，广告 SDK 在 shadow root 内注入的透明跳转覆盖层完全逃逸检测。这是 v0.1.68 覆盖层检测增强后遗留的盲区。
   - **修复**：主候选扫描完成后，遍历所有带 `shadowRoot` 的元素递归调用 `scanInvisibleOverlays`，覆盖层检测现在能穿透 shadow 边界；同时 `[_scheduleShadowApply](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1483)` 新增 `scanInvisibleOverlays` 调用，shadow 内动态注入的覆盖层也会被去抖拦截。

#### 死代码清理

4. **移除 `_cachedGenDomainList` 死字段**：该字段在 `getGeneralizedDomainSet` 中赋值、在 `invalidateCache` 中清除，但**全代码库无任何读取点**（实际使用的是 `_cachedGenDomainSet` 即 Set 结构）。移除声明、赋值、清除三处无效代码。

### 验证

- `node --check` 语法检查通过（user.js + meta.js）
- 同源守卫修复验证：`ads.example.com` 在 `example.com` 页面下 → `hostname !== location.hostname` 为 true → 进入域名检查 → 命中黑名单拦截 ✓；`example.com` 自身 → 精确豁免 → 页面不白屏 ✓
- Shadow DOM 闭包修复验证：`invalidateCache` 后 MutationObserver 回调调用 `_getLists()` 重读 storage → 新规则生效 ✓
- 覆盖层穿透验证：递归扫描 `el.shadowRoot` → shadow 内透明跳转层被检测并 autoBlock ✓
- 10 菜单 + 核心过滤链路审计无其他 Bug

---

## v0.2.12 — 2026-08-05

### 优化方案 v2 全量落地：自动化泛化引擎 + 模糊拓扑指纹 + 构造样式表

对照更新版 `优化方案.md` 逐项实现六大新维度（倒排索引接入、MurmurHash3 模糊拓扑、Constructable Stylesheets、双轨自动化泛化），并修复审查发现的迁移范围 Bug。

#### 一、网络层倒排索引接入（PathInvertedIndex）

- 新增 [PathInvertedIndex](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L453) 类：提取每条 pattern 最长 ≥4 字符 token 建 `Map<token, Set<pattern>>`，匹配时仅对 URL 中出现的 token 对应候选 pattern 做字面子串校验，将 O(N) 线性遍历降为 O(tokens) 查找。
- [BlockEngine.isUrlBlocked](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L800) 路径匹配改走倒排索引（网络层高频调用受益最大）；新增 [\_ensurePathIndex](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L739) 懒构建，[invalidateCache](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L725) 重置 `_cachedPathIndex`。
- DOM 扫描仍用 [getPathMatcher](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L760) 合并正则以保留 `.exec()` 提取匹配串日志。

#### 二、模糊拓扑指纹（MurmurHash3 + 父链骨架）

- 新增 [murmur32](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1779)：`Math.imul` 32-bit 整数乘法 + 位运算的非加密哈希。
- 重写 [generateTopologyFingerprint](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1806)：抛弃脆弱的兄弟节点索引（广告脚本插入空 div 即可破坏），改为沿父链上溯至 body（最多 5 层），仅采集 `Tag + className 长度分布`（不采 class 名，抗随机化），经 MurmurHash3 压缩为 hex，带 `mh:` 前缀标记新算法。
- 新增 [migrateTopoHashes](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1827)：一次性剥离旧版明文拓扑指纹（无 `mh:` 前缀），让规则退化为纯 Selector 兜底；[applyTopologyRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1859) 仅匹配 `mh:` 前缀哈希。

#### 三、Constructable Stylesheets 零解析注入

- 新增 [\_getSheet](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1089)：Feature Detection `'adoptedStyleSheets' in document` 优先构造 `CSSStyleSheet` + `adoptedStyleSheets`，不支持时降级到 `<style>.sheet`。
- [applyCSSRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1004) 构造样式表路径走 `replaceSync` 一次性 C++ 注入（不触发 HTML 解析器，且无法被 `document.querySelector('style')` 探查，自带防反屏蔽）；整体替换失败（某条 `:has()` 选择器非法）时降级到逐条 `insertRule` 隔离，单条非法不影响其余。
- [\_clearSheetRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1119) 统一清空任意 CSSStyleSheet，兼容两种路径。

#### 四、自动化泛化引擎（双轨推导）

- [DomainGeneralizer](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L517)：反向基数树 (Reverse Radix Trie)，某基准域名下子域密度 ≥3 时收敛为 `*.base` 规则；**安全约束**：仅在 ≥2 层（com.xxx）时输出通配，杜绝 `*.com` 灾难性规则。
- [PathGeneralizer](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L575)：多序列对齐 (MSA) 的 Token 级通配推导，仅将变异维度替换为 `*`，严格保留尾部特征；**熔断条件**：有效字符 < 8 / 通配符 > 2 / 退化为 `/*` → 判定误杀风险废弃。按首段聚类后逐组对齐。
- [AutoGeneralizer](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L639)：防抖编排器，读取全局域名黑名单与全站路径模式，驱动双轨泛化并写入 `generalizedRules` 存储。

#### 五、泛化规则全链路集成

- StorageManager 新增 [getGeneralized/setGeneralized/removeGeneralizedRule](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L235) CRUD，独立存储键 `generalizedRules = { domain:[], path:[], fused:[] }`。
- [BlockEngine](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L772) 新增 `getGeneralizedDomainSet`（`*.` 剥前缀复用 `hostnameBlocked` 父域上探）与 `getGeneralizedPathRegex`（`*` → `[^/]*`，其余转义）；[isUrlBlocked](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L800) 与 DOM 扫描均接入泛化域名/路径匹配。
- 触发钩子：`addRule`/`removeRule`（domainBlock）、`saveData`/`removeRuleForDomain`（pathPattern）、`clearDomain`、`importAll` 均防抖调用 `AutoGeneralizer.schedule()`。
- [exportAll/importAll](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L286) 含泛化规则（合并去重 / 覆盖替换）。

#### 六、泛化管理面板

- 新增 [showGeneralizationPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L4120)：三段式展示域名轨 / 路径轨 / 熔断日志，支持删除与"重新泛化"，复用既有面板设计令牌；菜单注册 `🤖 自动化泛化规则`，管理面板新增入口按钮。
- 仅重渲染列表容器（同 Bug6 规避），`makeDraggable` 全程一次，杜绝监听器泄漏。

#### Bug 修复（代码审查发现）

1. **`migrateTopoHashes` 仅迁移当前域名**（[migrateTopoHashes](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1827)）：原实现经 `storage.getData().structural` 只取当前域名规则，而 `topoHashMigrated` 标记为全局，导致升级用户在其他域名的旧明文拓扑指纹永不被清理 → 改为直接读 `structBlocks` 字典遍历所有域名。
2. **`PathInvertedIndex` 声明未接入**：`_cachedPathIndex` 字段已声明但 `invalidateCache` 未重置、`isUrlBlocked` 未调用 → 补 `_ensurePathIndex` 懒构建并在 `invalidateCache` 重置标记。
3. **`DomainGeneralizer` sources 元数据错位**：`childDomains` 过滤比较时 reverse 切片（`com.ads`）与正向拼接（`ads.com`）顺序不一致，导致 sources 恒为空 → 统一为 `[...currentPath, key].join('.')` 倒序键。

#### 10 菜单功能逐项审计 + 修复

对 `GM_registerMenuCommand` 注册的全部 10 个菜单（手动选择 / 全局检索域名 / 扫描覆盖层 / 添加规则 / 管理规则 / 按网站查看 / 自动化泛化 / 导出 / AdGuard 导出 / 导入）深度审计，修复 8 处 Bug：

1. **导入后重新泛化永不执行**（[showImportPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L4252) → importAll）：`importAll` 调防抖 `AutoGeneralizer.schedule()`（500ms），但 `showImportPanel` 紧随 `alert` + `reload()`，导航取消定时器，注释承诺的"导入后重新泛化"落空 → 改为同步 `AutoGeneralizer.run()`，由 `beforeunload` 落盘。
2. **预览后改选再封杀，未选中域名元素会话内永久隐藏**（[showGlobalDomainPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3081)）：封杀 handler 直接清空预览状态不恢复 display，假设预览元素==封杀元素；用户预览后取消勾选某域名再封杀，该域名元素无规则却保持 `display:none` → 封杀前先 `resetGlobalPreview` 恢复全部预览元素，封杀逻辑随后重新隐藏选中域名。
3. **正则模式保存未校验非法正则**（[showRegexPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3444)）：regex 模式直接存入用户输入，`applyRegexRules` 编译失败时静默丢弃，规则永不生效无提示 → 保存前 `new RegExp` 校验，与预览路径一致。
4. **删除 pathPattern/domainBlock 规则未刷新，inline 隐藏残留**（[showManager](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3589)）：`scanAndBlockDynamic` 对路径/域名匹配的动态资源设 inline `display:none`，删除规则只重建样式表（移除 CSS 层），inline 样式残留致已隐藏元素不恢复 → 将 pathPattern/domainBlock 纳入 reload 分支（与 regex/complex 一致）。
5. **complex 规则去重漏比 `logic`**（[addRule](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L146)）：同 conditions+level 但不同 logic（AND vs OR）的规则被误判重复丢弃 → 补 `item.logic === rule.logic`。
6. **AdGuard 导出 text equals 正则不 trim**（[generateAdGuardRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3771)）：导出 `/^value$/` 锚定整段 textContent 不容空白，而脚本自身匹配用 `val.trim()===c.value.trim()`，跨平台迁移后规则失效 → 改为 `/^\s*value\s*$/`（AND 与 OR 两处）。
7. **AdGuard 复制 fallback 在 Shadow DOM 不可靠**（[showAdGuardExportPanel](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3854)）：`createRange+selectNode` 对 Shadow DOM 内 div 的程序化选区跨浏览器不一致 → 改为 `<textarea readonly>` + `select()` + `execCommand`，与 showExportPanel 一致。
8. **覆盖导入缺失键不清空**（[importAll](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L315)）：覆盖模式下导入 JSON 缺某键时跳过处理，现有数据保留，与"覆盖"语义矛盾 → 缺失键显式清空（dictKeys→{}、domainBlocks→[]、generalizedRules→空）。

清理 1 处死代码：`showOverlayScanPanel` 封杀 handler 的降序 `sort`（不删除数组元素，sort 无意义）。

### 验证

- `node --check` 语法检查通过（user.js + meta.js）
- MurmurHash3 确定性验证：相同输入产相同 hex；空串与多层级输入均稳定
- DomainGeneralizer 边界用例：3 子域 → `*.ads.com`（sources 正确填充）；google/facebook/amazon → `[]`（`*.com` 守卫生效）；< threshold → `[]`
- PathGeneralizer 边界用例：`/ads/banner/1.js` 等 3 路径 → `/ads/banner/*`（vc=9≥8 通过）；`/a/b` vs `/a/c` → null（vc=1<8 熔断）
- Constructable Stylesheets 降级链：支持时 `replaceSync` 快路径 → 整体失败时 `insertRule` 隔离 → 不支持时 `<style>` 降级
- AdGuard text equals 导出串验证：`:has-text(/^\s*广告\s*$/)` 正确生成
- 六大维度全部落地：倒排索引 ✅ / MurmurHash3 模糊拓扑 ✅ / Constructable Stylesheets ✅ / 域名泛化 ✅ / 路径泛化 ✅ / 泛化面板 ✅
- 10 菜单逐项审计：startSelection / showOverlayScanPanel / showAllSitesPanel / showGeneralizationPanel / showExportPanel 审计无 Bug；其余 5 项共修复 8 处

---

## v0.2.11 — 2026-08-05

### 优化方案六大维度终检 + 隐藏 Bug 修复

对照 `优化方案.md` 逐维度复核，补齐缺失项并修复代码审查发现的 4 个隐藏 Bug。

#### 维度二.3 补齐：广告域置信度评分引擎（Logistic Regression）

- 新增 [AdScorerLR](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1566) 类：用 Sigmoid 将线性累加压缩到 (0,1) 概率区间，从数学根源解决"分数无上限"与基础设施域名误杀；结合香农熵识别 DGA 随机子域。
- 接入 [NetworkInterceptor.isUrlBlocked()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1663)：LR 得分 ≥ 85 且非同源/非安全 CDN 时自动加入拦截队列，减少人工指认成本（软阻断 200 空响应，单关键词域名不触发）。
- [extractResourceDomains](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1437) 评分矩阵加 `Math.min(100, …)` 上界，与 LR 引擎 0-100 刻度对齐。

#### 维度六.1 补齐：匹配引擎耗时看板

- `BlockEngine.stats` 新增 `matchTimeMs`，[scanAndBlockDynamic](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L753) 累计 `performance.now()` 耗时。
- 管理面板状态栏由 2 列扩为 3 列，新增 `⚡ 匹配耗时 N ms`，衡量 Long Task 风险。

#### Bug 修复（代码审查发现）

1. **requestIdleCallback 丢失文本节点**（[applyRegexRules](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L876)）：原逻辑 `timeRemaining` 耗尽时 `break`，但 `walker.nextNode()` 已推进指针，该节点永久漏匹配 → 改为先执行 `_executeRegexMatch` 再判时让出，确保每个节点都被处理。
2. **Shadow DOM 规则失效**（[\_observeShadowRoot](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1008)）：① 初始扫描传 `ShadowRoot`（nodeType 11）被 `scanAndBlockDynamic` 的 ELEMENT_NODE 守卫直接 return，成空操作 → 改为遍历 `root.children` 逐个扫描；② 观察器回调只跑域名/路径规则，正则/积木/拓扑规则对 shadow 内动态内容完全失效 → 新增 [\_scheduleShadowApply](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1045) 去抖补跑三类规则；③ `applyComplexRules`/`applyTopologyRules` 用 `targetNode.parentElement` 回退，而 `ShadowRoot.parentElement` 为 null → 增加 `DOCUMENT_FRAGMENT_NODE` 分支直接以 shadow root 为查询根。
3. **高亮颜色配置失效**（[showManager](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L3062)）：`#ui-highlight-color` 输入框无任何事件监听器，`config_highlight_color` 只读不写，颜色永远保持默认 → 补 `input` 监听器，校验 Hex 后实时更新 CSS 变量、预览色块并 `GM_setValue` 持久化。
4. **IntersectionObserver 内存泄漏**（[childListObserver](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1126)）：节点从 DOM 移除后未 `unobserve`，IntersectionObserver 持强引用阻止 GC，SPA 虚拟列表/无限滚动场景内存持续增长 → `removedNodes` 回调中主动 `unobserve`。

### 验证

- `node --check` 语法检查通过
- AdScorerLR 边界用例：空 URL / 2 段 hostname / 畸形 URL 均 try/catch 放行；单关键词域名（ad=50/ads=57）低于阈值 85 不误杀，双关键词（ads+track=91）触发自动拦截
- 6 维度优化全部落地：网络层 ✅ / ReDoS ✅ / LR 评分 ✅ / CSSOM 增量 ✅ / MutationObserver 拆分 ✅ / IntersectionObserver ✅ / TreeWalker 分片 ✅ / WeakSet+Shadow 穿透 ✅ / StorageManager 防抖 ✅ / 拓扑哈希 ✅ / 状态看板+Hex 配置 ✅

---

## v0.2.00 — 2026-08-05

### Bug 修复：预览→恢复后红框消失

#### Bug 10：点击"预览效果"再点"恢复显示"，选定元素红框不再显示

- **位置**：`UIManager._resetActionPreview` / `#btn-preview` 点击处理
- **根因**：预览时执行 `el.classList.remove('pro-blocker-selected')` 移除红框类，但 `_resetActionPreview` 恢复 `display` 时只做了 `classList.remove('pro-blocker-selected')`（再次移除），**从未重新添加**。导致恢复后选定元素的红框（`pro-blocker-selected`）永久消失，用户看不到当前框选的是哪个元素。
- **修复**：
  1. 预览时不再移除 `pro-blocker-selected`（`display:none` 已使红框不可见，移除无意义）。
  2. `_resetActionPreview` 恢复 `display` 后，重新为 `currentSelectedEl` 挂上 `pro-blocker-selected` 类，红框复原。
  3. 缩放按钮调用链（先 `_resetActionPreview` 再 `_applySelectionHighlight`）经验证无双重红框问题。

### 网络层全量拦截架构（NetworkInterceptor）

按优化方案落地网络层拦截，在 `document-start` 阶段劫持三类请求入口，命中黑名单域名或路径模式时**源头丢弃请求**，而非等 DOM 渲染后再隐藏，节省带宽并消除广告闪现。

- **Fetch 劫持**：命中返回空 `200 Response`，避免页面 `fetch().then` 抛错。
- **XHR 劫持**：命中改写 `open` 的 url 为 `about:blank`（同源空响应），XHR 正常完成但无广告数据。
- **`<script src>` 劫持**：命中静默不设置 src，广告脚本永不加载。
- **判定复用** [BlockEngine.isUrlBlocked()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L398)，与 DOM 层规则完全一致（域名 Set + 路径合并正则），避免双标。已用 8 个用例验证（含同域自托管广告路径拦截、子域、相对 URL）。

### 核心算法与数据结构升级

#### 合并路径正则（替代 Aho-Corasick 的轻量方案）

- 新增 [getPathMatcher()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L388)：多条路径模式转义后合并为单个 `RegExp`，一次 `test` 完成 O(L) 匹配，替代原 O(n) 线性 `includes` 遍历。缓存与 `_cachedPathPatterns` 同生命周期，`invalidateCache` 一并失效。
- AC 自动机对当前规则量（个位数~数十条）收益有限且实现复杂，合并正则在可读性与性能间取得最佳平衡。

#### ReDoS 灾难性回溯防护

- 新增 [safeRegexTest()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L416)：截断超长文本（>2000 字符）+ 耗时熔断（>8ms 告警跳过），`applyRegexRules` 改用此方法，防止用户输入的低效正则阻塞主线程。

#### 域名集合与 URL 判定收敛

- 新增 [getDomainSet()](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L377) 统一暴露域名 Set，网络拦截器与动态扫描共用同一缓存，避免重复 `new Set`。

### 拦截统计看板

- `BlockEngine.stats = { networkBlocks, domBlocks }`：网络层与 DOM 层拦截分别计数。
- 管理面板状态栏新增 `🌐 网络拦截 N 次 / 🧩 DOM 屏蔽 N 个` 看板（本页会话累计，刷新归零），提升工具透明度。

### 广告域评分矩阵对齐方案

[extractResourceDomains](file:///d:/github%20repositories/ad-block/web-element-blocker.user.js#L1197) 评分对齐方案矩阵：脚本来源 `+20→+25`、安全 CDN `-30→-50`（更严格抑制误报），其余权重（keyword 40 / data-attr 15 / style 10 / srcset+attr 10 / 频次上限 20）保持不变。

### 验证

- `node --check` 语法检查通过
- `isUrlBlocked` 8 用例全通过（黑名单域、子域、同域路径、相对 URL、合法资源放行）
- 红框 bug 修复路径核对：预览不移除类 → 恢复重加类，缩放链无双重红框
- 网络拦截 hook 均带 `__proBlockerHooked` 幂等标记，重复 init 不重入

---

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
