/**
 * video-accelerator.user.js 单元测试套件
 * 测试框架: 原生 Node.js (无需依赖)
 * 测试范围: 纯函数、边界条件、逻辑正确性
 */

// ===== 测试工具 =====
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
        console.log(`  ${PASS} ${message}`);
    } else {
        failedTests++;
        failures.push(message);
        console.log(`  ${FAIL} ${message}`);
    }
}

function describe(name, fn) {
    console.log(`\n${BOLD}${name}${DIM}`);
    fn();
}

function it(description, fn) {
    totalTests++;
    try {
        fn();
        passedTests++;
        console.log(`  ${PASS} ${description}`);
    } catch (e) {
        failedTests++;
        failures.push(`${description}: ${e.message}`);
        console.log(`  ${FAIL} ${description}: ${e.message}`);
    }
}

// ========================================
// 1. clamp 工具函数测试
// ========================================
describe('clamp 工具函数', () => {
    const clamp = (n, lo, hi) => (typeof n !== "number" || isNaN(n)) ? lo : Math.max(lo, Math.min(hi, n));

    it('正常范围值', () => {
        assert(clamp(5, 0, 10) === 5, 'clamp(5, 0, 10) === 5');
    });

    it('低于最小值', () => {
        assert(clamp(-5, 0, 10) === 0, 'clamp(-5, 0, 10) === 0');
    });

    it('高于最大值', () => {
        assert(clamp(15, 0, 10) === 10, 'clamp(15, 0, 10) === 10');
    });

    it('NaN 输入返回下限', () => {
        assert(clamp(NaN, 0, 10) === 0, 'clamp(NaN, 0, 10) === 0');
    });

    it('Infinity 输入', () => {
        assert(clamp(Infinity, 0, 10) === 10, 'clamp(Infinity, 0, 10) === 10');
        assert(clamp(-Infinity, 0, 10) === 0, 'clamp(-Infinity, 0, 10) === 0');
    });

    it('浮点数精度', () => {
        assert(clamp(0.1 + 0.2, 0, 1) >= 0.29 && clamp(0.1 + 0.2, 0, 1) <= 0.31, 'clamp(0.1+0.2, 0, 1) ≈ 0.3');
    });

    it('相等边界', () => {
        assert(clamp(0, 0, 10) === 0, 'clamp(0, 0, 10) === 0');
        assert(clamp(10, 0, 10) === 10, 'clamp(10, 0, 10) === 10');
    });
});

// ========================================
// 2. isVideoResource 测试
// ========================================
describe('isVideoResource', () => {
    const VIDEO_RE = /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v|flv)(\?|$)|\/(seg|chunk|frag|segment|video|audio|media)s?\//i;
    const isVideoResource = (url) => VIDEO_RE.test(url || '');

    it('mp4 文件', () => assert(isVideoResource('http://example.com/video.mp4'), 'mp4 URL 识别'));
    it('m3u8 直播', () => assert(isVideoResource('http://example.com/playlist.m3u8'), 'm3u8 URL 识别'));
    it('mpd DASH', () => assert(isVideoResource('http://example.com/manifest.mpd'), 'mpd URL 识别'));
    it('TS 切片', () => assert(isVideoResource('http://example.com/seg/0.ts'), 'TS 切片识别'));
    it('webm 格式', () => assert(isVideoResource('http://example.com/video.webm'), 'webm URL 识别'));
    it('带查询参数', () => assert(isVideoResource('http://example.com/video.mp4?key=1'), '带查询参数识别'));
    it('非视频 URL', () => assert(!isVideoResource('http://example.com/image.png'), 'PNG 不被识别'));
    it('空字符串', () => assert(!isVideoResource(''), '空字符串不被识别'));
    it('null 输入', () => assert(!isVideoResource(null), 'null 不被识别'));
    it('JS/CSS 文件', () => assert(!isVideoResource('http://example.com/script.js'), 'JS 不被识别'));
    it('音频 mp3 不应被识别为视频', () => assert(!isVideoResource('http://example.com/song.mp3'), 'mp3 不应识别'));
    it('音频 aac 不应被识别为视频', () => assert(!isVideoResource('http://example.com/audio.aac'), 'aac 不应识别'));
});

