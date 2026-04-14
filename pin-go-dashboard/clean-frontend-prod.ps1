$extensions = @("*.ts","*.tsx","*.js","*.jsx","*.css","*.html")

$files = Get-ChildItem -Recurse -Include $extensions | Where-Object {
    -not $_.PSIsContainer -and
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\dist\\" -and
    $_.FullName -notmatch "\\build\\"
}

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw

    $original = $content

    # Eliminar console.log / warn / error simples en una sola línea
    $content = [regex]::Replace($content, '^[ \t]*console\.(log|warn|error)\(.*?\);\s*\r?\n', '', 'Multiline')

    # Eliminar debugger;
    $content = [regex]::Replace($content, '^[ \t]*debugger;\s*\r?\n', '', 'Multiline')

    # Eliminar comentarios de una línea tipo TODO / FIXME / HACK
    $content = [regex]::Replace($content, '^[ \t]*//[ \t]*(TODO|FIXME|HACK).*?\r?\n', '', 'Multiline')

    # Eliminar comentarios en bloque de una sola línea con TODO / FIXME / HACK
    $content = [regex]::Replace($content, '^[ \t]*/\*[ \t]*(TODO|FIXME|HACK).*?\*/\s*\r?\n', '', 'Multiline')

    if ($content -ne $original) {
        Copy-Item $file.FullName "$($file.FullName).bak" -Force
        Set-Content -Path $file.FullName -Value $content -NoNewline
        Write-Host "Cleaned: $($file.FullName)"
    }
}