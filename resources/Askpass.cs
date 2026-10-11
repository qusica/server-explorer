using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
class Askpass {
  [STAThread]
  static int Main(string[] args) {
    try {
      using (var pipe = new NamedPipeClientStream(".", Environment.GetEnvironmentVariable("SERVER_EXPLORER_PIPE"), PipeDirection.InOut)) {
        pipe.Connect(10000);
        using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
        using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true)) {
          writer.AutoFlush = true;
          writer.WriteLine(Environment.GetEnvironmentVariable("SERVER_EXPLORER_TOKEN"));
          writer.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.GetEnvironmentVariable("SERVER_EXPLORER_ALIAS") ?? "SSH")));
          writer.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(args.Length > 0 ? args[0] : "SSH authentication")));
          writer.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(Environment.GetEnvironmentVariable("SERVER_EXPLORER_REQUEST") ?? "")));
          var answer = reader.ReadLine();
          if (answer == null || answer == "CANCEL") return 1;
          Console.Out.WriteLine(Encoding.UTF8.GetString(Convert.FromBase64String(answer)));
          return 0;
        }
      }
    } catch { return 1; }
  }
}
