import path from 'node:path';
import type {
	OwnedProcessSeams,
	ProcessProbe,
	SupervisedCommand,
} from '@studio/common/lib/owned-process';

/**
 * Windows ownership without native code. Studio's child stays in the job
 * object Node puts its children in, so Windows ends it with Studio's process.
 * Its descendants are tracked by a keeper: one PowerShell process that, for as
 * long as the child runs, polls for processes whose parent it already tracks
 * and started no earlier than that parent, and keeps a handle open to every
 * process it accepts. An open handle stops Windows from reusing that PID, so
 * a tracked parent's PID keeps naming it after it exits, and every kill goes
 * through the handle the start time was read from.
 *
 * What it cannot guarantee: a descendant whose parent was never seen by a
 * poll (a parent that started and exited between polls, as in a double fork)
 * is not found, nor is one that names another parent
 * (PROC_THREAD_ATTRIBUTE_PARENT_PROCESS) or is started for it by another
 * service (WMI, the Task Scheduler, a COM server). The polling costs a few
 * percent of one core while the child runs. It needs PowerShell in Full
 * Language mode.
 */
const FUNCTIONS = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Send($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

function Get-Start($p) {
	try { $null = $p.Handle; return [long]$p.StartTime.ToFileTimeUtc() } catch { return $null }
}

function Get-Rows($ids) {
	$parent = @{}; $created = @{}; $children = @{}
	foreach ($c in @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)) {
		$id = [long]$c.ProcessId
		$up = [long]$c.ParentProcessId
		$parent[$id] = $up
		if ($null -ne $c.CreationDate) { $created[$id] = [long]$c.CreationDate.ToFileTimeUtc() }
		if (-not $children.ContainsKey($up)) { $children[$up] = @() }
		$children[$up] += $id
	}
	$seen = @{}
	$todo = @($ids | ForEach-Object { [long]$_ })
	while ($todo.Count -gt 0) {
		$next = @()
		foreach ($id in $todo) {
			if ($seen.ContainsKey($id)) { continue }
			$seen[$id] = $true
			if ($children.ContainsKey($id)) { $next += $children[$id] }
		}
		$todo = $next
	}
	$rows = @(foreach ($id in @($seen.Keys)) {
		if ($id -le 0 -or -not $parent.ContainsKey($id)) { continue }
		$p = Get-Process -Id $id -ErrorAction SilentlyContinue
		if ($null -eq $p) { continue }
		$start = Get-Start $p
		# The snapshot and the handle must describe one process; the snapshot keeps microseconds.
		if ($null -ne $start -and (-not $created.ContainsKey($id) -or $created[$id] -ne ($start - ($start % 10)))) { $start = $null }
		[pscustomobject]@{ Id = $id; Parent = $parent[$id]; Start = $start; Process = $p }
	})
	return ,$rows
}

# The rows that descend from $tracked, whose PIDs the keeper's handles pin:
# a row is owned when it names an owned process as its parent and did not
# start before it. A row that would be owned but whose start cannot be read,
# or that names a tracked PID now showing another start, is uncertain.
function Select-Owned($tracked, $rows) {
	$owners = @{}
	foreach ($t in $tracked) { $owners[[long]$t.Id] = $t }
	$conflict = @{}
	foreach ($r in $rows) {
		$o = $owners[[long]$r.Id]
		if ($null -ne $o -and ($null -eq $r.Start -or $r.Start -ne $o.Start)) { $conflict[[long]$r.Id] = $true }
	}
	$owned = @(); $uncertain = @(); $taken = @{}
	do {
		$grew = $false
		foreach ($r in $rows) {
			$id = [long]$r.Id
			$parent = [long]$r.Parent
			if ($taken.ContainsKey($id)) { continue }
			if ($owners.ContainsKey($id) -and -not $conflict.ContainsKey($id)) { $taken[$id] = $true; continue }
			if ($conflict.ContainsKey($id) -or $conflict.ContainsKey($parent) -or ($owners.ContainsKey($parent) -and $null -eq $r.Start)) {
				$uncertain += $r
				$taken[$id] = $true
				continue
			}
			$up = $owners[$parent]
			if ($null -eq $up -or $r.Start -lt $up.Start) { continue }
			$owned += $r
			$owners[$id] = $r
			$taken[$id] = $true
			$grew = $true
		}
	} while ($grew)
	return @{ Owned = $owned; Uncertain = $uncertain }
}
`;

const KEEPER = String.raw`
$tracked = @{}
$uncertain = @()

function Update-Tracked {
	$found = Select-Owned @($tracked.Values) (Get-Rows @($tracked.Keys))
	foreach ($r in $found.Owned) { $tracked[[long]$r.Id] = [pscustomobject]@{ Id = [long]$r.Id; Start = [long]$r.Start; Process = $r.Process } }
	$script:uncertain = @($found.Uncertain)
}

function Get-Live {
	return @($tracked.Values | Where-Object { try { -not $_.Process.HasExited } catch { $true } })
}

function Invoke-Reap([int]$ms) {
	$deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
	while ($true) {
		$walked = $true
		try { Update-Tracked } catch { $walked = $false }
		$live = Get-Live
		if (($walked -and $live.Count -eq 0) -or [DateTime]::UtcNow -gt $deadline) { break }
		foreach ($t in $live) { try { $t.Process.Kill() } catch { } }
		foreach ($t in $live) { try { $null = $t.Process.WaitForExit(2000) } catch { } }
	}
	if ($walked -and $live.Count -eq 0 -and $uncertain.Count -eq 0) { Send 'reaped clean' } else { Send 'reaped dirty' }
}

