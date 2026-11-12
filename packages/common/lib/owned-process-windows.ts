import path from 'node:path';
import type {
	OwnedProcessSeams,
	ProcessIdentity,
	ProcessProbe,
	SupervisedCommand,
} from '@studio/common/lib/owned-process';

/**
 * Windows ownership through a kernel job object. A keeper (trusted Windows
 * PowerShell with static C# through Add-Type) creates the job before the
 * process starts, assigns the process to it as soon as it exists and holds
 * the only handle to the job. A process that a job member creates joins the
 * member's job, and this job permits no breakaway: a double fork, a detached
 * child and a child started at any moment all stay in it. Ending the job
 * (TerminateJobObject), or closing its handle once
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is set, terminates every member. The
 * keeper is this process's own child, so Windows ends it, and with it the
 * job, when this process ends.
 *
 * What the job does not cover:
 * - a process another service creates on the run's behalf (WMI, the Task
 *   Scheduler, a COM server), which is not a descendant;
 * - a process a member creates with PROC_THREAD_ATTRIBUTE_PARENT_PROCESS
 *   naming a process outside the job: it takes that process's job, not the
 *   creator's;
 * - anything the process started before it was assigned. The keeper checks
 *   its direct children for that, other than its console host.
 * Needs PowerShell in Full Language mode.
 */
