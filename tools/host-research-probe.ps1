[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WindowHandle,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId,
    [ValidateSet("Auto", "Explorer", "VSCode", "Word", "Excel", "PDFReader", "Generic")]
    [string]$HostKind = "Auto",
    [switch]$FullExtraction,
    [switch]$ExpandedUia,
    [switch]$IncludeRawContent,
    [switch]$IncludePaths,
    [switch]$RedactSensitive,
    [string]$DocumentPath,
    [ValidateRange(1, 10000)]
    [int]$MaxNodes = 800,
    [ValidateRange(0, 128)]
    [int]$MaxDepth = 16,
    [ValidateRange(256, 10000000)]
    [int]$MaxTextChars = 1000000,
    [ValidateRange(1, 1000000)]
    [int]$MaxCells = 100000,
    [string]$OutputDirectory = (Join-Path ([IO.Path]::GetTempPath()) "aside-host-research"),
    [string]$RunName = ("run-" + (Get-Date -Format "yyyyMMdd-HHmmssfff"))
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ([System.Management.Automation.PSTypeName]"AsideHostResearch.NativeMethods").Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AsideHostResearch {
    public static class NativeMethods {
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);

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
    }

    public static class ActiveComObject {
        [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
        private static extern int CLSIDFromProgID(string progId, out Guid clsid);

        [DllImport("oleaut32.dll")]
        private static extern int GetActiveObject(ref Guid clsid, IntPtr reserved, out IntPtr unknown);

        public static object Get(string progId) {
            Guid clsid;
            var clsidResult = CLSIDFromProgID(progId, out clsid);
            if (clsidResult != 0) Marshal.ThrowExceptionForHR(clsidResult);

            IntPtr unknown;
            var activeResult = GetActiveObject(ref clsid, IntPtr.Zero, out unknown);
            if (activeResult != 0) Marshal.ThrowExceptionForHR(activeResult);
            try {
                return Marshal.GetObjectForIUnknown(unknown);
            } finally {
                Marshal.Release(unknown);
            }
        }
    }
}
'@
}

function Get-StringDigest {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) { return $null }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return (($digest | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 16)
}

function Get-StringMetrics {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) { return [ordered]@{ present = $false } }
    return [ordered]@{
        present = $true
        length = $Value.Length
        bytes = [Text.Encoding]::UTF8.GetByteCount($Value)
        hash = Get-StringDigest $Value
    }
}

function Get-HandleValue {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -match '^0x') {
        return [IntPtr]([Convert]::ToInt64($Value.Substring(2), 16))
    }
    return [IntPtr]([Convert]::ToInt64($Value, 10))
}

function Format-Handle {
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)

    return "0x{0:X}" -f $Handle.ToInt64()
}

function Get-ProcessSnapshot {
    param([Parameter(Mandatory = $true)][int]$Id)

    $process = Get-Process -Id $Id -ErrorAction Stop
    $startTicks = $process.StartTime.ToUniversalTime().Ticks
    $processPath = $null
    try { $processPath = $process.Path } catch { }
    return [ordered]@{
        id = $Id
        name = $process.ProcessName
        executable = ($process.ProcessName + ".exe")
        path = Get-StringMetrics $processPath
        startTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
        startTicks = $startTicks
    }
}

function Get-TargetSnapshot {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId
    )

    if (-not [AsideHostResearch.NativeMethods]::IsWindow($Handle)) {
        throw "The requested HWND is not a valid window."
    }

    [uint32]$nativeProcessId = 0
    [void][AsideHostResearch.NativeMethods]::GetWindowThreadProcessId($Handle, [ref]$nativeProcessId)
    if ($nativeProcessId -ne [uint32]$ExpectedProcessId) {
        throw "The requested HWND does not belong to the requested process."
    }

    $process = Get-ProcessSnapshot $ExpectedProcessId
    $title = [AsideHostResearch.NativeMethods]::WindowText($Handle)
    $className = [AsideHostResearch.NativeMethods]::WindowClass($Handle)
    $fingerprintInput = "{0}|{1}|{2}" -f (Format-Handle $Handle), $ExpectedProcessId, $process.startTicks
    return [ordered]@{
        hwnd = Format-Handle $Handle
        processId = $ExpectedProcessId
        processName = $process.executable
        processPath = $process.path
        processStartTimeUtc = $process.startTimeUtc
        processStartTicks = $process.startTicks
        className = $className
        title = Get-StringMetrics $title
        visible = [AsideHostResearch.NativeMethods]::IsWindowVisible($Handle)
        bindingFingerprint = Get-StringDigest $fingerprintInput
    }
}

function Test-TargetBinding {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks
    )

    if (-not [AsideHostResearch.NativeMethods]::IsWindow($Handle)) { return $false }
    [uint32]$nativeProcessId = 0
    [void][AsideHostResearch.NativeMethods]::GetWindowThreadProcessId($Handle, [ref]$nativeProcessId)
    if ($nativeProcessId -ne [uint32]$ExpectedProcessId) { return $false }
    try {
        $process = Get-Process -Id $ExpectedProcessId -ErrorAction Stop
        return $process.StartTime.ToUniversalTime().Ticks -eq $ExpectedStartTicks
    } catch {
        return $false
    }
}

function Assert-TargetBinding {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks,
        [Parameter(Mandatory = $true)][string]$Phase
    )

    if (-not (Test-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks)) {
        throw "The target binding changed during $Phase."
    }
}

function Get-UiaValue {
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)]$Property
    )

    try {
        $value = $Element.GetCurrentPropertyValue($Property, $true)
        if ($value -eq [System.Windows.Automation.AutomationElement]::NotSupported) { return $null }
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

    if ($null -eq $ControlType) { return "unknown" }
    try { return $ControlType.ProgrammaticName } catch { return "unknown" }
}

