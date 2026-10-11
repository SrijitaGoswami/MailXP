<#
.SYNOPSIS
  MailXP shop asset measurement (Phase 6) — extracts exact frame rectangles for
  the shop art WITHOUT modifying any original file.

.DESCRIPTION
  Reads public/assets/mailxp/shop/** (read-only) and writes new outputs into
  public/assets/mailxp/processed/ (existing processed files are never touched):

    shop-decor.json           8 irregular items from decor/shop-decor.png
    shop-wall-decor.json      4 x 3 grid cells (362 px), alpha-trimmed
    shop-plants-rugs.json     4 x 3 grid cells (362 px), alpha-trimmed
    shop-desk-lounge.json     4 x 3 grid cells (362 px), alpha-trimmed
    shop-manifest.json        machine-readable item -> sheet/frame record

  Every frame rect is the *content* bounding box (alpha >= 8) of its cell, so
  Phaser gets tight frames. Contact sheets for visual verification are written
  to a temp/debug folder (NOT public/).

  Outfits (outfits/worker-*.png) need no extraction: the shop guide states they
  are exact 1254 x 1254 / 4 x 4 / 313 px sheets like characters/player/worker.png,
  so PreloadScene loads them as plain spritesheets.

  Modes:
    -Mode analyze   contact sheets only (no processed outputs)
    -Mode build     write the JSON outputs (fails on unexpected item counts)

.EXAMPLE
  powershell -File scripts/measure-shop-assets.ps1 -Mode analyze
  powershell -File scripts/measure-shop-assets.ps1 -Mode build
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

namespace MailXpShop
{
    public static class Ops
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

        // content bounding box (alpha >= thr) inside region; Rectangle.Empty when blank
        public static Rectangle Trim(string path, Rectangle region, int thr)
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

        // 8-connected component labeling of alpha>=thr pixels; returns bounding
        // boxes of components with area >= minArea, then merges any component
        // whose box gap to a kept box is <= mergeGap on both axes.
        public static Rectangle[] Components(string path, int thr, int minArea, int mergeGap)
        {
            int w, h;
            byte[] buf = Load(path, out w, out h);
            int n = w * h;
            int[] label = new int[n];
            var boxes = new System.Collections.Generic.List<Rectangle>();
            var areas = new System.Collections.Generic.List<int>();
            var stack = new System.Collections.Generic.Stack<int>();
            int comp = 0;
            for (int i = 0; i < n; i++)
            {
                if (label[i] != 0) continue;
                if (buf[i * 4 + 3] < thr) { label[i] = -1; continue; }
                comp++;
                int x0 = w, y0 = h, x1 = -1, y1 = -1, a = 0;
                label[i] = comp; stack.Push(i);
                while (stack.Count > 0)
                {
                    int p = stack.Pop();
                    int px = p % w, py = p / w;
                    a++;
                    if (px < x0) x0 = px; if (px > x1) x1 = px;
                    if (py < y0) y0 = py; if (py > y1) y1 = py;
                    for (int dy = -1; dy <= 1; dy++)
                        for (int dx = -1; dx <= 1; dx++)
                        {
                            if (dx == 0 && dy == 0) continue;
                            int nx = px + dx, ny = py + dy;
                            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                            int q = ny * w + nx;
                            if (label[q] != 0) continue;
                            if (buf[q * 4 + 3] < thr) { label[q] = -1; continue; }
                            label[q] = comp; stack.Push(q);
                        }
                }
                boxes.Add(new Rectangle(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
                areas.Add(a);
            }
            // drop specks, merge fragments that sit right next to a real item
            var keep = new System.Collections.Generic.List<int>();
            for (int i = 0; i < boxes.Count; i++) if (areas[i] >= minArea) keep.Add(i);
            bool changed = true;
            while (changed)
            {
                changed = false;
                for (int k = 0; k < keep.Count; k++)
                {
                    for (int i = 0; i < boxes.Count; i++)
                    {
                        if (areas[i] >= minArea) continue;
                        if (areas[i] <= 0) continue; // already merged or dropped
                        bool inKeep = false;
                        foreach (int kk in keep) if (kk == i) { inKeep = true; break; }
                        if (inKeep) continue;
                        Rectangle f = boxes[i];
                        int best = -1; int bestArea = 0;
                        foreach (int kk in keep)
                        {
                            Rectangle g = boxes[kk];
                            int gapX = Math.Max(0, Math.Max(g.X - f.Right, f.X - g.Right));
                            int gapY = Math.Max(0, Math.Max(g.Y - f.Bottom, f.Y - g.Bottom));
                            if (gapX <= mergeGap && gapY <= mergeGap && areas[kk] > bestArea)
                            { best = kk; bestArea = areas[kk]; }
                        }
                        if (best >= 0)
                        {
                            Rectangle g = boxes[best];
                            int nx0 = Math.Min(g.X, f.X), ny0 = Math.Min(g.Y, f.Y);
                            int nx1 = Math.Max(g.Right, f.Right), ny1 = Math.Max(g.Bottom, f.Bottom);
                            boxes[best] = new Rectangle(nx0, ny0, nx1 - nx0, ny1 - ny0);
                            areas[best] += areas[i];
                            areas[i] = -1;
                            changed = true;
                        }
                        else
                        {
                            areas[i] = -1; // stray speck with no keeper nearby
                        }
                    }
                }
            }
            var outBoxes = new System.Collections.Generic.List<Rectangle>();
            foreach (int i in keep) if (areas[i] > 0) outBoxes.Add(boxes[i]);
            return outBoxes.ToArray();
        }

        // axis 0 = per-column alpha counts, 1 = per-row alpha counts
        public static int[] Proj(string path, int axis, int thr)        {
            return ProjIn(path, axis, thr, new Rectangle(0, 0, int.MaxValue, int.MaxValue));
        }

        // same projection restricted to a region (region clipped to the image)
        public static int[] ProjIn(string path, int axis, int thr, Rectangle region)
        {
            int w, h;
            byte[] buf = Load(path, out w, out h);
            int x0 = Math.Max(0, region.X), x1 = Math.Min(w, region.Right);
            int y0 = Math.Max(0, region.Y), y1 = Math.Min(h, region.Bottom);
            if (axis == 0)
            {
                int[] p = new int[Math.Max(0, x1 - x0)];
                for (int y = y0; y < y1; y++)
                {
                    int off = y * w * 4;
                    for (int x = x0; x < x1; x++)
                        if (buf[off + x * 4 + 3] >= thr) p[x - x0]++;
                }
                return p;
            }
            else
            {
                int[] p = new int[Math.Max(0, y1 - y0)];
                for (int y = y0; y < y1; y++)
                {
                    int off = y * w * 4;
                    for (int x = x0; x < x1; x++)
                        if (buf[off + x * 4 + 3] >= thr) p[y - y0]++;
                }
                return p;
            }
        }

        // split an axis projection into [start,len] content runs separated by >= minGap zeros
        public static int[][] Runs(int[] proj, int minGap)
        {
            var runs = new System.Collections.Generic.List<int[]>();
            int start = -1;
            for (int i = 0; i <= proj.Length; i++)
            {
                bool filled = i < proj.Length && proj[i] > 0;
                if (filled && start < 0) start = i;
                if (!filled && start >= 0)
                {
                    runs.Add(new int[] { start, i - start });
                    start = -1;
                }
            }
            // merge runs separated by less than minGap zeros (antialiasing slivers)
            var merged = new System.Collections.Generic.List<int[]>();
            foreach (var r in runs)
            {
                if (merged.Count > 0)
                {
                    var last = merged[merged.Count - 1];
                    int gap = r[0] - (last[0] + last[1]);
                    if (gap < minGap) { last[1] = last[1] + gap + r[1]; continue; }
                }
                merged.Add(new int[] { r[0], r[1] });
            }
            return merged.ToArray();
        }

        // contact sheet: frames fit (aspect preserved) into cols x cellW/cellH cells with labels
        public static void Contact(string srcPath, Rectangle[] frames, string[] labels, int cols, int cellW, int cellH, string destPath)
        {
            int w, h;
            byte[] buf = Load(srcPath, out w, out h);
            int rows = (frames.Length + cols - 1) / cols;
            int sw = cols * cellW, sh = rows * cellH;
            byte[] outBuf = new byte[sw * sh * 4];
            for (int i = 0; i < outBuf.Length; i += 4) { outBuf[i] = 32; outBuf[i + 1] = 32; outBuf[i + 2] = 36; outBuf[i + 3] = 255; }
            for (int i = 0; i < frames.Length; i++)
            {
                Rectangle f = frames[i];
                if (f.Width <= 0 || f.Height <= 0) continue;
                double scale = Math.Min((double)(cellW - 8) / f.Width, (double)(cellH - 20) / f.Height);
                int dw = Math.Max(1, (int)(f.Width * scale)), dh = Math.Max(1, (int)(f.Height * scale));
                int ox = (i % cols) * cellW + (cellW - dw) / 2;
                int oy = (i / cols) * cellH + 16 + (cellH - 24 - dh) / 2;
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
                        if (buf[s + 3] < 8) continue;
                        int d = ((oy + y) * sw + ox + x) * 4;
                        outBuf[d] = buf[s]; outBuf[d + 1] = buf[s + 1]; outBuf[d + 2] = buf[s + 2]; outBuf[d + 3] = 255;
                    }
                }
            }
            using (var bmp = FromBuffer(sw, sh, outBuf))
            using (var g = Graphics.FromImage(bmp))
            using (var font = new Font("Consolas", 10f, FontStyle.Bold))
            using (var shadow = new SolidBrush(Color.FromArgb(210, 0, 0, 0)))
            using (var text = new SolidBrush(Color.Gold))
            {
                for (int i = 0; i < frames.Length && i < labels.Length; i++)
                {
                    float lx = (i % cols) * cellW + 3;
                    float ly = (i / cols) * cellH + 2;
                    g.DrawString(labels[i], font, shadow, lx + 1, ly + 1);
                    g.DrawString(labels[i], font, text, lx, ly);
                    g.DrawString(string.Format("{0}x{1}", frames[i].Width, frames[i].Height), font, shadow, lx + 1, ly + 12);
                    g.DrawString(string.Format("{0}x{1}", frames[i].Width, frames[i].Height), font, Brushes.Gainsboro, lx, ly + 11);
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
    }
}
'@ -ReferencedAssemblies System.Drawing

# ------------------------------------------------------------------ config --
$Root = Split-Path -Parent $PSScriptRoot
$Src  = Join-Path $Root 'public\assets\mailxp'
$Shop = Join-Path $Src 'shop'
$Out  = Join-Path $Src 'processed'
$Debug = Join-Path $env:TEMP 'mailxp-shop-debug'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
New-Item -ItemType Directory -Force -Path $Debug | Out-Null

$AlphaThreshold = 8

# Sheet specs. `names` are row-major; they are refined after inspecting the
# contact sheets in analyze mode (guide lists candidates, not exact cell order).
$Sheets = @(
  @{ key = 'decor'; rel = 'decor\shop-decor.png'; mode = 'segment';
     expect = 8; gap = 6;
     names = @('frame-abstract','trophy','rug-sage','desk-lamp','clock-pendulum','mug-cloud','potted-plant','bird-figurine') },
  @{ key = 'wall'; rel = 'decor\shop-wall-decor.png'; mode = 'grid';
     cols = 4; rows = 3; cell = 362; expect = 12;
     names = @('art-mountain','art-abstract','art-botanical','art-city','plaque-shield','bulletin-board','clock-gold','clock-teal','pennant','mirror-oval','mail-sorter','wall-sconce') },
  @{ key = 'plants'; rel = 'decor\shop-plants-rugs.png'; mode = 'cc';
     expect = 12; gap = 6; minArea = 250;
     names = @('plant-fiddle','plant-hanging','plant-monstera','succulents-tray','plant-bamboo','orchid','rug-round','rug-runner','umbrella-stand','rug-oval','floor-cushions','boot-tray') },
  @{ key = 'desk'; rel = 'decor\shop-desk-lounge.png'; mode = 'grid';
     cols = 4; rows = 3; cell = 362; expect = 12;
     names = @('desk-organizer','pen-cup','notebooks','timer','photo-frame','bird-statue','beanbag','floor-lamp','loveseat','footrest','coffee-tray','radio') }
)

# Outfit sheets: verified against the shop guide (exact 1254 x 1254, 4 x 4 of 313).
$Outfits = @(
  @{ rel = 'outfits\worker-courier.png'; w = 1254; h = 1254 },
  @{ rel = 'outfits\worker-tech.png';     w = 1254; h = 1254 },
  @{ rel = 'outfits\worker-forest.png';   w = 1254; h = 1254 }
)

# ------------------------------------------------------------------- helpers --
# Recursive split: separate a rect on full transparent gaps, x first then y.
# Used for sheets whose items are NOT laid out on the conceptual grid.
function Get-AutoRects {
  param([string]$Path, [System.Drawing.Rectangle]$Rect, [int]$Gap, [int]$Depth)
  $out = New-Object System.Collections.Generic.List[System.Drawing.Rectangle]
  if ($Depth -le 0) { $out.Add($Rect); return $out }

  $xp = [MailXpShop.Ops]::ProjIn($Path, 0, $AlphaThreshold, $Rect)
  $xRuns = [MailXpShop.Ops]::Runs($xp, $Gap)
  if ($xRuns.Count -gt 1) {
    foreach ($r in $xRuns) {
      $sub = [System.Drawing.Rectangle]::new($Rect.X + $r[0], $Rect.Y, $r[1], $Rect.Height)
      $t = [MailXpShop.Ops]::Trim($Path, $sub, $AlphaThreshold)
      if ($t.Width -gt 0) { foreach ($g in (Get-AutoRects -Path $Path -Rect $t -Gap $Gap -Depth ($Depth - 1))) { $out.Add($g) } }
    }
    return $out
  }

  $yp = [MailXpShop.Ops]::ProjIn($Path, 1, $AlphaThreshold, $Rect)
  $yRuns = [MailXpShop.Ops]::Runs($yp, $Gap)
  if ($yRuns.Count -gt 1) {
    foreach ($r in $yRuns) {
      $sub = [System.Drawing.Rectangle]::new($Rect.X, $Rect.Y + $r[0], $Rect.Width, $r[1])
      $t = [MailXpShop.Ops]::Trim($Path, $sub, $AlphaThreshold)
      if ($t.Width -gt 0) { foreach ($g in (Get-AutoRects -Path $Path -Rect $t -Gap $Gap -Depth ($Depth - 1))) { $out.Add($g) } }
    }
    return $out
  }

  $out.Add($Rect)
  return $out
}

function Get-Frames {
  param([hashtable]$Spec, [string]$Path)
  $rects = New-Object System.Collections.Generic.List[System.Drawing.Rectangle]
  $img = New-Object System.Drawing.Bitmap($Path)
  try {
    if ($Spec.mode -eq 'cc') {
      # pixel connected components: robust for sheets with no full-width gaps
      $gap = if ($Spec.ContainsKey('gap')) { [int]$Spec.gap } else { 6 }
      $minArea = if ($Spec.ContainsKey('minArea')) { [int]$Spec.minArea } else { 250 }
      foreach ($r in ([MailXpShop.Ops]::Components($Path, $AlphaThreshold, $minArea, $gap))) { $rects.Add($r) }
      $ordered = @($rects | Sort-Object @{e = { [int]($_.Y / 60) }}, X)
      $rects.Clear()
      foreach ($r in $ordered) { $rects.Add($r) }
    }
    elseif ($Spec.mode -eq 'auto') {
      # whole-sheet content bounds -> recursive split on transparent gaps
      $full = [System.Drawing.Rectangle]::new(0, 0, $img.Width, $img.Height)
      $bounds = [MailXpShop.Ops]::Trim($Path, $full, $AlphaThreshold)
      $gap = if ($Spec.ContainsKey('gap')) { [int]$Spec.gap } else { 6 }
      foreach ($r in (Get-AutoRects -Path $Path -Rect $bounds -Gap $gap -Depth 6)) { $rects.Add($r) }
      # reading order: top-to-bottom rows, left-to-right within a row
      $ordered = @($rects | Sort-Object @{e = { [int]($_.Y / 60) }}, X)
      $rects.Clear()
      foreach ($r in $ordered) { $rects.Add($r) }
    }
    elseif ($Spec.mode -eq 'grid') {
      $cell = [int]$Spec.cell
      for ($r = 0; $r -lt [int]$Spec.rows; $r++) {
        for ($c = 0; $c -lt [int]$Spec.cols; $c++) {
          $region = [System.Drawing.Rectangle]::new($c * $cell, $r * $cell, $cell, $cell)
          $t = [MailXpShop.Ops]::Trim($Path, $region, $AlphaThreshold)
          if ($t.Width -gt 0) { $rects.Add($t) }
          else { Write-Host ("  WARN {0}: empty cell ({1},{2})" -f $Spec.key, $c, $r) }
        }
      }
    }
    else {
      # irregular atlas: split on column gaps, then row gaps inside each column band
      $xp = [MailXpShop.Ops]::Proj($Path, 0, $AlphaThreshold)
      $cols = [MailXpShop.Ops]::Runs($xp, [int]$Spec.gap)
      foreach ($band in $cols) {
        $region = [System.Drawing.Rectangle]::new($band[0], 0, $band[1], $img.Height)
        $yp = [MailXpShop.Ops]::Proj($Path, 1, $AlphaThreshold) # full-height rows; narrowed below
        # narrow the row projection to this column band by re-trimming per candidate row run:
        $rowRuns = [MailXpShop.Ops]::Runs($yp, [int]$Spec.gap)
        foreach ($rr in $rowRuns) {
          $sub = [System.Drawing.Rectangle]::new($region.X, $rr[0], $region.Width, $rr[1])
          $t = [MailXpShop.Ops]::Trim($Path, $sub, $AlphaThreshold)
          if ($t.Width -gt 0) { $rects.Add($t) }
        }
      }
      # the naive band x rowRun cross product can produce overlapping boxes; de-dup by center
      $uniq = New-Object System.Collections.Generic.List[System.Drawing.Rectangle]
      foreach ($r in ($rects | Sort-Object X, Y)) {
        $dup = $false
        foreach ($u in $uniq) {
          $cx = $u.X + $u.Width / 2.0; $cy = $u.Y + $u.Height / 2.0
          if ($r.X -le $cx -and $r.Right -ge $cx -and $r.Y -le $cy -and $r.Bottom -ge $cy) { $dup = $true; break }
        }
        if (-not $dup) { $uniq.Add($r) }
      }
      $rects = $uniq
    }
  }
  finally { $img.Dispose() }
  return $rects
}

# --------------------------------------------------------------------- main --
$failed = $false
$manifest = [ordered]@{
  generatedBy = 'scripts/measure-shop-assets.ps1'
  note        = 'New Phase 6 outputs. Originals under public/assets/mailxp/shop/ are never modified.'
  alphaThreshold = $AlphaThreshold
  items = @()
}

Write-Host ("mode = {0}" -f $Mode)

# outfit dimension check (no writes, no extraction needed)
foreach ($o in $Outfits) {
  $p = Join-Path $Shop $o.rel
  if (-not (Test-Path $p)) { Write-Host ("ERROR missing outfit: {0}" -f $o.rel); $failed = $true; continue }
  $b = New-Object System.Drawing.Bitmap($p)
  try {
    $ok = ($b.Width -eq $o.w -and $b.Height -eq $o.h)
    Write-Host ("outfit {0}: {1}x{2} {3}" -f (Split-Path $o.rel -Leaf), $b.Width, $b.Height, $(if ($ok) { 'OK' } else { 'MISMATCH' }))
    if (-not $ok) { $failed = $true }
  } finally { $b.Dispose() }
}

foreach ($spec in $Sheets) {
  $path = Join-Path $Shop $spec.rel
  if (-not (Test-Path $path)) { Write-Host ("ERROR missing sheet: {0}" -f $spec.rel); $failed = $true; continue }
  Write-Host ("`n{0} ({1})" -f $spec.key, $spec.rel)
  $frames = Get-Frames -Spec $spec -Path $path
  Write-Host ("  frames found: {0} (expected {1})" -f $frames.Count, $spec.expect)

  # full-sheet dimensions (the React thumbnails scale the whole background)
  $sheetBmp = New-Object System.Drawing.Bitmap($path)
  $sheetW = $sheetBmp.Width; $sheetH = $sheetBmp.Height
  $sheetBmp.Dispose()

  $labels = @()
  $rectArr = @()
  for ($i = 0; $i -lt $frames.Count; $i++) {
    $name = if ($i -lt $spec.names.Count) { $spec.names[$i] } else { ("{0}-extra{1}" -f $spec.key, $i) }
    $labels += $name
    $rectArr += $frames[$i]
    $manifest.items += [ordered]@{
      id = $name; sheet = $spec.rel; sheetKey = $spec.key
      x = $frames[$i].X; y = $frames[$i].Y; w = $frames[$i].Width; h = $frames[$i].Height
      sheetWidth = $sheetW; sheetHeight = $sheetH
    }
  }
  if ($frames.Count -ne [int]$spec.expect) {
    Write-Host ("  WARN count mismatch for {0}" -f $spec.key)
    if ($Mode -eq 'build') { $failed = $true }
  }
  if ($Mode -eq 'build' -and $spec.names.Count -lt $frames.Count) {
    Write-Host ("  ERROR {0}: {1} frames but only {2} final names" -f $spec.key, $frames.Count, $spec.names.Count)
    $failed = $true
  }

  $contact = Join-Path $Debug ("contact-shop-{0}.png" -f $spec.key)
  # contact columns vary per sheet so the four sheets differ in pixel size
  $ccols = if ($spec.key -eq 'plants') { 3 } elseif ($spec.key -eq 'decor') { 4 } elseif ($spec.key -eq 'wall') { 5 } else { 4 }
  [MailXpShop.Ops]::Contact($path, $rectArr, $labels, $ccols, 220, 200, $contact)
  Write-Host ("  contact sheet: {0}" -f $contact)

  if ($Mode -eq 'build' -and $frames.Count -eq [int]$spec.expect) {
    # Phaser atlas JSON, same shape as the verified Phase 3 outputs
    $framesJson = @()
    for ($i = 0; $i -lt $frames.Count; $i++) {
      $f = $frames[$i]
      $framesJson += [ordered]@{
        filename       = $labels[$i]
        frame          = [ordered]@{ x = $f.X; y = $f.Y; w = $f.Width; h = $f.Height }
        rotated        = $false
        trimmed        = $false
        spriteSourceSize = [ordered]@{ x = 0; y = 0; w = $f.Width; h = $f.Height }
        sourceSize     = [ordered]@{ w = $f.Width; h = $f.Height }
      }
    }
    $doc = [ordered]@{ frames = $framesJson }
    $outPath = Join-Path $Out ("shop-{0}.json" -f $spec.key)
    # WriteAllText = UTF-8 without BOM (matches the verified Phase 3 outputs).
    [System.IO.File]::WriteAllText($outPath, ($doc | ConvertTo-Json -Depth 8))
    Write-Host ("  wrote {0}" -f $outPath)
  }
}

if ($Mode -eq 'build' -and -not $failed) {
  $manPath = Join-Path $Out 'shop-manifest.json'
  [System.IO.File]::WriteAllText($manPath, ($manifest | ConvertTo-Json -Depth 8))
  Write-Host ("`nwrote {0} ({1} items)" -f $manPath, $manifest.items.Count)
}

Write-Host ("`nVerify contact sheets in {0}" -f $Debug)
if ($failed) { Write-Host 'RESULT: FAILED'; exit 1 }
Write-Host ("RESULT: OK ({0})" -f $Mode)
exit 0
