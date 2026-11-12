# Recovering a locked Claude Code chat

A Claude Code turn locks its chat until Studio can prove that every process of the turn has ended. If Studio, or the turn's Claude Code process, stops unexpectedly, the lock stays and the chat cannot take another message.

Run `studio code claude recover --session <chat id>` to recover the chat. Studio releases the lock only when it can prove that the turn's processes have ended and that the chat's workspace and native history are still its own. It then records once that the turn was interrupted, closes the turn's pending approvals, and lists the operations that may or may not have taken effect. It replays nothing. The next turn resumes the same Claude Code conversation and tells Claude, once, that the previous turn was interrupted and which operations to check before repeating any of them.

When Studio cannot prove that the turn has ended, it changes nothing and says why: the CLI prints the result as JSON and the reason, with what to do next, on stderr. This document is the procedure for the reasons that have no automatic way forward. It is experimental, like the Claude Code runtime ([overview](claude-code-runtime.md)).

## Rules for doing this by hand

- **Never end a process by its name alone.** Ending every `claude` or `claude.exe` process also ends other Claude Code sessions, including ones you run outside Studio. End only a process you have identified by its process ID and start time, and by this chat's native session ID in its command line or by the exact identity the lock records.
- **Keep the lock as evidence.** Copy it before you change anything, then rename it. Never delete it.
- **If you are unsure, stop.** Keep the lock and start a new Claude Code chat. A new chat is always safe, and this chat's history stays available.

## Which reasons need this procedure

Wait first for the reasons that can resolve on their own, then try `recover` again:

- `owner-alive`, `native-alive`, `guardian-alive`, `descendants-alive`: a process of the last turn is still running. Wait for the turn to end, or quit the Studio app that ran it.
- `recovery-in-progress`: another Studio app is recovering the chat, or may be.
- `deletion-pending`, `lock-not-a-run`: Studio is deleting the chat, or was.
- `owner-unverifiable`, `native-unverifiable`, `guardian-unverifiable`, `descendants-unverifiable`, `lock-unreadable`, `recovery-failed`, `journal-unreadable`: Studio could not read something it needs. This is often momentary.

Follow this procedure when one of these does not go away once every Studio app is closed, or for these reasons:

