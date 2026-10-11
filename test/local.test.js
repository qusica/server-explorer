const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalFiles, localName, localPath } = require('../src/backend/local');
const { deleteEntries, renameEntry } = require('../src/backend/files');
test('local deletion validates names, removes nested folders, and preserves junction targets',async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'explorer-local-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const endpoint = new LocalFiles();
  const directory = path.join(root,'selected'), outside = path.join(root,'outside');
  await fs.mkdir(path.join(directory,'nested'),{recursive:true}); await fs.mkdir(outside);
  await fs.writeFile(path.join(directory,'nested','中文.txt'),'inside'); await fs.writeFile(path.join(outside,'keep.txt'),'keep');
  await fs.symlink(outside,path.join(directory,'linked'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await endpoint.stat(path.join(directory,'linked'))).type,'symlink');
  await assert.rejects(deleteEntries(endpoint,directory,['..']),/无效/);
  await assert.rejects(deleteEntries(endpoint,directory,['nested/中文.txt']),/无效/);
  await assert.rejects(deleteEntries(endpoint,directory,['nested','missing']),/ENOENT/);
  assert.equal(await fs.readFile(path.join(directory,'nested','中文.txt'),'utf8'),'inside','failed scanning does not remove earlier selections');
  assert.equal(await deleteEntries(endpoint,directory,['nested','nested','linked']),3);
  assert.deepEqual(await fs.readdir(directory),[]); assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
  for (const name of ['','..','../file','a\\b','a\0b']) assert.throws(()=>localName(name));
  assert.throws(()=>localPath('relative/path'));
  if (process.platform === 'win32') for (const name of ['a:b','NUL.txt','trailing.','trailing ']) assert.throws(()=>localName(name));
});
test('deletion rejects a changed parent before removing any file',async () => {
  let calls = 0, removed = 0;
  const endpoint = {
    realpath:async p => p === '/root/dir' && ++calls > 2 ? '/outside' : p,
    stat:async p => ({type:p.endsWith('/file') ? 'file' : 'directory'}),
    list:async p => p === '/root/dir' ? [{name:'file'}] : [],
    remove:async()=>{removed++;}, rmdir:async()=>{removed++;}
  };
  await assert.rejects(deleteEntries(endpoint,'/root',['dir']),/父目录.*变化/);
  assert.equal(removed,0);
});

test('rename preserves contents, refuses collisions and validates names',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'explorer-rename-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const endpoint=new LocalFiles();
  await fs.writeFile(path.join(root,'old.txt'),'source'); await fs.writeFile(path.join(root,'keep.txt'),'target');
  await assert.rejects(renameEntry(endpoint,root,'old.txt','keep.txt'),/同名/);
  assert.equal(await fs.readFile(path.join(root,'old.txt'),'utf8'),'source'); assert.equal(await fs.readFile(path.join(root,'keep.txt'),'utf8'),'target');
  await assert.rejects(renameEntry(endpoint,root,'old.txt','../outside'),/无效/);
  await renameEntry(endpoint,root,'old.txt','新名称.txt'); assert.equal(await fs.readFile(path.join(root,'新名称.txt'),'utf8'),'source');
  await fs.mkdir(path.join(root,'folder')); await fs.writeFile(path.join(root,'folder','child.txt'),'child');
  await renameEntry(endpoint,root,'folder','renamed'); assert.equal(await fs.readFile(path.join(root,'renamed','child.txt'),'utf8'),'child');
  if (process.platform === 'win32') { await renameEntry(endpoint,root,'keep.txt','KEEP.txt'); assert.ok((await fs.readdir(root)).includes('KEEP.txt')); }
});