function Get-UiaRecord {
    param(
        [Parameter(Mandatory = $true)]$Element,
        [Parameter(Mandatory = $true)][int]$Depth
    )

    $name = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::NameProperty)
    $automationId = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
    $controlType = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $bounds = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
    $typeName = Get-ControlTypeName $controlType
    $selected = $null

    try {
        $selectionObject = $null
        if ($Element.TryGetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern,
            [ref]$selectionObject
        )) {
            $selected = ([System.Windows.Automation.SelectionItemPattern]$selectionObject).Current.IsSelected
        }
    } catch { }

    $rect = $null
    if ($null -ne $bounds) {
        $rect = [ordered]@{
            x = $bounds.X
            y = $bounds.Y
            width = $bounds.Width
            height = $bounds.Height
        }
    }

    return [pscustomobject]@{
        element = $Element
        depth = $Depth
        type = $typeName
        rawName = $name
        rawAutomationId = $automationId
        nameMetrics = Get-StringMetrics $name
        automationIdMetrics = Get-StringMetrics $automationId
        enabled = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
        offscreen = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
        keyboardFocusable = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
        contentElement = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsContentElementProperty)
        controlElement = Get-UiaValue $Element ([System.Windows.Automation.AutomationElement]::IsControlElementProperty)
        selected = $selected
        bounds = $rect
        patterns = [ordered]@{
            text = Test-UiaPattern $Element ([System.Windows.Automation.TextPattern]::Pattern)
            value = Test-UiaPattern $Element ([System.Windows.Automation.ValuePattern]::Pattern)
            selection = Test-UiaPattern $Element ([System.Windows.Automation.SelectionPattern]::Pattern)
            selectionItem = Test-UiaPattern $Element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            invoke = Test-UiaPattern $Element ([System.Windows.Automation.InvokePattern]::Pattern)
            scroll = Test-UiaPattern $Element ([System.Windows.Automation.ScrollPattern]::Pattern)
        }
    }
}

