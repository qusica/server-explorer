function fileMenu({local,count,targets=[],demo=false},choose) {
  const transfer = (label,list,action) => ({label,enabled:count > 0 && list.length > 0,submenu:list.length ? list.map(target=>({label:target.alias,click:()=>choose(action,target.key)})) : [{label:'请先打开服务器面板',enabled:false}]});
  return [
    ...(local ? [transfer('上传到',targets.filter(target=>!target.local),'copy')] : [{label:'下载到本地',enabled:count > 0,click:()=>choose('download')}]),
    transfer('复制到',targets,'copy'),
    {label:'拖到桌面 / 文件夹',enabled:count > 0 && !demo,click:()=>choose('desktop')},
    {type:'separator'},
    {label:'重命名',enabled:count === 1,click:()=>choose('rename')},
    {label:'删除',enabled:count > 0,click:()=>choose('delete')},
    {type:'separator'},
    {label:'新建文件夹',click:()=>choose('mkdir')},
    {label:'刷新',click:()=>choose('refresh')}
  ];
}
module.exports = {fileMenu};
