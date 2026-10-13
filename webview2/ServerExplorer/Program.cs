using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ServerExplorer;
internal static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new ExplorerForm());
    }
}
internal sealed class ExplorerForm : Form
{
    readonly WebView2 web = new() { Dock = DockStyle.Fill };
    NativeCore? native;
    bool quitting;
    public ExplorerForm()
    {
        Text = "Server Explorer";
        Width = 1480; Height = 940; MinimumSize = new System.Drawing.Size(1000,680);
        Controls.Add(web);
        Load += async (_,_) => await Start();
        FormClosing += OnClosing;
    }
    async Task Start()
    {
        try
        {
            var baseDir = AppContext.BaseDirectory;
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ServerExplorer", "WebView2");
            Directory.CreateDirectory(userData);
            await web.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(userDataFolder:userData));
            web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsWebMessageEnabled = true;
            web.CoreWebView2.NavigationStarting += (_,e) => {
                if (!e.Uri.StartsWith("https://app.server-explorer.invalid/",StringComparison.OrdinalIgnoreCase)) e.Cancel=true;
            };
            web.CoreWebView2.WebMessageReceived += async (_,e) => {
                try { await FromPage(JsonDocument.Parse(e.WebMessageAsJson).RootElement.Clone()); } catch(Exception error) { Debug.WriteLine(error); }
            };
            web.CoreWebView2.SetVirtualHostNameToFolderMapping("app.server-explorer.invalid",
                Path.Combine(baseDir,"renderer"),CoreWebView2HostResourceAccessKind.DenyCors);
            native = new NativeCore(SendPage, HostRequest, Path.Combine(baseDir,"askpass.exe"));
            web.CoreWebView2.Navigate("https://app.server-explorer.invalid/index.html");
        }
        catch(Exception error) { MessageBox.Show(this,error.Message,"Server Explorer 启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error); Close(); }
    }
    void SendPage(object value) {
        if(web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(value));
    }
    static string Str(JsonElement element,string property,string fallback="") =>
        element.TryGetProperty(property,out var v) && v.ValueKind==JsonValueKind.String ? v.GetString()??fallback:fallback;
    async Task<JsonElement> HostRequest(string name,object options)
    {
        if(name=="choose")
        {
            using var doc=JsonDocument.Parse(JsonSerializer.Serialize(options));
            var files=Choose(doc.RootElement);
            return JsonSerializer.SerializeToElement(files);
        }
        return JsonSerializer.SerializeToElement((object?)null);
    }
    async Task FromPage(JsonElement msg)
    {
        if(Str(msg,"type")!="request")return;
        var id=Str(msg,"id");var channel=Str(msg,"channel");
        try {
            var payload=msg.TryGetProperty("payload",out var p)?p:JsonSerializer.SerializeToElement(new{});
            object? value;
            if(channel=="native:filePath"){value="";}
            else if(channel=="native:canClose"){value=native?.HasActiveTransfers??false;}
            else if(native==null)throw new InvalidOperationException("原生后端未启动");
            else value=await native.Handle(channel,payload);
            if(value!=null && JsonSerializer.SerializeToElement(value) is JsonElement v && v.ValueKind==JsonValueKind.Object && v.TryGetProperty("__host",out var hostName)){
                if(hostName.GetString()=="menu"){ShowMenu(v);value=null;}
                else if(hostName.GetString()=="drag"){StartDrag(v);value=null;}
            }
            SendPage(new{type="response",id,ok=true,value});
        }catch(Exception error){SendPage(new{type="response",id,ok=false,error=error.Message});}
    }
    string[]? Choose(JsonElement options)
    {
        var directory=options.TryGetProperty("directory",out var d)&&d.GetBoolean();
        if(directory) {
            using var dialog=new FolderBrowserDialog { Description=Str(options,"title") };
            var initial=Str(options,"defaultPath");
            if(Directory.Exists(initial))dialog.InitialDirectory=initial;
            return dialog.ShowDialog(this)==DialogResult.OK?new[]{dialog.SelectedPath}:null;
        }
        using var file=new OpenFileDialog {Title=Str(options,"title"),
            Multiselect=options.TryGetProperty("multiple",out var m)&&m.GetBoolean(),
            CheckFileExists=true};
        return file.ShowDialog(this)==DialogResult.OK?file.FileNames:null;
    }
    void ShowMenu(JsonElement value)
    {
        var contextKey=Str(value,"contextKey");
        var menu=new ContextMenuStrip();
        foreach(var item in value.GetProperty("items").EnumerateArray())AddItem(menu.Items,item,contextKey);
        menu.Closed+=(_,_)=>menu.Dispose();
        menu.Show(Cursor.Position);
    }
    void AddItem(ToolStripItemCollection items,JsonElement item,string key)
    {
        if(item.TryGetProperty("separator",out var s)&&s.GetBoolean()){items.Add(new ToolStripSeparator());return;}
        var entry=new ToolStripMenuItem(Str(item,"label"));
        if(item.TryGetProperty("enabled",out var en))entry.Enabled=en.GetBoolean();
        if(item.TryGetProperty("submenu",out var sub))foreach(var child in sub.EnumerateArray())AddItem(entry.DropDownItems,child,key);
        if(item.TryGetProperty("action",out var action))entry.Click+=(_,_)=>SendPage(new {
            type="event",channel="files:menuAction",value=new {contextKey=key,action=action.GetString(),targetKey=Str(item,"targetKey")}
        });
        items.Add(entry);
    }
    void StartDrag(JsonElement value)
    {
        // Windows native OLE drag needs a synchronous mouse drag context.
        // WebView2 does not expose Electron's startDrag API. Renderer fallback remains available.
        Debug.WriteLine("Native outgoing drag is not yet supported by this experimental host.");
    }
    void OnClosing(object? sender,FormClosingEventArgs e)
    {
        if(!quitting && native?.HasActiveTransfers==true) {
            var choice=MessageBox.Show(this,"仍有文件正在传输，确定取消任务并退出？","退出应用",MessageBoxButtons.YesNo,MessageBoxIcon.Warning);
            if(choice!=DialogResult.Yes){e.Cancel=true;return;}
        }
        quitting=true;
        if(native!=null)native.Shutdown().GetAwaiter().GetResult();
    }
}
