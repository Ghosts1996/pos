// Заглушка справочника персональных данных (pii-gateway) для проверки
// Windows-кассы: отвечает «ок» на всё, ничего не хранит.
require('http').createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{"ok":true}');
  });
}).listen(Number(process.env.PII_STUB_PORT || 8096), '127.0.0.1');