function Get-UiaTree {
    param(
        [Parameter(Mandatory = $true)]$Root,
        [Parameter(Mandatory = $true)][ValidateSet("Control", "Content")][string]$View,
        [Parameter(Mandatory = $true)][int]$TreeMaxNodes,
        [Parameter(Mandatory = $true)][int]$TreeMaxDepth
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
    $providerErrorCount = 0
    $traversalErrorCount = 0
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    while ($queue.Count -gt 0) {
        if ($records.Count -ge $TreeMaxNodes) {
            $truncated = $true
            break
        }

        $entry = $queue.Dequeue()
        try {
            $record = Get-UiaRecord $entry.element $entry.depth
        } catch {
            $providerErrorCount++
            continue
        }
        $record | Add-Member -NotePropertyName index -NotePropertyValue $records.Count
        $record | Add-Member -NotePropertyName parentIndex -NotePropertyValue $entry.parentIndex
        [void]$records.Add($record)

        if ($entry.depth -ge $TreeMaxDepth) {
            try {
                if ($null -ne $walker.GetFirstChild($entry.element)) { $depthLimitedNodeCount++ }
            } catch { $providerErrorCount++ }
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
        }
    }
    $timer.Stop()

    return [pscustomobject]@{
        view = $View
        records = $records
        nodeCount = $records.Count
        truncated = $truncated
        depthTruncated = ($depthLimitedNodeCount -gt 0)
        depthLimitedNodeCount = $depthLimitedNodeCount
        providerErrorCount = $providerErrorCount
        traversalErrorCount = $traversalErrorCount
        durationMs = [math]::Round($timer.Elapsed.TotalMilliseconds, 2)
    }
}

function Convert-UiaRecord {
    param([Parameter(Mandatory = $true)]$Record)

    $node = [ordered]@{
        index = $Record.index
        parentIndex = $Record.parentIndex
        depth = $Record.depth
        type = $Record.type
        nameMetrics = $Record.nameMetrics
        automationIdMetrics = $Record.automationIdMetrics
        enabled = $Record.enabled
        offscreen = $Record.offscreen
        keyboardFocusable = $Record.keyboardFocusable
        contentElement = $Record.contentElement
        controlElement = $Record.controlElement
        bounds = $Record.bounds
        patterns = $Record.patterns
    }
    if ($null -ne $Record.selected) { $node.selected = $Record.selected }
    if ($IncludeRawContent) {
        $node.name = $Record.rawName
        $node.automationId = $Record.rawAutomationId
    }
    return $node
}

function Convert-UiaTreePayload {
    param(
        [Parameter(Mandatory = $true)]$Tree,
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$TreeMaxNodes,
        [Parameter(Mandatory = $true)][int]$TreeMaxDepth
    )

    return [ordered]@{
        probe = "aside-host-research"
        view = $Tree.view
        generatedAt = [DateTime]::UtcNow.ToString("o")
        targetHwnd = Format-Handle $Handle
        limits = [ordered]@{
            maxNodes = $TreeMaxNodes
            maxDepth = $TreeMaxDepth
        }
        nodeCount = $Tree.nodeCount
        truncated = $Tree.truncated
        depthTruncated = $Tree.depthTruncated
        depthLimitedNodeCount = $Tree.depthLimitedNodeCount
        providerErrorCount = $Tree.providerErrorCount
        traversalErrorCount = $Tree.traversalErrorCount
        durationMs = $Tree.durationMs
        nodes = @($Tree.records | ForEach-Object { Convert-UiaRecord $_ })
    }
}

function Protect-Text {
    param([AllowNull()][string]$Text)

    if ($null -eq $Text) { return $null }
    $limited = if ($Text.Length -gt $MaxTextChars) { $Text.Substring(0, $MaxTextChars) } else { $Text }
    $matches = 0
    $patterns = @(
        '(?i)(password|passcode|secret|token|api[_ -]?key)(\s*[:=]\s*)[^\s,;]+'
        '(?i)\b(?:fixture-password|fixture-secret|fixture-sensitive-value)\b'
    )
    $redacted = $limited
    foreach ($pattern in $patterns) {
        $matches += [regex]::Matches($redacted, $pattern).Count
        if ($pattern.StartsWith('(?i)(password')) {
            $redacted = [regex]::Replace($redacted, $pattern, '$1$2[redacted]')
        } else {
            $redacted = [regex]::Replace($redacted, $pattern, '[redacted]')
        }
    }

    $output = [ordered]@{
        metrics = Get-StringMetrics $limited
        redactedMetrics = Get-StringMetrics $redacted
        redactionCount = $matches
    }
    if ($FullExtraction) {
        $output.text = if ($RedactSensitive) { $redacted } else { $limited }
        if ($IncludeRawContent) { $output.rawText = $limited }
    }
    return $output
}

function Get-TextPatternData {
    param([Parameter(Mandatory = $true)]$Element)

    try {
        $patternObject = $null
        if (-not $Element.TryGetCurrentPattern(
            [System.Windows.Automation.TextPattern]::Pattern,
            [ref]$patternObject
        )) { return $null }

        $textPattern = [System.Windows.Automation.TextPattern]$patternObject
        $range = $textPattern.DocumentRange
        $sample = if ($FullExtraction) { $range.GetText(4096) } else { $null }
        $data = [ordered]@{
            available = $true
            document = Protect-Text $sample
            selectionRangeCount = 0
            visibleRangeCount = 0
        }
        try { $data.selectionRangeCount = @($textPattern.GetSelection()).Count } catch { }
        try { $data.visibleRangeCount = @($textPattern.GetVisibleRanges()).Count } catch { }
        if ($FullExtraction) {
            $data.fullDocument = Protect-Text ($range.GetText($MaxTextChars))
        }
        return $data
    } catch {
        return [ordered]@{ available = $false; error = "TextPattern query failed" }
    }
}

function Get-UiaTextProviders {
    param(
        [Parameter(Mandatory = $true)]$Records,
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks
    )

    $providers = New-Object System.Collections.Generic.List[object]
    $providerIndex = 0
    foreach ($record in $Records) {
        if (-not $record.patterns.text) { continue }
        if (($providerIndex % 8) -eq 0) {
            Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "UIA text extraction"
        }
        $data = Get-TextPatternData $record.element
        if ($null -eq $data) { continue }
        [void]$providers.Add([ordered]@{
            index = $providerIndex
            type = $record.type
            depth = $record.depth
            name = $record.nameMetrics
            data = $data
        })
        $providerIndex++
    }

    $longestText = $null
    foreach ($provider in $providers) {
        if ($null -ne $provider.data.fullDocument -and $provider.data.fullDocument.metrics.length -gt $(if ($null -eq $longestText) { 0 } else { $longestText.metrics.length })) {
            $longestText = $provider.data.fullDocument
        }
    }
    return [ordered]@{
        providerCount = $providers.Count
        providers = @($providers)
        primaryDocument = $longestText
    }
}

function Test-AbsolutePath {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return $Value -match '^(?:[A-Za-z]:[\\/]|\\\\|//)'
}

function Get-PathDescriptor {
    param(
        [Parameter(Mandatory = $true)][ValidateSet("workspace_root", "active_file", "directory", "selected_item", "document")]
        [string]$Role,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    if (-not (Test-AbsolutePath $Candidate)) { return $null }
    try {
        $item = Get-Item -LiteralPath $Candidate -Force -ErrorAction Stop
        $resolved = Resolve-Path -LiteralPath $Candidate -ErrorAction Stop
        $canonical = $resolved.ProviderPath.Replace('\', '/')
        $kind = if ($item.PSIsContainer) { "directory" } else { "file" }
        return [ordered]@{ role = $Role; path = $canonical; kind = $kind }
    } catch {
        return $null
    }
}

function Get-FileMetadata {
    param([Parameter(Mandatory = $true)]$Descriptor)

    try {
        $item = Get-Item -LiteralPath $Descriptor.path -Force -ErrorAction Stop
        return [ordered]@{
            path = Protect-PathDescriptor $Descriptor
            name = if ($IncludeRawContent) { $item.Name } else { Get-StringMetrics $item.Name }
            extension = if ($IncludeRawContent) { $item.Extension } else { Get-StringMetrics $item.Extension }
            lengthBytes = if ($item.PSIsContainer) { $null } else { $item.Length }
            creationTimeUtc = $item.CreationTimeUtc.ToString("o")
            lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
            attributes = $item.Attributes.ToString()
        }
    } catch {
        return [ordered]@{
            path = Protect-PathDescriptor $Descriptor
            unavailable = $true
        }
    }
}

function Protect-PathDescriptor {
    param([Parameter(Mandatory = $true)]$Descriptor)

    return [ordered]@{
        role = $Descriptor.role
        kind = $Descriptor.kind
        path = if ($IncludePaths) { $Descriptor.path } else { $null }
        pathMetrics = Get-StringMetrics $Descriptor.path
    }
}

function Get-UiaPathSignals {
    param([Parameter(Mandatory = $true)]$Records)

    $descriptors = New-Object System.Collections.Generic.List[object]
    $directories = New-Object System.Collections.Generic.List[object]
    $explicitMarkers = @("path", "filepath", "file-path", "workspace", "resource", "documentpath", "document-path", "location", "address")

    foreach ($record in $Records) {
        $identifier = if ($null -eq $record.rawAutomationId) { "" } else { $record.rawAutomationId.ToString().ToLowerInvariant() }
        $name = if ($null -eq $record.rawName) { "" } else { $record.rawName.ToString().ToLowerInvariant() }
        $explicit = ($explicitMarkers | Where-Object { $identifier.Contains($_) -or $name.Contains($_) }).Count -gt 0 -or $identifier -eq "41477"
        $value = $null
        if ($record.patterns.value) {
            try {
                $valueObject = $null
                if ($record.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valueObject)) {
                    $value = ([System.Windows.Automation.ValuePattern]$valueObject).Current.Value
                }
            } catch { }
        }
        if ([string]::IsNullOrWhiteSpace($value)) { $value = $record.rawName }
        if ([string]::IsNullOrWhiteSpace($value) -or -not (Test-AbsolutePath $value)) { continue }
        $descriptor = Get-PathDescriptor "document" $value
        if ($null -eq $descriptor) { continue }
        if ($explicit -and $descriptor.kind -eq "directory") {
            $directory = Get-PathDescriptor "directory" $value
            if ($null -ne $directory -and -not ($directories.path -contains $directory.path)) { [void]$directories.Add($directory) }
        } elseif ($explicit -or $record.type -eq "ControlType.Document") {
            if (-not (($descriptors | Where-Object { $_.path -eq $descriptor.path }).Count -gt 0)) { [void]$descriptors.Add($descriptor) }
        }
    }

    foreach ($record in $Records) {
        if ($record.type -notin @("ControlType.ListItem", "ControlType.DataItem")) { continue }
        if ($record.selected -ne $true -or [string]::IsNullOrWhiteSpace($record.rawName)) { continue }
        foreach ($directory in $directories) {
            $candidate = Join-Path $directory.path $record.rawName
            $descriptor = Get-PathDescriptor "selected_item" $candidate
            if ($null -ne $descriptor -and -not (($descriptors | Where-Object { $_.path -eq $descriptor.path }).Count -gt 0)) {
                [void]$descriptors.Add($descriptor)
            }
        }
    }

    $allDescriptorObjects = New-Object System.Collections.Generic.List[object]
    foreach ($directory in $directories) { [void]$allDescriptorObjects.Add($directory) }
    foreach ($descriptor in $descriptors) { [void]$allDescriptorObjects.Add($descriptor) }
    return [ordered]@{
        directories = @($directories | ForEach-Object { Protect-PathDescriptor $_ })
        descriptors = @($descriptors | ForEach-Object { Protect-PathDescriptor $_ })
        descriptorObjects = @($allDescriptorObjects)
    }
}

function Invoke-UiaCapture {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][int]$TreeMaxNodes,
        [Parameter(Mandatory = $true)][int]$TreeMaxDepth
    )

    Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "UIA root creation"
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
    if ($null -eq $root) { throw "UIA did not expose a root element for the target." }
    $controlTree = Get-UiaTree $root "Control" $TreeMaxNodes $TreeMaxDepth
    $contentTree = Get-UiaTree $root "Content" $TreeMaxNodes $TreeMaxDepth
    Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "UIA tree traversal"
    $text = Get-UiaTextProviders @($contentTree.records + $controlTree.records) $Handle $ExpectedProcessId $ExpectedStartTicks
    $paths = Get-UiaPathSignals @($contentTree.records + $controlTree.records)
    Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "UIA capture completion"

    return [ordered]@{
        available = $true
        hostKind = $Kind
        rootCreated = $true
        controlTree = $controlTree
        contentTree = $contentTree
        text = $text
        paths = $paths
    }
}