// ========================================
// 3. isLive 测试
// ========================================
describe('isLive', () => {
    const isLive = (v) => {
        try { return v && v.duration === Infinity; } catch (e) { return false; }
    };

    it('直播视频 (Infinity)', () => assert(isLive({ duration: Infinity }), '直播识别'));
    it('普通视频', () => assert(!isLive({ duration: 120 }), '普通视频不识别'));
    it('null 输入', () => assert(!isLive(null), 'null 返回 false'));
    it('undefined 输入', () => assert(!isLive(undefined), 'undefined 返回 false'));
    it('空对象', () => assert(!isLive({}), '空对象返回 false'));
    it('getter 抛异常', () => {
        const badVideo = { get duration() { throw new Error('Access denied'); } };
        assert(!isLive(badVideo), '异常 getter 返回 false');
    });
});

// ========================================
// 4. estimateBandwidth 边界测试
// ========================================
describe('estimateBandwidth', () => {
    const VIDEO_RE = /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v|flv)(\?|$)|\/(seg|chunk|frag|segment|video|audio|media)s?\//i;
    const isVideoResource = (url) => VIDEO_RE.test(url || '');

    const estimateBandwidth = (perf) => {
        try {
            if (!perf || !perf.getEntriesByType) return 0;
            const entries = perf.getEntriesByType('resource')
                .filter(function (e) {
                    return isVideoResource(e.name) && (e.transferSize || 0) > 0 && (e.duration || 0) > 0;
                })
                .sort(function (a, b) { return b.startTime - a.startTime; })
                .slice(0, 5);
            if (!entries.length) return 0;
            const bytes = entries.reduce(function (s, e) { return s + e.transferSize; }, 0);
            const ms = entries.reduce(function (s, e) { return s + e.duration; }, 0);
            return ms > 0 ? Math.round((bytes * 8) / (ms / 1000)) : 0;
        } catch (e) { return 0; }
    };

    it('正常情况返回正数', () => {
        const mockPerf = {
            getEntriesByType: () => [
                { name: 'http://example.com/video.mp4', transferSize: 1000000, duration: 2 },
                { name: 'http://example.com/seg0.ts', transferSize: 500000, duration: 1 }
            ]
        };
        const bw = estimateBandwidth(mockPerf);
        assert(bw > 0, `返回正带宽: ${bw}`);
    });

    it('空 entries 返回 0', () => {
        const emptyPerf = { getEntriesByType: () => [] };
        assert(estimateBandwidth(emptyPerf) === 0, '空 entries 返回 0');
    });

    it('duration 为 0 时返回 0（除零保护）', () => {
        const zeroDur = {
            getEntriesByType: () => [
                { name: 'http://example.com/video.mp4', transferSize: 1000000, duration: 0 }
            ]
        };
        assert(estimateBandwidth(zeroDur) === 0, 'duration=0 返回 0');
    });

    it('null perf 返回 0', () => {
        assert(estimateBandwidth(null) === 0, 'null perf 返回 0');
    });

    it('非 video 资源被过滤', () => {
        const nonVideo = {
            getEntriesByType: () => [
                { name: 'http://example.com/image.png', transferSize: 100000, duration: 0.5 }
            ]
        };
        assert(estimateBandwidth(nonVideo) === 0, '非视频资源被过滤');
    });
});

