const net = require('node:net');
const { randomBytes } = require('node:crypto');
async function createAskpass(executable, ask) {
  const name = `server-explorer-${process.pid}-${randomBytes(12).toString('hex')}`;
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(180000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', async data => {
      if (handled) return;
      input += data.toString('utf8');
      if (input.length > 65536) { socket.destroy(); return; }
      const lines = input.split('\n');
      if (lines.length < 5) return;
      handled = true;
      if (lines[0].trim() !== token) { socket.destroy(); return; }
      const alias = Buffer.from(lines[1].trim(), 'base64').toString('utf8');
      const prompt = Buffer.from(lines[2].trim(), 'base64').toString('utf8');
      const requestId = Buffer.from(lines[3].trim(), 'base64').toString('utf8');
      const controller = new AbortController(); socket.once('close', () => controller.abort());
      const trust = /authenticity|continue connecting|fingerprint|yes\/no/i.test(prompt);
      try {
        const answer = await ask({ kind: trust ? 'trust' : 'secret', title: trust ? '确认服务器身份' : 'SSH 身份验证', message: prompt, detail: alias, requestId }, controller.signal);
        if (!socket.destroyed) socket.end(answer === null ? 'CANCEL\n' : Buffer.from(answer, 'utf8').toString('base64') + '\n');
      } catch { if (!socket.destroyed) socket.end('CANCEL\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${name}`, resolve); });
  return {
    env: { SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'server-explorer:0', SERVER_EXPLORER_PIPE: name, SERVER_EXPLORER_TOKEN: token },
    close() { for (const socket of sockets) socket.destroy(); server.close(); }
  };
}
module.exports = { createAskpass };
