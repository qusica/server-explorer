const path = require('node:path').posix;
const { randomUUID } = require('node:crypto');
const LIMIT = 256 * 1024;
function validate(paths) {
  if (!Array.isArray(paths) || paths.length > 500 || paths.some(p => typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.length > 32768)) throw new Error('收藏路径配置无效');
  return [...new Set(paths)];
}
async function location(session) {
  const home = session.home || await session.sftp.realpath('.');
  return path.join(home, '.server-explorer');
}
async function readFavorites(session) {
  const sftp = session.sftp, dir = await location(session);
  const directory = await sftp.exists(dir);
  if (!directory) return [];
  if (directory.type !== 'directory') throw new Error('收藏目录必须是普通目录');
  const file = path.join(dir, 'favorites.json'), stat = await sftp.exists(file);
  if (!stat) return [];
  if (stat.type !== 'file' || stat.size > LIMIT) throw new Error('收藏配置必须是小于 256 KB 的普通文件');
  const handle = await sftp.open(file, 1), chunks = [];
  try {
    let offset = 0;
    while (offset <= LIMIT) {
      let chunk;
      try { chunk = await sftp.read(handle, offset, Math.min(32768, LIMIT + 1 - offset)); }
      catch (error) { if (error.code === 1) break; throw error; }
      if (!chunk.length) break;
      chunks.push(chunk); offset += chunk.length;
    }
    if (offset > LIMIT) throw new Error('收藏配置过大');
  } finally { await sftp.closeHandle(handle); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (data.version !== 1) throw new Error('收藏配置版本不支持');
  return validate(data.paths);
}
async function updateFavorite(session, target, remove) {
  validate([target]);
  const sftp = session.sftp, dir = await location(session);
  // Serialize this application's updates; reread before each change to retain other clients' additions.
  const previous = session.favoriteUpdate || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readFavorites(session);
    const paths = validate(remove ? current.filter(p => p !== target) : [...new Set([...current, target])]);
    const data = Buffer.from(JSON.stringify({version:1, paths}, null, 2) + '\n');
    if (data.length > LIMIT) throw new Error('收藏配置过大');
    if (!await sftp.exists(dir)) {
      try { await sftp.mkdir(dir, 0o700); }
      catch (error) { if ((await sftp.exists(dir))?.type !== 'directory') throw error; }
    }
    const file = path.join(dir, 'favorites.json'), temp = path.join(dir, 'favorites-' + randomUUID() + '.tmp');
    try {
      const handle = await sftp.open(temp, 2 | 8 | 32, 0o600);
      try { for (let offset = 0; offset < data.length; offset += 32768) await sftp.write(handle, offset, data.subarray(offset, offset + 32768)); }
      finally { await sftp.closeHandle(handle); }
      if (sftp.extensions?.has('posix-rename@openssh.com')) await sftp.posixRename(temp, file);
      else await sftp.rename(temp, file);
      return paths;
    } finally { await sftp.remove(temp).catch(() => {}); }
  });
  session.favoriteUpdate = operation;
  return operation;
}
module.exports = { readFavorites, updateFavorite };