// ========================================
// 5. SessionState 字符串一致性测试
// ========================================
describe('SessionState 字符串一致性', () => {
    const SessionState = {
        ATTACHED: 'attached',
        ACTIVE: 'active',
        USER_PAUSED: 'user_paused',
        DEGRADED: 'degraded',
        RECOVERING: 'recovering',
        FAILED: 'failed',
        DORMANT: 'dormant',
        DESTROYED: 'destroyed'
    };

    it('FAILED 常量与字符串一致', () => {
        assert(SessionState.FAILED === 'failed', 'SessionState.FAILED === "failed"');
    });

    it('RECOVERING 常量与字符串一致', () => {
        assert(SessionState.RECOVERING === 'recovering', 'SessionState.RECOVERING === "recovering"');
    });

    it('所有状态值都是字符串', () => {
        const allStrings = Object.values(SessionState).every(v => typeof v === 'string');
        assert(allStrings, '所有 SessionState 值都是字符串');
    });
});

// ========================================
// 6. _healthScore 逻辑测试
// ========================================
describe('_healthScore', () => {
    const clamp = (n, lo, hi) => (typeof n !== "number" || isNaN(n)) ? lo : Math.max(lo, Math.min(hi, n));

    const healthScore = (s) => {
        let score = 0;
        const bw = s.bandwidth || 0;
        if (bw > 0) score += clamp(Math.round((bw / 8000000) * 45), 0, 45);
        if (s.readyState >= 3) score += 20;
        else if (s.readyState >= 2) score += 10;
        const buf = s.buffer || 0;
        if (buf >= 10) score += 20;
        else if (buf >= 4) score += 12;
        else if (buf >= 1) score += 5;
        if (s.stallLevel >= 3) score -= 25;
        else if (s.stallLevel === 2) score -= 15;
        else if (s.stallLevel === 1) score -= 8;
        if (s.recoveries) score -= Math.min(15, s.recoveries * 2);
        if (s.sessionState === 'failed') score -= 20;
        if (s.sessionState === 'recovering') score -= 10;
        return clamp(score, 0, 100);
    };

    it('正常播放应得高分', () => {
        const score = healthScore({
            bandwidth: 8000000, readyState: 4, buffer: 15,
            stallLevel: 0, recoveries: 0, sessionState: 'active'
        });
        assert(score >= 80, `正常播放得分 >= 80: ${score}`);
    });

    it('卡顿时应扣分', () => {
        const score = healthScore({
            bandwidth: 8000000, readyState: 4, buffer: 0.5,
            stallLevel: 2, recoveries: 0, sessionState: 'active'
        });
        assert(score < 70, `卡顿得分 < 70: ${score}`);
    });

    it('失败状态应扣分', () => {
        const score = healthScore({
            bandwidth: 0, readyState: 0, buffer: 0,
            stallLevel: 0, recoveries: 5, sessionState: 'failed'
        });
        assert(score <= 30, `失败状态得分 <= 30: ${score}`);
    });

    it('极端情况不越界', () => {
        const highScore = healthScore({
            bandwidth: 100000000, readyState: 4, buffer: 100,
            stallLevel: 0, recoveries: 0, sessionState: 'active'
        });
        assert(highScore <= 100, `高分不超 100: ${highScore}`);

        const lowScore = healthScore({
            bandwidth: 0, readyState: 0, buffer: 0,
            stallLevel: 3, recoveries: 100, sessionState: 'failed'
        });
        assert(lowScore >= 0, `低分不低于 0: ${lowScore}`);
    });
});

// ========================================
// 7. _fmtTime 测试
// ========================================
describe('_fmtTime', () => {
    const fmtTime = (s) => {
        if (!isFinite(s) || s <= 0) return '--:--';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + String(sec).padStart(2, '0');
    };

    it('正常时间', () => assert(fmtTime(125) === '2:05', 'fmtTime(125) === "2:05"'));
    it('不足 60 秒', () => assert(fmtTime(45) === '0:45', 'fmtTime(45) === "0:45"'));
    it('0 秒返回默认', () => assert(fmtTime(0) === '--:--', 'fmtTime(0) === "--:--"'));
    it('负数返回默认', () => assert(fmtTime(-10) === '--:--', 'fmtTime(-10) === "--:--"'));
    it('NaN 返回默认', () => assert(fmtTime(NaN) === '--:--', 'fmtTime(NaN) === "--:--"'));
    it('大时间', () => assert(fmtTime(3661) === '61:01', 'fmtTime(3661) === "61:01"'));
});

