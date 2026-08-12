const fs = require('fs');
const out = (s) => fs.appendFileSync('D:/github repositories/ad-block/diag.txt', s + '\n');
try {
  fs.writeFileSync('D:/github repositories/ad-block/diag.txt', 'LOADER_OK keys=' + Object.keys(require('D:/github repositories/ad-block/video-test/_loader.cjs')).join(',') + '\n');
  const loader = require('D:/github repositories/ad-block/video-test/_loader.cjs');
  const VA = loader.vaExports;
  const win = loader.win;
  out('win=' + (typeof win) + ' scoreCandidate=' + (typeof VA.scoreCandidate) + ' makeCandidate-dep');
  if (win && win.document) {
    const v = win.document.createElement('video');
    win.document.body.appendChild(v);
    out('video_ok=' + !!v + ' isConnected=' + v.isConnected);
  } else {
    out('NO_WIN_DOC');
  }
  // 直接复现 pure-tests 第一个 IIFE 的 scoreCandidate 调用
  const cand = { video: win.document.createElement('video'), context: { area: 300000, visible: true, inViewport: true, hasSrc: true, mediaUrl: true, blob: false, playing: true, duration: 600, live: false, muted: false, loop: false, adLike: false }, signals: { protoSrc: true, protoLoad: true, protoPlay: true, gesture: false } };
  win.document.body.appendChild(cand.video);
  const got = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: VA.VA_TUNING });
  out('scoreCandidate(full)=' + got);
  const empty = VA.scoreCandidate(cand, { minVideoArea: 0, profile: null, hasActiveSessions: false, tuning: {} });
  out('scoreCandidate(empty)=' + empty + ' isNaN=' + isNaN(empty));
} catch (e) {
  fs.appendFileSync('D:/github repositories/ad-block/diag.txt', 'THROW: ' + (e && e.stack ? e.stack : e) + '\n');
}
