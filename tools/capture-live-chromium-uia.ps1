[CmdletBinding()]
param(
    [ValidateSet("edge", "chrome")]
    [string]$Browser = "edge",
    [string]$WindowHandle,
    [switch]$ListOnly,
    [switch]$WaitForForeground,
    [int]$ForegroundTimeoutSeconds = 30,
    [switch]$Capture,
    [switch]$IncludeContent,
    [ValidateRange(1, 10000)]
    [int]$MaxNodes = 800,
    [ValidateRange(0, 128)]
    [int]$MaxDepth = 16,
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) "aside-live-chromium-uia"),
    [string]$TreeOutputDirectory,
    [string]$SampleName = ("live-" + $Browser + "-" + (Get-Date -Format "yyyyMMdd-HHmmssfff"))
)

$ErrorActionPreference = "Stop"

$probePath = Join-Path $PSScriptRoot "chromium-uia-screen-probe.ps1"
if (-not (Test-Path -LiteralPath $probePath)) {
    throw "The UIA probe was not found at $probePath."
}

if (-not ([System.Management.Automation.PSTypeName]"AsideLiveChromium.NativeMethods").Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace AsideLiveChromium {
    public static class NativeMethods {
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        public static string WindowText(IntPtr hwnd) {
            var text = new StringBuilder(2048);
            GetWindowText(hwnd, text, text.Capacity);
            return text.ToString();
        }

        public static string WindowClass(IntPtr hwnd) {
            var text = new StringBuilder(512);
            GetClassName(hwnd, text, text.Capacity);
            return text.ToString();
        }

        public static IntPtr[] TopLevelWindows() {
            var windows = new List<IntPtr>();
            EnumWindows((hwnd, lParam) => {
                windows.Add(hwnd);
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }

        public static int ProcessId(IntPtr hwnd) {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            return unchecked((int)processId);
        }
    }
}
'@
}

function Format-WindowHandle {
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)

    return "0x{0:X}" -f $Handle.ToInt64()
}

function Convert-ToHandle {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -match '^0x[0-9a-fA-F]+$') {
        return [IntPtr]([Convert]::ToInt64($Value.Substring(2), 16))
    }

    if ($Value -match '^[0-9]+$') {
        return [IntPtr]([Convert]::ToInt64($Value, 10))
    }

    throw "Invalid window handle '$Value'. Use a decimal handle or a value such as 0x123456."
}

function Get-BrowserProcessName {
    if ($Browser -eq "edge") {
        return "msedge"
    }

    return "chrome"
}

function Get-LiveBrowserWindows {
    $expectedProcessName = Get-BrowserProcessName
    $browserClasses = @("Chrome_WidgetWin_1", "Chrome_WidgetWin_0")
    $foreground = [AsideLiveChromium.NativeMethods]::GetForegroundWindow()
    $windows = New-Object System.Collections.Generic.List[object]

    foreach ($handle in [AsideLiveChromium.NativeMethods]::TopLevelWindows()) {
        if (-not [AsideLiveChromium.NativeMethods]::IsWindow($handle)) {
            continue
        }

        if (-not [AsideLiveChromium.NativeMethods]::IsWindowVisible($handle)) {
            continue
        }

        if ([AsideLiveChromium.NativeMethods]::IsIconic($handle)) {
            continue
        }

        $className = [AsideLiveChromium.NativeMethods]::WindowClass($handle)
        if ($browserClasses -notcontains $className) {
            continue
        }

        $processId = [AsideLiveChromium.NativeMethods]::ProcessId($handle)
        if ($processId -le 0) {
            continue
        }

        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
        } catch {
            continue
        }

        if ($process.ProcessName -ine $expectedProcessName) {
            continue
        }

        $windows.Add([pscustomobject]@{
            index = -1
            handle = $handle
            handleText = Format-WindowHandle $handle
            processId = $processId
            processName = $process.ProcessName
            className = $className
            title = [AsideLiveChromium.NativeMethods]::WindowText($handle)
            foreground = ($handle -eq $foreground)
        })
    }

    $ordered = @(
        $windows |
            Sort-Object @{ Expression = { if ($_.foreground) { 0 } else { 1 } } }, handleText
    )

    for ($index = 0; $index -lt $ordered.Count; $index++) {
        $ordered[$index].index = $index
    }

    return $ordered
}

function Show-BrowserWindows {
    param([Parameter(Mandatory = $true)]$Windows)

    Write-Host "Open $Browser windows:"
    foreach ($window in $Windows) {
        $marker = if ($window.foreground) { " *" } else { "  " }
        $title = if ([string]::IsNullOrWhiteSpace($window.title)) { "(untitled)" } else { $window.title }
        Write-Host ("[{0}] {1} PID={2} Class={3} {4}" -f $window.index, $window.handleText, $window.processId, $window.className, $title)
    }
    Write-Host " * foreground window"
}