const JOB_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace StudioOwned {
	public static class Job {
		const uint ProcessAccess = 0x0001 | 0x0100 | 0x1000 | 0x00100000;
		const uint QueryAccess = 0x1000;
		const uint EndAccess = 0x0001 | 0x1000;
		const uint KillOnJobClose = 0x2000;
		const int BasicAccountingInformation = 1;
		const int BasicProcessIdList = 3;
		const int ExtendedLimitInformation = 9;
		const int InvalidParameter = 87;

		[StructLayout(LayoutKind.Sequential)]
		struct BasicLimit {
			public long PerProcessUserTimeLimit;
			public long PerJobUserTimeLimit;
			public uint LimitFlags;
			public UIntPtr MinimumWorkingSetSize;
			public UIntPtr MaximumWorkingSetSize;
			public uint ActiveProcessLimit;
			public UIntPtr Affinity;
			public uint PriorityClass;
			public uint SchedulingClass;
		}

		[StructLayout(LayoutKind.Sequential)]
		struct IoCounters {
			public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
		}

		[StructLayout(LayoutKind.Sequential)]
		struct ExtendedLimit {
			public BasicLimit Basic;
			public IoCounters Io;
			public UIntPtr ProcessMemoryLimit;
			public UIntPtr JobMemoryLimit;
			public UIntPtr PeakProcessMemoryUsed;
			public UIntPtr PeakJobMemoryUsed;
		}

		[StructLayout(LayoutKind.Sequential)]
		struct Accounting {
			public long TotalUserTime;
			public long TotalKernelTime;
			public long ThisPeriodTotalUserTime;
			public long ThisPeriodTotalKernelTime;
			public uint TotalPageFaultCount;
			public uint TotalProcesses;
			public uint ActiveProcesses;
			public uint TotalTerminatedProcesses;
		}

		[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
		struct ProcessEntry {
			public uint Size;
			public uint Usage;
			public uint ProcessId;
			public IntPtr DefaultHeapId;
			public uint ModuleId;
			public uint Threads;
			public uint ParentProcessId;
			public int PriorityClassBase;
			public uint Flags;
			[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
		}

		[StructLayout(LayoutKind.Sequential)]
		struct BasicInformation {
			public IntPtr ExitStatus;
			public IntPtr PebBaseAddress;
			public UIntPtr AffinityMask;
			public IntPtr BasePriority;
			public UIntPtr UniqueProcessId;
			public UIntPtr InheritedFromUniqueProcessId;
		}

		[DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out BasicInformation info, int length, IntPtr returned);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
		[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint length, IntPtr returned);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, [Out] byte[] info, uint length, IntPtr returned);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
		[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
		[DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
		[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
		[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

		// The console host Windows starts for a console process when it is
		// created, before it can be assigned; it ends with its last client.
		static bool IsConsoleHost(IntPtr process) {
			StringBuilder name = new StringBuilder(1024);
			int size = name.Capacity;
			if (!QueryFullProcessImageNameW(process, 0, name, ref size)) return false;
			return string.Equals(name.ToString(), System.IO.Path.Combine(Environment.SystemDirectory, "conhost.exe"), StringComparison.OrdinalIgnoreCase);
		}

		public static IntPtr Create(out int error) {
			IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
			error = job == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
			return job;
		}

		public static IntPtr Open(uint pid, out int error) {
			IntPtr process = OpenProcess(ProcessAccess, false, pid);
			error = process == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
			return process;
		}

		public static long Created(IntPtr process) {
			long creation, exit, kernel, user;
			return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation : -1;
		}

		public static int Assign(IntPtr job, IntPtr process) {
			return AssignProcessToJobObject(job, process) ? 0 : Marshal.GetLastWin32Error();
		}

		// Kill on close, and no breakaway: a member's children always join the job.
		public static int KillOnClose(IntPtr job) {
			ExtendedLimit info = new ExtendedLimit();
			info.Basic.LimitFlags = KillOnJobClose;
			return SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit))) ? 0 : Marshal.GetLastWin32Error();
		}

		public static int Contains(IntPtr job, IntPtr process) {
			bool result;
			if (!IsProcessInJob(process, job, out result)) return -1;
			return result ? 1 : 0;
		}

		public static int Active(IntPtr job) {
			Accounting info;
			return QueryInformationJobObject(job, BasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) ? (int)info.ActiveProcesses : -1;
		}

		public static int Terminate(IntPtr job) {
			return TerminateJobObject(job, 1) ? 0 : Marshal.GetLastWin32Error();
		}

		// The ID of the process that created this one, read through its own
		// handle, or -1. A snapshot's parent ID belongs to whatever process had
		// the ID when the snapshot was taken; this one belongs to the handle.
		static long ParentOf(IntPtr process) {
			BasicInformation info;
			if (NtQueryInformationProcess(process, 0, out info, Marshal.SizeOf(typeof(BasicInformation)), IntPtr.Zero) != 0) return -1;
			return (long)info.InheritedFromUniqueProcessId.ToUInt64();
		}

		// Live children of the process "parent", created at "created" and kept
		// from reuse by the keeper's handle, that are outside the job, other than
		// its console host. -1 when they cannot all be read.
		public static int Outside(IntPtr job, uint parent, long created) {
			IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
			if (snapshot == new IntPtr(-1)) return -1;
			int count = 0;
			try {
				ProcessEntry entry = new ProcessEntry();
				entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
				for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
					if (entry.ParentProcessId != parent || entry.ProcessId == parent) continue;
					IntPtr child = OpenProcess(QueryAccess, false, entry.ProcessId);
					if (child == IntPtr.Zero) {
						if (Marshal.GetLastWin32Error() == InvalidParameter) continue;
						return -1;
					}
					try {
						long started = Created(child);
						long actual = ParentOf(child);
						if (started < 0 || actual < 0) return -1;
						if (actual != parent || started < created || IsConsoleHost(child)) continue;
						if (Contains(job, child) != 1) count++;
					} finally {
						CloseHandle(child);
					}
				}
			} finally {
				CloseHandle(snapshot);
			}
			return count;
		}

		// Whether a process created at "started" was created after the parent it
		// names. Creation times share a clock tick, so an equal time proves nothing.
		public static bool CreatedAfter(long started, long parentStarted) {
			return started > parentStarted;
		}

		// Opens each live process not yet in "held" whose parent, read through
		// its own handle, is held and that was created after that parent, and
		// adds it. null when the processes cannot be listed.
		static List<IntPtr> Descendants(Dictionary<uint, long> held) {
			IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
			if (snapshot == new IntPtr(-1)) return null;
			List<IntPtr> found = new List<IntPtr>();
			try {
				ProcessEntry entry = new ProcessEntry();
				entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
				for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
					if (held.ContainsKey(entry.ProcessId) || !held.ContainsKey(entry.ParentProcessId)) continue;
					IntPtr child = OpenProcess(EndAccess, false, entry.ProcessId);
					if (child == IntPtr.Zero) continue;
					long started = Created(child);
					long parent = ParentOf(child);
					long parentStarted;
					if (started >= 0 && parent >= 0 && parent <= uint.MaxValue && held.TryGetValue((uint)parent, out parentStarted) && CreatedAfter(started, parentStarted)) {
						held[entry.ProcessId] = started;
						found.Add(child);
					} else CloseHandle(child);
				}
			} finally {
				CloseHandle(snapshot);
			}
			return found;
		}

		// Ends the process "root", held since before it could exit, and every
		// descendant provable through handles: a process is taken only when its
		// parent, read through its own handle, is a process already held and it
		// was created after that parent. A held handle keeps its process's
		// ID from reuse, so nothing unrelated can match; a process whose parent
		// exited before it was held cannot be proven and is left alone. The
		// whole tree is held before anything is ended, since ending a process
		// can end others with it (its own kill-on-close jobs) before they are
		// held, leaving their children unprovable. Returns how many processes
		// were ended, or -1 when they could not be listed.
		public static int EndTree(IntPtr root, uint rootId, long rootStart) {
			Dictionary<uint, long> held = new Dictionary<uint, long>();
			held[rootId] = rootStart;
			List<IntPtr> handles = new List<IntPtr>();
			int ended = 0;
			try {
				for (int pass = 0; pass < 64; pass++) {
					List<IntPtr> found = Descendants(held);
					if (found == null) return -1;
					if (found.Count == 0) break;
					handles.AddRange(found);
				}
				if (TerminateProcess(root, 1)) ended++;
				foreach (IntPtr handle in handles) if (TerminateProcess(handle, 1)) ended++;
				// Children started while the tree was being held.
				for (int pass = 0; pass < 16; pass++) {
					List<IntPtr> found = Descendants(held);
					if (found == null) return -1;
					if (found.Count == 0) break;
					foreach (IntPtr child in found) {
						handles.Add(child);
						if (TerminateProcess(child, 1)) ended++;
					}
				}
			} finally {
				foreach (IntPtr handle in handles) CloseHandle(handle);
			}
			return ended;
		}

		// "pid start" for every live member of the job, one per line.
		public static string Members(IntPtr job) {
			byte[] buffer = new byte[8 + 4096 * IntPtr.Size];
			if (!QueryInformationJobObject(job, BasicProcessIdList, buffer, (uint)buffer.Length, IntPtr.Zero)) return null;
			int listed = BitConverter.ToInt32(buffer, 4);
			StringBuilder members = new StringBuilder();
			for (int index = 0; index < listed; index++) {
				uint pid = IntPtr.Size == 8 ? (uint)BitConverter.ToUInt64(buffer, 8 + index * 8) : BitConverter.ToUInt32(buffer, 8 + index * 4);
				IntPtr member = OpenProcess(QueryAccess, false, pid);
				if (member == IntPtr.Zero) continue;
				try {
					long started = Created(member);
					if (started >= 0 && Contains(job, member) == 1) members.Append(pid).Append(' ').Append(started).Append('\n');
				} finally {
					CloseHandle(member);
				}
			}
			return members.ToString();
		}
	}
}
`;

// The keeper's protocol, one line each way, after its script as the first line:
//   prepared | failed keeper language|<code> | failed job <code>   once the job exists
//   own <pid>   -> assigned <start> | failed open <code> | failed start 0 | failed assign <code> <start>
//   confirm     -> ready <start> in-job | failed limit|verify <code> | failed outside <count>
//   end-tree    -> ended <count>      ends the process and its descendants provable by handle
//   active      -> active <count>
//   inspect     -> live <pid> <start> ... inspected
//   reap <ms>   -> reaped clean|dirty
//   self        -> self <start>      the keeper's own creation time, -1 when unreadable
//   release, or the end of input: the keeper exits, closing the job.
// Studio sends `confirm` and `end-tree` only after it knows the opened process
// is its own child. Kill on close is set only at `confirm`, so a keeper that
// ends before then kills nothing.
const KEEPER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Send($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
$source = @'
${ JOB_SOURCE }
'@
try { Add-Type -TypeDefinition $source } catch { Send 'failed keeper 0'; exit 1 }
$failure = 0
$job = [StudioOwned.Job]::Create([ref]$failure)
if ($job -eq [IntPtr]::Zero) { Send "failed job $failure"; exit 1 }
Send 'prepared'
$process = [IntPtr]::Zero
$rootId = [uint32]0
$start = [long]-1
while ($true) {
	$line = [Console]::In.ReadLine()
	if ($null -eq $line -or $line -eq 'release') { exit 0 }
	if ($line -match '^own ([0-9]{1,10})$' -and $process -eq [IntPtr]::Zero) {
		$rootId = [uint32]$Matches[1]
		$process = [StudioOwned.Job]::Open($rootId, [ref]$failure)
		if ($process -eq [IntPtr]::Zero) { Send "failed open $failure"; continue }
		$start = [StudioOwned.Job]::Created($process)
		if ($start -lt 0) { Send 'failed start 0'; continue }
		$failure = [StudioOwned.Job]::Assign($job, $process)
		if ($failure -ne 0) { Send "failed assign $failure $start"; continue }
		Send "assigned $start"
	}
	elseif ($line -eq 'confirm') {
		$failure = [StudioOwned.Job]::KillOnClose($job)
		if ($failure -ne 0) { Send "failed limit $failure"; continue }
		if ([StudioOwned.Job]::Contains($job, $process) -ne 1) { Send 'failed verify 0'; continue }
		$outside = [StudioOwned.Job]::Outside($job, $rootId, $start)
		if ($outside -ne 0) { Send "failed outside $outside"; continue }
		Send "ready $start in-job"
	}
	elseif ($line -eq 'end-tree') {
		if ($start -lt 0) { Send 'ended -1' } else { Send "ended $([StudioOwned.Job]::EndTree($process, $rootId, $start))" }
	}
	elseif ($line -eq 'active') { Send "active $([StudioOwned.Job]::Active($job))" }
	elseif ($line -eq 'self') { Send "self $([StudioOwned.Job]::Created([System.Diagnostics.Process]::GetCurrentProcess().Handle))" }
	elseif ($line -eq 'inspect') {
		$members = [StudioOwned.Job]::Members($job)
		if ($null -eq $members) { Send 'uncertain' } else { foreach ($member in $members.Split([char]10)) { if ($member) { Send "live $member" } } }
		Send 'inspected'
	}
	elseif ($line -match '^reap ([0-9]{1,7})$') {
		$null = [StudioOwned.Job]::Terminate($job)
		$deadline = [DateTime]::UtcNow.AddMilliseconds([int]$Matches[1])
		while ([StudioOwned.Job]::Active($job) -ne 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
		if ([StudioOwned.Job]::Active($job) -eq 0) { Send 'reaped clean' } else { Send 'reaped dirty' }
	}
}
`;

