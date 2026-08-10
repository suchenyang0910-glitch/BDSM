Import-Module Microsoft.PowerShell.Utility
$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:3001"
$demoUserId = "d73f84bb-d3a6-4695-99b1-88d26fa0db52"
$DEV_DEMO_TOKEN = "intune-dev-only"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$headers = @{ "x-demo-token" = $DEV_DEMO_TOKEN }

Write-Host ""
Write-Host "=== [SECURITY REGRESSION] 老 bypass 方式（无 x-demo-token 仅 query ?bypass=1） 期望 403 ===" -ForegroundColor Yellow
try {
  $r0 = Invoke-WebRequest -Uri "$base/api/__demo/login/$demoUserId`?bypass=1" -UseBasicParsing -TimeoutSec 8
  Write-Host "FAIL: STATUS=$($r0.StatusCode) 应该是 403!" -ForegroundColor Red
} catch {
  $st = 0; try { $st = [int]$_.Exception.Response.StatusCode.value__ } catch {}
  if ($st -eq 403) { Write-Host "✅ PASS 老 bypass 已禁用 返回=$st (预期 403)" -ForegroundColor Green }
  else { Write-Host "FAIL 老 bypass 返回=$st (预期 403)" -ForegroundColor Red }
}

Write-Host ""
Write-Host "=== [SECURITY REGRESSION] 错 token （x-demo-token=wrong-token） 期望 403 ===" -ForegroundColor Yellow
try {
  $r0b = Invoke-WebRequest -Uri "$base/api/__demo/login/$demoUserId" -UseBasicParsing -TimeoutSec 8 -Headers @{ "x-demo-token" = "wrong-token" }
  Write-Host "FAIL: STATUS=$($r0b.StatusCode) 应该是 403!" -ForegroundColor Red
} catch {
  $st = 0; try { $st = [int]$_.Exception.Response.StatusCode.value__ } catch {}
  if ($st -eq 403) { Write-Host "✅ PASS 错 token 被拒 返回=$st (预期 403)" -ForegroundColor Green }
  else { Write-Host "FAIL 错 token 返回=$st (预期 403)" -ForegroundColor Red }
}

Write-Host ""
Write-Host "=== [1] Demo Login (正确 x-demo-token, 预期 200) ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "$base/api/__demo/login/$demoUserId" -UseBasicParsing -WebSession $session -TimeoutSec 8 -Headers $headers
  Write-Host "STATUS=$($r.StatusCode) -> $($r.Content) header-x-dev-only=$($r.Headers['x-dev-only'] -join ',')"
} catch { Write-Host "FAILED: $_" -ForegroundColor Red }

Write-Host ""
Write-Host "=== [2] GET /api/home (unlocked=true 预期) ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "$base/api/home" -UseBasicParsing -WebSession $session -TimeoutSec 8
  $body = $r.Content | ConvertFrom-Json
  Write-Host "STATUS=$($r.StatusCode) unlocked=$($body.unlocked) hasMembership=$($body.meta.hasMembership) entCount=$($body.meta.entitlementCount)" -ForegroundColor Green
} catch { Write-Host "FAILED: $_" -ForegroundColor Red }

Write-Host ""
Write-Host "=== [3] GET /api/user/orders (total=1 预期) ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "$base/api/user/orders?page=1&pageSize=20" -UseBasicParsing -WebSession $session -TimeoutSec 8
  $body = $r.Content | ConvertFrom-Json
  Write-Host "STATUS=$($r.StatusCode) total=$($body.pagination.total) orderNos=$($body.items.orderNo -join ',') statuses=$($body.items.status -join ',')"
} catch { Write-Host "FAILED: $_" -ForegroundColor Red }

Write-Host ""
Write-Host "=== [4] GET /api/user/entitlements (summary.membership.status='active' 预期) ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "$base/api/user/entitlements" -UseBasicParsing -WebSession $session -TimeoutSec 8
  $body = $r.Content | ConvertFrom-Json
  Write-Host "STATUS=$($r.StatusCode) summary.membership=$($body.summary.membership.status) expires=$($body.summary.membership.expiresAt) memberships=$($body.memberships.Count)"
} catch { Write-Host "FAILED: $_" -ForegroundColor Red }

Write-Host ""
Write-Host "=== [5] POST /api/resources/topic-02/access-link (≠403 预期，200/502 都合法) ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest -Uri "$base/api/resources/topic-02/access-link" -Method POST -UseBasicParsing -WebSession $session -TimeoutSec 20 -ContentType "application/json; charset=utf-8" -Body "{}"
  Write-Host "STATUS=$($r.StatusCode) (✅ 期望：200 真频道 / 502 占位符；都≠403=通过)" -ForegroundColor Green
  Write-Host "BODY前200字: $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
} catch {
  $status = 0
  try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch {}
  $bodyText = ""
  try { $stream = $_.Exception.Response.GetResponseStream(); $reader = New-Object System.IO.StreamReader($stream); $bodyText = $reader.ReadToEnd() } catch {}
  if ($status -eq 403) { Write-Host "❌ FAIL STATUS=403 权限未过 BODY=$bodyText" -ForegroundColor Red }
  else { Write-Host "✅ PASS STATUS=$status (≠403) BODY前200=[$($bodyText.Substring(0,[Math]::Min(200,$bodyText.Length)))]" -ForegroundColor Green }
}