function Get-ComProperty {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    try { return $Object.$Name } catch { return $null }
}

function Release-ComObject {
    param([AllowNull()]$Object)
    if ($null -eq $Object) { return }
    try {
        if ([Runtime.InteropServices.Marshal]::IsComObject($Object)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)
        }
    } catch { }
}

function Get-ActiveComObject {
    param([Parameter(Mandatory = $true)][string]$ProgId)
    return [AsideHostResearch.ActiveComObject]::Get($ProgId)
}

function Get-ComString {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    try { return [string]$Value } catch { return $null }
}

function Get-OfficeProperties {
    param([Parameter(Mandatory = $true)]$Document)

    $properties = [ordered]@{}
    foreach ($name in @("Title", "Subject", "Author", "Keywords", "Comments", "Last Save Time", "Creation Date", "Revision Number")) {
        try {
            $value = $Document.BuiltInDocumentProperties.Item($name).Value
            $text = Get-ComString $value
            $properties[$name] = if ($IncludeRawContent) { $text } else { Get-StringMetrics $text }
        } catch {
            $properties[$name] = [ordered]@{ present = $false }
        }
    }
    return $properties
}

function Get-WordData {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks
    )

    $application = $null
    try {
        Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Word COM binding"
        $application = Get-ActiveComObject "Word.Application"
        $activeWindow = Get-ComProperty $application "ActiveWindow"
        $activeHwnd = Get-ComProperty $activeWindow "Hwnd"
        if ($null -eq $activeHwnd -or [int64]$activeHwnd -ne $Handle.ToInt64()) {
            throw "Word's active window is not the requested target."
        }
        $document = Get-ComProperty $application "ActiveDocument"
        if ($null -eq $document) { throw "Word did not expose an active document." }
        $fullName = Get-ComString (Get-ComProperty $document "FullName")
        if ([string]::IsNullOrWhiteSpace($fullName)) { throw "Word's active document has no saved path." }
        $documentDescriptor = Get-PathDescriptor "document" $fullName
        if ($null -eq $documentDescriptor) { throw "Word's active document path could not be validated." }

        $metadata = [ordered]@{
            application = "Microsoft Word"
            activeWindowHwnd = Format-Handle $Handle
            documentName = if ($IncludeRawContent) { Get-ComString (Get-ComProperty $document "Name") } else { Get-StringMetrics (Get-ComString (Get-ComProperty $document "Name")) }
            path = Protect-PathDescriptor $documentDescriptor
            properties = Get-OfficeProperties $document
        }
        $extraction = [ordered]@{
            mode = if ($FullExtraction) { "full_read_only" } else { "metadata_only" }
            kind = "word"
            paragraphs = New-Object System.Collections.Generic.List[object]
            tables = New-Object System.Collections.Generic.List[object]
            hyperlinks = New-Object System.Collections.Generic.List[object]
        }

        $paragraphs = Get-ComProperty $document "Paragraphs"
        $paragraphCount = [int](Get-ComProperty $paragraphs "Count")
        $tables = Get-ComProperty $document "Tables"
        $tableCount = [int](Get-ComProperty $tables "Count")
        $hyperlinks = Get-ComProperty $document "Hyperlinks"
        $hyperlinkCount = [int](Get-ComProperty $hyperlinks "Count")
        if (-not $FullExtraction) {
            $extraction.counts = [ordered]@{
                paragraphs = $paragraphCount
                tables = $tableCount
                cellsRead = 0
                hyperlinks = $hyperlinkCount
            }
            Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Word metadata completion"
            return [ordered]@{
                available = $true
                source = "office_com"
                metadata = $metadata
                paths = @($documentDescriptor)
                extraction = $extraction
            }
        }
        $paragraphLimit = [math]::Min($paragraphCount, 100000)
        for ($index = 1; $index -le $paragraphLimit; $index++) {
            if (($index % 16) -eq 0) { Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Word paragraph extraction" }
            $paragraph = $null
            try { $paragraph = $paragraphs.Item($index) } catch { continue }
            $range = Get-ComProperty $paragraph "Range"
            $text = Get-ComString (Get-ComProperty $range "Text")
            $style = Get-ComString (Get-ComProperty $paragraph "Style")
            [void]$extraction.paragraphs.Add([ordered]@{
                index = $index
                style = if ($IncludeRawContent) { $style } else { Get-StringMetrics $style }
                text = Protect-Text $text
            })
        }

        $cellCount = 0
        for ($tableIndex = 1; $tableIndex -le [math]::Min($tableCount, 1000); $tableIndex++) {
            if (($tableIndex % 4) -eq 0) { Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Word table extraction" }
            $table = $null
            try { $table = $tables.Item($tableIndex) } catch { continue }
            $rows = [int](Get-ComProperty (Get-ComProperty $table "Rows") "Count")
            $columns = [int](Get-ComProperty (Get-ComProperty $table "Columns") "Count")
            $tableOutput = [ordered]@{ index = $tableIndex; rows = $rows; columns = $columns; cells = New-Object System.Collections.Generic.List[object] }
            for ($row = 1; $row -le $rows -and $cellCount -lt $MaxCells; $row++) {
                for ($column = 1; $column -le $columns -and $cellCount -lt $MaxCells; $column++) {
                    try {
                        $cell = $table.Cell($row, $column)
                        $cellRange = Get-ComProperty $cell "Range"
                        $cellText = Get-ComString (Get-ComProperty $cellRange "Text")
                        [void]$tableOutput.cells.Add([ordered]@{ row = $row; column = $column; text = Protect-Text $cellText })
                        $cellCount++
                    } catch { }
                }
            }
            [void]$extraction.tables.Add($tableOutput)
        }

        for ($index = 1; $index -le [math]::Min($hyperlinkCount, 10000); $index++) {
            try {
                $link = $hyperlinks.Item($index)
                $address = Get-ComString (Get-ComProperty $link "Address")
                $subAddress = Get-ComString (Get-ComProperty $link "SubAddress")
                $display = Get-ComString (Get-ComProperty $link "TextToDisplay")
                [void]$extraction.hyperlinks.Add([ordered]@{
                    address = if ($IncludeRawContent) { $address } else { Get-StringMetrics $address }
                    subAddress = if ($IncludeRawContent) { $subAddress } else { Get-StringMetrics $subAddress }
                    text = Protect-Text $display
                })
            } catch { }
        }
        $extraction.counts = [ordered]@{
            paragraphs = $paragraphCount
            tables = $tableCount
            cellsRead = $cellCount
            hyperlinks = $hyperlinkCount
        }
        Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Word extraction completion"
        return [ordered]@{
            available = $true
            source = "office_com"
            metadata = $metadata
            paths = @($documentDescriptor)
            extraction = $extraction
        }
    } finally {
        Release-ComObject $application
    }
}

function Convert-ExcelValue {
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTime]) { return $Value.ToString("o") }
    if ($Value -is [string] -or $Value -is [bool] -or $Value -is [System.ValueType]) { return $Value }
    try { return [string]$Value } catch { return $null }
}

