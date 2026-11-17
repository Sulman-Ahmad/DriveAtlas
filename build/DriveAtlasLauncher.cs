// DriveAtlas.exe: the Windows launcher. One file that carries the whole app (app.zip) and the official Node.js
// installer (node-installer.msi), and shows a tray icon while DriveAtlas runs.
//   DriveAtlas.exe          start DriveAtlas and open its window (or just open a window if it is already running)
//   DriveAtlas.exe --hub    start only the hub in the background (used by the "start with Windows" shortcut)
//   DriveAtlas.exe --exit   ask a running DriveAtlas to stop, exactly like Exit in the tray menu
// Built by build\Build-DriveAtlas.ps1 with the C# compiler that ships with Windows (.NET Framework 4, C# 5).
// For tests only: DRIVEATLAS_HOME moves the install folder and DRIVEATLAS_PORT the hub's port.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace DriveAtlasLauncher
{
    static class Paths
    {
        public static readonly string Override = Environment.GetEnvironmentVariable("DRIVEATLAS_HOME");
        // The same folder the hub uses for its settings, its window profile and its log; the catalog is in Home\data.
        public static readonly string Home = string.IsNullOrEmpty(Override)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DriveAtlas")
            : Path.GetFullPath(Override);
        public static readonly string App = Path.Combine(Home, "app");
        public static readonly string Stamp = Path.Combine(Home, "app.version");
        public static readonly string InstalledExe = Path.Combine(Home, "DriveAtlas.exe");
        public static readonly string WindowProfile = Path.Combine(Home, "window");
        public static readonly string Log = Path.Combine(Home, "launcher.log");
        public static readonly int Port = ReadPort();

        static int ReadPort()
        {
            int p;
            string v = Environment.GetEnvironmentVariable("DRIVEATLAS_PORT");
            return (!string.IsNullOrEmpty(v) && int.TryParse(v, out p) && p > 1024 && p < 65536) ? p : 7420;
        }
        public static string Url { get { return string.Format("http://localhost:{0}/", Port); } }
    }

    static class Log
    {
        static readonly object Gate = new object();
        public static void Write(string format, params object[] args)
        {
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(Paths.Home);
                    FileInfo fi = new FileInfo(Paths.Log);
                    if (fi.Exists && fi.Length > 256 * 1024) File.Delete(Paths.Log);
                    File.AppendAllText(Paths.Log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + string.Format(format, args) + Environment.NewLine);
                }
            }
            catch { /* logging must never stop the app */ }
        }
    }

    static class Program
    {
        const string Title = "DriveAtlas";

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e) { Log.Write("internal error: {0}", e.Exception); };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e) { Log.Write("fatal error: {0}", e.ExceptionObject); };
            bool hubOnly = HasArg(args, "--hub"), exit = HasArg(args, "--exit");

            if (exit)
            {
                bool signalled = Signals.RequestExit();
                return signalled ? 0 : 1;
            }

            bool first;
            using (Mutex single = new Mutex(true, Signals.Name("Launcher"), out first))
            {
                if (!first)
                {
                    // DriveAtlas is already running from this exe: just open another window.
                    if (!hubOnly) Browser.Open();
                    return 0;
                }
                try
                {
                    Log.Write("DriveAtlas launcher {0} starting from {1}{2}", Build.Version, Application.ExecutablePath, hubOnly ? " (hub only)" : "");
                    Installer.Install();
                    Installer.ExtractApp();
                    string node = NodeJs.Find();
                    if (node == null) node = NodeJs.Install();
                    if (node == null) return 1;
                    Application.Run(new TrayApp(node, hubOnly));
                    return 0;
                }
                catch (Exception e)
                {
                    Log.Write("failed: {0}", e);
                    MessageBox.Show("DriveAtlas could not start:\n\n" + e.Message + "\n\nDetails are in " + Paths.Log, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                finally
                {
                    single.ReleaseMutex();
                }
            }
        }

        static bool HasArg(string[] args, string name)
        {
            foreach (string a in args ?? new string[0]) if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }

    static class Signals
    {
        // Per user, per port, so a test copy on another port never touches the real one.
        public static string Name(string what) { return string.Format("Local\\DriveAtlas.{0}.{1}", what, Paths.Port); }

        public static bool RequestExit()
        {
            EventWaitHandle ev;
            if (!EventWaitHandle.TryOpenExisting(Name("Exit"), out ev)) return false;
            using (ev) ev.Set();
            return true;
        }
    }

    static class Installer
    {
        // Keeps a copy of this exe in %LOCALAPPDATA%\DriveAtlas (next to the app) and a Start menu shortcut to it,
        // so DriveAtlas starts from the Start menu wherever the exe was downloaded.
        public static void Install()
        {
            string self = Path.GetFullPath(Application.ExecutablePath);
            if (string.Equals(self, Paths.InstalledExe, StringComparison.OrdinalIgnoreCase)) return;
            Directory.CreateDirectory(Paths.Home);
            if (!File.Exists(Paths.InstalledExe) || !SameFile(self, Paths.InstalledExe))
            {
                try
                {
                    string tmp = Paths.InstalledExe + ".new";
                    File.Copy(self, tmp, true);
                    if (File.Exists(Paths.InstalledExe)) File.Delete(Paths.InstalledExe);
                    File.Move(tmp, Paths.InstalledExe);
                    Log.Write("installed a copy at {0}", Paths.InstalledExe);
                }
                catch (Exception e) { Log.Write("could not copy the exe: {0}", e.Message); return; }
            }
            if (string.IsNullOrEmpty(Paths.Override)) StartMenuShortcut();
        }

        static bool SameFile(string a, string b)
        {
            FileInfo fa = new FileInfo(a), fb = new FileInfo(b);
            if (fa.Length != fb.Length) return false;
            return Hash.Hex(File.ReadAllBytes(a)) == Hash.Hex(File.ReadAllBytes(b));
        }

        static void StartMenuShortcut()
        {
            try
            {
                string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DriveAtlas.lnk");
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(t);
                object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                Type st = sc.GetType();
                string current = (string)st.InvokeMember("TargetPath", BindingFlags.GetProperty, null, sc, null);
                if (string.Equals(current, Paths.InstalledExe, StringComparison.OrdinalIgnoreCase)) return;
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { Paths.InstalledExe });
                st.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { "" });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { Paths.Home });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "DriveAtlas: every drive you own and every file on it" });
                st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { Paths.InstalledExe + ",0" });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
                Log.Write("Start menu shortcut: {0}", lnk);
            }
            catch (Exception e) { Log.Write("could not add the Start menu shortcut: {0}", e.Message); }
        }

        // Unpacks the embedded app into %LOCALAPPDATA%\DriveAtlas\app whenever its contents change. The catalog
        // (Home\data) and the settings (Home\config.json) are separate folders and files, so they are never touched.
        public static void ExtractApp()
        {
            byte[] zip = Resources.Read("app.zip");
            if (zip == null || zip.Length == 0) throw new InvalidOperationException("This DriveAtlas.exe is damaged: the app inside it is missing.");
            string stamp = Build.Version + " " + Hash.Hex(zip);
            string old = File.Exists(Paths.Stamp) ? File.ReadAllText(Paths.Stamp).Trim() : "";
            if (old == stamp && File.Exists(Path.Combine(Paths.App, "hub", "main.mjs"))) return;

            string fresh = Paths.App + ".new", stale = Paths.App + ".old";
            if (Directory.Exists(fresh)) Directory.Delete(fresh, true);
            Directory.CreateDirectory(fresh);
            string root = Path.GetFullPath(fresh) + Path.DirectorySeparatorChar;
            using (ZipArchive archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string dest = Path.GetFullPath(Path.Combine(fresh, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Unexpected path in the app: " + entry.FullName);
                    if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (Stream src = entry.Open())
                    using (FileStream dst = File.Create(dest)) src.CopyTo(dst);
                }
            }
            if (Directory.Exists(stale)) { try { Directory.Delete(stale, true); } catch { } }
            try
            {
                if (Directory.Exists(Paths.App)) Directory.Move(Paths.App, Directory.Exists(stale) ? stale + "-" + DateTime.Now.Ticks : stale);
            }
            catch (IOException e)
            {
                // Another copy of DriveAtlas is still using the current files: keep them until it is closed.
                if (!File.Exists(Path.Combine(Paths.App, "hub", "main.mjs"))) throw;
                Log.Write("the app folder is in use ({0}); keeping the current version for now", e.Message);
                try { Directory.Delete(fresh, true); } catch { }
                return;
            }
            Directory.Move(fresh, Paths.App);
            try { Directory.Delete(stale, true); } catch { /* a file may still be open; removed next time */ }
            File.WriteAllText(Paths.Stamp, stamp);
            Log.Write("app {0} unpacked to {1}", Build.Version, Paths.App);
        }
    }

    static class NodeJs
    {
        // The hub needs Node.js 22.13 or newer (the first version with node:sqlite built in without a flag).
        static bool NewEnough(string exe)
        {
            try
            {
                FileVersionInfo v = FileVersionInfo.GetVersionInfo(exe);
                return v.FileMajorPart > 22 || (v.FileMajorPart == 22 && v.FileMinorPart >= 13);
            }
            catch { return false; }
        }

        public static string Find()
        {
            string path = (Environment.GetEnvironmentVariable("PATH") ?? "") + ";" +
                (Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "") + ";" +
                (Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "");
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string c = Path.Combine(Environment.ExpandEnvironmentVariables(dir.Trim().Trim('"')), "node.exe");
                    if (File.Exists(c) && NewEnough(c)) return c;
                }
                catch { /* not a valid folder */ }
            }
            string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
            return File.Exists(pf) && NewEnough(pf) ? pf : null;
        }

        // Runs the Node.js installer carried inside this exe (no download), then looks for node.exe again.
        public static string Install()
        {
            DialogResult ok = MessageBox.Show(
                "DriveAtlas runs on Node.js 22.13 or newer, which isn't installed on this PC.\n\n" +
                "Click OK to install it now. The installer is included in DriveAtlas.exe, so nothing is downloaded. " +
                "Windows will ask for permission to install it.",
                "DriveAtlas – Node.js needed", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (ok != DialogResult.OK) return null;

            byte[] msi = Resources.Read("node-installer.msi");
            if (msi == null || msi.Length == 0) { Fail("This DriveAtlas.exe doesn't contain the Node.js installer. Install Node.js 22.13 or newer from https://nodejs.org, then start DriveAtlas again."); return null; }
            string dir = Path.Combine(Path.GetTempPath(), "DriveAtlas-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "node-" + Build.NodeVersion + "-x64.msi");
            try
            {
                File.WriteAllBytes(file, msi);
                Log.Write("installing Node.js {0}", Build.NodeVersion);
                using (Process p = Process.Start(new ProcessStartInfo("msiexec.exe", "/i \"" + file + "\" /passive /norestart") { UseShellExecute = false }))
                {
                    p.WaitForExit();
                    Log.Write("Node.js installer finished with code {0}", p.ExitCode);
                    if (p.ExitCode == 1602) return null; // cancelled
                    if (p.ExitCode != 0 && p.ExitCode != 1641 && p.ExitCode != 3010) { Fail(string.Format("The Node.js installer stopped with code {0}.", p.ExitCode)); return null; }
                }
            }
            finally { try { Directory.Delete(dir, true); } catch { } }
            string node = Find();
            if (node == null) Fail("Node.js was installed, but DriveAtlas can't find it yet. Restart Windows, then start DriveAtlas again.");
            return node;
        }

        static void Fail(string message)
        {
            Log.Write(message);
            MessageBox.Show(message, "DriveAtlas", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static class Browser
    {
        // Same order as the hub: Chrome first, then Edge, each as an app window with DriveAtlas's own profile.
        public static void Open()
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] candidates = {
                Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe")
            };
            try
            {
                foreach (string b in candidates)
                {
                    if (!File.Exists(b)) continue;
                    string args = string.Format("--app={0} --user-data-dir=\"{1}\" --window-size=1320,880 --no-first-run --no-default-browser-check", Paths.Url, Paths.WindowProfile);
                    Process.Start(new ProcessStartInfo(b, args) { UseShellExecute = false });
                    return;
                }
                Process.Start(new ProcessStartInfo(Paths.Url) { UseShellExecute = true });
            }
            catch (Exception e) { Log.Write("could not open a window: {0}", e.Message); }
        }
    }

    static class Hub
    {
        // Calls the hub with the launcher's key. Returns the HTTP status and the body: 0 when nothing listens on the
        // port (the hub is gone), -1 when it doesn't answer in time (busy).
        public static int Call(string method, string path, string key, out string body)
        {
            body = "";
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Paths.Url.TrimEnd('/') + path);
                req.Method = method;
                req.Timeout = 4000;
                req.Proxy = null;
                req.KeepAlive = false;
                req.Headers["X-DriveAtlas-Launcher"] = key;
                if (method != "GET") { req.Headers["X-DriveAtlas"] = "1"; req.ContentLength = 0; }
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    int status = (int)res.StatusCode;
                    body = ReadBody(res);
                    return status;
                }
            }
            catch (WebException e)
            {
                HttpWebResponse res = e.Response as HttpWebResponse;
                if (res == null) return e.Status == WebExceptionStatus.Timeout ? -1 : 0;
                using (res)
                {
                    int status = (int)res.StatusCode;
                    body = ReadBody(res);
                    return status;
                }
            }
            catch (Exception e) { Log.Write("internal: {0} {1} failed: {2}", method, path, e.Message); return 0; }
        }

        static string ReadBody(HttpWebResponse res)
        {
            try { using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) return r.ReadToEnd(); }
            catch { return ""; }
        }

        public static long Number(string json, string key)
        {
            Match m = Regex.Match(json ?? "", "\"" + key + "\"\\s*:\\s*(\\d+)");
            long v;
            return m.Success && long.TryParse(m.Groups[1].Value, out v) ? v : 0;
        }

        public static string Text(string json, string key)
        {
            Match m = Regex.Match(json ?? "", "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }

        // Same units as the app (1024-based, like Windows Explorer).
        public static string Bytes(long n)
        {
            string[] units = { "B", "KB", "MB", "GB", "TB", "PB" };
            double v = n; int i = 0;
            while (v >= 1024 && i < units.Length - 1) { v /= 1024; i++; }
            return v.ToString(i == 0 ? "0" : v >= 10 ? "0.0" : "0.00", System.Globalization.CultureInfo.InvariantCulture) + " " + units[i];
        }
    }

    class TrayApp : ApplicationContext
    {
        readonly string key = NewKey();
        readonly string node;
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem status;
        // A hidden top-level window owned by this thread; work from other threads is handed back through it.
        readonly Form ui = new Form { ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None, Opacity = 0, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), Size = new Size(1, 1) };
        readonly System.Windows.Forms.Timer stats = new System.Windows.Forms.Timer { Interval = 30000 };
        readonly EventWaitHandle exitSignal;
        readonly RegisteredWaitHandle exitWait;
        Process hub;
        bool exiting, stopping;
        string lastTip = "";

        public TrayApp(string nodeExe, bool hubOnly)
        {
            node = nodeExe;
            IntPtr handle = ui.Handle; // created now, never shown
            status = new ToolStripMenuItem("Starting…") { Enabled = false };
            ToolStripMenuItem open = new ToolStripMenuItem("Open DriveAtlas", null, delegate { Browser.Open(); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(status);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Exit(true); }));
            tray = new NotifyIcon { Icon = AppIcon(), Text = "DriveAtlas", ContextMenuStrip = menu, Visible = true };
            tray.DoubleClick += delegate { Browser.Open(); };

            // DriveAtlas.exe --exit (from another process) works like Exit in the menu.
            exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Signals.Name("Exit"));
            exitWait = ThreadPool.RegisterWaitForSingleObject(exitSignal, delegate { Log.Write("exit requested by DriveAtlas.exe --exit"); OnUi(delegate { Exit(false); }); }, null, -1, false);

            stats.Tick += delegate { RefreshStats(); };
            StartHub(hubOnly);
            stats.Start();
            System.Windows.Forms.Timer first = new System.Windows.Forms.Timer { Interval = 3000 };
            first.Tick += delegate { first.Stop(); first.Dispose(); RefreshStats(); };
            first.Start();
        }

        static string NewKey()
        {
            byte[] b = new byte[32];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            return Hash.ToHex(b);
        }

        static void Background(Action a)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { a(); } catch (Exception e) { Log.Write("internal error: {0}", e); }
            });
        }

        void OnUi(Action a)
        {
            try { ui.BeginInvoke(a); }
            catch (Exception e) { if (!exiting) Log.Write("internal: could not hand work to the tray thread: {0}", e.Message); }
        }

        void StartHub(bool hubOnly)
        {
            ProcessStartInfo psi = new ProcessStartInfo(node, "--disable-warning=ExperimentalWarning hub\\main.mjs --background" + (hubOnly ? "" : " --open"))
            {
                WorkingDirectory = Paths.App,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            psi.EnvironmentVariables["DRIVEATLAS_LAUNCHER_KEY"] = key;
            Process proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
            proc.Exited += delegate { int code = -1; try { code = proc.ExitCode; } catch { } OnUi(delegate { HubExited(code); }); };
            proc.Start();
            hub = proc;
            Log.Write("hub started with {0} (pid {1}) on port {2}", node, proc.Id, Paths.Port);
        }

        // The hub process ended: stopped on purpose, restarted itself (after a restore or a catalog move),
        // found another DriveAtlas already running, or crashed.
        void HubExited(int code)
        {
            if (exiting) return;
            Log.Write("hub process ended with code {0}", code);
            Background(delegate
            {
                string body;
                int st = 0;
                for (int i = 0; i < 12 && st == 0; i++) { Thread.Sleep(800); st = Hub.Call("GET", "/api/summary", key, out body); }
                OnUi(delegate
                {
                    if (exiting) return;
                    if (st == 200) { Log.Write("the hub restarted itself; still watching it"); hub = null; RefreshStats(); return; }
                    Log.Write(st == 0 ? "hub is gone; closing the tray" : "another DriveAtlas is answering on this port; closing the tray");
                    Close();
                    if (st == 0 && code != 0)
                        MessageBox.Show("DriveAtlas stopped unexpectedly. Its log (hub.log) is in " + Paths.Home + ".", "DriveAtlas", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            });
        }

        void RefreshStats()
        {
            Background(delegate
            {
                string body;
                int st = Hub.Call("GET", "/api/summary", key, out body);
                OnUi(delegate
                {
                    if (exiting) return;
                    string tip, line;
                    if (st == 200)
                    {
                        long total = Hub.Number(body, "total"), capacity = Hub.Number(body, "capacity"), used = Hub.Number(body, "used");
                        string drives = total == 1 ? "1 drive" : total + " drives";
                        line = capacity > 0 ? string.Format("{0} · {1} of {2} used", drives, Hub.Bytes(used), Hub.Bytes(capacity)) : drives;
                        tip = "DriveAtlas · " + line;
                    }
                    else { line = st == 0 ? "Starting…" : "Running"; tip = "DriveAtlas"; }
                    if (tip.Length > 63) tip = tip.Substring(0, 63); // the tray's limit
                    tray.Text = tip;
                    status.Text = line;
                    if (tip != lastTip) { Log.Write("tray: {0}", tip); lastTip = tip; }
                });
            });
        }

        // Asks the hub to stop the normal way, so it refuses during a scan or a backup instead of being cut off.
        void Exit(bool fromMenu)
        {
            if (exiting || stopping) return;
            stopping = true;
            Log.Write("asking the hub to stop");
            Background(delegate
            {
                string body;
                int st = Hub.Call("POST", "/api/hub/stop", key, out body);
                Log.Write("stop requested ({0}): hub answered {1}", fromMenu ? "menu" : "--exit", st);
                OnUi(delegate { Stopped(fromMenu, st, body); });
            });
        }

        void Stopped(bool fromMenu, int st, string body)
        {
            stopping = false;
            if (st != 200 && st != 0)
            {
                string why = st == 409 ? (Hub.Text(body, "error") ?? "DriveAtlas is busy. Try again in a moment.")
                    : st == -1 ? "DriveAtlas is busy and didn't answer. Try again in a moment."
                    : "DriveAtlas couldn't stop: " + (Hub.Text(body, "error") ?? string.Format("the hub answered {0}.", st));
                tray.ShowBalloonTip(8000, "DriveAtlas is still running", why, ToolTipIcon.Warning);
                if (fromMenu) MessageBox.Show(why, "DriveAtlas", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            exiting = true;
            tray.Visible = false;
            Background(delegate
            {
                // A stopped hub closes its catalog and ends within a second; only a hub that isn't listening any more is ended here.
                Process p = hub;
                if (p != null && !p.WaitForExit(st == 200 ? 8000 : 0)) { try { p.Kill(); Log.Write("hub didn't stop; ended it"); } catch { } }
                OnUi(Close);
            });
        }

        void Close()
        {
            exiting = true;
            stats.Stop();
            tray.Visible = false;
            ExitThread();
        }

        static Icon AppIcon()
        {
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                exitWait.Unregister(null);
                exitSignal.Dispose();
                stats.Dispose();
                tray.Dispose();
                ui.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    static class Resources
    {
        public static byte[] Read(string name)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("DriveAtlasLauncher." + name))
            {
                if (s == null) return null;
                using (MemoryStream m = new MemoryStream()) { s.CopyTo(m); return m.ToArray(); }
            }
        }
    }

    static class Hash
    {
        public static string Hex(byte[] data) { using (SHA256 sha = SHA256.Create()) return ToHex(sha.ComputeHash(data)); }
        public static string ToHex(byte[] b)
        {
            StringBuilder sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }
    }
}
