const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { Readable, Writable } = require('node:stream');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const str = value => { const b = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(b.length), b]); };
class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  take(n) { if (n < 0 || this.offset + n > this.buffer.length) throw new Error('SFTP 响应格式不正确'); const b = this.buffer.subarray(this.offset, this.offset + n); this.offset += n; return b; }
  uint() { return this.take(4).readUInt32BE(); }
  string() { return this.take(this.uint()); }
  attrs() {
    const flags = this.uint(), a = {};
    if (flags & 1) { const size = this.take(8).readBigUInt64BE(); if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('文件大小超出支持范围'); a.size = Number(size); }
    if (flags & 2) { a.uid = this.uint(); a.gid = this.uint(); }
    if (flags & 4) a.mode = this.uint();
    if (flags & 8) { a.atime = this.uint(); a.mtime = this.uint(); }
    if (flags & 0x80000000) { const count = this.uint(); for (let i = 0; i < count; i++) { this.string(); this.string(); } }
    a.type = (a.mode & 0xf000) === 0x4000 ? 'directory' : (a.mode & 0xf000) === 0xa000 ? 'symlink' : (a.mode & 0xf000) === 0x8000 ? 'file' : 'other';
    return a;
  }
}
// SFTP v3 over the installed OpenSSH process: all SSH authentication and config
// remain handled by OpenSSH. Older servers use a quoted SSH cp command only
// for same-server copies; browsing and cross-server transfers stay on SFTP.
class Sftp extends EventEmitter {
  constructor(child, options = {}) {
    super(); this.extensions = new Map(); this.copyProcesses = new Set(); this.child = child; this.buffer = Buffer.alloc(0); this.pending = new Map(); this.nextId = 1; this.closed = false; this.stderr = ''; this.timeout = options.timeout || 45000;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    child.stdout.on('data', data => {
      try { this.buffer = Buffer.concat([this.buffer, data]); this.parse(); }
      catch (error) { this.fail(error); }
    });
    child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-16000); });
    child.on('error', error => this.fail(error));
    child.on('close', code => this.fail(new Error(this.stderr.trim() || `SSH 连接已关闭（${code ?? '断开'}）`)));
    child.stdin.on('error', error => this.fail(error));
    this.readyTimer = setTimeout(() => this.fail(new Error(this.stderr.trim() || '连接超时，请检查网络或完成身份验证。')), options.connectTimeout || 180000);
    this.send(Buffer.concat([Buffer.from([1]), u32(3)]));
  }
  static connect(alias, configPath, env = {}, options = {}) {
    const child = spawn('ssh', ['-F', configPath, '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=ask', '-o', 'BatchMode=no', '-o', 'RemoteCommand=none', '-o', 'ClearAllForwardings=yes', '-T', '-s', alias, 'sftp'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, SERVER_EXPLORER_ALIAS: alias }
    });
    const endpoint = new Sftp(child, options);
    endpoint.connection = { alias, configPath, env };
    return endpoint;
  }
  send(payload) {
    if (this.closed) throw new Error('SSH 连接已关闭');
    this.child.stdin.write(Buffer.concat([u32(payload.length), payload]));
  }
  parse() {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE();
      if (!length || length > 16 * 1024 * 1024) throw new Error('SFTP 数据包大小无效');
      if (this.buffer.length < length + 4) return;
      const packet = this.buffer.subarray(4, 4 + length); this.buffer = this.buffer.subarray(4 + length);
      const type = packet[0], r = new Reader(packet.subarray(1));
      if (type === 2) { const version = r.uint(); if (version !== 3) throw new Error(`不支持 SFTP v${version}`); while (r.offset < r.buffer.length) { const name = r.string().toString(); this.extensions.set(name, r.string().toString()); } clearTimeout(this.readyTimer); this.resolveReady(this); continue; }
      const id = r.uint(), pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id); clearTimeout(pending.timer);
      if (type === 101) {
        const code = r.uint(), message = r.string().toString();
        if (code === 0) pending.resolve(null);
        else { const error = new Error(message || ({1:'文件读取结束',2:'文件或目录不存在',3:'没有读写权限',4:'服务器拒绝操作'}[code] || `SFTP 错误 ${code}`)); error.code = code; pending.reject(error); }
      } else pending.resolve({ type, reader: r });
    }
  }
  request(type, ...parts) {
    if (this.closed) return Promise.reject(new Error('SSH 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('SFTP 操作超时，连接已关闭。')), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(Buffer.concat([Buffer.from([type]), u32(id), ...parts])); } catch (error) { this.fail(error); }
    });
  }
  async realpath(p) { const result = await this.request(16, str(p)); if (result?.type !== 104 || result.reader.uint() < 1) throw new Error('无法解析远程路径'); return result.reader.string().toString(); }
  async stat(p, follow = false) { const result = await this.request(follow ? 17 : 7, str(p)); if (result?.type !== 105) throw new Error('无法读取文件属性'); return result.reader.attrs(); }
  async exists(p) { try { return await this.stat(p); } catch (error) { if (error.code === 2) return null; throw error; } }
  async closeHandle(h) { await this.request(4, str(h)); }
  async list(p) {
    const result = await this.request(11, str(p));
    if (result?.type !== 102) throw new Error('无法打开目录');
    const handle = result.reader.string(), entries = [];
    try {
      for (;;) {
        let batch;
        try { batch = await this.request(12, str(handle)); } catch (error) { if (error.code === 1) break; throw error; }
        if (batch?.type !== 104) throw new Error('无法读取目录');
        const n = batch.reader.uint();
        if (!n) break;
        for (let i = 0; i < n; i++) { const name = batch.reader.string().toString(); batch.reader.string(); const attrs = batch.reader.attrs(); if (name !== '.' && name !== '..') entries.push({ name, ...attrs }); }
      }
    } finally { await this.closeHandle(handle).catch(() => {}); }
    return entries.sort((a,b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }
  async open(p, flags, mode = 0o644) { const result = await this.request(3, str(p), u32(flags), u32(4), u32(mode)); if (result?.type !== 102) throw new Error('无法打开文件'); return result.reader.string(); }
  async read(h, offset, size) { const result = await this.request(5, str(h), u64(offset), u32(size)); if (result?.type !== 103) throw new Error('无法读取文件'); return result.reader.string(); }
  async write(h, offset, data) { await this.request(6, str(h), u64(offset), str(data)); }
  async mkdir(p, mode = 0o755) { await this.request(14, str(p), u32(4), u32(mode & 0o777)); }
  async remove(p) { await this.request(13, str(p)); }
  async rmdir(p) { await this.request(15, str(p)); }
  async rename(from, to) { await this.request(18, str(from), str(to)); }
  async posixRename(from, to) { await this.request(200, str('posix-rename@openssh.com'), str(from), str(to)); }
  async readlink(p) { const r = await this.request(19, str(p)); if (r?.type !== 104 || r.reader.uint() < 1) throw new Error('无法读取链接'); return r.reader.string().toString(); }
  async symlink(target, p) { await this.request(20, str(target), str(p)); }
  async copyFile(from, to, mode, size, signal, progress) {
    const check = () => { if (signal.aborted) { const error = new Error('传输已取消'); error.name = 'AbortError'; throw error; } };
    check();
    if (this.extensions.get('copy-data') === '1' || !size) {
      let input, output;
      try {
        input = await this.open(from, 1);
        output = await this.open(to, 2 | 8 | 32, mode & 0o777);
        for (let offset = 0; offset < size;) {
          check();
          const length = Math.min(8 * 1024 * 1024, size - offset);
          await this.request(200, str('copy-data'), str(input), u64(offset), u64(length), str(output), u64(offset));
          offset += length; progress(length); check();
        }
        return;
      } catch (error) {
        if (error.code !== 8 || signal.aborted) throw error;
        // A server may advertise an extension that it cannot actually execute.
        this.extensions.delete('copy-data');
      } finally {
        if (input) await this.closeHandle(input).catch(() => {});
        if (output) await this.closeHandle(output).catch(() => {});
      }
      await this.remove(to);
    }
    check();
    // Verify a shared shell/SFTP namespace. A separate control file lets a
    // cancelled job stop remote cp before the temporary output is removed.
    const marker = require('node:crypto').randomBytes(32).toString('hex');
    const control = to + '.control';
    try {
      const handle = await this.open(control, 2 | 8 | 32, 0o600);
      try { await this.write(handle, 0, Buffer.from(marker)); }
      finally { await this.closeHandle(handle).catch(() => {}); }
      check();
      const output = await this.open(to, 2 | 8 | 32, 0o600);
      await this.closeHandle(output);
      check();
      const stop = `kill "$copy_pid" 2>/dev/null; wait "$copy_pid" 2>/dev/null; rm -f -- ${shellQuote(to)}; exit 1`;
      const command = `if [ "$(cat -- ${shellQuote(control)})" = ${shellQuote(marker)} ]; then cp -P -- ${shellQuote(from)} ${shellQuote(to)} & copy_pid=$!; trap ${shellQuote(stop)} HUP INT TERM; while kill -0 "$copy_pid" 2>/dev/null; do if [ ! -f ${shellQuote(control)} ]; then ${stop}; fi; sleep 0.2; done; wait "$copy_pid"; copy_status=$?; if [ ! -f ${shellQuote(control)} ]; then rm -f -- ${shellQuote(to)}; exit 1; fi; exit "$copy_status"; else printf '%s\\n' 'SFTP and shell directories differ' >&2; exit 1; fi`;
      await this.executeCopy(command, signal, () => this.remove(control));
      check();
      const copied = await this.stat(to);
      if (copied.type !== 'file' || copied.size !== size) throw new Error('服务器复制结果与源文件不一致，请检查源文件是否发生变化');
      await this.request(9, str(to), u32(4), u32(mode & 0o777));
      progress(size);
    } finally { await this.remove(control).catch(() => {}); }
  }
  executeCopy(command, signal, cancelRemote) {
    if (!this.connection) return Promise.reject(new Error('服务器不支持直接复制'));
    const { alias, configPath, env } = this.connection;
    return new Promise((resolve, reject) => {
      let stderr = '', timer, abortTimer, settled = false;
      const child = spawn('ssh', ['-F', configPath, '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=no', '-o', 'RemoteCommand=none', '-o', 'ClearAllForwardings=yes', '-T', alias, command], {
        windowsHide:true, stdio:['ignore','ignore','pipe'], env:{...process.env,...env,SERVER_EXPLORER_ALIAS:alias}
      });
      this.copyProcesses.add(child);
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(abortTimer); signal.removeEventListener('abort', abort); this.copyProcesses.delete(child);
        error ? reject(error) : resolve();
      };
      const abort = () => { cancelRemote().then(() => { if (!settled) abortTimer = setTimeout(() => child.kill(), 1500); }, () => child.kill()); };
      child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
      child.once('error', error => finish(error));
      child.once('close', code => {
        if (signal.aborted) { const error = new Error('传输已取消'); error.name = 'AbortError'; finish(error); }
        else finish(code === 0 ? null : new Error(`服务器端复制失败，请确认服务器支持 SFTP 复制或允许执行 cp：${stderr.trim() || code}`));
      });
      timer = setTimeout(() => { child.kill(); finish(new Error('服务器端复制超时')); }, 180000);
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    });
  }
  async readStream(p) {
    const h = await this.open(p, 1); let offset = 0; const self = this;
    return Readable.from((async function* () {
      try { for (;;) { let data; try { data = await self.read(h, offset, 65536); } catch (error) { if (error.code === 1) return; throw error; } if (!data.length) return; offset += data.length; yield data; } }
      finally { await self.closeHandle(h).catch(() => {}); }
    })(), { highWaterMark: 262144, objectMode: false });
  }
  async writeStream(p, mode) {
    const h = await this.open(p, 2 | 8 | 32, mode & 0o777); let offset = 0; let closed = false; const self = this;
    return new Writable({
      highWaterMark: 262144,
      write(data, encoding, callback) { self.write(h, offset, data).then(() => { offset += data.length; callback(); }, callback); },
      final(callback) { closed = true; self.closeHandle(h).then(() => callback(), callback); },
      destroy(error, callback) { if (closed) callback(error); else { closed = true; self.closeHandle(h).catch(() => {}).then(() => callback(error)); } }
    });
  }
  fail(error, force = false) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.readyTimer); this.rejectReady(error);
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    for (const child of this.copyProcesses) child.kill();
    if (force && process.platform === 'win32' && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      // Kill only this app-owned SSH process tree, including ProxyJump/askpass.
      const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
      killer.once('error', () => this.child.kill());
      killer.once('close', code => { if (code !== 0) this.child.kill(); });
    } else this.child.kill();
    this.emit('disconnect', error.message);
  }
  close({ force = false } = {}) { this.fail(new Error(force ? '连接已取消' : '连接已关闭'), force); }
}
module.exports = { Sftp, Reader, u32, str };
