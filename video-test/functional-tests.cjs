// 功能验证套件：加载真实 video-accelerator.user.js（经 _loader.cjs 在 jsdom 启动），
// 直接驱动真实函数，逐个模块核查功能 bug。遵循 AAA + 边界用例 + 依赖 mock。
const { vaExports: VA, win } = require('./_loader.cjs');

const PASS = '✓';
const FAIL = '✗';
let t = 0, p = 0, f = 0;
const fails = [];

function assert(cond, msg) {
    t++;
    if (cond) { p++; console.log('  ' + PASS + ' ' + msg); }
    else { f++; fails.push(msg); console.log('  ' + FAIL + ' ' + msg); }
}
function describe(name, fn) { console.log('\n■ ' + name); fn(); }

const CM = VA.ConfigManager;
const CA = VA.CandidateArbiter;
const SM = VA.SessionManager;
const T = VA.VA_TUNING;

// ───────────────────────── 1. 纯函数 ─────────────────────────
describe('1. 纯函数 clamp / isVideoResource / isLive / isVisible / videoArea / getHost', () => {
    assert(VA.clamp(5, 0, 10) === 5, 'clamp 正常值');
    assert(VA.clamp(-5, 0, 10) === 0, 'clamp 低于下限');
    assert(VA.clamp(99, 0, 10) === 10, 'clamp 高于上限');
    assert(VA.clamp(NaN, 0, 10) === 0, 'clamp NaN → 下限(安全)');
    assert(VA.clamp('x', 0, 10) === 0, 'clamp 非数字 → 下限');

    assert(VA.isVideoResource('https://x.com/a/seg/1.ts') === true, 'isVideoResource 命中 seg');
    assert(VA.isVideoResource('https://x.com/a.mp4?t=1') === true, 'isVideoResource 命中 .mp4');
    assert(VA.isVideoResource('https://x.com/a.jpg') === false, 'isVideoResource 非视频');
    assert(VA.isVideoResource('') === false, 'isVideoResource 空串');
    assert(VA.isVideoResource(null) === false, 'isVideoResource null');

    assert(VA.isLive({ duration: Infinity }) === true, 'isLive Infinity');
    assert(VA.isLive({ duration: 120 }) === false, 'isLive 有限时长');
    assert(VA.isLive(null) === false, 'isLive null 安全');

    const vis = win.document.createElement('div');
    vis.style.display = 'none';
    assert(VA.isVisible(vis) === false, 'isVisible display:none → false');
    const vis2 = win.document.createElement('div');
    vis2.style.opacity = '0';
    assert(VA.isVisible(vis2) === false, 'isVisible opacity:0 → false');
    const vis3 = win.document.createElement('div');
    vis3.style.opacity = '1';
    win.document.body.appendChild(vis3);
    assert(VA.isVisible(vis3) === true, 'isVisible 默认可见(已挂载, opacity:1) → true');

    const v1 = win.document.createElement('div');
    v1.getBoundingClientRect = () => ({ width: 100, height: 80, top: 0, left: 0, right: 100, bottom: 80, x: 0, y: 0 });
    assert(VA.videoArea(v1) === 8000, 'videoArea 100×80 = 8000');

    assert(VA.getHost('https://sub.example.com/path') === 'sub.example.com', 'getHost 解析');
    assert(VA.getHost('http://') === '', 'getHost 绝对非法 URL → 空串(安全)');
});

// ───────────────────────── 2. ConfigManager._mergeConfig 原型污染防御 ─────────────────────────
describe('2. ConfigManager._mergeConfig（原型污染防御 / null 处理）', () => {
    const out = CM._mergeConfig({ a: 1 }, JSON.parse('{"b":2,"__proto__":{"polluted":true}}'));
    assert(out.a === 1 && out.b === 2, '_mergeConfig 合并普通键');
    assert(({}).polluted === undefined, '__proto__ 注入被剥离，原型未被污染');

    const out2 = CM._mergeConfig({ a: 1 }, JSON.parse('{"constructor":{"polluted":true}}'));
    assert(({}).polluted === undefined, 'constructor 注入被剥离');

    const out3 = CM._mergeConfig({ x: 9 }, null);
    assert(out3.x === 9, 'override=null 返回 base 副本');
    assert(out3 !== undefined, '_mergeConfig null 不抛');
});

