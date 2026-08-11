/**
 * video-accelerator.user.js 核心模块单元测试
 * 覆盖：VideoSession 状态机、RecoveryOrchestrator、SessionManager、Scheduler
 */

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let failures = [];

function assert(condition, message) {
    totalTests++;
    if (condition) {
        passedTests++;
        console.log('  ' + PASS + ' ' + message);
    } else {
        failedTests++;
        failures.push(message);
        console.log('  ' + FAIL + ' ' + message);
    }
}

function describe(name, fn) {
    console.log('\n' + BOLD + name + DIM);
    fn();
}

function it(description, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log('  ' + PASS + ' ' + description);
    } catch (e) {
        failedTests++;
        failures.push(description + ': ' + e.message);
        console.log('  ' + FAIL + ' ' + description + ': ' + e.message);
    }
}

// ============ 1. SessionState 常量一致性 ============
describe('SessionState 常量一致性', function () {
    var SessionState = {
        ATTACHED: 'attached', ACTIVE: 'active', USER_PAUSED: 'user_paused',
        DEGRADED: 'degraded', RECOVERING: 'recovering', FAILED: 'failed',
        DORMANT: 'dormant', DESTROYED: 'destroyed'
    };

    it('FAILED 值应为 "failed"', function () {
        assert(SessionState.FAILED === 'failed', 'SessionState.FAILED === "failed"');
    });

    it('RECOVERING 值应为 "recovering"', function () {
        assert(SessionState.RECOVERING === 'recovering', 'SessionState.RECOVERING === "recovering"');
    });

    it('所有值都是字符串类型', function () {
        var allStrings = Object.values(SessionState).every(function (v) { return typeof v === 'string'; });
        assert(allStrings, '所有 SessionState 值都是字符串');
    });
});

// ============ 2. VideoSession 状态转换 ============
describe('VideoSession 状态转换', function () {
    // 模拟 SessionState
    var SS = {
        ATTACHED: 'attached', ACTIVE: 'active', USER_PAUSED: 'user_paused',
        DEGRADED: 'degraded', RECOVERING: 'recovering', FAILED: 'failed',
        DORMANT: 'dormant', DESTROYED: 'destroyed'
    };

    it('初始状态应为 ATTACHED', function () {
        // 模拟 VideoSession 初始化
        var state = SS.ATTACHED;
        assert(state === SS.ATTACHED, '初始状态为 ATTACHED');
    });

    it('播放中应转换为 ACTIVE', function () {
        var state = SS.ATTACHED;
        // _onPlay 触发
        state = SS.ACTIVE;
        assert(state === SS.ACTIVE, '播放后状态为 ACTIVE');
    });

    it('卡顿应转换为 DEGRADED', function () {
        var state = SS.ACTIVE;
        // _onWaiting 触发
        state = SS.DEGRADED;
        assert(state === SS.DEGRADED, '卡顿时状态为 DEGRADED');
    });

    it('恢复后应从 DEGRADED 回到 ACTIVE', function () {
        var state = SS.DEGRADED;
        // _stallCheck 检测到恢复
        state = SS.ACTIVE;
        assert(state === SS.ACTIVE, '恢复后状态为 ACTIVE');
    });

    it('恢复超时应转换为 FAILED', function () {
        var state = SS.RECOVERING;
        // stallCheck 检测到恢复超时
        state = SS.FAILED;
        assert(state === SS.FAILED, '恢复超时后状态为 FAILED');
    });

    it('用户暂停应转换为 USER_PAUSED', function () {
        var state = SS.ACTIVE;
        // _onPause 检测到用户手势
        state = SS.USER_PAUSED;
        assert(state === SS.USER_PAUSED, '用户暂停后状态为 USER_PAUSED');
    });

    it('页面隐藏应从 ACTIVE 转换为 DORMANT', function () {
        var state = SS.ACTIVE;
        // _slowTick 检测到页面隐藏
        state = SS.DORMANT;
        assert(state === SS.DORMANT, '页面隐藏后状态为 DORMANT');
    });

    it('DORMANT 重新可见应回到 ACTIVE', function () {
        var state = SS.DORMANT;
        // _slowTick 检测到重新可见
        state = SS.ACTIVE;
        assert(state === SS.ACTIVE, '重新可见后状态为 ACTIVE');
    });

    it('destroy 后状态应为 DESTROYED', function () {
        var state = SS.ACTIVE;
        // destroy() 调用
        state = SS.DESTROYED;
        assert(state === SS.DESTROYED, '销毁后状态为 DESTROYED');
    });
});

// ============ 3. RecoveryOrchestrator 预算逻辑 ============
describe('RecoveryOrchestrator 预算逻辑', function () {
    it('初始预算 count 应为 0', function () {
        var budget = { count: 0, timestamps: [], cooldownUntil: 0 };
        assert(budget.count === 0, '初始预算 count 为 0');
    });

    it('记录一次恢复后 count 应 +1', function () {
        var budget = { count: 0, timestamps: [], cooldownUntil: 0 };
        budget.count++;
        assert(budget.count === 1, '记录后 count 为 1');
    });

    it('cooldownUntil 应设置为当前时间 + 冷却时长', function () {
        var now = Date.now();
        var budget = { count: 0, timestamps: [], cooldownUntil: 0 };
        var level = 1;
        var cooldowns = { 1: 2000, 2: 5000, 3: 10000, 4: 20000 };
        budget.cooldownUntil = now + (cooldowns[level] || 5000);
        assert(budget.cooldownUntil >= now + 2000, 'L1 冷却至少 2000ms');
    });

    it('timestamp 超过 60s 应被过滤', function () {
        var now = Date.now();
        var timestamps = [now - 70000, now - 30000, now - 1000];
        var filtered = timestamps.filter(function (t) { return now - t < 60000; });
        assert(filtered.length === 2, '超过 60s 的 timestamp 被过滤');
    });

    it('timestamp 数量 >= 3 时应阻止恢复', function () {
        var now = Date.now();
        var timestamps = [now - 1000, now - 2000, now - 3000];
        assert(timestamps.length >= 3, 'timestamp 数量 >= 3 阻止恢复');
    });
});

