const { vaExports: VA } = require('./_loader.cjs');
const { scoreCandidate, normalizeConfig, ConfigManager, RecoveryOrchestrator, VA_TUNING, SessionState } = VA;

function section(t){ console.log('\n=== '+t+' ==='); }

// P1: scoreCandidate when tuning is missing keys -> NaN risk
section('P1 scoreCandidate tuning missing keys');
const c = {
  video: { isConnected:true, closest:null },
  context: { visible:true, inViewport:true, area:1000, hasSrc:true, mediaUrl:true, playing:true, duration:100, live:false, muted:false, loop:false, adLike:false },
  signals: { protoSrc:true, protoLoad:true, protoPlay:true, gesture:true }
};
const emptyDeps = { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: {} };
const s1 = scoreCandidate(c, emptyDeps);
console.log('empty tuning score =', s1, 'isNaN?', isNaN(s1));
const fullDeps = { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: VA_TUNING };
const s2 = scoreCandidate(c, fullDeps);
console.log('full tuning score =', s2, 'isNaN?', isNaN(s2));

// P2: scoreCandidate ctx fields partially undefined
section('P2 scoreCandidate ctx partially undefined');
const c2 = { video: { isConnected:true }, context: { area: undefined, duration: NaN }, signals: {} };
const s3 = scoreCandidate(c2, fullDeps);
console.log('partial ctx score =', s3, 'isNaN?', isNaN(s3));

// P3: normalizeConfig malicious / out-of-range input
section('P3 normalizeConfig malicious / out-of-range');
const malicious = { __proto__: { polluted: true }, constructor: 'x', bufferTarget: -5, recoveryBudget: 999, minVideoArea: -100, autoPlay: 0, logLevel: 'bogus', extraKey: 'keep', watchdog: 'yes' };
const norm = normalizeConfig(Object.assign({}, malicious), VA_TUNING);
console.log('bufferTarget=', norm.bufferTarget, 'recoveryBudget=', norm.recoveryBudget, 'minVideoArea=', norm.minVideoArea, 'logLevel=', norm.logLevel, 'autoPlay=', norm.autoPlay, 'watchdog=', norm.watchdog, 'extraKey=', norm.extraKey);
console.log('proto polluted?', ({}).polluted);

// P4: Recovery budget cap enforced regardless of cooldown
section('P4 Recovery budget cap (decode)');
const fakeV = { paused:false, ended:false, error:null, networkState:1 };
const sess = { id:1, _dead:false, _userPaused:false, isSeeking:false, state: SessionState.ATTACHED, video: fakeV, _emergencyLoad(){}, _setState(){} };
let allowedWhenOverBudget = null;
for (let i=0;i<25;i++){
  RecoveryOrchestrator._record(sess, 4);
  const b = RecoveryOrchestrator.budget.get(sess);
  b.cooldownUntil = 0; b.timestamps = [];
  if (i === ConfigManager.get('recoveryBudget')) {
    allowedWhenOverBudget = RecoveryOrchestrator._canAttemptDecode(sess);
  }
}
console.log('budget =', ConfigManager.get('recoveryBudget'), 'canAttempt at cap+1 =', allowedWhenOverBudget);

// P5: decode recovery allowed during RECOVERING?
section('P5 decode recovery while RECOVERING');
sess.state = SessionState.RECOVERING;
const b5 = RecoveryOrchestrator.budget.get(sess); if (b5){ b5.cooldownUntil=0; b5.timestamps=[]; b5.count=0; }
console.log('_canAttemptDecode while RECOVERING =', RecoveryOrchestrator._canAttemptDecode(sess));
