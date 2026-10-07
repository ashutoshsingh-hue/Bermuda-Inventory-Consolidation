/* One public port for HTTP and HTTPS. Phone cameras only work on HTTPS, operators' PCs keep plain HTTP.
   The first byte of a connection tells them apart (0x16 = TLS handshake); both are piped to the app,
   which listens on loopback only. Needs certs/key.pem + certs/cert.pem, otherwise main() skips this. */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function loadCerts() {
  try {
    return {
      key: fs.readFileSync(path.join(config.root, 'certs', 'key.pem')),
      cert: fs.readFileSync(path.join(config.root, 'certs', 'cert.pem')),
    };
  } catch { return null; }
}

function pipeToApp(front, innerPort, first) {
  const back = net.connect(innerPort, '127.0.0.1');
  back.on('error', () => front.destroy());
  front.on('error', () => back.destroy());
  if (first) back.write(first);
  front.pipe(back).pipe(front);
}

// Node's TLS takes over a socket's raw handle, so bytes already peeked would be lost. Instead TLS
// connections are forwarded raw to a loopback-only TLS server that decrypts them for the app.
export async function startPortMux({ certs, port, host, innerPort }) {
  const tlsServer = tls.createServer(certs, secure => pipeToApp(secure, innerPort));
  tlsServer.on('tlsClientError', () => {});
  await new Promise(r => tlsServer.listen(0, '127.0.0.1', r));
  const tlsPort = tlsServer.address().port;
  const server = net.createServer(sock => {
    sock.once('error', () => sock.destroy());
    sock.once('data', first => {
      sock.pause();
      pipeToApp(sock, first[0] === 0x16 ? tlsPort : innerPort, first);
      sock.resume();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
