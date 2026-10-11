const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const displayPath = p => p.replaceAll('\\', '/');
function localPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || p.length > 32768 || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(p))) throw new Error('请输入有效的本地绝对路径');
  return path.normalize(p);
}
function localName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name) || (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) throw new Error('本地文件名无效或不受 Windows 支持');
  return name;
}
class LocalFiles {
  constructor() { this.path = path; this.safeName = localName; this.closed = false; }
  async realpath(p) { return displayPath(await fs.realpath(localPath(p))); }
  async stat(p) { const a = await fs.lstat(localPath(p)); return { type:a.isSymbolicLink() ? 'symlink' : a.isDirectory() ? 'directory' : a.isFile() ? 'file' : 'other', size:a.size, mode:a.mode, mtime:Math.floor(a.mtimeMs / 1000) }; }
  async exists(p) { try { return await this.stat(p); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async list(p) { const entries = await fs.readdir(localPath(p)); return (await Promise.all(entries.map(async name => ({ name, ...await this.stat(path.join(p,name)) })))).sort((a,b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name,'zh-CN',{numeric:true})); }
  async mkdir(p, mode = 0o755) { await fs.mkdir(localPath(p),{mode:mode & 0o777}); }
  async remove(p) { await fs.unlink(localPath(p)); }
  async rmdir(p) { await fs.rmdir(localPath(p)); }
  async rename(from,to) { if (await this.exists(to) && path.relative(from,to)) throw new Error('目标项目已存在，请重试并确认覆盖'); await fs.rename(localPath(from),localPath(to)); }
  async posixRename(from,to) { await fs.rename(localPath(from),localPath(to)); }
  async readlink(p) { return fs.readlink(localPath(p)); }
  async symlink(target,p) { await fs.symlink(target,localPath(p)); }
  async readStream(p) { return createReadStream(localPath(p)); }
  async writeStream(p,mode) { return createWriteStream(localPath(p),{ flags:'wx', mode:mode & 0o777 }); }
}
function localSession() { return { id:'local', alias:'本地电脑', identity:'local-computer', local:true, home:displayPath(os.homedir()), sftp:new LocalFiles() }; }
module.exports = { LocalFiles, localPath, localName, localSession };
