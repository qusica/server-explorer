const path = require('node:path').posix;
const { safeName } = require('./transfers');
// Scan before deleting; directory links are unlinked without traversing targets.
async function deleteEntries(endpoint, directory, names) {
  if (!Array.isArray(names) || !names.length || names.length > 1000) throw new Error('请选择要删除的项目');
  const p = endpoint.path || path, validate = endpoint.safeName || safeName;
  names = [...new Set(names.map(validate))];
  const root = await endpoint.realpath(directory);
  if ((await endpoint.stat(root)).type !== 'directory') throw new Error('删除位置不是文件夹');
  const plan = []; let count = 0;
  const walk = async (file, depth = 0) => {
    if (depth > 64 || ++count > 100000) throw new Error('目录过深或项目数量超过 100000，请分批删除');
    const parent = await endpoint.realpath(p.dirname(file));
    const relativeParent = p.relative(root,parent);
    if (relativeParent === '..' || relativeParent.startsWith('..' + p.sep) || p.isAbsolute(relativeParent)) throw new Error('不能删除目录外的项目');
    const attrs = await endpoint.stat(file);
    let canonical;
    if (attrs.type === 'directory') {
      canonical = await endpoint.realpath(file);
      const relative = p.relative(root,canonical);
      if (!relative || relative === '..' || relative.startsWith('..' + p.sep) || p.isAbsolute(relative)) throw new Error('不能删除当前目录或目录外的项目');
      for (const child of await endpoint.list(file)) await walk(p.join(file,validate(child.name)),depth + 1);
    }
    plan.push({ file, type:attrs.type, canonical, parent });
  };
  for (const name of names) await walk(p.join(root,name));
  let removed = 0;
  try {
    for (const entry of plan) {
      if (p.relative(entry.parent,await endpoint.realpath(p.dirname(entry.file)))) throw new Error(`父目录在删除过程中发生变化：${entry.file}`);
      const current = await endpoint.stat(entry.file);
      if (current.type !== entry.type || (entry.canonical && p.normalize(await endpoint.realpath(entry.file)) !== p.normalize(entry.canonical))) throw new Error(`项目在删除过程中发生变化：${entry.file}`);
      if (entry.type === 'directory') await endpoint.rmdir(entry.file); else await endpoint.remove(entry.file);
      removed++;
    }
  } catch (error) { throw new Error(`已删除 ${removed} 个项目，删除未完成：${error.message}`); }
  return removed;
}
async function renameEntry(endpoint,directory,name,newName) {
  const p = endpoint.path || path, validate = endpoint.safeName || safeName;
  validate(name); validate(newName);
  const root = await endpoint.realpath(directory), from = p.join(root,name), to = p.join(root,newName);
  await endpoint.stat(from);
  if (name === newName) return;
  if (await endpoint.exists(to)) {
    const caseOnly = endpoint.path === require('node:path') && process.platform === 'win32' && !p.relative(from,to);
    if (!caseOnly) throw new Error('同名项目已存在，请使用其他名称');
  }
  await endpoint.rename(from,to);
}
module.exports = { deleteEntries, renameEntry };
