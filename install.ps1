$ErrorActionPreference = 'Stop'

# Deploie les hooks Claude Code dont depend l'extension quota-bar, et cable
# settings.json. Idempotent : ne reecrit settings.json que si une entree manque
# (backup horodate + validation JSON post-ecriture). Voir README.md section
# "Showing the current model" pour l'architecture.
#
# ASCII pur volontairement : un .ps1 sans BOM est lu en CP1252 par PS 5.1, les
# caracteres accentues casseraient le parsing.

$claudeDir    = Join-Path $env:USERPROFILE '.claude'
$scriptsDir   = Join-Path $claudeDir 'scripts'
$settingsPath = Join-Path $claudeDir 'settings.json'
$srcHooks     = Join-Path $PSScriptRoot 'hooks'

# usage-statusline.js / track-active-session.js / hook-session-state.js sont des
# hooks ; sessions-state.js, model-id.js et transcript.js sont des libs require()
# par les precedents (meme dossier de deploiement obligatoire).
$hookFiles = @(
    'usage-statusline.js',
    'track-active-session.js',
    'hook-session-state.js',
    'sessions-state.js',
    'model-id.js',
    'transcript.js'
)

# --- 1. Copie des hooks vers ~/.claude/scripts/ ---
if (-not (Test-Path $scriptsDir)) { New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null }
foreach ($f in $hookFiles) {
    $src = Join-Path $srcHooks $f
    if (-not (Test-Path $src)) { throw "Hook source introuvable : $src" }
    Copy-Item $src (Join-Path $scriptsDir $f) -Force
    Write-Host "Copie : $f -> $scriptsDir"
}

# Commandes telles qu'elles doivent figurer dans settings.json (slashes avant, comme l'existant)
$scriptsFwd     = ($scriptsDir -replace '\\', '/')
$statusLineCmd  = "node $scriptsFwd/usage-statusline.js"
$trackCmd       = "node $scriptsFwd/track-active-session.js"
$sessionStateCmd = "node $scriptsFwd/hook-session-state.js"

# Un meme script cable sur 3 evenements : l'idempotence ne peut PAS se tester par
# recherche de texte dans le fichier brut (le 1er event trouve ferait croire que
# les 3 sont la). On teste event par event dans l'objet parse.
function Test-HookPresent($settings, $eventName, $needle) {
    if (-not ($settings.PSObject.Properties.Name -contains 'hooks')) { return $false }
    if (-not ($settings.hooks.PSObject.Properties.Name -contains $eventName)) { return $false }
    foreach ($g in @($settings.hooks.$eventName)) {
        if ($null -eq $g) { continue }
        foreach ($h in @($g.hooks)) {
            if ($null -eq $h) { continue }
            if ($h.command -like "*$needle*") { return $true }
        }
    }
    return $false
}

# Ajoute TOUJOURS notre propre groupe (matcher '' = tous les cas) plutot que
# d'appender au groupe existant : sur Notification/SessionEnd un groupe peut
# porter un matcher restrictif ('permission_prompt'), et s'y greffer limiterait
# silencieusement notre hook a ce seul cas.
function Add-HookEntry($settings, $eventName, $cmd) {
    $newHook = [pscustomobject]@{ type = 'command'; command = $cmd }
    if (-not ($settings.PSObject.Properties.Name -contains 'hooks')) {
        $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{})
    }
    if (-not ($settings.hooks.PSObject.Properties.Name -contains $eventName)) {
        $settings.hooks | Add-Member -NotePropertyName $eventName -NotePropertyValue @()
    }
    $groups = @($settings.hooks.$eventName) | Where-Object { $null -ne $_ }
    $settings.hooks.$eventName = @($groups) + @([pscustomobject]@{ matcher = ''; hooks = @($newHook) })
    Write-Host "settings.json : hook $eventName ajoute ($([System.IO.Path]::GetFileName(($cmd -split ' ')[-1])))."
}

# --- 2. Cablage settings.json (idempotent) ---
$rawText  = if (Test-Path $settingsPath) { Get-Content $settingsPath -Raw -Encoding UTF8 } else { '{}' }
$settings = $rawText | ConvertFrom-Json

$hasStatusLine = $rawText -match 'usage-statusline\.js'
$needed = @()
if (-not (Test-HookPresent $settings 'UserPromptSubmit' 'track-active-session.js')) {
    $needed += @{ Event = 'UserPromptSubmit'; Cmd = $trackCmd }
}
# PermissionRequest est le seul signal IMMEDIAT d'un dialogue de permission :
# Notification:permission_prompt n'est emis qu'apres 6 s d'inactivite de l'user
# (cf. hook-session-state.js). PermissionDenied / ElicitationResult referment
# l'attente. Notre hook n'ecrit rien sur stdout : il n'accorde ni ne refuse rien.
foreach ($ev in @('Stop', 'Notification', 'SessionEnd', 'PermissionRequest', 'PermissionDenied', 'Elicitation', 'ElicitationResult')) {
    if (-not (Test-HookPresent $settings $ev 'hook-session-state.js')) {
        $needed += @{ Event = $ev; Cmd = $sessionStateCmd }
    }
}

$bak = $null

if ($hasStatusLine -and $needed.Count -eq 0) {
    Write-Host "settings.json : statusLine + hooks deja cables (aucune modif)."
} else {
    # Backup avant toute ecriture
    if (Test-Path $settingsPath) {
        $bak = "$settingsPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $settingsPath $bak -Force
        Write-Host "Backup settings.json -> $bak"
    }

    # statusLine (objet simple)
    if (-not $hasStatusLine) {
        $sl = [pscustomobject]@{ type = 'command'; command = $statusLineCmd; refreshInterval = 60 }
        if ($settings.PSObject.Properties.Name -contains 'statusLine') {
            $settings.statusLine = $sl
        } else {
            $settings | Add-Member -NotePropertyName 'statusLine' -NotePropertyValue $sl
        }
        Write-Host "settings.json : statusLine ajoute."
    }

    foreach ($n in $needed) { Add-HookEntry $settings $n.Event $n.Cmd }

    # Ecriture UTF-8 sans BOM (Node JSON.parse n'aime pas le BOM)
    $json = $settings | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))

    # Validation : re-parse, sinon restauration du backup
    try {
        Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
        Write-Host "settings.json : ecrit et re-valide (JSON OK)."
    } catch {
        if ($bak -and (Test-Path $bak)) {
            Copy-Item $bak $settingsPath -Force
            throw "settings.json invalide apres ecriture - backup restaure ($bak). Erreur : $_"
        } else {
            throw "settings.json invalide apres ecriture et pas de backup a restaurer. Erreur : $_"
        }
    }
}

Write-Host ""
Write-Host "Installation terminee."
Write-Host "  Hooks deployes : $scriptsDir"
Write-Host "  Etat des conversations : $claudeDir\sessions-state.json (ecrit par les hooks)"
Write-Host "  Reload de la fenetre VS Code pour que l'extension recharge."