// A process's identity, read through the handle Get-Process opens for it.
const IDENTITY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = Get-Process -Id $rootId -ErrorAction SilentlyContinue
if ($null -eq $p) { [Console]::Out.WriteLine('gone') } else {
	$s = $null
	try { $null = $p.Handle; $s = [long]$p.StartTime.ToFileTimeUtc() } catch { }
	if ($null -eq $s) { [Console]::Out.WriteLine('unknown') } else { [Console]::Out.WriteLine("start $s") }
}
`;

// The live processes that name $parentId as their parent, each with its
// creation time, then `listed`. CIM reads creation times to the microsecond.
const CHILDREN = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $parentId" -Property ProcessId,CreationDate)) {
	if ($null -eq $p.CreationDate) { [Console]::Out.WriteLine('unknown'); exit 0 }
	[Console]::Out.WriteLine("child $($p.ProcessId) $($p.CreationDate.ToFileTimeUtc())")
}
[Console]::Out.WriteLine('listed')
`;

// Starts the keeper. Its script is too long for a command line, which Windows
// caps at 32,767 characters, so it arrives as the first line of input: Base64
// UTF-8, written by Studio to a pipe only Studio holds. This part refuses to
// run outside Full Language mode, where the keeper's Add-Type would fail.
const KEEPER_LOADER = String.raw`
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'failed keeper language'; exit 1 }
$script = [Console]::In.ReadLine()
if ($null -eq $script) { exit 1 }
. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script))))
`;

