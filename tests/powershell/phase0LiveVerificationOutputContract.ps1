[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TemporaryDirectory = Join-Path $env:TEMP ("clover-live-verification-contract-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null

try {
    $Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $Utf16LeBom = [System.Text.Encoding]::Unicode

    foreach ($FileName in @(
        'Phase0LiveWindow.Common.ps1',
        'Phase0LiveWindow.Sqlite.ps1'
    )) {
        $SourcePath = Join-Path $RepositoryRoot "scripts\ops\$FileName"
        $TargetPath = Join-Path $TemporaryDirectory $FileName
        $Text = [System.IO.File]::ReadAllText($SourcePath, $Utf8Strict)
        [System.IO.File]::WriteAllText($TargetPath, $Text, $Utf16LeBom)
        . $TargetPath
    }

    $DatabasePath = Join-Path $TemporaryDirectory 'verification.sqlite'
    $OutputPath = Join-Path $TemporaryDirectory 'verification.json'
    $SetupScript = Join-Path $TemporaryDirectory 'setup-verification.cjs'

    $SetupCode = @'
'use strict';

const { DatabaseSync } = require('node:sqlite');
const databasePath = process.argv[2];
const db = new DatabaseSync(databasePath);

try {
  db.exec(`
    CREATE TABLE jogadores (id TEXT);
    CREATE TABLE clover_blank_player_identity_archive (archive_id INTEGER PRIMARY KEY);
    CREATE TABLE clover_role_migration_batches (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE clover_role_grants (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE clover_role_migration_batch_grants (batch_id INTEGER NOT NULL, grant_id INTEGER NOT NULL);
    CREATE TABLE clover_role_grant_events (grant_id INTEGER NOT NULL, action TEXT NOT NULL);
    CREATE TABLE clover_admin_roles (active INTEGER NOT NULL);
    CREATE TABLE clover_access_roles (status TEXT NOT NULL);

    CREATE TRIGGER trg_jogadores_require_nonblank_id_insert
    BEFORE INSERT ON jogadores
    WHEN NEW.id IS NULL OR TRIM(CAST(NEW.id AS TEXT)) = ''
    BEGIN
      SELECT RAISE(ABORT, 'blank id');
    END;

    CREATE TRIGGER trg_jogadores_require_nonblank_id_update
    BEFORE UPDATE OF id ON jogadores
    WHEN NEW.id IS NULL OR TRIM(CAST(NEW.id AS TEXT)) = ''
    BEGIN
      SELECT RAISE(ABORT, 'blank id');
    END;
  `);

  const archiveInsert = db.prepare('INSERT INTO clover_blank_player_identity_archive (archive_id) VALUES (?)');
  for (let index = 1; index <= 10; index += 1) archiveInsert.run(index);

  db.prepare('INSERT INTO clover_role_migration_batches (id, status) VALUES (?, ?)').run(1, 'applied');

  const grantInsert = db.prepare('INSERT INTO clover_role_grants (id, status) VALUES (?, ?)');
  const linkInsert = db.prepare('INSERT INTO clover_role_migration_batch_grants (batch_id, grant_id) VALUES (?, ?)');
  const eventInsert = db.prepare('INSERT INTO clover_role_grant_events (grant_id, action) VALUES (?, ?)');
  for (let index = 1; index <= 18; index += 1) {
    grantInsert.run(index, 'active');
    linkInsert.run(1, index);
    eventInsert.run(index, 'granted');
  }

  const adminInsert = db.prepare('INSERT INTO clover_admin_roles (active) VALUES (1)');
  for (let index = 0; index < 5; index += 1) adminInsert.run();

  const accessInsert = db.prepare("INSERT INTO clover_access_roles (status) VALUES ('active')");
  for (let index = 0; index < 14; index += 1) accessInsert.run();
} finally {
  db.close();
}
'@

    [System.IO.File]::WriteAllText($SetupScript, $SetupCode, $Utf8NoBom)

    node $SetupScript $DatabasePath | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao preparar fixture SQLite. Código: $LASTEXITCODE"
    }

    $Output = @(Invoke-LiveVerification `
        -Database $DatabasePath `
        -OutputPath $OutputPath `
        -ExpectedBatchId 1)

    if ($Output.Count -ne 1) {
        throw "Invoke-LiveVerification deveria retornar exatamente um objeto, mas retornou $($Output.Count)."
    }

    $Result = $Output[0]

    foreach ($Property in @(
        'blankIdentityCount',
        'archiveCount',
        'triggerCount',
        'batchStatus',
        'mappedCount',
        'activeCanonicalCount',
        'integrityOk'
    )) {
        if (-not $Result.PSObject.Properties[$Property]) {
            throw "Propriedade ausente no resultado da verificação: $Property"
        }
    }

    $Checks = @(
        ([int]$Result.blankIdentityCount -eq 0)
        ([int]$Result.archiveCount -eq 10)
        ([int]$Result.triggerCount -eq 2)
        ($Result.batchStatus -eq 'applied')
        ([int]$Result.mappedCount -eq 18)
        ([int]$Result.activeMappedCount -eq 18)
        ([int]$Result.activeCanonicalCount -eq 18)
        ([int]$Result.grantedEventCount -eq 18)
        ([int]$Result.legacyAdminCount -eq 5)
        ([int]$Result.legacyAccessCount -eq 14)
        ($Result.integrityOk -eq $true)
    )

    if ($Checks -contains $false) {
        throw 'O objeto único da verificação contém valores inesperados.'
    }

    Write-Host 'Live verification single-result contract passed.' -ForegroundColor Green
}
finally {
    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
