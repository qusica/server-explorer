const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { glob } = require('glob');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const defaultConfig = () => path.join(os.homedir(), '.ssh', 'config');
// Quotes and comments follow ssh_config syntax; Include paths may contain spaces.
function tokens(line) {
  const out = []; let word = '', quote = false, started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quote = !quote; started = true; continue; }
    if (ch === '#' && !quote) break;
    if (/\s/.test(ch) && !quote) { if (started) out.push(word); word = ''; started = false; }
    else { word += ch; started = true; }
  }
  if (started) out.push(word);
  return out;
}
async function discover(configPath = defaultConfig()) {
  const aliases = new Set(), seen = new Set(), warnings = [];
  async function visit(file, depth = 0) {
    file = path.resolve(file);
    if (seen.has(file)) return;
    if (depth > 16) { warnings.push('Include 嵌套超过 16 层，已停止读取。'); return; }
    seen.add(file);
    let contents;
    try { contents = await fs.readFile(file, 'utf8'); }
    catch (error) { if (depth === 0) throw error; warnings.push(`无法读取 Include：${file}`); return; }
    for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const parts = tokens(line.replace(/^\s*(\S+?)\s*=\s*/, '$1 '));
      const directive = parts.shift()?.toLowerCase();
      if (directive === 'host') {
        for (const name of parts) if (!/[*!?]/.test(name) && !name.startsWith('-') && !name.includes('\0')) aliases.add(name);
      } else if (directive === 'include') {
        for (let pattern of parts) {
          pattern = pattern.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '').replace(/%d/g, os.homedir()).replace(/%u/g, os.userInfo().username);
          pattern = pattern.replace(/^~(?=[/\\]|$)/, os.homedir());
          if (!path.isAbsolute(pattern)) pattern = path.join(os.homedir(), '.ssh', pattern);
          const files = await glob(pattern.replaceAll('\\', '/'), { nodir: true, dot: true });
          for (const included of files.sort()) await visit(included, depth + 1);
        }
      }
    }
  }
  try { await visit(configPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { configPath, servers: [], warnings: ['没有找到 SSH config。可以点击「选择配置」指定文件。'] };
    throw error;
  }
  const servers = [], names = [...aliases];
  // OpenSSH itself resolves wildcard defaults, Include, Match and ProxyJump.
  for (let i = 0; i < names.length; i += 6) {
    const batch = await Promise.all(names.slice(i, i + 6).map(async alias => {
      try {
        const { stdout } = await exec('ssh', ['-G', '-F', configPath, alias], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
        const options = {};
        for (const line of stdout.split(/\r?\n/)) { const at = line.indexOf(' '); if (at > 0 && options[line.slice(0, at)] === undefined) options[line.slice(0, at)] = line.slice(at + 1); }
        const connectionKey = createHash('sha256').update(JSON.stringify([options.hostname?.toLowerCase(), options.user, options.port, options.proxyjump, options.proxycommand])).digest('hex');
        return { alias, hostname: options.hostname || alias, user: options.user || '', port: Number(options.port || 22), jump: options.proxyjump === 'none' ? '' : options.proxyjump || '', connectionKey, error: null };
      } catch (error) {
        return { alias, hostname: alias, user: '', port: 22, jump: '', error: error.code === 'ENOENT' ? '未找到 OpenSSH，请安装 Windows OpenSSH 客户端。' : (error.stderr?.trim() || error.message) };
      }
    }));
    servers.push(...batch);
  }
  return { configPath, servers, warnings };
}
module.exports = { discover, tokens, defaultConfig };
