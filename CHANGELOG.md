# Changelog

## [2.85.1] - 2026-08-27

### Fixed
- **Packaging only — nothing about the extension itself changes.** Two kinds of file were being shipped inside the installed package without belonging there: an internal working note left in the project folder, and the README's demonstration GIFs. Neither is used by the extension at runtime — the Marketplace resolves the README's images through the GitHub repository, which is why the screenshots were already excluded. The exclusion rules that were supposed to catch such files listed them **by name**, so any working note created after the rule was written sailed straight through; they now match by pattern, on both publication channels (the package and the public repo), which is where the same list had already diverged once. The package drops from 58 to 53 files.

### Changed
- README brought back in line with what the panel actually does: moving a queued task between waves is the **wave n ▾** destination menu introduced in 2.77.1, not the ◂ ▸ arrows it replaced (those remain in the creation form); plus the paste-time preview of a `claude-convs` block (2.83.0), the quota bars' segment tick marks (2.85.0), and the highlight resynchronization banner (2.82.0), none of which were documented.

## [2.85.0] - 2026-08-27

### Added
- **Quota bars now show light tick marks that split them into equal segments** — 5 for the 5h window, 7 for any 7-day window (weekly, or a model-scoped weekly bar). The marks sit in their own thin rail right under the fill, never inside it (so the fill's rounded corners stay intact) and never inside the burn-rate arrow's own rail below, so the two never collide at any fill level. The segment count is derived from the window's actual duration, not from its label, so it stays correct if a differently-sized window ever appears.

## [2.84.0] - 2026-08-27

### Fixed
- **The highlight no longer jumps to the wrong conversation for a few seconds after clicking a row.** The renderer's record of the active editor is the panel's judge of last resort — it is the process that paints the screen, so it settles any disagreement about which conversation is really in front. Its freshness, though, was read from the *file*'s modification time, and that file is rewritten every half-minute for unrelated keys: measured on a live session, 5 flushes out of 10 carried no change at all to the editor key, and the key itself took up to 27 seconds to reflect a tab switch. Judging with a 3-second margin therefore meant arbitrating with a record that could be half a minute stale, and every real correction the journal recorded had done exactly that — overruled a genuine, 4-to-7-second-old click on a panel row. The margin now covers the measured latency, so a lagging record can no longer overrule a fresh choice, while a lasting desynchronization is still caught. Filling a *blank* highlight keeps the short margin: there is no choice to overrule. Each deferred arbitration is journalled (`highlight-truth-deferred`), so what the guard holds back stays measurable instead of guessed.

## [2.83.0] - 2026-08-27

### Added
- **Pasting a `claude-convs` block now shows which conversation the batch will hang from — before you launch it.** The parent conversation used to be looked for only after clicking "Create", so the filiation was discovered once the batch was already running, or not at all when the search had failed. It is now resolved at paste time: the conversation the block came from breathes in the list, and a staple links it to the "New conversation" form — a hooked line with dashes travelling upwards, so the direction of the link reads even on a still image, ending in an arrow that stops just short of the row's status dot. Everything switches off on "Create" and on "Cancel", and a later paste supersedes an earlier one even if the earlier answer comes back last.
- **The future conversations are previewed in place, greyed out under the parent row.** Same rendering the panel already gives a task that has not launched yet — dotted square, prompt, intended model and effort — with the batch's own wave separators (`wave 2 — queued`). When the parent is already the head of a live batch, the preview sits at the bottom of that batch's body, where the tasks will actually be appended. The preview is produced by the flow's own render, so it survives every state push instead of being wiped by the next one.
- **A failed search now says so, in the form.** "No master conversation found — standalone batch" and "N conversations contain this block — none kept" replace what used to be silence, with the consequence spelled out and a tooltip pointing at "Set master…" for linking it by hand. Both cases are common (a hand-written block, a parent conversation that has been closed, a stale token) and a silent panel reads as a breakdown.

### Changed
- Contrast of everything the highlighted row carries was re-measured on the tinted background and re-dosed accordingly (`test/audit-contraste.js` grew the case, plus an untinted control so a pre-existing gap can no longer be mistaken for a new one). One documented gap remains: in dark themes the red context percentage of a highlighted row reaches 4.21:1 against a 4.5 threshold — the tint is 60% the theme's own red, so an alert colour cannot detach from it and stay red.

## [2.82.2] - 2026-08-27

### Fixed
- **The resynchronization banner no longer fires on ordinary tab-title transitions.** Right after 2.82.0 shipped, the banner showed up during normal use: while a tab is being renamed (the few seconds it spends as "Claude Code" before its title arrives), the label-based highlight goes briefly blank, and the renderer's record filling that blank was reported as a "correction". Two rules now gate the alert, while the highlight correction itself stays immediate: filling an *empty* highlight is never reported (nothing wrong was shown), and a real correction is only announced if the disagreement persists for ~5 seconds — a transient the tracker resolves on its own stays silent, the journal keeps its trace, and the 14-minute-class bug the banner exists for still cannot pass unseen.

## [2.82.0] - 2026-08-27

### Fixed
- **The highlight can no longer stay wrong: VS Code's own on-disk record of the active tab now overrules the panel.** Every previous highlight fix defended against the extension-host tab mirror lying in the moment; this release closes the remaining case, where the mirror adopts a wrong active tab and then never emits anything to correct it — measured at 14 minutes of wrong highlight, ended only by a click. The panel now also reads the editor layout VS Code's renderer persists to workspace storage (the process that actually paints your screen, recorded by exact session identity, not by tab label), and whenever that record is more recent than the tab tracker's last change of mind and disagrees with it, the record wins. Any desynchronization now repairs itself at the next state flush instead of lasting forever.

### Added
- **A correction is never silent: a warning banner reports every highlight resynchronization.** When the renderer's record overrules the panel, a dismissible banner appears above the list — time of the correction, which conversation the highlight moved to, what the panel was wrongly showing — and the `highlight-reconciled` journal line carries the full detail. If the banner never shows up again, the bug is truly dead; if it does, it says exactly what to look at.

## [2.81.0] - 2026-08-27

### Fixed
- **Two unrelated conversations that happen to share a title are no longer merged into one.** When a conversation is resumed under a new id (a window reload, or a background respawn), the old transcript stays behind as a shell and the panel folds it into its replacement — without that, the same conversation would be listed twice. The fold was decided on the title alone, and a title is considered reliable when it comes from VS Code's own session cache — which keeps its entries forever, long after the tab is closed. Two different tasks that had been given the same short name were therefore taken for one: the older conversation disappeared from the list, and any batch task pointing at it started reading the other conversation's state instead. A fold now also requires that both conversations opened with the same first message — exactly what a resume replays. When only one of the two can be read, nothing changes.
- **A batch is never left as a bare header with nothing under it.** There is only one row per conversation, so when two batches ended up pointing at the same one, whichever was drawn last took the row and the other kept an empty, invisible slot: a batch header alone on screen, with no way to dismiss it. The claim is now settled before anything is drawn — the batch actually linked to that conversation keeps the row, and the other shows its task's pending line, prompt included. A batch head whose conversation is already displayed as another batch's task falls back to its saved title in the same way, instead of an empty capsule.

## [2.80.0] - 2026-08-27

### Fixed
- **A conversation finishing in the background no longer steals the highlight from the tab you're reading.** When a background conversation ended its turn, VS Code's tab mirror flipped its "active tab" onto that conversation about a fifth of a second later — the window focused, the screen unchanged — and stayed there for minutes. The event carrying that flip looks exactly like the one a real click produces, so it was taken as proof and the highlight moved. Now, a conversation that has just changed state puts its own tab under a short quarantine: during that window, an activation naming it is no longer proof, and a flip already adopted is undone if the state change turns out to have caused it. Clicking a conversation that just finished still highlights it immediately, and so does typing in it; past the window, an ordinary click works as before. The worst case is a brief delay before the highlight follows, never a refusal.

## [2.79.0] - 2026-08-27

### Fixed
- **The tab highlight no longer locks onto a background window's activation that never actually happened.** An activation reported for a window other than the one you're looking at (relayed to it, or carried by a stale/synthetic message) could be mistaken for a frozen tab mirror and hold the highlight there indefinitely. Only an activation confirmed as a genuine click now gets that indefinite hold; an unconfirmed one now expires after the same short delay and falls back to the last proven tab instead.

### Added
- More of the highlight's decision path is now journaled (which activation was posted, by which window, whether it was confirmed) — pure observability, nothing renders differently; it exists so the next highlight report can be read from a file instead of reproduced live.

## [2.78.5] - 2026-08-27

### Fixed
- **A nested batch's capsule now closes flush, not offset.** 2.78.3 tinted the row that hosts a nested batch to match its grip, but the grip itself still shifted its whole box 28px right to show the nesting — so on a narrow panel the two backgrounds visibly started at different x positions instead of meeting cleanly. The grip's box is full-width again, like the row underneath; only its chevron and label are pushed in by padding. Both backgrounds now start at the same edge.

## [2.78.4] - 2026-08-27

### Changed
- The red intent-mismatch badge ("asked sonnet - medium") no longer takes a line of its own: it sits on the meta line, right of the model actually used, and shrinks with an ellipsis on narrow panels - the ctx% stays right-aligned.

## [2.78.3] - 2026-08-27

### Fixed
- **A nested batch's capsule now closes at the bottom, like a root batch's does.** A root batch with a master conversation reads as one continuous tinted capsule — its grip and its master row share the same background. A nested batch only had its grip tinted: the row underneath (the parent's own conversation that serves as the child's head) stayed on bare background, an "open bottom" left over from a border that was removed in 2026-08-17 without the tint pass that later gave the grip its own background. That row now gets the same treatment — the child's tint colour, rounded bottom corners — closing the seam.

## [2.78.2] - 2026-08-27

### Fixed
- **The launch-mismatch badge no longer nags about a setting you changed yourself.** It compares what a batch asked for at launch to the model/effort of the last turn actually played, but that intent was never let go once it had done its job: change the conversation's own model/effort picker later on (nothing QuotaSaver controls) and every following turn kept getting flagged "⚠ asked …" against the original launch choice, even though the launch had honoured it for as long as it ran and the later change was entirely deliberate. The intent is now retired the moment it is confirmed — the first time the real turn matches what was asked — so a manual change afterwards is read as the new intention it is, not a broken promise.

### Added
- **The model · effort line now says, on hover, what it actually is.** It reads the last turn *really played* from the transcript, while the conversation's own selector already shows what the *next* turn will use — the same snapshot-vs-running-total split the panel already draws between `ctx` and the dollar cost, just never spelled out for this one. A tooltip now says so directly, so a selector that has moved on no longer reads as this panel being wrong.

## [2.78.1] - 2026-08-27

### Fixed
- **The busy spinner on the selected row is easy to see again.** The 2026-08-26 contrast pass made the spinner's track opaque enough to stay visible on the saturated selection background, but the moving arc used that same pale colour — so the two blended together and the spin barely read as motion. The arc now uses the row's own guaranteed-contrast text colour (lightly tinted blue), independent from the track.

## [2.78.0] - 2026-08-27

### Changed
- **In auto mode, wave separators are no longer clickable — at all.** The next wave's divider used to stay clickable even in auto, dimmed, as a way to jump the queue with a confirmation dialog; a wave stuck on an interrupted task even kept a full-colour escape hatch, clickable without confirmation. Both are gone. In auto a divider now only ever reads "wave n" or "wave n — queued", never anything else, whichever wave it is and however blocked it is — the only door left to open a wave by hand is flipping the batch's switch to manual, where the **▶ wave n** button keeps working exactly as it did in 2.73.0. The blocked-wave banners follow: in auto they now state only the remedy — reconnect the tab or Relaunch, or that an interrupted task will not finish on its own — and no longer mention ▶ or a suspended auto-advance, since neither exists to point at any more.

## [2.77.2] - 2026-08-27

### Fixed
- **No user-facing change** — three render-bench assertions had gone stale against the 2026-08-26 contrast pass and were failing on a real combination (a busy conversation that is also the active tab, inside a batch): the spinner arc is deliberately softened with `color-mix` for readability on the saturated selection background, and its ring's background deliberately tracks the row's own paint instead of the panel's, both already measured and passed by `audit-contraste.js`. The three checks were rewritten to prove that same behaviour by pixels instead of asserting the pre-2026-08-26 colours; nothing in `panel.js` changed.

## [2.77.1] - 2026-08-27

### Added
- **A queued task's wave number is now a menu of destinations.** On a task that has not started yet, its wave reads **wave n ▾** and opens a list: every wave still in the queue, the current one marked "(here)" and not clickable, plus "new wave at the end". One click sends the task there. It replaces the ◂ / ▸ arrows that used to sit in the same spot: those moved by one *step* — a task alone in its wave merged into the neighbouring one, a task sharing its wave detached into a brand-new one — which is a sound gesture but an indirect one. It took as many clicks as there were waves to cross, and the same click did different things depending on who shared the starting wave, so no number of clicks could ever mean "go to wave 4". A destination is now named rather than walked to. Wave numbering stays contiguous throughout: a wave emptied by a move disappears and the following ones close up, so a batch never shows a gap.

### Changed
- **The "+ this wave" and "+ new wave" lines light up as soon as there is a prompt to drop.** They already existed, one per queued wave, right under that wave's tasks — but they only revealed themselves on hover, so they were found by accident, and "+ new wave" ended up being used as the only door: the task landed in the last wave and then had to be walked back up, one click per wave. They now take the theme's action colour the moment a task is typed into the form, dashed rule turning solid, so the places a prompt can land are visible at a glance instead of being hunted for. Nothing else about them changed — same clicks, same rules, still never on a wave that has already started. They go back to being quiet when the field is empty: a full-colour target with nothing to drop on it would be a button that lies. **Typing no longer shifts the form under your cursor**: those lines sit above the form, so lighting them up used to push everything below them down, and the whole panel appeared to scroll away at the first keystroke. The panel now gives back to the scroll exactly what the layout takes, so the prompt field stays put on screen and it is the content above that slides.


## [2.75.0] - 2026-08-26

### Fixed
- **Stillborn wave links now heal themselves - and mostly stop happening.** Launching a wave right after a window reload could bind the task to a CLI that the restore storm kills and replaces seconds later, under the same tab: the pasted prompt looked fine on screen, yet the panel said "link lost before sending" and the batch stalled until a human pressed Enter (measured: launch at activation+15 s, linked CLI dead and replaced ~3 s later). Two changes: (1) auto wave launches wait out a 60 s activation grace after a reload, so the storm passes before anything irreversible starts - the manual button stays immediate; (2) a new stage 1bis re-links the orphan automatically: the only live, unlinked, transcript-less workspace session born within the launch window is the dead CLI's heir under the same tab (any ambiguity means no action, as everywhere in attach.js). The row then truthfully reads "not sent yet - press Enter in its tab" instead of a lost link whose "Relaunch" would open a duplicate tab.

## [2.74.0] - 2026-08-26

### Fixed
- **The highlighted row now always matches the tab you actually see selected.** VS Code's tab mirror (`window.tabGroups`) can silently move its `activeTab` onto a background conversation at the exact moment that conversation finishes a turn - window focused, screen unchanged (journal-proven: the mirror flipped and STAYED wrong for 159 s while the user's real tab never moved). The 2026-08-23 quarantine only guarded unfocused windows, and any mechanical tab/group event re-armed its trust within milliseconds. New rule, focus-independent: a highlight switch is only adopted with proof - a tab event whose payload carries a conversation tab turning `isActive`, a real active-group change, a panel row click, or a remembered tab that no longer exists (closed/renamed). Unproven divergences are served from memory (`source: held`) and journaled as `tabs-flip-held`, so if a phantom ever finds a new door, the journal names it.

## [2.73.0] - 2026-08-26

### Added
- **Each batch now carries a manual / auto switch on its header.** Wave chaining used to be one global behaviour for every batch — always on until 2.72.0, then removed outright. Neither is right: some batches are meant to unroll on their own, others are watched step by step, and both can be open at the same time. The switch sits in the middle of the batch header, `MANUAL` on the left and `AUTO` on the right, the active word in full colour; it belongs to the batch, is stored with it, and survives a window reload. A brand-new batch starts in **auto**, which is the behaviour every previous version had.
- **In manual, nothing opens by itself, ever.** The **▶ wave n** button appears only once the current wave has finished — before that the next wave keeps its plain "queued" divider, so there is nothing to click and nothing to decide. When it does appear it is in the theme's action colour with a halo, and clicking it launches the wave immediately: no confirmation, because in manual mode the click *is* the deliberate act. (The one exception, so a batch can never be stuck: a wave holding a task that will never finish on its own gets the button too.)

### Fixed
- **Auto chaining is back — with the guard whose absence caused it to be removed.** The panel could open several conversations at once while tabs were being closed: measured on a real workspace, seven tabs for five conversations, several of them duplicates of the same task. The cause was subtle — a member whose row has gone (tab closed, state entry expired) has no state left, and the panel *displays* it as finished. That is deliberate and stays: a doubt about a long-dead conversation must not leave a cross on screen or freeze a counter forever. But a presumption is now no longer enough to **open** anything: automatic advancement requires every task of the wave to be **provably** finished — a `done` written by a source, never inferred from silence. When the proof is missing the wave simply stays where it is, and ▶ remains available.
- **The "force it now?" confirmation only shows up in auto mode**, where clicking ▶ really does jump ahead of something that would have happened anyway. In manual there is nothing to jump ahead of, so the dialog is gone. The blocked-wave banners no longer talk about "auto advance being suspended" on a batch that was never on auto either.

## [2.72.0] - 2026-08-26

### Fixed
- **Waves no longer open conversations on their own.** Closing a tab could make the panel open one or several others: a member whose line is gone has no state left, `member-truth` counts a missing state as finished, the wave is therefore considered complete, and the next one launches. Measured on a real workspace: seven tabs for five conversations, several of them duplicates of the same task, and closed tabs coming straight back. Automatic wave advancement is removed — the play button on a wave is now the only thing that opens a batch, and it is a deliberate click. Nothing in the panel can open an editor tab without you asking for it.

## [2.71.0] - 2026-08-26

### Fixed
- **Closing a conversation's tab now always removes its line, and no click in the panel can ever open a tab again.** Two behaviours were reported together: a line that survived the tab being closed and reopened it when clicked, and — worse — the same conversation ending up with *two* VS Code tabs. Both came from `claude-vscode.editor.open`, the only official command that takes a session id: it reveals an existing panel, but when the window does not already hold that session it treats the call as a session resume and **creates one**. It was used as the primary click path, guarded by a memento of open sessions; in real use that guard was wrong often enough to reopen tabs that had just been closed and to duplicate others. The command is gone from the click path entirely, together with the "reopen" click on marked lines. The panel can now only ever *reveal* a tab that already exists — no match, no action.
- **The "to re-read" mark no longer keeps a line alive after its tab is closed.** It was introduced to stop a finished conversation from vanishing when the tab was closed too early; it is now the only thing that could put a line on screen with no tab behind it, which is exactly what made a reopen possible. The mark keeps its other effects (a marked conversation is exempt from the age filter and ranks first among candidates), but a proven-closed tab removes the line, marked or not.

## [2.70.3] - 2026-08-26

### Fixed
- **Everything on the selected row is legible again.** Painting that row in the theme's action colour made the darker elements on it fade out: the tick of a conversation you had already read (deliberately faint on the panel's own background) all but vanished, the red context percentage, the pinned-to-review marker, the ring around a batch member and the empty part of the context bar all fell below the readable threshold. The row's background is now a notch darker than the raw accent — measured, the raw dark-theme accent caps even pure white at 4.53:1, leaving no headroom for any colour at all — and every colour the row carries is lifted until it clears the WCAG threshold (4.5:1 for text, 3:1 for glyphs and bars) in **both** themes, without losing its meaning: a red still reads red. A new bench, `test/audit-contraste.js`, renders the real panel in every state the selected row can take and reports anything that falls short, so this can be checked rather than eyeballed.

## [2.70.2] - 2026-08-26

