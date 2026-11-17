// Minimal static server for the webview harness (node test/harness/serve.mjs → http://localhost:5179/test/harness/).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = path.join(root, decodeURIComponent(url.pathname));
    if (!p.startsWith(root)) return res.writeHead(403).end();
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  })
  .listen(5179, () => console.log('harness on http://localhost:5179/test/harness/'));