$root = Get-Process -Id $rootId -ErrorAction SilentlyContinue
$rootStart = $null
if ($null -ne $root) { $rootStart = Get-Start $root }
if ($null -eq $rootStart) { Send 'failed'; exit 1 }
$tracked[[long]$rootId] = [pscustomobject]@{ Id = [long]$rootId; Start = $rootStart; Process = $root }
Send "ready $rootStart"

$stdin = [Console]::OpenStandardInput()
$buffer = New-Object byte[] 4096
$text = ''
$read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
$seen = @{}
$lastSnapshot = [DateTime]::MinValue
while ($true) {
	if ($read.Wait(500)) {
		$count = 0
		try { $count = $read.Result } catch { }
		if ($count -le 0) { Invoke-Reap 10000; exit 0 }
		$text += [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
		while (($end = $text.IndexOf([char]10)) -ge 0) {
			$line = $text.Substring(0, $end).TrimEnd([char]13)
			$text = $text.Substring($end + 1)
			if ($line -eq 'release') { exit 0 }
			if ($line -like 'gone*') { Invoke-Reap 10000; exit 0 }
			if ($line -match '^reap ([0-9]{1,7})$') { Invoke-Reap ([int]$Matches[1]) }
			if ($line -eq 'inspect') {
				try { Update-Tracked } catch { $script:uncertain = @([pscustomobject]@{ Id = 0 }) }
				foreach ($t in Get-Live) { Send "live $($t.Id) $($t.Start)" }
				foreach ($r in $uncertain) { Send "uncertain $($r.Id)" }
				Send 'inspected'
			}
		}
		$read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
		continue
	}
	# Snapshot when a process appeared anywhere, and at least every few seconds,
	# since a reused PID with the same name looks unchanged.
	try {
		$now = @{}
		$fresh = $false
		foreach ($p in [Diagnostics.Process]::GetProcesses()) {
			$key = [string]$p.Id + '/' + $p.ProcessName
			$now[$key] = $true
			if (-not $seen.ContainsKey($key)) { $fresh = $true }
		}
		$seen = $now
		if ($fresh -or ([DateTime]::UtcNow - $lastSnapshot).TotalSeconds -ge 3) {
			$lastSnapshot = [DateTime]::UtcNow
			Update-Tracked
		}
	} catch { }
}
`;

/** The keeper's functions followed by `main`, run as `mode`. */
export function windowsOwnedProcessScript( mode: string, main: string ): string {
	return `${ FUNCTIONS }\n$mode = '${ mode }'\n${ main }`;
}

function powerShellPath( env: NodeJS.ProcessEnv ): string {
	const systemRoot = systemRootOf( env );
	if ( ! systemRoot || ! path.win32.isAbsolute( systemRoot ) )
		throw new Error( 'Windows system root unavailable' );
	return path.win32.join( systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe' );
}

function systemRootOf( env: NodeJS.ProcessEnv ): string | undefined {
	return Object.entries( env ).find( ( [ name ] ) => name.toUpperCase() === 'SYSTEMROOT' )?.[ 1 ];
}

function powerShell(
	script: string,
	seams: OwnedProcessSeams,
	timeout: number
): SupervisedCommand {
	const systemRoot = systemRootOf( seams.env );
	return {
		command: powerShellPath( seams.env ),
		args: [
			'-NoProfile',
			'-NonInteractive',
			'-EncodedCommand',
			Buffer.from( script, 'utf16le' ).toString( 'base64' ),
		],
		env: systemRoot ? { SystemRoot: systemRoot } : {},
		timeout,
	};
}

/** The keeper for the process `rootId`: it verifies and tracks it, then answers `inspect`, `reap <ms>`, `release` and `gone`. */
export function windowsKeeperCommand(
	rootId: number,
	seams: OwnedProcessSeams
): SupervisedCommand {
	if ( ! Number.isSafeInteger( rootId ) || rootId <= 0 ) throw new Error( 'Invalid process ID' );
	return powerShell(
		windowsOwnedProcessScript( 'keeper', `$rootId = [long]${ rootId }\n${ KEEPER }` ),
		seams,
		60_000
	);
}

export async function probeWindowsProcess(
	pid: number,
	seams: OwnedProcessSeams
): Promise< ProcessProbe > {
	const helper = powerShell(
		windowsOwnedProcessScript(
			'identity',
			`$p = Get-Process -Id ${ pid } -ErrorAction SilentlyContinue
if ($null -eq $p) { Send 'gone' } else { $s = Get-Start $p; if ($null -eq $s) { Send 'unknown' } else { Send "start $s" } }`
		),
		seams,
		20_000
	);
	const result = await seams.run( helper.command, helper.args, {
		env: helper.env,
		timeout: helper.timeout,
	} );
	if ( result.code !== 0 ) return { state: 'unknown' };
	const line = result.stdout.split( /\r?\n/ ).find( Boolean );
	if ( line === 'gone' ) return { state: 'gone' };
	const start = /^start (\d{1,19})$/.exec( line ?? '' )?.[ 1 ];
	return start ? { state: 'running', start } : { state: 'unknown' };
}
