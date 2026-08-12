// 阶段1 纯函数单测：直接驱动真实代码抽取出的 scoreCandidate / normalizeConfig / mergeConfig。
// 运行：node video-test/pure-tests.cjs
const loader = require('./_loader.cjs');
const { vaExports: VA, win } = loader;

let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
    if (cond) { pass++; }
    else { fail++; fails.push(msg); }
}

// 构造最小 candidate（jsdom video + context/signals）
function makeCandidate(over) {
    const v = win.document.createElement('video');
    win.document.body.appendChild(v);
    const base = {
        video: v,
        context: {
            area: 0, visible: false, inViewport: false, hasSrc: false,
            mediaUrl: false, blob: false, playing: false, duration: 0,
            live: false, muted: false, loop: false, adLike: false
        },
        signals: {
            protoSrc: false, protoLoad: false, protoPlay: false,
            gesture: false
        }
    };
    return Object.assign(base, over || {});
}

// ── scoreCandidate 数学精确校验 ──
(function () {
    // 清晰视频场景：area 用 300000 (> LARGE_AREA_PX=200000，触发大尺寸 +6)
    // 注意：LARGE_AREA_PX=200000，area 必须 > 它才加 +6；blob=false 时不加 +8。
    const T = VA.VA_TUNING;
    const cand = makeCandidate({
        context: {
            area: 300000, visible: true, inViewport: true, hasSrc: true,
            mediaUrl: true, blob: false, playing: true, duration: 600,
            live: false, muted: false, loop: false, adLike: false
        },
        signals: { protoSrc: true, protoLoad: true, protoPlay: true, gesture: false }
    });
    // 逐项：isConnected20 + visible12 + inViewport18 + area>=0 15 + 大尺寸6
    //       + hasSrc10 + mediaUrl12 + blob0 + protoSrc8 + protoLoad5 + protoPlay14
    //       + gesture0 + playing20 + 长视频10
    const expected =
        20 + 12 + 18 + 15 + 6 +
        10 + 12 + 0 +
        8 + 5 + 14 + 0 +
        20 + 10;
    const got = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: T });
    assert(got === expected, `scoreCandidate 清晰视频 = ${expected}, 实得 ${got}`);

    // 活动会话惩罚：无 gesture + 无 __vaSession → -25
    const s2 = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: true, tuning: T });
    assert(s2 === expected - 25, `活动会话无 gesture → 扣25 (实得 ${s2})`);

    // gesture 豁免惩罚，且加 GESTURE_BONUS
    const cg = makeCandidate({
        context: { area: 300000, visible: true, inViewport: true, hasSrc: true, mediaUrl: true, blob: false, playing: true, duration: 600 },
        signals: { protoPlay: true, gesture: true }
    });
    const expG = 20 + 12 + 18 + 15 + 6 + 10 + 12 + 0 + 0 + 0 + 14 + T.GESTURE_BONUS + 20 + 10;
    const g1 = VA.scoreCandidate(cg, { minVideoArea: 0, profile: null, hasActiveSessions: true, tuning: T });
    assert(g1 === expG, `gesture 豁免惩罚且加 bonus = ${expG}, 实得 ${g1}`);

    // profile.primarySelector 命中 +bonus
    const cp = makeCandidate({ context: { area: 300000, visible: true, inViewport: true, hasSrc: true, mediaUrl: true, blob: false, playing: true, duration: 600 } });
    const wrap = win.document.createElement('div');
    wrap.className = 'player';
    win.document.body.appendChild(wrap);   // 必须接入文档，否则 v.isConnected 变 false 影响评分
    wrap.appendChild(cp.video);
    const profile = { primarySelector: '.player' };
    const baseScore = 20 + 12 + 18 + 15 + 6 + 10 + 12 + 0 + 0 + 0 + 0 + 0 + 20 + 10; // 无 proto/gesture/blob
    const p1 = VA.scoreCandidate(cp, { minVideoArea: 0, profile, hasActiveSessions: false, tuning: T });
    assert(p1 === baseScore + T.PRIMARY_MATCH_BONUS, `profile 命中 +PRIMARY_MATCH_BONUS (实得 ${p1})`);

    // 行为等价：与 CandidateArbiter.score 包装器一致
    const viaWrapper = VA.CandidateArbiter.score(cand);
    assert(viaWrapper === got, `scoreCandidate 与 CandidateArbiter.score 包装一致 (${viaWrapper} vs ${got})`);
})();

