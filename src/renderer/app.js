const $ = selector => document.querySelector(selector);
const icons = {
  computer:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  code:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6m-10 4-3 3 3 3m4-6 3 3-3 3"/>',
  archive:'<rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v13h14V7M10 11h4M12 7v13"/>',
  link:'<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  shield:'<path d="M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6l-9-3Z"/><path d="m8 12 3 3 5-6"/>',
  move:'<path d="M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3"/>',
  transfer:'<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-up':'<path d="M12 20V4m-6 6 6-6 6 6"/>',
  'chevron-down':'<path d="m6 9 6 6 6-6"/>',
  home:'<path d="m3 10 9-7 9 7v10H3V10Z"/><path d="M9 20v-7h6v7"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  plus:'<path d="M12 4v16M4 12h16"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const join = (dir, name) => `${dir.replace(/\/$/,'')}/${name}`;
const parent = p => { const clean = p.replace(/\\/g,'/').replace(/\/$/,''); if (/^[a-z]:$/i.test(clean)) return clean + '/'; if (/^\/\/[^/]+\/[^/]+$/.test(clean)) return clean; const result = clean.slice(0,clean.lastIndexOf('/')) || '/'; return /^[a-z]:$/i.test(result) ? result + '/' : result; };
const validPath = (p, value) => p.local ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value) : value.startsWith('/');
function bytes(n) { if (!n) return '0 B'; const units = ['B','KB','MB','GB','TB']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4); return `${(n / 1024 ** i).toFixed(i && n / 1024 ** i < 10 ? 1 : 0)} ${units[i]}`; }
const date = timestamp => timestamp ? new Date(timestamp * 1000).toLocaleDateString('zh-CN', { month:'2-digit', day:'2-digit' }) : '—';
let config = { servers: [], warnings: [], configPath: '' }, configLoading = true, configError = '', panels = [], demo = false, jobs = new Map(), toastTimer;
const api = window.explorer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function syncWorkspace() {
  $('#empty-workspace').hidden = panels.length > 0;
  $('#panels').hidden = panels.length === 0;
  $('#panel-count').textContent = panels.length ? `${panels.length} 个面板` : '';
  const count = panels.filter(p => p.status === 'ready' && !p.local).length;
  $('#connection-summary').textContent = demo ? '演示模式 · 文件操作仅模拟' : count ? `${count} 台服务器已连接` : '还没有打开的连接';
  $('#open-local').classList.toggle('open',panels.some(p => p.local));
  renderSidebar();
}
function renderSidebar() {
  const servers = demo ? demoServers : config.servers;
  $('#server-count').textContent = servers.length;
  $('#config-path').textContent = config.configPath || (configError ? '配置读取失败 · 点击刷新重试' : configLoading ? '正在读取配置…' : '尚未选择配置文件');
  $('#config-path').title = configError || config.configPath;
  const search = $('#server-search').value.trim().toLowerCase();
  const filtered = servers.filter(s => `${s.alias} ${s.hostname} ${s.user}`.toLowerCase().includes(search));
  $('#server-list').innerHTML = filtered.length ? filtered.map(s => `<button class="server-card ${panels.some(p => p.alias === s.alias) ? 'open' : ''} ${s.error ? 'invalid' : ''}" data-alias="${esc(s.alias)}" title="${esc(s.error || `${s.user}@${s.hostname}:${s.port}`)}"><span class="server-symbol">${icon('server')}</span><span class="server-info"><span class="server-name">${esc(s.alias)}</span><span class="server-address">${esc(s.hostname)}</span><span class="server-detail">${esc(s.user || '默认用户')} · :${s.port}${s.jump ? ' · 跳板机' : ''}</span></span><span class="status-dot"></span></button>`).join('') : `<div class="sidebar-empty">${search ? '没有匹配的服务器' : '还没有服务器<br>请检查 SSH config 或选择配置文件'}</div>`;
  $('#server-list').querySelectorAll('.server-card').forEach(button => button.onclick = () => openServer(button.dataset.alias));
  $('#config-warning').hidden = demo || !(configError || config.warnings?.length);
  $('#config-warning').textContent = configError ? `读取 SSH 配置失败：${configError}。可点击左侧刷新按钮重试。` : (config.warnings || []).join('\n');
}
async function loadConfig(choose = false) {
  const button = $(choose ? '#choose-config' : '#refresh-config'); button.disabled = true;
  configLoading = true; configError = ''; renderSidebar();
  try { const value = await (choose ? api.chooseConfig() : api.loadConfig()); if (value) { config = value; renderSidebar(); } }
  catch (error) { configError = error.message; toast(error.message); }
  finally { configLoading = false; button.disabled = false; renderSidebar(); }
}
async function openServer(alias, local = false) {
  const found = panels.find(p => p.alias === alias && !!p.local === local);
  if (found) { found.element.scrollIntoView({ behavior: 'smooth', block:'nearest', inline:'center' }); if (found.status === 'error') await connectPanel(found); return; }
  const p = { key: crypto.randomUUID(), alias, local, id: null, path: '/', home: '/', entries: [], selected: new Set(), filter: '', status: 'connecting', error: '', loadVersion: 0, anchor: -1 };
  const element = document.createElement('section'); element.className = 'panel'; p.element = element;
  panels.push(p); $('#panels').appendChild(element); syncWorkspace(); renderPanel(p);
  await connectPanel(p); if (panels.includes(p)) element.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'end' });
}
async function connectPanel(p) {
  const requestId = crypto.randomUUID(); p.connectRequestId = requestId; p.closing = false; p.id = null;
  p.status = 'connecting'; p.error = ''; renderPanel(p);
  try {
    const session = demo ? { id:`demo-${p.alias}`, alias:p.alias, home:'/home/deploy', ...demoServers.find(s => s.alias === p.alias) } : p.local ? await api.openLocal() : await api.connect({ alias:p.alias, requestId });
    if (!panels.includes(p) || p.closing || p.connectRequestId !== requestId) return;
    Object.assign(p, session); p.path = p.home; p.status = 'ready'; await loadDirectory(p, p.home);
  } catch (error) { if (!panels.includes(p) || p.closing || p.connectRequestId !== requestId) return; p.status = 'error'; p.error = error.message; renderPanel(p); }
  syncWorkspace();
}
async function loadDirectory(p, targetPath = p.path) {
  if (p.status !== 'ready' || p.deleting || p.renaming || p.exporting) return;
  const version = ++p.loadVersion; p.loading = true; p.error = ''; renderPanel(p);
  try {
    const result = demo ? demoList(p.alias, targetPath) : await api.list({ id:p.id, path:targetPath });
    if (version !== p.loadVersion || !panels.includes(p)) return;
    p.path = result.path; p.entries = result.entries; p.selected.clear(); p.anchor = -1;
  } catch (error) { if (version === p.loadVersion) { p.error = error.message; toast(error.message); } }
  finally { if (version === p.loadVersion && panels.includes(p)) { p.loading = false; renderPanel(p); } }
}
function fileIcon(entry) { if (entry.type === 'directory') return 'folder'; if (entry.type === 'symlink') return 'link'; if (/\.(zip|tar|gz|tgz|bz2|7z)$/i.test(entry.name)) return 'archive'; return /\.(js|ts|py|json|yml|yaml|conf|sh|html|css|toml|md)$/i.test(entry.name) ? 'code' : 'file'; }
function visibleEntries(p) { return p.entries.filter(e => e.name.toLowerCase().includes(p.filter.toLowerCase())); }
function renderPanel(p) {
  const s = (demo ? demoServers : config.servers).find(s => s.alias === p.alias);
  const entries = visibleEntries(p);
  const connected = p.status === 'ready';
  const busy = p.loading || p.deleting || p.exporting || p.renaming;
  p.element.innerHTML = `<div class="panel-header"><div class="panel-symbol">${icon(p.local ? 'computer' : 'server')}</div><div class="panel-heading"><strong>${esc(p.alias)}</strong><span>${esc(p.local ? '本机文件与文件夹' : s ? `${s.user}@${s.hostname}` : p.alias)}</span></div><span class="connected-pill ${p.status === 'error' ? 'error' : ''}">${demo ? '演示' : p.status === 'connecting' ? '连接中' : connected ? p.local ? '本地' : '已连接' : '已断开'}</span><button class="icon-button close-panel" title="${p.status === 'connecting' ? '取消连接并关闭' : '关闭面板'}" aria-label="关闭 ${esc(p.alias)}" ${p.closing ? 'disabled' : ''}>${icon('close')}</button></div>
    ${connected ? `<div class="panel-toolbar"><button class="icon-button go-parent" title="上级目录" ${busy || parent(p.path) === p.path ? 'disabled' : ''}>${icon('arrow-up')}</button><button class="icon-button go-home" title="主目录" ${busy ? 'disabled' : ''}>${icon('home')}</button><span class="path-icon">${icon('folder')}</span><input class="path-input" value="${esc(p.path)}" aria-label="${esc(p.alias)} 目录路径" title="输入绝对路径并按 Enter"><button class="icon-button refresh-panel" title="刷新目录" ${busy ? 'disabled' : ''}>${icon('refresh')}</button></div><div class="panel-transfer-tools">${!p.local ? `<button class="button upload-files" title="选择本地文件或文件夹并上传到当前服务器目录" ${busy ? 'disabled' : ''}>${icon('upload')}<span>从本地上传</span></button><button class="button download-selected" title="先选中服务器文件或文件夹，再选择本地保存目录" ${busy ? 'disabled' : ''}>${icon('download')}<span>下载到本地</span></button>` : ''}<button class="button drag-to-desktop" title="${p.local ? '将所选文件拖到桌面或资源管理器' : '先准备下载，再将文件拖到桌面或资源管理器'}" ${busy ? 'disabled' : ''}>${icon('move')}<span>${p.exporting ? '正在准备桌面文件…' : '拖到桌面 / 文件夹'}</span></button></div><div class="panel-file-tools"><input class="file-filter" placeholder="筛选当前目录…" value="${esc(p.filter)}" aria-label="筛选文件"><div class="tool-buttons">${p.local ? `<button class="icon-button choose-directory" title="选择本地目录" aria-label="选择本地目录" ${busy ? 'disabled' : ''}>${icon('folder')}</button>` : ''}<button class="icon-button delete-selected" title="永久删除所选项目" aria-label="删除所选项目" ${!p.selected.size || busy ? 'disabled' : ''}>${icon('trash')}</button><button class="icon-button copy-selected" title="复制所选文件到…" ${!p.selected.size || busy ? 'disabled' : ''}>${icon('copy')}</button><button class="icon-button create-folder" title="新建文件夹" ${busy ? 'disabled' : ''}>${icon('plus')}</button></div></div><div class="file-columns"><span>名称</span><span>大小</span><span>修改日期</span></div>` : ''}
    ${p.status === 'connecting' || p.loading ? '<div class="panel-state"><div class="spinner"></div><p>正在'+(p.loading ? '读取文件列表' : '建立安全连接')+'…</p></div>' : p.status === 'error' ? `<div class="panel-state">${icon('warning')}<p>${esc(p.error)}</p><button class="button reconnect-panel">重新连接</button></div>` : `<div class="file-list" tabindex="0" aria-label="${esc(p.alias)} 文件列表">${entries.length ? entries.map(e => `<div class="file-row ${e.type} ${p.selected.has(e.name) ? 'selected' : ''}" draggable="true" data-name="${esc(e.name)}" title="${esc(e.name)}${e.type === 'symlink' ? '（符号链接，复制时保留链接）' : ''}"><div class="file-name">${icon(fileIcon(e))}<span>${esc(e.name)}</span></div><span class="file-size">${e.type === 'directory' ? '—' : bytes(e.size)}</span><span class="file-date">${date(e.mtime)}</span></div>`).join('') : '<div class="directory-empty">'+(p.error ? esc(p.error) : p.filter ? '没有匹配的文件' : '此文件夹是空的，拖入文件开始复制')+'</div>'}</div>`}
    <div class="panel-footer"><span>${connected ? `${p.entries.length} 个项目` : 'SSH / SFTP'}</span><span class="selection-label">${p.selected.size ? `已选 ${p.selected.size} 项` : connected ? '拖入此面板，复制到当前目录' : '安全连接到远程服务器'}</span></div>`;
  p.element.querySelector('.close-panel').onclick = () => closePanel(p);
  if (!connected) { const reconnect = p.element.querySelector('.reconnect-panel'); if (reconnect) reconnect.onclick = () => connectPanel(p); return; }
  p.element.querySelector('.go-parent').onclick = () => loadDirectory(p, parent(p.path));
  p.element.querySelector('.go-home').onclick = () => loadDirectory(p, p.home);
  p.element.querySelector('.refresh-panel').onclick = () => loadDirectory(p);
  p.element.querySelector('.path-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); const value = event.target.value.trim(); if (!validPath(p,value) && !demo) { toast(p.local ? '请输入本地绝对路径，例如 C:/Users' : '请输入以 / 开头的绝对路径'); return; } loadDirectory(p, value); } };
  p.element.querySelector('.file-filter').oninput = event => { const start = event.target.selectionStart; p.filter = event.target.value; renderPanel(p); const input = p.element.querySelector('.file-filter'); input.focus(); input.setSelectionRange(start, start); };
  p.element.querySelector('.create-folder').onclick = () => createFolder(p);
  p.element.querySelector('.copy-selected').onclick = () => chooseTarget(p);
  p.element.querySelector('.delete-selected').onclick = () => deleteSelected(p);
  p.element.querySelector('.drag-to-desktop').onclick = () => prepareDesktop(p);
  if (p.local) p.element.querySelector('.choose-directory').onclick = () => chooseLocalDirectory(p);
  else { p.element.querySelector('.upload-files').onclick = () => uploadFiles(p); p.element.querySelector('.download-selected').onclick = () => downloadSelected(p); }
  const list = p.element.querySelector('.file-list');
  if (list) {
    list.oncontextmenu = event => { event.preventDefault(); if (busy) return; const row=event.target.closest('.file-row'); if (row && !p.selected.has(row.dataset.name)) {p.selected.clear(); p.selected.add(row.dataset.name);} else if (!row) p.selected.clear(); updateSelection(p); showFileMenu(p); };
    list.onclick = event => { if (!event.target.closest('.file-row')) { p.selected.clear(); updateSelection(p); } };
    list.onkeydown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); entries.forEach(e => p.selected.add(e.name)); updateSelection(p); }
      if (event.key === 'F2') { event.preventDefault(); renameSelected(p); }
      if (event.key === 'Delete') { event.preventDefault(); deleteSelected(p); }
      if (event.key === 'Backspace') { event.preventDefault(); loadDirectory(p, parent(p.path)); }
      if (event.key === 'Enter' && p.selected.size === 1) { const entry = p.entries.find(e => e.name === [...p.selected][0]); if (entry?.type === 'directory') loadDirectory(p, join(p.path, entry.name)); }
    };
    list.querySelectorAll('.file-row').forEach((row, index) => {
      row.onclick = event => {
        const name = row.dataset.name;
        if (event.shiftKey && p.anchor >= 0) { if (!event.ctrlKey) p.selected.clear(); entries.slice(Math.min(p.anchor,index), Math.max(p.anchor,index)+1).forEach(e => p.selected.add(e.name)); }
        else if (event.ctrlKey || event.metaKey) { if (p.selected.has(name)) p.selected.delete(name); else p.selected.add(name); p.anchor = index; }
        else { p.selected.clear(); p.selected.add(name); p.anchor = index; }
        updateSelection(p); list.focus({ preventScroll:true });
      };
      row.ondblclick = () => { const entry = p.entries.find(e => e.name === row.dataset.name); if (['directory','symlink'].includes(entry?.type)) loadDirectory(p, join(p.path, entry.name)); };
      row.ondragstart = event => {
        if (!p.selected.has(row.dataset.name)) { p.selected.clear(); p.selected.add(row.dataset.name); updateSelection(p); }
        if (p.local && !demo) { event.preventDefault(); startNativeDrag([...p.selected].map(name=>join(p.path,name))); return; }
        const value = { sourceId:p.id, sourceKey:p.key, paths:[...p.selected].map(n => join(p.path, n)) };
        event.dataTransfer.setData('application/x-server-explorer', JSON.stringify(value)); event.dataTransfer.effectAllowed = 'copy';
      };
      row.ondragend = clearDrag;
      if (row.classList.contains('directory')) {
        row.ondragover = event => { if (busy || !validDrag(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; clearDrag(); row.classList.add('drop-folder'); };
        row.ondragleave = () => row.classList.remove('drop-folder');
        row.ondrop = event => { event.preventDefault(); event.stopPropagation(); clearDrag(); acceptDrop(event, p, join(p.path, row.dataset.name)); };
      }
    });
  }
  p.element.ondragover = event => { if (busy || !validDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; p.element.classList.add('drag-over'); };
  p.element.ondragleave = event => { if (!p.element.contains(event.relatedTarget)) p.element.classList.remove('drag-over'); };
  p.element.ondrop = event => { event.preventDefault(); clearDrag(); if (!busy && validDrag(event)) acceptDrop(event, p, p.path); };
}
function validDrag(event) { return [...event.dataTransfer.types].some(type => type === 'application/x-server-explorer' || (!demo && type === 'Files')); }
function clearDrag() { document.querySelectorAll('.drag-over,.drop-folder').forEach(el => el.classList.remove('drag-over','drop-folder')); }
function updateSelection(p) { p.element.querySelectorAll('.file-row').forEach(row => row.classList.toggle('selected', p.selected.has(row.dataset.name))); p.element.querySelector('.selection-label').textContent = p.selected.size ? `已选 ${p.selected.size} 项` : '拖入此面板，复制到当前目录'; for (const button of p.element.querySelectorAll('.copy-selected,.delete-selected')) button.disabled = !p.selected.size || p.loading || p.deleting; const download = p.element.querySelector('.download-selected'); if (download) download.disabled = !!(p.loading || p.deleting || p.exporting || p.renaming); }
async function closePanel(p) {
  if (p.closing) return;
  if (p.deleting) { toast('正在删除文件，请等待完成'); return; }
  const connecting = p.status === 'connecting', requestId = p.connectRequestId;
  if (connecting) {
    const answer = await showModal({ title:'强制关闭连接？', icon:'warning', message:`${p.alias} 正在连接。确认后将立即终止本次连接，并关闭此面板。`, buttons:[{label:'继续等待',value:null},{label:'强制关闭',value:'force',primary:true}] });
    if (!answer || !panels.includes(p) || p.connectRequestId !== requestId) return;
  }
  p.closing = true;
  p.element.querySelector('.close-panel').disabled = true;
  try {
    if (!demo && connecting) await api.cancelConnect({requestId});
    else if (!demo && p.id) await api.disconnect({ id:p.id });
    panels = panels.filter(x => x !== p); p.element.remove(); syncWorkspace();
    if (connecting) toast('连接已取消');
  } catch (error) { p.closing=false; renderPanel(p); toast(error.message); }
}
async function acceptDrop(event, target, targetPath) {
  try {
    if (!demo && [...event.dataTransfer.types].includes('Files')) {
      const paths = [...event.dataTransfer.files].map(file => api.filePath(file)).filter(Boolean);
      if (paths.length) await confirmCopy({id:'local',alias:'本地电脑'},target,paths,targetPath);
      return;
    }
    const data = JSON.parse(event.dataTransfer.getData('application/x-server-explorer')); const source = panels.find(p => p.key === data.sourceKey && p.id === data.sourceId); if (!source || !Array.isArray(data.paths)) return; await confirmCopy(source, target, data.paths, targetPath); }
  catch (error) { toast(error.message); }
}
async function confirmCopy(source, target, paths, targetPath) {
  if (!paths.length) return;
  const payload = {sourceId:source.id,targetId:target.id,paths,targetPath};
  let sameServer = source.id === target.id || (!!source.connectionKey && source.connectionKey === target.connectionKey);
  if (demo) {
    if (sameServer && paths.every(p => parent(p) === targetPath.replace(/\/$/,'') || parent(p) === targetPath)) return;
  } else {
    try { const check = await api.inspectTransfer(payload); if (check.sameDirectory) return; sameServer = check.sameServer; }
    catch (error) { toast(error.message); return; }
  }
  const downloading = target.local || target.id === 'local';
  const confirmed = await showModal({ title:demo ? '模拟复制文件' : downloading ? '下载到本地' : '复制到目标目录', icon:'copy', message:`${paths.length} 个项目将${sameServer && !source.local && source.id !== 'local' ? '在服务器端' : ''}复制到指定目录。源文件会保留。`, detail:`${source.alias}  →  ${target.alias}\n目标目录：${targetPath}\n${paths.slice(0,5).map(p => p.slice(p.lastIndexOf('/')+1)).join('、')}${paths.length > 5 ? '…' : ''}`, buttons:[{ label:'取消', value:null }, { label:demo ? '模拟复制' : downloading ? '开始下载' : '开始复制', value:'copy', primary:true }] });
  if (!confirmed) return;
  try { if (demo) simulateTransfer(payload); else await api.transfer(payload); toast(demo ? '演示任务已加入队列' : '复制任务已加入传输队列'); $('#transfer-section').classList.remove('collapsed'); }
  catch (error) { toast(error.message); }
}
async function chooseTarget(source) {
  const targets = panels.filter(p => p.status === 'ready');
  if (!source.selected.size) { toast('请先选择要复制的项目'); return; }
  const paths = [...source.selected].map(n => join(source.path,n));
  const value = await showModal({ title:'复制所选项目', icon:'copy', message:`已选择 ${source.selected.size} 个项目`, fields:[{ name:'target', type:'select', label:'目标位置', options:targets.map(p => ({value:p.key, label:p.alias})), value:(targets.find(p => p !== source) || source).key },{ name:'path', label:'目标目录（留空使用目标面板当前目录）', value:'' }], buttons:[{label:'取消',value:null},{label:'下一步',value:'next',primary:true}] });
  if (!value) return;
  const target = panels.find(p => p.key === value.target);
  const targetPath = value.path.trim() || target?.path;
  if (!target || (!demo && !validPath(target,targetPath))) { toast('目标位置或目录无效'); return; }
  await confirmCopy(source, target, paths, targetPath);
}
async function createFolder(p) {
  const result = await showModal({ title:'新建文件夹', icon:'folder', message:`在 ${p.alias} 的当前目录中创建`, detail:p.path, fields:[{ name:'name', label:'文件夹名称', placeholder:'输入文件夹名称', required:true }], buttons:[{ label:'取消',value:null },{ label:'创建',value:'create',primary:true }] });
  if (!result) return;
  if (!result.name || result.name === '.' || result.name === '..' || /[/\0]/.test(result.name)) { toast('文件夹名称不能包含 /，也不能是 . 或 ..'); return; }
  try { if (demo) { const entries = demoList(p.alias,p.path).entries; if (entries.some(e => e.name === result.name)) throw new Error('同名项目已存在'); entries.push({ name:result.name,type:'directory',size:0,mtime:Date.now()/1000 }); } else await api.mkdir({ id:p.id,path:p.path,name:result.name }); await loadDirectory(p); }
  catch (error) { toast(error.message); }
}
async function chooseLocalDirectory(p) {
  if (demo) { toast('演示模式不访问本地目录'); return; }
  try { const paths = await api.chooseLocal({directory:true}); if (paths?.length) await loadDirectory(p,paths[0]); } catch (error) { toast(error.message); }
}
async function uploadFiles(target) {
  if (demo) { toast('演示模式不读取本地文件；可打开本地演示面板体验拖拽复制'); return; }
  const targetPath = target.path;
  const kind = await showModal({title:'从本地上传',icon:'upload',message:'选择要上传的文件或文件夹。',buttons:[{label:'取消',value:null},{label:'选择文件夹',value:'directory'},{label:'选择文件',value:'file',primary:true}]});
  if (!kind) return;
  try { const paths = await api.chooseLocal({directory:kind === 'directory',multiple:true}); if (paths?.length) await confirmCopy({id:'local',alias:'本地电脑'},target,paths,targetPath); } catch (error) { toast(error.message); }
}
async function downloadSelected(source) {
  if (source.status !== 'ready' || source.loading || source.deleting) return;
  if (!source.selected.size) { toast('请先在服务器面板中选中文件或文件夹，再点击「下载到本地」'); return; }
  if (demo) { const paths = [...source.selected].map(n => join(source.path,n)); await openServer('本地电脑',true); const target = panels.find(p => p.local); await confirmCopy(source,target,paths,target.path); return; }
  const paths = [...source.selected].map(n => join(source.path,n));
  try { const targets = await api.chooseLocal({directory:true,purpose:'download'}); if (targets?.length) await confirmCopy(source,{id:'local',alias:'本地电脑'},paths,targets[0]); } catch (error) { toast(error.message); }
}
async function deleteSelected(p) {
  if (!p.selected.size || p.loading || p.deleting) return;
  const directory = p.path, names = [...p.selected];
  if ([...jobs.values()].some(j => activeStatuses.includes(j.status) && (j.sourceId === p.id || j.targetId === p.id))) { toast('此位置有未完成的传输，请先取消或等待完成'); return; }
  p.deleting = true; renderPanel(p);
  try {
    if (demo) {
      const confirmed = await showModal({title:'模拟删除所选项目？',icon:'trash',message:`将从 ${p.alias} 的演示数据中删除 ${names.length} 个项目。`,detail:`目录：${directory}\n${names.join('\n')}`,buttons:[{label:'取消',value:null},{label:'模拟删除',value:'delete',primary:true}]});
      if (!confirmed) return;
      const selected = new Set(names);
      demoTree.set(`${p.alias}:${directory}`,demoList(p.alias,directory).entries.filter(e => !selected.has(e.name)));
      for (const key of demoTree.keys()) if (names.some(name => key === `${p.alias}:${join(directory,name)}` || key.startsWith(`${p.alias}:${join(directory,name)}/`))) demoTree.delete(key);
      toast(`演示：已删除 ${names.length} 个项目`);
    } else { const removed = await api.delete({id:p.id,path:directory,names}); if (removed !== null) toast(`已删除 ${removed} 个项目`); }
  } catch (error) { toast(error.message); }
  finally { p.deleting = false; await loadDirectory(p); }
}
async function renameSelected(p) {
  if (p.selected.size !== 1 || p.loading || p.deleting || p.exporting || p.renaming) { toast('请选中一个文件或文件夹进行重命名'); return; }
  const name=[...p.selected][0], directory=p.path;
  const value=await showModal({title:'重命名',icon:'file',message:`重命名 ${name}`,fields:[{name:'name',label:'新名称',value:name,required:true}],buttons:[{label:'取消',value:null},{label:'保存',value:'rename',primary:true}]});
  if (!value || value.name === name) return;
  p.renaming=true; renderPanel(p);
  try {
    if (demo) {
      if (!value.name || value.name === '.' || value.name === '..' || /[/\0]/.test(value.name)) throw new Error('文件名无效');
      const entries=demoList(p.alias,directory).entries;
      if (entries.some(entry=>entry.name === value.name)) throw new Error('同名项目已存在');
      const entry=entries.find(entry=>entry.name === name); if (!entry) throw new Error('项目已不存在'); entry.name=value.name;
      const prefix=`${p.alias}:${join(directory,name)}`, next=`${p.alias}:${join(directory,value.name)}`;
      for (const [key,children] of [...demoTree]) if (key === prefix || key.startsWith(prefix+'/')) {demoTree.delete(key); demoTree.set(next+key.slice(prefix.length),children);}
    } else await api.rename({id:p.id,path:directory,name,newName:value.name});
    toast('重命名完成');
  } catch(error) {toast(error.message);} finally {p.renaming=false; await loadDirectory(p);}
}
const fileContexts = new Map();
async function showFileMenu(p) {
  const contextKey=crypto.randomUUID();
  fileContexts.set(contextKey,{key:p.key,id:p.id,path:p.path,names:[...p.selected]});
  if (fileContexts.size > 10) fileContexts.delete(fileContexts.keys().next().value);
  const targets=panels.filter(target=>target !== p && target.status === 'ready').map(target=>({key:target.key,id:target.id,alias:target.alias,local:!!target.local}));
  try {await api.contextMenu({id:p.id,contextKey,count:p.selected.size,local:!!p.local,targets,demo});} catch(error) {fileContexts.delete(contextKey); toast(error.message);}
}
async function menuAction({contextKey,action,targetKey}) {
  const context=fileContexts.get(contextKey); fileContexts.delete(contextKey);
  if (!context) return;
  const p=panels.find(panel=>panel.key === context.key && panel.id === context.id);
  if (!p || p.status !== 'ready' || p.path !== context.path) {toast('目录已变化，请重新右键选择'); return;}
  p.selected=new Set(context.names.filter(name=>p.entries.some(entry=>entry.name === name))); updateSelection(p);
  if (action === 'download') await downloadSelected(p);
  else if (action === 'delete') await deleteSelected(p);
  else if (action === 'rename') await renameSelected(p);
  else if (action === 'mkdir') await createFolder(p);
  else if (action === 'refresh') await loadDirectory(p);
  else if (action === 'desktop') await prepareDesktop(p);
  else if (action === 'copy') {
    const target=panels.find(panel=>panel.key === targetKey && panel.status === 'ready');
    if (!target) {toast('目标面板已关闭，请重新选择'); return;}
    await confirmCopy(p,target,[...p.selected].map(name=>join(context.path,name)),target.path);
  }
}
async function startNativeDrag(paths) {try {await api.startDrag({paths});} catch(error) {toast(error.message);}}
async function prepareDesktop(p) {
  if (p.loading || p.exporting || p.deleting || p.renaming) return;
  if (!p.selected.size) {toast('请先选中要拖到桌面的文件或文件夹'); return;}
  if (demo) {toast('演示模式不向桌面复制真实文件'); return;}
  const paths=[...p.selected].map(name=>join(p.path,name));
  p.exporting=true; renderPanel(p);
  try {
    $('#transfer-section').classList.remove('collapsed');
    const dragPaths=await api.prepareDesktop({id:p.id,paths});
    await showModal({title:'拖到桌面或文件夹',icon:'move',message:'文件已准备好。按住下面的文件卡片，将它拖到 Windows 桌面或文件资源管理器中。',detail:dragPaths.map(file=>file.replace(/\\/g,'/').split('/').pop()).join('\n'),dragPaths,buttons:[{label:'关闭',value:null}]});
  } catch(error) {toast(error.message);} finally {p.exporting=false; renderPanel(p);}
}
const modalQueue = []; let activeModal = null;
function showModal(options) { return new Promise(resolve => { modalQueue.push({ ...options, resolve }); nextModal(); }); }
function finishModal(value) { if (!activeModal) return; const item = activeModal; activeModal = null; $('#modal').close(); $('#modal-fields').replaceChildren(); item.resolve(value); nextModal(); }
function nextModal() {
  if (activeModal || !modalQueue.length) return;
  activeModal = modalQueue.shift(); const options = activeModal;
  $('#modal-icon').innerHTML = icon(options.icon || 'shield');
  $('#modal-title').textContent = options.title;
  $('#modal-message').textContent = options.message || '';
  $('#modal-detail').textContent = options.detail || '';
  $('#modal-fields').innerHTML = (options.fields || []).map(field => {
    if (field.type === 'checkbox') return `<label class="checkbox"><input name="${esc(field.name)}" type="checkbox">${esc(field.label)}</label>`;
    return `<label>${esc(field.label)}</label>${field.type === 'select' ? `<select name="${esc(field.name)}">${field.options.map(o => `<option value="${esc(o.value)}" ${field.value === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : `<input name="${esc(field.name)}" type="${field.type === 'password' ? 'password' : 'text'}" value="${esc(field.value || '')}" placeholder="${esc(field.placeholder || '')}" ${field.required ? 'required' : ''} autocomplete="off">`}`;
  }).join('');
  if (options.dragPaths) {
    const card=document.createElement('div'); card.className='native-drag-card'; card.draggable=true; card.tabIndex=0;
    card.innerHTML=`${icon('move')}<strong>${options.dragPaths.length} 个项目 · 拖到桌面</strong><span>按住并拖出此卡片</span>`;
    card.ondragstart=event=>{event.preventDefault(); startNativeDrag(options.dragPaths);};
    $('#modal-fields').appendChild(card);
  }
  $('#modal-actions').innerHTML = '';
  for (const button of options.buttons || []) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'button' + (button.primary ? ' primary' : '') + (button.danger ? ' danger' : ''); el.textContent = button.label;
    el.onclick = () => {
      if (button.value !== null && options.fields?.length) {
        if (!$('#modal-form').reportValidity()) return;
        const result = { action:button.value };
        for (const field of options.fields) { const input = $('#modal-fields').querySelector(`[name="${field.name}"]`); result[field.name] = field.type === 'checkbox' ? input.checked : input.value; }
        finishModal(result);
      } else finishModal(button.value);
    };
    $('#modal-actions').appendChild(el);
  }
  $('#modal').showModal();
  const input = $('#modal-fields').querySelector('input:not([type=checkbox]),select'); if (input) input.focus();
}
$('#modal').addEventListener('cancel', event => { event.preventDefault(); finishModal(null); });
$('#modal-form').onsubmit = event => { event.preventDefault(); $('#modal-actions .primary')?.click(); };
async function handlePrompt(prompt) {
  let options = { ...prompt, promptId:prompt.id };
  if (prompt.kind === 'delete') options = {...options,buttons:[{label:'取消',value:null},{label:'永久删除',value:'delete',primary:true,danger:true}]};
  if (prompt.kind === 'secret') options = { ...options, fields:[{ name:'secret',label:'密码 / 密钥口令',type:'password' }], buttons:[{label:'取消',value:null},{label:'验证',value:'submit',primary:true}] };
  if (prompt.kind === 'trust') options = { ...options, message:prompt.message + '\n\n请核对服务器指纹，确认后会由 OpenSSH 保存到 known_hosts。', buttons:[{label:'取消连接',value:'no'},{label:'信任并连接',value:'yes',primary:true}] };
  if (prompt.kind === 'conflict') options = { ...options, icon:'warning', fields:[{name:'all',type:'checkbox',label:'对本次传输的后续冲突使用相同处理方式'}], buttons:[{label:'取消传输',value:null},{label:'跳过',value:'skip'},...(prompt.canReplace ? [{label:'覆盖',value:'replace',primary:true}] : [])] };
  const answer = await showModal(options);
  let value = answer;
  if (prompt.kind === 'secret') value = answer?.secret ?? null;
  if (prompt.kind === 'conflict') value = answer ? answer.action + (answer.all ? '-all' : '') : 'cancel';
  try { await api.answer({ id:prompt.id,value }); } catch (error) { toast(error.message); }
}
function closePrompt(id) {
  if (activeModal?.promptId === id) finishModal(null);
  for (let i = modalQueue.length - 1; i >= 0; i--) if (modalQueue[i].promptId === id) { const [item] = modalQueue.splice(i,1); item.resolve(null); }
}
const activeStatuses = ['queued','scanning','running','waiting'];
function updateJob(job) {
  const previous = jobs.get(job.id); jobs.set(job.id,{...job});
  if (['done','failed','cancelled'].includes(job.status) && previous?.status !== job.status) {
    const target = panels.find(p => p.id === job.targetId); if (target?.status === 'ready') loadDirectory(target);
    if (job.status === 'done') toast(`${demo ? '演示：' : ''}复制完成${job.skipped ? `，跳过 ${job.skipped} 项` : ''}`);
  }
  renderTransfers();
}
function renderTransfers() {
  const values = [...jobs.values()].reverse();
  const active = values.filter(j => activeStatuses.includes(j.status)).length;
  $('#active-transfer-count').textContent = active;
  $('#transfer-summary').innerHTML = `${active ? `${active} 个任务进行中` : values.length ? `${values.filter(j => j.status === 'done').length} 个任务已完成` : '所有传输都在这里'} ${icon('chevron-down')}`;
  if (!values.length) return;
  $('#transfer-list').innerHTML = values.slice(0,50).map(job => {
    const percent = job.status === 'done' ? 100 : job.total ? Math.min(99, job.bytes/job.total*100) : 0;
    const status = {queued:'等待中',scanning:'统计文件…',running:job.mode === 'server' ? '服务器端复制' : '正在复制',waiting:'等待确认',done:'已完成',failed:'失败',cancelled:'已取消'}[job.status];
    const name = job.paths.length === 1 ? job.paths[0].slice(job.paths[0].lastIndexOf('/')+1) : `${job.paths.length} 个项目`;
    return `<div class="transfer-row ${job.status}"><div class="transfer-symbol">${icon(job.status === 'done' ? 'check' : 'file')}</div><div><div class="transfer-name" title="${esc(job.current || name)}">${esc(name)}</div><div class="transfer-route">${esc(job.sourceAlias)} ${icon('arrow-right')} ${esc(job.targetAlias)} · ${esc(job.targetPath)}${job.mode === 'server' ? ' · 服务器端复制' : ''}</div>${job.error ? `<div class="transfer-error" title="${esc(job.error)}">${esc(job.error)}</div>` : ''}</div><div><div class="progress-track"><div class="progress-fill" style="width:${percent.toFixed(1)}%"></div></div><div class="transfer-progress-note"><span>${bytes(job.bytes)} / ${bytes(job.total)}${job.skipped ? ` · 跳过 ${job.skipped}` : ''}</span><span>${Math.floor(percent)}%</span></div></div><div class="transfer-result ${job.status}">${status}${demo ? ' · 演示' : ''}</div>${activeStatuses.includes(job.status) ? `<button class="icon-button cancel-transfer" data-id="${esc(job.id)}" title="取消传输">${icon('close')}</button>` : '<span></span>'}</div>`;
  }).join('');
  $('#transfer-list').querySelectorAll('.cancel-transfer').forEach(button => button.onclick = async () => { if (demo) { const j = jobs.get(button.dataset.id); clearInterval(j.timer); j.status = 'cancelled'; renderTransfers(); } else { try { await api.cancel({ id:button.dataset.id }); } catch (error) { toast(error.message); } } });
}
const demoServers = [
  { alias:'production', hostname:'192.168.1.10',user:'deploy',port:22 },
  { alias:'staging', hostname:'192.168.1.20',user:'deploy',port:22 },
  { alias:'backup', hostname:'192.168.1.30',user:'deploy',port:22 },
  { alias:'database', hostname:'192.168.1.40',user:'admin',port:2222 },
  { alias:'gateway', hostname:'192.168.1.50',user:'root',port:22 }
];
const demoTree = new Map();
function demoList(alias, path) {
  path = path.replace(/\/+/g,'/').replace(/\/$/,'') || '/'; const key = `${alias}:${path}`;
  if (!demoTree.has(key)) {
    const names = path === '/home/deploy' ? (alias === 'production' ? ['apps/','assets/','config/','logs/','releases/','docker-compose.yml','nginx.conf','README.md','deploy.sh','.env.example'] : alias === 'staging' ? ['apps/','config/','logs/','releases/','docker-compose.yml','README.md','setup.sh'] : ['archives/','daily/','database/','snapshots/','backup.sh','manifest.json']) : path === '/' ? ['etc/','home/','opt/','srv/','tmp/','var/'] : path === '/home' ? ['deploy/'] : path.endsWith('/apps') ? ['api/','web/','worker/','package.json'] : path.endsWith('/config') ? ['nginx.conf','app.yml','database.json'] : path.endsWith('/releases') ? ['v1.2.0/','v1.3.0/','release.tar.gz'] : [];
    demoTree.set(key,names.map((name,i) => ({ name:name.replace(/\/$/,''),type:name.endsWith('/') ? 'directory' : 'file',size:name.endsWith('/') ? 0 : [2460,814,1534,378,1221][i%5],mtime:Date.parse('2026-10-10T09:00:00Z')/1000-i*86400,mode:name.endsWith('/') ? 0o40755 : 0o100644 })));
  }
  return { path,entries:demoTree.get(key) };
}
function simulateTransfer(payload) {
  const source = panels.find(p => p.id === payload.sourceId), target = panels.find(p => p.id === payload.targetId);
  const job = { ...payload,id:crypto.randomUUID(),sourceAlias:source.alias,targetAlias:target.alias,status:'running',bytes:0,total:1048576,completed:0,count:payload.paths.length,skipped:0,startedAt:Date.now() };
  updateJob(job);
  job.timer = setInterval(() => { if (jobs.get(job.id)?.status === 'cancelled') { clearInterval(job.timer); return; } job.bytes = Math.min(job.total,job.bytes+98304); if (job.bytes === job.total) { clearInterval(job.timer); job.status = 'done'; job.completed = job.count; const entries = demoList(target.alias,payload.targetPath).entries; for (const path of payload.paths) { const name = path.slice(path.lastIndexOf('/')+1); const item = demoList(source.alias,parent(path)).entries.find(e => e.name === name); if (item && !entries.some(e => e.name === name)) entries.push({...item}); } } updateJob(job); },160);
}
async function toggleDemo() {
  if ([...jobs.values()].some(j => activeStatuses.includes(j.status))) { toast('请等待或取消当前传输后切换模式'); return; }
  if (panels.some(p => p.exporting || p.renaming)) { toast('请等待文件操作完成后切换模式'); return; }
  if (panels.some(p => p.deleting)) { toast('请等待删除完成后切换模式'); return; }
  if (panels.some(p => p.status === 'connecting')) { toast('请等待当前连接完成'); return; }
  if (panels.length) {
    const answer = await showModal({ title:'切换工作区模式',icon:'layers',message:'切换会关闭当前文件面板。',buttons:[{label:'取消',value:null},{label:'切换',value:'switch',primary:true}] });
    if (!answer) return;
  }
  if (!demo) for (const p of panels) if (p.id) await api.disconnect({id:p.id});
  for (const j of jobs.values()) if (j.timer) clearInterval(j.timer);
  panels = []; jobs.clear(); $('#panels').replaceChildren(); $('#transfer-list').innerHTML = '<div class="transfer-empty">还没有传输任务</div>';
  demo = !demo; $('#mode-badge').hidden = !demo; $('#demo-button').textContent = demo ? '返回真实服务器' : '体验演示';
  $('#choose-config').disabled = demo; $('#refresh-config').disabled = demo; renderTransfers(); syncWorkspace();
  if (demo) for (const alias of ['production','staging','backup']) await openServer(alias);
}
$('#demo-button').onclick = () => toggleDemo().catch(error => toast(error.message));
$('#empty-demo').onclick = () => toggleDemo().catch(error => toast(error.message));
$('#open-local').onclick = () => openServer('本地电脑',true);
$('#server-search').oninput = renderSidebar;
$('#refresh-config').onclick = () => loadConfig();
$('#choose-config').onclick = () => loadConfig(true);
$('#transfer-toggle').onclick = () => $('#transfer-section').classList.toggle('collapsed');
api.onMenuAction(value=>menuAction(value).catch(error=>toast(error.message)));
api.onPrompt(handlePrompt); api.onPromptClosed(closePrompt); api.onTransfer(updateJob);
api.onDisconnect(({id,error}) => { const p = panels.find(p => p.id === id); if (p) { p.status = 'error'; p.error = error; p.loading = false; p.selected.clear(); renderPanel(p); syncWorkspace(); } });
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => { event.preventDefault(); clearDrag(); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); const focused = panels.find(p => p.element.contains(document.activeElement)); if (focused) loadDirectory(focused); else loadConfig(); } });
syncWorkspace(); loadConfig();
