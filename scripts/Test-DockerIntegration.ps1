<#
.SYNOPSIS
    Docker integration and failure-recovery tests for DistributedCache.

.DESCRIPTION
    Runs a full end-to-end test sequence against the live Docker Compose stack:

      S1  - Gateway health and node discovery
      S2  - Detect whether node ports are exposed on localhost
      S3  - PUT / GET / DELETE through the gateway
      S4  - Consistent-hash routing: key stored on exactly one node
      S5  - Find and pre-store a key that the ring maps to cache-node-2
      S6  - Stop cache-node-2 and verify failure detection + 503 handling
      S7  - Surviving nodes (1 and 3) still serve requests during outage
      S8  - Restart cache-node-2 and wait for health check
      S9  - Post-recovery: all nodes up, normal operations restored
      S10 - Container status summary

    Implements the SHA-256 consistent-hash ring in PowerShell (mirrors
    ConsistentHashRing.ts) so that the responsible node for any key can be
    predicted deterministically without relying on side-channel discovery.

.USAGE
    From the project root (docker compose stack must be running):
        .\scripts\Test-DockerIntegration.ps1

    With node ports exposed (docker-compose.override.yml active):
        .\scripts\Test-DockerIntegration.ps1

    The script detects node-port accessibility automatically and adjusts.

.NOTES
    - Restores cache-node-2 in a finally block even if a test throws.
    - Cleans up all test keys it creates.
    - Exits with code 0 (all passed) or 1 (one or more failures).
    - Safe to run repeatedly; uses randomised key prefixes per run.
    - Requires PowerShell 5.1 or later, Docker CLI in PATH.
#>

#Requires -Version 5.1

Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'   # we handle errors explicitly per-call

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

$GATEWAY_URL       = 'http://localhost:3000'
$NODE_DIRECT_URLS  = [ordered]@{
    'cache-node-1' = 'http://localhost:3001'
    'cache-node-2' = 'http://localhost:3002'
    'cache-node-3' = 'http://localhost:3003'
}
# Node names as the ring knows them (must match docker-compose env NODE_ID values)
$RING_NODE_IDS     = @('cache-node-1', 'cache-node-2', 'cache-node-3')
$VIRTUAL_NODES     = 100        # must match VIRTUAL_NODES env in docker-compose
$FAILURE_TARGET    = 'cache-node-2'

# Compose project file path (handles spaces in path via -f flag)
$COMPOSE_FILE      = Join-Path $PSScriptRoot '..\docker-compose.yml'
$COMPOSE_OVERRIDE  = Join-Path $PSScriptRoot '..\docker-compose.override.yml'

# Per-run key prefix so repeated runs don't interfere with each other
$RUN_ID            = Get-Random -Maximum 99999

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

$Script:PassCount     = 0
$Script:FailCount     = 0
$Script:SkipCount     = 0
$Script:HasFailure    = $false
$Script:NodePortsOk   = $false   # set during S2
$Script:Node2Stopped  = $false   # flag for finally-block cleanup

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function Write-Banner([string]$Text) {
    $line = '=' * 65
    Write-Host ''
    Write-Host $line                      -ForegroundColor Cyan
    Write-Host "  $Text"                  -ForegroundColor Cyan
    Write-Host $line                      -ForegroundColor Cyan
}

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host "  ------ $Text" -ForegroundColor Cyan
}

function Assert-Pass([string]$Label) {
    $Script:PassCount++
    Write-Host "  [PASS] $Label" -ForegroundColor Green
}

function Assert-Fail([string]$Label, [string]$Detail = '') {
    $Script:FailCount++
    $Script:HasFailure = $true
    $suffix = if ($Detail) { " | $Detail" } else { '' }
    Write-Host "  [FAIL] $Label$suffix" -ForegroundColor Red
}

function Assert-Skip([string]$Label, [string]$Reason = '') {
    $Script:SkipCount++
    $suffix = if ($Reason) { " ($Reason)" } else { '' }
    Write-Host "  [SKIP] $Label$suffix" -ForegroundColor Yellow
}