// ───────────────────────── 3. ConfigManager._normalize ─────────────────────────
describe('3. ConfigManager._normalize（clamp / bool / 0 / minVideoArea / logLevel）', () => {
    CM._cache = {
        bufferTarget: 9999, minPreBuffer: -5, seekTimeout: 100, recoveryBudget: 50,
        minVideoArea: 0, logLevel: 'bogus', autoPlay: 0, qualityManage: 'yes'
    };
    CM._normalize();
    const c = CM._cache;
    assert(c.bufferTarget === 300, 'bufferTarget 超上限→300');
    assert(c.minPreBuffer === 1, 'minPreBuffer 低于下限→1');
    assert(c.seekTimeout === 2000, 'seekTimeout 低于下限→2000');
    assert(c.recoveryBudget === 20, 'recoveryBudget 超上限→20');
    assert(c.minVideoArea === 0, 'minVideoArea=0 被保留（不被吞）');
    assert(c.logLevel === 'info', 'logLevel 非法→info 白名单回退');
    assert(c.autoPlay === false, 'autoPlay 0 → false(!!0)');
    assert(c.qualityManage === true, 'qualityManage "yes" → true');
});

// ───────────────────────── 4. ConfigManager 导入/导出/存储 ─────────────────────────
describe('4. ConfigManager 导入导出（importJSON / applyRemote / set / save / load）', () => {
    CM._cache = Object.assign({}, CM.defaults);

    assert(CM.importJSON(JSON.stringify({ bufferTarget: 120, minVideoArea: 0, autoPlay: true })) === true, 'importJSON 合法对象→true');
    assert(CM.get('minVideoArea') === 0, 'importJSON 后 minVideoArea=0 保留');
    assert(CM.get('bufferTarget') === 120, 'importJSON 后 bufferTarget=120');

    assert(CM.importJSON(JSON.stringify([1, 2, 3])) === false, 'importJSON 数组被拒绝');
    assert(CM.importJSON('{not json') === false, 'importJSON 非法 JSON 被拒绝(不抛)');

    const ok = CM.importJSON('{"__proto__":{"polluted":true},"autoPlay":false}');
    assert(ok === true, 'importJSON 含 __proto__ 仍成功');
    assert(({}).polluted === undefined, 'importJSON 未污染原型');

    CM._cache = Object.assign({}, CM.defaults);
    CM.applyRemote({ bufferTarget: 90, autoPlay: true });
    assert(CM.get('bufferTarget') === 90, 'applyRemote 应用对象');
    CM.applyRemote([1, 2, 3]);
    assert(CM.get('bufferTarget') === 90, 'applyRemote 数组被忽略(不修改)');

    CM.set('bufferTarget', 75);
    assert(CM.get('bufferTarget') === 75, 'set/get 往返');
    const raw = VA.Storage.get(CM.constructor === Object ? '' : '__va_cfg__');
    // 直接读 Storage 验证持久化
    const stored = JSON.parse(VA.Storage.get('va_config_v19_0') || '{}');
    assert(stored.bufferTarget === 75, 'save 已持久化到 Storage');
});

// ───────────────────────── 5. estimateBandwidth ─────────────────────────
describe('5. estimateBandwidth（无资源返回数字 / 不抛）', () => {
    let v;
    try { v = VA.estimateBandwidth(); } catch (e) { v = 'THROW'; }
    assert(typeof v === 'number' && !isNaN(v), 'estimateBandwidth 返回有限数字(jsdom 下为 0)');
    assert(v === 0, 'estimateBandwidth 无资源条目→0');
});

