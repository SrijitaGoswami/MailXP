<#
.SYNOPSIS
  MailXP asset pipeline — generates processed assets + machine-readable manifest.

.DESCRIPTION
  Reads the ORIGINAL art under public/assets/mailxp/ (never modifies it) and writes:
    public/assets/mailxp/processed/
      office-tiles-32.png    regular 32x32 tile sheet (nearest-neighbor) from selected source cells
      office-props.json      Phaser atlas frames for office/office-props.png   (furniture)
      mail-effects.json      Phaser atlas frames for items/mail-effects.png    (mail items + effects)
      office-npcs.json       Phaser atlas frames for characters/npcs/office-npcs.png
      ai-workers.json        Phaser atlas frames for characters/agents/ai-workers.png
      mail-bird.json         Phaser atlas frames for effects/mail-bird.png
      manifest.json          every source rectangle -> output name (machine-readable)

  Contact sheets for visual verification are written to a temp/debug folder (NOT public/).

  Modes:
    -Mode analyze   segment + diagnostics + contact sheets only (no processed outputs)
    -Mode build     full generation (fails if detected segment counts don't match config)

.EXAMPLE
  powershell -File scripts/generate-assets.ps1 -Mode analyze
  powershell -File scripts/generate-assets.ps1 -Mode build
#>
param(
  [ValidateSet('analyze', 'build')]
  [string]$Mode = 'build'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- C# helper --
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace MailXp
{
    public static class PngOps
    {
        private static byte[] Load(string path, out int w, out int h)
        {
            using (var bmp = new Bitmap(path))
            {
                w = bmp.Width; h = bmp.Height;
                var rect = new Rectangle(0, 0, w, h);
                var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                byte[] buf = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                bmp.UnlockBits(data);
                return buf;
            }
        }

        // axis: 0 = per-column counts (x projection), 1 = per-row counts (y projection)
        // from/to bound the axis range; yFrom/yTo bound the perpendicular range (full when -1).
        public static int[] Proj(string path, int axis, int thr, int from, int to, int yFrom, int yTo)
        {
            int w, h;
            byte[] buf = Load(path, out w, out h);
            if (axis == 0)
            {
                if (from < 0) from = 0;
                if (to < 0 || to > w) to = w;
                if (yFrom < 0) yFrom = 0;
                if (yTo < 0 || yTo > h) yTo = h;
                int[] p = new int[w];
                for (int y = yFrom; y < yTo; y++)
                {
                    int off = y * w * 4;
                    for (int x = from; x < to; x++)
                        if (buf[off + x * 4 + 3] >= thr) p[x]++;
                }
                return p;
            }
            else
            {
                if (from < 0) from = 0;
                if (to < 0 || to > h) to = h;
                if (yFrom < 0) yFrom = 0;
                if (yTo < 0 || yTo > w) yTo = w;
                int[] p = new int[h];
                for (int y = from; y < to; y++)
                {
                    int off = y * w * 4;
                    for (int x = yFrom; x < yTo; x++)
                        if (buf[off + x * 4 + 3] >= thr) p[y]++;
                }
                return p;
            }
        }

        // content bounding box (alpha >= thr) inside region; null-ish empty rect when no content
        public static Rectangle ContentBounds(string path, Rectangle region, int thr)
        {
            int w, h;
            byte[] buf = Load(path, out w, out h);
            int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
            for (int y = region.Y; y < region.Bottom; y++)
            {
                if (y < 0 || y >= h) continue;
                int off = y * w * 4;
                for (int x = region.X; x < region.Right; x++)
                {
                    if (x < 0 || x >= w) continue;
                    if (buf[off + x * 4 + 3] >= thr)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return Rectangle.Empty;
            return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
        }

        // nearest-neighbor crop + scale to a new PNG
        public static void CropScale(string srcPath, Rectangle src, int ow, int oh, string destPath)
        {
            int w, h;
            byte[] buf = Load(srcPath, out w, out h);
            byte[] outBuf = new byte[ow * oh * 4];
            for (int y = 0; y < oh; y++)
            {
                int sy = src.Y + (int)(((double)y + 0.5) * src.Height / oh);
                if (sy >= src.Y + src.Height) sy = src.Y + src.Height - 1;
                if (sy >= h) sy = h - 1;
                int soff = sy * w * 4;
                int doff = y * ow * 4;
                for (int x = 0; x < ow; x++)
                {
                    int sx = src.X + (int)(((double)x + 0.5) * src.Width / ow);
                    if (sx >= src.X + src.Width) sx = src.X + src.Width - 1;
                    if (sx >= w) sx = w - 1;
                    int s = soff + sx * 4, d = doff + x * 4;
                    outBuf[d] = buf[s]; outBuf[d + 1] = buf[s + 1];
                    outBuf[d + 2] = buf[s + 2]; outBuf[d + 3] = buf[s + 3];
                }
            }
            Save(ow, oh, outBuf, destPath);
        }

        // compose a regular tile sheet: cells = source rects, each scaled to tile x tile
        public static void BuildSheet(string srcPath, Rectangle[] cells, int tile, int cols, string destPath)
        {
            int w, h;
            byte[] buf = Load(srcPath, out w, out h);
            int rows = (cells.Length + cols - 1) / cols;
            int sw = cols * tile, sh = rows * tile;
            byte[] outBuf = new byte[sw * sh * 4];
            for (int i = 0; i < cells.Length; i++)
            {
                Rectangle src = cells[i];
                int cx = (i % cols) * tile, cy = (i / cols) * tile;
                for (int y = 0; y < tile; y++)
                {
                    int sy = src.Y + (int)(((double)y + 0.5) * src.Height / tile);
                    if (sy >= src.Y + src.Height) sy = src.Y + src.Height - 1;
                    if (sy >= h) sy = h - 1;
                    int soff = sy * w * 4;
                    int doff = ((cy + y) * sw + cx) * 4;
                    for (int x = 0; x < tile; x++)
                    {
                        int sx = src.X + (int)(((double)x + 0.5) * src.Width / tile);
                        if (sx >= src.X + src.Width) sx = src.X + src.Width - 1;
                        if (sx >= w) sx = w - 1;
                        int s = soff + sx * 4, d = doff + x * 4;
                        outBuf[d] = buf[s]; outBuf[d + 1] = buf[s + 1];
                        outBuf[d + 2] = buf[s + 2]; outBuf[d + 3] = buf[s + 3];
                    }
                }
            }
            Save(sw, sh, outBuf, destPath);
        }

        // contact sheet: frames fit (aspect preserved) into cols x cellW/cellH cells with labels
        public static void Contact(string srcPath, Rectangle[] frames, string[] labels, int cols, int cellW, int cellH, string destPath)
        {
            int w, h;
            byte[] buf = Load(srcPath, out w, out h);
            int rows = (frames.Length + cols - 1) / cols;
            int sw = cols * cellW, sh = rows * cellH;
            byte[] outBuf = new byte[sw * sh * 4];
            // opaque dark background so light art is visible
            for (int i = 0; i < outBuf.Length; i += 4) { outBuf[i] = 40; outBuf[i + 1] = 40; outBuf[i + 2] = 44; outBuf[i + 3] = 255; }
            for (int i = 0; i < frames.Length; i++)
            {
                Rectangle f = frames[i];
                if (f.Width <= 0 || f.Height <= 0) continue;
                double scale = Math.Min((double)(cellW - 8) / f.Width, (double)(cellH - 18) / f.Height);
                int dw = Math.Max(1, (int)(f.Width * scale)), dh = Math.Max(1, (int)(f.Height * scale));
                int ox = (i % cols) * cellW + (cellW - dw) / 2;
                int oy = (i / cols) * cellH + 14 + (cellH - 18 - dh) / 2;
                for (int y = 0; y < dh; y++)
                {
                    int sy = f.Y + (int)(((double)y + 0.5) * f.Height / dh);
                    if (sy >= f.Y + f.Height) sy = f.Y + f.Height - 1;
                    if (sy >= h) sy = h - 1;
                    int soff = sy * w * 4;
                    for (int x = 0; x < dw; x++)
                    {
                        int sx = f.X + (int)(((double)x + 0.5) * f.Width / dw);
                        if (sx >= f.X + f.Width) sx = f.X + f.Width - 1;
                        if (sx >= w) sx = w - 1;
                        int s = soff + sx * 4;
                        if (buf[s + 3] < 8) continue; // keep transparency -> background shows
                        int d = ((oy + y) * sw + ox + x) * 4;
                        outBuf[d] = buf[s]; outBuf[d + 1] = buf[s + 1];
                        outBuf[d + 2] = buf[s + 2]; outBuf[d + 3] = 255;
                    }
                }
            }
            // draw labels on top (in memory; single save avoids GDI+ file lock)
            using (var bmp = FromBuffer(sw, sh, outBuf))
            using (var g = Graphics.FromImage(bmp))
            using (var font = new Font("Consolas", 9f, FontStyle.Bold))
            using (var shadow = new SolidBrush(Color.FromArgb(200, 0, 0, 0)))
            using (var text = new SolidBrush(Color.Gold))
            {
                for (int i = 0; i < frames.Length && i < labels.Length; i++)
                {
                    float lx = (i % cols) * cellW + 3;
                    float ly = (i / cols) * cellH + 2;
                    g.DrawString(labels[i], font, shadow, lx + 1, ly + 1);
                    g.DrawString(labels[i], font, text, lx, ly);
                }
                bmp.Save(destPath, ImageFormat.Png);
            }
        }

        private static Bitmap FromBuffer(int w, int h, byte[] buf)
        {
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            var rect = new Rectangle(0, 0, w, h);
            var data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(buf, 0, data.Scan0, buf.Length);
            bmp.UnlockBits(data);
            return bmp;
        }

        private static void Save(int w, int h, byte[] buf, string destPath)
        {
            using (var bmp = FromBuffer(w, h, buf))
            {
                bmp.Save(destPath, ImageFormat.Png);
            }
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

# ------------------------------------------------------------------ config --
$Root = Split-Path -Parent $PSScriptRoot
$Src  = Join-Path $Root 'public\assets\mailxp'
$Out  = Join-Path $Src 'processed'
$Debug = Join-Path $env:TEMP 'mailxp-asset-debug'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
New-Item -ItemType Directory -Force -Path $Debug | Out-Null

$Paths = @{
  props    = Join-Path $Src 'office\office-props.png'      # furniture (21 objects)
  effects  = Join-Path $Src 'items\mail-effects.png'       # mail items + effects (13)
  npcs     = Join-Path $Src 'characters\npcs\office-npcs.png'
  ai       = Join-Path $Src 'characters\agents\ai-workers.png'
  bird     = Join-Path $Src 'effects\mail-bird.png'
  worker   = Join-Path $Src 'characters\player\worker.png'
  interact = Join-Path $Src 'characters\player\interact-directions.png'
  tiles    = Join-Path $Src 'tilesets\office\office-tileset.png'
}

# Segmentation thresholds (alpha >= thr counts as content; glow is low-alpha)
$Thr = @{ props = 80; effects = 80; npcs = 32; ai = 32; bird = 32 }

# Row-major expected names (segmentation merges/splits are reconciled with $Merges)
$PropRows = @(
  ,@('desk', 'chair', 'computer', 'printer', 'phone', 'cabinet')
  ,@('bookshelf', 'couch', 'plant', 'water-cooler', 'notice-board', 'mailbox')
  ,@('lockers', 'clock', 'lamp', 'wastebasket', 'mug', 'parcel', 'envelope', 'papers', 'draftcoin')
)
$EffectRows = @(
  ,@('mail-closed', 'mail-open', 'letter', 'mail-sealed', 'parcel', 'package')
  ,@('draftcoin', 'reward-token', 'sparkle')
  ,@('pickup-burst', 'interaction-ring', 'coin-burst', 'quest-burst', 'levelup-burst')
)

# Selected tileset source cells (row, col) on the 16x8 visual grid: floor, rug, wall,
# window, door, transition categories. Verified against a numbered contact sheet.
$TilePicks = @(
  @{ n = 'carpet-forest';   r = 0;  c = 0  },
  @{ n = 'carpet-sage';     r = 0;  c = 1  },
  @{ n = 'carpet-cream';    r = 0;  c = 4  },
  @{ n = 'carpet-sand';     r = 0;  c = 5  },
  @{ n = 'wood-walnut';     r = 0;  c = 7  },
  @{ n = 'wood-oak';        r = 0;  c = 8  },
  @{ n = 'tile-white';      r = 0;  c = 10 },
  @{ n = 'tile-grid';       r = 0;  c = 11 },
  @{ n = 'rug-red';         r = 1;  c = 0  },
  @{ n = 'rug-check';       r = 1;  c = 2  },
  @{ n = 'rug-green';       r = 1;  c = 6  },
  @{ n = 'wall-top-teal';   r = 2;  c = 0  },
  @{ n = 'wall-top-cream';  r = 2;  c = 1  },
  @{ n = 'wall-top-panel';  r = 2;  c = 2  },
  @{ n = 'wall-top-plain';  r = 2;  c = 3  },
  @{ n = 'wall-base-teal';  r = 3;  c = 0  },
  @{ n = 'wall-base-cream'; r = 3;  c = 1  },
  @{ n = 'window-sill';     r = 3;  c = 7  },
  @{ n = 'door-teal';       r = 3;  c = 9  },
  @{ n = 'door-glass';      r = 3;  c = 10 },
  @{ n = 'door-dark';       r = 3;  c = 11 },
  @{ n = 'door-wood';       r = 3;  c = 12 },
  @{ n = 'transition-teal'; r = 5;  c = 0  },
  @{ n = 'transition-wood'; r = 5;  c = 2  },
  @{ n = 'trim-teal';       r = 6;  c = 0  },
  @{ n = 'trim-tile';       r = 6;  c = 2  }
)

# ------------------------------------------------------------ helper logic --
function Get-ContentRuns {
  param([int[]]$counts, [int]$minGap, [int]$minContent = 2)
  $runs = @(); $i = 0; $n = $counts.Length
  while ($i -lt $n) {
    if ($counts[$i] -gt 0) {
      $start = $i; $last = $i; $i++
      while ($i -lt $n) {
        if ($counts[$i] -gt 0) { $last = $i; $i++; continue }
        $z = $i
        while ($z -lt $n -and $counts[$z] -eq 0) { $z++ }
        if (($z - $i) -le $minGap) { $i = $z; continue }   # bridge small gap
        break
      }
      if (($last - $start + 1) -ge $minContent) {
        $runs += [pscustomobject]@{ Start = $start; End = $last + 1 }   # End exclusive
      }
    } else { $i++ }
  }
  , $runs
}

function Repair-RowSegments {
  # Reconcile a row's raw segments with the expected object count:
  # too many  -> merge the adjacent pair with the smallest gap (detached particles/glow)
  # too few   -> split the widest segment at its x-projection minimum (fused neighbors)
  param([object[]]$Segments, [int]$Expected, [string]$Path, [int]$Y0, [int]$Y1, [int]$Thr)
  $segs = @($Segments)
  if ($segs.Count -eq 0 -or $Expected -le 0) { , @($segs); return }

  $guard = 0
  while ($segs.Count -gt $Expected -and $guard -lt 32) {
    $guard++
    $bestI = -1; $bestGap = [int]::MaxValue
    for ($i = 0; $i -lt $segs.Count - 1; $i++) {
      $gap = $segs[$i + 1].x - ($segs[$i].x + $segs[$i].w)
      if ($gap -lt $bestGap) { $bestGap = $gap; $bestI = $i }
    }
    if ($bestI -lt 0) { break }
    $a = $segs[$bestI]; $b = $segs[$bestI + 1]
    $x0 = [Math]::Min($a.x, $b.x)
    $x1 = [Math]::Max($a.x + $a.w, $b.x + $b.w)
    $u = [pscustomobject]@{ x = $x0; y = $Y0; w = ($x1 - $x0); h = ($Y1 - $Y0) }
    $before = if ($bestI -gt 0) { @($segs[0..($bestI - 1)]) } else { @() }
    $after = if (($bestI + 2) -le ($segs.Count - 1)) { @($segs[($bestI + 2)..($segs.Count - 1)]) } else { @() }
    $segs = @($before) + @($u) + @($after)
  }

  $guard = 0
  while ($segs.Count -lt $Expected -and $guard -lt 32) {
    $guard++
    $wi = 0; $ww = -1
    for ($i = 0; $i -lt $segs.Count; $i++) { if ($segs[$i].w -gt $ww) { $ww = $segs[$i].w; $wi = $i } }
    $seg = $segs[$wi]
    if ($seg.w -lt 12) { break }
    $lo = [int]($seg.x + 0.15 * $seg.w); $hi = [int]($seg.x + 0.85 * $seg.w)
    $p = [MailXp.PngOps]::Proj($Path, 0, $Thr, $lo, $hi, $Y0, $Y1)
    $cut = -1; $minVal = [int]::MaxValue
    for ($x = $lo; $x -lt $hi; $x++) {   # NOTE: Proj's 'to' is exclusive — -le would pick an uninitialized 0
      if ($p[$x] -lt $minVal) { $minVal = $p[$x]; $cut = $x }
    }
    if ($cut -le ($seg.x + 2) -or $cut -ge ($seg.x + $seg.w - 2)) { break }
    $left = [pscustomobject]@{ x = $seg.x; y = $Y0; w = ($cut - $seg.x); h = ($Y1 - $Y0) }
    $right = [pscustomobject]@{ x = $cut; y = $Y0; w = ($seg.x + $seg.w - $cut); h = ($Y1 - $Y0) }
    $before = if ($wi -gt 0) { @($segs[0..($wi - 1)]) } else { @() }
    $after = if (($wi + 1) -le ($segs.Count - 1)) { @($segs[($wi + 1)..($segs.Count - 1)]) } else { @() }
    $segs = @($before) + @($left, $right) + @($after)
  }
  , @($segs)
}

function Get-GridFrames {
  # Frame boundaries for a grid sheet.
  # -NoSnap: strict floor grid (i * floor(size / cells)) for sheets whose guide frames are
  #          exact integers (worker: 4x313+2 unused, interact: 4x543 exact).
  # Default: nominal boundaries snapped to the nearest projection minimum (non-integer cells).
  param([string]$Path, [int]$Cols, [int]$Rows, [int]$Snap, [int]$ProjThr, [switch]$NoSnap)
  $img = [System.Drawing.Image]::FromFile($Path); $w = $img.Width; $h = $img.Height; $img.Dispose()

  $xBound = @(0)
  $yBound = @(0)
  if ($NoSnap) {
    $cellW = [Math]::Floor($w / $Cols); $cellH = [Math]::Floor($h / $Rows)
    for ($i = 1; $i -lt $Cols; $i++) { $xBound += ($i * $cellW) }
    $xBound += ($Cols * $cellW)
    for ($i = 1; $i -lt $Rows; $i++) { $yBound += ($i * $cellH) }
    $yBound += ($Rows * $cellH)
    $frames = @()
    for ($r = 0; $r -lt $Rows; $r++) {
      for ($c = 0; $c -lt $Cols; $c++) {
        $frames += [pscustomobject]@{ x = $xBound[$c]; y = $yBound[$r]; w = $xBound[$c + 1] - $xBound[$c]; h = $yBound[$r + 1] - $yBound[$r] }
      }
    }
    return [pscustomobject]@{ Frames = $frames; XBound = $xBound; YBound = $yBound }
  }

  $xProj = [MailXp.PngOps]::Proj($Path, 0, $ProjThr, -1, -1, -1, -1)
  $yProj = [MailXp.PngOps]::Proj($Path, 1, $ProjThr, -1, -1, -1, -1)

  for ($i = 1; $i -lt $Cols; $i++) {
    $nominal = [int][Math]::Round($i * $w / $Cols)
    $best = $nominal; $bestVal = [int]::MaxValue
    $lo = [Math]::Max(1, $nominal - $Snap); $hi = [Math]::Min($w - 2, $nominal + $Snap)
    for ($x = $lo; $x -le $hi; $x++) {
      if ($xProj[$x] -lt $bestVal -or ($xProj[$x] -eq $bestVal -and [Math]::Abs($x - $nominal) -lt [Math]::Abs($best - $nominal))) {
        $bestVal = $xProj[$x]; $best = $x
      }
    }
    $xBound += $best
  }
  $xBound += $w

  for ($i = 1; $i -lt $Rows; $i++) {
    $nominal = [int][Math]::Round($i * $h / $Rows)
    $best = $nominal; $bestVal = [int]::MaxValue
    $lo = [Math]::Max(1, $nominal - $Snap); $hi = [Math]::Min($h - 2, $nominal + $Snap)
    for ($y = $lo; $y -le $hi; $y++) {
      if ($yProj[$y] -lt $bestVal -or ($yProj[$y] -eq $bestVal -and [Math]::Abs($y - $nominal) -lt [Math]::Abs($best - $nominal))) {
        $bestVal = $yProj[$y]; $best = $y
      }
    }
    $yBound += $best
  }
  $yBound += $h

  $frames = @()
  for ($r = 0; $r -lt $Rows; $r++) {
    for ($c = 0; $c -lt $Cols; $c++) {
      $rect = [pscustomobject]@{
        x = $xBound[$c]; y = $yBound[$r]
        w = $xBound[$c + 1] - $xBound[$c]; h = $yBound[$r + 1] - $yBound[$r]
      }
      $frames += $rect
    }
  }
  , [pscustomobject]@{ Frames = $frames; XBound = $xBound; YBound = $yBound }
}

function Write-JsonFile {
  param($Object, [string]$Dest, [int]$Depth = 8)
  # BOM-less UTF-8. RFC 8259: a JSON text must not start with a BOM, and strict
  # parsers (e.g. jq, Node JSON.parse without stripping) reject one. PS 5.1's
  # `Set-Content -Encoding UTF8` always writes a BOM, so use .NET directly.
  $path = if ([System.IO.Path]::IsPathRooted($Dest)) { $Dest } else { Join-Path (Get-Location).Path $Dest }
  $json = ConvertTo-Json -InputObject $Object -Depth $Depth
  [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Write-PhaserAtlas {
  param([string]$TextureUrl, [object[]]$Frames, [string]$Dest)
  $items = foreach ($f in $Frames) {
    [pscustomobject]@{
      filename         = $f.name
      frame            = [pscustomobject]@{ x = $f.x; y = $f.y; w = $f.w; h = $f.h }
      rotated          = $false
      trimmed          = $false
      spriteSourceSize = [pscustomobject]@{ x = 0; y = 0; w = $f.w; h = $f.h }
      sourceSize       = [pscustomobject]@{ w = $f.w; h = $f.h }
    }
  }
  # Phaser 3.90 TextureManager.addAtlas() dispatches on Array.isArray(data.frames):
  #   { "frames": [ ... ] }  -> addAtlasJSONArray (works)
  #   bare top-level [ ... ] -> falls through to the JSON Hash parser, which warns
  #   "missing 'frames' Object" and adds ZERO frames. Wrap the array under "frames".
  $doc = [pscustomobject]@{ frames = @($items) }
  Write-JsonFile -Object $doc -Dest $Dest -Depth 8
}

function Save-RectangleJson {
  param($Rects)
  [pscustomobject]@{ x = $Rects.x; y = $Rects.y; w = $Rects.w; h = $Rects.h }
}

# ------------------------------------------------------------------- analyze --
Write-Host "Mode: $Mode  (debug sheets -> $Debug)"

$atlasPlan = @()
foreach ($key in @('props', 'effects')) {
  $expectedRows = if ($key -eq 'props') { $PropRows } else { $EffectRows }

  $rowProj = [MailXp.PngOps]::Proj($Paths[$key], 1, $Thr[$key], -1, -1, -1, -1)
  $rowRuns = Get-ContentRuns -counts $rowProj -minGap 6
  Write-Host ("[{0}] row bands={1} (expected {2})" -f $key, $rowRuns.Count, $expectedRows.Count)

  $frames = @(); $ok = ($rowRuns.Count -eq $expectedRows.Count)
  for ($r = 0; $r -lt $rowRuns.Count; $r++) {
    $band = $rowRuns[$r]
    $colProj = [MailXp.PngOps]::Proj($Paths[$key], 0, $Thr[$key], -1, -1, $band.Start, $band.End)
    $raw = @()
    foreach ($run in (Get-ContentRuns -counts $colProj -minGap 4)) {
      $raw += [pscustomobject]@{ x = $run.Start; y = $band.Start; w = ($run.End - $run.Start); h = ($band.End - $band.Start) }
    }
    $expected = if ($r -lt $expectedRows.Count) { @($expectedRows[$r]) } else { @() }
    $repaired = Repair-RowSegments -Segments $raw -Expected $expected.Count -Path $Paths[$key] -Y0 $band.Start -Y1 $band.End -Thr $Thr[$key]
    $repaired = @($repaired)
    Write-Host ("  row {0}: raw={1} repaired={2} expected={3} {4}" -f $r, $raw.Count, $repaired.Count, $expected.Count,
      $(if ($repaired.Count -eq $expected.Count) { 'OK' } else { 'MISMATCH' }))
    if ($repaired.Count -ne $expected.Count) {
      $ok = $false
      foreach ($sg in $raw) {
        Write-Host ("    raw x={0} y={1} w={2} h={3}" -f $sg.x, $sg.y, $sg.w, $sg.h)
      }
      continue
    }
    for ($i = 0; $i -lt $expected.Count; $i++) {
      $frames += [pscustomobject]@{ name = $expected[$i]; x = $repaired[$i].x; y = $repaired[$i].y; w = $repaired[$i].w; h = $repaired[$i].h }
    }
  }

  $labels = @($frames | ForEach-Object { $_.name })
  $rectArr = [System.Drawing.Rectangle[]]@($frames | ForEach-Object { New-Object System.Drawing.Rectangle($_.x, $_.y, $_.w, $_.h) })
  if ($rectArr.Count -gt 0) {
    [MailXp.PngOps]::Contact($Paths[$key], $rectArr, [string[]]$labels, 5, 200, 150, (Join-Path $Debug "contact-$key.png"))
    Write-Host ("  contact sheet: {0}" -f (Join-Path $Debug "contact-$key.png"))
  }
  $atlasPlan += [pscustomobject]@{ Key = $key; Path = $Paths[$key]; Frames = $frames; Ok = $ok }
}

# grid sheets
$npcGrid = Get-GridFrames -Path $Paths.npcs -Cols 4 -Rows 4 -Snap 64 -ProjThr 32
$aiGrid  = Get-GridFrames -Path $Paths.ai   -Cols 4 -Rows 2 -Snap 30 -ProjThr 32
$birdGrid = Get-GridFrames -Path $Paths.bird -Cols 4 -Rows 2 -Snap 30 -ProjThr 32
$workerGrid = Get-GridFrames -Path $Paths.worker -Cols 4 -Rows 4 -Snap 4 -ProjThr 32 -NoSnap
$interactGrid = Get-GridFrames -Path $Paths.interact -Cols 4 -Rows 1 -Snap 4 -ProjThr 32 -NoSnap

$npcNames = foreach ($row in @('down', 'left', 'right', 'up')) { foreach ($col in @('officer', 'agent', 'monkey', 'intern')) { "$col-$row" } }
# frames are generated row-major: row = direction, col = character
$aiNames = foreach ($row in @('understanding', 'response')) { foreach ($col in @('front', 'left', 'right', 'back')) { "$row-$col" } }
$birdNames = @(); foreach ($c in 0..3) { $birdNames += "right-$c" }; foreach ($c in 0..3) { $birdNames += "left-$c" }
$workerNames = @(); foreach ($r in @('down', 'left', 'right', 'up')) { foreach ($c in @('idle-a', 'idle-b', 'walk-a', 'walk-b')) { $workerNames += "$r-$c" } }
$interactNames = @('down', 'left', 'right', 'up')

function Attach-Names {
  param($Grid, [string[]]$Names)
  $out = @(); $i = 0
  foreach ($f in $Grid.Frames) {
    $out += [pscustomobject]@{ name = $Names[$i]; x = $f.x; y = $f.y; w = $f.w; h = $f.h }
    $i++
  }
  , $out
}

$npcFrames   = Attach-Names -Grid $npcGrid -Names $npcNames
$aiFrames    = Attach-Names -Grid $aiGrid -Names $aiNames
$birdFrames  = Attach-Names -Grid $birdGrid -Names $birdNames
$workerFrames = Attach-Names -Grid $workerGrid -Names $workerNames
$interactFrames = Attach-Names -Grid $interactGrid -Names $interactNames

foreach ($spec in @(
    @{ k = 'npcs'; p = $Paths.npcs; f = $npcFrames; g = $npcGrid },
    @{ k = 'ai'; p = $Paths.ai; f = $aiFrames; g = $aiGrid },
    @{ k = 'bird'; p = $Paths.bird; f = $birdFrames; g = $birdGrid },
    @{ k = 'worker'; p = $Paths.worker; f = $workerFrames; g = $workerGrid },
    @{ k = 'interact'; p = $Paths.interact; f = $interactFrames; g = $interactGrid }
  )) {
  $labels = @($spec.f | ForEach-Object { $_.name })
  $rectArr = [System.Drawing.Rectangle[]]@($spec.f | ForEach-Object { New-Object System.Drawing.Rectangle($_.x, $_.y, $_.w, $_.h) })
  [MailXp.PngOps]::Contact($spec.p, $rectArr, [string[]]$labels, 5, 200, 160, (Join-Path $Debug "contact-$($spec.k).png"))
  Write-Host ("contact-{0}: xbound={1} ybound={2}" -f $spec.k, ($spec.g.XBound -join ','), ($spec.g.YBound -join ','))
}

# tileset: numbered source-cell contact + crop preview
$tileImg = [System.Drawing.Image]::FromFile($Paths.tiles)
$tileW = $tileImg.Width; $tileH = $tileImg.Height; $tileImg.Dispose()
$cellW = $tileW / 16.0; $cellH = $tileH / 8.0
$allCells = @(); $cellLabels = @()
for ($r = 0; $r -lt 8; $r++) {
  for ($c = 0; $c -lt 16; $c++) {
    $x = [int][Math]::Round($c * $cellW); $y = [int][Math]::Round($r * $cellH)
    $x2 = [int][Math]::Round(($c + 1) * $cellW); $y2 = [int][Math]::Round(($r + 1) * $cellH)
    $allCells += New-Object System.Drawing.Rectangle($x, $y, ($x2 - $x), ($y2 - $y))
    $cellLabels += "r$r,c$c"
  }
}
[MailXp.PngOps]::Contact($Paths.tiles, [System.Drawing.Rectangle[]]$allCells, [string[]]$cellLabels, 16, 116, 128, (Join-Path $Debug 'contact-tileset-numbered.png'))
Write-Host ("tileset contact: {0}  (grid cell = {1} x {2})" -f (Join-Path $Debug 'contact-tileset-numbered.png'), $cellW, $cellH)

if ($Mode -eq 'analyze') {
  Write-Host 'Analyze complete. No processed outputs written.'
  exit 0
}

# --------------------------------------------------------------------- build --
$failed = $false
foreach ($plan in $atlasPlan) {
  if (-not $plan.Ok) { Write-Host ("ERROR: {0} segmentation mismatch - inspect contact sheets and adjust thresholds/names." -f $plan.Key); $failed = $true }
}
if ($failed) { exit 1 }

# atlas JSONs
$atlasUrls = @{
  'props'   = @{ url = '/assets/mailxp/office/office-props.png'; file = 'office-props.json' }
  'effects' = @{ url = '/assets/mailxp/items/mail-effects.png'; file = 'mail-effects.json' }
}
foreach ($plan in $atlasPlan) {
  Write-PhaserAtlas -TextureUrl $atlasUrls[$plan.Key].url -Frames $plan.Frames -Dest (Join-Path $Out $atlasUrls[$plan.Key].file)
}
Write-PhaserAtlas -Frames $npcFrames -Dest (Join-Path $Out 'office-npcs.json')
Write-PhaserAtlas -Frames $aiFrames -Dest (Join-Path $Out 'ai-workers.json')
Write-PhaserAtlas -Frames $birdFrames -Dest (Join-Path $Out 'mail-bird.json')

# 32x32 tilesheet from selected source cells
$tileRects = @()
foreach ($pick in $TilePicks) {
  $x = [int][Math]::Round($pick.c * $cellW); $y = [int][Math]::Round($pick.r * $cellH)
  $x2 = [int][Math]::Round(($pick.c + 1) * $cellW); $y2 = [int][Math]::Round(($pick.r + 1) * $cellH)
  $region = New-Object System.Drawing.Rectangle($x, $y, ($x2 - $x), ($y2 - $y))
  # trim to content bbox (alpha>=64) when it is reasonably cell-sized, else keep full cell
  $bbox = [MailXp.PngOps]::ContentBounds($Paths.tiles, $region, 64)
  $crop = $region
  if (-not $bbox.IsEmpty -and $bbox.Width * $bbox.Height -ge 0.55 * $region.Width * $region.Height) {
    $ratio = $bbox.Width / [double]$bbox.Height
    if ($ratio -ge 0.6 -and $ratio -le 1.7) { $crop = $bbox }
  }
  $tileRects += $crop
}
$tileCols = 8
[MailXp.PngOps]::BuildSheet($Paths.tiles, [System.Drawing.Rectangle[]]$tileRects, 32, $tileCols, (Join-Path $Out 'office-tiles-32.png'))
[MailXp.PngOps]::Contact($Paths.tiles, [System.Drawing.Rectangle[]]$tileRects, [string[]](@($TilePicks | ForEach-Object { $_.n })), $tileCols, 72, 72, (Join-Path $Debug 'contact-tiles-selected.png'))

# manifest
$tileEntries = @()
for ($i = 0; $i -lt $TilePicks.Count; $i++) {
  $pick = $TilePicks[$i]; $rect = $tileRects[$i]
  $tileEntries += [pscustomobject]@{
    name       = $pick.n
    slot       = $i
    sourceCell = [pscustomobject]@{ col = $pick.c; row = $pick.r }
    sourceRect = [pscustomobject]@{ x = $rect.X; y = $rect.Y; w = $rect.Width; h = $rect.Height }
    outputRect = [pscustomobject]@{ x = ($i % $tileCols) * 32; y = ([int][Math]::Floor($i / [double]$tileCols)) * 32; w = 32; h = 32 }
  }
}
$manifest = [pscustomobject]@{
  generatedBy  = 'scripts/generate-assets.ps1'
  generatedAt  = (Get-Date).ToString('o')
  originals    = 'public/assets/mailxp/** (untouched; this folder holds derived outputs only)'
  atlasFrames  = [pscustomobject]@{
    'office-props' = [pscustomobject]@{ source = '/assets/mailxp/office/office-props.png'; atlas = '/assets/mailxp/processed/office-props.json'; frames = @($atlasPlan[0].Frames | ForEach-Object { [pscustomobject]@{ name = $_.name; x = $_.x; y = $_.y; w = $_.w; h = $_.h } }) }
    'mail-effects' = [pscustomobject]@{ source = '/assets/mailxp/items/mail-effects.png'; atlas = '/assets/mailxp/processed/mail-effects.json'; frames = @($atlasPlan[1].Frames | ForEach-Object { [pscustomobject]@{ name = $_.name; x = $_.x; y = $_.y; w = $_.w; h = $_.h } }) }
    'office-npcs'  = [pscustomobject]@{ source = '/assets/mailxp/characters/npcs/office-npcs.png'; atlas = '/assets/mailxp/processed/office-npcs.json'; grid = '4 cols (officer, agent, monkey, intern) x 4 rows (down, left, right, up)'; frames = $npcFrames }
    'ai-workers'   = [pscustomobject]@{ source = '/assets/mailxp/characters/agents/ai-workers.png'; atlas = '/assets/mailxp/processed/ai-workers.json'; grid = '4 cols (front, left, right, back) x 2 rows (understanding, response)'; frames = $aiFrames }
    'mail-bird'    = [pscustomobject]@{ source = '/assets/mailxp/effects/mail-bird.png'; atlas = '/assets/mailxp/processed/mail-bird.json'; grid = '4 flap cols x 2 rows (right, left)'; frames = $birdFrames }
  }
  spritesheets = [pscustomobject]@{
    'worker'          = [pscustomobject]@{ source = '/assets/mailxp/characters/player/worker.png'; frameWidth = 313; frameHeight = 313; columns = 4; rows = 4; rowsOrder = @('down', 'left', 'right', 'up'); columnsOrder = @('idle-a', 'idle-b', 'walk-a', 'walk-b'); frameIndex = 'directionRow * 4 + poseColumn' }
    'worker-interact' = [pscustomobject]@{ source = '/assets/mailxp/characters/player/interact-directions.png'; frameWidth = 543; frameHeight = 724; frames = @('down', 'left', 'right', 'up') }
  }
  tiles = [pscustomobject]@{
    output      = '/assets/mailxp/processed/office-tiles-32.png'
    tileSize    = 32
    columns     = $tileCols
    sourceGrid  = [pscustomobject]@{ cols = 16; rows = 8; cellWidth = $cellW; cellHeight = $cellH }
    scaling     = 'nearest-neighbor, content-bbox crop (falls back to full source cell)'
    tiles       = $tileEntries
  }
}
Write-JsonFile -Object $manifest -Dest (Join-Path $Out 'manifest.json') -Depth 12

Write-Host "Build complete:"
Get-ChildItem $Out | ForEach-Object { Write-Host ("  {0}  ({1} bytes)" -f $_.Name, $_.Length) }
Write-Host ("Verify contact sheets in {0}" -f $Debug)
