$ErrorActionPreference = 'Stop'

# Retire ce qu'install.ps1 depose HORS de l'extension elle-meme (fichiers dans
# ~/.claude/, qui survivent a la desinstallation VS Code). Perimetre volontai-
# rement limite a la commande /handoffs (lot 3 du plan creation-groupes) : les
# hooks/settings.json n'avaient pas de chemin de retrait avant ce lot, et n'en
# gagnent pas ici pour ne pas improviser une portee plus large que demandee.
#
# ASCII pur, meme raison que install.ps1 (PS 5.1 + CP1252 sans BOM).

$claudeDir   = Join-Path $env:USERPROFILE '.claude'
$handoffsMd  = Join-Path $claudeDir 'commands\handoffs.md'

if (Test-Path $handoffsMd) {
    Remove-Item $handoffsMd -Force
    Write-Host "Retire : $handoffsMd"
} else {
    Write-Host "Deja absent : $handoffsMd"
}

Write-Host ""
Write-Host "Hooks (~/.claude/scripts) et settings.json non touches par ce script :"
Write-Host "  aucune procedure de retrait n'existait avant ce lot pour ces deux-la."
