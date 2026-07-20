$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$database = "banco.sqlite"
$manifest = "data\player-canonical-batch-1-import.json"
$repairConfirmation = "REPAIR_VITOR_ACCESS_REGRESSION"
$importConfirmation = "IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1"
$botStopped = $false

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Get-CloverHealth {
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 5
    }
    catch {
        return $null
    }
}

Write-Host "`n=== FINALIZAÇÃO CANÔNICA — LOTE 1 ==="

if ((git branch --show-current).Trim() -ne "main") {
    throw "O projeto precisa estar na branch main."
}

$trackedChanges = git status --porcelain --untracked-files=no
if ($trackedChanges) {
    git status --short
    throw "Existem alterações rastreadas no projeto. Nada será executado."
}

foreach ($requiredFile in @(
    $database,
    $manifest,
    "scripts\repairVitorAccessRegression.js",
    "scripts\importCanonicalPlayerContentBatch1.js"
)) {
    if (-not (Test-Path $requiredFile)) {
        throw "Arquivo obrigatório não encontrado: $requiredFile"
    }
}

Write-Host "`n=== VALIDANDO CÓDIGO ==="
Invoke-CheckedCommand {
    node --check scripts\repairVitorAccessRegression.js
} "Erro de sintaxe no reparador de Vitor."

Invoke-CheckedCommand {
    node --check scripts\importCanonicalPlayerContentBatch1.js
} "Erro de sintaxe no importador canônico."

Write-Host "`n=== AGUARDANDO FILA DO CLOVER ==="
$queueReady = $false

for ($attempt = 1; $attempt -le 30; $attempt++) {
    $health = Get-CloverHealth
    if ($null -ne $health) {
        $depth = [int]($health.queue.depth)
        $active = [bool]($health.queue.active)
        Write-Host "Tentativa $attempt`: online=$($health.ok) depth=$depth active=$active"

        if ($health.ok -and $depth -eq 0 -and -not $active) {
            $queueReady = $true
            break
        }
    }

    Start-Sleep -Seconds 2
}

if (-not $queueReady) {
    throw "A fila do Clover não ficou livre. Nada foi alterado."
}

