# Generates Lumen's icons: resources/icon.png, resources/public/icon.png, resources/icon.ico, resources/tray.ico
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$res = Join-Path $root 'resources'
New-Item -ItemType Directory -Force -Path (Join-Path $res 'public') | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconBitmap([int]$size, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $inset = [float]([Math]::Max(0.5, $size * 0.04))
  $w = [float]($size - 2 * $inset)
  if ($rounded) { $shape = New-RoundedPath $inset $inset $w $w ([float]($size * 0.22)) }
  else { $shape = New-Object System.Drawing.Drawing2D.GraphicsPath; $shape.AddEllipse($inset, $inset, $w, $w) }

  $rect = New-Object System.Drawing.RectangleF $inset, $inset, $w, $w
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::Black), ([System.Drawing.Color]::Black), 45.0
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend 3
  $blend.Colors = @([System.Drawing.ColorTranslator]::FromHtml('#ff9a2e'), [System.Drawing.ColorTranslator]::FromHtml('#ff5e8a'), [System.Drawing.ColorTranslator]::FromHtml('#6c5cff'))
  $blend.Positions = @([float]0, [float]0.5, [float]1)
  $bg.InterpolationColors = $blend
  $g.FillPath($bg, $shape)

  $c = [float]($size / 2)
  $gr = [float]($size * 0.34)
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glow.AddEllipse($c - $gr, $c - $gr, 2 * $gr, 2 * $gr)
  $pg = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
  $pg.CenterColor = [System.Drawing.Color]::FromArgb(200, 255, 255, 255)
  $pg.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
  $g.SetClip($shape)
  $g.FillPath($pg, $glow)
  $g.ResetClip()

  $cr = [float]([Math]::Max(1.5, $size * 0.13))
  $core = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 255, 255, 255))
  $g.FillEllipse($core, $c - $cr, $c - $cr, 2 * $cr, 2 * $cr)
  $g.Dispose()
  return $bmp
}

function Get-PngBytes($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $ms.ToArray()
}

# 32-bit DIB (BITMAPINFOHEADER + bottom-up BGRA + empty AND mask), the most compatible ICO entry format.
function Get-DibBytes($bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $buf = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($data)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([int32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2)); $bw.Write([int16]1); $bw.Write([int16]32)
  $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0)
  for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($buf, [int]($y * $stride), [int]($w * 4)) }
  $maskRow = [int]([Math]::Ceiling($w / 32.0) * 4)
  $bw.Write((New-Object byte[] ($maskRow * $h)))
  $bw.Flush()
  return , $ms.ToArray()
}

function Write-Ico([string]$path, [int[]]$sizes, [bool]$rounded) {
  $entries = foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s $rounded
    $bytes = if ($s -ge 128) { Get-PngBytes $bmp } else { Get-DibBytes $bmp }
    $bmp.Dispose()
    [PSCustomObject]@{ Size = $s; Bytes = $bytes }
  }
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([int16]0); $bw.Write([int16]1); $bw.Write([int16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) {
    $dim = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int32]$e.Bytes.Length); $bw.Write([int32]$offset)
    $offset += $e.Bytes.Length
  }
  foreach ($e in $entries) { $bw.Write([byte[]]$e.Bytes) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
}

$png = New-IconBitmap 512 $true
$png.Save((Join-Path $res 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png.Save((Join-Path $res 'public\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
Write-Ico (Join-Path $res 'icon.ico') @(16, 20, 24, 32, 40, 48, 64, 128, 256) $true
Write-Ico (Join-Path $res 'tray.ico') @(16, 20, 24, 32, 40, 48, 64) $false
Get-ChildItem $res -Recurse -File | Format-Table @{n = 'File'; e = { $_.FullName.Replace($root + '\', '') } }, Length -AutoSize