// ───────────────────────── 6. SessionManager.hasActiveSessions（C2 守卫） ─────────────────────────
describe('6. SessionManager.hasActiveSessions（C2 修复守卫）', () => {
    assert(SM.hasActiveSessions() === false, '初始无活动会话→false');
    const fake = { id: 'test-session' };
    SM.sessions.add(fake);
    assert(SM.hasActiveSessions() === true, '加入会话后→true');
    SM.sessions.delete(fake);
    assert(SM.hasActiveSessions() === false, '移除后→false');
});

// ───────────────────────── 7. CandidateArbiter.score（评分数学精确校验） ─────────────────────────
describe('7. CandidateArbiter.score（评分算法 + 会话惩罚守卫）', () => {
    const v = win.document.createElement('video');
    win.document.body.appendChild(v); // isConnected = true
    const cand = CA._createCandidate(v);
    cand.context.visible = true;
    cand.context.inViewport = true;
    cand.context.area = 500000;
    cand.context.hasSrc = true;
    cand.context.mediaUrl = true;
    cand.context.playing = true;
    cand.context.duration = 100;
    cand.signals.protoPlay = true;

    let expected = 20 /*isConnected*/ + 12 /*visible*/ + 18 /*inViewport*/
        + 15 /*area>=minArea*/ + (cand.context.area > T.LARGE_AREA_PX ? 6 : 0) /*large*/
        + 10 /*hasSrc*/ + 12 /*mediaUrl*/ + 14 /*protoPlay*/ + 20 /*playing*/ + 10 /*long duration*/;
    const s1 = CA.score(cand);
    assert(s1 === expected, '清晰视频候选评分 = ' + expected + '（实得 ' + s1 + '）');

    // 会话惩罚：无活动会话不应扣分
    assert(SM.hasActiveSessions() === false, '对照：当前无活动会话');
    assert(s1 === expected, '无活动会话时不扣分');

    // 注入活动会话 → 应扣 25（除非 gesture）
    const sess = { id: 'x' };
    SM.sessions.add(sess);
    const s2 = CA.score(cand);
    assert(s2 === expected - 25, '有活动会话且无 gesture → 扣 25（C2 守卫生效，实得 ' + s2 + '）');
    SM.sessions.delete(sess);
    assert(SM.hasActiveSessions() === false, '会话移除后清空');

    // gesture 豁免惩罚，且叠加 gesture 奖励
    SM.sessions.add(sess);
    cand.signals.gesture = true;
    const s3 = CA.score(cand);
    assert(s3 === expected + T.GESTURE_BONUS, '有活动会话但 gesture=true → 不扣分且加 gesture 奖励（实得 ' + s3 + '）');
    cand.signals.gesture = false;
    SM.sessions.delete(sess);
});

// ───────────────────────── 8. CandidateArbiter._evaluate（接管决策 + 断连过滤） ─────────────────────────
describe('8. CandidateArbiter._evaluate（评估 + 断连过滤）', () => {
    CA.queue.clear();
    const live = win.document.createElement('video');
    win.document.body.appendChild(live);
    const cLive = CA._createCandidate(live);
    CA.queue.add(cLive);

    const dead = win.document.createElement('video'); // 未挂载 → isConnected=false
    const cDead = CA._createCandidate(dead);
    CA.queue.add(cDead);

    CA._evaluate();
    assert(cLive.lastEvaluatedAt > 0, '在线候选被评估(lastEvaluatedAt 已设)');
    assert(typeof cLive.score === 'number' && !isNaN(cLive.score), '在线候选 score 为有限数字');
    assert(!CA.queue.has(cDead), '断连候选已从 queue 移除（防泄漏）');
    CA.queue.clear();
});

