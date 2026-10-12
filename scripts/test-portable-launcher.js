const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(),'explorer-portable-'));
  const portServer = net.createServer();
  await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
  const port = portServer.address().port;
  await new Promise(resolve=>portServer.close(resolve));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const version = require('../package.json').version;
  const launcher = spawn(path.resolve(process.env.EXPLORER_BUILD_DIR || 'dist',`Server-Explorer-${version}-Windows.exe`),[`--remote-debugging-port=${port}`,'--user-data-dir='+profile],{env,windowsHide:true,stdio:'ignore'});
  const exited = new Promise((resolve,reject)=>{launcher.once('exit',resolve);launcher.once('error',reject);});
  let browser, page;
  try {
    let ready = false;
    const end = Date.now()+30000;
    while(Date.now()<end) {
      try { const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)}); if(response.ok) {ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,'portable launcher starts Electron with forwarded arguments');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages()[0];
    await page.waitForSelector('.server-card');
    const count = await page.locator('.server-card').count();
    assert.ok(count>0);
    assert.match(page.url(),/\/Temp\//i,'testing the actual extracted portable executable');
    assert.doesNotMatch(await page.locator('#config-path').textContent(),/正在读取/);
    assert.equal(await page.locator('#config-warning').isVisible(),false);
    const emptyLayout=await page.evaluate(()=>({
      panelsHeight:document.querySelector('#panels').getBoundingClientRect().height,
      illustrationTop:document.querySelector('.empty-illustration').getBoundingClientRect().top,
      containerTop:document.querySelector('#empty-workspace').getBoundingClientRect().top
    }));
    assert.equal(emptyLayout.panelsHeight,0,'packaged hidden panels occupy no space');
    assert.ok(emptyLayout.illustrationTop>=emptyLayout.containerTop,'packaged empty illustration is not cropped');
    assert.equal(await page.evaluate(()=>typeof window.explorer.cancelConnect),'function','packaged cancellation bridge exists');
    assert.equal(await page.evaluate(()=>typeof window.explorer.openLocal),'function','packaged local bridge exists');
    assert.equal(await page.evaluate(()=>typeof window.explorer.delete),'function','packaged deletion bridge exists');
    await page.locator('#open-local').click();
    await page.locator('.connected-pill').filter({hasText:'本地'}).waitFor();
    assert.ok(await page.locator('.choose-directory').isVisible(),'packaged local panel opens');
    await page.locator('#demo-button').click();
    await page.locator('#modal-actions .primary').click();
    await page.locator('.panel').first().getByRole('button',{name:'下载到本地',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>typeof window.explorer.contextMenu),'function');
    assert.equal(await page.evaluate(()=>typeof window.explorer.prepareDesktop),'function');
    console.log(`Actual portable launcher passed: ${count} server aliases loaded from temporary extraction path.`);
  } finally {
    if(page) { await page.evaluate(()=>window.close()).catch(()=>{}); }
    if(browser) await browser.close();
  }
  await exited;
  await fs.rm(profile,{recursive:true,force:true});
}
run().catch(error=>{console.error(error);process.exitCode=1;});