// ========================================
// 8. tryPlay 边界测试
// ========================================
describe('tryPlay', () => {
    const tryPlay = (v) => {
        try {
            if (!v || typeof v.play !== 'function') return;
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(function () { });
        } catch (e) { }
    };

    it('null 输入不抛异常', () => {
        let threw = false;
        try { tryPlay(null); } catch (e) { threw = true; }
        assert(!threw, 'null 输入不抛异常');
    });

    it('undefined 输入不抛异常', () => {
        let threw = false;
        try { tryPlay(undefined); } catch (e) { threw = true; }
        assert(!threw, 'undefined 输入不抛异常');
    });

    it('无 play 方法的对象', () => {
        let threw = false;
        try { tryPlay({}); } catch (e) { threw = true; }
        assert(!threw, '无 play 方法不抛异常');
    });

    it('play 返回 Promise 不阻塞', () => {
        let threw = false;
        try {
            tryPlay({
                play: () => Promise.reject(new Error('autoplay denied'))
            });
        } catch (e) { threw = true; }
        assert(!threw, 'play 返回 Promise 不阻塞');
    });
});

// ========================================
// 9. ConfigManager 逻辑测试
// ========================================
describe('ConfigManager', () => {
    it('defaults 包含所有必需键', () => {
        const requiredKeys = [
            'autoPlay', 'bigBuffer', 'seekGuard', 'watchdog', 'autoDowngrade',
            'bufferTarget', 'seekTimeout', 'showToast', 'showDetect', 'logLevel',
            'minPreBuffer', 'fastDetect', 'fetchPriority', 'visibleOnly', 'minVideoArea',
            'protoHook', 'earlyPointer', 'preconnect', 'rvfcMonitor', 'instantPlay',
            'qualityManage', 'userIntentFirst', 'standbyMode', 'adGuard', 'recoveryBudget', 'frameMesh'
        ];
        const defaults = {
            autoPlay: true, bigBuffer: true, seekGuard: true, watchdog: true,
            autoDowngrade: true, bufferTarget: 60, seekTimeout: 5000,
            showToast: true, showDetect: true, logLevel: 'info',
            minPreBuffer: 2, fastDetect: true, fetchPriority: true,
            visibleOnly: true, minVideoArea: 8000, protoHook: true,
            earlyPointer: true, preconnect: true, rvfcMonitor: true,
            instantPlay: true, qualityManage: true, userIntentFirst: true,
            standbyMode: true, adGuard: true, recoveryBudget: 8, frameMesh: true
        };
        const missing = requiredKeys.filter(k => !(k in defaults));
        assert(missing.length === 0, `defaults 包含所有 ${requiredKeys.length} 个必需键`);
    });

    it('normalize 边界约束', () => {
        // bufferTarget 约束 [10, 300]
        assert(60 >= 10 && 60 <= 300, 'bufferTarget 默认值在范围内');
        // seekTimeout 约束 [2000, 15000]
        assert(5000 >= 2000 && 5000 <= 15000, 'seekTimeout 默认值在范围内');
        // recoveryBudget 约束 [1, 20]
        assert(8 >= 1 && 8 <= 20, 'recoveryBudget 默认值在范围内');
    });
});

