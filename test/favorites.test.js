const test = require('node:test');
const assert = require('node:assert/strict');
const {readFavorites,updateFavorite} = require('../src/backend/favorites');
function fixture() {
 const files = new Map(), dirs = new Set(['/home/test']);
 const sftp = {
 extensions:new Map([['posix-rename@openssh.com','1']]),
 realpath:async()=>'/home/test',
 exists:async p=>dirs.has(p)?{type:'directory'}:files.has(p)?{type:'file',size:files.get(p).length}:null,
 mkdir:async p=>dirs.add(p),
 open:async(p,flags)=>{if(flags & 8)files.set(p,Buffer.alloc(0));return p;},
 closeHandle:async()=>{},
 read:async(p,offset,size)=>files.get(p).subarray(offset,offset+size),
 write:async(p,offset,data)=>{const old=files.get(p);files.set(p,Buffer.concat([old.subarray(0,offset),data]));},
 posixRename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);},
 remove:async p=>files.delete(p)
 };
 return {sftp,files,dirs};
}
test('remote favorites persist across sessions, remain isolated, and merge sequential edits',async()=>{
 const a=fixture(),b=fixture();
 assert.deepEqual(await readFavorites(a),[]);
 await updateFavorite(a,'/var/log',false);
 await Promise.all([updateFavorite(a,'/srv/app',false),updateFavorite(a,'/var/log',false)]);
 assert.deepEqual(await readFavorites({sftp:a.sftp}),['/var/log','/srv/app']);
 assert.deepEqual(await readFavorites(b),[]);
 await updateFavorite(a,'/var/log',true);
 assert.deepEqual(await readFavorites(a),['/srv/app']);
 assert.equal(a.files.size,1);
});
test('invalid remote configuration and write failures preserve existing data',async()=>{
 const a=fixture(); await updateFavorite(a,'/safe',false);
 const file='/home/test/.server-explorer/favorites.json', before=a.files.get(file);
 a.sftp.posixRename=async()=>{throw new Error('denied');};
 await assert.rejects(updateFavorite(a,'/new',false),/denied/);
 assert.deepEqual(a.files.get(file),before); assert.equal(a.files.size,1);
 a.files.set(file,Buffer.from('{broken'));
 await assert.rejects(updateFavorite(a,'/new',false));
 assert.equal(a.files.get(file).toString(),'{broken');
 await assert.rejects(updateFavorite(a,'relative',false));
});
