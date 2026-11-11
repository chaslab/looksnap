# LookSnap Windows capture helper. Uses GDI CopyFromScreen: with HDR on, Windows tone-maps GDI captures,
# so colors look normal (desktopCapturer comes out washed-out). Reads "x|y|w|h|file" (physical px) on stdin, writes raw BGRA.
Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public class LsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
# Per-monitor DPI aware (-4 = PER_MONITOR_AWARE_V2), otherwise 150%-scaled screens come out blurry
if (-not [LsDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { [LsDpi]::SetProcessDPIAware() | Out-Null }
[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()
while ($true) {
  $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }
  $p = $l.Split('|')
  try {
    $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, 'Format24bppRgb'
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $w, $h)); $g.Dispose()
    $d = $bmp.LockBits((New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h), 'ReadOnly', 'Format32bppArgb')
    $bytes = New-Object byte[] ($d.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($d); $bmp.Dispose()
    [System.IO.File]::WriteAllBytes($p[4], $bytes)
    [Console]::Out.WriteLine("ok")
  } catch { [Console]::Out.WriteLine("err " + $_.Exception.Message) }
  [Console]::Out.Flush()
}
