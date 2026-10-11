const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { Server, utils } = require('ssh2');
const STATUS = utils.sftp.STATUS_CODE;
async function testServer(roots) {
  let allowOverwrite = true, allowCopyData = true, allowExec = true, execDelay = 0;
  const counters = {reads:0,writes:0,copies:0,execs:0};
  const {u32,str} = require('../src/backend/sftp');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength:2048, privateKeyEncoding:{ type:'pkcs1',format:'pem' }, publicKeyEncoding:{ type:'spki',format:'pem' } });
  const connections = new Set();
  const server = new Server({ hostKeys:[privateKey] }, client => {
    connections.add(client); client.on('error',() => {}); client.on('close',() => connections.delete(client)); let root;
    client.on('authentication',ctx => { if (roots[ctx.username] && ctx.method === 'password' && ctx.password === 'test-password') { root = roots[ctx.username]; ctx.accept(); } else ctx.reject(); });
    client.on('ready',() => client.on('session',accept => {
      const session = accept();
      const local = p => { const absolute = path.resolve(root, '.' + path.posix.resolve('/',p)); if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('outside fixture'); return absolute; };
      session.on('exec',(accept,reject,{command}) => {
        const stream = accept(); counters.execs++;
        (async () => {
          if (!allowExec) throw new Error('remote command disabled');
          // Parse only the app's fixed command structure, never execute a shell
          // supplied by the test. Decoding handles POSIX single-quote escapes.
          const quoted = "'(?:(?:[^'])|(?:'\"'\"'))*'";
          const pattern = new RegExp('^if \\[ "\\$\\(cat -- (' + quoted + ')\\)" = (' + quoted + ') \\]; then cp -P -- (' + quoted + ') (' + quoted + ') & copy_pid=');
          const match = command.match(pattern);
          if (!match) throw new Error('unexpected copy command: ' + command);
          const decode = text => text.slice(1,-1).replaceAll("'\"'\"'", "'");
          const [,target,token,source,destination] = match.map((text,index)=>index ? decode(text) : text);
          if (target !== destination + '.control' || await fs.readFile(local(target),'utf8') !== token) throw new Error('namespace token mismatch');
          if (execDelay) await new Promise(resolve=>setTimeout(resolve,execDelay));
          if (!await fs.stat(local(target)).catch(()=>null)) { await fs.unlink(local(destination)).catch(()=>{}); stream.exit(1); stream.end(); return; }
          await fs.copyFile(local(source),local(destination)); counters.copies++;
          stream.exit(0); stream.end();
        })().catch(error=>{ stream.stderr.write(error.message); stream.exit(1); stream.end(); });
      });
      session.on('sftp',accept => {
        const sftp = accept(), handles = new Map(); let next = 1;
        const protocol = sftp._protocol, send = protocol.channelData.bind(protocol);
        // ssh2's server sends a bare v3 VERSION. Advertise the fixture's real
        // copy-data capability to exercise negotiation over the OpenSSH client.
        protocol.channelData = (id,data) => {
          if (data.length === 9 && data[4] === 2) {
            const payload = Buffer.concat([data.subarray(4),str('copy-data'),str('1')]);
            return send(id,Buffer.concat([u32(payload.length),payload]));
          }
          return send(id,data);
        };
        const local = p => { const absolute = path.resolve(root, '.' + path.posix.resolve('/',p)); if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error('outside fixture'); return absolute; };
        const attributes = stat => ({ size:stat.size, uid:0, gid:0, mode:(stat.isDirectory() ? 0o40000 : stat.isSymbolicLink() ? 0o120000 : 0o100000) | (stat.mode & 0o777), atime:Math.floor(stat.atimeMs/1000),mtime:Math.floor(stat.mtimeMs/1000) });
        const failure = (id,error) => sftp.status(id, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : error.code === 'EACCES' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE,error.message);
        const handle = value => { const b = Buffer.alloc(4); b.writeUInt32BE(next++); handles.set(b.toString('hex'),value); return b; };
        const wrap = fn => (id,...args) => Promise.resolve().then(() => fn(id,...args)).catch(error => failure(id,error));
        sftp.on('REALPATH',wrap(async(id,p) => { await fs.stat(local(p)); const canonical = await fs.realpath(local(p)); const remote = '/' + path.relative(root,canonical).split(path.sep).join('/'); sftp.name(id,[{filename:remote,longname:remote,attrs:{}}]); }));
        for (const op of ['STAT','LSTAT']) sftp.on(op,wrap(async(id,p) => sftp.attrs(id,attributes(await fs[op === 'STAT' ? 'stat' : 'lstat'](local(p))))));
        sftp.on('OPENDIR',wrap(async(id,p) => { const entries = await fs.readdir(local(p)); sftp.handle(id,handle({ kind:'dir',path:p,entries,done:false })); }));
        sftp.on('READDIR',wrap(async(id,h) => { const dir = handles.get(h.toString('hex')); if (dir.done) { sftp.status(id,STATUS.EOF); return; } dir.done = true; const entries = await Promise.all(dir.entries.map(async name => ({filename:name,longname:name,attrs:attributes(await fs.lstat(local(path.posix.join(dir.path,name))))}))); if (!entries.length) sftp.status(id,STATUS.EOF); else sftp.name(id,entries); }));
        sftp.on('OPEN',wrap(async(id,p,flags) => { const mode = flags & 2 ? (flags & 32 ? 'wx' : 'w') : 'r'; const file = await fs.open(local(p),mode); sftp.handle(id,handle({kind:'file',file})); }));
        sftp.on('READ',wrap(async(id,h,offset,length) => { counters.reads++; const data = Buffer.alloc(length), file = handles.get(h.toString('hex')).file; const {bytesRead} = await file.read(data,0,length,offset); if (!bytesRead) sftp.status(id,STATUS.EOF); else sftp.data(id,data.subarray(0,bytesRead)); }));
        sftp.on('WRITE',wrap(async(id,h,offset,data) => { counters.writes++; await handles.get(h.toString('hex')).file.write(data,0,data.length,offset); sftp.status(id,STATUS.OK); }));
        sftp.on('CLOSE',wrap(async(id,h) => { const key = h.toString('hex'), item = handles.get(key); if (item?.file) await item.file.close(); handles.delete(key); sftp.status(id,STATUS.OK); }));
        sftp.on('SETSTAT',wrap(async(id,p,attrs) => { if (attrs.mode !== undefined) await fs.chmod(local(p),attrs.mode); sftp.status(id,STATUS.OK); }));
        sftp.on('MKDIR',wrap(async(id,p) => { await fs.mkdir(local(p)); sftp.status(id,STATUS.OK); }));
        sftp.on('RMDIR',wrap(async(id,p) => { await fs.rmdir(local(p)); sftp.status(id,STATUS.OK); }));
        sftp.on('REMOVE',wrap(async(id,p) => { await fs.unlink(local(p)); sftp.status(id,STATUS.OK); }));
        sftp.on('RENAME',wrap(async(id,from,to) => { try { await fs.lstat(local(to)); throw new Error('target exists'); } catch(e) { if (e.code !== 'ENOENT') throw e; } await fs.rename(local(from),local(to)); sftp.status(id,STATUS.OK); }));
        sftp.on('READLINK',wrap(async(id,p) => { const value = await fs.readlink(local(p)); sftp.name(id,[{filename:value,longname:value,attrs:{}}]); }));
        sftp.on('SYMLINK',wrap(async(id,target,p) => { await fs.symlink(target,local(p)); sftp.status(id,STATUS.OK); }));
        sftp.on('EXTENDED',wrap(async(id,name,data) => {
          let offset = 0;
          const bytes = () => { const len=data.readUInt32BE(offset); offset+=4; const value=data.subarray(offset,offset+len); offset+=len; return value; };
          const uint64 = () => { const value=Number(data.readBigUInt64BE(offset)); offset+=8; return value; };
          if (name === 'copy-data' && allowCopyData) {
            const source=handles.get(bytes().toString('hex')).file, sourceOffset=uint64(), length=uint64();
            const target=handles.get(bytes().toString('hex')).file, targetOffset=uint64();
            const buffer=Buffer.alloc(length); const {bytesRead}=await source.read(buffer,0,length,sourceOffset);
            if (bytesRead !== length) throw new Error('source truncated');
            await target.write(buffer,0,bytesRead,targetOffset); counters.copies++; sftp.status(id,STATUS.OK); return;
          }
          if (name === 'posix-rename@openssh.com' && allowOverwrite) { await fs.rename(local(bytes().toString()),local(bytes().toString())); sftp.status(id,STATUS.OK); return; }
          sftp.status(id,STATUS.OP_UNSUPPORTED);
        }));
        sftp.on('end',() => { for (const h of handles.values()) h.file?.close().catch(() => {}); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  return { port:server.address().port, counters, allowCopyData:value => {allowCopyData=value;}, allowExec:value => {allowExec=value;}, execDelay:value => {execDelay=value;}, allowOverwrite:value => { allowOverwrite = value; }, close:async() => { for (const c of connections) c.end(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { testServer };
