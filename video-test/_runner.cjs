const fs = require('fs');
const path = require('path');
const target = process.argv[2];
const base = path.basename(target).replace(/\.(cjs|js)$/, '');
const outFile = 'D:/github repositories/ad-block/run_' + base + '.txt';
try { fs.unlinkSync(outFile); } catch (e) {}
const log = (...a) => fs.appendFileSync(outFile, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
const origLog = console.log, origErr = console.error;
console.log = log; console.error = log;
try {
  require(target);
} catch (e) {
  log('THROW: ' + (e && e.stack ? e.stack : String(e)));
}
console.log = origLog; console.error = origErr;
