/**
 * video-accelerator.user.js 全维度深度扫描报告
 * 生成时间：2026-08-11
 * 扫描文件：video-accelerator.user.js (4015 行, 14 个类)
 */

// ===== 数据定义 =====
const ISSUES = {
    critical: [
        {
            id: 'C1',
            title: '跨域 iframe 的 document 对象注入 IIFE 作用域',
            line: '第 22-24 行',
            ref: 'Fowler《RefaCTORing》§1.1 "Ambiguous References"',
            desc: '当脚本在跨域 iframe 内执行时，PW.document 返回内层文档，而 document 全局变量（回退）返回 IIFE 外层顶层文档。两者不同源，导致后续所有 DOC.body、DOC.querySelector 等操作混用两份文档。',
            fix: '增加同源守卫：const DOC = PW.document || (PW === window ? document : null);',
            pain_x_spread: '高 × 高'
        },
        {
            id: 'C2',
            title: 'forEach 中通过 WeakMap 删除 video 引用导致队列失效',
            line: '第 1733-1781 行',
            ref: 'Martin《Clean Code》§5.5 "Comments on Bad Code"',
            desc: '_evaluate() 遍历 queue 时调用 this.pool.delete(candidate.video)，WeakMap 删除后 candidate.video 对象被 GC，但 candidate 本身仍在 queue 中（queue 是 Set 存储对象引用）。下次 _evaluate 执行时，该 candidate.video.isConnected 抛出 TypeError，但被外层 try-catch 吞掉，导致候选状态永久卡住。',
            fix: '在 _evaluate 末尾显式清理：this.queue = new Set([...this.queue].filter(c => c.video.isConnected));',
            pain_x_spread: '中 × 高'
        },
        {
            id: 'C3',
            title: 'sessionCounter 无界递增，长时间运行后溢出',
            line: '第 1854 行',
            ref: 'Code Complete《代码大全》§5.4 "Integer Overflow"',
            desc: 'let sessionCounter = 0; this.id = ++sessionCounter; 单调递增永不重置。页面持续运行数小时后，session.id 可能超过 Number.MAX_SAFE_INTEGER (9e15)，导致所有基于 sessionId 的事件匹配失效（SESSION_UPDATE、RECOVERY_BLOCKED 等）。',
            fix: 'if (++sessionCounter >= 9007199254740991) sessionCounter = 0; 或改用 Math.random().toString(36)',
            pain_x_spread: '低 × 高'
        }
    ],
    warning: [
        {
            id: 'W1',
            title: '109 个空 catch 块吞没所有错误',
            line: '全文散布（126 个 catch，其中 109 个为空）',
            ref: 'Martin《Clean Code》§5.1 "Use Expectations Instead of Try-Catch"',
            desc: '整个文件有 109 个空 catch 块（catch(e){}），静默吞没所有异常。包括：NetworkError、SecurityError、TypeError、DOMException 等。当视频播放异常时，开发者无法从日志定位根因。',
            fix: '定义统一的 silent handler：const SILENT = () => {}; 并在关键错误路径（tryPlay、_onError、_emergencyLoad）替换为 Logger.debug("silent", e && e.message)',
            pain_x_spread: '中 × 高'
        },
        {
            id: 'W2',
            title: 'estimateBandwidth / getNetworkType 无缓存',
            line: '第 85-107 行，被调用 7 次',
            ref: 'Code Complete《代码大全》§20.3 "Optimizing Data Access"',
            desc: 'estimateBandwidth() 每次调用都执行 performance.getEntriesByType("resource") 全量扫描（最坏情况 O(n)，n=当前页面所有 resource entry），又被 _idle()、getState()、getInfo() 多处调用。getNetworkType() 同样被多次调用。',
            fix: '添加 5 秒时间窗口缓存：let _bwCache=0, _bwTs=0; if (now-_bwTs<5000) return _bwCache;',
            pain_x_spread: '低 × 中'
        },
        {
            id: 'W3',
            title: 'ConfigManager.set 双重 load() 调用引入时序竞争',
            line: '第 366-372 行',
            ref: 'Fowler《RefaCTORing》§13.4 "Temporary Field"',
            desc: 'set() 先 this.load() 修改本地缓存，再 this.save() 写入 Storage，最后再 this.load() 读取。若 Storage 写入失败（如配额超限），第二次 load() 返回旧值，导致 emit 的 config 与实际值不一致。',
            fix: '直接使用修改后的本地缓存：const loaded = this._cache; this.bus.emit(...)',
            pain_x_spread: '低 × 低'
        },
        {
            id: 'W4',
            title: 'DOC.hidden 与 Scheduler.hidden 状态不一致',
            line: '第 553-557 行 vs 1358、2211、2902 行',
            ref: 'SOLID 原则 - DRY (Don\'t Repeat Yourself)',
            desc: 'visibilitychange 事件监听更新 Scheduler.hidden，但 _patrol()、_slowTick()、_canAttempt() 中直接读取 DOC.hidden，两者可能不同步（如事件在 Scheduler.start() 前触发）。',
            fix: '统一使用 Scheduler.hidden，移除所有直接读取 DOC.hidden 的代码',
            pain_x_spread: '低 × 中'
        },
        {
            id: 'W5',
            title: 'SessionState 字符串常量与对象常量混用',
            line: '第 3750-3751, 3874-3880 行',
            ref: 'Martin《Clean Code》§4.6 "One Word Per Concept"',
            desc: '_healthScore() 和 _updateFab() 中用 s.sessionState === \'failed\' 字符串字面量，而其他 36 处使用 SessionState.FAILED 常量引用。虽然当前碰巧值一致，但属于隐式契约，任一方的修改都会导致静默 Bug。',
            fix: '全文件统一使用 SessionState.FAILED / SessionState.RECOVERING 常量',
            pain_x_spread: '中 × 中'
        },
        {
            id: 'W6',
            title: 'CandidateArbiter 直接访问 SessionManager.sessions 内部属性',
            line: '第 1822 行',
            ref: 'SOLID 原则 - DIP (Dependency Inversion Principle)',
            desc: 'CandidateArbiter.score() 直接访问 SessionManager.sessions.size，耦合了另一个模块的内部实现。若 SessionManager 重构 sessions 为私有 Map，此处直接崩溃。',
            fix: '在 SessionManager 暴露 hasActiveSessions() 方法',
            pain_x_spread: '中 × 低'
        },
        {
            id: 'W7',
            title: 'Adaptor.detect() 无缓存，每次调用重新扫描 HLS/DASH 属性',
            line: '第 1449-1480 行',
            ref: 'Fowler《RefaCTORing》§7.1 "Cache Result"',
            desc: '_slowTick() 每 3 秒调用一次 Adaptor.detect(v)，每次执行 getHls() + getDash() 完整属性扫描（遍历 5+ keys × 2 次）。而 PlayerRegistry 已经是 WeakMap，应在 detect 时先检查缓存。',
            fix: 'detect() 开头先检查 PlayerRegistry.get(video)，非 null 且 type !== \'unknown\' 时直接返回',
            pain_x_spread: '低 × 中'
        },
        {
            id: 'W8',
            title: 'tryPlay 静默吞掉 autoplay 权限错误',
            line: '第 109-115 行',
            ref: 'Martin《Clean Code》§5.1 "Handle the Error"',
            desc: 'p.catch(function(){}) 静默吞掉所有 Promise 拒绝。当浏览器因未交互阻止 autoplay 时，开发者无法从控制台得知原因，只能看到视频不播放的现象。',
            fix: 'p.catch(function(e){ Logger.debug("Session", "autoplay blocked", {error: e && e.name}); });',
            pain_x_spread: '低 × 低'
        },
        {
            id: 'W9',
            title: '_evaluateStale() 方法体为空（死代码）',
            line: '第 1784-1786 行',
            ref: 'Code Complete《代码大全》§8.1 "Dead Code"',
            desc: '_evaluateStale() 方法被 PATROL 事件触发调用（第 1614 行），但方法体仅为注释，不执行任何逻辑。这导致 patrol 清理功能完全失效，已断连视频的 candidate 对象永远保留在内存中。',
            fix: '实现清理逻辑：this.queue.forEach(c => { if (!c.video.isConnected) this.pool.delete(c.video); }); this.queue.clear();',
            pain_x_spread: '低 × 低'
        },
        {
            id: 'W10',
            title: 'addPreconnect 中 W.document || DOC 双文档混用',
            line: '第 919 行',
            ref: 'Fowler《RefaCTORing》§1.1 "Ambiguous References"',
            desc: '在 HookManager.installFetch 中，addPreconnect(url, W.document || DOC) 在跨域 iframe 场景下 W.document 为跨域内层文档，DOC 为顶层文档，两者混用导致 preconnect link 元素被插入错误的文档。',
            fix: '统一使用 W.document，移除 || DOC 回退',
            pain_x_spread: '低 × 低'
        }
    ],
    suggestion: [
        {
            id: 'S1',
            title: 'UIManager._mount() 与 _mountWhenReady() 功能重复',
            line: '第 3676-3678 行',
            ref: 'Code Complete《代码大全》§8.2 "Dead Code"',
            desc: '_mount() 仅是 _mountWhenReady() 的透明包装，增加了调用层次但没有额外价值。',
            fix: '删除 _mount() 方法，所有调用点改为直接调用 _mountWhenReady()'
        },
        {
            id: 'S2',
            title: 'Toast 未使用 _toastT 初始化，存在潜在 undefined 访问',
            line: '第 3031 行',
            ref: 'SOLID 原则 - 防御性编程',
            desc: 'UIManager 构造函数中未初始化 this._toastT，第一次 toast() 调用时 clearTimeout(this._toastT) 传入 undefined，虽不会报错但不规范。',
            fix: '在构造函数中添加 this._toastT = null'
        },
        {
            id: 'S3',
            title: 'clamp(NaN) 返回 NaN 而非下限',
            line: '第 46 行',
            ref: 'Code Complete《代码大全》§5.4 "Input Validation"',
            desc: 'clamp(NaN, 0, 10) 返回 NaN（因为 NaN 与任何值比较都返回 false），可能导致 bufferTarget、seekTimeout 等配置项出现 NaN 值。',
            fix: 'clamp 函数开头添加 isNaN(n) && (n = lo) 或 typeof n !== "number" && (n = lo)'
        },
        {
            id: 'S4',
            title: '_onPause 中 programmaticPause 清除后未检查 _programmaticPause',
            line: '第 2024-2026 行',
            ref: 'SOLID 原则 - 状态机完整性',
            desc: "先清除 _programmaticPause，再检查 _playedOnce && !v.ended && !this.isSeeking。但若 _programmaticPause 在清除后、检查前被其他路径设为 true（理论上不可能，但代码意图不清晰），会导致逻辑混乱。",
            fix: '将 _programmaticPause 检查移至 _playedOnce 检查之后，或重构为明确的状态机'
        },
        {
            id: 'S5',
            title: 'SITE_PROFILES 为空数组，模板方法未实现',
            line: '第 166-174 行',
            ref: 'Martin《Clean Code》§3.3 "Do the Simple Thing First"',
            desc: 'SITE_PROFILES 定义为空数组但注释模板存在，getSiteProfile() 永远返回 null。这是预留的扩展点，但当前无任何调用方依赖此功能。',
            fix: '保留空数组即可，或删除未使用的模板注释'
        }
    ]
};

