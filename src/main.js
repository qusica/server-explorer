const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { isTrustedPage } = require('./backend/trusted-page');
const { discover, defaultConfig } = require('./backend/config');
const { Sftp } = require('./backend/sftp');
const { Transfers, safeName } = require('./backend/transfers');
const { localSession, localPath } = require('./backend/local');
const { DesktopFiles } = require('./backend/desktop-files');
const { fileMenu } = require('./backend/file-menu');
const { deleteEntries, renameEntry } = require('./backend/files');
const local = localSession(), deleting = new Set(), renaming = new Set();
const { createAskpass } = require('./backend/askpass');
let window, bridge, transfers, desktopFiles, configPath = defaultConfig(), config = null, preferencesFile;
const sessions = new Map(), attempts = new Map(), prompts = new Map();
const send = (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send(channel, value); };
function ask(data, signal) {
  if (signal?.aborted) return Promise.resolve(null);
  if (data.requestId && !attempts.has(data.requestId)) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = randomUUID();
    const finish = value => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); prompts.delete(id); send('prompt:closed', id); resolve(value); };
    const aborted = () => finish(null);
    const timer = setTimeout(aborted, 180000);
    prompts.set(id, { finish, kind: data.kind, canReplace: data.canReplace, requestId: data.requestId });
    signal?.addEventListener('abort', aborted, { once: true });
    send('prompt:show', { ...data, id });
  });
}
function getSession(id) { if (renaming.has(id)) throw new Error('此位置正在重命名，请等待完成'); if (deleting.has(id)) throw new Error('此位置正在删除文件，请等待完成'); const session = id === 'local' ? local : sessions.get(id); if (!session || session.sftp.closed) throw new Error('服务器尚未连接，请重新打开'); return session; }
function remotePath(p) { if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.length > 32768) throw new Error('远程路径无效'); return p; }
function endpointPath(id, p) { return id === 'local' ? localPath(p) : remotePath(p); }
function register(channel, action) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !isTrustedPage(event.senderFrame.url, path.join(__dirname, 'renderer', 'index.html'))) throw new Error('请求来源无效');
      return { ok: true, value: await action(payload) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
}
function setupIpc() {
  register('config:load', async () => { config = await discover(configPath); return config; });
  register('config:choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择 SSH config', defaultPath: configPath, properties: ['openFile'] });
    if (result.canceled) return null;
    configPath = result.filePaths[0]; config = await discover(configPath);
    await fs.writeFile(preferencesFile, JSON.stringify({ configPath })); return config;
  });
  register('server:connect', async ({ alias, requestId }) => {
    const entry = config?.servers.find(s => s.alias === alias);
    if (!entry) throw new Error('此服务器不在当前 SSH 配置中，请刷新配置');
    if (entry.error) throw new Error(entry.error);
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId) || attempts.has(requestId)) throw new Error('连接请求无效');
    const id = randomUUID(); const sftp = Sftp.connect(alias, configPath, { ...bridge.env, SERVER_EXPLORER_REQUEST: requestId });
    const session = { id, alias, sftp, identity: entry.connectionKey, requestId };
    sessions.set(id, session);
    attempts.set(requestId, session);
    sftp.on('disconnect', error => {
      sessions.delete(id); attempts.delete(requestId);
      for (const prompt of prompts.values()) if (prompt.requestId === requestId) prompt.finish(null);
      send('server:closed', { id, error });
    });
    try { await sftp.ready; const home = await sftp.realpath('.'); return { id, alias, home, ...entry }; }
    catch (error) { sftp.close(); sessions.delete(id); throw error; }
  });
  register('server:cancelConnect', async ({ requestId }) => {
    const session = attempts.get(requestId);
    if (!session) return;
    if (transfers.usesSession(session.id)) throw new Error('此服务器有未完成的传输，请先取消或等待完成');
    session.sftp.close({ force: true });
  });
  register('server:disconnect', async ({ id }) => { if (deleting.has(id) || renaming.has(id)) throw new Error('正在进行文件操作，请等待完成'); if (transfers.usesSession(id)) throw new Error('此服务器有未完成的传输，请先取消或等待完成'); sessions.get(id)?.sftp.close(); });
  register('server:list', async ({ id, path: p }) => { const sftp = getSession(id).sftp; const canonical = await sftp.realpath(endpointPath(id, p)); return { path: canonical, entries: await sftp.list(canonical) }; });
  register('server:mkdir', async ({ id, path: p, name }) => { const sftp = getSession(id).sftp; await sftp.mkdir((sftp.path || path.posix).join(endpointPath(id,p), (sftp.safeName || safeName)(name))); });
  register('local:open', async () => ({ id:local.id, alias:local.alias, home:local.home, local:true }));
  register('local:choose', async ({ directory = false, multiple = false, purpose } = {}) => {
    const downloading = directory && purpose === 'download';
    const result = await dialog.showOpenDialog(window, { ...(downloading ? {defaultPath:app.getPath('downloads'),buttonLabel:'下载到此文件夹'} : {}), title:downloading ? '选择下载保存目录' : directory ? '选择本地文件夹' : '选择要上传的本地文件或文件夹', properties:[directory ? 'openDirectory' : 'openFile', ...(multiple || !directory ? ['multiSelections'] : [])] });
    return result.canceled ? null : result.filePaths.map(p => p.replaceAll('\\','/'));
  });
  register('files:rename', async ({id,path:p,name,newName}) => {
    const session = getSession(id); endpointPath(id,p);
    if (transfers.usesSession(id)) throw new Error('此位置有未完成的传输，请先取消或等待完成');
    renaming.add(id);
    try { await renameEntry(session.sftp,p,name,newName); } finally { renaming.delete(id); }
  });
  register('files:prepareDesktop', payload => desktopFiles.prepare(payload));
  register('files:startDrag', async ({paths}) => {
    const files = await desktopFiles.paths(paths);
    window.webContents.startDrag({file:files[0],files,icon:path.join(__dirname,'..','resources','app.png')});
  });
  register('files:menu', ({id,contextKey,count,local:isLocal,targets=[],demo:demoMode=false}) => {
    if (typeof contextKey !== 'string' || !/^[a-f0-9-]{36}$/i.test(contextKey) || !Number.isInteger(count) || count < 0 || count > 1000 || !Array.isArray(targets) || targets.length > 100) throw new Error('菜单请求无效');
    if (!demoMode) { getSession(id); isLocal=id === 'local'; }
    const available = targets.filter(target => typeof target.key === 'string' && typeof target.alias === 'string' && target.alias.length < 256 && (demoMode || target.id === 'local' || (sessions.has(target.id) && !sessions.get(target.id).sftp.closed)));
    const menu = Menu.buildFromTemplate(fileMenu({local:isLocal,count,targets:available,demo:demoMode},(action,targetKey)=>send('files:menuAction',{contextKey,action,targetKey})));
    menu.popup({window});
  });
  register('files:delete', async ({ id, path:p, names }) => {
    const session = getSession(id), endpoint = session.sftp;
    endpointPath(id,p);
    if (!Array.isArray(names) || !names.length || names.length > 1000) throw new Error('请选择要删除的项目');
    names = [...new Set(names.map(endpoint.safeName || safeName))];
    if (transfers.usesSession(id)) throw new Error('此位置有未完成的传输，请先取消或等待完成');
    deleting.add(id);
    try {
      const canonical = await endpoint.realpath(p);
      const answer = await ask({ kind:'delete', title:'永久删除所选项目？', message:`将从 ${session.alias} 删除 ${names.length} 个项目。文件夹及其内容也会删除，无法撤销。`, detail:`目录：${canonical}\n${names.slice(0,20).join('\n')}${names.length > 20 ? '\n…' : ''}`, icon:'trash' });
      if (answer !== 'delete') return null;
      return await deleteEntries(endpoint,canonical,names);
    } finally { deleting.delete(id); }
  });
  register('transfer:inspect', payload => transfers.inspect(payload));
  register('transfer:start', payload => transfers.start(payload));
  register('transfer:cancel', ({ id }) => transfers.cancel(id));
  register('prompt:answer', ({ id, value }) => {
    const prompt = prompts.get(id); if (!prompt) return;
    if (value !== null && (typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value))) throw new Error('回答格式无效');
    if (prompt.kind === 'trust' && ![null, 'yes', 'no'].includes(value)) throw new Error('请确认或取消主机身份');
    if (prompt.kind === 'delete' && ![null,'delete'].includes(value)) throw new Error('请确认或取消删除');
    if (prompt.kind === 'conflict' && ![null,'cancel','skip','skip-all',...(prompt.canReplace ? ['replace','replace-all'] : [])].includes(value)) throw new Error('操作无效');
    if (prompt.requestId && ((prompt.kind === 'trust' && value !== 'yes') || (prompt.kind === 'secret' && value === null))) {
      const session = attempts.get(prompt.requestId);
      attempts.delete(prompt.requestId);
      session?.sftp.close({ force: true });
      for (const pending of [...prompts.values()]) if (pending.requestId === prompt.requestId) pending.finish(null);
    } else prompt.finish(value);
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1480, height: 940, minWidth: 1000, minHeight: 680, icon: path.join(__dirname, '..', 'resources', 'app.png'), backgroundColor: '#f6f8fa', title: 'Server Explorer', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  window.on('close', event => {
    if (deleting.size || renaming.size) { event.preventDefault(); return; }
    if ([...transfers.jobs.values()].some(j => ['queued','scanning','running','waiting'].includes(j.status))) {
      const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '退出应用', message: '有文件正在传输，退出会取消尚未完成的任务。', buttons: ['继续传输', '取消传输并退出'], defaultId: 0, cancelId: 0 });
      if (choice === 0) { event.preventDefault(); return; }
    }
    for (const job of transfers.jobs.values()) transfers.cancel(job.id);
    for (const prompt of prompts.values()) prompt.finish(null);
    for (const session of sessions.values()) session.sftp.close({ force: true });
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    preferencesFile = path.join(app.getPath('userData'), 'preferences.json');
    try { const preferences = JSON.parse(await fs.readFile(preferencesFile, 'utf8')); if (typeof preferences.configPath === 'string') configPath = preferences.configPath; } catch {}
    const executable = app.isPackaged ? path.join(process.resourcesPath, 'askpass.exe') : path.join(__dirname, '..', 'resources', 'askpass.exe');
    bridge = await createAskpass(executable, ask);
    transfers = new Transfers({ getSession, ask, emit: job => send('transfer:update', job) });
    desktopFiles = new DesktopFiles({directory:path.join(app.getPath('userData'),'desktop-files'),local:local.sftp,transfers,getSession});
    await desktopFiles.cleanup().catch(()=>{});
    setupIpc(); await createWindow();
  }).catch(error => { dialog.showErrorBox('Server Explorer 启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => { bridge?.close(); app.quit(); });
}
