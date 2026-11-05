// ============================================================
// 门铃：被拒绝的访问（401 / 403）记一行，写进系统日志（journalctl -u maowo，只有管理员能看，
// journald 自己会删旧的）。只记被拒绝的，正常进出不记。
// 网址只记 ? 前面的路径：后面可能带着 token，钥匙绝不进日志。
// 同一个地址一分钟里被拒绝太多次，只逐条记前几次，之后合成一句「又被拒绝了 N 次」。
// 看：sudo journalctl -u maowo --since -1day | grep 门铃
// ============================================================
const PER_MINUTE = 20;
const seen = new Map(); // ip -> { start, count }

const clean = (s, n) => String(s || '').replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7e -￿]/g, '?').slice(0, n);

function line(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  const now = Date.now();
  let s = seen.get(ip);
  if (!s || now - s.start >= 60000) {
    if (s && s.count > PER_MINUTE) console.log(`[门铃] ${ip} 上一分钟里又被拒绝了 ${s.count - PER_MINUTE} 次（没逐条记）`);
    s = { start: now, count: 0 };
    seen.set(ip, s);
  }
  s.count++;
  if (s.count > PER_MINUTE) return;
  const path = clean((req.originalUrl || req.url || '').split('?')[0], 120);
  console.log(`[门铃] ${res.statusCode} ${ip} ${clean(req.method, 8)} ${path} · ${clean(req.get('user-agent'), 60) || '没写是什么程序'}`);
}

// Express middleware: listens for the answer, so every route's 401 / 403 is caught in one place.
function middleware(req, res, next) {
  res.on('finish', () => { if (res.statusCode === 401 || res.statusCode === 403) line(req, res); });
  next();
}

// Forget quiet addresses now and then, so the map stays small.
setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of seen) {
    if (now - s.start < 60000) continue;
    if (s.count > PER_MINUTE) console.log(`[门铃] ${ip} 上一分钟里又被拒绝了 ${s.count - PER_MINUTE} 次（没逐条记）`);
    seen.delete(ip);
  }
}, 5 * 60000).unref();

module.exports = { middleware };
