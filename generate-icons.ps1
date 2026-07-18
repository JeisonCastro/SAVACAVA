# ─── AUVRO — Generador de Iconos PWA ─────────────────────────────────────────
# Ejecutar: powershell -ExecutionPolicy Bypass -File generate-icons.ps1
# Requiere: icon-192.png en la raíz del proyecto

Add-Type -AssemblyName System.Drawing

$sourcePath = Join-Path $PSScriptRoot "icon-192.png"
if (-not (Test-Path $sourcePath)) {
    Write-Error "No se encontro icon-192.png en $PSScriptRoot"
    exit 1
}

$source = [System.Drawing.Image]::FromFile($sourcePath)

# ── Iconos para manifest.json ──
$manifestIcons = @(
    @{ Size = 72;   Name = "icon-72.png" },
    @{ Size = 96;   Name = "icon-96.png" },
    @{ Size = 128;  Name = "icon-128.png" },
    @{ Size = 144;  Name = "icon-144.png" },
    @{ Size = 152;  Name = "icon-152.png" },
    @{ Size = 384;  Name = "icon-384.png" }
)

# ── Apple Touch Icons ──
$appleIcons = @(
    @{ Size = 152; Name = "apple-touch-icon-152.png" },
    @{ Size = 167; Name = "apple-touch-icon-167.png" },
    @{ Size = 180; Name = "apple-touch-icon-180.png" }
)

function Resize-Icon {
    param(
        [System.Drawing.Image]$Src,
        [int]$TargetSize,
        [string]$OutputPath
    )
    $bmp = New-Object System.Drawing.Bitmap($TargetSize, $TargetSize)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($Src, 0, 0, $TargetSize, $TargetSize)
    $bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "  [OK] $OutputPath ($TargetSize x $TargetSize)"
}

# ── Generar iconos de manifest ──
Write-Host "`n=== Generando iconos para manifest.json ==="
foreach ($icon in $manifestIcons) {
    $out = Join-Path $PSScriptRoot $icon.Name
    Resize-Icon -Src $source -TargetSize $icon.Size -OutputPath $out
}

# ── Generar Apple Touch Icons ──
Write-Host "`n=== Generando Apple Touch Icons ==="
foreach ($icon in $appleIcons) {
    $out = Join-Path $PSScriptRoot $icon.Name
    Resize-Icon -Src $source -TargetSize $icon.Size -OutputPath $out
}

# ── Generar Splash Screens ──
Write-Host "`n=== Generando Splash Screens iOS ==="
$splashDir = Join-Path $PSScriptRoot "splash"
if (-not (Test-Path $splashDir)) {
    New-Item -ItemType Directory -Path $splashDir -Force | Out-Null
    Write-Host "  Directorio splash/ creado"
}

$splashScreens = @(
    @{ W = 390;  H = 844;  Name = "splash-390x844.png" },
    @{ W = 393;  H = 852;  Name = "splash-393x852.png" },
    @{ W = 428;  H = 926;  Name = "splash-428x926.png" },
    @{ W = 430;  H = 932;  Name = "splash-430x932.png" },
    @{ W = 375;  H = 667;  Name = "splash-375x667.png" },
    @{ W = 1024; H = 1366; Name = "splash-1024x1366.png" }
)

$bgColor = [System.Drawing.Color]::FromArgb(6, 9, 15)  # #06090f

foreach ($sp in $splashScreens) {
    $bmp = New-Object System.Drawing.Bitmap($sp.W, $sp.H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($bgColor)

    # Logo centrado (192x192 o 25% del ancho menor, lo que sea mas pequeno)
    $logoSize = [Math]::Min(192, [Math]::Min($sp.W, $sp.H) * 0.25)
    $logoX = ($sp.W - $logoSize) / 2
    $logoY = ($sp.H - $logoSize) / 2 - ($sp.H * 0.08)  # ligeramente arriba del centro

    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($source, $logoX, $logoY, $logoSize, $logoSize)

    # Texto "AUVRO" debajo del logo
    $font = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(232, 240, 248))
    $textSize = $g.MeasureString("AUVRO", $font)
    $textX = ($sp.W - $textSize.Width) / 2
    $textY = $logoY + $logoSize + 16
    $g.DrawString("AUVRO", $font, $brush, $textX, $textY)

    $outPath = Join-Path $splashDir $sp.Name
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $font.Dispose()
    $brush.Dispose()
    Write-Host "  [OK] splash/$($sp.Name) ($($sp.W)x$($sp.H))"
}

$source.Dispose()

Write-Host "`n=== Todos los iconos generados correctamente ==="
Write-Host "Total: $($manifestIcons.Count + $appleIcons.Count + $splashScreens.Count) archivos"
