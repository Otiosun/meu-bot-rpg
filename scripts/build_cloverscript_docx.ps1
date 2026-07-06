param(
    [string]$InputPath = "docs/clover/guia-oficial-cloverscript.txt",
    [string]$OutputPath = "docs/clover/guia-oficial-cloverscript.docx"
)

$ErrorActionPreference = "Stop"

function Escape-Xml([string]$Value) {
    if ($null -eq $Value) { return "" }
    return [System.Security.SecurityElement]::Escape($Value)
}

function New-Run([string]$Text, [bool]$Bold = $false, [bool]$Italic = $false) {
    $runProps = ""
    if ($Bold -or $Italic) {
        $parts = @()
        if ($Bold) { $parts += "<w:b/>" }
        if ($Italic) { $parts += "<w:i/>" }
        $runProps = "<w:rPr>$($parts -join '')</w:rPr>"
    }
    return "<w:r>$runProps<w:t xml:space=`"preserve`">$(Escape-Xml $Text)</w:t></w:r>"
}

function New-Paragraph([string]$Text, [string]$Style = "Normal", [bool]$Bold = $false, [bool]$Italic = $false) {
    $pPr = ""
    if ($Style -and $Style -ne "Normal") {
        $pPr = "<w:pPr><w:pStyle w:val=`"$Style`"/></w:pPr>"
    }
    return "<w:p>$pPr$(New-Run $Text $Bold $Italic)</w:p>"
}

function Get-SectionTitle([string]$Line) {
    $dash = [string][char]0x2500
    $clean = $Line.Trim()
    $clean = $clean.Trim([char[]]@('_', [char]0x60, ' '))
    $pattern = "^" + [regex]::Escape($dash) + "\(\s*.+?\s*\)" + [regex]::Escape($dash) + "+\s*"
    $clean = $clean -replace $pattern, ""
    return $clean.Trim()
}

function Convert-LineToParagraphs([string]$Text) {
    $dashPair = ([string][char]0x2500) + ([string][char]0x2500)
    $sectionStart = "_" + ([string][char]0x60) + ([string][char]0x2500) + "("
    $normalized = $Text -replace "`r`n", "`n"
    $normalized = $normalized -replace "`r", "`n"
    $lines = $normalized.Split("`n")
    $paragraphs = New-Object System.Collections.Generic.List[string]
    $inCode = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $raw = $lines[$i]
        $line = $raw.Trim()

        if ($line -match '^```') {
            $inCode = -not $inCode
            continue
        }

        if ($inCode) {
            if ($raw.Length -eq 0) {
                $paragraphs.Add((New-Paragraph " " "Code"))
            } else {
                $paragraphs.Add((New-Paragraph $raw "Code"))
            }
            continue
        }

        if ($i -eq 0) {
            $paragraphs.Add((New-Paragraph $line "Title"))
            continue
        }

        if ($i -eq 1 -and $line.StartsWith($dashPair)) {
            $paragraphs.Add((New-Paragraph $line "Subtitle"))
            $paragraphs.Add((New-Paragraph " " "Spacer"))
            continue
        }

        if (-not $line) {
            $paragraphs.Add((New-Paragraph " " "Spacer"))
            continue
        }

        if ($line.StartsWith($sectionStart)) {
            $paragraphs.Add((New-Paragraph (Get-SectionTitle $line) "Heading1"))
            continue
        }

        if ($line.StartsWith(">")) {
            $paragraphs.Add((New-Paragraph ($line.TrimStart(">").Trim()) "Quote"))
            continue
        }

        if ($line.StartsWith("*") -and $line.EndsWith("*") -and $line.Length -gt 1) {
            $paragraphs.Add((New-Paragraph ($line.Trim("*")) "Command" $true $false))
            continue
        }

        if ($line -match "^(Status|Aplicação no bot|Objetivo|Comando principal|Atalhos|Integração):") {
            $paragraphs.Add((New-Paragraph $line "Meta" $true $false))
            continue
        }

        $paragraphs.Add((New-Paragraph $line "Normal"))
    }

    return $paragraphs
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$root = (Resolve-Path ".").Path
$inputFull = Join-Path $root $InputPath
$outputFull = Join-Path $root $OutputPath

if (-not (Test-Path $inputFull)) {
    throw "Arquivo de entrada nao encontrado: $inputFull"
}

$text = [System.IO.File]::ReadAllText($inputFull, [System.Text.Encoding]::UTF8)
$paragraphs = Convert-LineToParagraphs $text

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("cloverscript-docx-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp "word") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp "word/_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $temp "docProps") | Out-Null

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
'@

$rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
'@

$documentRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
'@

$styles = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="8" w:color="2F6B46"/></w:pBdr></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:color w:val="1F4D37"/><w:sz w:val="34"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:pPr><w:jc w:val="center"/><w:spacing w:after="260"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:i/><w:color w:val="5B6F63"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:shd w:fill="EAF4EF"/><w:pBdr><w:left w:val="single" w:sz="16" w:space="6" w:color="2F6B46"/></w:pBdr></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display"/><w:b/><w:color w:val="1F4D37"/><w:sz w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Command">
    <w:name w:val="Command"/>
    <w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:b/><w:color w:val="263D73"/><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Meta">
    <w:name w:val="Meta"/>
    <w:pPr><w:spacing w:after="80"/><w:shd w:fill="F3F7F4"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:b/><w:color w:val="2F6B46"/><w:sz w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/>
    <w:pPr><w:ind w:left="420"/><w:spacing w:after="80"/><w:shd w:fill="F7F7F2"/><w:pBdr><w:left w:val="single" w:sz="10" w:space="8" w:color="C5A65A"/></w:pBdr></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:color w:val="4F4A3C"/><w:sz w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Code">
    <w:name w:val="Code"/>
    <w:pPr><w:ind w:left="360"/><w:spacing w:before="0" w:after="0"/><w:shd w:fill="F1F3F5"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="243447"/><w:sz w:val="19"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Spacer">
    <w:name w:val="Spacer"/>
    <w:pPr><w:spacing w:after="80"/></w:pPr>
    <w:rPr><w:sz w:val="8"/></w:rPr>
  </w:style>
</w:styles>
'@

$body = ($paragraphs -join "`n")
$document = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
$body
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
"@

$created = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$core = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Guia Oficial - CloverScript</dc:title>
  <dc:subject>Clover Multicolor</dc:subject>
  <dc:creator>Codex</dc:creator>
  <cp:lastModifiedBy>Codex</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">$created</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">$created</dcterms:modified>
</cp:coreProperties>
"@

$app = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Word</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company>Clover Multicolor</Company>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>
'@

Write-Utf8NoBom (Join-Path $temp "[Content_Types].xml") $contentTypes
Write-Utf8NoBom (Join-Path $temp "_rels/.rels") $rels
Write-Utf8NoBom (Join-Path $temp "word/document.xml") $document
Write-Utf8NoBom (Join-Path $temp "word/styles.xml") $styles
Write-Utf8NoBom (Join-Path $temp "word/_rels/document.xml.rels") $documentRels
Write-Utf8NoBom (Join-Path $temp "docProps/core.xml") $core
Write-Utf8NoBom (Join-Path $temp "docProps/app.xml") $app

if (Test-Path $outputFull) {
    Remove-Item -LiteralPath $outputFull -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($temp, $outputFull)
Remove-Item -LiteralPath $temp -Recurse -Force

Write-Output "DOCX gerado: $outputFull"