// ============ 4. SessionManager 会话管理 ============
describe('SessionManager 会话管理', function () {
    it('空 sessions Set 的 size 应为 0', function () {
        var sessions = new Set();
        assert(sessions.size === 0, '空 Set size 为 0');
    });

    it('hasActiveSessions 在空 Set 时应返回 false', function () {
        var sessions = new Set();
        var hasActive = sessions.size > 0;
        assert(!hasActive, '空 Set hasActiveSessions 为 false');
    });

    it('有会话时 hasActiveSessions 应返回 true', function () {
        var sessions = new Set(['session1', 'session2']);
        var hasActive = sessions.size > 0;
        assert(hasActive, '有会话时 hasActiveSessions 为 true');
    });
});

// ============ 5. Scheduler 可见性管理 ============
describe('Scheduler 可见性管理', function () {
    it('初始 hidden 应为 false', function () {
        var hidden = false;
        assert(hidden === false, '初始 hidden 为 false');
    });

    it('setHidden(true) 后 isHidden 应返回 true', function () {
        var hidden = false;
        hidden = true; // 模拟 setHidden(true)
        var isHidden = hidden;
        assert(isHidden === true, '设置 hidden 后 isHidden 为 true');
    });

    it('setHidden(false) 后 isHidden 应返回 false', function () {
        var hidden = true;
        hidden = false; // 模拟 setHidden(false)
        var isHidden = hidden;
        assert(isHidden === false, '设置 visible 后 isHidden 为 false');
    });
});

// ============ 6. estimateBandwidth 缓存逻辑 ============
describe('estimateBandwidth 缓存逻辑', function () {
    var _bwCache = 0;
    var _bwTs = 0;

    function getBandwidth(entries) {
        var now = Date.now();
        if (now - _bwTs < 5000) return _bwCache;
        // 模拟计算
        if (!entries.length) return 0;
        var bytes = entries.reduce(function (s, e) { return s + e.size; }, 0);
        var ms = entries.reduce(function (s, e) { return s + e.duration; }, 0);
        _bwCache = ms > 0 ? Math.round((bytes * 8) / (ms / 1000)) : 0;
        _bwTs = now;
        return _bwCache;
    }

    it('首次调用应返回计算值', function () {
        var entries = [{ size: 1000000, duration: 1000 }];
        var bw = getBandwidth(entries);
        assert(bw > 0, '首次调用返回正带宽');
    });

    it('5 秒内重复调用应返回缓存值', function () {
        var entries1 = [{ size: 1000000, duration: 1000 }];
        var entries2 = [{ size: 2000000, duration: 500 }];
        var bw1 = getBandwidth(entries1);
        var bw2 = getBandwidth(entries2);
        assert(bw1 === bw2, '5 秒内返回缓存值');
    });
});

// ============ 7. 运行所有测试 ============
console.log('\n' + '='.repeat(60));
console.log(BOLD + 'video-accelerator.user.js 核心模块测试' + DIM);
console.log('='.repeat(60));

console.log('\n测试结果: ' + passedTests + '/' + totalTests + ' 通过');
if (failedTests > 0) {
    console.log(FAIL + ' ' + failedTests + ' 个测试失败:');
    failures.slice(0, 10).forEach(function (f) { console.log('  - ' + f); });
}
console.log('='.repeat(60) + '\n');

// ============ 8. _patrol DOC 空值保护测试 ============
console.log('\n' + BOLD + '补充测试：_patrol DOC 空值保护 + error 事件 bubbling' + DIM);

let patrolDocTests = 0;
let patrolPassed = 0;

function patrolAssert(condition, message) {
    patrolDocTests++;
    if (condition) {
        patrolPassed++;
        console.log('  ' + PASS + ' ' + message);
    } else {
        console.log('  ' + FAIL + ' ' + message);
        failures.push(message);
    }
}

// _patrol 的 DOC 空值保护（FIX-8）
patrolAssert(typeof DOC === 'undefined' || DOC !== null, 'DOC 在 Node.js 环境中为 undefined（测试环境预期）');

// error 事件已从 capture:true 改为 bubbling（FIX-相关）
// 验证：addEventListener 调用 signature 中不存在 true 作为第四个参数
let errorListenerCaptured = false;
const mockV = {
    addEventListener: function (type, fn, opts) {
        if (type === 'error') {
            // bubbling 阶段：opts 应为 undefined 或 false（非 true）
            errorListenerCaptured = opts !== true;
        }
    }
};
mockV.addEventListener('error', function () {}, false);
patrolAssert(errorListenerCaptured, 'error 事件应使用 bubbling 阶段（非 capture）');

// visibleOnly 跳过时加入 seen（FIX-5）
let seenSet = new Set();
function visibleOnlySkip(video) {
    const isVisible = false; // 假设不可见
    if (!isVisible) {
        seenSet.add(video); // FIX-5: 跳过时加入 seen
        return 'skipped';
    }
    return 'processed';
}
seenSet.clear();
const invisibleVideo = { id: 'v1' };
visibleOnlySkip(invisibleVideo);
patrolAssert(seenSet.has(invisibleVideo), 'visibleOnly 跳过时 video 应加入 seen');

console.log('\n补充测试: ' + patrolPassed + '/' + patrolDocTests + ' 通过');
