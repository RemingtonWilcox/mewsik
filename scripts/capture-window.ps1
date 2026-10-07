# Captures the mewsik main window content (even if occluded) via PrintWindow.
$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
Add-Type -AssemblyName System.Drawing

$p = Get-Process mewsik -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "NO_WINDOW"; exit 1 }

$r = New-Object Win32Cap+RECT
[void][Win32Cap]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output "WINDOW ${w}x${h} at ($($r.Left),$($r.Top)) title='$($p.MainWindowTitle)'"
if ($w -le 0 -or $h -le 0) { Write-Output "BAD_RECT"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Win32Cap]::PrintWindow($p.MainWindowHandle, $hdc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
Write-Output "PRINTWINDOW_OK=$ok"

$outDir = "C:\Users\og10ktech\Documents\VIBECODE\mewsik\output"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir "live-capture.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "SAVED $out"
