# 项目长期记忆

## iframe 防线 v3.0 架构要点

### 核心设计
- **冻结测量**：`IframeGuard._ensureRecord()` 首次测量 iframe 几何值（width/height/opacity/zIndex），后续 classify 读冻结值，防「隐藏→测量归零→分数漂移→振荡」
- **单一数据源**：`_frameRecords` WeakMap 持有每个 iframe 的 record，verdict/blocked/manual/counted 全部集中存储
- **判定粘性**：`blocked || manual` 的 frame 永不自动复活（除非白名单）
- **stats 首次计数**：`rec.counted` 对象确保每个 iframe 的 blocked/protected/scanned 只计数一次
- **粘性保留**：`rescanAll/forceRescan` 迁移 blocked/manual 记录，不整体重置

### 帧内深扫闭环
1. `IframeDeepScanner.scanAll()` → 全引擎入帧（domainSet + pathPattern + scanInvisibleOverlays + 递归嵌套iframe）
2. 产出元素级 record（{el, category, suspicion, selector, frameHost, chain, depth}）
3. `IframeGuard.blockInFrameNode(rec)` → 同源帧写 `storage.addRuleForDomain(frameHost, 'attribute', {_meta:'iframe-scan'})` + 即时隐藏
4. `IframeGuard.reapplyInFrames()` → 先 restore 帧内 inline 隐藏，再按未禁用规则重隐藏（用 hostname 比较）

### Panel 交互
- `showIframePanel()`：帧级列表（🛡拦截/✅保护按钮）+ 帧内元素级列表（嫌疑分+selector）
- `blockedFingerprints` WeakSet：跨扫描保留已拦截状态
- `this._iframePreview`：预览状态（同覆盖层面板口径，含 _showPreviewBanner）
- `this._iframeUnsubs`：EventBus 订阅句柄数组，clearPanel 时统一退订
- 行 click = 勾选/展开，动作仅走按钮（H8）

### VICE 词集拆分（H10）
- `VICE_LONG_TOKENS`：仅强特征词（casino/poker/baccarat 等），可单独单判
- `NEEDS_TLD`：link/live/tiny/jump/short/owly，需叠加 GAMBLING_TLDS 才判
- `VICE_SHORT_TOKENS_NAV`：≤3 字符词，须叠加 GAMBLING_TLDS

### PathInvertedIndex 滑窗
- `build()`：对每个 pattern 提取所有长度为4的滑窗口作为倒排键
- `test(pathStr)`：对 URL path 提取滑窗口集合（token滑窗+整串滑窗），查候选pattern做字面子串校验

### B10 子帧补报
- `_observeFrameChildren(iframe, depth)`：为同源帧设 MutationObserver，新 iframe 出现时 2s 去抖补报（存 timer，去抖），最多3次

## v0.10.0 修复记录（2026-08-10）

### 已修复 Bug 清单（H1-H16）
| Bug | 修复 | 状态 |
|-----|------|------|
| H1 | protectInFrame 移除 this.showToast | ✅ |
| H2 | MessageGuard snippet: lower.slice(0,200) | ✅ |
| H3 | 删除 OverlayAdScanner.deepScan 整段 | ✅ |
| H4 | overlay 直接 _buildRecord 透传 | ✅ |
| H5 | reapplyInFrames 用 hostname + restore | ✅ |
| H6 | buildRecords 三分支补 rule 字段 | ✅ |
| H7 | rescanAll/forceRescan 保留粘性 | ✅ |
| H8 | 行 click = 勾选，动作走按钮 | ✅ |
| H9 | 首绘 stats + _incStat | ✅ |
| H10 | VICE_LONG_TOKENS 移入 NEEDS_TLD | ✅ |
| H11 | chain 空数组用三元修复 | ✅ |
| H12 | renderScanList 异步化 | ✅ |
| H13 | _observeFrameChildren 2s 去抖 | ✅ |
| H14 | generateOptimalSelector 精准选择器 | ✅ |
| H15 | endsWith('-ad') 统计文案 | ✅ |
| H16 | isCrossOrigin 死代码删除 | ✅ |

### 代码审查（2026-08-10）
- 工具扫描 343 条问题，全部误报
- 10 条"严重"均为 CSS 选择器字符串拼接被识别为 SQL 注入，或模板字符串误报
- 19 条"一般"均为带 `[Pro Blocker]` 前缀的 console.error/warn，属正常错误捕获日志
- 无真实问题，代码状态健康

### 代码简化（2026-08-10）
- safeGetComputedStyle 工具函数：消除 2 处 viewCSS 重复
- evaluateRuleImpact 提取 _countMatches：消除 6 处 try-catch 计数重复
- isSafeOutermost 逻辑压缩：6 行 → 3 行
- BUG-S1 过时注释清理
- 语法检查通过，10 个菜单项完整