function Get-ExcelData {
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][int]$ExpectedProcessId,
        [Parameter(Mandatory = $true)][long]$ExpectedStartTicks
    )

    $application = $null
    try {
        Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Excel COM binding"
        $application = Get-ActiveComObject "Excel.Application"
        $activeWindow = Get-ComProperty $application "ActiveWindow"
        $activeHwnd = Get-ComProperty $activeWindow "Hwnd"
        if ($null -eq $activeHwnd -or [int64]$activeHwnd -ne $Handle.ToInt64()) {
            throw "Excel's active window is not the requested target."
        }
        $workbook = Get-ComProperty $application "ActiveWorkbook"
        if ($null -eq $workbook) { throw "Excel did not expose an active workbook." }
        $fullName = Get-ComString (Get-ComProperty $workbook "FullName")
        if ([string]::IsNullOrWhiteSpace($fullName)) { throw "Excel's active workbook has no saved path." }
        $workbookDescriptor = Get-PathDescriptor "document" $fullName
        if ($null -eq $workbookDescriptor) { throw "Excel's active workbook path could not be validated." }

        $metadata = [ordered]@{
            application = "Microsoft Excel"
            activeWindowHwnd = Format-Handle $Handle
            workbookName = if ($IncludeRawContent) { Get-ComString (Get-ComProperty $workbook "Name") } else { Get-StringMetrics (Get-ComString (Get-ComProperty $workbook "Name")) }
            path = Protect-PathDescriptor $workbookDescriptor
            properties = Get-OfficeProperties $workbook
        }
        $extraction = [ordered]@{
            mode = if ($FullExtraction) { "full_read_only" } else { "metadata_only" }
            kind = "excel"
            sheets = New-Object System.Collections.Generic.List[object]
            hyperlinks = New-Object System.Collections.Generic.List[object]
        }

        $worksheets = Get-ComProperty $workbook "Worksheets"
        $sheetCount = [int](Get-ComProperty $worksheets "Count")
        if (-not $FullExtraction) {
            $extraction.counts = [ordered]@{
                sheets = $sheetCount
                cellsRead = 0
                hyperlinks = 0
            }
            Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Excel metadata completion"
            return [ordered]@{
                available = $true
                source = "office_com"
                metadata = $metadata
                paths = @($workbookDescriptor)
                extraction = $extraction
            }
        }
        $cellsRead = 0
        for ($sheetIndex = 1; $sheetIndex -le [math]::Min($sheetCount, 1000); $sheetIndex++) {
            if (($sheetIndex % 4) -eq 0) { Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Excel sheet extraction" }
            $sheet = $null
            try { $sheet = $worksheets.Item($sheetIndex) } catch { continue }
            $usedRange = Get-ComProperty $sheet "UsedRange"
            $sheetName = Get-ComString (Get-ComProperty $sheet "Name")
            $rows = [int](Get-ComProperty (Get-ComProperty $usedRange "Rows") "Count")
            $columns = [int](Get-ComProperty (Get-ComProperty $usedRange "Columns") "Count")
            $address = Get-ComString (Get-ComProperty $usedRange "Address")
            $sheetOutput = [ordered]@{
                index = $sheetIndex
                name = if ($IncludeRawContent) { $sheetName } else { Get-StringMetrics $sheetName }
                usedRange = if ($IncludeRawContent) { $address } else { Get-StringMetrics $address }
                rows = $rows
                columns = $columns
                cells = New-Object System.Collections.Generic.List[object]
            }
            for ($row = 1; $row -le $rows -and $cellsRead -lt $MaxCells; $row++) {
                for ($column = 1; $column -le $columns -and $cellsRead -lt $MaxCells; $column++) {
                    try {
                        $cell = $usedRange.Cells.Item($row, $column)
                        $value = Convert-ExcelValue (Get-ComProperty $cell "Value2")
                        $formula = Get-ComString (Get-ComProperty $cell "Formula")
                        [void]$sheetOutput.cells.Add([ordered]@{
                            row = $row
                            column = $column
                            value = if ($null -eq $value) { $null } elseif ($value -is [string]) { Protect-Text $value } else { $value }
                            formula = if ($IncludeRawContent) { $formula } else { Get-StringMetrics $formula }
                        })
                        $cellsRead++
                    } catch { }
                    if (($cellsRead % 256) -eq 0) { Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Excel cell extraction" }
                }
            }
            [void]$extraction.sheets.Add($sheetOutput)

            try {
                $links = Get-ComProperty $sheet "Hyperlinks"
                $linkCount = [int](Get-ComProperty $links "Count")
                for ($linkIndex = 1; $linkIndex -le [math]::Min($linkCount, 10000); $linkIndex++) {
                    $link = $links.Item($linkIndex)
                    $addressValue = Get-ComString (Get-ComProperty $link "Address")
                    $subAddress = Get-ComString (Get-ComProperty $link "SubAddress")
                    [void]$extraction.hyperlinks.Add([ordered]@{
                        sheet = if ($IncludeRawContent) { $sheetName } else { Get-StringMetrics $sheetName }
                        address = if ($IncludeRawContent) { $addressValue } else { Get-StringMetrics $addressValue }
                        subAddress = if ($IncludeRawContent) { $subAddress } else { Get-StringMetrics $subAddress }
                    })
                }
            } catch { }
        }
        $extraction.counts = [ordered]@{
            sheets = $sheetCount
            cellsRead = $cellsRead
            hyperlinks = $extraction.hyperlinks.Count
        }
        Assert-TargetBinding $Handle $ExpectedProcessId $ExpectedStartTicks "Excel extraction completion"
        return [ordered]@{
            available = $true
            source = "office_com"
            metadata = $metadata
            paths = @($workbookDescriptor)
            extraction = $extraction
        }
    } finally {
        Release-ComObject $application
    }
}

function Resolve-HostKind {
    param(
        [Parameter(Mandatory = $true)][string]$Requested,
        [Parameter(Mandatory = $true)][string]$Executable
    )

    if ($Requested -ne "Auto") { return $Requested }
    switch ($Executable.ToLowerInvariant()) {
        "explorer.exe" { return "Explorer" }
        "code.exe" { return "VSCode" }
        "code-insiders.exe" { return "VSCode" }
        "codium.exe" { return "VSCode" }
        "winword.exe" { return "Word" }
        "excel.exe" { return "Excel" }
        "acrord32.exe" { return "PDFReader" }
        "acrobat.exe" { return "PDFReader" }
        "foxitreader.exe" { return "PDFReader" }
        "sumatrapdf.exe" { return "PDFReader" }
        "okular.exe" { return "PDFReader" }
        default { return "Generic" }
    }
}

function Get-HostCapabilities {
    param([Parameter(Mandatory = $true)][string]$Kind)
    switch ($Kind) {
        "Explorer" { return @("identify", "capture_context", "explorer_metadata", "path_descriptor") }
        "VSCode" { return @("identify", "capture_context", "vscode_workspace", "path_descriptor") }
        "Word" { return @("identify", "capture_context", "word_document", "path_descriptor", "research_full_extraction") }
        "Excel" { return @("identify", "capture_context", "excel_document", "path_descriptor", "research_full_extraction") }
        "PDFReader" { return @("identify", "capture_context", "pdf_document", "research_full_extraction") }
        default { return @("identify", "capture_context", "generic_uia_semantic_capture", "research_full_extraction") }
    }
}

function Write-JsonArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 64
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
    return $Path
}

