const path = require('node:path').posix;
const contains = (p, parent, child) => { const relative = p.relative(parent, child); return !relative || (relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative)); };
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
function safeName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new Error('远程文件名无效');
  return name;
}
class Transfers {
  constructor({ getSession, emit, ask }) { this.getSession = getSession; this.emit = emit; this.ask = ask; this.jobs = new Map(); this.waiters = new Map(); this.queue = []; this.running = false; }
  validate({ sourceId, targetId, paths, targetPath }) {
    const source = this.getSession(sourceId), target = this.getSession(targetId);
    const sourcePath = source.sftp.path || path, destinationPath = target.sftp.path || path;
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(p => typeof p !== 'string' || !sourcePath.isAbsolute(p) || p.includes('\0'))) throw new Error('请选择有效的源文件');
    if (typeof targetPath !== 'string' || !destinationPath.isAbsolute(targetPath) || targetPath.includes('\0')) throw new Error('目标目录无效');
    return { source, target, sourcePath, destinationPath };
  }
  sameServer(sourceId, targetId, source, target) { return sourceId === targetId || (!!source.identity && source.identity === target.identity); }
  async inspect(payload) {
    const { source, target, sourcePath } = this.validate(payload);
    const sameServer = this.sameServer(payload.sourceId, payload.targetId, source, target);
    if (!sameServer) return {sameServer:false,sameDirectory:false};
    const targetRoot = await target.sftp.realpath(payload.targetPath);
    if ((await target.sftp.stat(targetRoot)).type !== 'directory') throw new Error('目标位置不是文件夹');
    const parents = new Set(payload.paths.map(p => sourcePath.dirname(sourcePath.normalize(p))));
    let sameDirectory = true;
    for (const parent of parents) {
      if (sourcePath.relative(await source.sftp.realpath(parent), targetRoot)) { sameDirectory = false; break; }
    }
    return {sameServer:true,sameDirectory};
  }
  start(payload) {
    const { sourceId, targetId, paths, targetPath } = payload;
    const { source, target } = this.validate(payload);
    const id = randomUUID(), job = { id, sourceId, targetId, sourceAlias: source.alias, targetAlias: target.alias, paths: [...new Set(paths)], targetPath, status: 'queued', bytes: 0, total: 0, completed: 0, count: 0, skipped: 0, current: '', startedAt: Date.now() };
    job.controller = new AbortController();
    this.jobs.set(id, job); this.queue.push(job); this.update(job); this.drain();
    return id;
  }
  update(job) {
    const { controller, ...publicJob } = job; this.emit(publicJob);
    if (['done','failed','cancelled'].includes(job.status)) {
      for (const resolve of this.waiters.get(job.id) || []) resolve(publicJob);
      this.waiters.delete(job.id);
    }
  }
  wait(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error('传输任务不存在'));
    if (['done','failed','cancelled'].includes(job.status)) { const {controller,...result}=job; return Promise.resolve(result); }
    return new Promise(resolve => { const waiters = this.waiters.get(id) || []; waiters.push(resolve); this.waiters.set(id,waiters); });
  }
  usesSession(id) { return [...this.jobs.values()].some(j => ['queued','scanning','running','waiting'].includes(j.status) && (j.sourceId === id || j.targetId === id)); }
  cancel(id) { const job = this.jobs.get(id); if (!job || !['queued','scanning','running','waiting'].includes(job.status)) return; job.controller.abort(); if (job.status === 'queued') { job.status = 'cancelled'; this.update(job); } }
  check(job) { if (job.controller.signal.aborted) { const error = new Error('传输已取消'); error.name = 'AbortError'; throw error; } }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        if (job.status === 'cancelled') continue;
        try { await this.run(job); job.status = 'done'; }
        catch (error) { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; }
        this.update(job);
        const finished = [...this.jobs.values()].filter(j => ['done','failed','cancelled'].includes(j.status));
        for (const old of finished.slice(0, Math.max(0, finished.length - 50))) this.jobs.delete(old.id);
      }
    } finally { this.running = false; }
  }
  async run(job) {
    const sourceSession = this.getSession(job.sourceId), targetSession = this.getSession(job.targetId);
    const source = sourceSession.sftp, target = targetSession.sftp;
    const srcPath = source.path || path, dstPath = target.path || path, targetName = target.safeName || safeName;
    job.status = 'scanning'; this.update(job); this.check(job);
    const targetRoot = await target.realpath(job.targetPath);
    if ((await target.stat(targetRoot)).type !== 'directory') throw new Error('目标位置不是文件夹');
    const sameServer = this.sameServer(job.sourceId, job.targetId, sourceSession, targetSession);
    job.mode = sameServer && !source.path ? 'server' : 'stream';
    const entries = [], selected = [];
    for (const input of job.paths) {
      const p = srcPath.normalize(input);
      if (p === srcPath.parse(p).root) throw new Error('不能复制整个根目录');
      if (!selected.some(parent => contains(srcPath, parent, p))) selected.push(p);
    }
    // If a parent was selected after a child, copy the parent once.
    const roots = selected.filter(p => !selected.some(other => p !== other && contains(srcPath, other, p)));
    const walk = async (src, dst, depth = 0) => {
      this.check(job);
      if (depth > 64 || entries.length >= 100000) throw new Error('目录过深或文件数量超过 100000，请分批复制。');
      const attrs = await source.stat(src);
      if (!['file','directory','symlink'].includes(attrs.type)) throw new Error(`不支持复制特殊文件：${src}`);
      if (sameServer && attrs.type !== 'symlink') {
        const canonical = await source.realpath(src);
        if (contains(srcPath, canonical, dst) && (attrs.type === 'directory' || !srcPath.relative(canonical, dst))) throw new Error('不能复制到原位置或源文件夹内部');
      }
      entries.push({ src, dst, ...attrs });
      if (attrs.type === 'file') { job.total += attrs.size || 0; job.count++; }
      if (attrs.type === 'symlink') job.count++;
      if (entries.length % 32 === 0) { job.current = src; this.update(job); }
      if (attrs.type === 'directory') {
        for (const child of await source.list(src)) { safeName(child.name); targetName(child.name); await walk(srcPath.join(src, child.name), dstPath.join(dst, child.name), depth + 1); }
      }
    };
    for (const src of roots) {
      this.check(job);
      if (sameServer && !srcPath.relative(await source.realpath(srcPath.dirname(src)), targetRoot)) { job.skipped++; continue; }
      await walk(src, dstPath.join(targetRoot, targetName(srcPath.basename(src))));
    }
    job.status = 'running'; this.update(job);
    const skipDirectories = []; let policy = null;
    for (const entry of entries) {
      this.check(job);
      if (skipDirectories.some(p => contains(dstPath, p, entry.dst))) { if (entry.type !== 'directory') job.skipped++; continue; }
      job.current = entry.src; this.update(job);
      const existing = await target.exists(entry.dst);
      if (existing) {
        if (entry.type === 'directory' && existing.type === 'directory') continue;
        let answer = policy;
        if (!answer) {
          job.status = 'waiting'; this.update(job);
          answer = await this.ask({ kind: 'conflict', title: '目标中存在同名项目', message: entry.dst, detail: `来源：${job.sourceAlias}\n目标：${job.targetAlias}\n文件夹与文件类型不同的项目只能跳过。`, canReplace: entry.type !== 'directory' && ['file','symlink'].includes(existing.type), jobId: job.id }, job.controller.signal);
          this.check(job);
          job.status = 'running';
          if (answer?.endsWith('-all')) { policy = answer.replace('-all', ''); answer = policy; }
        }
        if (answer === 'cancel' || !answer) { job.controller.abort(); this.check(job); }
        if (answer === 'skip' || entry.type === 'directory' || !['file','symlink'].includes(existing.type)) {
          if (entry.type === 'directory') skipDirectories.push(entry.dst);
          job.skipped++;
          continue;
        }
        if (answer !== 'replace') throw new Error('同名文件处理方式无效');
      }
      if (entry.type === 'directory') { await target.mkdir(entry.dst, entry.mode); continue; }
      const temp = dstPath.join(dstPath.dirname(entry.dst), `.server-explorer-${job.id}-${randomUUID()}.part`);
      try {
        if (entry.type === 'symlink') { await target.symlink(await source.readlink(entry.src), temp); }
        else if (job.mode === 'server') {
          // Both extension handles must belong to one SFTP connection, even
          // when source and target panels were opened through different aliases.
          await source.copyFile(entry.src, temp, entry.mode, entry.size || 0, job.controller.signal, length => { job.bytes += length; this.update(job); });
        } else {
          const input = await source.readStream(entry.src); let output;
          try { output = await target.writeStream(temp, entry.mode); } catch (error) { input.destroy(); throw error; }
          let last = 0;
          const progress = new Transform({ transform: (chunk, encoding, callback) => { job.bytes += chunk.length; if (Date.now() - last > 120) { last = Date.now(); this.update(job); } callback(null, chunk); } });
          await pipeline(input, progress, output, { signal: job.controller.signal });
        }
        this.check(job);
        if (existing) {
          // OpenSSH extension replaces atomically. Do not delete originals when
          // a server lacks the extension: preserving data wins over overwrite.
          try { await target.posixRename(temp, entry.dst); }
          catch (error) { throw new Error(`目标不支持安全覆盖，原文件已保留：${entry.dst}（${error.message}）`); }
        } else await target.rename(temp, entry.dst);
        job.completed++;
      } finally { await target.remove(temp).catch(() => {}); }
    }
    job.current = ''; this.update(job);
  }
}
module.exports = { Transfers, safeName };
