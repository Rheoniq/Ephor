# Bring the Claude Desktop main window to the front.
# Fixed script: takes no arguments and interpolates nothing.
# Exit codes: 0 = Claude Desktop is now the foreground window,
#             2 = window found but Windows refused the foreground switch,
#             3 = no Claude Desktop window found.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace EphorFocus -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@

# Claude Desktop's window process is Claude.exe; the Claude Code CLI is also
# named claude.exe but has no main window and lives under a claude-code folder.
$proc = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Path -notmatch '\\claude-code\\' } |
  Select-Object -First 1

if (-not $proc) { exit 3 }

$hwnd = $proc.MainWindowHandle
if ([EphorFocus.Win32]::IsIconic($hwnd)) {
  [void][EphorFocus.Win32]::ShowWindow($hwnd, 9)  # SW_RESTORE
}
[void][EphorFocus.Win32]::SetForegroundWindow($hwnd)

if ([EphorFocus.Win32]::GetForegroundWindow() -eq $hwnd) { exit 0 }
exit 2
