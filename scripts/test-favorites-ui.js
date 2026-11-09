const {_electron:electron}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');const path=require('node:path');
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'favorites-ui-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[path.resolve(__dirname,'..'),'--user-data-dir='+profile],env});
 try {
 const page=await app.firstWindow();await page.locator('#demo-button').click();
 const first=page.locator('.panel').first(),second=page.locator('.panel').nth(1);
 await first.locator('.toggle-favorite').click();
 assert.equal(await first.locator('.toggle-favorite').getAttribute('aria-pressed'),'true');
 assert.equal(await second.locator('.favorite-path option').count(),1);
 await first.locator('.go-parent').click();await first.locator('.favorite-path').selectOption('/home/deploy');
 await page.waitForFunction(()=>document.querySelector('.panel .path-input').value==='/home/deploy');
 await first.locator('.remove-favorite').click();await page.locator('#modal-actions .primary').click();
 assert.equal(await first.locator('.favorite-path option').count(),1);
 console.log('Favorite UI: add, isolated lists, navigate, remove passed');
 }finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