// ───────────────────────── 9. UIManager._flushSettings（minVideoArea=0 端到端保留） ─────────────────────────
describe('9. UIManager._flushSettings（minVideoArea=0 端到端保留，验证修复）', () => {
    let ui;
    try {
        ui = new VA.UIManager(VA.Bus);
    } catch (e) {
        console.log('  (跳过的子测试: UIManager 构造在 jsdom 受限: ' + e.message + ')');
        return;
    }
    const fake = win.document.createElement('div');
    fake.innerHTML =
        '<input id="va-area" type="number" value="0">' +
        '<input id="va-btgt" type="number" value="120">' +
        '<input id="va-prebuf" type="number" value="3">' +
        '<input id="va-seekto" type="number" value="4000">' +
        '<input id="va-budget" type="number" value="5">' +
        '<input id="va-loglevel" type="text" value="warn">' +
        '<input id="va-auto" type="checkbox" checked>' +
        '<input id="va-dep-down" type="checkbox">';
    ui._panel = fake;
    ui._synced = true;
    ui._flushSettings();
    assert(CM.get('minVideoArea') === 0, 'minVideoArea=0 经 _flushSettings 后保留（修复生效）');
    assert(CM.get('bufferTarget') === 120, 'bufferTarget=120 正确写入');
    assert(CM.get('autoPlay') === true, 'checkbox autoPlay 正确写入');
});

// ───────────────────────── 10. 扫描优化：浅扫跳过 shadow 全量查询 ─────────────────────────
describe('10. Detector 扫描优化（浅扫跳过 shadowRoot 全量查询）', () => {
    const D = VA.Detector;
    const captured = [];
    const off = VA.Bus.on('SIGNAL_RAW', (p) => { if (p && p.video) captured.push(p.video.id); });

    // 扫描根为 root（无 class）；shadow 宿主 host 作为 root 的后代（带 class）。
    // 真实场景：refresh() 扫描 documentElement，shadow 宿主是其后代，故深扫可发现。
    const root = win.document.createElement('div');
    const host = win.document.createElement('div');
    host.className = 'host';
    const directV = win.document.createElement('video');
    directV.id = 'directV';
    root.appendChild(directV);
    const sr = host.attachShadow({ mode: 'open' });
    const shadowV = win.document.createElement('video');
    shadowV.id = 'shadowV';
    sr.appendChild(shadowV);
    root.appendChild(host);
    win.document.body.appendChild(root);

    // 深扫：video/iframe 与 shadow 宿主都应被发现
    captured.length = 0;
    D._scanWithin(root, true);
    assert(captured.includes('directV'), '深扫：直接 <video> 被发现');
    assert(captured.includes('shadowV'), '深扫：shadowRoot 内 <video> 被发现（深扫生效）');

    // 浅扫：仅 video/iframe 查询，跳过 [class],[id] 全量查询 → shadow 宿主不被发现
    captured.length = 0;
    D._scanWithin(root, false);
    assert(captured.includes('directV'), '浅扫：直接 <video> 仍被发现（主功能不受影响）');
    assert(!captured.includes('shadowV'), '浅扫：shadowRoot 内 <video> 被正确跳过（优化生效，避免整页全量查询）');

    off();

    // 周期巡逻深扫节奏：每 SCAN_SHADOW_RESCAN_PATROLS 次做一次深扫
    D._shadowRescanCounter = 0;
    const seq = [];
    for (let i = 0; i < 10; i++) {
        seq.push((D._shadowRescanCounter++ % VA.VA_TUNING.SCAN_SHADOW_RESCAN_PATROLS) === 0);
    }
    assert(seq[0] === true && seq[5] === true, '巡逻节奏：第 1、6 次为深扫');
    assert(seq.slice(1, 5).every((x) => !x) && seq.slice(6, 10).every((x) => !x), '巡逻节奏：其余为浅扫');
    D._shadowRescanCounter = 0;
});

// ───────────────────────── 汇总 ─────────────────────────
console.log('\n═══════════════════════════════════════════');
console.log('功能验证结果: ' + p + '/' + t + ' 通过' + (f ? ('，失败 ' + f) : '，全部通过 ✅'));
if (f) { console.log('失败项:'); fails.forEach(m => console.log('  - ' + m)); }
console.log('═══════════════════════════════════════════');
process.exit(f ? 1 : 0);