### Changed
- **The conversation you are looking at is now clearly marked in the panel.** Its row used to take the theme's *inactive* selection background — a dark grey a shade off the panel's own (`#37373d` on `#181818` in Dark Modern), which read as almost nothing on a list of a dozen rows. It now takes the theme’s **action colour** — the one its buttons use — with the text colour the theme pairs with it. That pair is the only one whose vividness every theme guarantees: the list-selection colour is not, and Light Modern sets it to #E8E8E8, another grey on a #F8F8F8 panel. Because that background is saturated, the row's colour tokens are re-derived on the selected row itself rather than in each rule that reads them: the context percentage, the cost, the context bar and the status glyph all keep their meaning (a red is still red) while staying legible on top of it, in both light and dark themes. The small disc that hides the group rail behind a member's bubble now follows the row's real background too — left as the panel's own colour, it showed up as a dark blot around the bubble as soon as the highlight got stronger.

## [2.69.0] - 2026-08-26

### Fixed
- **A conversation could vanish from the panel and reappear moments later, for no visible reason.** Two conversations whose tab labels get truncated to the same text (VS Code cuts them at a fixed width) could no longer be told apart by their labels alone, so the panel's tab-matching fell back to guessing by list order — an order that shifts between recomputes (activity, another window republishing a label) and could hand the "open" verdict to either sibling from one tick to the next, making the loser blink out and back in. The panel now resolves this by exact session identity first, using the same on-disk proof VS Code itself keeps of which sessions have a tab open in this window (introduced for the 2.68.0 click fix) — label matching only kicks in as an explicit fallback when that identity isn't available (an older VS Code build, a locked or unreadable database, a not-yet-flushed update). And when identity genuinely can't settle it, a row that's already on screen no longer disappears on a single inconclusive recompute — losing an ambiguous match has to hold for several recomputes in a row before the row is retired, so a momentary hiccup in the underlying data never reads as a real close.

## [2.68.0] - 2026-08-25

### Fixed
- **Clicking an already-open conversation now actually focuses its tab.** The panel used to find a tab by matching its displayed title against the tab's real label — a silent safety net so it would never focus the wrong conversation, but it meant any tab whose label had drifted from that title (renamed by the official extension, cf. 2026-07-22) produced a no-op click with nothing on screen to explain it. The click now targets the official extension's own `claude-vscode.editor.open(sessionId)` command, which reveals the exact panel it already tracks internally — no title comparison at all. This only fires once the panel can prove, from the same on-disk state VS Code itself persists, that the target session already has a tab open in that window; calling the command blind on a session it doesn't recognize would silently reopen it as a brand-new tab (duplicate) instead. Older versions of the official extension that don't expose the command fall back to the previous title-matching behaviour, unchanged.

## [2.67.0] - 2026-08-25

### Changed
- **The extension is now called QuotaSaver — "Wave Your Prompts for Claude Code".** The old name, *Claude Convs*, described what the panel displayed (a list of conversations) and said nothing about what it buys you: pasting one block to launch a whole batch, each task on the model it actually deserves, is what keeps a week's quota from being burned by a single oversized conversation. The name now carries that promise, and the tagline carries the mechanism. Everything visible follows — the view container title, the command palette entries (`QuotaSaver: …`), every notification, and the Marketplace listing in both English and French. **The extension identifier is unchanged** (`AnthonyDame.claude-code-quota-bar`), so this arrives as an ordinary update: nothing to uninstall, settings, groups and read receipts are all kept.

## [2.66.0] - 2026-08-25

### Added
- **A conversation no longer shows an empty line while it is being compacted.** Claude Code's `PreCompact`/`PostCompact` hooks are now installed (existing installs pick them up through the usual migration path) and set a dedicated `compacting` marker in `~/.claude/sessions-state.json`. The panel reuses the busy spinner it already had — nothing in the rendering changed. Both triggers are covered: the typed `/compact` and the automatic compaction that happens between turns without any user prompt.
- The marker never touches the entry's `state`/`since`, so the read-receipt (`ack_ts`) stays exact: once compaction ends the line goes back to precisely what it showed before.

### Fixed
- **Three nets against the eternal spinner** (same class as the 2026-08-18 incident documented in `hooks/transcript.js`): the marker is timestamped and ignored past a 10-minute cap, it is only honoured while the CLI process is alive, and the next `UserPromptSubmit` or `Stop` clears it explicitly even if `PostCompact` never fires.
- Real hook payloads verified by instrumenting the deployed hooks rather than guessing from the docs: both events carry `trigger: 'manual' | 'auto'`, a manual `/compact` fires **no** `UserPromptSubmit` and **no** `Stop`. Documented in `hooks/hook-session-state.js` and pinned by `test/test-precompact.js` (22 checks).

## [2.65.0] - 2026-08-25

### Changed
- **Marketplace/GitHub metadata catches up with the cross-platform portage (2.61.0).** `package.json` `categories` moves from `["Other"]` to `["AI", "Visualization"]`, and `keywords` gains `parallel`, `orchestration`, `multi-agent`, `batch`, `waves`, `handoff`, `status`, `claude-code` (hyphenated) alongside the existing set.
- **The "Windows-only" claim is gone from the description and the README.** The extension has been cross-platform since 2.61.0; `package.nls.json`'s short description now says "cross-platform", and the README's top note spells out the real, narrower state: window-raising stays Windows-only (no portable equivalent), sounds work on Windows and macOS and stay silent on Linux — everything else (panel, state, quota bars, batching) is plain Node with nothing OS-specific. The Requirements section already had this right; only the top summary line was stale.
- **The animated demo GIFs (added in the previous lot, never wired into the README) are now shown** — a `<picture>` element under the hero screenshot, dark/light matched to `prefers-color-scheme` like GitHub does for its own README images.
- **The public repo (`Depot404/claude-code-quota-bar`) got topics** — `claude-code`, `vscode-extension`, `ai-agents`, `developer-tools` — previously unset. Its description was already populated (not empty as assumed going in) and is left as-is.

## [2.64.0] - 2026-08-25

### Changed
- **The model/effort pickers on each task card got a redesign.** They used to be a soldered segmented control (grey text, a plain blue fill on the active choice — the same look for both rows). They're now detached pills, each carrying a small dot in its own colour: the model dot uses the same identity colour already used elsewhere in the panel (blue for Sonnet, purple for Opus, etc.), and the effort dot follows a green-to-red gradient reused from the quota bars' own low/medium/high colouring — nothing invented, both draw from the same `--vscode-charts-*`/`--pace-*` variables the rest of the panel already uses. The active pill fills solid with its colour and gets a soft halo; picking Haiku still dims and disables the effort row exactly as before. Variant chosen from a three-way mockup (`MOCKUP_selecteurs_modele_effort_2026-08-25.html`, kept out of the package).
  - The store screenshots and the two demo GIFs (dark and light) are regenerated to match.

## [2.62.0] - 2026-08-25

