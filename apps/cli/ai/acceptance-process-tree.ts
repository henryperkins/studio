import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Ends the process tree of a CLI process the acceptance runner started, and
 * nothing else. On Windows nothing chooses victims by parent id alone (Windows
 * keeps a process's parent id after that parent exits, and reuses ids): the
 * runner reads one snapshot of the process table, keeps only processes created
 * no earlier than their parent, and ends each on a handle it first checks the
 * creation time on. On POSIX the child leads a process group of its own.
 */

/** One process in a snapshot of the process table. */
export interface ProcessTableRow {
	pid: number;
	parentPid: number;
	/** When it was created: a Windows file time, in 100 ns units since 1601, UTC. */
	createdAt: bigint;
}

/**
 * The descendants of `rootPid` in one snapshot of the process table, deepest
 * first; null when the table doesn't list the root exactly once. A process
 * counts as a child only if it was created no earlier than its parent, so one
 * whose recorded parent is an earlier process that had the same id is never
 * taken. An id the table lists twice is never taken, nor anything below it.
 */
export function selectProcessTreeVictims(
	table: readonly ProcessTableRow[],
	rootPid: number
): ProcessTableRow[] | null {
	const listings = new Map< number, number >();
	for ( const row of table ) {
		listings.set( row.pid, ( listings.get( row.pid ) ?? 0 ) + 1 );
	}
	const unique = table.filter( ( row ) => listings.get( row.pid ) === 1 );
	const root = unique.find( ( row ) => row.pid === rootPid );
	if ( ! root ) {
		return null;
	}
	const children = new Map< number, ProcessTableRow[] >();
	for ( const row of unique ) {
		children.set( row.parentPid, [ ...( children.get( row.parentPid ) ?? [] ), row ] );
	}
	const taken = new Set< number >( [ rootPid ] );
	const levels: ProcessTableRow[][] = [];
	for ( let level = [ root ]; level.length > 0;  ) {
		const next: ProcessTableRow[] = [];
		for ( const parent of level ) {
			for ( const row of children.get( parent.pid ) ?? [] ) {
				if ( ! taken.has( row.pid ) && row.createdAt >= parent.createdAt ) {
					taken.add( row.pid );
					next.push( row );
				}
			}
		}
		if ( next.length > 0 ) {
			levels.push( next );
		}
		level = next;
	}
	return levels.reverse().flat();
}

const MAX_PID = 0xffffffff;
// BigInt calls, not literals: the CLI's TypeScript target predates them.
const NO_TIME = BigInt( 0 );
const MAX_FILE_TIME = BigInt( '9223372036854775807' );

/** The rows of a process table printed as `<pid> <parent pid> <file time>` lines; other lines are skipped. */
export function parseProcessTable( text: string ): ProcessTableRow[] {
	const rows: ProcessTableRow[] = [];
	for ( const line of text.split( /\r?\n/ ) ) {
		const match = /^(\d{1,10}) (\d{1,10}) (\d{1,19})$/.exec( line.trim() );
		if ( ! match ) {
			continue;
		}
		const pid = Number( match[ 1 ] );
		const parentPid = Number( match[ 2 ] );
		const createdAt = BigInt( match[ 3 ] );
		if (
			pid <= MAX_PID &&
			parentPid <= MAX_PID &&
			createdAt > NO_TIME &&
			createdAt <= MAX_FILE_TIME
		) {
			rows.push( { pid, parentPid, createdAt } );
		}
	}
	return rows;
}

export interface ProcessTreeTools {
	/** One snapshot of the whole process table; null when it couldn't be taken. */
	snapshot(): ProcessTableRow[] | null;
	/**
	 * Ends each process, in the order given, only when the handle that ends it
	 * shows the creation time the snapshot recorded; returns the ids it ended.
	 */
	end( victims: readonly ProcessTableRow[] ): number[];
}

// As the credential store starts it: Windows PowerShell, a fixed script as
// -EncodedCommand, and any data, only integers, over stdin.
const POWERSHELL = 'powershell.exe';
const POWERSHELL_TIMEOUT_MS = 15_000;

const SNAPSHOT_SCRIPT = `$ErrorActionPreference = 'Stop'
$invariant = [Globalization.CultureInfo]::InvariantCulture
foreach ($process in Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, CreationDate) {
	if ($process.CreationDate) {
		[Console]::Out.WriteLine([string]::Format($invariant, '{0} {1} {2}', $process.ProcessId, $process.ParentProcessId, $process.CreationDate.ToFileTimeUtc()))
	}
}`;

// Opening the handle first keeps the id from passing to another process: the
// creation time is read, and the process ended, on that one handle. The
// process table gives creation times to the microsecond, the handle to 100 ns.
const END_SCRIPT = `$ErrorActionPreference = 'Stop'
foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {
	$fields = $line.Trim().Split([char]32)
	$id = 0
	$created = [long]0
	if ($fields.Count -ne 2 -or -not [int]::TryParse($fields[0], [ref]$id) -or -not [long]::TryParse($fields[1], [ref]$created) -or $id -le 0 -or $created -le 0) { continue }
	$process = $null
	try {
		$process = [Diagnostics.Process]::GetProcessById($id)
		$null = $process.Handle
		$started = $process.StartTime.ToFileTimeUtc()
		if (($started - ($started % 10)) -eq ($created - ($created % 10))) {
			$process.Kill()
			[Console]::Out.WriteLine("ended $id")
		}
	} catch {
	} finally {
		if ($process) { $process.Dispose() }
	}
}`;

function runPowerShell( script: string, input: string ): string | null {
	const result = spawnSync(
		POWERSHELL,
		[
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
			Buffer.from( script, 'utf16le' ).toString( 'base64' ),
		],
		{
			input,
			encoding: 'utf8',
			windowsHide: true,
			timeout: POWERSHELL_TIMEOUT_MS,
			killSignal: 'SIGKILL',
			maxBuffer: 8 * 1024 * 1024,
		}
	);
	return result.error || result.status !== 0 ? null : result.stdout;
}

/** The process table and the identity-checked end, through Windows PowerShell. */
export const windowsProcessTreeTools: ProcessTreeTools = {
	snapshot() {
		const output = runPowerShell( SNAPSHOT_SCRIPT, '' );
		const rows = output === null ? [] : parseProcessTable( output );
		return rows.length > 0 ? rows : null;
	},
	end( victims ) {
		if ( victims.length === 0 ) {
			return [];
		}
		const input = victims
			.filter(
				( { pid, createdAt } ) =>
					Number.isSafeInteger( pid ) &&
					pid > 0 &&
					pid <= MAX_PID &&
					createdAt > NO_TIME &&
					createdAt <= MAX_FILE_TIME
			)
			.map( ( { pid, createdAt } ) => `${ pid } ${ createdAt }` )
			.join( '\n' );
		const output = runPowerShell( END_SCRIPT, input ) ?? '';
		return [ ...output.matchAll( /^ended (\d+)\r?$/gm ) ].map( ( [ , pid ] ) => Number( pid ) );
	},
};

type HeldChild = Pick< ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill' >;

/**
 * Exited as far as this process knows: until then it hasn't been reaped, so
 * its PID, and on POSIX its process group, can't belong to anything else.
 */
export const hasExited = ( child: Pick< ChildProcess, 'exitCode' | 'signalCode' > ) =>
	child.exitCode !== null || child.signalCode !== null;

/**
 * Ends a child's whole process tree while the child still runs. On Windows:
 * from one snapshot, its descendants deepest first, each on a handle whose
 * creation time matched, then the child itself on the handle this process
 * holds; `onDescendantsMayRemain` is called when there was no usable snapshot
 * (the child alone is ended) or a process it chose wasn't ended. On POSIX:
 * SIGKILL to the process group the child leads. Never anything by name, and
 * nothing once the child has exited.
 */
export function endProcessTree(
	child: HeldChild,
	{
		platform = process.platform,
		tools = windowsProcessTreeTools,
		onDescendantsMayRemain,
	}: {
		platform?: NodeJS.Platform;
		tools?: ProcessTreeTools;
		onDescendantsMayRemain: () => void;
	}
): void {
	const { pid } = child;
	if ( pid === undefined || hasExited( child ) ) {
		return;
	}
	if ( platform === 'win32' ) {
		const table = tools.snapshot();
		const victims = table && selectProcessTreeVictims( table, pid );
		if ( ! victims ) {
			onDescendantsMayRemain();
		} else {
			const ended = new Set( tools.end( victims ) );
			// One not ended may have exited meanwhile, or may still run: say so either way.
			if ( victims.some( ( victim ) => ! ended.has( victim.pid ) ) ) {
				onDescendantsMayRemain();
			}
		}
		// The snapshot and the ends ran synchronously, so nothing has reaped
		// the child meanwhile: this is still the handle it was started with.
		if ( ! hasExited( child ) ) {
			child.kill( 'SIGKILL' );
		}
		return;
	}
	try {
		process.kill( -pid, 'SIGKILL' );
	} catch {
		// No such group: the caller ends the child alone.
	}
}
