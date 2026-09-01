[CmdletBinding()]
param(
    [string]$WindowHandle,
    [switch]$Capture,
    [switch]$IncludeContent,
    [switch]$SaveSemanticTree,
    [ValidateRange(1, 10000)]
    [int]$MaxNodes = 800,
    [ValidateRange(0, 128)]
    [int]$MaxDepth = 16,
    [string]$OutputDirectory = (Join-Path $env:TEMP "aside-chromium-probe"),
    [string]$TreeOutputDirectory,
    [string]$SampleName = ("sample-" + (Get-Date -Format "yyyyMMdd-HHmmssfff"))
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($TreeOutputDirectory)) {
    $TreeOutputDirectory = Join-Path $PSScriptRoot "..\docs\cycle-4-contextual-sidecar\research\samples"
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

if (-not ([System.Management.Automation.PSTypeName]"AsideWindowsProbe.NativeMethods").Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace AsideWindowsProbe {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential)]
        public struct Rect {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

        public static string WindowText(IntPtr hwnd) {
            var text = new System.Text.StringBuilder(1024);
            GetWindowText(hwnd, text, text.Capacity);
            return text.ToString();
        }

        public static string WindowClass(IntPtr hwnd) {
            var text = new System.Text.StringBuilder(512);
            GetClassName(hwnd, text, text.Capacity);
            return text.ToString();
        }

        public static bool CaptureScreen(IntPtr hwnd, string path) {
            Rect rect;
            if (!GetWindowRect(hwnd, out rect)) return false;
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return false;

            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                bitmap.Save(path, ImageFormat.Png);
            }
            return true;
        }

        public static bool CaptureWindow(IntPtr hwnd, string path) {
            Rect rect;
            if (!GetWindowRect(hwnd, out rect)) return false;
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return false;

            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(bitmap)) {
                var hdc = graphics.GetHdc();
                var rendered = false;
                try {
                    rendered = PrintWindow(hwnd, hdc, 2);
                } finally {
                    graphics.ReleaseHdc(hdc);
                }
                if (!rendered) return false;
                bitmap.Save(path, ImageFormat.Png);
            }
            return true;
        }
    }
}
'@ -ReferencedAssemblies System.Drawing
}

function Get-StringDigest {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return $null
    }

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return (($digest | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 16)
}

function Get-StringMetrics {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return [ordered]@{ present = $false }
    }

    return [ordered]@{
        present = $true
        length = $Value.Length
        hash = Get-StringDigest $Value
    }
}

function Get-UiaValue {
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)]$Property
    )

    try {
        $value = $Element.GetCurrentPropertyValue($Property, $true)
        if ($value -eq [System.Windows.Automation.AutomationElement]::NotSupported) {
            return $null
        }
        return $value
    } catch {
        return $null
    }
}

function Test-UiaPattern {
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)]$Pattern
    )

    try {
        $patternObject = $null
        return $Element.TryGetCurrentPattern($Pattern, [ref]$patternObject)
    } catch {
        return $false
    }
}

function Get-ControlTypeName {
    param($ControlType)

    if ($null -eq $ControlType) {
        return "unknown"
    }

    try {
        return $ControlType.ProgrammaticName
    } catch {
        return "unknown"
    }
}

