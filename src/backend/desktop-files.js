const fs = require('node:fs/promises');
const path = require('node:path');
const { localPath } = require('./local');
class DesktopFiles {
  constructor({directory,local,transfers,getSession}) { this.directory=path.resolve(directory); this.local=local; this.transfers=transfers; this.getSession=getSession; }
  async paths(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw new Error('请选择要拖出的文件或文件夹');
    const result = [...new Set(paths.map(localPath))];
    for (const file of result) if (!['file','directory','symlink'].includes((await this.local.stat(file)).type)) throw new Error('不支持拖出特殊文件');
    return result;
  }
  async prepare({id,paths}) {
    this.getSession(id);
    if (id === 'local') return this.paths(paths);
    await fs.mkdir(this.directory,{recursive:true});
    const staging = await fs.mkdtemp(path.join(this.directory,'export-'));
    try {
      const jobId = this.transfers.start({sourceId:id,targetId:'local',paths,targetPath:staging});
      const job = await this.transfers.wait(jobId);
      if (job.status === 'cancelled') throw new Error('桌面文件准备已取消');
      if (job.status !== 'done') throw new Error(job.error || '桌面文件准备失败');
      return await this.paths((await this.local.list(staging)).map(entry=>path.join(staging,entry.name)));
    } catch(error) { await this.remove(staging).catch(()=>{}); throw error; }
  }
  async remove(directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.directory || !/^export-[a-z0-9]{6}$/i.test(path.basename(resolved))) throw new Error('临时文件目录无效');
    await fs.rm(resolved,{recursive:true,force:true});
  }
  async cleanup(now=Date.now()) {
    let entries; try { entries=await fs.readdir(this.directory,{withFileTypes:true}); } catch(error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^export-[a-z0-9]{6}$/i.test(entry.name)) continue;
      const directory = path.join(this.directory,entry.name);
      if (now - (await fs.lstat(directory)).mtimeMs > 86400000) await this.remove(directory);
    }
  }
}
module.exports = {DesktopFiles};
