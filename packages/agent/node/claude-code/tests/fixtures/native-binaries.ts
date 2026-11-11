import { createHash } from 'crypto';
import type {
	ClaudeCommandRunner,
	ClaudeFileAccess,
	ClaudeFileStat,
	ClaudePlatformSeams,
} from '../../platform';
import type { PlatformPath } from 'path';

/** A PE header: `MZ`, the PE signature, the COFF header and the optional header's magic. */
export function peBinary(
	options: {
		machine?: number;
		characteristics?: number;
		optionalMagic?: number;
		signature?: number;
		body?: string;
	} = {}
): Buffer {
	const buffer = Buffer.alloc( 160 );
	buffer.write( 'MZ' );
	buffer.writeUInt32LE( 64, 60 );
	buffer.writeUInt32LE( options.signature ?? 0x4550, 64 );
	buffer.writeUInt16LE( options.machine ?? 0x8664, 68 );
	buffer.writeUInt16LE( 0xf0, 64 + 4 + 16 );
	buffer.writeUInt16LE( options.characteristics ?? 0x0022, 64 + 4 + 18 );
	buffer.writeUInt16LE( options.optionalMagic ?? 0x20b, 64 + 24 );
	return Buffer.concat( [ buffer, Buffer.from( options.body ?? 'pe body' ) ] );
}

export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;
export const CPU_TYPE_POWERPC64 = 0x01000012;

/** A thin Mach-O header; `magic` is written little-endian, as on Intel and Apple silicon. */
export function machOBinary(
	cpuType: number,
	options: { magic?: number; bigEndian?: boolean; body?: string } = {}
): Buffer {
	const buffer = Buffer.alloc( 32 );
	if ( options.bigEndian ) {
		buffer.writeUInt32BE( options.magic ?? 0xfeedfacf, 0 );
		buffer.writeInt32BE( cpuType, 4 );
	} else {
		buffer.writeUInt32LE( options.magic ?? 0xfeedfacf, 0 );
		buffer.writeInt32LE( cpuType, 4 );
	}
	return Buffer.concat( [ buffer, Buffer.from( options.body ?? 'mach-o body' ) ] );
}

/** A universal (fat) Mach-O header, big-endian, with one slice per CPU type. */
export function universalBinary(
	cpuTypes: number[],
	options: { wide?: boolean; count?: number; body?: string } = {}
): Buffer {
	const entry = options.wide ? 32 : 20;
	const buffer = Buffer.alloc( 8 + entry * cpuTypes.length );
	buffer.writeUInt32BE( options.wide ? 0xcafebabf : 0xcafebabe, 0 );
	buffer.writeUInt32BE( options.count ?? cpuTypes.length, 4 );
	cpuTypes.forEach( ( cpuType, index ) => buffer.writeInt32BE( cpuType, 8 + entry * index ) );
	return Buffer.concat( [ buffer, Buffer.from( options.body ?? 'universal body' ) ] );
}

export const EM_X86_64 = 62;
export const EM_AARCH64 = 183;
export const EM_RISCV = 243;

/** A 64-bit ELF header with one program header, PT_INTERP when `interpreter` is given. */
export function elfBinary(
	machine: number,
	options: {
		interpreter?: string;
		elfClass?: number;
		data?: number;
		type?: number;
		body?: string;
	} = {}
): Buffer {
	const header = Buffer.alloc( 64 );
	header.write( '\x7fELF', 0, 'latin1' );
	header[ 4 ] = options.elfClass ?? 2;
	header[ 5 ] = options.data ?? 1;
	header[ 6 ] = 1;
	header.writeUInt16LE( options.type ?? 3, 16 );
	header.writeUInt16LE( machine, 18 );
	header.writeBigUInt64LE( BigInt( 64 ), 32 );
	header.writeUInt16LE( 56, 54 );
	header.writeUInt16LE( 1, 56 );
	const program = Buffer.alloc( 56 );
	const interpreter = options.interpreter ? Buffer.from( options.interpreter + '\0' ) : undefined;
	program.writeUInt32LE( interpreter ? 3 : 1, 0 );
	program.writeBigUInt64LE( BigInt( 120 ), 8 );
	program.writeBigUInt64LE( BigInt( interpreter?.length ?? 0 ), 32 );
	return Buffer.concat( [
		header,
		program,
		interpreter ?? Buffer.alloc( 0 ),
		Buffer.from( options.body ?? 'elf body' ),
	] );
}

export const GLIBC_X64 = '/lib64/ld-linux-x86-64.so.2';
export const GLIBC_ARM64 = '/lib/ld-linux-aarch64.so.1';
export const MUSL_X64 = '/lib/ld-musl-x86_64.so.1';

export function sha256( bytes: Buffer ): string {
	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );
}

type MemoryNode =
	| { kind: 'file'; bytes: Buffer; inode: number; version: number; mode: number }
	| { kind: 'directory'; inode: number }
	| { kind: 'symlink'; target: string; inode: number };

function missing( target: string ): Error {
	return Object.assign( new Error( `ENOENT: ${ target }` ), { code: 'ENOENT' } );
}

/**
 * A filesystem seam with symlinks that never touches the disk, for paths of
 * another OS than the one running the test.
 */