function Get-ElementRecord {
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)][int]$Depth
    )

    $name = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::NameProperty)
    $automationId = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
    $controlType = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $isEnabled = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
    $isOffscreen = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
    $isKeyboardFocusable = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
    $isContentElement = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsContentElementProperty)
    $isControlElement = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsControlElementProperty)
    $bounds = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
    $typeName = Get-ControlTypeName $controlType
    $isSelected = $null

    if ($typeName -eq "ControlType.TabItem") {
        try {
            $selectionItemObject = $null
            if ($Element.TryGetCurrentPattern(
                [System.Windows.Automation.SelectionItemPattern]::Pattern,
                [ref]$selectionItemObject
            )) {
                $isSelected = ([System.Windows.Automation.SelectionItemPattern]$selectionItemObject).Current.IsSelected
            }
        } catch {
            $isSelected = $null
        }
    }

    $patterns = [ordered]@{
        text = Test-UiaPattern $Element ([System.Windows.Automation.TextPattern]::Pattern)
        value = Test-UiaPattern $Element ([System.Windows.Automation.ValuePattern]::Pattern)
        selection = Test-UiaPattern $Element ([System.Windows.Automation.SelectionPattern]::Pattern)
        selectionItem = Test-UiaPattern $Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        invoke = Test-UiaPattern $Element ([System.Windows.Automation.InvokePattern]::Pattern)
        scroll = Test-UiaPattern $Element ([System.Windows.Automation.ScrollPattern]::Pattern)
    }

    return [pscustomobject]@{
        element = $Element
        depth = $Depth
        type = $typeName
        rawName = $name
        rawAutomationId = $automationId
        name = Get-StringMetrics $name
        automationId = Get-StringMetrics $automationId
        enabled = $isEnabled
        offscreen = $isOffscreen
        keyboardFocusable = $isKeyboardFocusable
        contentElement = $isContentElement
        controlElement = $isControlElement
        selected = $isSelected
        bounds = if ($null -ne $bounds) {
            [ordered]@{
                x = $bounds.X
                y = $bounds.Y
                width = $bounds.Width
                height = $bounds.Height
            }
        } else {
            $null
        }
        patterns = $patterns
    }
}

function Get-UiaTree {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [ValidateSet("Control", "Content")][string]$View = "Content",
        [int]$MaxNodes = 800,
        [int]$MaxDepth = 16
    )

    $walker = if ($View -eq "Control") {
        [System.Windows.Automation.TreeWalker]::ControlViewWalker
    } else {
        [System.Windows.Automation.TreeWalker]::ContentViewWalker
    }

    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([pscustomobject]@{ element = $Root; depth = 0; parentIndex = -1 })
    $records = New-Object System.Collections.Generic.List[object]
    $truncated = $false
    $depthLimitedNodeCount = 0
    $depthProbeErrorCount = 0
    $traversalErrorCount = 0
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    while ($queue.Count -gt 0) {
        if ($records.Count -ge $MaxNodes) {
            $truncated = $true
            break
        }

        $entry = $queue.Dequeue()
        $record = Get-ElementRecord $entry.element $entry.depth
        $record | Add-Member -NotePropertyName index -NotePropertyValue $records.Count
        $record | Add-Member -NotePropertyName parentIndex -NotePropertyValue $entry.parentIndex
        $records.Add($record)

        if ($entry.depth -ge $MaxDepth) {
            try {
                $childAtLimit = $walker.GetFirstChild($entry.element)
                if ($null -ne $childAtLimit) {
                    $depthLimitedNodeCount++
                }
            } catch {
                $depthProbeErrorCount++
            }
            continue
        }

        try {
            $child = $walker.GetFirstChild($entry.element)
            while ($null -ne $child) {
                $queue.Enqueue([pscustomobject]@{
                    element = $child
                    depth = $entry.depth + 1
                    parentIndex = $record.index
                })
                $child = $walker.GetNextSibling($child)
            }
        } catch {
            $traversalErrorCount++
            continue
        }
    }

    $timer.Stop()

    return [pscustomobject]@{
        view = $View
        nodeCount = $records.Count
        truncated = $truncated
        depthTruncated = ($depthLimitedNodeCount -gt 0)
        depthLimitedNodeCount = $depthLimitedNodeCount
        depthProbeErrorCount = $depthProbeErrorCount
        traversalErrorCount = $traversalErrorCount
        durationMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 2)
        records = $records
    }
}

