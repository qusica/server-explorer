const { _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

async function run() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-screenshot-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: [path.resolve(__dirname, '..'), '--user-data-dir=' + profile], env });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1480, 900));
    await page.waitForFunction(() => !configLoading);
    await page.locator('#demo-button').click();
    await page.waitForSelector('.panel:nth-child(3) .file-row');
    await page.locator('.panel').first().locator('.file-row[data-name="deploy.sh"]').click();
    await page.evaluate(() => {
      config.configPath = '内置演示配置';
      renderSidebar();
      document.querySelectorAll('.file-list').forEach(list => { list.scrollTop = 0; });
      return document.fonts.ready;
    });
    await page.mouse.move(1470, 890);
    await page.screenshot({ path: path.resolve(__dirname, '../docs/images/workspace.png'), animations: 'disabled' });
    console.log('Updated docs/images/workspace.png (1480 × 900, built-in demo mode).');
  } finally {
    if (app) await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

