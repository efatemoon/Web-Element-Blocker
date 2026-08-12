// 探针：复现「visibleOnly 延迟接管」隐藏 bug
// 行为：不可见视频被延迟（seen 不应永久标记），可见后应成功接管
const fs = require('fs');
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));
const { vaExports: VA } = require('./_loader.cjs');

const SM = VA.SessionManager;
const CM = VA.ConfigManager;
const DOC = VA.Bus && (typeof document !== 'undefined' ? document : null);

function freshVideo() {
  const v = document.createElement('video');
  v.src = 'https://example.com/v.mp4';
  document.body.appendChild(v);
  return v;
}

// 关键：让 area 检查不干扰（minVideoArea=0），只测可见性
CM.set('visibleOnly', true);
CM.set('minVideoArea', 0);
CM.set('watchdog', true);

const v = freshVideo();

log('=== 调用前 ===');
log('isVisible(v)=', VA.isVisible(v), ' area=', VA.videoArea(v));
log('seen.has(v)=', SM.seen.has(v), ' sessions=', SM.sessions.size);

// 第一次：不可见 → 应延迟
SM._takeOverFromArbiter(v, { candidate: { userGestureAt: 0 } });
log('=== 第一次(不可见)后 ===');
log('sessions=', SM.sessions.size, ' seen.has(v)=', SM.seen.has(v), ' __vaSession=', !!v.__vaSession);

// 使可见：设置 opacity
v.style.opacity = '1';
log('=== 设为可见后 ===');
log('isVisible(v)=', VA.isVisible(v));

// 第二次：可见 → 应接管
SM._takeOverFromArbiter(v, { candidate: { userGestureAt: 0 } });
log('=== 第二次(可见)后 ===');
log('sessions=', SM.sessions.size, ' seen.has(v)=', SM.seen.has(v), ' __vaSession=', !!v.__vaSession);

fs.writeFileSync(__dirname + '/probe2.txt', out.join('\n') + '\n', 'utf8');
process.exit(0);
