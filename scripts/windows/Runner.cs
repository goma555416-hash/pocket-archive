using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Security.Principal;
using System.Threading;
using System.Runtime.InteropServices;
class Runner {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcesses;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits basic;
        public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static IntPtr lifetimeJob;
    static string logPath;
    static void Log(string message) {
        Console.WriteLine(message);
        File.AppendAllText(logPath,DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine);
    }
    static void BindProcessLifetime() {
        lifetimeJob=CreateJobObject(IntPtr.Zero,null);
        var limits=new ExtendedLimits();
        limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if(lifetimeJob==IntPtr.Zero ||
            !SetInformationJobObject(lifetimeJob,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
            !AssignProcessToJobObject(lifetimeJob,new IntPtr(-1)))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        // Bind before spawning; only this process owns the non-inherited handle, closed by Windows on exit.
    }
    static byte[] Read(Stream stream,int size) {
        var bytes=new byte[size];
        var until=DateTime.UtcNow.AddMinutes(3);
        for(int offset=0;offset<size;) {
            var pending=stream.ReadAsync(bytes,offset,size-offset);
            while(!pending.Wait(500)) if(DateTime.UtcNow>=until) throw new TimeoutException();
            if(DateTime.UtcNow>=until) throw new TimeoutException();
            int count=pending.Result;
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
        bool eventMode=args.Length>0 && args[args.Length-1]=="--event";
        int argumentCount=args.Length-(eventMode?1:0);
        if(argumentCount!=4 && argumentCount!=5) return 2;
        if(argumentCount==5 && (!Path.IsPathRooted(args[4]) || !File.Exists(args[4]))) return 2;
        bool created;
        using(var mutex=new Mutex(true,@"Local\PocketArchiveRunner",out created)) {
            if(!created) return 3;
            BindProcessLifetime();
            string root=Path.GetFullPath(args[0]);
            var stop=Path.Combine(root,"private-data","runner.stop");
            Directory.CreateDirectory(Path.GetDirectoryName(stop));
            logPath=Path.Combine(root,"private-data","runner-events.log");
            if(eventMode) {
                var last=Path.Combine(root,"private-data","runner-last-event");
                var age=DateTime.UtcNow-File.GetLastWriteTimeUtc(last);
                if(File.Exists(last) && age>=TimeSpan.Zero && age<TimeSpan.FromMinutes(1)) { Log("event-debounced"); return 0; }
                File.WriteAllText(last,DateTime.UtcNow.ToString("o"));
            }
            Log("runner-started");
            int failures=0;
            while(!File.Exists(stop)) {
                bool bound=false;
                try {
                    using(var pipe=new NamedPipeClientStream(".",args[2],
                        PipeAccessRights.ReadData|PipeAccessRights.WriteData|PipeAccessRights.ReadAttributes|PipeAccessRights.ReadPermissions,
                        PipeOptions.Asynchronous,TokenImpersonationLevel.Anonymous,HandleInheritability.None)) {
                        pipe.Connect(5000);
                        var owner=(SecurityIdentifier)pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier));
                        if(owner.Value!=args[3]) throw new UnauthorizedAccessException("Broker owner mismatch");
                        pipe.WriteByte(1);
                        var meta=Frame(pipe,2*1024*1024);
                        if(meta.Length==0) { Log("queue-empty"); return 0; }
                        bound=true;
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
                        if(argumentCount==5)start.EnvironmentVariables["PA_CODEX_EXECUTABLE"]=args[4];
                        using(var child=Process.Start(start)) {
#if SLEEP_PROBE
                            const int executorTimeout=60000;
#elif FIXTURE && !CODEX_PROBE
                            const int executorTimeout=5000;
#else
                            const int executorTimeout=45*60*1000;
#endif
                            // Exit closes the lifetime job and reclaims descendants even if the executor has already exited.
                            var until=DateTime.UtcNow.AddMilliseconds(executorTimeout);
                            while(!child.WaitForExit(500)) if(DateTime.UtcNow>=until) { Log("executor-deadline"); return 4; }
                            // Windows waits can exclude sleep time; wall-clock expiry must be checked even when the child just exited.
                            if(DateTime.UtcNow>=until) { Log("executor-deadline"); return 4; }
                            if(child.ExitCode!=0) { Log("executor-failed"); return 4; }
                        }
                        var resultPath=Path.Combine(directory,"organized.json");
                        if(new FileInfo(resultPath).Length>2*1024*1024) throw new InvalidDataException();
                        var bytes=File.ReadAllBytes(resultPath);
                        File.WriteAllText(Path.Combine(directory,"submission-started"),"Preserve for reconciliation");
                        var header=BitConverter.GetBytes(bytes.Length);
                        pipe.Write(header,0,4);pipe.Write(bytes,0,bytes.Length);pipe.Flush();
                        if(System.Text.Encoding.UTF8.GetString(Frame(pipe,32))!="ready") throw new InvalidDataException();
                        File.WriteAllText(Path.Combine(directory,"ready"),"Worker acknowledged");
                        failures=0;
                        Log("result-ready");
                    }
                } catch(Exception e) {
                    Log(e.GetType().Name);
                    // An uncertain binding/result is preserved and never replayed, including after sleep.
                    if(bound) { Log("binding-stopped-preserve-evidence"); return 4; }
                    if(++failures>=4) { Log("connection-retries-exhausted"); return 5; }
                    Log("connection-retry");
#if FIXTURE
                    int delay=500;
#else
                    int delay=15000;
#endif
                    Pause(stop,delay*(1<<(failures-1)));
                }
            }
            mutex.ReleaseMutex();
        }
        return 0;
    }
    static void Pause(string stop,int delay) {
        for(int elapsed=0;elapsed<delay && !File.Exists(stop);elapsed+=100) Thread.Sleep(100);
    }
}
