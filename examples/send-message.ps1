param(
    [string]$BaseUrl = 'http://127.0.0.1:19387/local/codex-bridge',
    [string]$SessionId,
    [string]$RequestId = [guid]::NewGuid().ToString(),
    [Parameter(Mandatory = $true)][string]$Text
)
$ErrorActionPreference = 'Stop'
$base = $BaseUrl.TrimEnd('/')
$health = Invoke-RestMethod "$base/v1/health" -TimeoutSec 10
if (-not $health.ready) { throw 'Plugin is not ready.' }
if ([string]::IsNullOrWhiteSpace($SessionId)) {
    $SessionId = 'session-' + [guid]::NewGuid().ToString()
    # Print the stable ID before creating: reuse it if the request outcome is unknown.
    Write-Output "SessionId: $SessionId"
    $createBody = @{ sessionId = $SessionId } | ConvertTo-Json -Compress
    Invoke-RestMethod "$base/v1/sessions" -Method Post -ContentType 'application/json' -Body $createBody -TimeoutSec 35 | Out-Null
}
Write-Output "RequestId: $RequestId"
$body = @{ sessionId = $SessionId; requestId = $RequestId; text = $Text; clientTimeZone = 'Asia/Shanghai' } | ConvertTo-Json -Compress
Invoke-RestMethod "$base/v1/messages" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 35
Write-Output "Status: $base/v1/status?sessionId=$SessionId&requestId=$RequestId"
Write-Output "Events: $base/v1/events?sessionId=$SessionId&sinceSeq=-1"