try {
    Write-Host "`n=== PARANDO SOMENTE O CLOVER — PM2 ID 1 ==="
    Invoke-CheckedCommand {
        pm2 stop 1
    } "Não foi possível parar o PM2 ID 1."
    $botStopped = $true

    Write-Host "`n=== CORRIGINDO ACESSO DE VITOR ==="
    Invoke-CheckedCommand {
        node scripts\repairVitorAccessRegression.js `
            --db="$database" `
            --output="backups" `
            --apply `
            --confirm="$repairConfirmation"
    } "A reparação de Vitor falhou. O lote não será importado."

    Write-Host "`n=== COMPLETANDO OS 22 REGISTROS CANÔNICOS ==="
    Invoke-CheckedCommand {
        node scripts\importCanonicalPlayerContentBatch1.js `
            --db="$database" `
            --manifest="$manifest" `
            --output="backups" `
            --apply `
            --confirm="$importConfirmation"
    } "A importação canônica falhou."

    Write-Host "`n=== VERIFICAÇÃO FINAL SOMENTE LEITURA ==="

@'
"use strict";

const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const PLAYER_ID = "119516088528998@lid";
const SOURCE = "admin_whatsapp_2026-07-20";

(async () => {
    const db = await open({
        filename: "banco.sqlite",
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec("PRAGMA query_only = ON");

        const player = await db.get(`
            SELECT personagem_nome, ficha_status, personagem_aparencia_status,
                   historia_status, jogo_status, jogo_liberado_at,
                   jogo_liberado_by, jogo_bloqueio_motivo
            FROM jogadores
            WHERE id = ?
        `, [PLAYER_ID]);

        const totals = await db.all(`
            SELECT content_type, COUNT(*) AS total
            FROM clover_player_content
            WHERE active = 1 AND source = ?
            GROUP BY content_type
            ORDER BY content_type
        `, [SOURCE]);

        const overall = await db.get(`
            SELECT COUNT(*) AS total
            FROM clover_player_content
            WHERE active = 1 AND source = ?
        `, [SOURCE]);

        const vitor = await db.all(`
            SELECT content_type, content_key, title, mechanical_status, review_status
            FROM clover_player_content
            WHERE active = 1 AND source = ? AND player_id = ?
            ORDER BY content_type, content_key
        `, [SOURCE, PLAYER_ID]);

        const pending = await db.get(`
            SELECT COUNT(*) AS total
            FROM clover_player_content
            WHERE active = 1 AND source = ?
              AND content_type = 'custom_trait'
              AND mechanical_status = 'pending_balance'
        `, [SOURCE]);

        const linked = await db.get(`
            SELECT COUNT(*) AS total
            FROM clover_player_content
            WHERE active = 1 AND source = ?
              AND content_type = 'narrative_item'
              AND linked_content_id IS NOT NULL
        `, [SOURCE]);

        console.log("Vitor:", player);
        console.table(totals);
        console.log("Total canônico:", overall.total);
        console.log("Registros de Vitor:", vitor.length);
        console.table(vitor);
        console.log("Traços pendentes de balanceamento:", pending.total);
        console.log("Itens vinculados:", linked.total);

        if (!player || player.personagem_nome !== "Vitor") {
            throw new Error("Cadastro canônico de Vitor não foi encontrado.");
        }
        if (String(player.jogo_status || "").toLowerCase() !== "liberado") {
            throw new Error(`Vitor continua com jogo_status=${player.jogo_status || "vazio"}.`);
        }
        if (!player.jogo_liberado_at || !player.jogo_liberado_by || player.jogo_bloqueio_motivo) {
            throw new Error("Metadados de acesso de Vitor ficaram inconsistentes.");
        }

        const byType = Object.fromEntries(totals.map((row) => [row.content_type, Number(row.total)]));
        const expected = {
            system_trait: 9,
            custom_trait: 7,
            narrative_hook: 4,
            narrative_item: 2,
        };

        if (Number(overall.total) !== 22) throw new Error(`Total canônico inesperado: ${overall.total}/22`);
        for (const [type, total] of Object.entries(expected)) {
            if (Number(byType[type] || 0) !== total) {
                throw new Error(`${type}: ${byType[type] || 0}/${total}`);
            }
        }

        if (vitor.length !== 2) throw new Error(`Vitor possui ${vitor.length}/2 registros.`);
        const vitorKeys = new Set(vitor.map((row) => `${row.content_type}:${row.content_key}`));
        if (!vitorKeys.has("system_trait:cria_da_fronteira")) throw new Error("Cria da Fronteira ausente.");
        if (!vitorKeys.has("narrative_hook:divida_da_montanha")) throw new Error("Dívida da Montanha ausente.");
        if (Number(pending.total) !== 7) throw new Error(`Pendentes: ${pending.total}/7`);
        if (Number(linked.total) !== 2) throw new Error(`Itens vinculados: ${linked.total}/2`);

        const foreignKeys = await db.all("PRAGMA foreign_key_check");
        if (foreignKeys.length) throw new Error(`foreign_key_check: ${foreignKeys.length} falha(s).`);

        const integrity = await db.all("PRAGMA integrity_check");
        const failures = integrity
            .flatMap((row) => Object.values(row))
            .filter((value) => String(value).toLowerCase() !== "ok");
        if (failures.length) throw new Error(`integrity_check: ${failures.join("; ")}`);

        console.log("Integridade SQLite: OK");
        console.log("Lote canônico 1: COMPLETO");
    } finally {
        await db.close();
    }
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
'@ | node

    if ($LASTEXITCODE -ne 0) {
        throw "A verificação final do lote falhou."
    }
}
finally {
    if ($botStopped) {
        Write-Host "`n=== RELIGANDO SOMENTE O CLOVER — PM2 ID 1 ==="
        pm2 restart 1 --update-env
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Falha ao religar o PM2 ID 1."
        }
    }
}

Write-Host "`n=== AGUARDANDO HEALTH DO CLOVER ==="
$online = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
    Start-Sleep -Seconds 2
    $health = Get-CloverHealth
    if ($null -ne $health -and $health.ok) {
        $health | ConvertTo-Json -Depth 20
        $online = $true
        break
    }
}

if (-not $online) {
    throw "O Clover não respondeu ao health após o reinício."
}

Invoke-CheckedCommand {
    pm2 save
} "O lote foi concluído, mas o pm2 save falhou."

Write-Host "`n=== LOTE 1 CONCLUÍDO: 10 JOGADORES, 22 REGISTROS ==="
