const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const asar = require('@electron/asar');
async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'explorer-package-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath:path.resolve('dist','win-unpacked','Server Explorer.exe'), args:['--user-data-dir='+profile],env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.server-card');
    assert.ok(await app.evaluate(({app}) => app.isPackaged));
    await page.locator('#demo-button').click();
    await page.waitForSelector('.panel:nth-child(3) .file-row');
    assert.equal(await page.locator('.panel').count(),3);
    assert.equal(await page.locator('.download-selected').first().innerText(),'下载到本地');
    assert.equal(await page.evaluate(()=>typeof window.explorer.contextMenu),'function');
    assert.equal(await page.evaluate(()=>typeof window.explorer.startDrag),'function');
    const packaged = await app.evaluate(({app}) => ({resourcesPath:process.resourcesPath,appPath:app.getAppPath()}));
    assert.ok(fs.existsSync(path.join(packaged.resourcesPath,'askpass.exe')),'packaged native SSH authentication helper exists');
    assert.ok(asar.statFile(packaged.appPath,'resources/app.png').size > 0,'packaged application icon exists');
    console.log('Packaged desktop app passed: startup, SSH config list, three-panel workspace, and packaged authentication helper.');
  } finally { await app.close(); fs.rmSync(profile,{recursive:true,force:true}); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