function powerShell(
	script: string,
	seams: OwnedProcessSeams,
	timeout: number
): SupervisedCommand {
	const env: NodeJS.ProcessEnv = {};
	for ( const [ name, value ] of Object.entries( seams.env ) )
		if ( /^(SYSTEMROOT|TEMP|TMP)$/i.test( name ) ) env[ name ] = value;
	const systemRoot = Object.entries( env ).find(
		( [ name ] ) => name.toUpperCase() === 'SYSTEMROOT'
	)?.[ 1 ];
	if ( ! systemRoot || ! path.win32.isAbsolute( systemRoot ) )
		throw new Error( 'Windows system root unavailable' );
	return {
		command: path.win32.join(
			systemRoot,
			'System32',
			'WindowsPowerShell',
			'v1.0',
			'powershell.exe'
		),
		args: [
			'-NoProfile',
			'-NonInteractive',
			'-EncodedCommand',
			Buffer.from( script, 'utf16le' ).toString( 'base64' ),
		],
		env,
		timeout,
	};
}

/** The job keeper. Its script is the same for every run; it takes only protocol lines. */
export function windowsKeeperCommand( seams: OwnedProcessSeams ): SupervisedCommand {
	return {
		...powerShell( KEEPER_LOADER, seams, 60_000 ),
		input: Buffer.from( KEEPER, 'utf8' ).toString( 'base64' ),
	};
}

