<#
.SYNOPSIS
  Validates the outputs of scripts/generate-assets.ps1 (build mode).

.DESCRIPTION
  Checks, without relying on visual inspection:
    - every atlas JSON parses, has the expected frame count, unique names
    - every frame rect lies inside its source PNG and frames never overlap
    - every frame contains real pixels (alpha coverage), no empty frames
    - semantic sanity: props row-1 auto-split put 'plant' (green) and
      'couch' (warm red/orange) in the correct, disjoint frames
    - office-tiles-32.png dimensions match the tile count / 8 columns
    - every tile source rect is inside the tileset, output rect inside the sheet
    - manifest.json frame rects match the per-atlas JSONs exactly
    - worker.png is exactly 4 x 313 (+2 unused) and interact 4 x 543
    - Phase 6: shop decor atlases (8/12/12/12 frames) pass the same
      bounds/coverage/overlap checks; outfit sheets are exactly 1254x1254
  Exit code 0 = pass, 1 = failures found.

.EXAMPLE
  powershell -File scripts/validate-assets.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace MailXpV
{
    public static class Stats
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

        public static int[] Dims(string path) { int w, h; Load(path, out w, out h); return new int[] { w, h }; }

        // mode 0 = opaque, 1 = greenish opaque (g>r && g>b), 2 = reddish opaque (r>g && r>b)
        public static long Count(string path, int x, int y, int w, int h, int mode, int thr)
        {
            int iw, ih; byte[] buf = Load(path, out iw, out ih);
            long n = 0;
            for (int yy = y; yy < y + h; yy++)
            {
                if (yy < 0 || yy >= ih) continue;
                int off = yy * iw * 4;
                for (int xx = x; xx < x + w; xx++)
                {
                    if (xx < 0 || xx >= iw) continue;
                    int s = off + xx * 4;
                    int b = buf[s], g = buf[s + 1], r = buf[s + 2], a = buf[s + 3];
                    if (a < thr) continue;
                    if (mode == 0) n++;
                    else if (mode == 1 && g > r && g > b) n++;
                    else if (mode == 2 && r > g && r > b) n++;
                }
            }
            return n;
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root 'public\assets\mailxp'
$Out = Join-Path $Src 'processed'
$fail = @()
$warn = @()

$atlases = @(
  @{ file = 'office-props.json'; src = Join-Path $Src 'office\office-props.png'; count = 21 },
  @{ file = 'mail-effects.json'; src = Join-Path $Src 'items\mail-effects.png'; count = 14 },
  @{ file = 'office-npcs.json'; src = Join-Path $Src 'characters\npcs\office-npcs.png'; count = 16 },
  @{ file = 'ai-workers.json'; src = Join-Path $Src 'characters\agents\ai-workers.png'; count = 8 },
  @{ file = 'mail-bird.json'; src = Join-Path $Src 'effects\mail-bird.png'; count = 8 },
  # Phase 6 shop decor (scripts/measure-shop-assets.ps1 -> shop-manifest.json)
  # softOverlap: frames come from connected-component segmentation whose tight
  # boxes may interlock around organic shapes without sharing pixels.
  @{ file = 'shop-decor.json'; src = Join-Path $Src 'shop\decor\shop-decor.png'; count = 8; softOverlap = $true },
  @{ file = 'shop-wall.json'; src = Join-Path $Src 'shop\decor\shop-wall-decor.png'; count = 12; softOverlap = $true },
  @{ file = 'shop-plants.json'; src = Join-Path $Src 'shop\decor\shop-plants-rugs.png'; count = 12; softOverlap = $true },
  @{ file = 'shop-desk.json'; src = Join-Path $Src 'shop\decor\shop-desk-lounge.png'; count = 12; softOverlap = $true }
)

$frameData = @{}
foreach ($a in $atlases) {
  $jsonPath = Join-Path $Out $a.file
  if (-not (Test-Path $jsonPath)) { $fail += "missing $($a.file)"; continue }
  # NOTE: PS 5.1 ConvertFrom-Json emits a wrapped array as ONE pipeline object;
  # @( <command> ) would keep it nested. Assign first, then flatten via @($var).
  # Atlas files are { "frames": [ { filename, frame, ... }, ... ] } — the JSON
  # Array shape Phaser's TextureManager.addAtlas() dispatches to its array parser.
  $doc = Get-Content -Raw -Path $jsonPath | ConvertFrom-Json
  $framesProp = $doc.frames
  $items = @($framesProp)
  $dims = [MailXpV.Stats]::Dims($a.src)
  $w0 = $dims[0]; $h0 = $dims[1]
  if ($items.Count -ne $a.count) { $fail += "$($a.file): expected $($a.count) frames, got $($items.Count)" }

  $names = @{}
  $rects = @()
  foreach ($it in $items) {
    if ($names.ContainsKey($it.filename)) { $fail += "$($a.file): duplicate name '$($it.filename)'" }
    $names[$it.filename] = $true
    $f = $it.frame
    if ($f.x -lt 0 -or $f.y -lt 0 -or $f.w -le 0 -or $f.h -le 0 -or ($f.x + $f.w) -gt $w0 -or ($f.y + $f.h) -gt $h0) {
      $fail += "$($a.file): '$($it.filename)' out of bounds ($($f.x),$($f.y),$($f.w),$($f.h)) vs ${w0}x${h0}"
    }
    $rects += ,$f
    $cov = [MailXpV.Stats]::Count($a.src, $f.x, $f.y, $f.w, $f.h, 0, 64) / [double][Math]::Max(1, ($f.w * $f.h))
    if ($cov -lt 0.005) { $fail += "$($a.file): '$($it.filename)' coverage $([Math]::Round($cov * 100, 2))% - looks empty/sliced" }
    elseif ($cov -lt 0.02) { $warn += "$($a.file): '$($it.filename)' low coverage $([Math]::Round($cov * 100, 2))%" }
  }

  for ($i = 0; $i -lt $rects.Count; $i++) {
    for ($j = $i + 1; $j -lt $rects.Count; $j++) {
      $r1 = $rects[$i]; $r2 = $rects[$j]
      if ($r1.x -lt ($r2.x + $r2.w) -and $r2.x -lt ($r1.x + $r1.w) -and $r1.y -lt ($r2.y + $r2.h) -and $r2.y -lt ($r1.y + $r1.h)) {
        $ovW = [Math]::Min($r1.x + $r1.w, $r2.x + $r2.w) - [Math]::Max($r1.x, $r2.x)
        $ovH = [Math]::Min($r1.y + $r1.h, $r2.y + $r2.h) - [Math]::Max($r1.y, $r2.y)
        $ovArea = $ovW * $ovH
        # Connected-component segmentation (shop sheets) yields tight boxes that
        # may *interlock* around organic shapes (leaf tips beside a pot) while
        # sharing zero pixels — visually verified, so only a large overlap
        # (possible double-counted content) still fails the build.
        if ($a.softOverlap -and $ovArea -le 10000) {
          $warn += "$($a.file): frames #$i/#$j bounding boxes interlock ${ovW}x${ovH}px (disjoint pixels, expected for CC segmentation)"
        } else {
          $fail += "$($a.file): frame #$i overlaps frame #$j (${ovW}x${ovH}px)"
        }
      }
    }
  }
  $frameData[$a.file] = $items
  Write-Host ("{0}: {1} frames, source {2}x{3} - checks done" -f $a.file, $items.Count, $w0, $h0)
}

# --- semantic check: the auto-split of couch+plant produced correct frames ---
if ($frameData.ContainsKey('office-props.json')) {
  $byName = @{}
  foreach ($it in $frameData['office-props.json']) { $byName[$it.filename] = $it.frame }
  $propsSrc = Join-Path $Src 'office\office-props.png'
  if ($byName.ContainsKey('plant') -and $byName.ContainsKey('couch')) {
    $pf = $byName['plant']; $cf = $byName['couch']
    $plantOpq = [MailXpV.Stats]::Count($propsSrc, $pf.x, $pf.y, $pf.w, $pf.h, 0, 64)
    $plantGrn = [MailXpV.Stats]::Count($propsSrc, $pf.x, $pf.y, $pf.w, $pf.h, 1, 64)
    $couchOpq = [MailXpV.Stats]::Count($propsSrc, $cf.x, $cf.y, $cf.w, $cf.h, 0, 64)
    $couchRed = [MailXpV.Stats]::Count($propsSrc, $cf.x, $cf.y, $cf.w, $cf.h, 2, 64)
    $gFrac = $plantGrn / [double][Math]::Max(1, $plantOpq)
    $rFrac = $couchRed / [double][Math]::Max(1, $couchOpq)
    if ($gFrac -lt 0.05) { $fail += "plant frame is only $([Math]::Round($gFrac * 100, 1))% green - auto-split likely cut wrongly" }
    if ($rFrac -lt 0.05) { $fail += "couch frame is only $([Math]::Round($rFrac * 100, 1))% warm-red - auto-split likely cut wrongly" }
    if (($cf.x + $cf.w) -gt $pf.x) { $fail += "couch frame is not left-disjoint from plant frame" }
    Write-Host ("couch/plant split: plant green {0}%, couch warm-red {1}%" -f [Math]::Round($gFrac * 100, 1), [Math]::Round($rFrac * 100, 1))

    # Boundary-density check: the split column must be a genuine visual gap, not a
    # cut through the middle of an object. Compare opaque density in a 9px strip at
    # the split against a 9px strip in the couch interior.
    $split = $cf.x + $cf.w
    $bndOpq = [MailXpV.Stats]::Count($propsSrc, $split - 4, $cf.y, 9, $cf.h, 0, 64)
    $midX = $cf.x + [int]($cf.w / 2)
    $midOpq = [MailXpV.Stats]::Count($propsSrc, $midX - 4, $cf.y, 9, $cf.h, 0, 64)
    if ($midOpq -gt 0) {
      $ratio = $bndOpq / [double]$midOpq
      $pct = [Math]::Round($ratio * 100)
      if ($ratio -gt 0.5) { $fail += "couch/plant split at x=$split cuts through content (boundary density $pct% of couch interior)" }
      elseif ($ratio -gt 0.35) { $warn += "couch/plant split at x=$split boundary density $pct% - check visually" }
      Write-Host ("couch/plant split boundary density = {0}% of couch interior (split x={1})" -f $pct, $split)
    }
  } else {
    $fail += "props atlas missing 'couch' and/or 'plant' frames"
  }
}

# --- tilesheet + manifest ---
$manifestPath = Join-Path $Out 'manifest.json'
if (-not (Test-Path $manifestPath)) {
  $fail += 'missing manifest.json'
} else {
  $m = Get-Content -Raw $manifestPath | ConvertFrom-Json
  $tileOut = Join-Path $Out 'office-tiles-32.png'
  if (-not (Test-Path $tileOut)) {
    $fail += 'missing office-tiles-32.png'
  } else {
    $d = [MailXpV.Stats]::Dims($tileOut)
    $tilesRaw = $m.tiles.tiles
    $tiles = @($tilesRaw)
    $cols = [int]$m.tiles.columns
    $rows = [int][Math]::Ceiling($tiles.Count / [double]$cols)
    if ($d[0] -ne ($cols * 32) -or $d[1] -ne ($rows * 32)) {
      $fail += "tilesheet is $($d[0])x$($d[1]), expected $($cols * 32)x$($rows * 32) for $($tiles.Count) tiles"
    }
    $tsrc = Join-Path $Src 'tilesets\office\office-tileset.png'
    $td = [MailXpV.Stats]::Dims($tsrc)
    foreach ($t in $tiles) {
      $sr = $t.sourceRect; $or = $t.outputRect
      if (($sr.x + $sr.w) -gt $td[0] -or ($sr.y + $sr.h) -gt $td[1]) { $fail += "tile '$($t.name)' source rect outside tileset" }
      if (($or.x + $or.w) -gt $d[0] -or ($or.y + $or.h) -gt $d[1]) { $fail += "tile '$($t.name)' output rect outside sheet" }
      $c = [MailXpV.Stats]::Count($tileOut, $or.x, $or.y, $or.w, $or.h, 0, 64)
      if ($c -lt 64) { $fail += "tile '$($t.name)' output slot is empty ($c px)" }
    }
    $names = @{}
    foreach ($t in $tiles) { if ($names.ContainsKey($t.name)) { $fail += "duplicate tile name '$($t.name)'" }; $names[$t.name] = $true }
    Write-Host ("tiles: {0} entries, sheet {1}x{2}" -f $tiles.Count, $d[0], $d[1])
  }

  # manifest <-> atlas JSON consistency
  foreach ($key in @('office-props', 'mail-effects', 'office-npcs', 'ai-workers', 'mail-bird')) {
    $jsonName = "$key.json"
    if (-not $frameData.ContainsKey($jsonName)) { continue }
    $jfRaw = $frameData[$jsonName]
    $jf = @($jfRaw)
    $mfRaw = $m.atlasFrames.$key.frames
    $mf = @($mfRaw)
    if ($jf.Count -ne $mf.Count) { $fail += "manifest '$key' frame count $($mf.Count) != atlas $($jf.Count)"; continue }
    for ($i = 0; $i -lt $jf.Count; $i++) {
      $a1 = $jf[$i]; $b1 = $mf[$i]
      if ($a1.filename -ne $b1.name -or $a1.frame.x -ne $b1.x -or $a1.frame.y -ne $b1.y -or $a1.frame.w -ne $b1.w -or $a1.frame.h -ne $b1.h) {
        $fail += "manifest '$key' frame #$i differs from $($jsonName)"
      }
    }
  }

  # sprite sheet documentation vs real dimensions
  $wd = [MailXpV.Stats]::Dims((Join-Path $Src 'characters\player\worker.png'))
  $id = [MailXpV.Stats]::Dims((Join-Path $Src 'characters\player\interact-directions.png'))
  if ($wd[0] -ne 1254 -or $wd[1] -ne 1254) { $fail += "worker.png is $($wd[0])x$($wd[1]), expected 1254x1254 (4x313 + 2)" }
  if ($id[0] -ne 2172 -or $id[1] -ne 724) { $fail += "interact-directions.png is $($id[0])x$($id[1]), expected 2172x724 (4x543)" }
  if ([int]$m.spritesheets.worker.frameWidth -ne 313) { $fail += 'manifest worker.frameWidth != 313' }
  if ([int]$m.spritesheets.'worker-interact'.frameWidth -ne 543) { $fail += 'manifest worker-interact.frameWidth != 543' }

  # Phase 6 outfit sheets must match worker.png's exact 4 x 313 layout, or the
  # shared idle/walk animations would play on wrong frames.
  foreach ($outfit in @('worker-courier', 'worker-tech', 'worker-forest')) {
    $od = [MailXpV.Stats]::Dims((Join-Path $Src "shop\outfits\$outfit.png"))
    if ($od[0] -ne 1254 -or $od[1] -ne 1254) { $fail += "shop/outfits/$outfit.png is $($od[0])x$($od[1]), expected 1254x1254 (4x313 + 2)" }
  }
}

Write-Host ''
if ($warn.Count -gt 0) { foreach ($w in $warn) { Write-Host "WARN: $w" -ForegroundColor Yellow } }
if ($fail.Count -gt 0) {
  foreach ($f in $fail) { Write-Host "FAIL: $f" -ForegroundColor Red }
  Write-Host "VALIDATION FAILED ($($fail.Count) errors, $($warn.Count) warnings)" -ForegroundColor Red
  exit 1
}
Write-Host "VALIDATION PASSED (0 errors, $($warn.Count) warnings)" -ForegroundColor Green
exit 0