function Resolve-WindowFromList {
    param([Parameter(Mandatory = $true)]$Windows)

    if ($Windows.Count -eq 0) {
        throw "No visible, non-minimized $Browser main window was found. Open $Browser first, then retry."
    }

    if ($Windows.Count -eq 1) {
        Write-Host ("Using the only visible $Browser window: {0} ({1})" -f $Windows[0].handleText, $Windows[0].title)
        return $Windows[0]
    }

    Show-BrowserWindows $Windows
    while ($true) {
        $answer = Read-Host "Select a window index or HWND"
        if ($answer -match '^[0-9]+$') {
            $index = [int]$answer
            $selected = $Windows | Where-Object { $_.index -eq $index } | Select-Object -First 1
            if ($null -ne $selected) {
                return $selected
            }
        } else {
            try {
                $handle = Convert-ToHandle $answer
                $selected = $Windows | Where-Object { $_.handle -eq $handle } | Select-Object -First 1
                if ($null -ne $selected) {
                    return $selected
                }
            } catch {
            }
        }

        Write-Host "That selection does not match a visible $Browser main window."
    }
}

function Wait-ForForegroundBrowserWindow {
    param([int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Write-Host "Switch to the target $Browser window. Watching the foreground window for $TimeoutSeconds seconds..."

    while ((Get-Date) -lt $deadline) {
        $foreground = [AsideLiveChromium.NativeMethods]::GetForegroundWindow()
        $candidate = Get-LiveBrowserWindows | Where-Object { $_.handle -eq $foreground } | Select-Object -First 1
        if ($null -ne $candidate) {
            return $candidate
        }
        Start-Sleep -Milliseconds 100
    }

    throw "No $Browser window became foreground within $TimeoutSeconds seconds."
}

function Resolve-TargetWindow {
    if (-not [string]::IsNullOrWhiteSpace($WindowHandle)) {
        $handle = Convert-ToHandle $WindowHandle
        $windows = Get-LiveBrowserWindows
        $match = $windows | Where-Object { $_.handle -eq $handle } | Select-Object -First 1
        if ($null -eq $match) {
            throw "HWND $WindowHandle is not a visible $Browser main window. Use -ListOnly to inspect candidates."
        }
        return $match
    }

    if ($WaitForForeground) {
        return Wait-ForForegroundBrowserWindow $ForegroundTimeoutSeconds
    }

    return Resolve-WindowFromList @(Get-LiveBrowserWindows)
}

$windows = @(Get-LiveBrowserWindows)
if ($ListOnly) {
    if ($windows.Count -eq 0) {
        Write-Host "No visible $Browser main window was found."
        return
    }
    Show-BrowserWindows $windows
    return
}

$target = Resolve-TargetWindow
$safeSampleName = ($SampleName -replace "[^A-Za-z0-9._-]", "-")
if ([string]::IsNullOrWhiteSpace($safeSampleName)) {
    $safeSampleName = "live-$Browser"
}

$runDirectory = Join-Path $OutputDirectory $safeSampleName
if ([string]::IsNullOrWhiteSpace($TreeOutputDirectory)) {
    $TreeOutputDirectory = Join-Path $runDirectory "trees"
}

New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $TreeOutputDirectory | Out-Null

$probeArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $probePath,
    "-WindowHandle",
    $target.handleText,
    "-SaveSemanticTree",
    "-TreeOutputDirectory",
    $TreeOutputDirectory,
    "-MaxNodes",
    $MaxNodes,
    "-MaxDepth",
    $MaxDepth,
    "-SampleName",
    $safeSampleName
)

if ($Capture) {
    $probeArguments += @("-Capture", "-OutputDirectory", (Join-Path $runDirectory "screen"))
}

if ($IncludeContent) {
    $probeArguments += "-IncludeContent"
}

Write-Host ("Capturing {0} PID={1} title={2}" -f $target.handleText, $target.processId, $target.title)
$probeOutput = & powershell.exe @probeArguments 2>&1 | Out-String
$probeExitCode = $LASTEXITCODE

$probeOutputPath = Join-Path $runDirectory "probe-output.txt"
[IO.File]::WriteAllText($probeOutputPath, $probeOutput, (New-Object System.Text.UTF8Encoding($false)))

$metadata = [ordered]@{
    capture = "live-chromium-uia"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    browser = $Browser
    target = [ordered]@{
        handle = $target.handleText
        processId = $target.processId
        processName = $target.processName
        className = $target.className
        title = $target.title
    }
    options = [ordered]@{
        includeContent = [bool]$IncludeContent
        screenCapture = [bool]$Capture
        maxNodes = $MaxNodes
        maxDepth = $MaxDepth
    }
    probeExitCode = $probeExitCode
    probeOutput = $probeOutputPath
    treeOutput = $TreeOutputDirectory
}

$metadataPath = Join-Path $runDirectory "capture-metadata.json"
[IO.File]::WriteAllText(
    $metadataPath,
    ($metadata | ConvertTo-Json -Depth 12),
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "Capture complete."
Write-Host ("Metadata: {0}" -f $metadataPath)
Write-Host ("Probe output: {0}" -f $probeOutputPath)
Write-Host ("UIA trees: {0}" -f $TreeOutputDirectory)

if ($probeExitCode -ne 0) {
    throw "The UIA probe exited with code $probeExitCode. Inspect probe-output.txt."
}
