using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ServerExplorer;
internal sealed class NativeCore
{
    readonly Action<object> emit;
    readonly Func<string,object,Task<JsonElement>> host;
    readonly Dictionary<string,(string alias,SftpWire wire,string identity)> connections=new();
    readonly ConcurrentDictionary<string,CancellationTokenSource> connecting=new();
    readonly Dictionary<string,TaskCompletionSource<string?>> prompts=new();
    readonly string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"server-explorer");
    string configPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ssh","config");
    readonly string askpassPath;
    readonly Dictionary<string,TransferJob> jobs=new();
    readonly SemaphoreSlim transferLock=new(1,1);
    public NativeCore(Action<object> emit,Func<string,object,Task<JsonElement>> host,string askpassPath){
        this.emit=emit;this.host=host;this.askpassPath=askpassPath;
        Directory.CreateDirectory(profile);
        try{using var cfg=JsonDocument.Parse(File.ReadAllText(Path.Combine(profile,"preferences.json")));configPath=cfg.RootElement.GetProperty("configPath").GetString()??configPath;}catch{}
    }
    void Event(string channel,object? value)=>emit(new{type="event",channel,value});
    static string Text(JsonElement x,string key,string fallback="")=>x.ValueKind==JsonValueKind.Object&&x.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString()??fallback:fallback;
    static bool Bool(JsonElement x,string key)=>x.ValueKind==JsonValueKind.Object&&x.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.True;
    static string[] Strings(JsonElement x,string key)=>x.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.Array?v.EnumerateArray().Select(y=>y.GetString()??"").ToArray():[];
    static string Safe(string name){if(string.IsNullOrWhiteSpace(name)||name is "." or ".."||name.Contains('/')||name.Contains('\\')||name.Contains('\0'))throw new IOException("文件名无效");return name;}
    static string Remote(string path){if(!path.StartsWith('/')||path.Contains('\0'))throw new IOException("远程路径无效");return path;}
    static string Join(string a,string b)=>a.TrimEnd('/')+"/"+Safe(b);
    static string Parent(string p)=>p[..Math.Max(1,p.LastIndexOf('/'))];
    static object View(FileEntry e)=>new {e.name,e.type,e.size,e.mode,e.mtime};
    static object LocalInfo(string p){
        var a=File.GetAttributes(p);
        var type=(a&FileAttributes.ReparsePoint)!=0?"symlink":(a&FileAttributes.Directory)!=0?"directory":"file";
        return new FileEntry(Path.GetFileName(p),type,type=="file"?new FileInfo(p).Length:0,0,new DateTimeOffset(File.GetLastWriteTimeUtc(p)).ToUnixTimeSeconds());
    }
    static async Task<(int code,string stdout)> Shell(params string[] args){
        var p=new ProcessStartInfo("ssh"){CreateNoWindow=true,UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true};
        foreach(var a in args)p.ArgumentList.Add(a);
        using var proc=Process.Start(p)??throw new IOException("找不到 OpenSSH");
        var output=proc.StandardOutput.ReadToEndAsync();var error=proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        if(proc.ExitCode!=0)throw new IOException(await error);
        return (proc.ExitCode,await output);
    }
    async Task<object> Discover(){
        var names=new HashSet<string>();var seen=new HashSet<string>();
        async Task Visit(string file,int depth){
            if(depth>16||!seen.Add(Path.GetFullPath(file))||!File.Exists(file))return;
            foreach(var raw in await File.ReadAllLinesAsync(file)){
                var line=raw.Trim();if(line.StartsWith('#'))continue;
                var tokens=Regex.Matches(line,"(?:\\\"[^\\\"]*\\\"|\\S+)").Select(m=>m.Value.Trim('"')).ToArray();
                if(tokens.Length<2)continue;
                if(tokens[0].Equals("Host",StringComparison.OrdinalIgnoreCase))foreach(var n in tokens.Skip(1))if(!n.Contains('*')&&!n.Contains('?')&&!n.Contains('!'))names.Add(n);
                if(tokens[0].Equals("Include",StringComparison.OrdinalIgnoreCase))foreach(var n in tokens.Skip(1)){
                    var expanded=Environment.ExpandEnvironmentVariables(n.Replace("~",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
                    var dir=Path.GetDirectoryName(expanded);if(string.IsNullOrEmpty(dir))dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".ssh");
                    if(Directory.Exists(dir))foreach(var inc in Directory.GetFiles(dir,Path.GetFileName(expanded)))await Visit(inc,depth+1);
                }
            }
        }
        await Visit(configPath,0);
        var servers=new List<object>();
        foreach(var alias in names){
            try{
                var (_,result)=await Shell("-G","-F",configPath,alias);
                var opts=result.Split('\n').Select(l=>l.Trim().Split(' ',2)).Where(x=>x.Length==2).GroupBy(x=>x[0]).ToDictionary(g=>g.Key,g=>g.First()[1]);
                string Get(string k,string fallback="")=>opts.TryGetValue(k,out var v)?v:fallback;
                var identity=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("|",new[]{Get("hostname",alias),Get("user"),Get("port","22"),Get("proxyjump"),Get("proxycommand")})))).ToLowerInvariant();
                servers.Add(new{alias,hostname=Get("hostname",alias),user=Get("user"),port=int.TryParse(Get("port"),out var po)?po:22,jump=Get("proxyjump")=="none"?"":Get("proxyjump"),connectionKey=identity,error=(string?)null});
            }catch(Exception ex){servers.Add(new{alias,hostname=alias,user="",port=22,jump="",connectionKey="",error=ex.Message});}
        }
        return new{configPath,servers,warnings=File.Exists(configPath)?Array.Empty<string>():new[]{"未找到 SSH 配置文件"}};
    }
    public void Answer(string id,string? answer){lock(prompts){if(prompts.Remove(id,out var p))p.TrySetResult(answer);}}
    async Task<string?> Ask(string kind,string title,string message,string detail="",string? requestId=null,bool canReplace=false,CancellationToken ct=default){
        var id=Guid.NewGuid().ToString();var tcs=new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock(prompts)prompts[id]=tcs;
        Event("prompt:show",new{kind,title,message,detail,id,requestId,canReplace});
        try{return await tcs.Task.WaitAsync(TimeSpan.FromMinutes(3),ct);}catch{return null;}
        finally{lock(prompts)prompts.Remove(id);Event("prompt:closed",id);}
    }
    async Task<(string pipe,string token,Task server)> Askpass(string requestId,CancellationToken ct){
        var name="server-explorer-"+Guid.NewGuid().ToString("N");var token=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var listener=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous);
        async Task Serve(){
            try{
                while(!ct.IsCancellationRequested){
                    await listener.WaitForConnectionAsync(ct);
                    using(var reader=new StreamReader(listener,Encoding.UTF8,leaveOpen:true))
                    using(var writer=new StreamWriter(listener,new UTF8Encoding(false),leaveOpen:true){AutoFlush=true}){
                        var lines=new List<string>();
                        for(var i=0;i<4;i++)lines.Add(await reader.ReadLineAsync(ct)??"");
                        if(lines[0]==token){
                            string Decode(string s){try{return Encoding.UTF8.GetString(Convert.FromBase64String(s));}catch{return "";}}
                            var message=Decode(lines[2]);var trust=Regex.IsMatch(message,"authenticity|fingerprint|yes/no|continue connecting",RegexOptions.IgnoreCase);
                            var answer=await Ask(trust?"trust":"secret",trust?"确认服务器身份":"SSH 身份验证",message,Decode(lines[1]),requestId,ct:ct);
                            await writer.WriteLineAsync(answer==null?"CANCEL":Convert.ToBase64String(Encoding.UTF8.GetBytes(answer)));
                        }
                    }
                    listener.Disconnect();
                }
            }catch(OperationCanceledException){}catch(IOException){}finally{listener.Dispose();}
        }
        return(name,token,Serve());
    }
    (string alias,SftpWire wire,string identity) Session(string id)=>connections.TryGetValue(id,out var s)?s:throw new IOException("服务器尚未连接");
    string Key(string id,string p)=>id=="local"?Path.GetFullPath(p):Remote(p);
    async Task<string> Canon(string id,string p)=>id=="local"?Path.GetFullPath(p):await Session(id).wire.RealPath(p);
    async Task<FileEntry> Stat(string id,string p)=>id=="local"?(FileEntry)LocalInfo(p):await Session(id).wire.Stat(p);
    async Task<FileEntry?> Exists(string id,string p){try{return await Stat(id,p);}catch(SftpError e)when(e.Code==2){return null;}catch(FileNotFoundException){return null;}catch(DirectoryNotFoundException){return null;}}
    async Task<List<FileEntry>> List(string id,string p){
        if(id!="local")return await Session(id).wire.List(p);
        return Directory.EnumerateFileSystemEntries(p).Select(e=>(FileEntry)LocalInfo(e)).OrderBy(x=>x.type=="directory"?0:1).ThenBy(x=>x.name,StringComparer.CurrentCultureIgnoreCase).ToList();
    }
    async Task Mkdir(string id,string p){if(id=="local")Directory.CreateDirectory(p);else await Session(id).wire.Mkdir(p);}
    async Task Rename(string id,string from,string to,bool overwrite=false){if(id=="local"){if(Directory.Exists(from))Directory.Move(from,to);else File.Move(from,to,overwrite);}else if(overwrite)await Session(id).wire.PosixRename(from,to);else await Session(id).wire.Rename(from,to);}
    async Task Remove(string id,string p,bool dir){if(id=="local"){if(dir)Directory.Delete(p);else File.Delete(p);}else if(dir)await Session(id).wire.Rmdir(p);else await Session(id).wire.Remove(p);}
    async Task<string> Link(string id,string p)=>id=="local"?new FileInfo(p).LinkTarget??"":await Session(id).wire.Readlink(p);
    async Task Symlink(string id,string target,string p){if(id=="local")File.CreateSymbolicLink(p,target);else await Session(id).wire.Symlink(target,p);}
    sealed class TransferJob{
        public string id=Guid.NewGuid().ToString(),sourceId="",targetId="",sourceAlias="",targetAlias="",targetPath="",status="queued",current="",mode="stream";
        public string[] paths=[];public long bytes,total;public int completed,count,skipped;public string? error;
        public readonly CancellationTokenSource cancel=new();
    }
    void Update(TransferJob j)=>Event("transfer:update",new{j.id,j.sourceId,j.targetId,j.sourceAlias,j.targetAlias,j.paths,j.targetPath,j.status,j.current,j.mode,j.bytes,j.total,j.completed,j.count,j.skipped,j.error});
    async Task CopyBytes(string sid,string src,string tid,string dst,uint mode,long size,TransferJob job){
        var ct=job.cancel.Token;
        if(sid!="local"&&tid!="local"&&sid==tid&&Session(sid).wire.HasCopyData){
            await Session(sid).wire.CopyData(src,dst,size,mode,n=>{job.bytes+=n;Update(job);},ct);return;
        }
        byte[]? hIn=null,hOut=null;
        FileStream? localInput=null,localOutput=null;
        try{
            if(sid=="local")localInput=new FileStream(src,FileMode.Open,FileAccess.Read,FileShare.Read,65536,true);
            else hIn=await Session(sid).wire.Open(src,1,mode,ct);
            if(tid=="local")localOutput=new FileStream(dst,FileMode.CreateNew,FileAccess.Write,FileShare.None,65536,true);
            else hOut=await Session(tid).wire.Open(dst,42,mode,ct);
            long offset=0;
            while(true){
                ct.ThrowIfCancellationRequested();
                byte[]? chunk;
                if(localInput!=null){
                    var buffer=new byte[65536];int n=await localInput.ReadAsync(buffer,ct);chunk=n==0?null:buffer[..n];
                }else chunk=await Session(sid).wire.Read(hIn!,offset,65536,ct);
                if(chunk is not {Length:>0})break;
                if(localOutput!=null)await localOutput.WriteAsync(chunk,ct);
                else await Session(tid).wire.Write(hOut!,offset,chunk,ct);
                offset+=chunk.Length;job.bytes+=chunk.Length;Update(job);
            }
        }finally{
            if(localInput!=null)await localInput.DisposeAsync();
            if(localOutput!=null)await localOutput.DisposeAsync();
            if(hIn!=null)try{await Session(sid).wire.Close(hIn);}catch{}
            if(hOut!=null)try{await Session(tid).wire.Close(hOut);}catch{}
        }
    }
    async Task Run(TransferJob j){
        await transferLock.WaitAsync(j.cancel.Token);
        try{
            var ct=j.cancel.Token;j.status="scanning";Update(j);
            var entries=new List<(string src,string dest,FileEntry meta)>();
            var target=await Canon(j.targetId,j.targetPath);
            if((await Stat(j.targetId,target)).type!="directory")throw new IOException("目标不是文件夹");
            async Task Walk(string src,string dest,int depth){
                ct.ThrowIfCancellationRequested();
                if(depth>64||entries.Count>100000)throw new IOException("目录太深或文件太多");
                var meta=await Stat(j.sourceId,src);
                entries.Add((src,dest,meta));if(meta.type=="file"){j.count++;j.total+=meta.size;}if(meta.type=="symlink")j.count++;
                if(meta.type=="directory")foreach(var file in await List(j.sourceId,src))await Walk(j.sourceId=="local"?Path.Combine(src,file.name):Join(src,file.name),j.targetId=="local"?Path.Combine(dest,file.name):Join(dest,file.name),depth+1);
            }
            foreach(var source in j.paths){
                var src=Key(j.sourceId,source);
                var name=j.sourceId=="local"?Path.GetFileName(src.TrimEnd('\\','/')):src.Split('/').Last();
                var dest=j.targetId=="local"?Path.Combine(target,Safe(name)):Join(target,name);
                if(j.sourceId==j.targetId && (string.Equals(src,dest,StringComparison.OrdinalIgnoreCase)||dest.StartsWith(src.TrimEnd('/')+"/",StringComparison.Ordinal)))throw new IOException("不能复制到原位置或源目录内部");
                await Walk(src,dest,0);
            }
            j.status="running";Update(j);string? policy=null;var skipped=new List<string>();
            foreach(var (src,dest,meta) in entries){
                ct.ThrowIfCancellationRequested();
                if(skipped.Any(x=>dest==x||dest.StartsWith(x.TrimEnd('/')+"/",StringComparison.Ordinal)))continue;
                j.current=src;Update(j);
                var existing=await Exists(j.targetId,dest);
                if(existing!=null&&meta.type=="directory"&&existing.type=="directory")continue;
                if(existing!=null){
                    var answer=policy??await Ask("conflict","目标中存在同名项目",dest,$"来源：{j.sourceAlias}\n目标：{j.targetAlias}",canReplace:meta.type!="directory"&&existing.type!="directory",ct:ct);
                    if(answer?.EndsWith("-all")==true){policy=answer[..^4];answer=policy;}
                    if(answer=="cancel"||answer==null)throw new OperationCanceledException();
                    if(answer=="skip"||meta.type=="directory"||existing.type=="directory"){j.skipped++;if(meta.type=="directory")skipped.Add(dest);continue;}
                    if(answer!="replace")throw new IOException("无效的覆盖选项");
                }
                if(meta.type=="directory"){await Mkdir(j.targetId,dest);continue;}
                var temp=(j.targetId=="local"?Path.Combine(Path.GetDirectoryName(dest)!, ".server-explorer-"+Guid.NewGuid().ToString("N")+".part"):Join(Parent(dest),".server-explorer-"+Guid.NewGuid().ToString("N")+".part"));
                try{
                    if(meta.type=="symlink")await Symlink(j.targetId,await Link(j.sourceId,src),temp);
                    else await CopyBytes(j.sourceId,src,j.targetId,temp,meta.mode,meta.size,j);
                    await Rename(j.targetId,temp,dest,existing!=null);j.completed++;
                }finally{try{await Remove(j.targetId,temp,false);}catch{}}
            }
            j.status="done";j.current="";Update(j);
        }catch(OperationCanceledException){j.status="cancelled";Update(j);}
        catch(Exception ex){j.status="failed";j.error=ex.Message;Update(j);}
        finally{transferLock.Release();}
    }
    public bool HasActiveTransfers=>jobs.Values.Any(j=>j.status is "queued" or "scanning" or "running" or "waiting");
    public async Task<object?> Handle(string channel,JsonElement p){
        var id=Text(p,"id");var path=Text(p,"path");
        switch(channel){
            case "config:load":return await Discover();
            case "config:choose":{
                var reply=await host("choose",new{title="选择 SSH config",defaultPath=configPath,directory=false,multiple=false});
                if(reply.ValueKind!=JsonValueKind.Array||reply.GetArrayLength()==0)return null;
                configPath=reply[0].GetString()??configPath;await File.WriteAllTextAsync(Path.Combine(profile,"preferences.json"),JsonSerializer.Serialize(new{configPath}));
                return await Discover();
            }
            case "local:open":return new{id="local",alias="本地电脑",home=Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).Replace('\\','/'),local=true};
            case "local:choose":{
                var result=await host("choose",new{title=Bool(p,"directory")?"选择本地文件夹":"选择文件",directory=Bool(p,"directory"),multiple=Bool(p,"multiple"),defaultPath=Text(p,"purpose")=="download"?Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),"Downloads"):""});
                return result.ValueKind==JsonValueKind.Array?result.EnumerateArray().Select(x=>x.GetString()?.Replace('\\','/')).ToArray():null;
            }
            case "server:connect":{
                var alias=Text(p,"alias");var request=Text(p,"requestId");
                var list=JsonSerializer.Serialize(await Discover());
                using(var doc=JsonDocument.Parse(list))if(!doc.RootElement.GetProperty("servers").EnumerateArray().Any(x=>Text(x,"alias")==alias && (x.GetProperty("error").ValueKind==JsonValueKind.Null)))throw new IOException("未在 SSH 配置中找到该服务器");
                var cancel=new CancellationTokenSource();connecting[request]=cancel;
                var (pipe,token,worker)=await Askpass(request,cancel.Token);
                var vars=new Dictionary<string,string>{{"SSH_ASKPASS",askpassPath},{"SSH_ASKPASS_REQUIRE","force"},{"DISPLAY","server-explorer:0"},{"SERVER_EXPLORER_PIPE",pipe},{"SERVER_EXPLORER_TOKEN",token},{"SERVER_EXPLORER_REQUEST",request}};
                try{
                    var wire=await SftpWire.Connect(alias,configPath,vars,cancel.Token);
                    var home=await wire.RealPath(".");
                    var session=Guid.NewGuid().ToString();connections[session]=(alias,wire,alias);
                    return new{id=session,alias,home,connectionKey=alias};
                }finally{connecting.TryRemove(request,out _);cancel.Cancel();}
            }
            case "server:cancelConnect":if(connecting.TryGetValue(Text(p,"requestId"),out var c))c.Cancel();return null;
            case "server:disconnect":if(connections.Remove(id,out var closed)){await closed.wire.DisposeAsync();Event("server:closed",new{id,error="连接已关闭"});}return null;
            case "server:list":{
                var canonical=await Canon(id,path);return new{path=canonical.Replace('\\','/'),entries=(await List(id,canonical)).Select(View).ToArray()};
            }
            case "server:mkdir":{
                var dest=id=="local"?Path.Combine(path,Safe(Text(p,"name"))):Join(path,Text(p,"name"));await Mkdir(id,dest);return null;
            }
            case "files:rename":{
                var name=Safe(Text(p,"name"));var newName=Safe(Text(p,"newName"));
                var a=id=="local"?Path.Combine(path,name):Join(path,name);var b=id=="local"?Path.Combine(path,newName):Join(path,newName);
                if(await Exists(id,b)!=null)throw new IOException("同名项目已经存在");
                await Rename(id,a,b);return null;
            }
            case "files:delete":{
                var names=Strings(p,"names");if(names.Length==0||names.Length>1000)throw new IOException("请选择要删除的项目");
                var answer=await Ask("delete","永久删除所选项目？",$"将删除 {names.Length} 个项目。",string.Join("\n",names));
                if(answer!="delete")return null;
                var count=0;
                async Task DeleteTree(string file,int depth){
                    if(depth>64||count>=100000)throw new IOException("删除范围过大");
                    var type=(await Stat(id,file)).type;
                    if(type=="directory")foreach(var child in await List(id,file))await DeleteTree(id=="local"?Path.Combine(file,child.name):Join(file,child.name),depth+1);
                    await Remove(id,file,type=="directory");count++;
                }
                foreach(var name in names)await DeleteTree(id=="local"?Path.Combine(path,Safe(name)):Join(path,Safe(name)),0);
                return count;
            }
            case "transfer:inspect":{
                var same=Text(p,"sourceId")==Text(p,"targetId")||(Text(p,"sourceId")!="local"&&Text(p,"targetId")!="local"&&connections.TryGetValue(Text(p,"sourceId"),out var src)&&connections.TryGetValue(Text(p,"targetId"),out var dst)&&src.identity==dst.identity);
                var target=Text(p,"targetPath");var paths=Strings(p,"paths");
                return new{sameServer=same,sameDirectory=same&&paths.All(x=>Parent(x)==target.TrimEnd('/'))};
            }
            case "transfer:start":{
                var sid=Text(p,"sourceId");var tid=Text(p,"targetId");
                if(sid!="local")Session(sid);if(tid!="local")Session(tid);
                var paths=Strings(p,"paths");if(paths.Length==0||paths.Length>1000)throw new IOException("请选择文件");
                var j=new TransferJob{sourceId=sid,targetId=tid,sourceAlias=sid=="local"?"本地电脑":Session(sid).alias,targetAlias=tid=="local"?"本地电脑":Session(tid).alias,paths=paths,targetPath=Text(p,"targetPath")};
                jobs[j.id]=j;Update(j);_=Task.Run(()=>Run(j));return j.id;
            }
            case "transfer:cancel":if(jobs.TryGetValue(id,out var job))job.cancel.Cancel();return null;
            case "prompt:answer":Answer(id,p.TryGetProperty("value",out var v)&&v.ValueKind==JsonValueKind.String?v.GetString():null);return null;
            case "files:menu":{
                var items=new List<object>();
                var key=Text(p,"contextKey");
                int count=p.TryGetProperty("count",out var cn)?cn.GetInt32():0;
                foreach(var action in new[]{"download","desktop","rename","delete","mkdir","refresh"})
                    items.Add(new{label=action,action,enabled=count>0||action is "mkdir" or "refresh"});
                return new{__host="menu",contextKey=key,items};
            }
            case "files:prepareDesktop":{
                var paths=Strings(p,"paths");
                if(id=="local")return paths;
                throw new NotSupportedException("原生 WebView2 文件拖出尚未实现");
            }
            case "files:startDrag":return new{__host="drag",paths=Strings(p,"paths")};
            default:throw new NotSupportedException("尚未实现："+channel);
        }
    }
    public async Task Shutdown(){foreach(var c in connecting.Values)c.Cancel();foreach(var j in jobs.Values)j.cancel.Cancel();foreach(var s in connections.Values)await s.wire.DisposeAsync();}
}
