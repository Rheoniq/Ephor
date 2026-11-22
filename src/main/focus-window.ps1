# List the top-level windows of processes, or bring one window of a process to the front.
# Fixed script: every value arrives as JSON on stdin and is only compared, never
# evaluated. The only window actions are SW_RESTORE on a minimized target and
# bringing that target to the foreground; nothing is closed, moved or typed into.
#
# stdin {"mode":"list","pids":[n,...]}
#   prints [{"pid":n,"hwnd":"n","title":"..."}] as ASCII JSON, topmost first; exit 0.
# stdin {"mode":"focus","ownerPid":n,"folderName":"..."}
#   picks the first window whose title contains folderName (ignoring case), else
#   the first window. Exit 0 = it is now the foreground window, 2 = the process
#   has no visible titled top-level window, 3 = Windows refused the switch.
# Exit 1 = bad input or any error.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-Pid($value) {
  return (($value -is [int]) -or ($value -is [long])) -and $value -gt 0 -and $value -le 4294967295
}

try {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
  $raw = $reader.ReadToEnd()
  if ($raw.Length -gt 65536) { exit 1 }
  $req = ConvertFrom-Json -InputObject $raw

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HuddleWindow {
  public class Found {
    public uint Pid;
    public IntPtr Hwnd;
    public string HwndText;
    public string Title;
  }

  public static class Native {
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    // Visible, titled top-level windows of the given pids, in Z order (topmost first).
    // GetWindowText reads another process's caption without sending it a message.
    public static List<Found> List(uint[] pids) {
      HashSet<uint> wanted = new HashSet<uint>(pids);
      List<Found> found = new List<Found>();
      EnumProc cb = delegate (IntPtr h, IntPtr l) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (!wanted.Contains(pid) || !IsWindowVisible(h)) return true;
        StringBuilder sb = new StringBuilder(1024);
        if (GetWindowTextW(h, sb, sb.Capacity) <= 0) return true;
        Found f = new Found();
        f.Pid = pid;
        f.Hwnd = h;
        f.HwndText = unchecked((ulong)h.ToInt64()).ToString();
        f.Title = sb.ToString();
        found.Add(f);
        return true;
      };
      EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return found;
    }

    public static int Focus(uint ownerPid, string folder) {
      List<Found> wins = List(new uint[] { ownerPid });
      if (wins.Count == 0) return 2;
      Found target = wins[0];
      if (folder.Length > 0) {
        foreach (Found w in wins) {
          if (w.Title.IndexOf(folder, StringComparison.OrdinalIgnoreCase) >= 0) { target = w; break; }
        }
      }
      IntPtr h = target.Hwnd;
      if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
      if (GetForegroundWindow() == h) return 0;
      // Windows only lets the process that owns the foreground input switch it:
      // share the input state of the foreground thread for the switch.
      uint self = GetCurrentThreadId();
      uint ignored;
      IntPtr fg = GetForegroundWindow();
      uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out ignored);
      bool attached = fgThread != 0 && fgThread != self && AttachThreadInput(self, fgThread, true);
      try {
        BringWindowToTop(h);
        SetForegroundWindow(h);
      } finally {
        if (attached) AttachThreadInput(self, fgThread, false);
      }
      // Bounded wait: the switch is asynchronous.
      for (int i = 0; i < 20; i++) {
        if (GetForegroundWindow() == h) return 0;
        Thread.Sleep(25);
      }
      return 3;
    }
  }
}
'@

  if ($req.mode -eq 'list') {
    $ids = New-Object System.Collections.Generic.List[uint32]
    foreach ($p in @($req.pids)) {
      if (-not (Test-Pid $p)) { exit 1 }
      $ids.Add([uint32]$p)
    }
    if ($ids.Count -eq 0 -or $ids.Count -gt 64) { exit 1 }
    $rows = @(foreach ($w in [HuddleWindow.Native]::List($ids.ToArray())) {
      [pscustomobject]@{ pid = [long]$w.Pid; hwnd = $w.HwndText; title = $w.Title }
    })
    $json = ConvertTo-Json -InputObject $rows -Compress
    # ASCII only, so the console code page cannot change a title.
    [regex]::Replace($json, '[^\x20-\x7e]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    exit 0
  }

  if ($req.mode -eq 'focus') {
    $ownerPid = $req.ownerPid
    if (-not (Test-Pid $ownerPid)) { exit 1 }
    $folder = $req.folderName
    if ($null -eq $folder) { $folder = '' }
    if (-not ($folder -is [string]) -or $folder.Length -gt 260) { exit 1 }
    exit ([HuddleWindow.Native]::Focus([uint32]$ownerPid, $folder))
  }

  exit 1
} catch {
  exit 1
}