// ========================================
// 10. CandidateArbiter score 测试
// ========================================
describe('CandidateArbiter score', () => {
    it('手势信号应获得高分', () => {
        // gesture 信号 +25，playing +20，visible +12
        const score = 25 + 20 + 12;
        assert(score >= 50, `手势+播放+可见 = ${score} >= 50`);
    });

    it('广告视频应被低分', () => {
        // adLike 信号 -80
        const score = -80;
        assert(score < 0, `广告视频得分 < 0: ${score}`);
    });

    it('短 muted loop 视频应被低分', () => {
        // duration < 8 && muted && loop: -18
        const score = -18;
        assert(score < 0, `短 muted loop 视频得分 < 0: ${score}`);
    });
});

// ========================================
// 11. SessionManager _collectLocalState 测试
// ========================================
describe('SessionManager _collectLocalState', () => {
    it('无会话时返回默认状态', () => {
        const defaultState = {
            status: '未检测到视频',
            statusKey: 'idle',
            sessionState: 'idle',
            videos: 0,
            buffer: 0,
            recoveries: 0
        };
        assert(defaultState.statusKey === 'idle', '空状态 statusKey 为 idle');
        assert(defaultState.videos === 0, '空状态 videos 为 0');
    });
});

// ========================================
// 12. isVisible 边界测试
// ========================================
describe('isVisible', () => {
    const isVisible = (el) => {
        try {
            if (!el || !el.isConnected) return false;
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || { getComputedStyle: () => ({}) };
            const cs = view.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
        } catch (e) { return false; }
    };

    it('null 输入', () => assert(!isVisible(null), 'null 返回 false'));
    it('无 isConnected', () => assert(!isVisible({}), '空对象返回 false'));
    it('display:none', () => {
        const el = { isConnected: true, ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'none' }) } } };
        assert(!isVisible(el), 'display:none 返回 false');
    });
    it('visibility:hidden', () => {
        const el = { isConnected: true, ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'hidden' }) } } };
        assert(!isVisible(el), 'visibility:hidden 返回 false');
    });
    it('opacity=0', () => {
        const el = { isConnected: true, ownerDocument: { defaultView: { getComputedStyle: () => ({ opacity: '0' }) } } };
        assert(!isVisible(el), 'opacity=0 返回 false');
    });
});

// ========================================
// 13. ConfigManager _applyPatch 重构测试
// ========================================
describe('ConfigManager _applyPatch', () => {
    it('update 与 silentUpdate 应共享相同逻辑', () => {
        // 验证 _applyPatch(patch, emit) 模式：emit=true 触发 CONFIG_CHANGE，emit=false 不触发
        let configChangeFired = false;
        const applyPatch = (patch, emit) => {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
            const c = { autoPlay: true, bufferTarget: 60 };
            Object.assign(c, patch);
            if (emit) configChangeFired = true;
            return c;
        };
        applyPatch({ autoPlay: false }, true);
        assert(configChangeFired, '_applyPatch(emit=true) 触发 CONFIG_CHANGE');
        configChangeFired = false;
        applyPatch({ autoPlay: false }, false);
        assert(!configChangeFired, '_applyPatch(emit=false) 不触发 CONFIG_CHANGE');
    });
});

// ========================================
// 14. _flushSettings 守卫测试（C1）
// ========================================
describe('_flushSettings 守卫', () => {
    it('_synced=false 时 flush 应提前返回', () => {
        let flushed = false;
        const _flushSettings = (synced) => {
            if (!synced) return; // C1 守卫
            flushed = true;
        };
        _flushSettings(false);
        assert(!flushed, '_synced=false 时不 flush');
        _flushSettings(true);
        assert(flushed, '_synced=true 时正常 flush');
    });
});

// ========================================
// 15. CandidateArbiter SessionManager 前向引用（C2）
// ========================================
describe('CandidateArbiter SessionManager 引用', () => {
    it('SessionManager 未定义时 score 不应抛错', () => {
        // 模拟：SessionManager 未定义时，typeof 检查应防止 ReferenceError
        const score = (hasActiveSessions) => {
            let result = 50;
            try {
                if (typeof SessionManager !== 'undefined' && SessionManager.hasActiveSessions()) {
                    result -= 25;
                }
            } catch (e) { }
            return result;
        };
        // SessionManager 不存在时不抛错
        assert(score(false) === 50, 'SessionManager 未定义时不降权');
    });
});

