using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;

namespace ServerExplorer;

// SFTP v3 packets over ssh.exe -s <alias> sftp. OpenSSH retains SSH config,
// agent, ProxyJump/ProxyCommand, host-key checks and authentication.
internal sealed record FileEntry(string name, string type, long size, uint mode, long mtime);
internal sealed class SftpError(uint code, string message) : IOException(message)
{
    public uint Code { get; } = code;
}
internal sealed class PacketWriter
{
    readonly MemoryStream stream = new();
    public PacketWriter Byte(byte n) { stream.WriteByte(n); return this; }
    public PacketWriter U32(uint n) { Span<byte> b = stackalloc byte[4]; BinaryPrimitives.WriteUInt32BigEndian(b,n); stream.Write(b); return this; }
    public PacketWriter U64(ulong n) { Span<byte> b = stackalloc byte[8]; BinaryPrimitives.WriteUInt64BigEndian(b,n); stream.Write(b); return this; }
    public PacketWriter Bytes(byte[] n) { U32((uint)n.Length); stream.Write(n); return this; }
    public PacketWriter Text(string n) => Bytes(Encoding.UTF8.GetBytes(n));
    public byte[] Get() => stream.ToArray();
}
internal sealed class PacketReader(byte[] bytes)
{
    int at;
    public bool HasMore => at < bytes.Length;
    public byte[] Take(int count) {
        if(count<0 || count>bytes.Length-at) throw new IOException("SFTP 数据包不完整");
        var r=bytes.AsSpan(at,count).ToArray();at+=count;return r;
    }
    public uint U32() => BinaryPrimitives.ReadUInt32BigEndian(Take(4));
    public ulong U64() => BinaryPrimitives.ReadUInt64BigEndian(Take(8));
    public byte[] Bytes() { var n=U32();if(n>16*1024*1024)throw new IOException("SFTP 字符串过长");return Take((int)n); }
    public string Text() => Encoding.UTF8.GetString(Bytes());
    public FileEntry Attr(string name="") {
        uint flags=U32();ulong size=0;uint mode=0,mtime=0;
        if((flags&1)!=0)size=U64();
        if((flags&2)!=0){U32();U32();}
        if((flags&4)!=0)mode=U32();
        if((flags&8)!=0){U32();mtime=U32();}
        if((flags&0x80000000)!=0){uint n=U32();if(n>10000)throw new IOException("SFTP 扩展属性无效");for(int i=0;i<n;i++){Bytes();Bytes();}}
        var kind=(mode&0xf000) switch {0x4000=>"directory",0xa000=>"symlink",0x8000=>"file",_=>"other"};
        return new FileEntry(name,kind,checked((long)size),mode,mtime);
    }
}
internal sealed class SftpWire : IAsyncDisposable
{
    readonly Process proc;
    readonly SemaphoreSlim gate = new(1,1);
    readonly Stream input, output;
    readonly HashSet<string> extensions=new();
    uint sequence=1;
    string stderr="";
    SftpWire(Process process) {
        proc=process;input=proc.StandardInput.BaseStream;output=proc.StandardOutput.BaseStream;
        _=Task.Run(async()=>{
            try {var text=await proc.StandardError.ReadToEndAsync();stderr=text.Length>4000?text[^4000..]:text;}
            catch {}
        });
    }
    public bool HasCopyData=>extensions.Contains("copy-data");
    public static async Task<SftpWire> Connect(string alias,string configPath,Dictionary<string,string> askpassEnv,CancellationToken cancel) {
        var psi=new ProcessStartInfo("ssh") {CreateNoWindow=true,UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        foreach(var arg in new[]{"-F",configPath,"-o","ConnectTimeout=20","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=ask","-o","BatchMode=no","-o","RemoteCommand=none","-o","ClearAllForwardings=yes","-T","-s",alias,"sftp"})psi.ArgumentList.Add(arg);
        foreach(var (key,val) in askpassEnv)psi.Environment[key]=val;
        psi.Environment["SERVER_EXPLORER_ALIAS"]=alias;
        var process=Process.Start(psi)??throw new IOException("无法启动 Windows OpenSSH");
        var wire=new SftpWire(process);
        try {
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancel);
            timeout.CancelAfter(TimeSpan.FromSeconds(180));
            await wire.Send(new PacketWriter().Byte(1).U32(3).Get(),timeout.Token);
            var version=await wire.Receive(timeout.Token);
            if(version.Length<5 || version[0]!=2)throw new IOException("服务器未返回 SFTP 协议握手");
            var reader=new PacketReader(version[1..]);
            if(reader.U32()!=3)throw new IOException("服务器不支持 SFTP v3");
            while(reader.HasMore){wire.extensions.Add(reader.Text());reader.Text();}
            return wire;
        }catch(Exception ex){
            await wire.DisposeAsync();
            throw new IOException("SSH 连接失败："+(wire.stderr.Trim().Length>0?wire.stderr.Trim():ex.Message),ex);
        }
    }
    async Task Send(byte[] payload,CancellationToken ct) {
        if(payload.Length>16*1024*1024)throw new IOException("SFTP 包超过限制");
        var frame=new byte[payload.Length+4];BinaryPrimitives.WriteUInt32BigEndian(frame,(uint)payload.Length);payload.CopyTo(frame,4);
        await input.WriteAsync(frame,ct);await input.FlushAsync(ct);
    }
    async Task<byte[]> Receive(CancellationToken ct) {
        var header=new byte[4];await output.ReadExactlyAsync(header,ct);
        uint size=BinaryPrimitives.ReadUInt32BigEndian(header);
        if(size==0 || size>16*1024*1024)throw new IOException("SFTP 数据包长度无效");
        var data=new byte[(int)size];await output.ReadExactlyAsync(data,ct);return data;
    }
    async Task<(byte type,PacketReader reader)> Request(byte type,Action<PacketWriter> write,CancellationToken ct=default) {
        await gate.WaitAsync(ct);
        try {
            using var timeout=CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(60));
            var id=sequence++;
            var message=new PacketWriter().Byte(type).U32(id);write(message);
            await Send(message.Get(),timeout.Token);
            var reply=await Receive(timeout.Token);
            var reader=new PacketReader(reply[1..]);
            if(reader.U32()!=id)throw new IOException("SFTP 响应序号不一致");
            if(reply[0]==101) {
                var code=reader.U32();var description=reader.Text();
                if(code!=0)throw new SftpError(code,string.IsNullOrWhiteSpace(description)?$"SFTP 错误 {code}":description);
            }
            return (reply[0],reader);
        }finally{gate.Release();}
    }
    static PacketReader Need((byte type,PacketReader reader) result,byte kind){
        if(result.type!=kind)throw new IOException($"SFTP 响应类型无效：{result.type}");
        return result.reader;
    }
    public async Task<string> RealPath(string p,CancellationToken ct=default){
        var r=Need(await Request(16,w=>w.Text(p),ct),104);
        if(r.U32()<1)throw new IOException("无法解析路径");
        return r.Text();
    }
    public async Task<FileEntry> Stat(string p,CancellationToken ct=default) =>
        Need(await Request(7,w=>w.Text(p),ct),105).Attr(Path.GetFileName(p));
    public async Task<FileEntry?> Exists(string p,CancellationToken ct=default) {
        try{return await Stat(p,ct);}catch(SftpError e)when(e.Code==2){return null;}
    }
    public async Task<List<FileEntry>> List(string p,CancellationToken ct=default){
        var h=Need(await Request(11,w=>w.Text(p),ct),102).Bytes();
        var list=new List<FileEntry>();
        try {
            while(true){
                (byte type,PacketReader reader) reply;
                try{reply=await Request(12,w=>w.Bytes(h),ct);}catch(SftpError e)when(e.Code==1){break;}
                var r=Need(reply,104);uint n=r.U32();
                if(n>100000)throw new IOException("SFTP 返回过多条目");
                for(int i=0;i<n;i++){
                    var name=r.Text();r.Text();var entry=r.Attr(name);
                    if(name!="."&&name!="..")list.Add(entry);
                }
                if(n==0)break;
            }
        }finally{try{await Close(h);}catch{}}
        return list.OrderBy(x=>x.type=="directory"?0:1).ThenBy(x=>x.name,StringComparer.CurrentCultureIgnoreCase).ToList();
    }
    public async Task<byte[]> Open(string p,uint flags,uint mode=420,CancellationToken ct=default) =>
        Need(await Request(3,w=>w.Text(p).U32(flags).U32(4).U32(mode&511),ct),102).Bytes();
    public async Task Close(byte[] handle,CancellationToken ct=default)=> await Request(4,w=>w.Bytes(handle),ct);
    public async Task<byte[]?> Read(byte[] h,long offset,int amount,CancellationToken ct=default){
        try{return Need(await Request(5,w=>w.Bytes(h).U64((ulong)offset).U32((uint)amount),ct),103).Bytes();}
        catch(SftpError e)when(e.Code==1){return null;}
    }
    public async Task Write(byte[] h,long offset,byte[] content,CancellationToken ct=default)=>
        await Request(6,w=>w.Bytes(h).U64((ulong)offset).Bytes(content),ct);
    public async Task Mkdir(string p,CancellationToken ct=default)=>await Request(14,w=>w.Text(p).U32(4).U32(493),ct);
    public async Task Remove(string p,CancellationToken ct=default)=>await Request(13,w=>w.Text(p),ct);
    public async Task Rmdir(string p,CancellationToken ct=default)=>await Request(15,w=>w.Text(p),ct);
    public async Task Rename(string a,string b,CancellationToken ct=default)=>await Request(18,w=>w.Text(a).Text(b),ct);
    public async Task PosixRename(string a,string b,CancellationToken ct=default)=>await Request(200,w=>w.Text("posix-rename@openssh.com").Text(a).Text(b),ct);
    public async Task<string> Readlink(string p,CancellationToken ct=default){
        var r=Need(await Request(19,w=>w.Text(p),ct),104);
        if(r.U32()<1)throw new IOException("无法读取符号链接");
        return r.Text();
    }
    public async Task Symlink(string target,string p,CancellationToken ct=default)=>await Request(20,w=>w.Text(target).Text(p),ct);
    public async Task CopyData(string src,string dest,long size,uint mode,Action<int> progress,CancellationToken ct){
        if(!HasCopyData)throw new NotSupportedException("服务器不支持 copy-data 扩展");
        var a=await Open(src,1,mode,ct);
        byte[]? b=null;
        try{
            b=await Open(dest,42,mode,ct);
            for(long at=0;at<size;){
                ct.ThrowIfCancellationRequested();
                var n=(uint)Math.Min(4*1024*1024,size-at);
                await Request(200,w=>w.Text("copy-data").Bytes(a).U64((ulong)at).U64(n).Bytes(b).U64((ulong)at),ct);
                at+=n;progress((int)n);
            }
        }finally{try{await Close(a);}catch{}if(b!=null)try{await Close(b);}catch{}}
    }
    public async ValueTask DisposeAsync(){
        try{if(!proc.HasExited)proc.Kill(entireProcessTree:true);}catch{}
        try{await proc.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3));}catch{}
        proc.Dispose();gate.Dispose();
    }
}