export function memoryFileSystem( pathModule: PlatformPath ) {
	const nodes = new Map< string, MemoryNode >();
	let inodes = 100;
	const key = ( target: string ) => pathModule.normalize( target );
	const ensureParents = ( target: string ) => {
		let parent = pathModule.dirname( key( target ) );
		while ( ! nodes.has( parent ) ) {
			nodes.set( parent, { kind: 'directory', inode: inodes++ } );
			const next = pathModule.dirname( parent );
			if ( next === parent ) break;
			parent = next;
		}
	};
	const resolve = ( target: string, followLast = true, depth = 0 ): string => {
		if ( depth > 32 ) throw Object.assign( new Error( 'ELOOP' ), { code: 'ELOOP' } );
		const normalized = key( target );
		const { root } = pathModule.parse( normalized );
		const parts = normalized.slice( root.length ).split( pathModule.sep ).filter( Boolean );
		let current = root;
		for ( let index = 0; index < parts.length; index++ ) {
			current = pathModule.join( current, parts[ index ] );
			const node = nodes.get( current );
			if ( ! node ) throw missing( target );
			if ( node.kind === 'symlink' && ( followLast || index < parts.length - 1 ) ) {
				const linked = pathModule.resolve( pathModule.dirname( current ), node.target );
				current = resolve( linked, true, depth + 1 );
			}
		}
		return current;
	};
	const stat = ( resolved: string ): ClaudeFileStat => {
		const node = nodes.get( resolved );
		if ( ! node ) throw missing( resolved );
		return {
			kind: node.kind,
			size: node.kind === 'file' ? node.bytes.length : 0,
			device: '7',
			inode: String( node.inode ),
			modified: String( node.kind === 'file' ? node.version : 0 ),
			changed: String( node.kind === 'file' ? node.version : 0 ),
			executable: node.kind === 'file' ? ( node.mode & 0o111 ) !== 0 : true,
		};
	};
	const files: ClaudeFileAccess = {
		realpath: async ( target ) => resolve( target ),
		stat: async ( target ) => stat( resolve( target ) ),
		lstat: async ( target ) => stat( resolve( target, false ) ),
		statSync: ( target ) => stat( resolve( target ) ),
		read: async ( target, position, length ) => {
			const node = nodes.get( resolve( target ) );
			if ( node?.kind !== 'file' ) throw missing( target );
			return Buffer.from( node.bytes.subarray( position, position + length ) );
		},
		sha256: async ( target ) => {
			const node = nodes.get( resolve( target ) );
			if ( node?.kind !== 'file' ) throw missing( target );
			return sha256( node.bytes );
		},
	};
	return {
		files,
		directory( target: string ) {
			ensureParents( pathModule.join( target, 'x' ) );
			nodes.set( key( target ), { kind: 'directory', inode: inodes++ } );
		},
		/** Writes a file; `inPlace` keeps the inode, as an in-place edit does. */
		write( target: string, bytes: Buffer, options: { mode?: number; inPlace?: boolean } = {} ) {
			ensureParents( target );
			const previous = nodes.get( key( target ) );
			const keep = options.inPlace && previous?.kind === 'file' ? previous : undefined;
			nodes.set( key( target ), {
				kind: 'file',
				bytes,
				inode: keep?.inode ?? inodes++,
				version: ( keep?.version ?? 0 ) + 1,
				mode: options.mode ?? keep?.mode ?? 0o755,
			} );
		},
		link( target: string, linked: string ) {
			ensureParents( target );
			nodes.set( key( target ), { kind: 'symlink', target: linked, inode: inodes++ } );
		},
		remove( target: string ) {
			nodes.delete( key( target ) );
		},
	};
}

export type RecordedCommand = { file: string; args: string[]; env: NodeJS.ProcessEnv };

/** A command runner seam that records each call and answers from `answer`. */
export function recordingRunner(
	answer: ( command: RecordedCommand ) => string | Error | Promise< string | Error >
) {
	const calls: RecordedCommand[] = [];
	const run: ClaudeCommandRunner = async ( file, args, options ) => {
		const command = { file, args: [ ...args ], env: { ...options.env } };
		calls.push( command );
		const result = await answer( command );
		if ( result instanceof Error ) throw result;
		return { stdout: result };
	};
	return { run, calls };
}

export function exitWith( code: number, stdout = '' ): Error {
	return Object.assign( new Error( `exit ${ code }` ), { code, stdout } );
}

export function spawnFailure( code = 'ENOENT' ): Error {
	return Object.assign( new Error( `spawn ${ code }` ), { code } );
}

/** Seams for a simulated host: its paths, files and commands, and nothing from this machine. */
export function simulatedHost(
	host: { platform: string; arch: string },
	pathModule: PlatformPath,
	seams: Partial< ClaudePlatformSeams > = {}
): { fs: ReturnType< typeof memoryFileSystem >; seams: Partial< ClaudePlatformSeams > } {
	const fs = memoryFileSystem( pathModule );
	return {
		fs,
		seams: {
			host,
			files: fs.files,
			env: {},
			hostLibc: () => 'glibc',
			findOnPath: () => null,
			username: () => 'tester',
			run: async () => {
				throw new Error( 'Unexpected command' );
			},
			launchDetached: async () => {
				throw new Error( 'Unexpected launch' );
			},
			...seams,
		},
	};
}
