import type {
	OwnedProcessSeams,
	ProcessProbe,
	SupervisedCommand,
} from '@studio/common/lib/owned-process';

/**
 * POSIX ownership: Studio's child starts a new session, so it leads a new
 * process group that its descendants join unless they leave it. POSIX does
 * not reuse a group's ID while any member remains, so the group is signalled
 * directly while Studio has not reaped the leader, and afterwards only when no
 * other process holds the leader's PID.
 *
 * What it cannot guarantee: a descendant that calls setsid() or setpgid()
 * (a daemonizing double fork, `setsid`, some job-control shells) leaves the
 * group and is not reached. Once the leader is reaped, a check and the signal
 * after it are separate system calls; only a complete wrap of the PID space in
 * between could make the group ID name an unrelated group.
 */

// Start identities. Linux: the boot id and the start time in clock ticks from
// /proc. Elsewhere: `ps` lstart in UTC, which has one-second resolution; macOS
// assigns PIDs sequentially, so reuse within a second needs a full wrap.
const PROBE = `probe() {
	if [ -r /proc/self/stat ]; then
		stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
		rest=\${stat##*) }
		set -- $rest
		case $1 in Z|X) return 1 ;; esac
		IFS= read -r boot < /proc/sys/kernel/random/boot_id || return 2
		printf 'linux:%s:%s' "$boot" "\${20}"
	else
		out=$(TZ=UTC LC_ALL=C ps -o stat= -o lstart= -p "$1" 2>/dev/null) || return 1
		[ -n "$out" ] || return 1
		set -- $out
		case $1 in Z*) return 1 ;; esac
		shift
		printf 'ps:%s' "$*"
	fi
}`;

// The supervisor's keeper: it waits, and once Studio's process is gone (a
// `gone` line, or the end of its input without `release`) it ends the group.
const KEEPER = `pgid=$1
token=$2
ours() {
	current=$(probe "$pgid")
	found=$?
	[ "$found" -eq 2 ] && return 1
	[ "$found" -eq 0 ] && [ "$current" != "$token" ] && return 1
	return 0
}
reap() {
	ours && kill -s TERM -- "-$pgid" 2>/dev/null
	i=0
	while [ "$i" -lt 20 ] && ours && kill -0 -- "-$pgid" 2>/dev/null; do
		sleep 0.1
		i=$((i + 1))
	done
	ours && kill -s KILL -- "-$pgid" 2>/dev/null
}
printf 'ready\\n'
while IFS= read -r line; do
	case $line in
		release) exit 0 ;;
		gone*) reap; exit 0 ;;
	esac
done
reap
exit 0`;

/** The shell function that prints a process's start identity exactly as Node reads it. */
export function posixProbeScript(): string {
	return PROBE;
}

/** The keeper a supervisor runs for the group led by `pgid`, whose leader started at `start`. */
export function posixKeeperCommand( pgid: number, start: string ): SupervisedCommand {
	return {
		command: '/bin/sh',
		args: [ '-c', `${ PROBE }\n${ KEEPER }`, 'sh', String( pgid ), start ],
		env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
		timeout: 30_000,
	};
}

function errnoCode( error: unknown ): string | undefined {
	return ( error as NodeJS.ErrnoException )?.code;
}

async function probeLinux( pid: number, seams: OwnedProcessSeams ): Promise< ProcessProbe > {
	let stat: string;
	try {
		stat = await seams.readFile( `/proc/${ pid }/stat` );
	} catch ( error ) {
		return errnoCode( error ) === 'ENOENT' || errnoCode( error ) === 'ESRCH'
			? { state: 'gone' }
			: { state: 'unknown' };
	}
	const fields = stat
		.slice( stat.lastIndexOf( ')' ) + 2 )
		.trim()
		.split( ' ' );
	if ( fields[ 0 ] === 'Z' || fields[ 0 ] === 'X' ) return { state: 'gone' };
	const ticks = fields[ 19 ];
	if ( ! ticks || ! /^\d+$/.test( ticks ) ) return { state: 'unknown' };
	let boot: string;
	try {
		boot = ( await seams.readFile( '/proc/sys/kernel/random/boot_id' ) ).trim();
	} catch {
		return { state: 'unknown' };
	}
	if ( ! /^[0-9a-f-]{8,64}$/i.test( boot ) ) return { state: 'unknown' };
	return { state: 'running', start: `linux:${ boot }:${ ticks }` };
}

const LSTART = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

async function probePs( pid: number, seams: OwnedProcessSeams ): Promise< ProcessProbe > {
	const { code, stdout } = await seams.run(
		'/bin/ps',
		[ '-o', 'stat=', '-o', 'lstart=', '-p', String( pid ) ],
		{ env: { TZ: 'UTC', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 10_000 }
	);
	const fields = stdout.trim().split( /\s+/ ).filter( Boolean );
	if ( code === 1 && ! fields.length ) return { state: 'gone' };
	if ( code !== 0 || ! fields.length ) return { state: 'unknown' };
	if ( fields[ 0 ].startsWith( 'Z' ) ) return { state: 'gone' };
	const start = fields.slice( 1 ).join( ' ' );
	return LSTART.test( start ) ? { state: 'running', start: `ps:${ start }` } : { state: 'unknown' };
}

export function probePosixProcess(
	pid: number,
	seams: OwnedProcessSeams
): Promise< ProcessProbe > {
	return seams.platform === 'linux' ? probeLinux( pid, seams ) : probePs( pid, seams );
}

/** The PIDs whose process group is `pgid`, or undefined when they cannot be listed. */
export async function posixGroupMembers(
	pgid: number,
	seams: OwnedProcessSeams
): Promise< number[] | undefined > {
	try {
		if ( seams.platform === 'linux' ) {
			const members: number[] = [];
			for ( const entry of await seams.readdir( '/proc' ) ) {
				if ( ! /^\d+$/.test( entry ) ) continue;
				let stat: string;
				try {
					stat = await seams.readFile( `/proc/${ entry }/stat` );
				} catch {
					continue;
				}
				const fields = stat
					.slice( stat.lastIndexOf( ')' ) + 2 )
					.trim()
					.split( ' ' );
				if ( Number( fields[ 2 ] ) === pgid ) members.push( Number( entry ) );
			}
			return members;
		}
		const { code, stdout } = await seams.run( '/bin/ps', [ '-A', '-o', 'pid=', '-o', 'pgid=' ], {
			env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
			timeout: 10_000,
		} );
		if ( code !== 0 ) return undefined;
		return stdout
			.trim()
			.split( '\n' )
			.map( ( line ) => line.trim().split( /\s+/ ).map( Number ) )
			.filter( ( [ pid, group ] ) => group === pgid && Number.isSafeInteger( pid ) )
			.map( ( [ pid ] ) => pid );
	} catch {
		return undefined;
	}
}
