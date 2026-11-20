using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Security.Principal;
using System.Threading;
class Runner {
    static byte[] Read(Stream stream,int size) {
        var bytes=new byte[size];
        for(int offset=0;offset<size;) {
            int count=stream.Read(bytes,offset,size-offset);
            if(count==0) throw new EndOfStreamException();
            offset+=count;
        }
        return bytes;
    }
    static byte[] Frame(Stream stream,int max) {
        int size=BitConverter.ToInt32(Read(stream,4),0);
        if(size<0 || size>max) throw new InvalidDataException();
        return Read(stream,size);
    }
    static string Quote(string value) {
        if(value.Contains("\"")) throw new ArgumentException();
        return "\""+value+"\"";
    }
    static int Main(string[] args) {
        if(args.Length!=4) return 2; // repo, Node executable, pipe, server owner SID
        bool created;
        using(var mutex=new Mutex(true,@"Local\PocketArchiveRunner",out created)) {
            if(!created) return 3;
            Console.WriteLine("runner-started");
            string root=Path.GetFullPath(args[0]);
            var stop=Path.Combine(root,"private-data","runner.stop");
            Directory.CreateDirectory(Path.GetDirectoryName(stop));
            while(!File.Exists(stop)) {
                try {
                    using(var pipe=new NamedPipeClientStream(".",args[2],
                        PipeAccessRights.ReadData|PipeAccessRights.WriteData|PipeAccessRights.ReadPermissions,
                        PipeOptions.None,TokenImpersonationLevel.Anonymous,HandleInheritability.None)) {
                        pipe.Connect(5000);
                        var owner=(SecurityIdentifier)pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier));
                        if(owner.Value!=args[3]) throw new UnauthorizedAccessException("Broker owner mismatch");
                        pipe.WriteByte(1);
                        var meta=Frame(pipe,2*1024*1024);
                        if(meta.Length==0) { Pause(stop); continue; }
                        var inbox=Frame(pipe,100*1024*1024);
                        string directory=Path.Combine(root,"private-data","runner-"+Guid.NewGuid().ToString("N"));
                        Directory.CreateDirectory(directory);
                        File.WriteAllBytes(Path.Combine(directory,"job.json"),meta);
                        File.WriteAllBytes(Path.Combine(directory,"inbox.bin"),inbox);
                        var start=new ProcessStartInfo(args[1],
                            #if FIXTURE
                            Quote(Path.Combine(root,"tests","fixtures","runner-executor.mjs"))+" "+Quote(directory)) {
#else
                            Quote(Path.Combine(root,"scripts","windows","execute-batch.mjs"))+" "+Quote(directory)) {
#endif
                            WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true
                        };
                        foreach(string key in new[]{"PA_AGENT_TOKEN","HTTPS_PROXY","HTTP_PROXY","ALL_PROXY"})
                            start.EnvironmentVariables.Remove(key);
                        using(var child=Process.Start(start)) {
                            if(!child.WaitForExit(45*60*1000)) { child.Kill(); throw new TimeoutException(); }
                            if(child.ExitCode!=0) throw new InvalidOperationException("Executor failed");
                        }
                        var resultPath=Path.Combine(directory,"organized.json");
                        if(new FileInfo(resultPath).Length>2*1024*1024) throw new InvalidDataException();
                        var bytes=File.ReadAllBytes(resultPath);
                        File.WriteAllText(Path.Combine(directory,"submission-started"),"Preserve for reconciliation");
                        var header=BitConverter.GetBytes(bytes.Length);
                        pipe.Write(header,0,4);pipe.Write(bytes,0,bytes.Length);pipe.Flush();
                        if(System.Text.Encoding.UTF8.GetString(Frame(pipe,32))!="ready") throw new InvalidDataException();
                        File.WriteAllText(Path.Combine(directory,"ready"),"Worker acknowledged");
                    }
                } catch(Exception e) { Console.Error.WriteLine(e.GetType().Name); }
                // Reconnect claims only queued work; a lost running binding is never replayed.
                Pause(stop);
            }
            mutex.ReleaseMutex();
        }
        return 0;
    }
    static void Pause(string stop) {
        for(int i=0;i<60 && !File.Exists(stop);i++) Thread.Sleep(500);
    }
}