function Get-TextPatternMetrics {
    param([Parameter(Mandatory = $true)]$Element)

    try {
        $patternObject = $null
        if (-not $Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$patternObject)) {
            return $null
        }

        $textPattern = [System.Windows.Automation.TextPattern]$patternObject
        $documentRange = $textPattern.DocumentRange
        $documentSample = $documentRange.GetText(4096)
        $selectionRanges = @($textPattern.GetSelection())
        $selectionLength = 0
        $selectionSamples = New-Object System.Collections.Generic.List[string]
        foreach ($range in $selectionRanges | Select-Object -First 16) {
            $sample = $range.GetText(4096)
            if ($null -ne $sample) {
                $selectionLength += $sample.Length
                if ($selectionSamples.Count -lt 2) {
                    $selectionSamples.Add($sample)
                }
            }
        }

        $visibleRanges = @($textPattern.GetVisibleRanges())
        $visibleLength = 0
        foreach ($range in $visibleRanges | Select-Object -First 32) {
            $sample = $range.GetText(4096)
            if ($null -ne $sample) {
                $visibleLength += $sample.Length
            }
        }

        $result = [ordered]@{
            documentSample = Get-StringMetrics $documentSample
            selectionRangeCount = $selectionRanges.Count
            selectionText = [ordered]@{
                present = ($selectionLength -gt 0)
                length = $selectionLength
                hash = if ($selectionLength -gt 0) { Get-StringDigest (($selectionSamples -join "`n")) } else { $null }
            }
            visibleRangeCount = $visibleRanges.Count
            visibleText = [ordered]@{
                present = ($visibleLength -gt 0)
                length = $visibleLength
            }
        }

        if ($IncludeContent) {
            $result.documentSample.text = $documentSample
            $result.selectionText.samples = @($selectionSamples)
        }

        return $result
    } catch {
        return [ordered]@{
            error = "TextPattern query failed"
        }
    }
}

function Get-PatternSummary {
    param([Parameter(Mandatory = $true)]$Records)

    $summary = [ordered]@{
        patternCounts = [ordered]@{
            text = 0
            value = 0
            selection = 0
            selectionItem = 0
            invoke = 0
            scroll = 0
        }
        controlTypeCounts = [ordered]@{}
        tabs = New-Object System.Collections.Generic.List[object]
        textProviders = New-Object System.Collections.Generic.List[object]
        edits = New-Object System.Collections.Generic.List[object]
    }

    foreach ($record in $Records) {
        $type = $record.type
        if (-not $summary.controlTypeCounts.Contains($type)) {
            $summary.controlTypeCounts[$type] = 0
        }
        $summary.controlTypeCounts[$type]++

        foreach ($patternName in @($summary.patternCounts.Keys)) {
            if ($record.patterns[$patternName]) {
                $summary.patternCounts[$patternName]++
            }
        }

        if ($type -eq "ControlType.TabItem") {
            $isSelected = Get-UiaValue $record.element ([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
            $tab = [ordered]@{
                name = $record.name
                automationId = $record.automationId
                selected = $isSelected
                patterns = $record.patterns
            }
            $summary.tabs.Add($tab)
        }

        if ($record.patterns.text) {
            $textMetrics = Get-TextPatternMetrics $record.element
            $summary.textProviders.Add([ordered]@{
                type = $type
                name = $record.name
                metrics = $textMetrics
            })
        }

        if ($type -eq "ControlType.Edit") {
            $valueMetrics = [ordered]@{ available = $record.patterns.value }
            if ($record.patterns.value) {
                try {
                    $valueObject = $null
                    if ($record.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valueObject)) {
                        $value = ([System.Windows.Automation.ValuePattern]$valueObject).Current.Value
                        $valueMetrics.value = Get-StringMetrics $value
                    }
                } catch {
                    $valueMetrics.error = "ValuePattern query failed"
                }
            }
            $summary.edits.Add([ordered]@{
                name = $record.name
                automationId = $record.automationId
                enabled = $record.enabled
                offscreen = $record.offscreen
                value = $valueMetrics
            })
        }
    }

    return $summary
}

function Convert-RecordToTreeNode {
    param([Parameter(Mandatory = $true)]$Record)

    $node = [ordered]@{
        index = $Record.index
        parentIndex = $Record.parentIndex
        depth = $Record.depth
        type = $Record.type
        nameMetrics = $Record.name
        automationIdMetrics = $Record.automationId
        enabled = $Record.enabled
        offscreen = $Record.offscreen
        keyboardFocusable = $Record.keyboardFocusable
        contentElement = $Record.contentElement
        controlElement = $Record.controlElement
        bounds = $Record.bounds
        patterns = $Record.patterns
    }

    if ($null -ne $Record.selected) {
        $node.selected = $Record.selected
    }

    if ($IncludeContent) {
        $node.name = $Record.rawName
        $node.automationId = $Record.rawAutomationId
    }

    return $node
}

function Save-SemanticTree {
    param(
        [Parameter(Mandatory = $true)]$Tree,
        [Parameter(Mandatory = $true)][string]$View,
        [Parameter(Mandatory = $true)]$Target
    )

    $safeSampleName = ($SampleName -replace "[^A-Za-z0-9._-]", "-")
    if ([string]::IsNullOrWhiteSpace($safeSampleName)) {
        $safeSampleName = "sample"
    }

    $sampleDirectory = Join-Path $TreeOutputDirectory $safeSampleName
    New-Item -ItemType Directory -Force -Path $sampleDirectory | Out-Null
    $fileName = "uia-" + $View.ToLowerInvariant() + "-view.json"
    $path = Join-Path $sampleDirectory $fileName
    $payload = [ordered]@{
        probe = "chromium-uia-screen"
        generatedAt = [DateTime]::UtcNow.ToString("o")
        view = $View
        limits = [ordered]@{
            maxNodes = $MaxNodes
            maxDepth = $MaxDepth
        }
        target = [ordered]@{
            processName = $Target.processName
            processPath = $Target.processPath
            className = $Target.className
            title = $Target.title
        }
        nodeCount = $Tree.nodeCount
        truncated = $Tree.truncated
        depthTruncated = $Tree.depthTruncated
        depthLimitedNodeCount = $Tree.depthLimitedNodeCount
        depthProbeErrorCount = $Tree.depthProbeErrorCount
        traversalErrorCount = $Tree.traversalErrorCount
        durationMs = $Tree.durationMs
        nodes = @($Tree.records | ForEach-Object { Convert-RecordToTreeNode $_ })
    }

    $json = $payload | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText(
        $path,
        $json,
        (New-Object System.Text.UTF8Encoding($false))
    )
    return $path
}

function Convert-ToHandle {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return [AsideWindowsProbe.NativeMethods]::GetForegroundWindow()
    }

    if ($Value -match '^0x') {
        return [IntPtr]([Convert]::ToInt64($Value.Substring(2), 16))
    }

    return [IntPtr]([Convert]::ToInt64($Value, 10))
}

