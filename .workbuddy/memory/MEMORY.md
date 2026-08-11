# 项目长期记忆

## iframe 防线 v3.0 架构要点

### 核心设计
- **冻结测量**：`IframeGuard._ensureRecord()` 首次测量 iframe 几何值（width/height/opacity/zIndex），后续 classify 读冻结值，防「隐藏→重测→分数漂移→振荡」
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

## video-accelerator.user.js 深度扫描（2026-08-11）
- 健康评分：66/100 → 68/100（C1/W9 修复后）
- Brooks-lint 全部 MANUAL 项已修复：C1 跨域双文档守卫、W9 _evaluateStale() 死代码实现
- 测试套件：122/122（unit）+ 50/50（core-module）= 172/172 全部通过
- 架构优化：提取 `static _configMap`（25项）消除 3× 重复配置代码，删除透明包装 `_mount()`
- 当前文件：4065 行
- **本次修复（11:24）**：8 项五轴审查修复，文件增至 4070 行
- **本次修复（11:20）**：补充 VA_BUFFER 缺失的 5 个常量（STALL_LEVEL/RECOVERY_TIMEOUT），修复 BACK_BUFFER_TRIM_S 引用错误
- **五轴审查修复（11:24）**：8 项修复（见下方详细记录）

## web-element-blocker.user.js 深度扫描 v3.0（2026-08-11）
- 健康评分: 69/100 (C+)
- 已修复: 空 catch 块 172→0, console 残留 19→0, UIManager 反向依赖 49→0
- 测试套件: 13 个文件, 44 个测试用例 (ad-block-test/)
- 待修复 P0: OverlayAdScanner 4766 行需拆分, 138 魔法数字需提取常量
- 报告: ad-block-test/HEALTH_REPORT.md

## video-accelerator.user.js 五轴审查修复（2026-08-11 11:24）

### 修复清单
| 编号 | 级别 | 行号 | 问题 | 修复 |
|------|------|------|------|------|
| FIX-1 | Critical | L4023 | `VA_TUNING.TIMELINE_RENDER_THROTTLE_MS` 应为 `VA_BUFFER` | 修正常量引用 |
| FIX-2 | Important | L1910 | `SessionManager` 前向引用无 typeof 守卫 | 加 `typeof SessionManager !== 'undefined'` |
| FIX-3 | Medium | L55 | `VIDEO_RE` 包含 `mp3|aac` 音频误匹配 | 移除音频扩展名 |
| FIX-4 | Medium | L3824 | 日志阈值硬编码 250 与 `VA_BUFFER.LOG_LINE_LIMIT=200` 不一致 | 统一为常量 |
| FIX-5 | Medium | L2788 | `visibleOnly` 跳过时未加入 `this.seen` | 补充 `seen.add(video)` |
| FIX-6 | Minor | L433-450 | `update()`/`silentUpdate()` 重复代码 | 提取 `_applyPatch(patch, emit)` |
| FIX-7 | Minor | L2193 | click 事件用 capture:true 导致 `e.target.closest()` 行为异常 | 改 bubbling |
| FIX-8 | Minor | L1430 | `_patrol()` 未检查 `DOC` 是否为 null | 加 `if (!DOC) return` |

### 验证
- 语法检查：通过
- 文件行数：4065 → 4070
- 已知遗留：M3/M4/P1（低优先级，可选优化）
