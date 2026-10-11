const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'explorer-portable-'));
  await fs.cp(path.resolve('dist/win-unpacked'),directory,{recursive:true});
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({executablePath:path.join(directory,'Server Explorer.exe'),args:[],env});
    const page = await app.firstWindow();
    page.on('pageerror',error=>console.log('renderer-error',error.message));
    const loaded = await page.evaluate(async()=>{
      try { const result=await window.explorer.loadConfig(); return {count:result.servers.length}; }
      catch(error) { return {error:error.message,bridge:typeof window.explorer}; }
    });
    assert.equal(loaded.error,undefined,loaded.error);
    assert.ok(loaded.count>0,'portable temp-path application lists configured servers');
    await page.waitForSelector('.server-card');
    assert.doesNotMatch(await page.locator('#config-path').textContent(),/正在读取/);
    console.log(`Portable temporary-path regression passed: ${loaded.count} servers loaded.`);
  } finally { if(app) await app.close(); await fs.rm(directory,{recursive:true,force:true}); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