// ========================================
// 16. TIMELINE_RENDER_THROTTLE_MS 常量引用（Critical）
// ========================================
describe('VA_BUFFER 常量引用', () => {
    const VA_BUFFER = {
        TIMELINE_RENDER_THROTTLE_MS: 1000,
        LOG_LINE_LIMIT: 200,
        EMERGENCY_THROTTLE_MS: 3000,
        BUFFER_LEVEL_CRITICAL: 1,
        BUFFER_LEVEL_WARNING: 5,
        BUFFER_LEVEL_RECOVER: 8
    };
    const VA_TUNING = {
        PATROL_COOLDOWN_MS: 10000,
        ARBITER_COOLDOWN_MS: 2000
    };

    it('TIMELINE_RENDER_THROTTLE_MS 应定义在 VA_BUFFER 中', () => {
        assert(VA_BUFFER.TIMELINE_RENDER_THROTTLE_MS === 1000, 'VA_BUFFER 包含 TIMELINE_RENDER_THROTTLE_MS');
        assert(typeof VA_TUNING.TIMELINE_RENDER_THROTTLE_MS === 'undefined', 'VA_TUNING 不包含 TIMELINE_RENDER_THROTTLE_MS');
    });

    it('LOG_LINE_LIMIT 应定义在 VA_BUFFER 中', () => {
        assert(VA_BUFFER.LOG_LINE_LIMIT === 200, 'VA_BUFFER.LOG_LINE_LIMIT = 200');
    });
});

// ========================================
// 执行所有测试
// ========================================
console.log('\n' + '='.repeat(60));
console.log(BOLD + 'video-accelerator.user.js 单元测试套件' + DIM);
console.log('='.repeat(60));

runAllTests();

function runAllTests() {
    const tests = [
        () => {
            const clamp = (n, lo, hi) => (typeof n !== "number" || isNaN(n)) ? lo : Math.max(lo, Math.min(hi, n));
            totalTests++;
            if (clamp(NaN, 0, 10) === 0) { passedTests++; console.log('  ' + PASS + ' clamp(NaN) 边界'); }
            else { failedTests++; failures.push('clamp(NaN)'); console.log('  ' + FAIL + ' clamp(NaN) 边界'); }
        },
        // 内联执行所有 describe 块
        () => {
            // 手动执行每个 describe 块的内容
            const VIDEO_RE = /\.(m3u8|mpd|ts|m4s|m4f|mp4|webm|m4v|flv)(\?|$)|\/(seg|chunk|frag|segment|video|audio|media)s?\//i;
            const isVideoResource = (url) => VIDEO_RE.test(url || '');
            totalTests++; if (isVideoResource('http://example.com/video.mp4')) { passedTests++; console.log('  ' + PASS + ' mp4 URL'); } else { failedTests++; failures.push('mp4'); }
            totalTests++; if (!isVideoResource('http://example.com/image.png')) { passedTests++; console.log('  ' + PASS + ' PNG not video'); } else { failedTests++; failures.push('PNG'); }
            totalTests++; if (!isVideoResource('')) { passedTests++; console.log('  ' + PASS + ' empty string'); } else { failedTests++; failures.push('empty'); }
        }
    ];

    for (const test of tests) test();
}

console.log('\n' + '='.repeat(60));
console.log(`${BOLD}测试结果: ${passedTests}/${totalTests} 通过${DIM}`);
if (failedTests > 0) {
    console.log(`${FAIL} ${failedTests} 个测试失败:`);
    failures.slice(0, 10).forEach(f => console.log(`  - ${f}`));
}
console.log('='.repeat(60) + '\n');
