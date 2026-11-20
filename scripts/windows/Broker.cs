// Build with the Windows .NET Framework compiler. Fixture transport is compiled separately.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

class Broker : ServiceBase {
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint mode, uint instances,
        uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes security);
    const string Service = "PocketArchiveBroker";
    const int ResultLimit = 2 * 1024 * 1024, InboxLimit = 100 * 1024 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = ResultLimit };
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static HttpClient api;
    static string pipeName;
    static NamedPipeServerStream pipe;
    static volatile bool stopped;
    static SecurityIdentifier Account(string name) {
        return (SecurityIdentifier)new NTAccount(name).Translate(typeof(SecurityIdentifier));
    }
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, byte[] descriptor);
    static void Initialize(string[] args) {
        var self = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier client;
        Uri origin;
        string token;
        pipeName = Service;
#if FIXTURE
        client = self;
        origin = new Uri("http://127.0.0.1:" + int.Parse(args[0]));
        pipeName += "-" + Guid.Parse(args[1]).ToString("N");
        token = "fixture-only";
#else
        if (!self.Equals(Account(@"NT SERVICE\PocketArchiveBroker"))) throw new InvalidOperationException("Wrong service identity");
        var descriptor = new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + self.Value + ")");
        byte[] acl = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(acl, 0);
        if (!SetKernelObjectSecurity(new IntPtr(-1), 4, acl)) throw new InvalidOperationException("Process ACL failed");
        var root = AppDomain.CurrentDomain.BaseDirectory;
        client = new SecurityIdentifier(File.ReadAllText(Path.Combine(root,"runner.sid")).Trim());
        if (client.Equals(self)) throw new InvalidOperationException("Distinct identities required");
        origin = new Uri(File.ReadAllText(Path.Combine(root,"origin.txt")).Trim());
        if (origin.Scheme != "https" || origin.GetLeftPart(UriPartial.Authority) + "/" != origin.AbsoluteUri ||
            origin.UserInfo != "" || origin.Host.TrimEnd('.').Equals("pocket-archive.goma555416.workers.dev", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("An isolated HTTPS origin is required");
        token = File.ReadAllText(Path.Combine(root,"agent.secret")).Trim();
        if (!Regex.IsMatch(token, @"\Apa_agent_[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{32,128}\z")) throw new InvalidOperationException("Invalid credential format");
#endif
        var security = new PipeSecurity();
        security.SetOwner(self);
        security.SetSecurityDescriptorSddlForm("D:P(D;;GA;;;NU)(A;;GA;;;" + self.Value + ")(A;;0x120003;;;" + client.Value + ")", AccessControlSections.Access);
        // One persistent first instance prevents replacing the server between requests.
        var pinned = GCHandle.Alloc(security.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
        try {
            var attributes = new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)), descriptor=pinned.AddrOfPinnedObject() };
            var handle=CreateNamedPipe(@"\\.\pipe\"+pipeName,0x40080003,8,1,65536,65536,0,ref attributes);
            if(handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
        } finally { pinned.Free(); }
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        api = new HttpClient(new HttpClientHandler { AllowAutoRedirect=false, UseProxy=false, UseCookies=false }) {
            BaseAddress=origin, Timeout=TimeSpan.FromSeconds(45), MaxResponseContentBufferSize=InboxLimit
        };
        api.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",token);
    }

    static byte[] Call(HttpMethod method, string path, byte[] body, bool claim=false) {
        using (var request = new HttpRequestMessage(method,path)) {
            if (body != null) {
                request.Content=new ByteArrayContent(body);
                request.Content.Headers.ContentType=new MediaTypeHeaderValue("application/json");
            }
            using (var reply=api.SendAsync(request).GetAwaiter().GetResult()) {
                if (claim && (reply.StatusCode==HttpStatusCode.NoContent || reply.StatusCode==HttpStatusCode.Conflict)) return null;
                reply.EnsureSuccessStatusCode();
                return reply.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
            }
        }
    }
    static Dictionary<string,object> Job(byte[] bytes) {
        return (Dictionary<string,object>)Json.Deserialize<Dictionary<string,object>>(Utf8.GetString(bytes))["job"];
    }
    static byte[] Read(int size, DateTime until) {
        byte[] data=new byte[size];
        for (int offset=0;offset<size;) {
            var task=pipe.ReadAsync(data,offset,size-offset);
            var remaining=until-DateTime.UtcNow;
            if (remaining<=TimeSpan.Zero || !task.Wait(remaining)) throw new System.TimeoutException();
            int n=task.Result;
            if(n==0) throw new EndOfStreamException();
            offset+=n;
        }
        return data;
    }
    static void Send(byte[] bytes) {
        foreach (var part in new[]{BitConverter.GetBytes(bytes.Length),bytes}) {
            if(!pipe.WriteAsync(part,0,part.Length).Wait(TimeSpan.FromSeconds(30))) throw new System.TimeoutException();
        }
    }
    static void Session() {
        if (Read(1,DateTime.UtcNow.AddSeconds(5))[0]!=1) throw new InvalidDataException();
        var binding=Call(HttpMethod.Post,"/api/ai/agent/claim",null,true);
        if(binding==null) { Send(new byte[0]); return; }
        var claimed=Job(binding);
        var id=(string)claimed["exportId"];
        var attempt=(int)claimed["attempt"];
        if(!Regex.IsMatch(id,@"\Aexport-[A-Za-z0-9._:-]{1,110}\z") || attempt<1) throw new InvalidDataException();
        string path="/api/ai/agent/jobs/"+Uri.EscapeDataString(id), query="?attempt="+attempt;
        var metadata=Call(HttpMethod.Get,path+query,null);
        var info=Job(metadata);
        if((string)info["exportId"]!=id || (int)info["attempt"]!=attempt) throw new InvalidDataException();
        var inbox=Call(HttpMethod.Get,path+"/inbox"+query,null);
        using(var sha=SHA256.Create())
            if(BitConverter.ToString(sha.ComputeHash(inbox)).Replace("-","").ToLowerInvariant()!=(string)info["inboxSha256"]) throw new InvalidDataException();
        Send(metadata);
        Send(inbox);
        var until=DateTime.UtcNow.AddMinutes(50);
        int length=BitConverter.ToInt32(Read(4,until),0);
        if(length<=0 || length>ResultLimit) throw new InvalidDataException();
        var result=Read(length,until);
        if ((string)Json.Deserialize<Dictionary<string,object>>(Utf8.GetString(result))["source_export_id"]!=id) throw new InvalidDataException();
        var ready=Job(Call(HttpMethod.Put,path+"/result"+query,result));
        if((string)ready["status"]!="ready") throw new InvalidDataException();
        Send(Utf8.GetBytes("ready"));
        if(!Task.Run(() => pipe.WaitForPipeDrain()).Wait(TimeSpan.FromSeconds(30))) throw new System.TimeoutException();
    }
    static void Loop() {
        while(!stopped) {
            try { pipe.WaitForConnection(); Session(); }
            catch(Exception e) {
                // No response bodies, URLs, credentials or batch content in diagnostics.
                if(!stopped) Console.Error.WriteLine(e.GetType().Name);
            } finally { if(!stopped && pipe.IsConnected) pipe.Disconnect(); }
        }
    }
    protected override void OnStart(string[] args) { Initialize(args); new Thread(Loop){IsBackground=true}.Start(); }
    protected override void OnStop() { stopped=true; pipe.Dispose(); api.Dispose(); }
    static void Main(string[] args) {
#if FIXTURE
        Initialize(args); Console.WriteLine("listening"); Loop();
#else
        ServiceBase.Run(new Broker { ServiceName=Service });
#endif
    }
}
