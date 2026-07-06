param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead($InputPath)
try {
    $entry = $zip.GetEntry('word/document.xml')
    if (-not $entry) {
        throw "word/document.xml nao encontrado em $InputPath"
    }

    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
        [xml]$xml = $reader.ReadToEnd()
    } finally {
        $reader.Close()
    }

    $ns = [System.Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')

    $lines = [System.Collections.Generic.List[string]]::new()

    foreach ($node in $xml.SelectNodes('/w:document/w:body/*', $ns)) {
        if ($node.LocalName -eq 'p') {
            $text = [System.Text.StringBuilder]::new()
            foreach ($child in $node.SelectNodes('.//w:t|.//w:tab|.//w:br', $ns)) {
                if ($child.LocalName -eq 'tab') {
                    [void]$text.Append("`t")
                } elseif ($child.LocalName -eq 'br') {
                    [void]$text.Append("`n")
                } else {
                    [void]$text.Append($child.InnerText)
                }
            }
            $lines.Add($text.ToString().TrimEnd())
        } elseif ($node.LocalName -eq 'tbl') {
            foreach ($row in $node.SelectNodes('.//w:tr', $ns)) {
                $cells = @()
                foreach ($cell in $row.SelectNodes('./w:tc', $ns)) {
                    $parts = @()
                    foreach ($paragraph in $cell.SelectNodes('.//w:p', $ns)) {
                        $paragraphText = (($paragraph.SelectNodes('.//w:t', $ns) | ForEach-Object { $_.InnerText }) -join '').Trim()
                        if ($paragraphText) {
                            $parts += $paragraphText
                        }
                    }
                    $cells += (($parts -join ' ') -replace '\s+', ' ').Trim()
                }
                $lines.Add(($cells -join ' | '))
            }
        }
    }

    $text = (($lines -join "`n") -replace "`n{3,}", "`n`n").Trim()
    $parent = Split-Path -Parent $OutputPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText($OutputPath, $text, [System.Text.UTF8Encoding]::new($false))
    Write-Output "extraido: $OutputPath ($($text.Length) chars, $($lines.Count) linhas)"
} finally {
    $zip.Dispose()
}
