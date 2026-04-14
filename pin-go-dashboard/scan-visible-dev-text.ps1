$extensions = @("*.ts","*.tsx","*.js","*.jsx","*.html")

Get-ChildItem -Recurse -Include $extensions | Where-Object {
    -not $_.PSIsContainer -and
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.FullName -notmatch "\\dist\\" -and
    $_.FullName -notmatch "\\build\\"
} |
Select-String -Pattern "development|dev mode|test mode|beta|coming soon|placeholder|dummy|mock" |
Select-Object Path, LineNumber, Line