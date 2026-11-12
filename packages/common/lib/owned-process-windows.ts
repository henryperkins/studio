import path from 'node:path';
import type {
	OwnedProcessSeams,
	ProcessProbe,
	SupervisedCommand,
} from '@studio/common/lib/owned-process';

/**
 * Windows ownership through a kernel job object. A keeper (trusted Windows
 * PowerShell with static C# through Add-Type) creates the job before the
 * process starts, assigns the process to it as soon as it exists and holds
 * the only handle to the job. Windows puts every process that a job member
 * creates into the job too, unless the job permits breakaway, and this one
 * does not: a double fork, a re-parented child and a child started at any
 * moment all stay in it. Ending the job (TerminateJobObject), or closing its
 * handle once JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is set, terminates every
 * member. The keeper is this process's own child, so Windows ends it, and
 * with it the job, when this process ends.
 *
 * What the job does not cover: a process another service creates on the
 * run's behalf (WMI, the Task Scheduler, a COM server) is not a descendant and
 * is not in the job; nor is anything the process started before it was
 * assigned, which the keeper checks for its direct children. Needs PowerShell
 * in Full Language mode.
 */
const JOB_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace StudioOwned {
	public static class Job {
		const uint ProcessAccess = 0x0001 | 0x0100 | 0x1000 | 0x00100000;
		const uint QueryAccess = 0x1000;
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

		// Live children of the process "parent", created at "created" and kept
		// from reuse by the keeper's handle, other than its console host: all of
		// them when job is zero, otherwise those outside the job. -1 when they
		// cannot all be read.
		public static int Children(IntPtr job, uint parent, long created) {
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
						if (started < 0) return -1;
						if (started < created || IsConsoleHost(child)) continue;
						if (job == IntPtr.Zero || Contains(job, child) != 1) count++;
					} finally {
						CloseHandle(child);
					}
				}
			} finally {
				CloseHandle(snapshot);
			}
			return count;
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

// The keeper's protocol, one line each way:
//   prepared | failed keeper|job <code>            once the job exists
//   own <pid>   -> assigned <start> | failed open <code> | failed assign <code> <start>
//   confirm     -> ready <start> in-job | failed limit|verify <code> | failed outside <count>
//   children    -> children <count>   live children of the process, in the job or not
//   active      -> active <count>
//   inspect     -> live <pid> <start> ... inspected
//   reap <ms>   -> reaped clean|dirty
//   release, or the end of input: the keeper exits, closing the job.
// Kill on close is set only at `confirm`, once Studio knows the assigned
// process is its own child, so a keeper that ends before then kills nothing.
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
		$failure = [StudioOwned.Job]::Assign($job, $process)
		if ($failure -ne 0) { Send "failed assign $failure $start"; continue }
		Send "assigned $start"
	}
	elseif ($line -eq 'confirm') {
		$failure = [StudioOwned.Job]::KillOnClose($job)
		if ($failure -ne 0) { Send "failed limit $failure"; continue }
		if ([StudioOwned.Job]::Contains($job, $process) -ne 1) { Send 'failed verify 0'; continue }
		$outside = [StudioOwned.Job]::Children($job, $rootId, $start)
		if ($outside -ne 0) { Send "failed outside $outside"; continue }
		Send "ready $start in-job"
	}
	elseif ($line -eq 'children') { Send "children $([StudioOwned.Job]::Children([IntPtr]::Zero, $rootId, $start))" }
	elseif ($line -eq 'active') { Send "active $([StudioOwned.Job]::Active($job))" }
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
	return powerShell( KEEPER, seams, 60_000 );
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