function Write-Info([string]$Text) {
    Write-Host "         $Text" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# HTTP helper --- never throws; always returns a result object
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function Invoke-Api {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]  $Method     = 'GET',
        [object]  $Body       = $null,
        [int]     $TimeoutSec = 8
    )

    $result = [PSCustomObject]@{
        Status  = 0
        Body    = $null
        OK      = $false
        Raw     = $null
    }

    $params = @{
        Uri             = $Uri
        Method          = $Method
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
    }

    if ($null -ne $Body) {
        $params.ContentType = 'application/json'
        $params.Body        = $Body | ConvertTo-Json -Compress -Depth 5
    }

    try {
        $raw            = Invoke-WebRequest @params
        $result.Status  = [int]$raw.StatusCode
        $result.Raw     = $raw.Content
        $result.OK      = $true
        try { $result.Body = $raw.Content | ConvertFrom-Json } catch {}
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) {
            $result.Status = [int]$resp.StatusCode
            $content = $null
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $content = $_.ErrorDetails.Message
            }
            if ([string]::IsNullOrEmpty($content)) {
                try {
                    $stream  = $resp.GetResponseStream()
                    if ($stream -and $stream.CanSeek) { $stream.Position = 0 }
                    $reader  = [System.IO.StreamReader]::new($stream)
                    $content = $reader.ReadToEnd()
                } catch {}
            }
            $result.Raw = $content
            if ($content) {
                try { $result.Body = $content | ConvertFrom-Json } catch {}
            }
        }
    }
    catch {
        # Connection refused, timeout, or non-WebException HTTP errors
        $ex = $_.Exception
        if ($ex.PSObject.Properties['Response'] -and $ex.Response) {
            $resp = $ex.Response
            if ($resp.PSObject.Properties['StatusCode']) {
                $result.Status = [int]$resp.StatusCode
            }
        }
        $content = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $content = $_.ErrorDetails.Message
        }
        $result.Raw = if ($content) { $content } else { $ex.Message }
        if ($content) {
            try { $result.Body = $content | ConvertFrom-Json } catch {}
        }
    }

    return $result
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# SHA-256 consistent hash ring --- mirrors ConsistentHashRing.ts exactly
#
#   Virtual-node label : "<nodeId>#<replicaIndex>"   (e.g. "cache-node-1#0")
#   Hash function      : SHA-256(label) --- lowercase hex
#   Ring               : sorted array of 300 hex strings
#   Key lookup         : SHA-256(key) --- lower-bound binary search --- wrap to [0]
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function Get-Sha256Hex([string]$Text) {
    $sha   = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hex   = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    $sha.Dispose()
    return $hex
}

# Build and cache the sorted ring once
$Script:CachedRing = $null
function Get-Ring {
    if ($null -ne $Script:CachedRing) { return $Script:CachedRing }

    $hashes = [System.Collections.Generic.List[string]]::new(300)
    $map    = @{}

    foreach ($nodeId in $Script:RING_NODE_IDS_LOCAL) {
        for ($i = 0; $i -lt $Script:VN_LOCAL; $i++) {
            $h = Get-Sha256Hex "$nodeId#$i"
            $hashes.Add($h)
            $map[$h] = $nodeId
        }
    }

    # Lexicographic sort --- identical to JS string comparison on lowercase hex
    $sorted = [string[]]$hashes.ToArray()
    [System.Array]::Sort($sorted, [System.StringComparer]::Ordinal)

    $Script:CachedRing = [PSCustomObject]@{ Sorted = $sorted; Map = $map }
    return $Script:CachedRing
}

# Export config into script-scope variables accessible inside Get-Ring
$Script:RING_NODE_IDS_LOCAL = $RING_NODE_IDS
$Script:VN_LOCAL            = $VIRTUAL_NODES

function Get-ResponsibleNode([string]$Key) {
    $ring    = Get-Ring
    $keyHash = Get-Sha256Hex $Key
    $sorted  = $ring.Sorted
    $n       = $sorted.Length

    # Lower-bound binary search: first index where sorted[i] >= keyHash
    $lo = 0; $hi = $n
    while ($lo -lt $hi) {
        $mid = [int][Math]::Floor(($lo + $hi) / 2)
        if ([string]::CompareOrdinal($sorted[$mid], $keyHash) -lt 0) {
            $lo = $mid + 1
        } else {
            $hi = $mid
        }
    }
    if ($lo -ge $n) { $lo = 0 }   # wraparound (clockwise)
    return $ring.Map[$sorted[$lo]]
}

