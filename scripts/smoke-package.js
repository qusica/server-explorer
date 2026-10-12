const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const asar = require('@electron/asar');
async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'explorer-package-'));
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath:path.resolve(process.env.EXPLORER_BUILD_DIR || 'dist','win-unpacked','Server Explorer.exe'), args:['--user-data-dir='+profile],env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.server-card');
    assert.ok(await app.evaluate(({app}) => app.isPackaged));
    await page.locator('#demo-button').click();
    await page.waitForSelector('.panel:nth-child(3) .file-row');
    assert.equal(await page.locator('.panel').count(),3);
    const panel = page.locator('.panel').first();
    const download = panel.getByRole('button',{name:'下载到本地',exact:true});
    assert.ok(await download.isVisible(),'packaged download icon is accessible');
    assert.ok(await download.isDisabled(),'download requires a selection');
    assert.equal(await panel.locator('.panel-file-tools .download-selected').count(),1,'download belongs to compact toolbar');
    assert.equal(await panel.locator('.panel-transfer-tools,.delete-selected').count(),0,'old transfer toolbar and delete button are removed');
    await panel.locator('.file-row[data-name="deploy.sh"]').click();
    assert.ok(await download.isEnabled(),'selecting a file enables download');
    assert.equal(await page.evaluate(()=>typeof window.explorer.contextMenu),'function');
    assert.equal(await page.evaluate(()=>typeof window.explorer.startDrag),'function');
    const packaged = await app.evaluate(({app}) => ({resourcesPath:process.resourcesPath,appPath:app.getAppPath()}));
    assert.ok(fs.existsSync(path.join(packaged.resourcesPath,'askpass.exe')),'packaged native SSH authentication helper exists');
    assert.ok(asar.statFile(packaged.appPath,'resources/app.png').size > 0,'packaged application icon exists');
    console.log('Packaged desktop app passed: startup, SSH config list, three-panel workspace, and packaged authentication helper.');
  } finally { await app.close(); fs.rmSync(profile,{recursive:true,force:true}); }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
