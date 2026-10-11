const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = channel => async payload => { const result = await ipcRenderer.invoke(channel, payload); if (!result.ok) throw new Error(result.error); return result.value; };
const listen = channel => callback => { const handler = (_, data) => callback(data); ipcRenderer.on(channel, handler); return () => ipcRenderer.removeListener(channel, handler); };
contextBridge.exposeInMainWorld('explorer', {
  loadConfig: call('config:load'), chooseConfig: call('config:choose'), connect: call('server:connect'), cancelConnect: call('server:cancelConnect'), disconnect: call('server:disconnect'), list: call('server:list'), mkdir: call('server:mkdir'),
  openLocal: call('local:open'), chooseLocal: call('local:choose'), delete: call('files:delete'), filePath: file => webUtils.getPathForFile(file).replaceAll('\\','/'),
  rename: call('files:rename'), contextMenu: call('files:menu'), prepareDesktop: call('files:prepareDesktop'), startDrag: call('files:startDrag'), onMenuAction: listen('files:menuAction'),
  inspectTransfer: call('transfer:inspect'), transfer: call('transfer:start'), cancel: call('transfer:cancel'), answer: call('prompt:answer'),
  onTransfer: listen('transfer:update'), onDisconnect: listen('server:closed'), onPrompt: listen('prompt:show'), onPromptClosed: listen('prompt:closed')
});
