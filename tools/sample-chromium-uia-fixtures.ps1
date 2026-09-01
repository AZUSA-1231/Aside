[CmdletBinding()]
param(
    [ValidateSet("edge", "chrome")]
    [string]$Browser = "edge",
    [switch]$Capture,
    [switch]$KeepProfile,
    [int]$WindowTimeoutSeconds = 15,
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "..\docs\cycle-4-contextual-sidecar\research\samples"
}

if (-not ([System.Management.Automation.PSTypeName]"AsideFixtureWindow.NativeMethods").Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AsideFixtureWindow {
    public static class NativeMethods {
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

        public static string WindowClass(IntPtr hwnd) {
            var text = new StringBuilder(256);
            GetClassName(hwnd, text, text.Capacity);
            return text.ToString();
        }
    }
}
'@
}

$probePath = Join-Path $PSScriptRoot "chromium-uia-screen-probe.ps1"
$fixtureDirectory = Join-Path $PSScriptRoot "fixtures"
$fixtures = @(
    [pscustomobject]@{ Name = "semantic"; Path = (Join-Path $fixtureDirectory "chromium-uia-semantic.html") },
    [pscustomobject]@{ Name = "restricted"; Path = (Join-Path $fixtureDirectory "chromium-uia-restricted.html") },
    [pscustomobject]@{ Name = "visual"; Path = (Join-Path $fixtureDirectory "chromium-uia-visual.html") }
)

function Find-BrowserExecutable {
    param([string]$BrowserName)

    $candidates = if ($BrowserName -eq "edge") {
        @(
            (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
            (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
            (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
        )
    } else {
        @(
            (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
            (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
            (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
        )
    }

    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Get-RecentBrowserWindow {
    param(
        [string]$ProcessName,
        [DateTime]$StartedAt
    )

    try {
        return Get-Process -Name $ProcessName -ErrorAction Stop |
            Where-Object {
                $_.MainWindowHandle -ne 0 -and
                $_.StartTime -ge $StartedAt.AddSeconds(-2) -and
                [AsideFixtureWindow.NativeMethods]::IsWindowVisible([IntPtr]$_.MainWindowHandle) -and
                [AsideFixtureWindow.NativeMethods]::WindowClass([IntPtr]$_.MainWindowHandle) -in @(
                    "Chrome_WidgetWin_1",
                    "Chrome_WidgetWin_0"
                )
            } |
            Sort-Object StartTime |
            Select-Object -Last 1
    } catch {
        return $null
    }
}

function Invoke-FixtureProbe {
    param(
        [Parameter(Mandatory = $true)]$Fixture,
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$ProbeOutputDirectory
    )

    $profileDirectory = Join-Path ([IO.Path]::GetTempPath()) ("aside-uia-fixture-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
    $fixtureUri = ([Uri]$Fixture.Path).AbsoluteUri
    $startedAt = Get-Date
    $process = $null
    $sampleName = "$Browser-$($Fixture.Name)"
    $result = [ordered]@{
        browser = $Browser
        fixture = $Fixture.Name
        fixturePath = $Fixture.Path
        profileDirectory = $profileDirectory
        status = "not_started"
        probeOutput = $null
    }

    try {
        $arguments = @(
            "--user-data-dir=$profileDirectory",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--new-window",
            $fixtureUri
        )
        $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
        $processName = [IO.Path]::GetFileNameWithoutExtension($Executable)
        $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
        $window = $null
        while ((Get-Date) -lt $deadline) {
            $window = Get-RecentBrowserWindow $processName $startedAt
            if ($null -ne $window) {
                break
            }
            Start-Sleep -Milliseconds 250
        }

        if ($null -eq $window) {
            $result.status = "no_interactive_window"
            $result.error = "The browser process started but no visible main window was found."
            return [pscustomobject]$result
        }

        $probeArguments = @(
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $probePath,
            "-WindowHandle",
            ("0x{0:X}" -f $window.MainWindowHandle.ToInt64()),
            "-SaveSemanticTree",
            "-IncludeContent",
            "-TreeOutputDirectory",
            $ProbeOutputDirectory,
            "-SampleName",
            $sampleName
        )
        if ($Capture) {
            $probeArguments += "-Capture"
        }

        $probeOutput = & powershell.exe @probeArguments 2>&1 | Out-String
        $result.status = "captured"
        $result.windowHandle = ("0x{0:X}" -f $window.MainWindowHandle.ToInt64())
        $result.probeOutput = $probeOutput.Trim()
        return [pscustomobject]$result
    } catch {
        $result.status = "failed"
        $result.error = "Fixture probe failed."
        return [pscustomobject]$result
    } finally {
        if ($null -ne $process) {
            try {
                [void]$process.CloseMainWindow()
                [void]$process.WaitForExit(2000)
            } catch {
            }
            if (-not $process.HasExited) {
                try { [void]$process.Kill() } catch { }
            }
        }

        if (-not $KeepProfile -and (Test-Path -LiteralPath $profileDirectory)) {
            try {
                Remove-Item -LiteralPath $profileDirectory -Recurse -Force -ErrorAction Stop
            } catch {
                # Chromium child processes can keep the disposable profile open.
            }
        }
    }
}

$executable = Find-BrowserExecutable $Browser
if ($null -eq $executable) {
    throw "No $Browser executable was found."
}

if (-not (Test-Path -LiteralPath $probePath)) {
    throw "The UIA probe was not found at $probePath."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$results = foreach ($fixture in $fixtures) {
    Invoke-FixtureProbe $fixture $executable $OutputDirectory
}

$manifestPath = Join-Path $OutputDirectory ("$Browser-manifest.json")
$manifest = [ordered]@{
    generatedAt = [DateTime]::UtcNow.ToString("o")
    browser = $Browser
    executable = $executable
    captureRequested = [bool]$Capture
    results = @($results)
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 12),
    (New-Object System.Text.UTF8Encoding($false))
)

$manifest | ConvertTo-Json -Depth 12
