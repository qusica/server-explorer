const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { testServer } = require('../test/helpers');
async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'explorer-cancel-'));
  const sockets = new Set();
  const server = net.createServer(socket=>{ sockets.add(socket); socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(socket)); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const configPath = path.join(directory,'config');
  await fs.writeFile(configPath,`Host cancel-one cancel-two\n HostName 127.0.0.1\n User tester\n Port ${server.address().port}\n`);
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  let app, preferencesPath, previousPreferences, authServer;
  try {
    app = await electron.launch({args:[path.resolve(__dirname,'..')],env});
    const page = await app.firstWindow();
    await page.waitForSelector('.server-card');
    preferencesPath = await app.evaluate(({app})=>app.getPath('userData')+'\\preferences.json');
    try { previousPreferences=await fs.readFile(preferencesPath); } catch(error) { if(error.code!=='ENOENT') throw error; }
    await app.evaluate(({dialog},configPath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[configPath]});},configPath);
    await page.locator('#choose-config').click();
    await page.locator('.server-card[data-alias="cancel-one"]').waitFor();
    await page.locator('.server-card[data-alias="cancel-one"]').click();
    await page.locator('.server-card[data-alias="cancel-two"]').click();
    await page.waitForSelector('.panel:nth-child(2) .spinner');
    await page.waitForFunction(()=>document.querySelectorAll('.panel').length===2);
    const first = page.locator('.panel').first();
    assert.equal(await first.locator('.close-panel').isEnabled(),true,'can click close while connecting');
    await first.locator('.close-panel').click();
    await page.locator('#modal').waitFor({state:'visible'});
    assert.match(await page.locator('#modal-title').innerText(),/强制关闭/);
    await page.locator('#modal-actions .button').first().click();
    assert.equal(await page.locator('.panel').count(),2,'continue waiting leaves both attempts open');
    await first.locator('.close-panel').click();
    const started = Date.now();
    await page.locator('#modal-actions .primary').click();
    await page.waitForFunction(()=>document.querySelectorAll('.panel').length===1,{},{timeout:3000});
    assert.ok(Date.now()-started<3000,'does not wait for SSH connection timeout');
    assert.equal(await page.locator('.panel-heading strong').innerText(),'cancel-two','other connection stays open');
    assert.equal(await page.locator('.connected-pill').innerText(),'连接中');
    await page.locator('.close-panel').click();
    await page.locator('#modal-actions .primary').click();
    await page.waitForFunction(()=>document.querySelectorAll('.panel').length===0,{},{timeout:3000});
    const deadline=Date.now()+3000;
    while(sockets.size && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(sockets.size,0,'underlying SSH sockets close too');
    await page.locator('.server-card[data-alias="cancel-one"]').click();
    await page.locator('.panel .spinner').waitFor();
    await page.locator('.close-panel').click();
    await page.locator('#modal-actions .primary').click();
    await page.waitForFunction(()=>document.querySelectorAll('.panel').length===0,{},{timeout:3000});
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.panel').count(),0,'cancelled attempt cannot resurrect a removed panel');
    assert.equal(await page.locator('#modal').isVisible(),false,'no orphaned modal');
    // Exercise the real native askpass bridge, not a mocked prompt event.
    const authRoot=path.join(directory,'server'); await fs.mkdir(authRoot);
    authServer=await testServer({tester:authRoot});
    await fs.writeFile(configPath,`Host cancel-auth\n HostName 127.0.0.1\n User tester\n Port ${authServer.port}\n PreferredAuthentications password\n UserKnownHostsFile "${path.join(directory,'known_hosts').replaceAll('\\','/')}"\n`);
    await page.locator('#refresh-config').click();
    await page.locator('.server-card[data-alias="cancel-auth"]').waitFor();
    await page.locator('.server-card[data-alias="cancel-auth"]').click();
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==='确认服务器身份');
    await page.locator('#modal-actions .primary').click();
    await page.waitForFunction(()=>document.querySelector('#modal-title').textContent==='SSH 身份验证');
    await page.evaluate(()=>window.explorer.cancelConnect({requestId:panels[0].connectRequestId}));
    await page.waitForFunction(()=>!document.querySelector('#modal').open,{},{timeout:3000});
    await page.waitForSelector('.connected-pill.error');
    await page.locator('.close-panel').click();
    await page.waitForFunction(()=>document.querySelectorAll('.panel').length===0);
    assert.equal(await page.locator('#modal').isVisible(),false,'native authentication prompt closes with its attempt');
    console.log('Connection cancellation passed: close enabled while connecting, confirmation, keep waiting, force cancel within 3s, other attempt survives, SSH sockets close, and retry works.');
  } finally {
    if(app) await app.close();
    if(authServer) await authServer.close();
    if(preferencesPath) { if(previousPreferences) await fs.writeFile(preferencesPath,previousPreferences); else await fs.rm(preferencesPath,{force:true}); }
    for(const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
