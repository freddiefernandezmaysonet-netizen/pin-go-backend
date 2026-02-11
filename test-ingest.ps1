# test-ingest.ps1
$BaseUrl = "http://localhost:3000"

# ====== AJUSTA ESTOS 2 CAMPOS ======
$PropertyId = "prop-1"
$GuestName  = "Test Guest"
$GuestPhone = "7875555555"   # puede ser cualquiera, ideal 10 digitos

# Ventana de prueba
$Now = Get-Date
$CheckIn  = ($Now.AddMinutes(-10).ToUniversalTime()).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$CheckOut = ($Now.AddMinutes(60).ToUniversalTime()).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# Idempotencia (no duplica)
$IngestKey = "ps-" + [Guid]::NewGuid().ToString()

$Body = @{
  propertyId   = $PropertyId
  guestName    = $GuestName
  guestPhone   = $GuestPhone
  checkIn      = $CheckIn
  checkOut     = $CheckOut
  paymentState = "PAID"
  source       = "powershell"
  ingestKey    = $IngestKey
} | ConvertTo-Json -Depth 20

Write-Host "== Sending ingest reservation ==" -ForegroundColor Cyan
Write-Host "checkIn : $CheckIn"
Write-Host "checkOut: $CheckOut"
Write-Host "ingestKey: $IngestKey"

try {
  $Resp = Invoke-RestMethod `
    -Method POST `
    -Uri "$BaseUrl/api/ingest/reservations" `
    -ContentType "application/json" `
    -Body $Body

  Write-Host "`n== Response ==" -ForegroundColor Green
  $Resp | ConvertTo-Json -Depth 50

} catch {
  Write-Host "`n== ERROR ==" -ForegroundColor Red
  $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-Host $_.ErrorDetails.Message
  }
}