### Removed
- **The `claude.ai` cookie path is gone, and with it every trace of a session credential.** Until 2.61.0 the primary quota fetch read a `claude.ai` `sessionKey` cookie out of a dedicated Brave profile (spawned headless, read over CDP `Storage.getCookies`), cached it **in clear text** at `~/.claude/quota-session-key.json`, and replayed it against `claude.ai/api/organizations/{id}/usage`. It was opt-in and off by default, but Anthropic's policy is explicit that "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) — caching that cookie and replaying it is exactly *store* and *intermediate*. Since this extension is published, it also handed that capability to anyone who installed it.
  - Removed: the cookie read/refresh path, the embedded CDP client, the Brave spawn/shutdown lifecycle, the `claudeCodeQuotaBar.braveUserDataDir` setting, and the `ws` dependency — **the extension now has no runtime dependencies at all**. About 320 lines.
  - **Exactly one network call remains in the whole extension**: the OAuth `https.get` to `api.anthropic.com/api/oauth/usage`. The token is read fresh from `~/.claude/.credentials.json` at each fetch, never copied, never logged.
  - **Nothing is lost on screen.** The OAuth endpoint returns every field the panel consumes (`five_hour`, `seven_day`, and the per-model weekly `limits`), verified against it on 2026-08-25. The cookie path existed to dodge rate-limiting on that endpoint ([#31021](https://github.com/anthropics/claude-code/issues/31021), [#31637](https://github.com/anthropics/claude-code/issues/31637)); both are closed without a fix, and the endpoint answers normally today. Should it ever throttle again, the bars fall back to the cache and show its age, as they always have.
  - **If you had the path configured**, the setting is now unknown to VS Code and can be deleted from your `settings.json`; so can `~/.claude/quota-session-key.json`, `~/.claude/quota-org-id.json` and `~/.claude/quota-brave-pid.json` — nothing reads them any more. Deleting the first one is worth doing regardless: it holds a live account credential in clear text.
  - Full audit, including what each path read and what left the machine: `NOTES_exposition_auth_2026-08-25.md` in the repository.

### Fixed
- **The privacy section no longer contradicts itself.** Its first line claimed the extension reads "**only** the OAuth access token", which stopped being true the moment the cookie path was enabled. That statement is now correct by construction rather than by wording.

## [2.61.0] - 2026-08-25

### Changed
- **The three PowerShell calls in the execution path now degrade cleanly off Windows instead of assuming it.** The conversation list, state engine, quota bars and batching are already plain portable Node — only window-raising, sounds and the optional Brave cookie path ever touched PowerShell:
  - **Window-raising** (bringing a VS Code window to the front after clicking a conversation) has no portable equivalent — `raise-window.ps1` is Win32-specific (`EnumWindows`/`SetForegroundWindow`). Off Windows it's now a silent no-op logged to the console; the tab itself still gets focused inside the current window either way.
  - **Sounds** gained a macOS equivalent: `afplay` with the two system `.aiff` files that ship on every Mac, played the same way `ding.wav`/`SystemSounds.Exclamation` are on Windows. On Linux, where no audio player is guaranteed present without an extra dependency, it degrades to silence rather than spawning a binary that may not exist.
  - **The Brave Octopus spawn/kill** (opt-in, empty `braveUserDataDir` by default) now refuses outright off Windows instead of trying `brave.exe`/`taskkill`/`Get-CimInstance` paths that only make sense there — already caught by the existing fallback to OAuth, so no behaviour change on the path most installs use.
  - No visible error and no attempted spawn of an absent binary in any of the three cases.

## [2.60.2] - 2026-08-24

### Fixed
- **The cost breakdown behind a conversation's amount is reachable again.** Since pinning arrived, hovering a row fades its amount out and puts the bookmark and ⌂ buttons exactly where it was — so pointing at the figure landed on a button and showed *its* label, never the breakdown that explains the number. The estimate is the only thing on a row that needs an explanation (the colour follows the last turn while the figure shows the running total), so the row itself now carries that breakdown: hovering anywhere on it shows the amount, the number of replies, the last turn and the input/cache/output split. The two buttons keep their own label, unchanged.

## [2.60.1] - 2026-08-24

### Fixed
- **A batch could keep every one of its rows after its conversations had left the list.** The row-level fix in 2.60.0 stopped short of the batches: a member's status still asked "is its process alive?" and only knew about tab closures the panel had *watched happen* — never one made while the window was shut, never an orphaned process outliving its tab. A batch therefore stayed on screen, one member labelled "open", with no tab behind any of it. The snapshot now publishes which conversations are *proven* to have no tab — including the ones it does not list — and a member reads that fact directly. A batch whose members are all finished and closed removes itself, as it always meant to.

## [2.60.0] - 2026-08-24

### Fixed
- **A conversation whose tab is closed no longer keeps its row.** The panel already meant to list what you have open, but three separate escape hatches could keep a row alive with no tab behind it: a running CLI process was taken as proof that its tab was open, a conversation the hooks still believed busy was kept "just in case", and a conversation without an AI-generated title could never be concluded closed at all — its row was, in practice, immortal. All three existed to cover the same honest case: *we cannot know yet*. They now stop at the point where we can. As soon as the editor's own session table publishes a tab title for a conversation, finding no open tab under that name is a proof of closure rather than an absence of information, and the row goes — process alive or not, hooks or no hooks, fallback title or not. Closing a tab does not always kill its background process (measured: one still running sixteen hours later, in a window that had never been reloaded and no longer showed a single conversation tab), which is what made the first hatch quietly wrong.
- Conversations pinned "to review" are unaffected, by design: a pin is an instruction from you, not a missing proof, and it remains the one reason a row outlives its tab.
- **The session table no longer forgets what it knew on a single bad read.** That store is read straight from the editor's own database while the editor is writing to it, and a read can come back with zero rows and no error at all — observed on a live workspace: 369 entries, then 0, then 369 again, minutes apart. Adopting that zero wiped the only identity proof the panel has, so every row without a tab reappeared until the next good read. A read that returns nothing where something was known is now treated as the failed read it is: the last known table stands, and the next refresh genuinely re-reads.
- The failure mode stays safe. If the session table goes silent — the shape of that store is undocumented and has changed under us before — nothing is considered published, all three fallbacks resume their old role, and no row disappears that would not have disappeared before.

## [2.59.0] - 2026-08-23

### Added
- **Pin a conversation "to review".** Hovering a row reveals a small bookmark button next to ⌂; clicking it marks the conversation, and a bookmark then sits in front of its title for as long as it stays pinned. Pose and lift are entirely manual — nothing pins or unpins on your behalf, no read state, no age, no heuristic — because the point is precisely to survive the moment you'd otherwise close the tab thinking the work is done. A pinned conversation whose tab closes (or whose transcript ages out) stays in the list instead of disappearing: struck through, tagged "tab closed", and clicking it reopens the conversation instead of trying to focus a tab that no longer exists. It costs a row — a pinned, closed conversation still occupies one of the list's slots, behind every conversation with a tab still open — a deliberate trade for not losing it. See [Pinning a conversation "to review"](README.md#pinning-a-conversation-to-review).

## [2.58.0] - 2026-08-22

### Changed
- **A row that is both a member of a batch and the head of a nested sub-batch now wears both roles on its bubble.** That bubble used to be painted entirely in the parent batch's colour, at the size of a batch head: nothing on the row itself said which sub-batch it opened, and nothing said it was still an ordinary member of the batch above. It is now split down the middle, each half drawn at the canon of the role it stands for — the left half in the parent batch's hue, at the exact size and weight of a member's ring; the right half in the sub-batch's hue, at the size and weight of a head. The two halves therefore differ in both thickness and radius, and they overlap by 10 degrees across the axis, because meeting end to end left an open seam at twelve and six o'clock. Root batch heads — one role, one colour — are untouched.
- **Member rings are slightly larger: 16px across becomes 18px.** It is the same canon the split bubble's left half uses, so the two cannot be allowed to drift apart; it applies to every member row and every queued row inside a batch.

### Fixed
- The opaque disc that punches the batch rail where it crosses a row now follows the bubble's real shape instead of assuming a single radius. On a split bubble the parent's rail used to vanish several pixels before reaching its own arc, stopping in mid-air; it now runs right up to it, and the seam where the two halves meet no longer lets a hair of the rail show through the middle of the bubble.

## [2.57.1] - 2026-08-22

### Fixed
- **A finished conversation could show a ~5 min spinner right after a window reload.** When a reload kills a background task, the harness delivers a `<task-notification>` with status `stopped` to the respawned CLI as a regular user message. That delivery is bookkeeping — the model is never re-invoked after it — yet the engine counted it as fresh conversational activity and concluded the conversation had resumed. Delivery is now distinguished from resumption: a `stopped` notification no longer counts as activity, while `completed`/`failed` notifications still do (they announce a real resumption, and treating them as silence would briefly mis-report a working batch as done).

## [2.57.0] - 2026-08-22

### Fixed
- **Moving the last conversation out of a wave destroyed that wave with no way back, and no gesture could create a wave at the end of the queue.** The ◂ / ▸ arrows on a queued row moved the wave *number* by one and required the destination wave to already hold someone — so a wave emptied by the move simply ceased to exist: the ◂ stayed on screen but the move was refused in silence, and the ▸ was hidden outright on the last wave, there being nothing after it. A wave is now a **position**, not a fixed number: wave numbering is always contiguous, and one click is one step. A row **alone** in its wave merges into the neighbouring wave (its own wave disappears); a row that **shares** its wave detaches into a brand-new wave, just before or just after its neighbours — and that is the gesture that creates a wave, including past the end of the queue. The two are exact inverses, so the opposite arrow always undoes the previous click, which "+1 / −1" could not do (a merge was one-way). Numbering is repaired on read as well, so a batch already holed by the old behaviour heals itself.

### Changed
- The arrows offered on a row now mirror exactly what the batch engine accepts. The ▸ appears on the last wave whenever the row has company there; the ◂ appears on a row that shares its wave even when the previous wave has already started, because that row detaches ahead of its neighbours instead of joining a wave that is gone. A row alone in its wave keeps the old, stricter rules — it can only merge, so it needs a neighbouring wave that exists and has not started.

## [2.56.0] - 2026-08-22

### Changed
- **A row that is both a member of a batch and the head of a nested sub-batch now wears both colors on its head ring** — left half in the parent batch's hue, right half in its own sub-batch's hue. Until now that ring was painted entirely in the parent's color, so nothing on the row itself said "this one opens the sub-batch below" beyond the indented grip; the split ring makes the double role legible at a glance, and its color pair matches what the rails already say (parent rail above, child rail threading the indented members below). Root batch heads — one role, one color — are untouched. Technically the ring had to move from a CSS border (single color by nature) to a painted disk: a two-color conic under an opaque center that still punches the parent rail crossing the row, with the gradient geometry computed on the border box (the default padding-box sizing would tile the gradients under the ring).

## [2.55.0] - 2026-08-21

### Fixed
- **The highlighted row could stop following the selected tab, most noticeably right after switching back to the window.** Clicking a row tells the panel "this tab is now active" without waiting for VS Code to confirm it — a safeguard for the case where the window's tab mirror has stopped responding altogether, where that click is the only truth left. That remembered act was recorded on every click, including the very common one where the tab was *already* the active one; and an activation that changes nothing produces no tab event, so nothing could ever supersede it. It then outranked the live reading on every refresh, indefinitely, on a perfectly healthy window — cancelling the self-correction that is supposed to put the highlight straight on its own. The symptom surfaced when returning to the window after an alt-tab, precisely when you look at the panel, and it did not heal by itself: clicking the correct row only recorded one more act. The remembered act is now only recorded when it actually disagrees with what the API reports, and it only outranks the live reading while it is still awaiting confirmation or the window is known to be frozen. Frozen-window behaviour is unchanged.

- **A finished conversation could keep its working spinner on screen for many minutes — because the panel itself had silently stopped receiving updates.** The panel is push-only: the extension posts a state on every change, and nothing ever proved to the webview that this feed was still alive. On a VS Code window left open for 25+ hours, the host→webview channel froze (the same RPC freeze the extension already detects on the tabs API); the engine knew the conversation was done within seconds, but the webview kept painting the last state it had — and a CSS spinner animates locally, forever, so the stale state didn't just linger, it actively claimed work was in progress. The webview now watches its own feed: while visible, 60 s without a state makes it re-request one (the upward direction demonstrably survives these freezes — clicks still went through during the incident, so this alone repairs the display); three minutes without an answer and it says so — a banner, and every animation paused by one rule, because a spinner may never claim activity the panel cannot prove. Any state received clears everything instantly. Coming back to the panel also requests a fresh state on the spot — precisely the moment you look.
- **Two conversations whose titles collide within the tab label's 24 characters no longer fight over the same tab.** Tab↔conversation matching used to be decided row by row, each conversation matching labels on its own — so twins could both claim one tab (double highlight, wrong click target) or a closed one could keep a live one's tab. One bijective pairing is now computed per snapshot: unambiguous resolutions cascade first (a label only one conversation can take, and vice versa), and only what remains genuinely ambiguous is grouped and marked as such. Presence, highlight and click all read that single pairing.
- **When the ambiguity is genuinely unresolvable — k conversations sharing one truncated title against k identical tabs — the panel now says so instead of guessing.** Affected rows carry a discreet ≈ sign with a tooltip (renaming or closing one would settle it); the highlight stays silent on them, unless the session identity recorded at your last prompt designates one of the twins for real.

### Added
- Highlight decisions are journaled (`highlight-verdict` lines in the existing ack journal, on verdict *changes* only): which label was active, which conversation matched, through which path, frozen or not. Pure observability — no rendering depends on it; it exists so the next "the highlight is on the wrong row" report can be read from a file instead of reproduced live.

## [2.54.0] - 2026-08-20

### Fixed
- **Rows for conversations whose tab was long gone could never leave the list, and nothing on screen could remove them.** They rendered struck through — the panel's way of saying "finished, tab closed" — while refusing to act on that same conclusion, and they came back every time a slot freed up, each one eating one of the twelve places a live conversation could have used. Two independent failures stacked up. First, VS Code's per-session tab record is keyed by a URI scheme that changed under us (`agent-host-claude:/` where it used to be `claude-code:/`); a single hard-coded prefix made the whole table unreadable **without raising anything** — hundreds of entries present, none retained. That table is the only proof of an open tab that does not depend on matching titles, so losing it left conversations without an AI-generated title with no way of ever being recognised as closed: their title falls back to the first prompt, which never matches a tab label, and the presence filter correctly refuses to conclude anything from a mismatch it knows to be meaningless. All known schemes are now accepted, oldest kept alongside newest — a workspace that hasn't been reopened in months still carries the old one.
- **Second, a session's hook record kept those rows alive indefinitely.** `updated_at` timestamps the *record*, not the conversation, and it can be refreshed long after a conversation last wrote anything; a recent record exempted the session from the staleness filter by two separate paths — the transcript loop's own condition, and a re-admission further down by the loop that picks up sessions the first one never saw. "Not seen" and "deliberately skipped" are now distinguished, so the second loop keeps its purpose (a conversation whose transcript does not exist yet, at the very first prompt) without silently undoing the first one's decision.

## [2.53.1] - 2026-08-20

### Fixed
- **A conversation could get a title that never matched its tab, making its row unclickable.** Titles fall back to a session's first human message when there's no AI-generated title yet, but that lookup only read the first 32KB of the transcript file — on a conversation whose very first turn already carries a large embedded session context (a few hundred KB is normal), that cut the first line off mid-JSON, made it unparseable, and silently fell through to the *last* prompt instead. The tab label, set once at the start, never moves — so the panel row drifted to a different title than its tab and clicking it stopped doing anything. The lookup now reads the transcript line by line (bounded to 2MB) instead of a fixed byte window, so a line is either read whole or not at all.

## [2.53.0] - 2026-08-20

### Added
- **A persistent daily cost history now builds itself quietly in the background.** The per-turn and per-conversation cost figures the panel already showed were never kept anywhere once the number scrolled off screen or the window closed — the running quota-window totals cost.js computes are capped at 7 days by design. `~/.claude/quotabar-cost-daily.json` now accumulates one entry per calendar day (total, message count, per-model breakdown), rebuilt from local transcripts the first time it runs — so it backfills whatever history is already on disk, not just what happens from today on. It updates at most once per day (piggybacking on the existing `UserPromptSubmit` hook, gated so the full rescan — cheap, but not free — never runs more than once a day), and it's purely a data log for now: no view in the panel, just the raw material for whatever cost-optimization analysis someone wants to do with it later. Weekly/monthly totals aren't stored — they're plain sums over the daily file (`weeklyTotals`/`monthlyTotals` in `hooks/cost-history.js`), always available on demand.

## [2.52.0] - 2026-08-19

### Added
- **A new, optional walkthrough step teaches Claude *when* to split work into batches — not just how to format one.** `/handoffs` (step 3) only turns an already-made decision into a pasteable block; nothing told Claude's own judgment to offer that split in the first place, so left alone it would work every request in one conversation, on whichever model happened to be active, no matter how mechanical part of it was. Accepting the new step drops a short, extension-maintained note (`~/.claude/claude-convs-batching.md`) and adds a single `@claude-convs-batching.md` line to your personal `~/.claude/CLAUDE.md` — a relative import (see Claude Code's own memory docs), so nothing machine-specific ever gets written to a file you version or share. The note itself ships with two guardrails: only offer a split when it's real (independent parts, or a chain where a later step needs an earlier one), and a single focused task stays a single conversation — without them Claude would offer to batch a typo fix.
- **Never signed without reading it first.** Accepting is a dialog separate from the required hooks step — same status difference as the walkthrough itself marks it ("optional, recommended") — and it shows the exact paragraph that will be imported into every future conversation before asking, not just the technical line that pulls it in. A one-click **Install Hooks** now offers this as a *second*, distinct question right after hooks finish installing, at most once per machine; declining leaves nothing written and is remembered so it won't ask again on its own, but the **Claude Convs: Add Batching Philosophy to CLAUDE.md** command stays available any time for anyone who changes their mind. Re-running the hooks installer (or accepting from the walkthrough/Command Palette) re-deploys the note itself every time — like the hooks, it's a file the extension owns, so a future version improves it for everyone without anyone re-pasting anything.

## [2.51.0] - 2026-08-19

### Added
- **A native walkthrough now opens the first time the extension starts**, in place of the two things a fresh install used to leave a person to find on their own: an unmissable-but-easy-to-miss banner (2.50.0, only visible once the panel is actually open) and a Command Palette entry only findable by already knowing its name. Three steps, ordered by what they unlock: **finish setup** (one button — the same installer as the banner and the Palette command, hooks and `/handoffs` together, marked required); **launch several conversations at once** by pasting a `claude-convs` block into the New conversation form (nothing to install — it's the reason the extension exists); and **`/handoffs`** itself, which was already installed by step one and just needs typing. Steps check themselves off on their own: the two context keys published in 2.50.0 drive the first and third, the panel-opening command drives the second — so reopening the walkthrough after setup shows it already done, nothing to click to prove it. VS Code opens a newly-installed extension's walkthrough by itself (`workbench.welcomePage.walkthroughs.openOnInstall`, on by default); nothing here had to trigger that.
- The `/handoffs` step spells out that it's a *file* the installer drops in place, not something to write anywhere yourself — a distinction worth stating plainly, since the two are easy to conflate and only one of them is a step in this walkthrough.

## [2.50.0] - 2026-08-19

### Added
- **A banner now says so when a fresh install has not deployed the hooks yet.** Installed from the Marketplace, the panel wrote nothing to `~/.claude/` on its own — every conversation just sat there with a blank status icon, no sound, no per-turn cost, and nothing on screen ever explained why. The panel already knew how to detect this (it warned before turning sounds on), but a warning only shown on that one path meant most people never saw it. A banner at the top of the conversation list now names exactly what is off — status icons, sounds, per-turn cost — with an **Install hooks** button that runs the same one-click installer as the Command Palette command, then offers the usual reload. It checks the `/handoffs` command separately from the hooks (a machine can be missing one without the other) and says which one is missing. It cannot be dismissed — a × here would recreate the exact silence this fixes — and it disappears on its own the moment both are in place, no reload required to see it go.
- The two checks are also published as VS Code context keys (`claudeCodeQuotaBar.hooksInstalled` / `claudeCodeQuotaBar.handoffsInstalled`, via `setContext`), ahead of a native walkthrough that will use them to check its own steps off.

### Removed
- **The "copy an instruction for your CLAUDE.md" tip is gone — the `/handoffs` command replaces it.** Both did the same thing (make Claude end its planning with a pasteable `claude-convs` block), and having two ways to ask for it — one a standing CLAUDE.md instruction, the other typed per occasion — was confusing rather than helpful. Only the slash command remains.

## [2.49.0] - 2026-08-19

### Fixed
- **"Install Hooks" now actually works on macOS and Linux.** The command deployed the hooks by launching `powershell.exe` — which only exists on Windows, so on any other platform the button did nothing but fail, silently as far as the rest of the panel was concerned, for an extension published on the Marketplace for everyone. The installer is now plain Node, run directly by the extension itself: no external process, no PowerShell dependency, same one confirmation dialog, same one click. `install.ps1` still exists for anyone who wants to deploy the hooks by hand or from a script — it just isn't what the button runs anymore.
- **Nothing about what gets written changed.** Same files copied to `~/.claude/scripts/`, same `/handoffs` command, same `~/.claude/settings.json` wiring (a timestamped backup before any edit, only the missing `statusLine`/hook entries added, existing entries and any unrelated hook groups left untouched) — this is a rewrite of *how* it runs, not of what it does.
- **A `settings.json` the installer can't parse is now left completely alone.** It is your file, hand-edited over time; overwriting a JSON syntax error you were about to fix yourself would be worse than doing nothing. The installer now stops before writing anything and says exactly what to do (fix or rename the file, then retry) rather than guessing.

## [2.48.1] - 2026-08-19

### Fixed
- **The conversation list was permanently empty on a great many machines.** Claude Code stores each workspace's transcripts in a folder under `~/.claude/projects/` whose name is derived from the workspace path, and the panel has to derive that same name to find them. It only replaced path separators and spaces, where Claude Code replaces **every** non-alphanumeric character — so a single `_`, `.`, accent, apostrophe, parenthesis or `&` anywhere in the path sent the panel looking into a folder that does not exist. The result was a panel that stayed empty forever, with no error and no clue, while Claude tabs sat open right next to it. If the character was in the Windows account name (`C:\Users\jane.doe\…`), it applied to every workspace on the machine at once. The derivation now matches Claude Code's exactly, verified against a real CLI rather than assumed.
- Nothing changes for a workspace that was already working, and there is nothing to migrate or re-open: the panel simply reads the folder that was there all along. If the list was empty for this reason, it fills up on the next window reload.

## [2.48.0] - 2026-08-18

### Changed
- **A batch whose tasks are all finished and closed now disappears, even when the conversation that launched it is still open.** Until now the batch also waited for its master conversation to be finished and its tab closed — but that conversation is the one you work from, so it is almost never closed, and a batch you were done with kept its capsule on screen and kept its master pinned as a batch header for good (nothing purges a group whose master is still listed). A batch exists for its tasks: once every one of them is finished with its tab closed, the whole block leaves the panel and the conversation that launched it goes back to being an ordinary row in the list. Nothing is written, closed or interrupted — only the grouping stops being drawn.
- **Unfinished work still holds the batch, on purpose.** A task that was interrupted, or one whose prompt never got sent — the case where reloading the window clears the inserted prompt — keeps its row, and with it its ▶ Relaunch. Closing a tab is not what retires a batch; finishing the work is.

## [2.47.2] - 2026-08-18

### Fixed
- **Second half of the same rule: an open tab now also wins a place in the list.** 2.47.1 stopped the list from dropping a conversation whose tab is still open, but the list is capped at twelve rows, and that cap was filled in order of "most recently written" — so twelve fresher conversations could still evict the one you have open, and everything the hierarchy infers from a conversation being listed fell over with it (a master line struck through, a member's row vanishing from its wave, a nested batch detaching from its parent). Conversations with an open tab are now picked first, freshest-first among themselves; the cap and the display order are unchanged. With no tab store available, everything stays exactly as before.

## [2.47.1] - 2026-08-18

### Fixed
- **A conversation whose tab was still open could be struck through as "done · closed".** The panel drops a conversation from its list once nothing has been written to it for four hours and its CLI process is gone — a sensible rule for the list itself, but one the rest of the extension reads as *proof*: a group's master line renders struck through, and a wave member's row disappears altogether, purely because the conversation is not listed (`member-truth.js` concludes `done-closed` from it). Four hours after a batch was launched, the conversation that framed it — finished overnight, its process shut down, but its tab wide open on screen — was therefore crossed out as though its tab had been closed. A conversation whose tab is provably still open is now kept in the list whatever its age: VS Code's own session→tab-label store, crossed with the tabs actually open, proves it without reading a single transcript. Either source missing degrades to the previous behaviour, never to more hiding. Worth knowing: an old conversation you keep a tab open for now takes one of the list's slots again.

## [2.47.0] - 2026-08-18

### Added
- **When a turn gets expensive, Claude now offers to hand the work over to a fresh conversation.** Colouring the row (2.46.0) tells you the next reply will be costly, but only if you happen to be looking at the panel — and the moment that matters is the one where you're typing. So once the last completed turn crosses `relayNoticeDollars` (default $5), the `UserPromptSubmit` hook adds three lines to that turn's context: what the last turn cost, and a request that Claude **offer** — never decide on its own — to commit what's done and continue in a new conversation, handing over with a `claude-convs` block you can paste straight into the panel's batch launcher. You stay in charge of the switch; you just stop having to notice the right moment yourself. Set the setting to `0` to turn the notice off.
- **Never on a young conversation, and once per conversation, ever.** The notice waits until it has observed at least two complete turns: an expensive turn early on is usually one big tool call over a still-small context, and offering to hand over there would save nothing while teaching you to ignore the message. The threshold is its own setting rather than the one that colours the row ($2), because a colour is a passive signal and a notice interrupts — measured on the machine this was built on, $2 per turn would have fired on three working conversations out of four. A reminder repeated on every prompt would burn exactly the context it exists to save. The marker is persisted (`~/.claude/quotabar-turns/`) and survives window reloads.
- The hook reads **only its own conversation's transcript**, incrementally, keeping the byte offset between prompts: 8 ms on the first prompt of a 20 MB resumed conversation (only the tail is parsed), 1–2 ms afterwards. It never scans the transcript folder, sends nothing anywhere, and is wrapped end to end — a missing transcript, an unreadable state file or an unparsable `settings.json` all resolve to silence, never to a failed prompt. It reuses the same price list and the same turn definition as the panel (`cost.js`), so a figure quoted in the chat and a colour shown in the sidebar can never disagree.
- Requires the hooks to be installed (**Claude Convs: Install Hooks**, or `install.ps1`); re-run it after updating, since the hooks that run are the deployed copies.

## [2.46.0] - 2026-08-18

### Changed
- **A conversation row's amount now colors by the cost of its LAST completed turn, not its running total.** The total shown never changes — it is still the full-conversation cumulative estimate — but the color behind it used to answer "has this been expensive so far?", a question you can no longer act on once it's true. It now answers "is the next reply likely to be expensive?": a turn is everything the assistant did between two of your prompts, and the color only ever reflects the most recent one that actually finished (a turn still in progress is never colored, so the row does not flicker while you're mid-task). The two settings governing conversation-total color (`costYellowDollars`/`costRedDollars`) still exist but no longer color anything; two new ones, `costTurnYellowDollars` (default $0.50) and `costTurnRedDollars` (default $2.00), take over — set an order of magnitude below the total thresholds, since a single turn on this machine has ranged from $0.03 to $27.20. Hovering the amount now always shows the reply count and last-turn cost alongside the usual input/cache/output breakdown once at least one turn has completed, since a color that no longer matches the number next to it needs the explanation more than ever.

## [2.45.0] - 2026-08-18

### Added
- **Every quota window now shows what actually filled it, in dollars** — on its top line, between the label and the percentage. The percentage says how much of a window is gone; it never said what went into it. The amount is measured over the window's exact period (its reset time minus its length) across **every** Claude Code transcript on the machine, not just the conversations the panel happens to be listing: a quota window is account-wide, so the figure has to be too. A model-scoped weekly window counts only that family's messages, and shows nothing at all rather than a misleading zero when it cannot tell which family a scope refers to.
- Same convention as a conversation row: `≈` marks the estimate, and hovering carries the two caveats the line itself must not — the measurement is local (Claude Code on this PC, so whatever goes through claude.ai or the mobile app counts toward the percentage but not toward this amount), and it is the value of that usage at API list prices, something a subscription covers rather than a spend. Above $100 the figure rounds to the dollar: two decimals on four digits, in a 300 px sidebar, are noise.
- Reading it costs no tokens and no network call, and reuses the accumulator that already prices each conversation — the same bytes are never parsed twice. The first full pass over the transcript folder is deferred until the panel is actually **visible**, and only then: a window whose panel stays closed reads nothing, which matters when several VS Code windows are open at once. Later passes are incremental and take a few milliseconds.

## [2.44.2] - 2026-08-18

### Fixed
- **The spinner could still stay on forever — second cause, found the same evening.** A live, finished conversation shows a spinner when the transcript proves it is about to resume on its own: every background launch is paired with its completion notification. 2.44.0 taught that pairing to survive window reloads, but the notification itself was only recognized in the one shape observed until then — a user-turn message, which is how it lands when the task finishes while the conversation is *idle*. When the task finishes *mid-turn*, the CLI delivers it through its message queue instead (`queue-operation`, then an `attachment` marked `task-notification`) — entries the detector never read. The launch stayed visible, the completion invisible: half of the pair broke alone, and the row spun forever on a conversation that had long answered. All three delivery shapes are now recognized, and a notification merely *quoted* somewhere (a grep, a pasted prompt mentioning the tags) still extinguishes nothing.

## [2.44.1] - 2026-08-18

### Fixed
- **"1 conversation not sent yet — press Enter in its tab." could stay on screen long after that tab had started.** The banner is recomputed on every refresh from what is actually true — a tab still open with nothing sent — but the sentence produced at launch time was also kept as a fallback, and that copy was frozen. The moment the batch it described went away (its group dissolved, or no session left to recount), the recompute fell back to that frozen sentence, and the panel went on prescribing an Enter press for a conversation that had answered hours earlier. The fallback now carries only what no recompute could reproduce — tasks that were never identified, a batch that stopped part-way: a stale statement of fact goes quiet, where a stale instruction sends you hunting for a tab that no longer exists.

## [2.44.0] - 2026-08-18

### Changed
- **The listing now opens on how to actually see the panel.** The panel docks in VS Code's Secondary Side Bar, which is open by default on a folder but hidden in an empty window — and stays hidden once you close it, at which point installing the extension appears to do nothing at all. What used to be a troubleshooting note halfway down the README is now its first section: a three-step walkthrough with the keyboard shortcut (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd>) and the Command Palette entry, not just the menu path, and it no longer claims there is always an icon to click — when Claude Convs is the only panel docked there, it simply *is* the sidebar.

### Fixed
- **A finished conversation could spin forever after a window reload.** Reloading VS Code kills every CLI process; when one had a background agent or a `run_in_background` command still outstanding at that moment, its notification could never arrive — yet the row kept reading that as "about to resume on its own" and stayed busy for good, since nothing was ever going to write to the transcript again. A pending background launch or a scheduled wakeup now only counts as a reason to stay busy when it's newer than the currently running CLI process — one it could actually still hear back from. Anything older is a leftover from a process the reload already ended.

## [2.43.0] - 2026-08-18

### Added
- **Each conversation row now shows what it has cost, in dollars, since it started** — to the right of its title, next to the `ctx:%` that only ever said how full the context is *right now*. A conversation sitting at 20% after three compactions has spent far more than one at 70% opened ten minutes ago; the amount is that missing half of the picture. Hovering it breaks the estimate down into input / cache / output.
- The figure costs **nothing to produce**: no network call and no tokens, just the `usage` data every assistant entry of the transcript already carries, priced at the public list rate of the model **of each message** (so a conversation that switched models mid-way mixes rates, as it should), with the standard cache ratios and the fast-mode rate where it applies. Transcripts run to tens of megabytes, so reading is incremental — only appended bytes are ever parsed.
- Amounts turn yellow past `$2` and red past `$5` by default (`claudeCodeQuotaBar.costYellowDollars` / `costRedDollars`), reusing the colour vocabulary of the context and quota bars. Absolute thresholds, so an amount means the same thing from one day to the next. A conversation with no usage data yet shows nothing rather than a `$0.00` that would suggest it was free, and the tooltip's `≈` marks the figure for what it is: an estimate.

## [2.42.0] - 2026-08-18

### Changed
- **A batch no longer draws a frame around itself — its head row carries the batch instead.** The tinted outline that boxed in the batch header and its master row is gone, on root batches and on nested sub-batches alike. What said "this row opens a batch" is now inside the row: a noticeably larger, thicker state bubble, the vertical rail starting from under that bubble rather than from under the whole row, and the title in bold. The tinted band stays, so a batch still reads as one block, with one line less of ink around it.

### Fixed
- **The rail no longer disappears under the row you hover or select.** A row's background is opaque and was painted over the batch's vertical line, so moving the mouse down a batch wiped the line out row by row. The rail now sits above row backgrounds and below the state bubbles, which keep punching their hole through it — an order that no longer depends on the order rows happen to be laid out in.

## [2.41.0] - 2026-08-17

### Added
- **The context bar (`ctx:%`) now turns yellow or red as a conversation fills its context window**, same red/yellow/green vocabulary as the quota bars. Coloured directly on the percentage of the window used — red at 50% by default, yellow at 40% — rather than the quota bars' burn-rate ratio, since a context window doesn't refill on a schedule the way a quota window does. Thresholds are configurable (`claudeCodeQuotaBar.ctxRedMin`/`ctxYellowMin`); the bar's length is unchanged, it still measures the margin before the wall.

## [2.40.1] - 2026-08-17

### Fixed
- **"Create" from a conversation that's already heading a live batch now joins that batch instead of starting a rival one.** Pasting a block whose framing conversation already leads a batch still in progress, then clicking Create, used to spin up a second, separate batch — and since a conversation can only visibly head one batch at a time, the new one stole the header right out from under the batch already running, which was left looking empty. The new tasks now queue onto the end of the existing batch instead, opening at the wave engine's own pace, with a short notice confirming where they landed. A batch that has already finished is untouched by this and still starts a fresh one, as before.

## [2.40.0] - 2026-08-17

### Fixed
- **The highlight now follows the row you click even when VS Code stops reporting tab changes; a small notice tells you when that happens.** VS Code keeps the extension's copy of "which tabs are open" in sync through background events — and on rare occasions that channel dies for an entire window, hours at a time, with no error of its own: every read, fresh or cached, just returns the last thing it heard. Clicking a row to focus its tab used to rely entirely on that channel noticing the switch, so the click itself did nothing. The panel now also remembers what *it* just activated, and trusts that over the API until a genuinely newer tab event arrives to update it — so clicking a row now fixes the highlight even on a window whose tab-reporting has gone silent. A small notice appears when that silence is detected, so it doesn't look like the panel simply forgot; reloading the window is what actually restores VS Code's own channel.
- **A batch's master row no longer flashes as closed for ~30 seconds right after pasting a block.** The conversation that frames a new batch is known only by its own generated title at that instant — VS Code hasn't renamed its tab from the first prompt yet, and the panel's separate record of real tab titles hasn't caught up either. For a few seconds neither title matches any open tab, and a conversation that's actually front and centre on screen briefly rendered with its title struck through, as if finished and closed. A conversation whose process is confirmed alive in a VS Code window can no longer be shown as tab-closed on this kind of title mismatch — closing a tab kills that process, so a live one always has a tab open somewhere, full stop.

## [2.39.3] - 2026-08-17

### Fixed
- **A conversation that merely *quotes* a background-task launch no longer spins forever.** 2.39.2 taught the panel to treat "ended its turn but a background task hasn't reported back" as still running — but it recognized those launches by their text anywhere in a tool result, so a conversation whose output *quoted* such a line (a grep through transcripts, a pasted log) was mistaken for one with a task of its own, and kept its spinner after it had genuinely finished. A real launch message *starts* the tool result it lives in, and a real completion notification arrives as its own message, never inside a tool result — the detection now honours both, so quotes neither create a phantom wait nor silence a real one.

## [2.39.2] - 2026-08-17

### Fixed
- **The next wave no longer opens while the current one is still working.** "Done" used to mean "the conversation ended a turn" — but a turn also ends when the conversation hands work to a background agent and waits to be woken, and a Stop hook that immediately relaunches the turn (a commit reminder, say) leaves a few seconds during which the state reads "done" before the resume is visible. Both cases were observed on a real batch: the next wave's tab opened, prompt ready, while the previous lot was demonstrably still running. Two locks close this. A conversation that is going to resume *by itself* — a background agent or command whose completion notification has not arrived yet, a scheduled wakeup still in the future — is now shown and counted as running, everywhere at once: its row, the batch counter, the wave engine, and the end-of-turn sound all wait for the *real* end. And the automatic advance no longer trusts an instantaneous reading: a wave must stay finished for 15 uninterrupted seconds before the next one opens — any resume in between rearms the clock. The manual ▶ button is untouched and remains immediate. If a background task dies without ever sending its notification, the block only holds while the conversation's process is alive, and ▶ always remains as the way through.

## [2.39.1] - 2026-08-17

### Added
- **The demo mode now shows a nested batch.** Launch VS Code with `CLAUDE_QUOTA_PANEL_DEMO=1` and the fictional panel includes a batch whose master conversation is itself a member of another batch — rendered nested under that row, counter chip included. The demo data goes through the same derivation as real batches (nothing hand-written), so it exercises the actual nesting logic.

## [2.39.0] - 2026-08-17

### Fixed
- **A conversation that launched several batches now heads only the latest one — the earlier batches stop holding an empty header, and disappear once they are done.** Planning batch after batch from the same conversation is the normal way to run a long piece of work, and each batch rightly recorded it as its master. But a conversation has a single row in the panel, so the batches were fighting over it: the last one drawn took it and every earlier batch kept an empty frame where its header should have been. Worse, a batch only vanishes once everything in it is finished — its master conversation included — so as long as that conversation was still alive driving the *next* batch, every batch it had ever launched stayed on screen, permanently showing "3/3 done". The most recently linked batch now keeps the header and the finished-or-not question; the earlier ones simply render as batches without a master, and fold away by themselves once their own tasks are done. Nothing is unlinked behind your back: link the conversation to an older batch again and the header moves back to it, immediately. As a result, linking a conversation that already heads another batch is no longer refused — it just becomes that batch's master, and the previous one steps back.

## [2.38.0] - 2026-08-17

### Fixed
- **The list is back to being about your tabs: conversations running outside this window no longer appear in it.** A Claude Code session started somewhere other than a VS Code tab — from the phone or the web through a Remote Control server running on this machine, from a terminal, or from an agent SDK — often runs in the same working directory as your window, so the panel saw it as one of its own. And because the panel never hides a conversation whose process is still alive, such a session stayed in the list for as long as its server held it: a row that no click could take you anywhere from, occupying one of the twelve slots a real conversation could have used. The panel now checks how a live session was started, and only a session born of a VS Code tab keeps that protection. Nothing changes for your own conversations, including the case that protection was written for — a tab renamed by Claude Code so that no title matches any more. A conversation picked up again inside VS Code comes back to the list as soon as its tab is there.

## [2.37.0] - 2026-08-17

### Added
- **A batch opened from inside another batch's own conversation now nests under it, instead of splitting into two disconnected groups.** Planning wave 2 from wave 1's own conversation is common — and until now the panel had no way to say "this conversation is both a member of A and the master of B": one of the two groups would claim the row, the other would keep an empty slot where it should have been. The row now stays exactly where it was — a member of its own batch, on that batch's rail — and simply grows a second batch hanging under it: same grip-then-members shape as a top-level batch with a master conversation, indented and framed in its own colour, folding and dissolving independently of the batch that hosts it. Nesting can go several levels deep, and it un-nests on its own, with nothing lost, the moment the link that created it disappears. See [Nested batches](README.md#nested-batches) in the README.

## [2.36.2] - 2026-08-15

### Fixed
- **The highlight catches up the moment you come back to the window.** 2.36.1 made the panel read the selected tab afresh rather than trust a remembered one — right, but nobody was asking for it. Coming back to VS Code from another application moves no tab, so no tab event fires, and the list only recomputed on its 30-second clock tick — exactly the stretch of time during which you are looking at it. Regaining window focus now triggers a recompute, so the highlight is correct as soon as the window is.

## [2.36.1] - 2026-08-15

### Fixed
- **The highlighted row now follows the tab you are actually on.** The panel kept the selected conversation in a memory that was only refreshed when VS Code announced a tab event. Any path that made a tab active without firing one left the highlight stuck on a conversation you had already left — and clicking the correct row did not repair it, because that tab was *already* active, so there was no event to catch up on and the wrong row stayed lit. The selected tab is now read fresh on every refresh, so the highlight puts itself right on the next tick whether or not an event ever arrives. Switching to a non-conversation tab still keeps the last conversation highlighted, as before.

## [2.36.0] - 2026-08-15

### Changed
- **A batch header now shows which batch it is, and its counter moved to the right.** The row held nothing but a chevron and a counter floating in the middle of an empty line, while nothing on screen said *which* batch you were looking at — the batch name only ever appeared as a tooltip, and only on a batch with no master conversation, so in the usual case it was invisible. The header now reads `BATCH 14:12` on the left, from the batch's creation time, and the `N/M done` counter sits on the right where it lines up from one batch to the next. The creation time rather than the name: two batches can carry the same `group:` line (or none at all), their time always tells them apart. The name is back as a tooltip in every case.

### Fixed
- **A batch that was given no name no longer reports the wrong time.** The fallback name (`Batch HH:MM`, used when the pasted block has no `group:` line) was derived from the UTC clock, so a batch created at 14:11 in Paris was called "Batch 12:11". It follows the machine's time zone now, like every other time the panel displays.

## [2.35.1] - 2026-08-15

### Changed
- **"+ new wave" and "+ this wave" now only show up once there's a prompt to add.** Both buttons file the batch form's current prompt into an existing group; with the field empty, clicking either did nothing but focus it. They stayed visible either way, taking up space in the sidebar and catching the eye of anyone who hadn't yet learned what they're for. They're now hidden until a task is actually typed in, and reappear the moment it is.

## [2.35.0] - 2026-08-15

### Changed
- **The batch notice now says how many conversations are still waiting, instead of how many have started.** "0/1 conversation(s) opened" asked you to work out the remainder yourself, and its total was fixed at launch time; it now reads "1 conversation not sent yet — press Enter in its tab.", counting the one thing the panel can actually prove at any moment: tabs that are open and have sent nothing.

### Fixed
- **A batch with several waves no longer describes a wave that is already over.** The notice tracked the conversations opened by the first wave and only those, so when a wave finished and the next one opened its tabs, a conversation sitting there with its prompt unsent was never counted — the line kept reporting the previous wave, or had already disappeared. Every conversation the batch has opened is now counted, whichever wave opened it.
- **Two French messages had drifted back to English.** The wording of the "lost its link before sending" notices changed when their remedy was simplified, which orphaned their translations; both are translated again.

## [2.34.3] - 2026-08-15

### Fixed
- **A conversation could ring twice for one turn.** A `Stop` hook that returns feedback (exit code 2) doesn't cancel an ending — it sends Claude back for one more turn, which ends in a second, entirely real stop. Both endings rang, 10 to 25 s apart, far beyond the 2.5 s rebound guard, and no guard length could have covered it without delaying every ending. The **done** sound is now keyed on the turn you started rather than on the engine stopping, so one turn rings once however many times a hook sends Claude back — including hooks the extension knows nothing about. The **waiting** sound is unchanged: several permission prompts in one turn are several real calls for you. Where the `UserPromptSubmit` hook isn't installed, the previous behaviour applies unchanged.

## [2.34.2] - 2026-08-10

### Fixed
- **Two conversations that merely share a title no longer collapse into one.** When a window reloads, the panel folds an abandoned transcript into the conversation that took its tab over — that is how a restarted conversation keeps one line instead of two. But a tab is matched by its label, so two conversations bearing the same title both look like they own it, and the older one was folded away even when each had a tab of its own. The panel now counts the tabs carrying that title: as many tabs as claimants means nobody took anything over, so nothing is folded. A conversation whose process is still running is still recognised as the successor, as before.
- **A batch could stay parked on a wave that had already finished, and one of its conversations could vanish from the list.** Two conversations that merely *open with the same short message* — "ok", "continue", "go on" — were taken for one single conversation resumed under a new id. The panel then dropped the older one from the list, and any batch task pointing at it read its status off the other conversation instead: still running, so the wave never counted as complete and the next one never opened on its own. Recognising a resumed conversation by its replayed opening message stays in place — it is what catches a batch whose title drifted by a word — but it now requires a message long enough to actually identify something, exactly the threshold the panel already applies everywhere else it matches a prompt. Below it, two identical openings prove nothing and fold nothing.

## [2.34.1] - 2026-08-09

### Fixed
- **The listing described two controls that no longer exist.** The README still explained the `auto` / `manual` wave-advance toggle removed in 2.30.0, and still placed the "dissolve this batch" ✕ on the master row, where 2.33.0 replaced it with the same ⤴ every other row carries. Documentation only — no code change.

## [2.34.0] - 2026-08-09

### Fixed
- **A conversation's status symbol no longer changes shape depending on whether it sits inside a batch.** Interrupted showed its hollow "stop" square in the flat list but turned into a "⚠" inside a group, where dormant turned into the very same "⚠" — two different states rendered as one symbol, and one state rendered as two symbols, so the panel effectively used two vocabularies at once. The cause was never a design choice: those two shapes were the only ones drawn with the icon's own border, and a group's status ring is painted over that border, which made them vanish inside a batch. Both are now drawn the way the busy arc already was, which survives the ring — so there is a single definition per state, valid everywhere, and the substitute glyph is gone. The render bench now renders every state in a group and in the flat list at the same instant and requires the two to be identical, so no future substitution can creep back in.

## [2.33.0] - 2026-08-09

### Changed
- **A batch's master row had two exit buttons that were impossible to tell apart — it now has one, and it is the same one every other row has.** Side by side sat a "✕" that dissolved the whole batch and an "Unlink" chip that only forgot which conversation the batch came from: two very different reaches, on the same object, with nothing in their placement to say so. Worse, in the situation where you actually met them — every task finished, their tabs closed, only the master left — both produced the identical result on screen, since a batch with nothing left to show stops being drawn as soon as it has no master. The master row now carries the same "⤴" as any member, meaning the same thing everywhere: this row leaves the block and goes back to being an ordinary conversation. Dissolving the batch moved up to the batch's own header row, where it belongs, and appears on hover so the header still shows nothing but the chevron and counter at rest. Nothing about what either action does has changed — dissolving still asks for confirmation and still closes no tab, unlinking still needs none and can be undone by relinking with "⌂".

## [2.32.0] - 2026-08-09

### Changed
- **A group now ends with one row instead of two.** "+ add to this wave" and "+ new wave" were two stacked full-width rows, about 52 pixels for two neighbouring actions at the very bottom of every group. They now share a single row, one on each half — two separate boxes, two dashed rules, two independent hover states, so they stay two targets you cannot click by mistake. The labels shrank to fit side by side ("+ this wave" and "+ new wave"); their tooltips still spell out what each one does. Nothing else changed: "+ this wave" still never appears on a wave that has already started or on the one currently running, and still refuses a multi-task block rather than silently collapsing its waves into one, while "+ new wave" still moves the whole block over after asking. When the last wave has already started there is no "+ this wave" at all, and "+ new wave" takes the full width on its own, exactly as before.

## [2.31.0] - 2026-08-09

### Changed
- **The panel fits more on screen: the same content is now about 10% shorter.** A sidebar is tall and narrow, so vertical space is the scarce resource — and a lot of it was going into gaps rather than content. Wave separators and the "+ add to this wave" / "+ new wave" rows each carried 14 pixels of blank margin around a 13-to-22-pixel box, so a group spent close to 40% of its height on dividers; section headers, the quota block and the page edges were similarly generous. All vertical spacing now comes from three variables defined in one place instead of values scattered across dozens of rules, which is what let them drift apart in the first place. Only empty space was tightened: no row, context bar or status glyph was made smaller, and their geometry is still verified to the pixel by the render bench.

## [2.30.0] - 2026-08-09

### Removed
- **The auto/manual wave-advance toggle is gone — a group's waves now always advance on their own.** The choice never earned its keep: the ▶ launch control on the next wave's header was already always there to force it open early, whichever mode was selected, so "manual" only meant one extra click on every batch of a group for no real benefit. Waves now always open automatically once the current one finishes, exactly as "auto" behaved before; forcing the next wave early still works the same way it always did.

## [2.29.1] - 2026-08-09

### Fixed
- **Queued tasks are no longer visibly taller than launched ones.** In a group with more than one wave still ahead, every queued task carried an empty 15-pixel strip under it, breaking the rhythm of the list. The strip was the row's action footer, kept open by the "move to the neighbouring wave" buttons: those only appear on queued tasks, and even at zero opacity a flow child still costs its height. They now sit on the row itself as a hover overlay next to the ⤴ button, as compact circles — the same pattern already used for the remove button and the master row's "unlink" chip, applied to height this time. The footer collapses completely when it has nothing visible to show, so a task in a group is exactly as tall as its content, whether it has started or not.

## [2.29.0] - 2026-08-09

### Added
- **A single conversation can now have a master, too.** Until now, a master conversation only existed for a batch of two or more tasks — a single task launched with a `group:`/handoffs block, or one you typed by hand, stayed a plain row with no way to say where it came from. Launching one task now creates a group (with just that one member) whenever you name it or the panel resolves a master for it, so the same header, counter and wave chrome you already know from bigger batches apply here too.
- **Link an already-open conversation to a master, after the fact.** Hovering a plain row now reveals a small ⌂ button: click it and the conversation in your currently active VS Code tab becomes its master. No picker, no typing — if the active tab isn't a Claude conversation, or it matches more than one, or either side is already part of a group, nothing happens and you're told why. Works the same way as the existing "link the active tab as master" button on a group's header.

## [2.28.4] - 2026-08-08

### Changed
- **Housekeeping only, no behaviour change.** A code comment in `state.js` illustrated a bug with names taken from the machine it was diagnosed on; it now describes the mechanism generically, which is also what a reader of this repo needs. Same code, same tests.

## [2.28.3] - 2026-08-08

### Fixed
- **A conversation you interrupted now shows the stop square immediately, instead of spinning forever.** The panel only acted on the transcript's interrupt marker when the hook state literally said `busy` — a test on the *source*, when what needed correcting was the *result*. The displayed state is often derived rather than reported: a Stop hook that returns feedback marks the turn `done` and restarts Claude, so from then on the spinner comes from "the transcript is still being written", not from the hooks. Interrupting during that stretch changed nothing: the spinner ran on, then five minutes later the row flipped to a bright "finished" check **and played the end-of-turn sound**, on work you had just cut short yourself. The two facts only the transcript knows — a manual interrupt, and a pending `AskUserQuestion`/`ExitPlanMode` — are now timestamped and weighed against the last hook event, and the fresher evidence wins. Five situations that were wrong are fixed: interrupting while a turn was resuming after hook feedback, interrupting a permission prompt (a stale "?"), an interrupt that survives a window reload (a pale "nothing to do here" check), a question asked after hook feedback (no "?" at all), and the split-second stop square that used to flash when you relaunched.

### Changed
- **The "busy" spinner is now blue, thicker, and its arc breathes.** Following up on 2.28.2: the orange didn't stand out enough and the arc was a fixed length. It's now a brighter blue with a bolder ring, and the arc continuously grows and shrinks as it spins — the same "breathing" motion as Material Design's circular spinner — instead of staying a fixed length. Same footprint, same position in a group's rail.

## [2.28.2] - 2026-08-07

### Changed
- **The "busy" spinner is now orange, and thicker.** It used to be a faint purple ring that was easy to miss in a list of small status icons. It's the same shape and size — no layout shift — just a brighter, more legible color and a bolder stroke.

## [2.28.1] - 2026-08-07

### Fixed
- **Collapsing a group no longer changes how its master conversation looks.** Collapsing hides the group's conversations — nothing else. Until now the group header vanished on collapse and the master row had to impersonate it: it grew a chevron, a "N/M done" chip and a frame closed on all four sides, so the one row that was supposed to stay put was the one that moved. The header stays where it is, keeps the chevron and the counter, and the master row is now identical to itself whether the group is open or closed — same edges, same width, same corners, same context bar, measured in both themes.

## [2.28.0] - 2026-08-07

### Changed
- **A row inside a group is now pixel-for-pixel the same row as one outside it.** Same context bar, same offsets, same right edge. Until now every group row was ~19 px shorter than a flat one: the permanent red cross on the right was a flow child, so it ate that width whether you looked at it or not — the same defect the master line had already been cured of (its "Unlink" chip was pulled out of the flow for exactly this reason). The removal button follows the same pattern now: an overlay, revealed on hover, with zero footprint at rest *and* on hover. Proven by measurement, in both themes, at rest, on hover and after a window reload.
- **That red cross is an arrow, and it is no longer red.** Nothing about it closes anything: it takes the conversation *out of its group* — the row reappears in the flat list, the tab is untouched. A cross said "close", which the panel simply never does: the only way to make a row disappear is still to close its tab in VS Code. The master's ✕ (dissolve the group, keep every conversation) keeps its shape but loses the error colour too, and is likewise revealed on hover.
- **In "Tab order", a group now takes its place in the flow** instead of always sitting on top. Its rank is that of its leftmost tab, master included — so a conversation whose tab is to the left of the group's shows *above* it, and one to the right shows below. Inside a group, order stays by wave (never by tabs). "Last activity" and "Status first" are unchanged: groups on top. Technically the panel used to render two separate containers, which made that ordering structural rather than a choice; it is now a single flow.

### Fixed
- **`~/.claude/panel-tabs/` no longer collects orphan `.json.tmp` files** (17 had piled up here). Each window publishes its tab list by writing `<pid>.json.tmp` then renaming it; when the rename lost a race with a neighbour reading the target — routine on Windows — the temporary file stayed behind forever, since the sweep only knew about `<pid>.json`. Two locks now: a failed publish deletes its own leftover immediately, and the sweep collects the ones left by dead instances. A `.tmp` belonging to a live instance is never touched, and never read — it is not a publication.

### Removed
- **The `closeConvTab` message handler.** No button had emitted it for several releases (the panel stopped acting on VS Code tabs when group crosses became metadata-only); leaving it wired kept the door open for the next button that assumed it could close a tab. The relay's responder side stays, so a neighbouring window still running an older version keeps working.

## [2.27.15] - 2026-08-07

### Fixed
- **Reloading the VS Code window no longer turns every finished conversation into a spinner.** On reload, the official extension respawns a CLI for each restored tab, and that respawn appends bookkeeping lines to the transcript (observed: a `last-prompt` record, no timestamp, 86 s after the turn's Stop). The "did work resume after the Stop?" check keyed on the file's modification time, so each unread finished conversation flipped back to a busy spinner for up to 5 minutes — on every reload. (Surfaced by 2.27.12: before it, those entries were purged at reload, which also wiped the unread ✓ this was fixing.) Resume detection now keys on the timestamp of the last real user/assistant message — the same discrimination the interrupt detector already used against these bookkeeping lines — with the file time kept only as a fallback when no dated message is readable. Liveness (busy → stale) still trusts the file time: there, any write is a sign of life.

## [2.27.14] - 2026-08-07

### Fixed
- **The "▶ wave n" launch pill no longer bites into the group's coloured rail.** The pill used to span the full row width and paint *over* the rail (a deliberate 2.27.8 choice — the pill masked the line behind it), which read as the button clipping the rail. Its box now starts after the rail's axis, like every other wave header — the rail runs continuously past it. The z-index guard stays as a belt: if the two boxes ever cross again, the pill paints on top rather than showing a line through the button. Screenshots regenerated.

## [2.27.13] - 2026-08-06

### Changed
- **The Marketplace listing finally shows what the extension does now.** New README section "Launching conversations — one, or a whole batch" (the New conversation form, pasted `claude-convs` blocks, per-task model/effort, waves, groups and the master capsule), and four regenerated screenshots: the full panel with a batch group, the form with a pasted block prefilled across two waves, a group with a running and a queued wave, and the pace-coloured quota bars. All screenshots are generated from fictional English data by the new `test/make-store-shots.js` (the real `panel.js` rendered in an offscreen Chromium with VS Code theme variables injected) — never captures of a real workspace. They are no longer packaged into the `.vsix` (`images/screenshot*.png` ignored): the listing resolves them through the GitHub repository.
- **The demo data set (`CLAUDE_QUOTA_PANEL_DEMO=1`) is now fictional and in English**, aligned with the screenshots. A handful of real conversation titles that had drifted into test fixtures over time (`test-focus.js`, `test-ack.js`, `test-presence.js`, `test-title.js`, one comment in `labels.js`) were replaced with the same fictional set — no functional change, all benches green.

## [2.27.12] - 2026-08-06

### Changed
- **Read receipts are never automatic any more.** A finished conversation's ✓ stays bright until you click its row in the panel — nothing else can dim it. The old rule ("the tab was active and focused for 2 seconds") never meant *read*: it fired for a tab left open while you worked elsewhere, for the tab-rename at the end of a turn, for tabs opened by the wave launcher, and — the eighth report — for a window simply coming back to the foreground with that conversation already active. Four guards had been stacked on that path over as many releases; a signal that needs five exceptions was not measuring what we thought. The dwell tracker still runs, but only to write the journal: it observes, it no longer decides.
- **Wider gap between the two checks.** Unread keeps the full colour and now also carries weight; read drops from 45% to 25%. The distinction no longer rests on hue alone, which matters on light themes where the fallback green is very pale.

### Fixed
- **"Finished, never read" no longer dies with the CLI process.** `SessionEnd` deleted the whole session entry — including the very record that a conversation had finished and had never been opened. Since that hook fires when the process dies, reloading a VS Code window wiped it for every conversation at once, and the panel, falling back to "the hooks know nothing", repainted them all as already read. The entry now survives when it still carries that fact (and only then: read, running, or `/clear`ed conversations are pruned exactly as before).

## [2.27.11] - 2026-08-06

### Fixed
- **A finished group (and its master row) lingered on screen after its last tab was closed**, sometimes for minutes, until an unrelated event — creating a conversation, a quota refresh — made it vanish. The panel is only re-pushed when its *render key* changes, and that key described the conversation list alone. Closing the last tab does two things a fraction of a second apart: the conversation leaves the list (pushed), then the hooks entry is purged and the session registry file disappears, flipping the master to "finished" — a recompute that produced an identical key, hence no push at all. Group truth (member and master statuses, waves, notices) is now part of that key, so anything the panel shows takes part in the decision to repaint.

### Changed
- **Group member titles are now one notch smaller than everything else** (12 px vs 13 px), matching the queued-task line right below them. The master row and conversations outside groups keep the base size, so rank reads in the type as much as in the colored rail.

## [2.27.10] - 2026-08-06

### Fixed
- **The busy spinner was invisible inside groups — the ring looked empty while a conversation was working.** Reported four times; two earlier fixes (2.24.x, 2.27.5) addressed the *animation* and were correct, yet changed nothing on screen. Root cause finally proven by pixel sampling: the group ring's opaque disc (a `z-index: -1` pseudo-element that punches the hole in the rail) paints *above* its host element's border in the CSS painting order — and the busy arc was the host's border, so the disc swallowed it entirely. The ✓ and ⚠ glyphs are text, which paints above the disc; busy was the only state drawn purely as a border. The arc now lives in a positioned pseudo-element that paints above the ring, with a single definition shared by flat rows and groups. The render bench now also proves the arc by sampling pixels inside the ring, not just by reading computed styles.

## [2.27.9] - 2026-08-06

### Changed
- **One less row in the New conversation form.** The "+ Add task" / "+ Add wave divider" buttons and the Cancel / Create buttons now share a single row — adders on the left, actions pushed to the right. On a narrow sidebar the row wraps naturally, nothing overflows.

## [2.27.8] - 2026-08-06

### Fixed
- **The group frame vanished under the master row's selection.** Selecting (or hovering) a group's master conversation painted its background over the colored capsule's side and bottom edges. The frame is now drawn on a layer above the rows, so no row background can ever cover it, whatever theme or state it is in.
- **The master row's ✕ overlapped the frame's right edge.** The ✕ has to stay exactly aligned with every other row's ✕, so the frame itself now extends slightly beyond the content column on both sides and encloses the whole row, ✕ included.
- **The colored rail was drawn inside the capsule.** It now starts at the capsule's bottom edge: the master's ring is still the head of the chain, but the line only appears once it leaves the frame.
- **The ⚠ glyph was not centered in its ring** (interrupted / dormant tasks inside a group). It is now centered as a box rather than as a line of text, with no hand-tuned offset.
- **The rail crossed the "▶ WAVE n" launch pill**, which reads as a rendering glitch. The pill now paints over it.
- **A collapsed group's status chip ("x/y", "✓ done") sat below the ✕ instead of beside it**; the chip and the chevron now line up with the ✕ on the row's first line.

## [2.27.7] - 2026-08-06

### Added
- **Diagnostic log for read receipts.** A finished conversation's bright ✓ can still dim itself without anyone having read it — four fixes so far, each deduced from the symptom rather than from evidence, and none of them final. That path depends on tab events, a process registry and timestamps that can't be replayed afterwards, so it now records what it actually decided, when it decided it: one JSON line per read receipt posted and per notable verdict, with the full context, in `~/.claude/quotabar-ack-journal.jsonl` (local file, never sent anywhere, rotated past 1 MB). It only records — no decision depends on it, and nothing about the panel's behaviour changes in this release. Set `QUOTABAR_ACK_JOURNAL=off` to disable it.

## [2.27.6] - 2026-08-06

### Fixed
- **A group task whose tab had just been closed could briefly show "open" instead of disappearing**, because two independent background signals (the CLI process registry and the hook-written state file) each clear their own trace of a closed tab on their own schedule, a few seconds apart — and right in that gap, the task looked like an open, idle conversation. The panel already knows the moment a tab closes; a finished task now hides on the very next render instead of waiting for those two signals to catch up, and an unfinished task (still running, or waiting on you) switches straight to its real remedy state (interrupted/lost link) instead of ever claiming to still be open.

## [2.27.5] - 2026-08-06

### Fixed
- **A busy task inside a group showed a static dot instead of a spinning ring, unlike an identical task shown as a plain row.** The static busy state was a deliberate but overcautious choice — it now reuses the exact same spin animation as plain rows (no reduced-motion media query, matching the panel's existing pulse animation for tasks waiting on you).
- **The "▶ WAVE n" control area and its banners could overlap the group's colored rail.** It now starts after the rail's axis, same rule already applied to wave separators and the "+ new wave" ghost row.

### Changed
- **A group's red ✕/⨯ buttons could close a VS Code tab you didn't expect to lose.** The panel now only ever edits its own grouping metadata from these buttons — it never closes a tab again. A member's ✕ removes it from the group (its conversation and tab, if any, are untouched — it simply becomes a plain row again). The master row's ⨯ dissolves the group only (same confirmation as before); its tab stays open. The close badge on plain, ungrouped conversation rows is unchanged — closing a tab is still its only job.

## [2.27.3] - 2026-08-05

### Fixed
- **The batch notice ("N/M conversation(s) opened — press Enter in each tab") could keep telling you to press Enter in a tab that no longer existed, or to click "Relaunch" on a single ungrouped task where no such button exists.** Each sentence in the notice is now shown only when the action it describes is still genuinely available: "press Enter" requires at least one task still provably open and waiting, and the "lost its link" remedy is only mentioned for tasks that belong to a group (the only place a "Relaunch"/"Link…" button actually exists). A batch with nothing left to act on now shows no notice at all, instead of a stale one.

## [2.27.2] - 2026-08-05

### Fixed
- **A group's master conversation was drawn just below the group's colored frame instead of inside it.** The frame now encloses the header row and the master row as one continuous capsule, in every state — master listed, master out of view, group collapsed, no master at all.
- **The master row's close button and context bar didn't line up with the group's other conversations.** The hover-only "Unlink" action, invisible at rest, was still taking up its full width in the row's layout and squeezed everything else left by about 42 pixels. It's now out of the layout entirely, and the master row measures pixel-for-pixel identical to any other conversation row: icon column, context bar, close button.
- **Status rings could let the rail show through, so a bubble looked see-through instead of sitting on the line.** Two separate causes: a finished-and-read conversation dimmed its whole icon (ring included) rather than just its checkmark, and a queued task's ring was dimmed the same way. Dimming now applies to the mark and to the ring's outline only — a ring's fill is always fully opaque, in both light and dark themes.

## [2.27.1] - 2026-08-05

### Fixed
- **A group's colored rail could go missing after a window reload, making its master conversation and tasks look disconnected from the group header.** The rail's height was only measured once, right when the panel re-rendered from a state push — if the panel's layout shifted afterwards without a fresh push (as can happen right after VS Code restores its window), the rail was left at a stale, sometimes zero, height. It's now kept in sync continuously instead of only at render time.
- **The status rings around a group's task icons could fail to fully hide the rail passing behind them in light color themes**, because the panel had no explicit background of its own and the ring's fill color could end up not quite matching what was actually behind it. The panel's background and the rings now always resolve to the exact same value, so they can no longer drift apart.
- **A group's master conversation could vanish from the panel entirely** (shown neither inside its group nor back in the plain conversation list) during the brief moment a group's tasks all finish while its master conversation is still open — a bookkeeping gap between two separate checks that has now been closed.

## [2.27.0] - 2026-08-05

### Changed
- **Finished group tasks whose tab has been closed no longer take up space in the panel — the auto-collapse chevron from 2.23.0 is gone, replaced by simply not showing them.** A task stays hidden as long as it's finished and closed; reopening its tab (or a reload restoring it) brings its row straight back, no state to reconcile. A wave whose every task is now hidden loses its "wave N" header too, rather than sitting there empty. Interrupted, stale and lost-link tasks are never hidden — there's still something left to do about them. A group whose tasks AND master conversation (if any) are all finished and closed disappears from the panel entirely (nothing is deleted — it comes back the moment anything in it needs attention again); a group whose tasks are all done but whose master is still open shows just its header row and a "✓ done" chip. The done counter still counts hidden tasks, so it stays accurate.

## [2.26.0] - 2026-08-05

### Added
- **Pasting a multi-task `claude-convs` block and clicking "+ new wave" on an existing group now adds the whole block at once**, instead of one task at a time with manual deletion in between. The block's own wave numbers shift to start right after the group's last wave; a confirmation shows how many tasks and waves are about to be added, and says so if the block's own group name or master-conversation token is being ignored (the target group already has its own). Clicking "+ add to this wave" with a multi-task block is refused instead of silently squeezing every task into one wave — use "+ new wave" for that.

## [2.25.0] - 2026-08-05

### Changed
- **A group's master conversation is now rendered exactly like any other conversation row** — title, model · effort, context bar — instead of the stripped-down title-only capsule header. Its status ring is now the first node on the group's colored rail, same as any task row.
- **The group header is now a slim "grip" above the master row**: chevron, done counter, auto/manual toggle — nothing else. A collapsed group with a master still shows a single row: the grip hides and the master row itself carries the chevron and the done chip.
- **Linking a master conversation is now one click on a "⌂" button, and only appears when the group doesn't have one yet** — it links whichever conversation's tab is currently active in the window, no picker involved. It refuses silently (with a message) rather than guessing when the active tab isn't a Claude conversation, or when its title matches more than one conversation. Hovering the master row reveals an "Unlink" action to undo a wrong link, with nothing shown the rest of the time.
- **Closing a master's tab (⨯) now dissolves its group in the same action** — the group's other conversations are left exactly as they are, never closed or interrupted. It asks first only if something in the group is still working.
- **The "+" button to adopt an existing conversation into a group is gone** — adding tasks already goes through "+ add to this wave" / "+ new wave".

## [2.24.4] - 2026-08-05

### Fixed
- **A finished group task could show up twice — once as its group's checkmark, once as a plain, unrelated row lower down — after its background session restarted on its own tab, with no window reload involved.** The duplicate-detection only trusted an exact conversation title match, and the two titles differed by a single word (the resumed run's own title drifted slightly from the original). It now also recognizes a continuation by its very first message, replayed verbatim by any resumed session — a second, independent signal that catches a same-tab restart even when the title itself isn't identical.

## [2.24.3] - 2026-08-05

### Fixed
- **A finished batch could leave two conversations marked "read" that you'd never actually looked at** — the official extension still showed their unread dot. Cause: opening a tab programmatically (the batch launcher, the wave engine advancing to the next task) makes it the active tab exactly like a click does, and once it sat there alone for a couple of seconds it satisfied the "read" check on its own. The panel now remembers which tabs it opened itself and never auto-marks those as read — only a real tab switch away and back, or clicking the row directly, still does.

## [2.24.2] - 2026-08-05

### Fixed
- **A group task with no conversation yet showed an empty ring — the icon it was punched out of the rail for simply wasn't there.** A task whose tab is open with the prompt inserted, waiting on you to press Enter, now pulses that ring slowly (opacity only, no motion) — everything else waiting its turn (queued, not yet linked) gets a plain dimmed ring instead, never a pulse. No `prefers-reduced-motion` opt-out: this PC runs with system animations off permanently, so a media query would have hidden the pulse from its own author — it's unconditional, same call as the existing spinner.
- **A working conversation's ring went empty too, mid-batch.** Busy, waiting, interrupted and stale rows inside a group now all carry a glyph inside their ring, same as the done checkmark — busy gets a plain filled dot rather than the flat list's spinning arc (a whole rail of tiny spinners read as "empty" before it read as "in progress"), waiting keeps its existing "?", and interrupted/stale both get "⚠" for the first time.
- **The "Create" notice text repeated what the group header above it already showed** (its name, its master conversation, its wave progress) and never went away once its group was dissolved or pruned. It's now cut down to what nothing else on screen says — the open count, "press Enter in each tab," and a lost-link mention when there is one — and it disappears together with its tooltip the moment its group is gone. The official-menu disclaimer moved off the permanent text entirely, into a tooltip on the notice.

## [2.24.1] - 2026-08-05

### Fixed
- **A launched wave's now-unneeded "+ add to this wave" line could get left behind, stacking up under "+ new wave."** The row is only ever placed in the DOM while its wave is still queued, but it was only ever removed once that wave number disappeared entirely — a queued wave that got launched kept its row orphaned at its old position instead. The row is now cleaned up the moment its wave stops being queued.

## [2.24.0] - 2026-08-05

### Changed
- **A group's header is now its master conversation.** The framed border that used to sit on a separate master row now wraps the header capsule itself: chevron, title, status dot and tooltip — the title is the master's live name when it's designated (its persisted name once it's out of view), or the group's own name when no master is set. No more separate row, no more color pastille, no more rename (✎) button — the frame carries the group's hue.
- **A group's task rows are now aligned exactly with the flat conversation list** — the old fixed left indent is gone.
- **A thin vertical rail now runs down the group, centered precisely on the status-icon column** (the same axis as the flat list), from the header down to the "+ new wave" line. Each row's icon sits inside a small ring — bordered in the group's hue, filled with the panel's own background — that visually "punches through" the rail.

## [2.23.0] - 2026-08-05

### Added
- **A group whose every task is done — and whose tabs are closed — now collapses itself into a single header row, marked with a "✓ done" chip.** No more scrolling past a finished batch's fully-deployed waves and "finished · closed" rows with nothing left to click. It reopens on its own the moment anything changes it back into something worth looking at (a reopened tab, a task added to a new wave) — and a manual expand of a done group is never re-collapsed behind your back. Nothing is deleted or hidden from the store: the chevron still opens it any time.

## [2.22.0] - 2026-08-05

### Fixed
- **A task could be labelled "closed before sending" while its tab was wide open, prompt inserted, waiting for you.** When a batch task's background CLI dies in the first seconds after its tab opens, the official Claude extension quietly starts a new one *in the same tab* — but the group member stayed bound to the dead one forever. The panel then concluded the tab had been closed, painted a red "this will not finish on its own" banner and suspended auto-advance, all about a tab that was fine. The status now says only what is actually known — **"link lost before sending"** — and never claims anything about your tab.

### Added
- **A lost link now repairs itself.** A member bound to a session that died *without ever sending anything* becomes eligible for prompt-prefix matching again: press Enter in the orphaned tab and the task re-links to the conversation that really started, on its own. Every other link stays final, as before — a session that is alive, or dead *with* a transcript (a genuinely interrupted conversation), is never re-bound behind your back.
- **A "Relaunch" chip** on that same state, for when the tab really is gone: it reopens a conversation for the task with its original prompt, model and effort, and links it back. It refuses to act if the task has re-linked itself in the meantime.

### Changed
- **The blocked-wave banner is now proportionate.** Red stays for a conversation genuinely interrupted mid-work; a wave held up only by a lost link gets an informational banner that states the remedy (press Enter in the tab, or use Relaunch). The batch notice after a "Create" was reworded the same way.

### Changed
- **The master conversation's row now gets a framed border in the group's own hue**, matching the color of the member thread below it and blending into it seamlessly at the bottom-left corner (no rounding there, so the line appears to grow directly out of the frame). A faint tint of the same hue fills the background.

## [2.21.5] - 2026-07-24

### Changed
- **The green "close & remove ⨯" chip is gone — the red circled ✕ on a member's own line is now the only way to exit it, in every case.** Clicking it always closes the tab (if one is open) and removes the member from the group, whether it's finished, already closed, or never launched — there's nothing left to choose between. The one guard: a conversation still actively working (busy/waiting) asks for a native confirmation first; a finished or queued one acts immediately.
- **Fixed the red ✕ overlapping the member's title text.** It used to sit on top of the line via absolute positioning; it's now a normal flex item next to it, so the truncated title stops before it instead of running underneath.

## [2.21.4] - 2026-07-24

### Fixed
- **An auto-advancing group would not open the next queued wave when the current wave finished while the extension was shut down (e.g. around a window reload).** The wave engine only re-evaluated groups on a state *change* pushed by the engine's `onChange` — and a wave that completes while the CLIs are dead and the hook entries are being purged leaves no change to carry the transition. At the next boot the very first snapshot already shows the wave `done` and the next one `queued`, a stable state that never fires `onChange` again, so the queued wave sat there forever. The extension now re-evaluates every auto group once against that first post-boot snapshot; a wave that came due while it was off starts on its own, and a wave still `busy` at boot is left untouched (it advances the moment its own finish arrives, as before).

## [2.21.3] - 2026-07-24

### Fixed
- **A finished member's "close & remove" chip could vanish just from switching focus between tabs, with no tab ever closed.** When several conversations in the same group share a long common prefix (e.g. three "Implement lot N…" tasks), VS Code's width-based tab truncation can make their on-screen labels ambiguous, and an isolated recompute — including one triggered by nothing more than a focus change — could momentarily fail to match one of them to its own (still open) tab. The match is now allowed a single consecutive miss before the badge gives up on it; only a real, sustained absence flips it off. Also: `tabOpen` was missing from the change-detection key the engine uses to decide whether to push a fresh state to the panel, so even a self-correcting recompute could leave a stale badge on screen until some unrelated event forced a repaint — it's now part of that key.

## [2.21.2] - 2026-07-24

### Changed
- **"Remove" is now a small red circled ✕ on the member's own line instead of a full-width button underneath it** — one line reclaimed per member. The footer below now only ever holds the merged "close & remove ⨯" chip, "Link…" and the ◂/▸ wave movers; empty, it takes up no height at all.
- **The "▶ Launch wave N" button is gone — the separator of the next wave to open becomes the button itself.** It shows "▶ wave N", rounded and centered: transparent (but still clickable, forcing it with the existing confirmation) while auto mode hasn't reached it yet, filled blue once the engine is actually waiting on you (manual mode with the previous wave done, or a stuck wave needing the fallback). Already-open or finished waves stay the plain separator they always were.
- **Every line of text in the panel now truncates instead of overflowing** — conversation titles, queued task prompts, the wave separators, banners, the group's own short name. A long unbroken string (worst case: no spaces at all) used to push the whole sidebar into horizontal scroll; every text container is now `overflow: hidden` with an ellipsis, including the flex children that previously refused to shrink below their content width.
- **A queued task shows its intended model/effort** — dimmed and italic, clearly distinct from a real conversation's badge, with a tooltip explaining it's an intention that the actual conversation will confirm once launched.
- **A finished conversation whose tab has been closed now shows its title struck through**, everywhere that conversation is rendered (a group member, a master conversation's degraded fallback line, or a plain list row). It follows the tab's real state — reopening it clears the strikethrough on its own, nothing is remembered.

## [2.21.1] - 2026-07-24

### Fixed
- **Closing a tab by hand could silently drop an unrelated, still-open conversation from a group.** VS Code truncates a tab's label to fit its width, not to a fixed character count, so two conversations with similar titles (e.g. two "Implement lot N…" tasks) can end up with a truncated label that's a prefix of both real titles. Closing one of them used to purge every conversation whose title matched that label — including the other one, tab still open. Closing a tab whose truncated label matches more than one known conversation now closes none of them rather than guessing; it only ever purges a conversation when the match is unambiguous.
- **Queuing a task into an already-finished auto-advancing group never launched.** `addTaskToGroup` added the member but, unlike the manual-link path, never re-checked whether a wave should now open — the new task sat `queued` forever until some unrelated event (a transcript write, a tick) happened to trigger a recompute.
- **The "add to this wave"/"new wave" ghost rows showed up in English inside a French install.** Their strings were missing from the localization bundle.

### Changed
- **The small "+" on a queued wave's separator is replaced by a full-width dashed row**, placed right after that wave's last member — same look and behavior as the "+ new wave" row at the bottom of the group (drop the prompt on click, highlight the prompt field on hover).

## [2.21.0] - 2026-07-24

### Added
- **You can now queue a task into an existing group.** Each queued wave separator gets a discreet "+" (never on the currently launching wave or an already-launched one — adding there would fire it off immediately). A dashed "+ new wave" line always sits at the bottom of every group, finished ones included, and creates the next wave on click. Both reuse the existing "New conversation" form: fill in the prompt, pick a model/effort with the usual selectors, then click the "+" where you want it dropped. Hovering a "+" highlights the prompt field so it's clear what text will land where. Clicking with an empty prompt does nothing but focus the field. The task is added as `queued` — nothing launches, it opens in turn like any other wave.

## [2.20.4] - 2026-07-24

### Changed
- **The paste-recognition banner can now be dismissed.** When pasting a `claude-convs` block into the prompt field, the banner that reports it ("recognized — N task(s) prefilled" or "not recognized: … — kept as a plain prompt") now has a × to close it early. It's purely local to the form (never persisted) — it still replaces itself on the next paste and disappears on Create/Cancel as before.
- **A finished member with an open tab now shows one chip instead of two.** "tab open — close ⨯" and "Remove" used to sit side by side with no case where you'd click one without the other. They're merged into a single "close & remove ⨯" chip: closing the tab and removing the member from the group happen together, and the removal isn't conditioned on the tab actually closing (a stubborn tab stays open and visible — nothing is lost). A finished member whose tab is already closed, or one never launched, still shows "Remove" alone.

### Fixed
- **A stale conversation could flash on screen for a moment right after a window reload, then vanish.** Working theory (not fully pinned down): the panel's first render can fire before the async sources it depends on (the open-tabs union, the live-session registry, the tab-title cache) have converged, letting an old transcript briefly match a restored tab before getting filtered out normally. Rather than patch that one heuristic, the very first push to the panel now waits for the computed conversation set to stabilize across two checks (or a ~1.2s cap, so it never blocks for good) before showing anything — every push after that stays immediate, unchanged.

## [2.20.3] - 2026-07-24

### Changed
- **The wave status line is gone.** Even trimmed down to a single sentence ("wave 1: 0/1 done — wave 2 opens automatically once this one is complete"), the line only repeated what the wave separators, the per-member ✓/spinner icons and the ▶ button (dimmed = auto, solid = manual) already say. Both the auto and manual variants are removed; only the "will not finish on its own" blocked banner remains.
- **The master conversation now appears exactly once, in its own group, at the standard conversation-row format.** Previously it showed up twice — once as the group header's title, once as its normal row in the flat list. It now has its own full-width line right under the group header (same rendering as any conversation row: real state icon, title, model · effort, context), with no special styling and no ⌂ mark. The group header goes back to always showing the group's short name. When the master conversation falls out of the panel's window (no tracked transcript+tab), a degraded line takes its place — its last known title, greyed out, no state or context — rather than disappearing.

### Fixed
- **A long master conversation title used to squeeze the auto/manual toggle down to unreadable slivers.** Now moot since the header no longer shows the master's title, but the underlying cause (the toggle and the icon buttons could shrink like any other flex item) is fixed too: the header's fixed controls (auto/manual toggle, ⌂ ✎ ⨯) never shrink — only the group's own (short) name ellipsizes.

### Fixed
- **"Create" now also counts as a remembered choice.** Since 2.19.2, clicking a model/effort button in the batch form remembered it as the new default — but launching a batch from a pasted `claude-convs` block never went through that click path, so the form still snapped back to the global default (e.g. `fable`·`xhigh`) right after the batch opened. A successful Create — pasted block included — now persists the model/effort of the **last task in the batch** (across all waves, not just the launched wave 1) as the new remembered default, exactly like a manual click. The haiku invariant is preserved: if the last task is haiku, the model is remembered but the effort is left untouched.

## [2.20.1] - 2026-07-24

### Fixed
- **Three status glitches after a window reload, one root cause: a conversation's identity moving out from under the panel.** Reloading the VS Code window kills the running CLIs; the official Claude extension restores its tabs, and sometimes relaunches a restored conversation under a **new** session id — a fresh transcript that replays the same first prompt (so it carries the same title) while the old transcript lingers, dead, as a *husk*. Everything keyed on the original id then broke:
  - **A finished conversation with its tab still open kept (or lost) its green "close ⨯" chip based on whether its CLI was alive, not on whether the tab was actually open.** A reload kills every CLI, so every finished group member became "done · closed" — no close chip — even with the tab right there. The chip now follows the real tab state (`tabOpen`), not process liveness; the "counts as done" fix from 2.19.4 is preserved.
  - **The same conversation appeared twice in the list**, both ✓ done with different context percentages — the husk transcript and its resumed successor rendered as two separate lines. The husk is now folded out of the view, keeping the live/fresher line only. Two genuinely concurrent tabs with the same title are never merged.
  - **A group member (or master pointer) linked to the pre-reload id** resolved its status, its close chip, and its close *target* against the dead husk. Members now follow the resumed conversation, so the chip appears when the tab is open and closing it hits the tab you actually see. Nothing stored is ever rewritten — the redirect is resolved at render time only (a guessed link is never persisted).

  These were pre-existing bugs in the reload/restored-tabs scenario, not regressions introduced by 2.20.0.

## [2.20.0] - 2026-07-24

### Changed
- **Wave batch panel, decluttered.** Three changes to cut down on repeated/redundant chrome in a group with multiple waves:
  - **Wave messages, status-only.** The "Wave N opened [automatically]" success notice is gone — the panel already shows the same information as the ongoing "wave N: X/Y done" line and the group's live conversations, so the extra banner only repeated it. Failure notices and the "will not finish on its own" blocked banner are unchanged.
  - **The group header now shows the master conversation's own title** instead of the group's internal short name, once one is linked — no more separate dedicated row underneath it. Click the title to jump straight to that conversation; the ⌂ button in the header remains the single entry point to set, change, or unlink the master (now a "Unlink" entry at the top of the same picker). The group's internal short name still exists (it drives the colour tint and the rename action) but is no longer shown once a master is set.
  - **The ▶ "Launch wave" button dims in auto mode** instead of always looking equally actionable — it stays fully clickable (with a confirmation prompt, since it forces auto mode's hand), but visually recedes so it doesn't compete with the fact that the next wave is already going to open on its own. A blocked wave, or manual mode, keeps the button at full strength — that's the one case where clicking it is the only way forward.

## [2.19.4] - 2026-07-24

### Fixed
- **Reloading the VS Code window no longer resets a group's "N/M done" count to zero.** A window reload terminates the CLI processes cleanly enough for their `SessionEnd` hook to fire, which purges each session's entry from the state file. Finished conversations still listed in the panel then fell back to the "no hook entry" state — rendered as a muted ✓ on their row, but read as *stale* by the group-member truth table, so the counter said "0/2 done" right under two check marks (and auto wave advance would have been suspended). A dead session whose hooks know nothing is now concluded *finished* whether the conversation is still listed or not — the doctrine the truth table already applied when the conversation had aged out of the list. A proven interruption (visible in the transcript) still counts as stale.

## [2.19.3] - 2026-07-24

### Changed
- **The master conversation now sits visually above the group, not inside it.** The line pointing at the conversation a batch came from (⌂) was rendered inside the group body, at the same indentation as the tasks — so it read as just another queued handoff instead of the conversation that produced them. It now sits between the group header and the task list, outside the tinted vertical rule, with its ⌂ tinted in the group's colour: the indented tasks below read as its sub-tree. It folds away with the rest when the group is collapsed.

## [2.19.2] - 2026-07-24

### Fixed
- **The model selector could go dark after a Create.** Reading back the default model from `~/.claude/settings.json`, the panel only stripped a trailing `[1m]` tag (`claude-fable-5[1m]` → `claude-fable-5`) and matched what was left against the button families (`haiku`/`sonnet`/`opus`/`fable`) — which never matches a full model ID, only the short form a click already writes (`sonnet`). So a global default stored as a full ID lit up no button at all, and Create stayed disabled. The lookup now also parses the `claude-<family>-<version>` schema, the same one used elsewhere to display the model actually running a conversation.

### Changed
- **The form now remembers your last explicit model/effort pick, instead of jumping back to the global default.** Clicking a model or effort button persists that choice per workspace; a blank task's pre-selection reads it first, and only falls back to the resolved global default (see above) the very first time nothing has ever been clicked. Previously a fresh task always inherited the machine-wide Claude Code default (e.g. `xhigh`), even right after picking something lighter for the task before it.

## [2.19.1] - 2026-07-24

### Fixed
- **A conversation deep in a long turn no longer shows as "stale — no activity for a while".** The panel marked a `busy` conversation `stale` as soon as its transcript stayed quiet for five minutes — but a long stretch of reasoning (extended thinking), or a slow tool call (a build, a web search, a sub-agent), writes nothing to the transcript for minutes while the CLI is very much working. The staleness check now consults the live-session registry: a conversation whose CLI process is still running stays `working…`, and only one whose process is actually gone can age into `stale`. This aligns the panel's status with the group-member truth table, which already required a dead session before calling anything stale.

## [2.19.0] - 2026-07-24

### Changed
- **One field, not two.** The dedicated *Paste anything* textarea is gone — the prompt field of each task now IS the paste zone. Paste (or edit and blur) a recognized ```` ```claude-convs ```` block into any task's prompt and it replaces the whole form (tasks, group, waves) exactly as the old field did, even when several tasks already exist; a block that's present but broken shows the same error banner and leaves the text as a plain prompt; anything else is simply the prompt, blank lines included — the old blank-line splitting is gone too, since a single field no longer needs to guess whether a paste is "one task" or "several".
- **The section separator is now `[---]`, not a bare `---`.** A lone `---` line is both a markdown horizontal rule and a YAML frontmatter delimiter, so a prompt containing ordinary markdown could get silently sliced into extra tasks. `[---]` (3 or more dashes in brackets) means nothing in markdown, YAML, or code, so it can't collide by accident. Old blocks that already use a bare `---` still paste correctly as long as the line right after it is a recognized field (`model:`, `effort:`, `stage:`, `group:`, `session:`) — an isolated `---` with nothing structured behind it is now left alone as plain text. `/handoffs` now emits `[---]`.

## [2.18.2] - 2026-07-23

### Added
- **Batches with several waves now actually run in waves.** Until now "Create" opened every task at once regardless of how the waves were laid out in the form. Only wave 1 opens now; the next wave unlocks once every task in the current one reaches `done` — automatically (default) or by clicking the always-available **▶ Launch wave N** button, which can also force a wave open early (a partially-done wave, or one with a stale/interrupted task) since auto is a convenience, never the only way forward. Each group has an **auto / manual** toggle in its header (hidden for single-wave groups), a queued task not started yet can be nudged to a neighbouring wave with the new move buttons, and an automatic wave opening is announced right there in the group.

### Changed
- **The onboarding tip under the paste field can be dismissed for good.** The help explaining how to make Claude end its handoffs with a `claude-convs` block — plus the one-click copy of an instruction for your CLAUDE.md — used to take three permanent lines below the field. It now carries a **×**: dismiss it once and it stays gone across reloads (stored per machine), leaving only a small **?** next to *Paste anything* to bring it back on demand. The separate "💡 /handoffs…" line has been removed: it repeated word-for-word the field's own placeholder.

### Fixed
- **The per-task `wave ◂ ▸` control no longer shows when a batch has a single prompt.** With only one task there is no wave to move it to, so the control did nothing (and `▸` would have spun up an empty second wave around a lone prompt). It now appears only from two tasks onward, matching the wave header.

## [2.17.0] - 2026-07-22

### Fixed
- **An open conversation no longer disappears from the list because its tab was renamed.** Presence was decided by comparing the tab caption with the conversation title stored in the transcript (`ai-title`). Those two drift apart: the official Claude Code extension keeps its own session titles in the workspace's `state.vscdb` (`agentSessions.model.cache`) and re-labels tabs from there without ever writing a new `ai-title`. Once they diverge, no tab matched any more — so a conversation whose tab was sitting right there, with its CLI process still running, was filtered out as "no tab anywhere", and clicking its row (had it still been listed) would have focused nothing.

  Two identities that don't depend on any caption now back the panel up:

  - the **live-session registry** (`~/.claude/sessions/<pid>.json`, one file per running CLI process, holding its session id). A conversation whose process is alive is never hidden, and stays a candidate even when its transcript has been quiet for hours;
  - the **real tab titles** read from `state.vscdb`. They feed matching, click-to-focus, tab-order sorting — and the display, so a row is now labelled with the name you actually see on the tab rather than a stale one.

  Both are undocumented internals, so both degrade in silence: if either source is missing or unreadable, the panel behaves exactly as it did before, and neither can ever hide a conversation that used to show. Closing a tab still wins over everything else — a conversation you closed disappears at once, alive process or not.

## [2.16.0] - 2026-07-22

### Added
- **The conversation list can be sorted, and both sections fold away.** A dropdown next to the *Conversations* header offers three orders: **tab order** (same left-to-right order as your VS Code tabs, the default), **last activity** (most recently active first), and **status first** (anything busy or waiting for you at the top, regardless of age). Clicking either section header — *Conversations* or *Quota* — collapses it, so a window where you only care about one of the two can show just that. All three choices persist as settings (`claudeCodeQuotaBar.conversationSortOrder`, `.collapsedConversations`, `.collapsedQuota`).

### Fixed
- **A permission dialog now raises the ? — immediately, and for every tool.** Until now the row kept spinning while the dialog sat on screen asking a question, so the one moment the panel exists for was the one it missed. The signal it relied on, `Notification:permission_prompt`, is only emitted after **6 seconds of user inactivity** (a 6 s timer plus a "last interaction ≥ 6 s" guard in the CLI, see [#58909](https://github.com/anthropics/claude-code/issues/58909)) — when you're at the keyboard it never fires at all. The panel now listens to the `PermissionRequest` hook instead, which fires inside the permission flow itself, before the dialog is drawn, with no idle guard: the **?** and its sound land ahead of the dialog. That hook can approve or refuse a tool call, so the handler writes nothing to stdout and always exits 0 — a bench asserts it, because a stray byte there would decide on your behalf.

### Changed
- **Any kind of "your turn" now looks the same in the list.** `Notification` types are filtered by a deny-list instead of an allow-list: everything that isn't explicitly informational (`idle_prompt`, `auth_success`, `agent_completed`, `computer_use_*`, elicitation completions, push notifications) raises the **?**. The old allow-list silently dropped every type added or renamed upstream — `elicitation_url_dialog`, `worker_permission_prompt` and `agent_needs_input` were all invisible. A notification that arrives **without** `notification_type` is no longer ignored either ([#11964](https://github.com/anthropics/claude-code/issues/11964), closed as *not planned* — reading the message is the sanctioned workaround). MCP elicitations raise the **?** naming the server, and `PermissionDenied` / `ElicitationResult` close the wait at once instead of leaving it up until some later transcript write proves work resumed.

## [2.15.0] - 2026-07-22

### Added
- **A "Claude Convs" button in the status bar always brings the panel back.** The panel lives in a single-view container in the secondary sidebar; close it with the tab's `×` and VS Code offers no obvious way back — no activity-bar icon to click, and `View: Open View…` buries it in a list of dozens of unrelated views under a name (`Conversations & quota`) that doesn't match the container title you were looking for (`Claude Convs`). A new command, `Claude Convs: Show Panel`, wraps VS Code's auto-generated `<view>.focus` command (which reveals both the container and the view) under a name that actually matches the extension, and a permanent status bar item runs it on click — no hunting required, whatever state the panel is in.

## [2.14.1] - 2026-07-22

### Removed
- **Maintainer-only notes are no longer shipped inside the package.** Two internal documents (a publishing runbook and the repository's own working notes) were picked up by the packager and travelled inside the `.vsix`. They are of no use to anyone installing the extension. Nothing about how the extension runs changes in this release.

## [2.14.0] - 2026-07-22

### Added
- **A conversation you interrupted now has its own icon — a hollow square — instead of borrowing the dim ✓.** Since 2.13.2 an interrupt correctly stopped the spinner, but it landed the row on `idle`, which renders exactly like "finished, already read". The two mean opposite things: a dim ✓ says *nothing to do here*, while a conversation you stopped mid-turn is **unfinished work you meant to come back to** — precisely the row you go looking for twenty minutes later, and the one that was impossible to pick out of a list of a dozen. `interrupted` is now a state of its own, drawn as the universal stop shape rather than another shade of green (the panel deliberately carries state in the *shape*, not just the colour, for high-contrast themes and colour vision deficiency). It is muted, not alarm-coloured: it is a fact to find again, not something demanding attention. It clears itself as soon as you send the next prompt, and it stays silent — no sound, no bright ✓ to acknowledge, exactly as before.

## [2.13.2] - 2026-07-22

### Fixed
- **The bright ✓ of a finished conversation no longer dims on its own a couple of seconds later.** Read receipts tracked "the tab you are sitting on" by its *label*, and the official Claude Code extension rewrites the tab at the end of every turn (a `rename_tab` message that reassigns `panelTab.title` and swaps the icon to `claude-logo-done.svg`). That rewrite fired `onDidChangeTabs` ~250 ms after the `done`, which looked exactly like "the user just arrived on this tab": a brand-new visit was recorded, its 2 s dwell expired, and the ✓ was marked read — by the tooling, never by a human. Worse, because that fake visit started *after* the run began, it also laundered the strict-ack guard added in 2.7.0, which exists precisely to reject a tab you were already parked on. The signature was an ack timestamp landing a constant `done + 2266 ms` in `sessions-state.json`. A visit is now identified by the tab itself (the `Tab` object, falling back to its column#index position); the label is just a caption refreshed in place and can no longer start or restart a visit. On top of that, the dwell now has to elapse **after the turn ends**, not after it starts: being present while Claude works is no longer proof you read a result that did not exist yet. Clicking a row in the panel still acknowledges it outright, as before.

### Fixed
- **The spinner no longer keeps turning after you interrupt a conversation.** Pressing Stop (or Esc) fires no hook at all — the Stop hook does not run on a user interrupt, by design (anthropics/claude-code#45289) — so the `busy` state set by `UserPromptSubmit` was never cleared and the conversation kept spinning until it aged into `stale` after 5 minutes. The state engine now reads the interruption straight from the transcript (the `[Request interrupted by user…]` user message Claude Code writes there) and drops the row to `idle` at once, the same way it already reads `AskUserQuestion`/`ExitPlanMode`. It flips back to `busy` on its own as soon as you send the next prompt.
- **The model name no longer blanks out to `—` mid-conversation.** The last-assistant lookup only reads the final 64 KB of the transcript; a single oversized `tool_result` in the tail (a base64 screenshot, a large file read, a long command output) pushes the last assistant message out of that window, and both the model and the ctx% vanished until an assistant message came back into range. The reader now remembers the last known model/ctx per conversation and keeps showing it instead of clearing it. (The very first moment of a brand-new conversation, before any assistant reply exists, still shows `—` for a second or two — there is nothing to remember yet.)
- **Opening a question no longer steals your keyboard focus.** When a conversation turned to `waiting`/`done`, the event-driven quota refresh would, if the cached claude.ai cookie was stale, launch Brave to re-extract it — and a spawning browser window grabs the foreground for ~230 ms (measured), cutting you off mid-typing. Brave is now started with `--no-startup-window`: the process and its DevTools endpoint come up with no window at all (cookie extraction is browser-level and works without one — verified), so nothing takes the foreground. A circuit breaker also stops re-launching Brave on every fetch when the refresh keeps failing (e.g. the configured Brave profile isn't logged into claude.ai): it falls back to the OAuth token and only retries the browser path after an hour, or immediately on a manual **Refresh**.

## [2.13.0] - 2026-07-19

### Fixed
- **The highlighted conversation now follows the selected tab.** The highlight was driven by `~/.claude/active-session.json` — the conversation that last *received a prompt* — so clicking another Claude tab (in the editor, or via the panel itself) never moved it, and it routinely sat on the wrong row. The tab tracker now remembers the last selected Claude tab of each window (`onDidChangeTabs` for switches inside a group, `onDidChangeTabGroups` for switches between groups) and the snapshot highlights the matching conversation instead. Selecting a non-Claude tab (a file) keeps the last conversation highlighted rather than clearing it. `active-session.json` survives only as a fallback for a window where no Claude tab was ever selected; an active tab whose label matches no listed conversation highlights nothing rather than falling back to a wrong row. The highlight is per-window — each window's panel shows what *that* window is looking at.

## [2.12.7] - 2026-07-17

### Changed
- **Last French example in the README replaced.** `Implémenter lot 4 burn-r…` — a real conversation title from the author's machine, used as the tab-truncation example in an otherwise English document — is now `Refactor auth middlewar…`, matching the screenshot's mock data. Textual survivor of the same problem as the screenshots in 2.12.6.

## [2.12.6] - 2026-07-17

### Changed
- **All screenshots replaced with a single mock-data one.** Every previous screenshot was a real capture of the author's own machine: real conversation titles, in French, on a light theme — published on a public listing page. The listing now carries one image built from mock English conversations (`images/screenshot.png`), on the dark theme, showing **all five states at once** (working, waiting for you, done-unread with the bright ✓, done-read with the dimmed one, stale) above the three quota bars in red/yellow/green with their ▲ pace markers. The old captures (`screenshot-dark-burnrate.png`, `screenshot-states-illustrated.png`) are gone, and their README sections read fine without them.

## [2.12.5] - 2026-07-17

### Fixed
- **Sounds toggle was silently useless without the hooks.** Flagged by the user reviewing the public listing: a Marketplace install that enables 🔊 but never runs **Claude Convs: Install Hooks** would see every conversation stuck at `idle` forever (README § Setup) and therefore never hear anything — nothing told them why. Enabling the toggle (via the icon, or a pre-set `true` found at startup — settings synced from another machine, hand-edited `settings.json`) now checks for `~/.claude/scripts/hook-session-state.js` (the hooks' own marker file) and, if missing, shows a one-time warning offering **Install hooks** / **Enable anyway** / **Turn sounds back off**. Same dismissal style as the existing accessibility-signals conflict prompt — never re-asked once accepted, and moot anyway the moment the hooks actually get installed.

## [2.12.4] - 2026-07-17

### Changed
- **Marketplace listing copy rewritten** after checking what competing Claude Code quota/usage extensions actually offer (Clusage, Claude Quota Tracker, ClaudeProUsage, Claude Code and Codex Assist — all status-bar quota monitors or past-session viewers; none show live per-conversation state, none focus a VS Code window on click, none play distinct done/waiting sounds, none colour quota by projected pace rather than a flat %-used threshold). README hook, `package.json` description and `keywords` updated to lead with those three verified differentiators instead of a feature list.
- **Two new screenshots.** `images/screenshot-dark-burnrate.png` (real capture, dark theme, a genuine red 90%-pace 5h window next to a green 7d one — added to the Burn-rate colouring section) and `images/screenshot-states-illustrated.png` (all five conversation states — busy/waiting/done unread/done read/stale — side by side with mock conversation titles, since no real workspace has all five at once; built from the panel's actual CSS so the styling is real even though the data is a demo, labelled as such in the caption — added to the Conversation state engine section).

## [2.12.3] - 2026-07-16

### Changed
- **`done` sound switched to `ding.wav`.** The user A/B-tested `Windows Ding.wav`, `Windows Notify.wav`, `chimes.wav`, and `ding.wav` against the actual PC speakers and picked `ding.wav` — the shortest/lightest of the set. Played via `System.Media.SoundPlayer(...).PlaySync()` (synchronous, no `Start-Sleep` needed) instead of `SystemSounds.Asterisk`. `waiting` (`SystemSounds.Exclamation`) unchanged.

## [2.12.2] - 2026-07-16

### Fixed
- **Sounds were still silent after 2.12.1**: `detached: true` on the spawn starves powershell.exe of a console on Windows — the process dies in ~150 ms (exit 0) without ever running the command, sleep or not (measured; without `detached` the same spawn lives its full ~1.6 s and plays). Option removed — same recipe as `focus.js`/raiseWindow, which never had the problem. Root-caused by process-watching a real end-of-turn: the claim was written, no powershell ever appeared.
- `package.json` `displayName` and two setting descriptions had their em-dashes mojibake'd (`â€”`) by the 2.12.1 release tooling (PowerShell 5.1 `Get-Content` reads BOM-less UTF-8 as ANSI). Restored.

## [2.12.1] - 2026-07-16

### Fixed
- **Notification sounds were completely silent.** `SystemSound.Play()` is asynchronous (PlaySound `SND_ASYNC`): the hidden PowerShell exited right after the call, killing playback before it started. The spawned command now sleeps 1.5 s after `Play()` — the process is detached and fire-and-forget, so the sleep blocks nothing.

## [2.12.0] - 2026-07-16

### Added
- **`claudeCodeQuotaBar.braveUserDataDir` setting** (default empty). The cookie-based quota fetch path no longer hardcodes `C:\OctopusData\BraveOctopus`: with the setting empty (the marketplace default), that path is skipped cleanly — no browser spawn attempt, no error — and the OAuth fallback is used directly. Set it to a Brave user-data directory with a `claude.ai` session logged in to restore the faster path.
- **`Claude Convs: Install Hooks` command.** Deploys the hooks (`install.ps1`, bundled in the extension) after a modal confirmation listing exactly what gets written (`~/.claude/scripts/`, a `~/.claude/settings.json` backup + additions) — no silent writes outside the extension folder. The panel already worked without hooks (every conversation shown as `idle`); this makes turning on live state a one-click, consent-gated action instead of a manual `.ps1` run.
- README: Requirements/Configuration/Privacy sections rewritten for a marketplace audience — what works with zero config vs. what's opt-in and degrades cleanly, a real screenshot of the panel, and the previously-undocumented `quota-org-id.json`/`quota-brave-pid.json`/`sessions-state.json` privacy entries.

### Changed
- `.vscodeignore`: excluded `test-cdp-fetch.mjs` (a standalone dev script against Brave principal's port 9222, unrelated to the shipped extension) from the packaged `.vsix`.
- `PUBLISH.md` refreshed: the GitHub repo step now comes before the Marketplace publisher step (the README screenshot needs it to render on the listing page), and the stale "status bar" description from the pre-2.0 architecture is gone.

## [2.11.0] - 2026-07-16

### Added
- **Tab detection drift canary.** Every tab↔conversation match (click-to-focus, tab-close removal, read receipts) depends on the official extension's `viewType` staying `claudeVSCodePanel*` — if it's ever renamed, those paths degrade silently, without an exception anywhere. A conversation `busy`/`waiting` with zero Claude tabs detected for over ~2 minutes now logs a warning and shows a small, non-modal `⚠ Claude tabs not detected` line under the conversation list; it clears the moment a tab is seen again.
- **Quota fetch dedup across VS Code windows.** N windows watching the same workspace used to each poll and event-fetch independently against the shared `usage-cache.json`, multiplying calls to `claude.ai` for the same number. A fetch (poll or event-driven) is now skipped if the shared cache was refreshed by any window less than 30 s ago — the panel still updates from that cache. The **Refresh Now** command and the panel's **Refresh** link always force a real fetch regardless, since that's an explicit ask.
- README: documented the `quota-session-key.json` clear-text `sessionKey` cookie under Privacy (same trust level as `.credentials.json`), and the dated failure modes of the "1M context" and "interactive tool" heuristics under Known limitations.

## [2.10.0] - 2026-07-16

### Added
- **Notification sounds**: a system sound plays when a conversation finishes replying (`done`) or hands control back to you (`waiting` — a question, a permission prompt), useful when the panel isn't on screen. **Off by default**, toggled from the new 🔈/🔊 icon at the top of the panel or `claudeCodeQuotaBar.sounds.enabled`. Played from the extension host via a detached, hidden PowerShell (`SystemSounds.Asterisk`/`Exclamation`) — never from the webview, whose JS is suspended exactly when the sound would be needed. Debounced (~2.5 s) against the same Stop-hook-with-feedback rebound the state engine itself corrects, so a turn that isn't really over never rings. Deduplicated across every VS Code window watching the same workspace via a claimed entry in `~/.claude/sound-claims.json` (same lock as `sessions-state.json`, pruned after 24 h like it). See README § Sounds.
- The first time the toggle turns on with VS Code's own `accessibility.signals.chatResponseReceived`/`chatUserActionRequired` set to `sound: "on"`, a one-time prompt offers to turn those off to avoid a double ring; the choice is remembered and never asked again.

## [2.9.0] - 2026-07-16

### Fixed
- **A conversation with no transcript file on disk is no longer shown at all**, instead of a ghost row with no title, no model and no context %. Incident: a session entered `sessions-state.json` via `UserPromptSubmit` with a transcript path for the workspace, but the process was aborted before ever creating that file — the row it produced (`"Conversation"`, `waiting`) couldn't be matched to any tab, couldn't be titled, and the lot-5 presence filter refused to clear it since it had no `ai-title` to trust. A brand-new conversation can legitimately precede its first transcript write by a few seconds — that's not treated as debris, it's simply not rendered yet, and appears the moment the file shows up. An entry stuck without a transcript for more than 5 minutes is dropped from `sessions-state.json` outright (`SessionEnd` isn't reliable enough to count on, see 2.2.0).

## [2.8.0] - 2026-07-16

### Fixed
- **A question asked (`AskUserQuestion`) or a plan awaiting approval (`ExitPlanMode`) now shows `waiting` immediately, instead of keeping the busy spinner until a 60-second-late `idle_prompt` Notification.** Neither tool fires any hook at all ([#13830](https://github.com/anthropics/claude-code/issues/13830), [#13024](https://github.com/anthropics/claude-code/issues/13024)); the `Notification` hook's `idle_prompt` path has a fixed, non-configurable 60 s delay ([#13922](https://github.com/anthropics/claude-code/issues/13922)). Detected straight from the transcript instead: if the last assistant message ends in a `tool_use` for one of these two tools with no matching `tool_result` yet, the conversation is `waiting`, regardless of the hooks' last word. Clears as soon as a `tool_result` (or any later event) shows up. The existing `permission_prompt`/`idle_prompt` paths are untouched.

### Changed
- **The `waiting` icon is now a single, non-animated `?`**, replacing the pulsing dot — one visual state for every kind of "hands you back control" (question, permission, idle), instead of a signal only some of them used to trigger.

## [2.7.0] - 2026-07-16

### Fixed
- **Strict read receipts: only an *observed* act dims the ✓, never a tab left active from before the run.** Incident: a conversation's ✓ dimmed after the tab had simply been sitting open for an hour while work continued elsewhere in the *same* window — "active tab + window focus + 2 s" was satisfied without anyone ever looking at the result. A dwell now only counts if it started **after** the conversation's current run began (`busy_since`, newly persisted per session, stamped on every `UserPromptSubmit`, unlike `since` it survives through to the following `Stop`). Coming to watch a conversation work is an observed act; having been there since before it was even launched no longer is. Decision: a false "unread" is acceptable, a false "read" is not.
- **Clicking a conversation's row in the panel is now an explicit read receipt**, even when its tab is already active and no tab-switch transition will ever fire — the one escape hatch a single-tab workflow needs.

## [2.6.0] - 2026-07-16

### Fixed
- **Quota bars refresh at the moment they'd actually be stale, not just every 5 minutes.** During a fast burn, the panel could show 85% while the real usage was already at 90% — the quota poll only ran on its fixed 5-minute timer. Now, whenever a conversation transitions to `done` or `waiting` (the moment a chunk of usage was just billed), a quota fetch fires immediately. Throttled to at most one event-driven fetch per ~45 s (a burst of conversations finishing together triggers only one), skipped while the panel is hidden, and never triggered by a `busy` state or by a recompute that doesn't actually change any conversation's state (e.g. context % moving mid-run). The 5-minute poll is unchanged and remains the fallback.

## [2.5.0] - 2026-07-15

### Fixed
- **A conversation's `ai-title` is now found no matter where it lands in the transcript.** It was only searched in the first 32 KB and last 64 KB of the file; a real transcript had it at byte 33,349 of a 739 KB file, invisible to both windows. The panel then fell back to the first message as the title, and — since the lot 5 presence filter only trusts `ai-title` to prove a closed tab is really gone — a closed conversation with a buried title stayed in the panel forever. Fixed with an incremental, append-only scan (`scanAiTitleIncremental` in `hooks/transcript.js`): a full scan once per file, then only the newly-written bytes on every subsequent read, cached per file in `state.js`'s transcript reader.

## [2.4.0] - 2026-07-15

### Added
- **A ▲ marker under each quota bar** showing where you should be right now if usage were spread evenly across the window — % of the window elapsed. Fill to its left is on pace; past it, you're burning faster than the clock. 24 h after a weekly reset, it sits at 1/7 ≈ 14.3%. Masked under the same conditions as the burn-rate colour (no reset time, reset already past, window barely started), capped at 100%.
- **The arrow and the burn-rate colour now refresh on their own**, every 30 s, without a network call: both are pure functions of the clock and the reset time, which the webview already has. The tick pauses while the panel isn't visible (`document.hidden`, the Page Visibility API webviews support).
- **A bar for every model-scoped weekly limit the API reports** (`limits[]` entries with `group: "weekly"` and a `scope`, e.g. a promotional Fable allowance) — labelled from `scope.model.display_name`, with **no hardcoded model name or date anywhere**: the bar appears when the API sends the entry and disappears the day it stops. `quotaState()` now exposes a `windows[]` list instead of a fixed `fiveHour`/`sevenDay` pair.

### Changed
- The burn-rate colouring logic itself is unchanged (no window-open damping, per an explicit 2026-07-15 decision) — this release only makes the existing colours self-explanatory and keeps them live between polls.

## [2.3.0] - 2026-07-15

### Fixed
- **The `busy` arc actually spins now.** Two causes, both measured rather than guessed. (1) The CSS carried an `@media (prefers-reduced-motion: reduce)` rule that set `animation: none` — and Chromium derives that preference from `SPI_GETCLIENTAREAANIMATION`, Windows' "Show animations" toggle, which is off on this machine. The rule was therefore *always* on: the spinner had never once spun. It's gone, deliberately: the arc carries the conversation's state, so cutting it removes information (see README → Known limitations). (2) Every state push rebuilt the whole list of DOM nodes, restarting the animation from zero; the list is now rendered incrementally, so nodes survive and keep their rotation.
- **A conversation no longer shows ✓ while it is visibly working.** The `Stop` hook also fires when the turn *continues* — a Stop hook returning feedback (an `exit 2` that sends Claude back to work), or a message typed mid-turn. The `waiting` state already had a "transcript wrote later ⇒ it resumed" correction; `done` now has it too, with two guards: writes within ~2 s of the `Stop` don't count (the turn's last assistant message lands right next to it, so every turn would otherwise bounce back to `busy`), and the fallback stays `done` and never `stale` — once writes stop, the turn really is over.
- **Repeated hook events now stamp their own timestamp** (`hook-session-state.js`). `since` was only re-armed when the *state changed*, but these events repeat identically and each repetition is news. Two consecutive `Stop`s (a Stop hook with feedback, then the real end of turn) left `since` on the *first* one: the end of the turn was read as a resumption — the conversation stayed "working" — and the ✓ never went bright again despite new content. The same flaw hit two consecutive `Notification`s: a second permission prompt was read as a resumption, so the panel showed "working" while Claude was actually waiting for you. Found by running the real hooks in a sandbox, not by reading the code.
- **Conversation titles no longer leak CLI markup.** A conversation opened with a slash-command showed `<command-name>/model</command-name> <co…` as its title: the transcript stores the markup, not `/model opus`, and those entries aren't flagged `isMeta`. Leading `<tag>…</tag>` envelopes are now stripped whole — by shape, not by a list of known tag names, which would just reproduce the bug on the next one the CLI invents — so the fallback title lands on the first real human message. Chevrons inside a sentence ("why does this `<div>` overflow?") are untouched.

### Added
- **Read receipts.** A finished conversation keeps a **bright ✓ until you've actually read it**, then dims to a soft ✓. "Read" = its tab is active *and* the window has focus, held for ~2 s — a dwell that ignores a `Ctrl+Tab` passing through and the neighbour VS Code auto-activates when you close a tab. It also covers the case where the tab was already in front of you as Claude finished (no tab switch will ever fire there, so the `Stop` goes and asks). Stored as `ack_ts` in `sessions-state.json`: survives a restart, and a read in one window dims the ✓ in all of them. A new `Stop` re-arms the bright ✓ on its own.
- `ack.js` — the dwell tracker. The extension is now the *second* writer of `sessions-state.json` (hooks were alone), and goes through the same locked, atomic `updateSession` — never a hand-rolled write.

### Changed
- **The 30-minute `done` fade is gone.** An arbitrary timer knows nothing about you: it erased the ✓ of a result you never read, and kept bright one you'd read 29 minutes ago. Reading is now the only thing that dims it. The natural bound is unchanged — the 4 h recency window still drops the conversation from the panel.
- **No more grey `idle` dot.** A finished conversation reads as a dim ✓ ("nothing running") rather than a grey pellet that made it look pointless. Conversations with no hook state at all (older than the hooks) render the same way.
- The state engine only notifies the panel when something **visible** changes. It used to compare whole snapshots, including `mtime` — rewritten on every transcript line — so a working conversation re-rendered the panel continuously.

## [2.2.0] - 2026-07-15

### Fixed
- **Closing a conversation's tab now removes it from the panel straight away** (~170 ms measured), instead of leaving it there — sometimes for hours. The disappearance used to depend on the `SessionEnd` hook, which doesn't fire on `/exit` or `/clear` ([anthropics/claude-code#17885](https://github.com/anthropics/claude-code/issues/17885), [#6428](https://github.com/anthropics/claude-code/issues/6428)) and is erratic on tab close ([#14760](https://github.com/anthropics/claude-code/issues/14760), [#45424](https://github.com/anthropics/claude-code/issues/45424)); when it stayed silent, the conversation only left once the 4 h recency window or the 30 min `done` fade expired — the "sometimes it works, but with a big latency" the panel used to show. Tab state now comes from VS Code (`onDidChangeTabs`), and the closed session's `sessions-state.json` entry is purged so it can't come back on the next snapshot, nor linger in another window. A tab closed mid-work removes the conversation too, `busy` or not.

### Added
- **Presence filter, applied to every snapshot**: a conversation with no matching tab open in any window is hidden. Running on every snapshot rather than at startup also cleans up the whole backlog for free — tabs closed while VS Code was off, conversations predating this version, conversations predating the hooks entirely (never present in `sessions-state.json`).
- **Tab union across VS Code windows**: each window publishes its Claude tab labels to `~/.claude/panel-tabs/<pid>.json` and judges presence on the union — otherwise each window would hide the conversations open in the others. One file per pid: a single writer per file, so no lock, and a dead window is cleaned up with an `unlink` (liveness by pid).
- `labels.js` — the tab-label ↔ conversation-title matching rule, extracted from `focus.js` and now shared with `state.js`/`tabs.js`. It decides both "where is this conversation's tab" and "is this conversation still open"; a second copy would be a second truth.

### Changed
- `SessionEnd` is downgraded to an opportunistic signal. It's kept (it costs nothing and cleans up when it does fire), but nothing depends on it any more.

### Known limitations
- A conversation whose title is still a fallback (no `ai-title` yet) is never hidden by the presence filter — its title can't be reliably matched against a tab label, so "no matching tab" proves nothing. It leaves the list the old way (4 h of inactivity, or an observed tab close).
- Conversations whose titles share their first 24 characters remain indistinguishable to the tab matcher (unchanged from 2.1.0).

## [2.1.0] - 2026-07-15

### Fixed
- **Clicking a conversation now actually focuses its tab.** The label match introduced in 2.0.0 was exact, but the Claude Code extension truncates tab labels to 24 characters plus an ellipsis (`Implémenter lot 4 burn-r…`) while the panel shows the full `ai-title` — so any conversation with a title longer than 24 characters silently matched nothing. Truncated labels are now matched as a prefix of the title.
- **Burn-rate thresholds now mean what the colours claim.** Red is `pace > 1.0`, i.e. red exactly when the projected end-of-window usage exceeds the quota. The previous defaults (green ≤ 0.8, yellow ≤ 1.2) painted a projection of 120% as merely "yellow". New defaults: `burnRateGreenMax` `0.8` → `0.85`, `burnRateYellowMax` `1.2` → `1.0`.

### Added
- **Cross-window tab focus.** The panel lists the conversations of the *workspace*, which may be open in several VS Code windows — so a clicked tab often lives in another window. The click is relayed through `~/.claude/panel-focus-request.json`; every window's instance watches it, the one owning the tab focuses it and raises its window (`raise-window.ps1`: `EnumWindows` + `SetForegroundWindow`, `AttachThreadInput` retry, taskbar flash as last resort). Measured, not assumed: Windows refuses the plain `SetForegroundWindow` from a background process, so the `AttachThreadInput` retry is what actually raises the window — the script reports which branch won (`raised (attach)`). Stale requests (> 3 s) are ignored, and an instance never answers its own.
- Tabs are now searched in **every editor group**, not just the active one (2.0.0 only looked at the active group, so a conversation in a split never matched).
- `raise-window.ps1 -ListOnly` — lists the VS Code windows the script can see without touching the foreground.

## [2.0.0] - 2026-07-15

### Added
- **Conversations & Quota panel**, docked in VS Code's Secondary Side Bar (right). Lists every recent conversation of the current workspace with its live state (`busy`/`waiting`/`done`/`stale`/`idle`), model, and context-window occupation — reactive via `fs.watch` on `~/.claude/sessions-state.json` and the workspace's transcripts, no polling.
- New hooks (`UserPromptSubmit` extended, `Stop`, `Notification`, `SessionEnd`) write per-session state to `~/.claude/sessions-state.json`, deployed idempotently by `install.ps1`.
- **Burn-rate colouring** on the 5h/7d quota bars: pace = percent used ÷ percent of window elapsed, green ≤ 0.8, yellow ≤ 1.2, red above — thresholds configurable (`claudeCodeQuotaBar.burnRateGreenMax`/`burnRateYellowMax`).
- Zero-hardcoded-model-list resolution (`hooks/model-id.js`): parses the model id schema instead of a lookup table, so a new model family (or one being retired, e.g. Fable 5) never produces a stale/wrong label — an unrecognized id is shown raw.

### Removed
- **The status bar item and its `statusBarAlignment` setting.** Superseded by the panel, which shows the same information (and per-conversation, not just the current tab) with real formatting a status bar text segment can't do. The "Open Usage Page" and "Refresh Now" commands are unchanged.
- All the duplicated status-bar-only model/context resolution code in `extension.js` (`MODEL_ID_MAP`, `referenceTranscriptPath`, `contextLabel`, etc.) — the panel's conversation list gets model/`ctx%` from `state.js` (via `hooks/model-id.js` and `hooks/transcript.js`), the single source of truth shared with the hooks.

### Known limitations (carried over, unchanged)
- Clicking a conversation is best-effort tab focus (VS Code exposes no tab↔session mapping, [microsoft/vscode#158853](https://github.com/microsoft/vscode/issues/158853)); no match → no-op rather than risk focusing the wrong tab.
- Requires VS Code 1.106+ for the Secondary Side Bar contribution.

## [1.5.1] - 2026-06-16

### Fixed
- **Model + `ctx:%` sometimes didn't follow the conversation when switching Claude tabs.** Root cause: both the model scan and the context scan picked the workspace transcript with the **most recent `mtime`**, not the conversation the user is actually working in — so when another tab finished a response, the bar stayed (or flipped) to *that* conversation regardless of focus, producing the "sometimes updates, sometimes not" behaviour. Introduced `referenceTranscriptPath()`: it resolves the **active session** first (`active-session.json` `session_id` → `<session_id>.jsonl`, since the transcript filename equals the session id), falling back to `mtime`-most-recent only when there's no fresh active session. Model and `ctx:%` now read the **same** reference transcript, so they're always mutually consistent and track the conversation where you last submitted a prompt.
- Known limit (unchanged, structural): VS Code does not expose the focused webview tab's session id to a third-party extension ([microsoft/vscode#158853](https://github.com/microsoft/vscode/issues/158853)), so the bar follows "the conversation you last typed in", not "the tab you're looking at". This is deterministic now (no more random flips) but switching to a tab without typing won't change the display.

## [1.5.0] - 2026-06-16

### Added
- **Context window occupation (`ctx:NN%`)** in the status bar, between the model name and the quota windows. The figure is the live `/context`-equivalent: the last assistant message of the active workspace transcript already carries `message.usage`, so occupation is read from the **same parse** as the model — `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — with no extra source, no network, no cookie.
- **Auto-detected denominator (200k vs 1M).** `detectContextWindow()` resolves the window, most-certain first: (1) always-1M API families (Opus 4.7/4.8, Fable 5); (2) **empirical guard** — any observed usage above 200k is necessarily a 1M session (Claude Code would have compacted otherwise), so the denominator self-corrects; (3) a `[1m]` alias in `settings.json` `model` (covers Sonnet/Opus 4.6 opt-in); (4) else 200k. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces 200k.
- Refresh is wired to the existing reactivity (the `active-session.json` watcher fires on every `UserPromptSubmit`, plus the Claude panel tab-switch and the periodic poll), so `ctx:%` reflects the window state at the start of each turn — what `/context` would report before you send.

### Notes
- VS Code status bar items can't colour a single text segment, so the percentage is plain text (no green/yellow/red sub-colouring like the native CLI statusline). The figure itself is authoritative.

## [1.4.3] - 2026-05-29

### Fixed
- **Model display flipped to the wrong version (`Opus 4.7`) after a window reload**, while showing the correct `Opus 4.8` during active work. Root cause: two Claude Code binaries running concurrently — a long-lived `claude remote-control` session on an older build (`.local\bin`, 2.1.154, which still resolves the `opus` alias to `claude-opus-4-7`) and the VS Code extension (2.1.156, `opus`→`claude-opus-4-8`). The RC session's status line periodically overwrites the **shared global** `~/.claude/current-model.json` with its own (stale) resolution. Right after a reload, on the first prompt, this session's fresh transcript has no assistant message yet, so the `track-active-session.js` hook fell back to that polluted global file and wrote `Opus 4.7` into `active-session.json` — which `modelLabel()` trusted as priority #1. Two fixes: (1) `modelLabel()` now reads the **per-session transcript first** (`message.model` is the real API-served model, never cross-session polluted), before `active-session.json` and the global cache; (2) the `track-active-session.js` hook no longer falls back to `current-model.json` — if the transcript has no model yet it writes nothing, letting the extension's transcript scan provide the truth.

## [1.4.2] - 2026-05-29

### Fixed
- **Model name lost its minor version for un-mapped model IDs.** The active model display relied on a hardcoded `MODEL_ID_MAP` table (frozen at `Opus 4.7`/`4.6`) with a regex fallback `/claude-([^-]+)-(\d+)/` that only captured the major version. For `claude-opus-4-8` (and any future ID not in the table) the fallback produced `Opus 4` — the `-8` was dropped at the dash. Fixed the fallback to `/claude-([a-z]+)-(\d+)-(\d+)/`, which captures `major.minor` and renders `Opus 4.8`, `Sonnet 4.6`, future `5.0`, etc. without any table to maintain (date-suffixed IDs like `claude-haiku-4-5-20251001` are handled too). Same fix applied to the twin `modelIdToDisplay()` in the `track-active-session.js` UserPromptSubmit hook (`~/.claude/scripts/`, outside this repo).

## [1.4.1] - 2026-05-25

### Fixed
- **Brave Octopus not killed after ephemeral spawn** (regression from 1.4.0). `closeOctopusBrave()` relied on async `Browser.close` CDP + a 500 ms `setTimeout` taskkill fallback; in the VSCode extension host, the timeout fired too late and the process stayed alive, leaving 10 Brave processes idle (~1 GB RAM) — defeating the entire point of 1.4.0. Rewritten to save the root `child.pid` at spawn time to `~/.claude/quota-brave-pid.json`, then synchronously `taskkill /PID <pid> /T /F` at close (plus a defense-in-depth PowerShell sweep filtered by `--user-data-dir=*BraveOctopus*`).

## [1.4.0] - 2026-05-25

### Changed
- **Zero persistent browser.** Empirical test on 2026-05-25 confirmed that `claude.ai/api/organizations/{id}/usage` accepts the `sessionKey` cookie alone (no `cf_clearance`, no `__cf_bm`, no TLS spoof needed from a residential IP). The extension now caches `sessionKey` at `~/.claude/quota-session-key.json` and uses a raw `https.get()` per tick. **Steady-state additional RAM: ~0** (vs ~1 GB for a persistent Brave Octopus instance in 1.3.x).
- Brave Octopus is spawned **ephemerally only** when the sessionKey cache is missing, when the API returns 401/403 (session rotated by Anthropic), or when org_id discovery fails. Cookie is extracted via browser-level CDP `Storage.getCookies`, then Brave is killed immediately. Typical refresh: ~10 s, happens roughly once every 30 days when the Anthropic session rotates.
- `refreshSessionKeyViaCdp()` only kills the Brave Octopus it spawned itself — never an instance an on-demand Playwright script may be using.

### Removed
- Persistent Brave Octopus lifecycle (`ensureOctopusBraveWithCDP` at activate, `closeOctopusBrave` at deactivate, dispose subscription).
- In-page `Runtime.evaluate` fetch path (`fetchInPage`, `findClaudeAiTarget`, `discoverOrgIdViaPage`, `fetchUsageViaCDP`).

### Notes
- Status bar tooltip now indicates `via cookie`, `via cookie-refreshed`, or `via oauth` depending on the path used.
- The OAuth fallback (rate-limited) is preserved as last resort.
- If Anthropic ever adds a Cloudflare JS challenge on the usage endpoint, raw `fetch()` will fail and the ephemeral Brave path also won't help — we'd need to bring back in-page fetch. Not a concern in 2026-05.

## [1.3.1] - 2026-05-25

### Fixed
- **`Cannot find module 'ws'` at activation.** The `ws` dependency added in 1.2.0 was excluded from the VSIX bundle by the default `.vscodeignore` (`node_modules/**`). Whitelisted `node_modules/ws/` so the extension can actually load. Note: 1.2.0 and 1.3.0 were both shipped broken — only 1.1.1 (which didn't use `ws`) was ever installable.

## [1.3.0] - 2026-05-25

### Changed
- **CDP target switched from Brave principal (9222) to Brave Octopus (9223).** The user's main Brave is no longer touched — no more `claude.ai/` background tab popping up in the daily browser at every refresh. Brave Octopus runs offscreen (`--window-position=-32000,-32000`) and is invisible by design.
- **Lifecycle bound to extension activation/deactivation**: Brave Octopus is spawned on `activate()` (best-effort, async) and gracefully shut down on `deactivate()` (Browser.close via CDP + taskkill fallback filtered by `--user-data-dir=BraveOctopus`). No orphan process between VSCode sessions.
- `fetchUsageViaCDP()` now calls `ensureOctopusBraveWithCDP()` first, so a fresh tick after a cold spawn waits up to 8 seconds for CDP to be reachable before falling back to OAuth.

### Notes
- The `claude.ai` session must be logged into the Brave Octopus profile (`C:\OctopusData\BraveOctopus\Default`). The OAuth fallback handles the case where it isn't.
- Coexistence with on-demand Playwright scripts (`Tools/BrowserAutomation/connect.mjs::attachToOctopusBrave`): both share the same browser instance via CDP. If a Playwright script is mid-run when VSCode closes, our `closeOctopusBrave()` will tear it down — acceptable trade-off given the rules in the BrowserAutomation CLAUDE.md.

## [1.2.0] - 2026-05-19

### Added
- **CDP path as primary fetch route**: when Brave is running with `--remote-debugging-port=9222` and a claude.ai session is logged in, the extension now fetches usage from `claude.ai/api/organizations/{org_id}/usage` via `Runtime.evaluate` in a background tab. This endpoint uses a **different rate-limit bucket** than `api.anthropic.com/api/oauth/usage`, which is currently subject to persistent 429s (Anthropic issues [#31021](https://github.com/anthropics/claude-code/issues/31021), [#31637](https://github.com/anthropics/claude-code/issues/31637)).
- Background tab on `https://claude.ai/` is reused across refreshes (not opened/closed per tick) — silent and unobtrusive once established.
- `org_id` discovered on first call via `/api/organizations`, cached at `~/.claude/quota-org-id.json` for subsequent runs; re-discovered on 401/403/404.
- OAuth path retained as **fallback** when CDP is unreachable (Brave not running, no claude.ai session).
- Tooltip now indicates the route used (`via cdp` / `via oauth`) and surfaces both error messages when both paths fail.

### Dependencies
- Added `ws@^8.18.0` for raw CDP WebSocket client.

### Notes
- Direct HTTPS fetch from Node with extracted cookies is blocked by Cloudflare (TLS fingerprint mismatch). The `Runtime.evaluate` approach uses Brave's own network stack and bypasses this transparently.

## [1.1.1] - 2026-05-16

### Removed
- Placeholder GitHub URLs (`repository`, `bugs`, `homepage`) from `package.json` — they pointed to a non-existent repo (404).

## [1.1.0] - 2026-05-16

### Added
- Display the **currently active Claude model** (e.g. `Opus 4.7`, `Sonnet 4.6`) at the start of the status bar item. The model name is read from `~/.claude/current-model.json`, which is written by a Claude Code `statusLine` hook (see README).
- If no model info is available (or older than 1 hour), the bar falls back to the previous `Claude` label.

### Changed
- Status bar text format: `$(cloud) <model> | 5h:X% (r:HH:MM)  7d:Y% (r:day HH:MM)` (model + separator + usage).

## [1.0.0] - 2026-05-14

Initial public release.

### Added
- Status bar widget showing Claude Code 5-hour and 7-day usage with reset times.
- Click handler opens `claude.ai/settings/usage`.
- Local cache for offline display.
- Configurable refresh interval (`claudeCodeQuotaBar.refreshIntervalMinutes`).
- Configurable status bar alignment (`claudeCodeQuotaBar.statusBarAlignment`).
- Manual refresh command (`Claude Code Quota: Refresh Now`).