export async function probeWindowsProcess(
	pid: number,
	seams: OwnedProcessSeams
): Promise< ProcessProbe > {
	const helper = powerShell( `$rootId = [long]${ pid }\n${ IDENTITY }`, seams, 20_000 );
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

const MICROSECOND = BigInt( 10 );

/**
 * The live processes that name `parent` as their parent and were created no
 * earlier than it, to the microsecond CIM reports, or undefined when they
 * cannot all be listed. Windows keeps a parent ID after the parent exits and
 * reuses PIDs, so these may also be children of a later process with that ID;
 * for proving a tree ended, counting them is the safe side.
 */
export async function listWindowsChildren(
	parent: ProcessIdentity,
	seams: OwnedProcessSeams
): Promise< ProcessIdentity[] | undefined > {
	if ( ! /^\d{1,19}$/.test( parent.start ) ) return undefined;
	const helper = powerShell( `$parentId = [long]${ parent.pid }\n${ CHILDREN }`, seams, 30_000 );
	const result = await seams.run( helper.command, helper.args, {
		env: helper.env,
		timeout: helper.timeout,
	} );
	if ( result.code !== 0 ) return undefined;
	const lines = result.stdout.split( /\r?\n/ ).filter( Boolean );
	if ( lines.at( -1 ) !== 'listed' ) return undefined;
	const after = BigInt( parent.start ) / MICROSECOND;
	const children: ProcessIdentity[] = [];
	for ( const line of lines.slice( 0, -1 ) ) {
		const found = /^child (\d{1,10}) (\d{1,19})$/.exec( line );
		if ( ! found ) return undefined;
		if ( BigInt( found[ 2 ] ) / MICROSECOND >= after )
			children.push( { pid: Number( found[ 1 ] ), start: found[ 2 ] } );
	}
	return children;
}
