# Remonte au premier plan la fenêtre VS Code dont le titre commence par le
# libellé d'un onglet donné. Appelé par focus.js (module `focus`), qui vient de
# faire passer cet onglet en actif dans SA fenêtre : le titre de la fenêtre
# reflète l'onglet actif, c'est donc lui qui identifie la bonne fenêtre.
#
# POURQUOI DU WIN32 ET PAS UNE API VS CODE : il n'en existe aucune pour remonter
# une fenêtre (microsoft/vscode#51078, #74945). Et Get-Process ne convient pas
# pour trouver le HWND : toutes les fenêtres d'une même instance VS Code
# appartiennent au MÊME process (MainWindowHandle n'en rend qu'une seule) — d'où
# EnumWindows.
#
# Windows n'accorde pas la prise de focus à n'importe qui (cf. SetForegroundWindow,
# Microsoft Learn) : un process lancé en arrière-plan se voit refuser l'appel.
# MESURÉ sur ce poste le 2026-07-15 : l'appel direct est bel et bien refusé (le
# verrou de premier plan n'expire jamais ici — SPI_GETFOREGROUNDLOCKTIMEOUT vaut
# 2147483647 ms), et c'est le repli AttachThreadInput qui remonte réellement la
# fenêtre (« raised (attach) », jamais « raised (direct) »). Autrement dit ce
# repli N'EST PAS décoratif : c'est lui qui fait marcher la fonctionnalité, ne
# pas le « simplifier ». Ordre : direct → AttachThreadInput → flash de la barre
# des tâches. Le résultat réel est écrit sur stdout et journalisé par focus.js.
param(
  [string]$TitlePrefix = $env:QB_FOCUS_TITLE,
  [string]$ProcessName = $env:QB_FOCUS_PROCESS,
  [int]$TimeoutMs = 1500,
  # Couture de diagnostic : liste les fenêtres correspondantes et sort, sans
  # jamais toucher au premier plan (utilisable pendant que l'user travaille).
  [switch]$ListOnly
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($TitlePrefix)) {
  # Un préfixe vide n'a de sens qu'en diagnostic : il liste toutes les fenêtres.
  if (-not $ListOnly) { Write-Output 'no-title'; exit 1 }
  $TitlePrefix = ''
}
if ([string]::IsNullOrWhiteSpace($ProcessName)) { $ProcessName = 'Code' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class QbWin
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO
    {
        public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout;
    }
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    const int SW_RESTORE = 9;
    const uint FLASHW_ALL = 3;
    const uint FLASHW_TIMERNOFG = 12;

    // Fenêtres visibles des process donnés dont le titre commence par `prefix`.
    // Le titre d'une fenêtre VS Code est « <onglet actif> - <dossier> - Visual
    // Studio Code », précédé de « ● » quand l'éditeur est modifié.
    public static IntPtr[] Find(string prefix, int[] pids)
    {
        HashSet<int> set = new HashSet<int>(pids);
        List<IntPtr> res = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!set.Contains((int)pid)) return true;
            StringBuilder sb = new StringBuilder(1024);
            GetWindowText(h, sb, sb.Capacity);
            string t = sb.ToString().TrimStart('●', ' ');
            if (t.Length > 0 && t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) res.Add(h);
            return true;
        }, IntPtr.Zero);
        return res.ToArray();
    }

    public static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(1024);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Rend la branche qui a gagné : « direct », « attach », ou « no » — pas un
    // bool. Savoir LAQUELLE a marché est ce qui empêche de « simplifier » plus
    // tard un repli qui, lui, porte le fonctionnement réel.
    public static string Raise(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        if (SetForegroundWindow(h) && GetForegroundWindow() == h) return "direct";

        // Refus de Windows : on retente en partageant la file d'entrée du thread
        // qui détient le premier plan (il a, lui, le droit de le céder).
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgTid = GetWindowThreadProcessId(fg, out dummy);
        uint myTid = GetCurrentThreadId();
        bool attached = false;
        if (fgTid != 0 && fgTid != myTid) attached = AttachThreadInput(fgTid, myTid, true);
        try
        {
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
        finally
        {
            if (attached) AttachThreadInput(fgTid, myTid, false);
        }
        return GetForegroundWindow() == h ? "attach" : "no";
    }

    // Dernier recours : la fenêtre clignote dans la barre des tâches. Rien n'est
    // volé à l'utilisateur, mais il voit où aller.
    public static void Flash(IntPtr h)
    {
        FLASHWINFO fi = new FLASHWINFO();
        fi.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        fi.hwnd = h;
        fi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
        fi.uCount = 3;
        fi.dwTimeout = 0;
        FlashWindowEx(ref fi);
    }
}
'@

# Le titre de la fenêtre est mis à jour de façon asynchrone après l'activation de
# l'onglet : sans cette boucle, on chercherait un titre pas encore rafraîchi.
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$hwnds = @()
do {
  $ids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($ids.Count -gt 0) { $hwnds = @([QbWin]::Find($TitlePrefix, [int[]]$ids)) }
  if ($hwnds.Count -gt 0) { break }
  Start-Sleep -Milliseconds 150
} while ((Get-Date) -lt $deadline)

if ($hwnds.Count -eq 0) { Write-Output "not-found (proc=$ProcessName, title=$TitlePrefix)"; exit 2 }

if ($ListOnly) {
  foreach ($h in $hwnds) { Write-Output ("{0} | {1}" -f $h, [QbWin]::TitleOf($h)) }
  exit 0
}

if ($hwnds.Count -gt 1) { Write-Output "ambiguous:$($hwnds.Count) — using the first" }

$how = [QbWin]::Raise($hwnds[0])
if ($how -ne 'no') { Write-Output "raised ($how)"; exit 0 }

[QbWin]::Flash($hwnds[0])
Write-Output 'flashed (Windows refused the foreground change)'
exit 3