function New-SafeRunName {
    param([Parameter(Mandatory = $true)][string]$Value)
    $safe = $Value -replace "[^A-Za-z0-9._-]", "-"
    if ([string]::IsNullOrWhiteSpace($safe)) { return "run" }
    return $safe
}

$handle = Get-HandleValue $WindowHandle
$safeRunName = New-SafeRunName $RunName
$runDirectory = Join-Path $OutputDirectory $safeRunName
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

$warnings = New-Object System.Collections.Generic.List[string]
$revalidation = New-Object System.Collections.Generic.List[object]
$target = $null
$resolvedHostKind = $null
$uia = [ordered]@{
    available = $false
    controlViewArtifact = $null
    contentViewArtifact = $null
    textProviderCount = 0
    pathCandidateCount = 0
}
$hostData = [ordered]@{
    available = $false
    source = $null
    metadata = $null
    paths = @()
    extractionArtifact = $null
}
$errorRecord = $null

try {
    $target = Get-TargetSnapshot $handle $ProcessId
    $resolvedHostKind = Resolve-HostKind $HostKind $target.processName
    $targetStartTicks = [long]$target.processStartTicks
    $revalidation.Add([ordered]@{ phase = "initial"; valid = $true; timestamp = [DateTime]::UtcNow.ToString("o") })
    Assert-TargetBinding $handle $ProcessId $targetStartTicks "probe start"

    $effectiveMaxNodes = $MaxNodes
    $effectiveMaxDepth = $MaxDepth
    if ($ExpandedUia) {
        $effectiveMaxNodes = [math]::Max($effectiveMaxNodes, 10000)
        $effectiveMaxDepth = [math]::Max($effectiveMaxDepth, 64)
    }

    try {
        $uiaCapture = Invoke-UiaCapture $handle $ProcessId $targetStartTicks $resolvedHostKind $effectiveMaxNodes $effectiveMaxDepth
        $controlPath = Join-Path $runDirectory "uia-control-view.json"
        $contentPath = Join-Path $runDirectory "uia-content-view.json"
        Write-JsonArtifact $controlPath (Convert-UiaTreePayload $uiaCapture.controlTree $handle $effectiveMaxNodes $effectiveMaxDepth) | Out-Null
        Write-JsonArtifact $contentPath (Convert-UiaTreePayload $uiaCapture.contentTree $handle $effectiveMaxNodes $effectiveMaxDepth) | Out-Null
        $uia.available = $true
        $uia.controlViewArtifact = "uia-control-view.json"
        $uia.contentViewArtifact = "uia-content-view.json"
        $uia.controlView = [ordered]@{
            nodeCount = $uiaCapture.controlTree.nodeCount
            truncated = $uiaCapture.controlTree.truncated
            depthTruncated = $uiaCapture.controlTree.depthTruncated
            providerErrorCount = $uiaCapture.controlTree.providerErrorCount
        }
        $uia.contentView = [ordered]@{
            nodeCount = $uiaCapture.contentTree.nodeCount
            truncated = $uiaCapture.contentTree.truncated
            depthTruncated = $uiaCapture.contentTree.depthTruncated
            providerErrorCount = $uiaCapture.contentTree.providerErrorCount
        }
        $uia.textProviderCount = $uiaCapture.text.providerCount
        $uia.pathCandidateCount = $uiaCapture.paths.descriptorObjects.Count

        $uiaDataPath = Join-Path $runDirectory "uia-text-and-paths.json"
        $uiaData = [ordered]@{
            probe = "aside-host-research"
            generatedAt = [DateTime]::UtcNow.ToString("o")
            targetHwnd = Format-Handle $handle
            text = $uiaCapture.text
            paths = [ordered]@{
                directories = $uiaCapture.paths.directories
                descriptors = $uiaCapture.paths.descriptors
            }
        }
        Write-JsonArtifact $uiaDataPath $uiaData | Out-Null
        $uia.textArtifact = "uia-text-and-paths.json"
    } catch {
        $warnings.Add("UIA capture was unavailable or failed for the bound target.")
    }

    $nativePaths = New-Object System.Collections.Generic.List[object]
    if ($null -ne $uiaCapture) {
        foreach ($candidate in $uiaCapture.paths.descriptorObjects) {
            if (-not (($nativePaths | Where-Object { $_.path -eq $candidate.path -and $_.role -eq $candidate.role }).Count -gt 0)) {
                [void]$nativePaths.Add($candidate)
            }
        }
    }

    if ($resolvedHostKind -eq "Word") {
        try {
            $hostDataRaw = Get-WordData $handle $ProcessId $targetStartTicks
            $hostData.available = $hostDataRaw.available
            $hostData.source = $hostDataRaw.source
            $hostData.metadata = $hostDataRaw.metadata
            foreach ($pathValue in $hostDataRaw.paths) { [void]$nativePaths.Add($pathValue) }
            $extractionPath = Join-Path $runDirectory "document-extraction.json"
            Write-JsonArtifact $extractionPath $hostDataRaw.extraction | Out-Null
            $hostData.extractionArtifact = "document-extraction.json"
        } catch {
            $warnings.Add("Word COM metadata or extraction was unavailable for the bound target.")
        }
    } elseif ($resolvedHostKind -eq "Excel") {
        try {
            $hostDataRaw = Get-ExcelData $handle $ProcessId $targetStartTicks
            $hostData.available = $hostDataRaw.available
            $hostData.source = $hostDataRaw.source
            $hostData.metadata = $hostDataRaw.metadata
            foreach ($pathValue in $hostDataRaw.paths) { [void]$nativePaths.Add($pathValue) }
            $extractionPath = Join-Path $runDirectory "document-extraction.json"
            Write-JsonArtifact $extractionPath $hostDataRaw.extraction | Out-Null
            $hostData.extractionArtifact = "document-extraction.json"
        } catch {
            $warnings.Add("Excel COM metadata or extraction was unavailable for the bound target.")
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($DocumentPath)) {
        $explicitDescriptor = Get-PathDescriptor "document" $DocumentPath
        if ($null -eq $explicitDescriptor) {
            $warnings.Add("The explicitly supplied document path could not be validated.")
        } else {
            [void]$nativePaths.Add($explicitDescriptor)
            $hostData.available = $true
            $hostData.source = "operator_supplied_path"
            $hostData.metadata = [ordered]@{ documentPath = Protect-PathDescriptor $explicitDescriptor }
        }
    }

    $uniquePaths = New-Object System.Collections.Generic.List[object]
    foreach ($descriptor in $nativePaths) {
        if (-not (($uniquePaths | Where-Object { $_.path -eq $descriptor.path -and $_.role -eq $descriptor.role }).Count -gt 0)) {
            [void]$uniquePaths.Add($descriptor)
        }
    }
    $hostData.paths = @($uniquePaths | ForEach-Object { Protect-PathDescriptor $_ })

    if ($resolvedHostKind -eq "PDFReader" -and $uniquePaths.Count -eq 0) {
        $warnings.Add("No target-bound PDF path locator was available; the title was not used as a path guess.")
    }
    if (($resolvedHostKind -eq "Word" -or $resolvedHostKind -eq "Excel") -and -not $hostData.available) {
        $warnings.Add("Office full extraction requires a running target-bound Word or Excel instance in the ROT.")
    }

    if ($resolvedHostKind -eq "PDFReader" -and $uniquePaths.Count -gt 0) {
        $hostData.metadata = [ordered]@{
            reader = $target.processName
            path = Protect-PathDescriptor $uniquePaths[0]
            fileSystem = Get-FileMetadata $uniquePaths[0]
            textExtraction = [ordered]@{
                requested = [bool]$FullExtraction
                providerCount = $uia.textProviderCount
                artifact = $uia.textArtifact
            }
        }
        $hostData.available = $true
        $hostData.source = "pdf_uia_path"
    }

    Assert-TargetBinding $handle $ProcessId $targetStartTicks "probe completion"
    $revalidation.Add([ordered]@{ phase = "completion"; valid = $true; timestamp = [DateTime]::UtcNow.ToString("o") })
} catch {
    $message = $_.Exception.Message
    $code = if ($message -match "binding|HWND|process") { "stale_target" } else { "probe_failed" }
    $errorRecord = [ordered]@{
        code = $code
        message = if ($code -eq "stale_target") { "The explicitly selected target changed or is no longer available." } else { "The research probe could not complete." }
        recoverable = $true
    }
    $warnings.Add("The probe stopped before all requested layers completed.")
    $revalidation.Add([ordered]@{ phase = "failure"; valid = $false; timestamp = [DateTime]::UtcNow.ToString("o") })
}

$summaryTarget = $target
if ($null -eq $summaryTarget) {
    $summaryTarget = [ordered]@{
        hwnd = Format-Handle $handle
        processId = $ProcessId
    }
}
$resolvedCapabilities = @()
if ($null -ne $resolvedHostKind) {
    $resolvedCapabilities = @(Get-HostCapabilities $resolvedHostKind)
}
$warningValues = [object[]]$warnings.ToArray()
$revalidationValues = [object[]]$revalidation.ToArray()
$manifestMaxNodes = $MaxNodes
$manifestMaxDepth = $MaxDepth
if ($ExpandedUia) {
    $manifestMaxNodes = [math]::Max($MaxNodes, 10000)
    $manifestMaxDepth = [math]::Max($MaxDepth, 64)
}

$summary = [ordered]@{
    probe = "aside-host-research"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    target = $summaryTarget
    host = [ordered]@{
        kind = $resolvedHostKind
        capabilities = $resolvedCapabilities
        targetBound = ($null -ne $target -and $revalidation.Count -gt 0 -and $null -eq $errorRecord)
    }
    observations = [ordered]@{
        uia = [ordered]@{
            available = $uia.available
            controlView = $uia.controlView
            contentView = $uia.contentView
            textProviderCount = $uia.textProviderCount
            pathCandidateCount = $uia.pathCandidateCount
        }
        officeCom = [ordered]@{
            attempted = ($resolvedHostKind -eq "Word" -or $resolvedHostKind -eq "Excel")
            available = $hostData.available -and ($hostData.source -eq "office_com")
        }
        fullExtractionRequested = [bool]$FullExtraction
        redactionRequested = [bool]$RedactSensitive
        pathLocator = [ordered]@{
            count = $hostData.paths.Count
            descriptors = $hostData.paths
        }
    }
    comparison = [ordered]@{
        targetBinding = [ordered]@{
            source = "explicit HWND + PID + process start fingerprint"
            targetBound = ($null -ne $target -and $null -eq $errorRecord)
            stableAcrossRuns = "requires repeated runs"
            sensitivity = "local_metadata"
        }
        uia = [ordered]@{
            source = "Windows UI Automation ControlView/ContentView"
            available = $uia.available
            stableAcrossRuns = "requires repeated runs"
            sensitivity = if ($FullExtraction) { "local_content" } else { "local_metadata" }
            production = "bounded_only"
        }
        hostMetadata = [ordered]@{
            source = if ($null -eq $hostData.source) { "none" } else { $hostData.source }
            available = $hostData.available
            stableAcrossRuns = "requires repeated runs"
            sensitivity = "local_metadata"
            production = if ($hostData.paths.Count -gt 0) { "validated_path_only" } else { "unavailable_until_locator_proven" }
        }
        fullExtraction = [ordered]@{
            requested = [bool]$FullExtraction
            available = ($hostData.extractionArtifact -ne $null -or ($uia.available -and $FullExtraction))
            stableAcrossRuns = "requires repeated runs"
            sensitivity = "local_content"
            production = "research_only"
        }
        absentOrDenied = @($warnings)
    }
    decision = [ordered]@{
        production = "path_only_or_bounded_uia"
        richExtraction = "research_only"
        nextStep = "Compare repeated runs, sensitivity, target binding, and latency before choosing an extract contract."
    }
    warnings = $warningValues
    error = $errorRecord
}

$hostDataArtifact = Join-Path $runDirectory "host-data.json"
Write-JsonArtifact $hostDataArtifact $hostData | Out-Null

$summaryArtifact = Join-Path $runDirectory "capability-summary.json"
Write-JsonArtifact $summaryArtifact $summary | Out-Null

$comparisonArtifact = Join-Path $runDirectory "comparison-summary.json"
Write-JsonArtifact $comparisonArtifact ([ordered]@{
    probe = "aside-host-research"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    targetBinding = $summary.comparison.targetBinding
    observations = $summary.comparison
    decision = $summary.decision
}) | Out-Null

$manifestHwnd = Format-Handle $handle
if ($null -ne $target) {
    $manifestHwnd = [string]$target.hwnd
}

$manifest = [ordered]@{
    probe = "aside-host-research"
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString("o")
    options = [ordered]@{
    hostKindRequested = $HostKind
        fullExtraction = [bool]$FullExtraction
        expandedUia = [bool]$ExpandedUia
        includeRawContent = [bool]$IncludeRawContent
        includePaths = [bool]$IncludePaths
        redactSensitive = [bool]$RedactSensitive
        maxNodes = $manifestMaxNodes
        maxDepth = $manifestMaxDepth
        maxTextChars = $MaxTextChars
        maxCells = $MaxCells
    }
    target = $summaryTarget
    host = [ordered]@{
        kind = $resolvedHostKind
        capabilities = $resolvedCapabilities
    }
    binding = [ordered]@{
        hwnd = $manifestHwnd
        processId = $ProcessId
        revalidated = $revalidationValues
    }
    uia = $uia
    hostData = [ordered]@{
        artifact = "host-data.json"
        available = $hostData.available
        source = $hostData.source
        pathCount = $hostData.paths.Count
        extractionArtifact = $hostData.extractionArtifact
    }
    artifacts = [ordered]@{
        manifest = "probe-output.json"
        hostData = "host-data.json"
        capabilitySummary = "capability-summary.json"
        comparisonSummary = "comparison-summary.json"
        controlView = $uia.controlViewArtifact
        contentView = $uia.contentViewArtifact
        textAndPaths = $uia.textArtifact
        documentExtraction = $hostData.extractionArtifact
    }
    warnings = $warningValues
    error = $errorRecord
}

$manifestPath = Join-Path $runDirectory "probe-output.json"
Write-JsonArtifact $manifestPath $manifest | Out-Null
$manifest | ConvertTo-Json -Depth 64