// ── normalizeConfig ──
(function () {
    const T = VA.VA_TUNING;
    const defs = VA.ConfigManager.defaults;
    // 全部合法
    const a = VA.normalizeConfig(Object.assign({}, defs), T);
    assert(a.bufferTarget >= 10 && a.bufferTarget <= 300, `bufferTarget 在范围内 (${a.bufferTarget})`);
    assert(a.minVideoArea >= 0 && a.minVideoArea <= T.MIN_VIDEO_AREA_MAX, `minVideoArea 在范围内 (${a.minVideoArea})`);
    assert(['debug', 'info', 'warn', 'error'].indexOf(a.logLevel) >= 0, `logLevel 白名单 (${a.logLevel})`);
    // 非法数值 → 回退 default
    const b = VA.normalizeConfig({ bufferTarget: 'xx', minVideoArea: 0, logLevel: 'verbose', autoPlay: 1 }, T);
    assert(b.bufferTarget === 60, `bufferTarget 非法 → 60 (${b.bufferTarget})`);
    assert(b.minVideoArea === 0, `minVideoArea=0 保留(不被吞) (${b.minVideoArea})`);
    assert(b.logLevel === 'info', `logLevel 非法 → info (${b.logLevel})`);
    assert(b.autoPlay === true, `bool 强制 true (${b.autoPlay})`);
    // 越界 clamp
    const c = VA.normalizeConfig({ bufferTarget: 9999, recoveryBudget: -5 }, T);
    assert(c.bufferTarget === 300, `bufferTarget 越界 → 300 (${c.bufferTarget})`);
    assert(c.recoveryBudget === 1, `recoveryBudget 越界 → 1 (${c.recoveryBudget})`);
})();

// ── mergeConfig（原型污染防御 + null 安全）──
(function () {
    const base = { a: 1, b: 2 };
    const malicious = { c: 3, __proto__: { polluted: true }, constructor: 'x' };
    const out = VA.mergeConfig(base, malicious);
    assert(out.a === 1 && out.b === 2 && out.c === 3, `mergeConfig 正常字段合并`);
    assert(out.polluted === undefined, `mergeConfig 阻断 __proto__ 注入 (polluted=${out.polluted})`);
    assert(out.constructor === Object, `mergeConfig 不污染 constructor`);
    // null 安全
    const n1 = VA.mergeConfig(base, null);
    assert(n1.a === 1 && Object.keys(n1).length === 2, `mergeConfig(null) 仅返回 base 副本`);
    // 数组 override 被忽略（避免替换为数组）
    const arr = VA.mergeConfig(base, [1, 2]);
    assert(arr.a === 1 && !Array.isArray(arr), `mergeConfig(数组) 被忽略`);
})();

// ── scoreCandidate 防御：tuning 缺失/不完整不得产出 NaN（隐藏脆弱性 P1）──
(function () {
    const T = VA.VA_TUNING;
    const cand = makeCandidate({
        context: {
            area: 300000, visible: true, inViewport: true, hasSrc: true,
            mediaUrl: true, blob: false, playing: true, duration: 600,
            live: false, muted: false, loop: false, adLike: false
        },
        signals: { protoSrc: true, protoLoad: true, protoPlay: true, gesture: true }
    });
    // 空 tuning：曾返回 NaN（score += undefined），现应回退 VA_TUNING 得有限分
    const empty = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: {} });
    assert(Number.isFinite(empty) && !Number.isNaN(empty), `空 tuning 不得返回 NaN (实得 ${empty})`);
    // 部分 tuning（仅覆盖一个键）也应有限
    const partial = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: { GESTURE_BONUS: T.GESTURE_BONUS } });
    assert(Number.isFinite(partial) && !Number.isNaN(partial), `部分 tuning 不得返回 NaN (实得 ${partial})`);
    // 空 tuning 结果应与完整 tuning 一致（防御回退到 VA_TUNING 默认值）
    const full = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: T });
    assert(empty === full, `空 tuning 应回退到 VA_TUNING 同分 (空 ${empty} vs 全 ${full})`);
})();

console.log(`\n纯函数验证结果: ${pass}/${pass + fail} 通过${fail ? '，失败 ' + fail + ' 项' : '，全部通过 ✅'}`);
if (fail) {
    console.log('失败项:');
    fails.forEach((m) => console.log('  ✗ ' + m));
    process.exit(1);
}