function Get-PngCaptureMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()]$ExpectedRect
    )

    $image = $null
    try {
        $image = [System.Drawing.Image]::FromFile($Path)
        $dimensionsMatch = $true
        if ($null -ne $ExpectedRect) {
            $dimensionsMatch = (
                $image.Width -eq $ExpectedRect.width -and
                $image.Height -eq $ExpectedRect.height
            )
        }

        return [ordered]@{
            captured = $true
            valid = $dimensionsMatch
            path = $Path
            bytes = (Get-Item $Path).Length
            sha256 = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
            width = $image.Width
            height = $image.Height
            expectedWidth = if ($null -ne $ExpectedRect) { $ExpectedRect.width } else { $null }
            expectedHeight = if ($null -ne $ExpectedRect) { $ExpectedRect.height } else { $null }
            dimensionsMatch = $dimensionsMatch
        }
    } catch {
        return [ordered]@{
            captured = $false
            valid = $false
            path = $Path
            error = "PNG validation failed"
        }
    } finally {
        if ($null -ne $image) {
            $image.Dispose()
        }
    }
}

function Get-TargetSummary {
    param([IntPtr]$Handle)

    $processId = 0
    [void][AsideWindowsProbe.NativeMethods]::GetWindowThreadProcessId($Handle, [ref]$processId)
    $title = [AsideWindowsProbe.NativeMethods]::WindowText($Handle)
    $className = [AsideWindowsProbe.NativeMethods]::WindowClass($Handle)
    $processName = $null
    $processPath = $null
    $windowRect = $null
    $hasWindowRect = $false

    $rect = New-Object AsideWindowsProbe.NativeMethods+Rect
    try {
        $hasWindowRect = [AsideWindowsProbe.NativeMethods]::GetWindowRect($Handle, [ref]$rect)
        if ($hasWindowRect) {
            $windowRect = [ordered]@{
                x = $rect.Left
                y = $rect.Top
                width = $rect.Right - $rect.Left
                height = $rect.Bottom - $rect.Top
            }
        }
    } catch {
    }

    if ($processId -gt 0) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $processName = $process.ProcessName
            try { $processPath = $process.Path } catch { }
        } catch {
        }
    }

    return [ordered]@{
        handle = if ($Handle -eq [IntPtr]::Zero) { "0x0" } else { "0x{0:X}" -f $Handle.ToInt64() }
        valid = [AsideWindowsProbe.NativeMethods]::IsWindow($Handle)
        processId = $processId
        processName = $processName
        processPath = $processPath
        className = $className
        title = Get-StringMetrics $title
        windowState = [ordered]@{
            visible = [AsideWindowsProbe.NativeMethods]::IsWindowVisible($Handle)
            minimized = [AsideWindowsProbe.NativeMethods]::IsIconic($Handle)
            maximized = [AsideWindowsProbe.NativeMethods]::IsZoomed($Handle)
        }
        windowRect = $windowRect
    }
}

