(() => {
  const pending = new Map(), listeners = new Map();
  let sequence = 0;
  const call = channel => payload => new Promise((resolve,reject) => {
    const id = String(++sequence);
    pending.set(id,{resolve,reject});
    window.chrome.webview.postMessage({type:'request',id,channel,payload:payload??null});
  });
  const listen = channel => callback => {
    if (!listeners.has(channel)) listeners.set(channel,new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel)?.delete(callback);
  };
  window.chrome.webview.addEventListener('message',event => {
    const data=event.data;
    if(data?.type==='response') {
      const result=pending.get(data.id);
      if(!result)return;
      pending.delete(data.id);
      if(data.ok) result.resolve(data.value);
      else result.reject(new Error(data.error || '操作失败'));
    } else if(data?.type==='event') {
      for(const listener of listeners.get(data.channel)||[])listener(data.value);
    } else if(data?.type==='fatal')console.error('Backend:',data.error);
  });
  window.explorer={
    loadConfig:call('config:load'),chooseConfig:call('config:choose'),
    connect:call('server:connect'),cancelConnect:call('server:cancelConnect'),
    disconnect:call('server:disconnect'),list:call('server:list'),mkdir:call('server:mkdir'),
    openLocal:call('local:open'),chooseLocal:call('local:choose'),delete:call('files:delete'),
    rename:call('files:rename'),contextMenu:call('files:menu'),prepareDesktop:call('files:prepareDesktop'),
    startDrag:call('files:startDrag'),inspectTransfer:call('transfer:inspect'),
    transfer:call('transfer:start'),cancel:call('transfer:cancel'),answer:call('prompt:answer'),
    filePath:file => file.path || '',
    onMenuAction:listen('files:menuAction'),onTransfer:listen('transfer:update'),
    onDisconnect:listen('server:closed'),onPrompt:listen('prompt:show'),
    onPromptClosed:listen('prompt:closed')
  };
})();