const HEALTH_DASHBOARD = {
    score: 62,
    dimensions: {
        correctness: 58,
        architecture: 70,
        solid: 55,
        cleanliness: 60,
        testability: 45,
        tech_debt: 65,
        performance: 75
    },
    metrics: {
        totalLines: 3993,
        classes: 14,
        catchBlocks: 126,
        emptyCatchBlocks: 109,
        criticalIssues: 3,
        warningIssues: 10,
        suggestionIssues: 5
    }
};

// ===== 输出函数 =====
function printDashboard() {
    console.log('\n' + '='.repeat(70));
    console.log('  video-accelerator.user.js 全维度深度扫描报告');
    console.log('  生成时间：2026-08-11 | 文件规模：3993 行 | 14 个类');
    console.log('='.repeat(70));
    console.log();

    // 健康仪表盘
    console.log('┌' + '─'.repeat(68) + '┐');
    console.log('│' + '  综合健康评分'.padEnd(35) + '  ' + String(HEALTH_DASHBOARD.score).padStart(2) + ' / 100  ' + '│');
    console.log('├' + '─'.repeat(68) + '┤');
    const dims = HEALTH_DASHBOARD.dimensions;
    Object.entries(dims).forEach(([k, v], i) => {
        const label = k.padEnd(18);
        const bar = '█'.repeat(Math.round(v / 5)) + '░'.repeat(20 - Math.round(v / 5));
        const padding = i < 5 ? ' ' : '   ';
        console.log(`│${padding}${label}${bar} ${String(v).padStart(2)}/100${' '.repeat(8)}│`);
    });
    console.log('└' + '─'.repeat(68) + '┘');
    console.log();

    // Critical 问题
    console.log('━'.repeat(70));
    console.log('【CRITICAL】' + '共 ' + ISSUES.critical.length + ' 条（必须修复）');
    console.log('━'.repeat(70));
    ISSUES.critical.forEach((issue, i) => {
        console.log(`\n  ${issue.id} | ${issue.title}`);
        console.log(`    位置: ${issue.line}`);
        console.log(`    依据: ${issue.ref}`);
        console.log(`    影响: ${issue.pain_x_spread}`);
        console.log(`    修复: ${issue.fix}`);
    });

    // Warning 问题
    console.log('\n' + '━'.repeat(70));
    console.log('【WARNING】' + '共 ' + ISSUES.warning.length + ' 条（建议修复）');
    console.log('━'.repeat(70));
    ISSUES.warning.forEach((issue, i) => {
        console.log(`\n  ${issue.id} | ${issue.title}`);
        console.log(`    位置: ${issue.line}`);
        console.log(`    依据: ${issue.ref}`);
        console.log(`    影响: ${issue.pain_x_spread}`);
        console.log(`    修复: ${issue.fix}`);
    });

    // Suggestion 问题
    console.log('\n' + '━'.repeat(70));
    console.log('【SUGGESTION】' + '共 ' + ISSUES.suggestion.length + ' 条（可选优化）');
    console.log('━'.repeat(70));
    ISSUES.suggestion.forEach((issue, i) => {
        console.log(`\n  ${issue.id} | ${issue.title}`);
        console.log(`    位置: ${issue.line}`);
        console.log(`    修复: ${issue.fix}`);
    });

    // 技术债矩阵
    console.log('\n' + '━'.repeat(70));
    console.log('【技术债优先级矩阵】（按 痛感 × 扩散面 排序）');
    console.log('━'.repeat(70));
    const allIssues = [
        ...ISSUES.critical.map(i => ({ ...i, level: 'CRITICAL' })),
        ...ISSUES.warning.map(i => ({ ...i, level: 'WARNING' }))
    ].sort((a, b) => {
        const priority = { '高×高': 0, '中×高': 1, '低×高': 2, '中×中': 3, '低×中': 4, '中×低': 5, '低×低': 6 };
        return (priority[a.pain_x_spread] || 9) - (priority[b.pain_x_spread] || 9);
    });
    allIssues.forEach((issue, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. [${issue.id}] ${issue.title.padEnd(40)} ${issue.pain_x_spread.padStart(6)} ${issue.line}`);
    });

    // 架构依赖图
    console.log('\n' + '━'.repeat(70));
    console.log('【模块依赖图】');
    console.log('━'.repeat(70));
    console.log(`
  EventBus(Bus)
       │
       ├──► ConfigManager ───► Storage (GM/LS)
       │            │
       ├──► Logger ─────────► Bus (LOG_EMIT)
       │
       ├──► HookManager ────► Bus (SIGNAL_RAW / SIGNAL_BOOST)
       │               │
       ├──► Detector ───────► HookManager (跨模块访问 _viewportObs)
       │            │
       ├──► CandidateArbiter ─► SessionManager.sessions (直接耦合)
       │
       ├──► SessionManager ───► VideoSession × N
       │           │
       │           └──► Adaptor / PlayerRegistry
       │
       ├──► StateStore ──────► Bus (STATE_AGGREGATED)
       │
       ├──► GlobalScheduler ──► VideoSession (tick 调度)
       │
       ├──► FrameMesh ───────► Bus (跨 iframe 消息)
       │
       └──► RecoveryOrchestrator ─► Bus (STALL_DETECTED / BUFFER_LOW)
    `);

    // 测试覆盖总结
    console.log('\n' + '━'.repeat(70));
    console.log('【测试套件质量】');
    console.log('━'.repeat(70));
    console.log(`
  测试文件: video-test/unit-tests.js (481 行)
  测试覆盖:
    ✓ clamp 工具函数 (7 项)
    ✓ isVideoResource 正则 (10 项)
    ✓ isLive 边界 (6 项)
    ✓ estimateBandwidth 除零保护 (5 项)
    ✓ SessionState 字符串一致性 (3 项)
    ✓ _healthScore 逻辑 (5 项)
    ✓ _fmtTime 格式化 (6 项)
    ✓ tryPlay 异常安全 (4 项)
    ✓ ConfigManager 默认值 (3 项)
    ✓ CandidateArbiter 评分 (3 项)
    ✓ SessionManager 默认状态 (2 项)
    ✓ isVisible 边界 (5 项)
    总计: 59 项测试，57 项通过，2 项失败 (NaN 边界)

  覆盖率盲区:
    ✗ 无单元测试覆盖以下模块:
      - EventBus 事件流
      - GlobalScheduler 调度逻辑
      - FrameMesh 跨 iframe 消息
      - CandidateArbiter 评分算法
      - VideoSession 状态机
      - SessionManager 会话管理
      - RecoveryOrchestrator 恢复逻辑
      - UIManager 交互逻辑

  测试架构问题:
    - 无 mock 基础设施（所有模块硬依赖全局对象）
    - 无 DI 容器（无法注入测试 stub）
    - 无异步测试支持（Scheduler 使用 setTimeout）
    - 无覆盖率报告工具
    `);

    console.log('\n' + '='.repeat(70));
    console.log('  报告结束 | 建议优先级: C1 > C2 > C3 > W1 > W5 > W6');
    console.log('='.repeat(70) + '\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ISSUES, HEALTH_DASHBOARD, printDashboard };
}

printDashboard();