$handle = Convert-ToHandle $WindowHandle
$target = Get-TargetSummary $handle
$result = [ordered]@{
    probe = "chromium-uia-screen"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    limits = [ordered]@{
        maxNodes = $MaxNodes
        maxDepth = $MaxDepth
    }
    target = $target
    uia = [ordered]@{
        available = $false
        rootCreated = $false
        focusedElement = $null
        controlView = $null
        contentView = $null
        semanticTreeFiles = New-Object System.Collections.Generic.List[string]
        note = ""
    }
    screenCapture = [ordered]@{
        requested = [bool]$Capture
        gdi = [ordered]@{
            copyFromScreen = $null
            printWindow = $null
        }
        note = ""
    }
    warnings = New-Object System.Collections.Generic.List[string]
}

if (-not $target.valid) {
    $result.warnings.Add("No valid target window was available. Pass -WindowHandle 0x... while the browser window is visible.")
    $result.uia.note = "UIA was not queried because the target HWND was invalid."
    $result.screenCapture.note = "Capture was not attempted because the target HWND was invalid."
} else {
    $controlTree = $null
    $contentTree = $null
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        $result.uia.available = $true
        $result.uia.rootCreated = ($null -ne $root)

        if ($null -ne $root) {
            try {
                $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
                if ($null -ne $focused) {
                    $focusedType = Get-UiaValue $focused ([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
                    $focusedName = Get-UiaValue $focused ([System.Windows.Automation.AutomationElement]::NameProperty)
                    $result.uia.focusedElement = [ordered]@{
                        type = Get-ControlTypeName $focusedType
                        name = Get-StringMetrics $focusedName
                        belongsToTarget = $false
                    }
                    try {
                        $result.uia.focusedElement.belongsToTarget = $root.FindFirst(
                            [System.Windows.Automation.TreeScope]::Descendants,
                            (New-Object System.Windows.Automation.PropertyCondition(
                                [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
                                $focused.Current.NativeWindowHandle
                            ))
                        ) -ne $null
                    } catch {
                    }
                }
            } catch {
                $result.warnings.Add("FocusedElement was unavailable.")
            }

            try {
                $controlTimer = [System.Diagnostics.Stopwatch]::StartNew()
                $controlTree = Get-UiaTree $root Control $MaxNodes $MaxDepth
                $controlSummary = Get-PatternSummary $controlTree.records
                $controlTimer.Stop()
                $result.uia.controlView = [ordered]@{
                    view = $controlTree.view
                    nodeCount = $controlTree.nodeCount
                    truncated = $controlTree.truncated
                    depthTruncated = $controlTree.depthTruncated
                    depthLimitedNodeCount = $controlTree.depthLimitedNodeCount
                    depthProbeErrorCount = $controlTree.depthProbeErrorCount
                    traversalErrorCount = $controlTree.traversalErrorCount
                    traversalDurationMs = $controlTree.durationMs
                    durationMs = [math]::Round($controlTimer.Elapsed.TotalMilliseconds, 2)
                    summary = $controlSummary
                }
            } catch {
                $result.warnings.Add("UIA ControlView traversal failed.")
            }

            try {
                $contentTimer = [System.Diagnostics.Stopwatch]::StartNew()
                $contentTree = Get-UiaTree $root Content $MaxNodes $MaxDepth
                $contentSummary = Get-PatternSummary $contentTree.records
                $contentTimer.Stop()
                $result.uia.contentView = [ordered]@{
                    view = $contentTree.view
                    nodeCount = $contentTree.nodeCount
                    truncated = $contentTree.truncated
                    depthTruncated = $contentTree.depthTruncated
                    depthLimitedNodeCount = $contentTree.depthLimitedNodeCount
                    depthProbeErrorCount = $contentTree.depthProbeErrorCount
                    traversalErrorCount = $contentTree.traversalErrorCount
                    traversalDurationMs = $contentTree.durationMs
                    durationMs = [math]::Round($contentTimer.Elapsed.TotalMilliseconds, 2)
                    summary = $contentSummary
                }
            } catch {
                $result.warnings.Add("UIA ContentView traversal failed.")
            }

            if ($SaveSemanticTree) {
                if ($null -ne $controlTree) {
                    $result.uia.semanticTreeFiles.Add((Save-SemanticTree $controlTree "Control" $target))
                }
                if ($null -ne $contentTree) {
                    $result.uia.semanticTreeFiles.Add((Save-SemanticTree $contentTree "Content" $target))
                }
                if ($result.uia.semanticTreeFiles.Count -eq 0) {
                    $result.warnings.Add("No UIA tree was available to save.")
                }
            }
        }
    } catch {
        $result.uia.note = "UIA root creation failed."
        $result.warnings.Add("UIA could not create an AutomationElement for the target HWND.")
    }

    if ($Capture) {
        New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
        $copyPath = Join-Path $OutputDirectory "screen-copy.png"
        $printPath = Join-Path $OutputDirectory "print-window.png"

        if ($target.windowState.minimized) {
            $result.screenCapture.gdi.copyFromScreen = [ordered]@{
                captured = $false
                valid = $false
                error = "Target window is minimized"
            }
            $result.screenCapture.gdi.printWindow = [ordered]@{
                captured = $false
                valid = $false
                error = "Target window is minimized"
            }
            $result.screenCapture.note = "GDI probes were skipped because the target window is minimized."
        } else {
            try {
                $copyOk = [AsideWindowsProbe.NativeMethods]::CaptureScreen($handle, $copyPath)
                if ($copyOk) {
                    $result.screenCapture.gdi.copyFromScreen = Get-PngCaptureMetadata $copyPath $target.windowRect
                } else {
                    $result.screenCapture.gdi.copyFromScreen = [ordered]@{ captured = $false; valid = $false }
                }
            } catch {
                $result.screenCapture.gdi.copyFromScreen = [ordered]@{
                    captured = $false
                    valid = $false
                    error = "CopyFromScreen failed"
                }
            }

            try {
                $printOk = [AsideWindowsProbe.NativeMethods]::CaptureWindow($handle, $printPath)
                if ($printOk) {
                    $result.screenCapture.gdi.printWindow = Get-PngCaptureMetadata $printPath $target.windowRect
                } else {
                    $result.screenCapture.gdi.printWindow = [ordered]@{ captured = $false; valid = $false }
                }
            } catch {
                $result.screenCapture.gdi.printWindow = [ordered]@{
                    captured = $false
                    valid = $false
                    error = "PrintWindow failed"
                }
            }
        }
    } else {
        $result.screenCapture.note = "Pass -Capture to write local PNG probes. No image is captured by default."
    }
}

$result | ConvertTo-Json -Depth 16
