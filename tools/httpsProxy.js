/* HTTPS front for the phone-camera prototype: terminates TLS on :8443 and forwards to the app on :8080.
   Not part of the app (src/ untouched). Usage: node tools/httpsProxy.js */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = { host: '127.0.0.1', port: Number(process.env.PORT) || 8080 };
const listen = Number(process.env.HTTPS_PORT) || 8443;
const opts = {
  key: fs.readFileSync(path.join(root, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(root, 'certs', 'cert.pem')),
};

https.createServer(opts, (req, res) => {
  const up = http.request({ ...target, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('app not reachable'); });
  req.pipe(up);
}).listen(listen, '0.0.0.0', () => console.log(`HTTPS proxy :${listen} -> :${target.port}`));