# Find first key with prefix that hashes to $TargetNode
function Find-KeyForNode([string]$TargetNode, [string]$Prefix, [int]$Max = 10000) {
    for ($i = 0; $i -lt $Max; $i++) {
        $candidate = "$Prefix$i"
        if ((Get-ResponsibleNode $candidate) -eq $TargetNode) { return $candidate }
    }
    return $null
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Docker Compose helper
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function Invoke-Compose {
    param([string[]]$Arguments)
    # Always pass explicit -f flags so the command works from any CWD
    $composeArgs = @('-f', $COMPOSE_FILE, '-f', $COMPOSE_OVERRIDE) + $Arguments
    $output      = & docker compose @composeArgs 2>&1
    return [PSCustomObject]@{ Output = $output; ExitCode = $LASTEXITCODE }
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Wait helpers
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

function Wait-UrlHealthy([string]$Url, [int]$MaxSec = 60, [int]$PollSec = 3) {
    $deadline = (Get-Date).AddSeconds($MaxSec)
    while ((Get-Date) -lt $deadline) {
        $r = Invoke-Api $Url -TimeoutSec 2
        if ($r.Status -eq 200) { return $true }
        Start-Sleep -Seconds $PollSec
    }
    return $false
}

function Wait-UrlUnreachable([string]$Url, [int]$MaxSec = 20, [int]$PollSec = 2) {
    $deadline = (Get-Date).AddSeconds($MaxSec)
    while ((Get-Date) -lt $deadline) {
        $r = Invoke-Api $Url -TimeoutSec 2
        if ($r.Status -ne 200) { return $true }
        Start-Sleep -Seconds $PollSec
    }
    return $false
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Keys created during this run --- always cleaned up in finally
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
$Script:CreatedKeys = [System.Collections.Generic.List[string]]::new()

function Register-Key([string]$Key) { $Script:CreatedKeys.Add($Key) }

function Remove-AllTestKeys {
    foreach ($k in $Script:CreatedKeys) {
        Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($k))" -Method DELETE | Out-Null
    }
    $Script:CreatedKeys.Clear()
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# MAIN TEST BODY (wrapped in try/finally for guaranteed cleanup)
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

Write-Banner 'DistributedCache - Docker Integration + Recovery Tests'
Write-Info "Run ID : $RUN_ID"
Write-Info "Time   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Info "Gateway: $GATEWAY_URL"

try {

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S1 --- Gateway health and node discovery
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S1: Gateway health and node discovery'

    $r = Invoke-Api "$GATEWAY_URL/health"
    if ($r.Status -eq 200 -and $r.Body.status -eq 'ok' -and $r.Body.role -eq 'gateway') {
        Assert-Pass 'GET /health --- 200, status=ok, role=gateway'
        Write-Info "virtualNodesPerPhysical=$($r.Body.virtualNodesPerPhysical)"
        Write-Info "nodes reported: $($r.Body.nodes -join ', ')"
    } else {
        Assert-Fail 'GET /health' "HTTP $($r.Status) | body: $($r.Raw)"
    }

    $r = Invoke-Api "$GATEWAY_URL/nodes"
    if ($r.Status -eq 200) {
        $allNodes  = @($r.Body.nodes)
        $upNodes   = @($allNodes | Where-Object { $_.status -eq 'up' })

        if ($allNodes.Count -eq 3) {
            Assert-Pass 'GET /nodes --- 3 node entries'
        } else {
            Assert-Fail 'GET /nodes node count' "Expected 3, got $($allNodes.Count)"
        }

        if ($upNodes.Count -eq 3) {
            Assert-Pass 'GET /nodes --- all 3 nodes status=up'
        } else {
            Assert-Fail 'GET /nodes all-up' "Only $($upNodes.Count)/3 nodes are up"
        }

        foreach ($n in $allNodes) {
            Write-Info "$($n.nodeId) --- $($n.status)  size=$($n.detail.size)  policy=$($n.detail.policy)"
        }
    } else {
        Assert-Fail 'GET /nodes' "HTTP $($r.Status)"
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S2 --- Detect direct node port accessibility
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S2: Direct node port detection'

    $nodePortResults = @{}
    foreach ($nodeId in $NODE_DIRECT_URLS.Keys) {
        $url = $NODE_DIRECT_URLS[$nodeId]
        $h   = Invoke-Api "$url/health" -TimeoutSec 3
        $nodePortResults[$nodeId] = ($h.Status -eq 200)
        $flag = if ($h.Status -eq 200) { 'reachable' } else { 'NOT reachable (port not exposed)' }
        Write-Info "$nodeId ($url) --- $flag"
    }

    $Script:NodePortsOk = @($nodePortResults.Values | Where-Object { $_ -eq $true }).Count -eq 3
    if ($Script:NodePortsOk) {
        Assert-Pass 'All 3 node ports accessible on localhost (override file active)'
    } else {
        Assert-Skip 'Node-port tests' 'ports not exposed; restart stack with docker-compose.override.yml for full coverage'
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S3 --- Basic PUT / GET / DELETE through gateway
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S3: PUT / GET / DELETE through gateway'

    $key3   = "s3-basic-$RUN_ID"
    $val3   = "value-$RUN_ID"
    Register-Key $key3

    # PUT
    $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $key3; value = $val3 }
    if ($r.Status -eq 200 -and $r.Body.success -eq $true) {
        Assert-Pass "PUT '$key3' --- 200 success=true"
        Write-Info "Responsible node (predicted): $(Get-ResponsibleNode $key3)"
    } else {
        Assert-Fail "PUT '$key3'" "HTTP $($r.Status) | $($r.Raw)"
    }

    # GET --- must return exact value
    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key3))"
    if ($r.Status -eq 200 -and $r.Body.data.value -eq $val3) {
        Assert-Pass "GET '$key3' --- 200 correct value returned"
    } else {
        Assert-Fail "GET '$key3'" "HTTP $($r.Status) | value='$($r.Body.data.value)'"
    }

    # DELETE
    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key3))" -Method DELETE
    if ($r.Status -eq 200 -and $r.Body.success -eq $true) {
        Assert-Pass "DELETE '$key3' --- 200 success=true"
    } else {
        Assert-Fail "DELETE '$key3'" "HTTP $($r.Status)"
    }

    # GET after DELETE --- must 404
    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key3))"
    if ($r.Status -eq 404) {
        Assert-Pass "GET '$key3' after DELETE --- 404 (correctly absent)"
    } else {
        Assert-Fail "GET after DELETE should be 404" "Got HTTP $($r.Status)"
    }

    # Invalid PUT --- missing key
    $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ value = 'no-key-field' }
    if ($r.Status -eq 400 -and ($null -ne $r.Body) -and ($r.Body.success -eq $false)) {
        Assert-Pass 'PUT without key field --- 400 validation error'
    } else {
        Assert-Fail 'PUT without key should return 400' "HTTP $($r.Status)"
    }

    # Invalid PUT --- missing value
    $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = 's3-no-val' }
    if ($r.Status -eq 400) {
        Assert-Pass 'PUT without value field --- 400 validation error'
    } else {
        Assert-Fail 'PUT without value should return 400' "HTTP $($r.Status)"
    }

    # GET non-existent key
    $r = Invoke-Api "$GATEWAY_URL/cache/key-that-does-not-exist-$RUN_ID"
    if ($r.Status -eq 404) {
        Assert-Pass 'GET non-existent key --- 404'
    } else {
        Assert-Fail 'GET missing key should 404' "HTTP $($r.Status)"
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S4 --- Consistent-hash routing: key stored on exactly one node
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S4: Consistent-hash routing verification'

    $key4          = "s4-routing-$RUN_ID"
    $val4          = "routing-value-$RUN_ID"
    $expectedNode4 = Get-ResponsibleNode $key4
    Register-Key $key4

    Write-Info "Key '$key4' --- predicted node: $expectedNode4"

    $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $key4; value = $val4 }
    if ($r.Status -eq 200) {
        Assert-Pass "PUT '$key4' --- 200"
    } else {
        Assert-Fail "PUT '$key4'" "HTTP $($r.Status)"
    }

    if ($Script:NodePortsOk) {
        # Direct node probing: key must be on exactly one node
        $foundOn   = @()
        $missingOn = @()
        foreach ($nodeId in $NODE_DIRECT_URLS.Keys) {
            $url = "$($NODE_DIRECT_URLS[$nodeId])/cache/$([Uri]::EscapeDataString($key4))"
            $h   = Invoke-Api $url -TimeoutSec 3
            if ($h.Status -eq 200) { $foundOn   += $nodeId }
            else                   { $missingOn += $nodeId }
        }

        Write-Info "Found on : $($foundOn  -join ', ')"
        Write-Info "Absent on: $($missingOn -join ', ')"

        if ($foundOn.Count -eq 1) {
            Assert-Pass "Key stored on exactly 1 node (no replication) --- found on: $($foundOn[0])"
        } else {
            Assert-Fail 'Key should be on exactly 1 node' "Found on $($foundOn.Count): $($foundOn -join ', ')"
        }

        if ($foundOn.Count -eq 1 -and $foundOn[0] -eq $expectedNode4) {
            Assert-Pass "Actual node ($($foundOn[0])) matches PowerShell ring prediction ($expectedNode4)"
        } elseif ($foundOn.Count -eq 1) {
            Assert-Fail 'Ring prediction mismatch' "Expected $expectedNode4, key is on $($foundOn[0])"
        }
    } else {
        Assert-Skip 'Single-node storage check' 'node ports not exposed'
        Assert-Skip 'Ring prediction vs actual node' 'node ports not exposed'

        # Fallback: verify GET is consistent over 5 requests
        $consistent = $true
        for ($i = 0; $i -lt 5; $i++) {
            $h = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key4))"
            if ($h.Status -ne 200 -or $h.Body.data.value -ne $val4) { $consistent = $false }
        }
        if ($consistent) {
            Assert-Pass 'Key returns stable value on 5 consecutive GETs (routing is consistent)'
        } else {
            Assert-Fail 'Key returned unstable value on repeated GETs'
        }
    }

    # GET via gateway returns correct value
    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key4))"
    if ($r.Status -eq 200 -and $r.Body.data.value -eq $val4) {
        Assert-Pass "GET via gateway returns correct value for routed key"
    } else {
        Assert-Fail "GET routed key" "HTTP $($r.Status) | value='$($r.Body.data.value)'"
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S5 --- Find and pre-store a key that hashes to cache-node-2
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S5: Identifying and pre-storing a cache-node-2 key'

    $node2Key = Find-KeyForNode 'cache-node-2' "s5-n2-$RUN_ID-" 10000
    if ($null -ne $node2Key) {
        Assert-Pass "Found key '$node2Key' --- maps to cache-node-2 (via SHA-256 ring)"
    } else {
        Assert-Fail 'Could not find any key mapping to cache-node-2'
        # Fatal for S6---S9; manufacture a placeholder so later sections don't crash
        $node2Key = $null
    }

    # Also find survivor keys for nodes 1 and 3
    $node1Key = Find-KeyForNode 'cache-node-1' "s5-n1-$RUN_ID-" 10000
    $node3Key = Find-KeyForNode 'cache-node-3' "s5-n3-$RUN_ID-" 10000

    Write-Info "Node-1 survivor key: $node1Key"
    Write-Info "Node-2 failure key : $node2Key"
    Write-Info "Node-3 survivor key: $node3Key"

    # Pre-store all three so we can verify visibility / invisibility later
    foreach ($kv in @(
        @{ Key = $node1Key; Val = "n1-pre-$RUN_ID"; Node = 'cache-node-1' }
        @{ Key = $node2Key; Val = "n2-pre-$RUN_ID"; Node = 'cache-node-2' }
        @{ Key = $node3Key; Val = "n3-pre-$RUN_ID"; Node = 'cache-node-3' }
    )) {
        if ($null -eq $kv.Key) { continue }
        Register-Key $kv.Key
        $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $kv.Key; value = $kv.Val }
        if ($r.Status -eq 200) {
            Assert-Pass "Pre-stored '$($kv.Key)' on $($kv.Node)"
        } else {
            Assert-Fail "Pre-store '$($kv.Key)'" "HTTP $($r.Status)"
        }
    }

    # Verify node-2 key is readable now (before shutdown)
    if ($null -ne $node2Key) {
        $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node2Key))"
        if ($r.Status -eq 200) {
            Assert-Pass "node-2 key readable via gateway before node shutdown"
        } else {
            Assert-Fail "node-2 key should be readable before shutdown" "HTTP $($r.Status)"
        }
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S6 --- Stop cache-node-2, verify failure detection and 503 handling
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section "S6: Stop $FAILURE_TARGET and verify failure detection"

    $stopResult = Invoke-Compose @('stop', $FAILURE_TARGET)
    if ($stopResult.ExitCode -eq 0) {
        $Script:Node2Stopped = $true
        Assert-Pass "docker compose stop $FAILURE_TARGET exited 0"
    } else {
        Assert-Fail "docker compose stop $FAILURE_TARGET" "exit=$($stopResult.ExitCode) | $($stopResult.Output)"
    }

    if ($Script:Node2Stopped) {

        # Wait for node-2 to stop accepting connections on the direct port
        if ($Script:NodePortsOk) {
            Write-Info "Waiting up to 15s for port 3002 to go silent..."
            $wentDown = Wait-UrlUnreachable 'http://localhost:3002/health' 15 2
            if ($wentDown) {
                Assert-Pass 'cache-node-2 no longer responds on localhost:3002'
            } else {
                Assert-Fail 'cache-node-2 still responding on port 3002 after stop' ''
            }
        }

        # Small grace period before probing gateway
        Start-Sleep -Seconds 2

        # Gateway /nodes must reflect the outage
        $r = Invoke-Api "$GATEWAY_URL/nodes"
        if ($r.Status -eq 200) {
            $node2Entry = @($r.Body.nodes | Where-Object { $_.nodeId -eq 'cache-node-2' }) | Select-Object -First 1
            $upCount    = @($r.Body.nodes | Where-Object { $_.status -eq 'up' }).Count

            $allStatuses = ($r.Body.nodes | ForEach-Object { "$($_.nodeId)=$($_.status)" }) -join '  '
            Write-Info "Node statuses: $allStatuses"

            if ($node2Entry -and $node2Entry.status -eq 'down') {
                Assert-Pass "Gateway /nodes reports cache-node-2 status='down'"
            } else {
                Assert-Fail 'Gateway should show cache-node-2 as down' "status='$($node2Entry.status)'"
            }

            if ($upCount -eq 2) {
                Assert-Pass "Exactly 2 of 3 nodes remain up during outage"
            } else {
                Assert-Fail 'Expected 2 nodes up during outage' "Got $upCount"
            }
        } else {
            Assert-Fail 'GET /nodes during outage' "HTTP $($r.Status)"
        }

        # GET request for node-2 key must return 503 or 504, never 200
        if ($null -ne $node2Key) {
            $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node2Key))" -TimeoutSec 10
            if ($r.Status -in @(503, 504)) {
                Assert-Pass "GET node-2 key '$node2Key' --- $($r.Status) while node-2 is down (correct)"
                if ($null -ne $r.Body -and $r.Body.PSObject.Properties['message']) {
                    Write-Info "Gateway message: $($r.Body.message)"
                }
            } else {
                Assert-Fail "GET node-2 key during outage should be 503/504" "Got HTTP $($r.Status)"
            }

            # PUT to node-2 key must also fail with 503/504 (no silent rerouting)
            $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT `
                    -Body @{ key = $node2Key; value = 'should-not-be-routed-elsewhere' } `
                    -TimeoutSec 10
            if ($r.Status -in @(503, 504)) {
                Assert-Pass "PUT to node-2 key --- $($r.Status) (gateway does NOT reroute to surviving nodes)"
                if ($null -ne $r.Body -and $r.Body.PSObject.Properties['node']) {
                    Write-Info "node field in response: $($r.Body.node)"
                }
            } else {
                Assert-Fail 'PUT to node-2 key during outage should be 503/504' "HTTP $($r.Status)"
            }

            # DELETE to node-2 key must also fail
            $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node2Key))" `
                    -Method DELETE -TimeoutSec 10
            if ($r.Status -in @(503, 504)) {
                Assert-Pass "DELETE to node-2 key --- $($r.Status) during outage"
            } else {
                Assert-Fail 'DELETE to node-2 key should be 503/504' "HTTP $($r.Status)"
            }
        } else {
            Assert-Skip 'node-2 key GET/PUT/DELETE failure tests' 'no node-2 key was found in S5'
        }

        # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
        # S7 --- Surviving nodes still serve their keys during the outage
        # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
        Write-Section 'S7: Survivor nodes (1 and 3) during cache-node-2 outage'

        if ($null -ne $node1Key) {
            $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node1Key))"
            if ($r.Status -eq 200 -and $r.Body.data.value -eq "n1-pre-$RUN_ID") {
                Assert-Pass "node-1 key '$node1Key' still accessible via gateway during node-2 outage"
            } else {
                Assert-Fail "node-1 key inaccessible during outage" "HTTP $($r.Status) | value='$($r.Body.data.value)'"
            }
        } else {
            Assert-Skip 'node-1 survivor key test' 'no node-1 key found'
        }

        if ($null -ne $node3Key) {
            $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node3Key))"
            if ($r.Status -eq 200 -and $r.Body.data.value -eq "n3-pre-$RUN_ID") {
                Assert-Pass "node-3 key '$node3Key' still accessible via gateway during node-2 outage"
            } else {
                Assert-Fail "node-3 key inaccessible during outage" "HTTP $($r.Status) | value='$($r.Body.data.value)'"
            }
        } else {
            Assert-Skip 'node-3 survivor key test' 'no node-3 key found'
        }

        # New writes to surviving nodes must succeed during the outage
        $newNode1Key = Find-KeyForNode 'cache-node-1' "s7-new1-$RUN_ID-" 5000
        if ($null -ne $newNode1Key) {
            Register-Key $newNode1Key
            $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $newNode1Key; value = 'written-during-outage' }
            if ($r.Status -eq 200) {
                Assert-Pass "New PUT to node-1 key succeeds while node-2 is down"
            } else {
                Assert-Fail 'New PUT to node-1 during outage' "HTTP $($r.Status)"
            }

            $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($newNode1Key))"
            if ($r.Status -eq 200 -and $r.Body.data.value -eq 'written-during-outage') {
                Assert-Pass "New GET from node-1 returns correct value during outage"
            } else {
                Assert-Fail 'New GET from node-1 during outage' "HTTP $($r.Status)"
            }
        } else {
            Assert-Skip 'New-write-to-node-1 during outage' 'no node-1 key found'
        }

        # Gateway /health must still return 200 during partial outage
        $r = Invoke-Api "$GATEWAY_URL/health"
        if ($r.Status -eq 200 -and $r.Body.status -eq 'ok') {
            Assert-Pass 'Gateway /health returns 200 even while one node is down'
        } else {
            Assert-Fail 'Gateway /health during outage' "HTTP $($r.Status)"
        }

    } else {
        Assert-Skip 'S6/S7 failure tests' 'docker compose stop failed'
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S8 --- Restart cache-node-2 and wait for health check
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section "S8: Restart $FAILURE_TARGET and wait for health"

    $startResult = Invoke-Compose @('start', $FAILURE_TARGET)
    if ($startResult.ExitCode -eq 0) {
        $Script:Node2Stopped = $false    # mark restored before we assert anything
        Assert-Pass "docker compose start $FAILURE_TARGET exited 0"
    } else {
        Assert-Fail "docker compose start $FAILURE_TARGET" "exit=$($startResult.ExitCode)"
    }

    Write-Info "Waiting up to 60s for cache-node-2 to pass its health check..."
    $recovered = $false

    # Primary: probe directly on port 3002 if accessible
    if ($Script:NodePortsOk) {
        $recovered = Wait-UrlHealthy 'http://localhost:3002/health' 60 3
    }

    # Fallback (or confirmation): ask the gateway's /nodes endpoint
    if (-not $recovered) {
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) {
            $nv    = Invoke-Api "$GATEWAY_URL/nodes" -TimeoutSec 5
            $node2 = @($nv.Body.nodes | Where-Object { $_.nodeId -eq 'cache-node-2' }) |
                     Select-Object -First 1
            if ($node2 -and $node2.status -eq 'up') { $recovered = $true; break }
            Start-Sleep -Seconds 3
        }
    }

    if ($recovered) {
        Assert-Pass 'cache-node-2 is healthy again after restart'
    } else {
        Assert-Fail 'cache-node-2 did not recover within 60s'
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S9 --- Post-recovery: all nodes up, normal operations restored
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S9: Post-recovery verification'

    # All 3 nodes reported up
    $r = Invoke-Api "$GATEWAY_URL/nodes"
    if ($r.Status -eq 200) {
        $upCount   = @($r.Body.nodes | Where-Object { $_.status -eq 'up' }).Count
        $n2Status  = (@($r.Body.nodes | Where-Object { $_.nodeId -eq 'cache-node-2' }) |
                      Select-Object -First 1).status

        if ($upCount -eq 3) {
            Assert-Pass 'All 3 nodes reported up after cache-node-2 recovery'
        } else {
            Assert-Fail "Expected 3 nodes up after recovery" "Got $upCount"
        }

        if ($n2Status -eq 'up') {
            Assert-Pass "cache-node-2 specifically shows status='up'"
        } else {
            Assert-Fail "cache-node-2 not 'up' after restart" "status='$n2Status'"
        }
    }

    # Normal PUT / GET / DELETE work
    $key9   = "s9-recovery-$RUN_ID"
    $val9   = "post-recovery-$RUN_ID"
    Register-Key $key9
    Write-Info "Recovery key '$key9' --- node: $(Get-ResponsibleNode $key9)"

    $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $key9; value = $val9 }
    if ($r.Status -eq 200) { Assert-Pass 'PUT works after recovery' }
    else { Assert-Fail 'PUT after recovery' "HTTP $($r.Status)" }

    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key9))"
    if ($r.Status -eq 200 -and $r.Body.data.value -eq $val9) {
        Assert-Pass 'GET returns correct value after recovery'
    } else {
        Assert-Fail 'GET after recovery' "HTTP $($r.Status) | value='$($r.Body.data.value)'"
    }

    $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($key9))" -Method DELETE
    if ($r.Status -eq 200) { Assert-Pass 'DELETE works after recovery' }
    else { Assert-Fail 'DELETE after recovery' "HTTP $($r.Status)" }

    # Specifically target node-2 with a fresh write after restart
    # (node-2 data is lost on restart --- expected, no persistence)
    if ($null -ne $node2Key) {
        $r = Invoke-Api "$GATEWAY_URL/cache" -Method PUT -Body @{ key = $node2Key; value = "fresh-post-restart-$RUN_ID" }
        if ($r.Status -eq 200) {
            Assert-Pass "PUT to node-2 key works after restart"
        } else {
            Assert-Fail 'PUT to node-2 key after restart' "HTTP $($r.Status)"
        }

        $r = Invoke-Api "$GATEWAY_URL/cache/$([Uri]::EscapeDataString($node2Key))"
        if ($r.Status -eq 200 -and $r.Body.data.value -eq "fresh-post-restart-$RUN_ID") {
            Assert-Pass 'GET from node-2 returns fresh value after restart'
        } else {
            Assert-Fail 'GET from node-2 after restart' "HTTP $($r.Status) | value='$($r.Body.data.value)'"
        }
    }

    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    # S10 --- Container status summary
    # ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Section 'S10: Container status summary'

    $ps = Invoke-Compose @('ps', '--format', 'table')
    if ($ps.ExitCode -eq 0) {
        $ps.Output | ForEach-Object { Write-Info $_ }
        Assert-Pass 'docker compose ps completed successfully'
    } else {
        Assert-Fail 'docker compose ps' "exit=$($ps.ExitCode)"
    }

} finally {

    # ------ Guaranteed cleanup ------------------------------------------------------------------------------------------------------------------------------------------------------------
    Write-Host ''

    if ($Script:Node2Stopped) {
        Write-Host '  [CLEANUP] cache-node-2 was left stopped --- restarting now...' -ForegroundColor Yellow
        $cr = Invoke-Compose @('start', $FAILURE_TARGET)
        if ($cr.ExitCode -eq 0) {
            Write-Host "  [CLEANUP] cache-node-2 restarted OK." -ForegroundColor Green
        } else {
            Write-Host "  [CLEANUP] WARNING: could not restart cache-node-2! Manual intervention needed." -ForegroundColor Red
        }
    }

    Write-Host '  [CLEANUP] Removing test keys...' -ForegroundColor DarkGray
    Remove-AllTestKeys
    Write-Host '  [CLEANUP] Done.' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

Write-Banner 'TEST SUMMARY'
Write-Host "  Passed : $($Script:PassCount)" -ForegroundColor Green
Write-Host "  Failed : $($Script:FailCount)"  -ForegroundColor $(if ($Script:FailCount -gt 0) {'Red'} else {'Green'})
Write-Host "  Skipped: $($Script:SkipCount)"  -ForegroundColor Yellow
Write-Host ''

if ($Script:HasFailure) {
    Write-Host "  RESULT: FAILED ($($Script:FailCount) test(s) failed)" -ForegroundColor Red
    exit 1
} else {
    Write-Host "  RESULT: ALL TESTS PASSED" -ForegroundColor Green
    exit 0
}