| Reason | What it means |
| --- | --- |
| `legacy-lock` | An earlier version of Studio took the lock and recorded no process, so nothing shows which process held it. |
| `native-unowned` | Studio may have started the turn's Claude Code process but never confirmed that it owned it. This includes a turn that ended with `process_unconfirmed` because its process could not be put under Studio's control or exited before Studio confirmed it. |
| `native-alive`, `guardian-alive`, `descendants-alive` | A recorded process, or one that may descend from the turn's Claude Code process, is still running although every Studio app is closed. |
| `owner-unverifiable`, `native-unverifiable`, `guardian-unverifiable`, `descendants-unverifiable` | Studio keeps failing to read whether a process has ended. On Windows, see [Windows without CIM](#windows-without-cim). |
| `lock-unreadable` | The lock is empty, damaged or of a kind Studio does not know. An empty lock is what an interrupted creation leaves on a filesystem without hard links (see [Leftover files](#leftover-files)). |
| `lock-other-conversation`, `platform-mismatch` | The lock names another chat, or was written on another operating system. |
| `binding-mismatch`, `native-session-mismatch` | The lock does not match the chat's connection, workspace or Claude Code session. The chat cannot continue; start a new chat, and unlock this one only to clear it. |
| `lock-not-a-run` | A deletion holds the lock, and no Studio app is deleting the chat: the deletion was interrupted. A deletion lock records no process. |
| `deletion-pending` | Deleting the chat again reports that it is locked. |
| `recovery-claim-unreadable` | A claim on the chat's recovery is empty or names no process. An interrupted claim creation on a filesystem without hard links leaves it so (see [Leftover files](#leftover-files)). |
| `recovery-failed` | Recording the recovery or releasing the lock keeps failing. A recovery that recorded the interrupted turn before failing records nothing more when it is tried again. |
| `workspace-missing`, `native-session-missing`, `native-history-missing`, `journal-unreadable` | The chat cannot be resumed: its workspace or Claude configuration folder is gone, its Claude Code session or history cannot be found or verified, or its journal keeps failing to read. Start a new chat. This chat keeps its lock, so it cannot be deleted until you clear it: see [Clearing the lock of a chat that cannot be resumed](#clearing-the-lock-of-a-chat-that-cannot-be-resumed). |

## 1. Find the chat's files

You need the chat ID: `studio code sessions list` shows it.

Studio keeps a Claude Code chat's files in the `sessions.claude-code` folder of its configuration folder, `~/.studio` (`%USERPROFILE%\.studio` on Windows) unless `DEV_CONFIG_DIR` names another. Each file name starts with the SHA-256 of the chat ID, in lowercase hex:

```powershell
# Windows PowerShell or PowerShell 7
$chat = '<chat id>'
$hash = -join ( [Security.Cryptography.SHA256]::Create().ComputeHash( [Text.Encoding]::UTF8.GetBytes( $chat ) ) | ForEach-Object { $_.ToString( 'x2' ) } )
$store = Join-Path $HOME '.studio\sessions.claude-code'
Get-ChildItem $store -Filter "$hash*"
```

```sh
# macOS: use `shasum -a 256` in place of `sha256sum`.
hash=$(printf '%s' '<chat id>' | sha256sum | cut -d' ' -f1)
store="$HOME/.studio/sessions.claude-code"
ls -la "$store" | grep "$hash"
```

| File | What it is |
| --- | --- |
| `<hash>.json` | The chat's Claude Code session: its `nativeSessionId`, workspace and Claude configuration folder. |
| `<hash>.json.lock` | The lock. |
| `<hash>.json.deleting` | Left while Studio deletes the chat. |
| `<hash>.json.lock.<32 hex>.claim-<n>` | A recovery's claim on the lock (see [Leftover files](#leftover-files)). |
| `<hash>.json.lock.<random>.tmp` | Left by an interrupted lock or claim creation. Nothing reads it as a lock. |
| `<hash>-<64 hex>.journal.jsonl`, `<hash>.journal-order.json` | The chat's display journal. Leave these untouched. |

## 2. Quit Studio

Quit every Studio app and command that could run a turn or a recovery for this chat: the Desktop app, a `studio ui` server, and any `studio code` session. Each of them can hold the lock or a claim.

## 3. Copy the lock and read it

Copy the lock, the chat's session file and its journal files to a folder outside `sessions.claude-code`. They name local folders, so keep the copy private.

```powershell
$evidence = Join-Path $HOME "studio-claude-lock-$( Get-Date -Format yyyyMMdd-HHmm )"
New-Item -ItemType Directory $evidence | Out-Null
Copy-Item ( Join-Path $store "$hash*" ) $evidence
Get-Content ( Join-Path $store "$hash.json.lock" )
```

```sh
evidence="$HOME/studio-claude-lock-$(date +%Y%m%d-%H%M)"
mkdir "$evidence" && cp -p "$store/$hash"* "$evidence/"
cat "$store/$hash.json.lock"
```

What the lock holds:

- **Only a UUID**: a lock from an earlier version of Studio. It names no process.
- **JSON with `"purpose":"delete"`**: a deletion's lock. It names no process.
- **JSON with `"purpose":"run"`**: a turn's lock.
  - `owner`: the Studio process that ran the turn, as `{ "pid", "start" }`.
  - `stage`: `locked` when Studio had not yet asked the SDK to start the turn's Claude Code process; `starting` once it may have; `owned` once Studio confirmed owning it.
  - `session.nativeSessionId`: the Claude Code session the turn used (from `starting` on).
  - `processes.native` and `processes.guardian`: the turn's Claude Code process and the helper that ends its process tree if Studio dies (only in `owned`). On Windows the helper is a `powershell.exe` job keeper; on macOS and Linux it is a `node` process whose command line ends with `studio-owned-process-supervisor`.
  - `workspace.workingDirectory` and `workspace.configDirectory`: the folder the turn ran in and its Claude configuration folder.
- **Empty or not readable as either**: see [Leftover files](#leftover-files).

The chat's native session ID is the lock's `session.nativeSessionId`, or else the `nativeSessionId` in `<hash>.json`. If there is neither, no Claude Code process was ever given this chat's session.

## 4. Find the chat's processes

These processes belong to the chat:

1. The Studio process that ran the turn: the lock's `owner`.
2. The turn's Claude Code process. Studio's SDK starts it with `--resume=<native session id>` or `--session-id=<native session id>` on its command line. Its working directory is the lock's `workspace.workingDirectory`, and its environment sets `CLAUDE_CONFIG_DIR` to `workspace.configDirectory`.
3. The helper that guarded it: the lock's `processes.guardian`.
4. Every process that descends from the Claude Code process: its parent is that process, or one of its descendants, and it started after its parent.

A process the lock records is still that process only when its start time equals the recorded `start` exactly. A process with the same ID and another start time is a different process: leave it alone.

### Windows

These commands work the same in PowerShell 7 and Windows PowerShell 5.1. Find every process naming this chat's native session with CIM, which reads all command lines at once (in PowerShell 7, reading `CommandLine` through `Get-Process` asks for each process separately and can take minutes). `CreationDate` is precise to the microsecond, so compare every digit of the lock's `start` except the last:

```powershell
$session = '<native session id>'
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains( $session ) } |
	Select-Object ProcessId, ParentProcessId, @{ n = 'Start'; e = { $_.CreationDate.ToFileTimeUtc() } }, CommandLine
```

`Get-Process` reads a process's start to the full precision the lock records:

```powershell
# A process the lock records: the same process only when Start equals its "start".
# If no process has that ID, it has ended.
Get-Process -Id <pid> | Select-Object Id, @{ n = 'Start'; e = { $_.StartTime.ToFileTimeUtc() } }
```

To list the children of a process the lock records, whether or not it still runs, ask CIM, as Studio does. `<start>` is the lock's `start` for that process. CIM keeps a child's parent ID after the parent has exited, and reads creation times to the microsecond, so the recorded start is rounded down to the microsecond before it is compared. A process that names the same parent ID but started earlier is a child of an earlier process with that ID, and is left out:

```powershell
$after = [long]'<start>' - [long]'<start>' % 10
Get-CimInstance Win32_Process -Filter "ParentProcessId = <pid>" |
	Where-Object { $_.CreationDate.ToFileTimeUtc() -ge $after } |
	Select-Object ProcessId, @{ n = 'Start'; e = { $_.CreationDate.ToFileTimeUtc() } }, CommandLine
```

Run it again for each process it lists, with that process's `ProcessId` and `Start`, to find its children in turn. Do not use `Get-Process` for this: `Get-Process -Id` fails once the process has exited, and PowerShell 7 shows no `Parent` for a process whose parent has exited, which is when the list matters.

PowerShell does not show another process's working directory or environment. The session ID in the command line is enough to identify the Claude Code process. To check its working directory and `CLAUDE_CONFIG_DIR` as well, use Sysinternals Process Explorer: the process's properties show its current directory on the Image tab and its environment on the Environment tab.

#### Windows without CIM

When CIM (WMI) is turned off or broken, Studio cannot list the children of the turn's Claude Code process, so recovery reports `descendants-unverifiable` until CIM works again. `Get-Process` still shows start times and, in PowerShell 7, parents, but its `CommandLine` comes from CIM and stays empty. Read command lines in Task Manager instead: on the Details tab, right-click a column heading, choose Select columns and add Command line. Process Explorer shows them too.

### Linux

These commands have not yet been checked on a Linux host.

```sh
session='<native session id>'
# Every process naming this chat's native session, with its parent, group and start.
ps -eo pid,ppid,pgid,lstart,args | grep -F -- "$session" | grep -v grep
# Its working directory and Claude configuration folder.
readlink /proc/<pid>/cwd
tr '\0' '\n' < /proc/<pid>/environ | grep '^CLAUDE_CONFIG_DIR='
# A recorded process is the same one only when its start equals "linux:<boot id>:<ticks>".
cat /proc/sys/kernel/random/boot_id
sed -E 's/^.*\) //' /proc/<pid>/stat | cut -d' ' -f20
# Everything still in the group the turn's Claude Code process led.
ps -eo pid,ppid,pgid,lstart,args | awk -v group=<pgid> '$3 == group'
```

### macOS

These commands have not yet been checked on a macOS host.

```sh
session='<native session id>'
ps -eo pid,ppid,pgid,lstart,command | grep -F -- "$session" | grep -v grep
# Its working directory (for your own processes).
lsof -a -p <pid> -d cwd -Fn
# Its CLAUDE_CONFIG_DIR, spaces included: what follows "CLAUDE_CONFIG_DIR=" up to
# the next variable. A folder whose name contains " NAME=" would be cut short there.
ps -E -ww -p <pid> -o command= | sed -n 's/.* CLAUDE_CONFIG_DIR=//p' | sed -E 's/ [A-Za-z_][A-Za-z0-9_]*=.*$//'
# A recorded process is the same one only when its start equals this output exactly.
TZ=UTC LC_ALL=C ps -o lstart= -p <pid> | awk '{ $1 = $1; print "ps:" $0 }'
# Everything still in the group the turn's Claude Code process led.
ps -eo pid,ppid,pgid,lstart,command | awk -v group=<pgid> '$3 == group'
```

`ps` pads a day of the month before the 10th with a second space (`Nov  3`), while Studio records the start with single spaces (`ps:Tue Nov 3 09:15:02 2026`); the `awk` above collapses the spaces, so its output compares equal to the lock's `start`.

## 5. End the processes you identified

End only the processes you identified in step 4. Check each one's start time again right before you end it.

```powershell
Stop-Process -Id <pid>
```

```sh
kill <pid>          # then, only if it is still the same process after a few seconds:
kill -KILL <pid>
```

If a process you cannot identify by these rules is still running, stop here: keep the lock and start a new chat.

## 6. Set the lock aside

Rename the lock rather than deleting it. Leave the journal files as they are.

```powershell
Rename-Item ( Join-Path $store "$hash.json.lock" ) "$hash.json.lock.manual-$( Get-Date -Format yyyyMMdd-HHmm )"
```

```sh
mv "$store/$hash.json.lock" "$store/$hash.json.lock.manual-$(date +%Y%m%d-%H%M)"
```

For an interrupted deletion (`lock-not-a-run`, or `deletion-pending` with the chat still locked), set the lock aside the same way, then delete the chat again so Studio finishes clearing it.

## Leftover files

- **`.tmp` files.** An interrupted lock or claim creation leaves `<hash>.json.lock.<random>.tmp`, or a claim's own `.tmp` file. Nothing reads them. Once every Studio app is closed you can delete them; deleting the chat removes them too.
- **Claim files.** A recovery claims the lock it is recovering with `<hash>.json.lock.<32 hex>.claim-<n>`, which names the recovering process. A claim is live while that process runs: `recovery-in-progress` until it ends. A completed recovery removes its claim. A claim whose process has provably ended needs nothing from you: the next recovery takes it over, and deleting the chat removes it. Studio never removes a claim whose process is running or cannot be checked.
- **Filesystems without hard links** (FAT and exFAT, some network shares). There Studio creates the lock and its claims with an exclusive create and then writes and syncs the content through the same handle. A crash between the create and the write leaves an empty lock, reported as `lock-unreadable`, or an empty claim, reported as `recovery-claim-unreadable`. Follow this procedure for an empty lock. Move an empty claim aside once every Studio app is closed, then run `recover` again; deleting the chat leaves an unreadable claim in place, since Studio cannot tell whose it is. On other filesystems the content is written and synced under a temporary name and linked into place, so a crash leaves only a `.tmp` file.

## 7. Confirm

1. Run `studio code claude recover --session <chat id>`. It should report `not-locked`.
2. Check that `<hash>.json.lock` no longer exists and that the processes you ended are gone.
3. Send the chat's next message (`studio code sessions resume <chat id> <message>`). Studio checks the chat's workspace and native history before it sends anything; if they cannot be verified, it says to start a new chat.

A lock set aside by hand records no outcome for the interrupted turn and no list of operations that may or may not have taken effect, and Claude is not told that its previous turn was interrupted. Check the state of the site yourself before you ask Claude to repeat anything from that turn, and tell Claude that its previous turn was interrupted.

## Clearing the lock of a chat that cannot be resumed

With `workspace-missing`, `native-session-missing`, `native-history-missing`, or a `journal-unreadable` that does not go away, the chat cannot be resumed. Start a new chat to continue. For `workspace-missing`, restoring the folder where it was and running `recover` again is better, if you can.

The old chat keeps its lock, and Studio does not delete a locked chat: deleting it fails while the lock is there. Studio never clears that lock without proof that the turn has ended, so clear it by hand, then delete the chat:

1. Follow steps 1 to 5: find the chat's files, quit Studio, copy the lock and the journals as evidence, and prove with step 4 that the lock's `owner` and every process of the turn have ended: its Claude Code process, the helper that guarded it, and every process that descends from them. End only processes you identified (step 5). If you cannot prove that they have ended, stop: keep the lock, and leave the chat as it is.
2. Set the lock aside as in step 6, by renaming it to `.manual-<date>`. Do not delete it.
3. Delete the chat in the app, or with `studio code sessions delete <chat id>`. The deletion takes the lock itself and removes the chat's files. It keeps the `.manual-…` file, and your copy stays where you put it.
