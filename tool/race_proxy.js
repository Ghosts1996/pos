// Посредник одной кассы для tool/race_devices.sh: 8788 → 8787. POST 127.0.0.1:8789/cut {"on":true} — у этой кассы «пропал интернет».
const http = require('http');
let cut = false; const socks = new Set();
const srv = http.createServer((req, res) => {
  if (cut) { req.socket.destroy(); return; }
  const r = http.request({ host: '127.0.0.1', port: 8787, path: req.url, method: req.method, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); });
  r.on('error', () => res.destroy());
  req.pipe(r);
});
srv.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); if (cut) s.destroy(); });
srv.listen(8788, '127.0.0.1');
http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { cut = JSON.parse(b).on === true; } catch (_) {} if (cut) for (const s of socks) s.destroy(); res.end(JSON.stringify({ cut })); }); }).listen(8789, '127.0.0.1');
