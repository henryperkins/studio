// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	endProcessTree,
	parseProcessTable,
	selectProcessTreeVictims,
	type ProcessTableRow,
	type ProcessTreeTools,
} from 'cli/ai/acceptance-process-tree';

/**
 * Made-up process tables only: nothing here lists, signals or ends a real
 * process. `process.kill` is replaced wherever the POSIX branch would call it.
 */
const row = ( pid: number, parentPid: number, createdAt: number ): ProcessTableRow => ( {
	pid,
	parentPid,
	createdAt: BigInt( createdAt ),
} );
const pids = ( rows: readonly ProcessTableRow[] | null ) => rows?.map( ( { pid } ) => pid ) ?? null;

describe( 'choosing the processes of a tree to end', () => {
	it( 'takes every descendant of the root, deepest first, and nothing else', () => {
		const table = [
			row( 4, 0, 10 ),
			row( 100, 4, 1_000 ),
			row( 200, 100, 1_100 ),
			row( 210, 100, 1_150 ),
			row( 300, 200, 1_200 ),
			row( 310, 300, 1_300 ),
			// Unrelated: a sibling of the root and its child.
			row( 400, 4, 500 ),
			row( 500, 400, 1_400 ),
		];
		const victims = selectProcessTreeVictims( table, 100 );
		expect( pids( victims ) ).toEqual( [ 310, 300, 200, 210 ] );
		// Each carries the creation time its end is checked against.
		expect( victims?.[ 0 ] ).toEqual( row( 310, 300, 1_300 ) );
	} );

	it( 'never takes a process whose recorded parent has the root’s id but was created before the root', () => {
		const table = [
			row( 100, 4, 1_000 ),
			row( 200, 100, 1_100 ),
			// Its own parent, an earlier process with id 100, has exited.
			row( 250, 100, 900 ),
			// That process's child, created after the root: still not the root's.
			row( 260, 250, 1_300 ),
		];
		expect( pids( selectProcessTreeVictims( table, 100 ) ) ).toEqual( [ 200 ] );
	} );

	it( 'never takes a descendant through a parent whose id was reused after it was created', () => {
		const table = [
			row( 100, 4, 1_000 ),
			// The root's child, started after the grandchild below was.
			row( 200, 100, 1_500 ),
			// Started by an earlier process 200 that has exited: out of reach.
			row( 300, 200, 1_200 ),
		];
		expect( pids( selectProcessTreeVictims( table, 100 ) ) ).toEqual( [ 200 ] );
	} );

	it( 'ends on a cycle of recorded parents, the root’s own included', () => {
		const table = [
			// 100 → 200 → 300 → 100, all created together.
			row( 100, 300, 1_000 ),
			row( 200, 100, 1_000 ),
			row( 300, 200, 1_000 ),
			// A process recorded as its own parent, and a cycle the root isn't in.
			row( 0, 0, 1 ),
			row( 600, 700, 1_100 ),
			row( 700, 600, 1_100 ),
		];
		expect( pids( selectProcessTreeVictims( table, 100 ) ) ).toEqual( [ 300, 200 ] );
		expect( pids( selectProcessTreeVictims( [ row( 100, 100, 1_000 ) ], 100 ) ) ).toEqual( [] );
	} );

	it( 'ends on a missing parent, and takes nothing when the root itself is missing or listed twice', () => {
		const table = [ row( 100, 4, 1_000 ), row( 900, 950, 1_100 ), row( 910, 900, 1_200 ) ];
		expect( pids( selectProcessTreeVictims( table, 100 ) ) ).toEqual( [] );
		expect( selectProcessTreeVictims( table, 123 ) ).toBeNull();
		expect( selectProcessTreeVictims( [], 100 ) ).toBeNull();
		expect(
			selectProcessTreeVictims( [ row( 100, 4, 1_000 ), row( 100, 4, 1_200 ) ], 100 )
		).toBeNull();
	} );

	it( 'takes no process whose id the table lists twice, nor anything below it', () => {
		const table = [
			row( 100, 4, 1_000 ),
			row( 200, 100, 1_100 ),
			row( 200, 100, 1_150 ),
			row( 300, 200, 1_200 ),
			row( 210, 100, 1_100 ),
		];
		expect( pids( selectProcessTreeVictims( table, 100 ) ) ).toEqual( [ 210 ] );
	} );
} );

describe( 'reading a process table', () => {
	it( 'keeps only lines of three integers in range, and nothing a line could smuggle in', () => {
		const text = [
			'4 0 133000000000000000',
			'100 4 134000000000000001\r',
			'',
			'  ',
			'200 100 0',
			'-1 4 134000000000000002',
			'300 100 1.5',
			'400 100 134000000000000003 extra',
			'4294967296 100 134000000000000004',
			'500 4294967295 99999999999999999999',
			'600 100 9223372036854775807',
			'& 100 134000000000000005',
		].join( '\n' );
		expect( parseProcessTable( text ) ).toEqual( [
			{ pid: 4, parentPid: 0, createdAt: BigInt( '133000000000000000' ) },
			{ pid: 100, parentPid: 4, createdAt: BigInt( '134000000000000001' ) },
			{ pid: 600, parentPid: 100, createdAt: BigInt( '9223372036854775807' ) },
		] );
	} );
} );

describe( 'ending a child’s process tree', () => {
	afterEach( () => {
		vi.restoreAllMocks();
	} );

	// A stand-in for a ChildProcess the runner holds: kill records, never signals.
	function fakeChild( overrides: { pid?: number; exitCode?: number | null } = {} ) {
		const log: string[] = [];
		const child = {
			pid: 'pid' in overrides ? overrides.pid : 100,
			exitCode: overrides.exitCode ?? null,
			signalCode: null,
			kill: vi.fn( ( signal?: NodeJS.Signals | number ) => {
				log.push( `kill-root:${ String( signal ) }` );
				return true;
			} ),
		};
		return { child, log };
	}

	function tools( log: string[], table: ProcessTableRow[] | null ): ProcessTreeTools {
		return {
			snapshot: () => {
				log.push( 'snapshot' );
				return table;
			},
			end: ( victims ) => {
				log.push( `end:${ victims.map( ( victim ) => victim.pid ).join( ',' ) }` );
				return victims.map( ( victim ) => victim.pid );
			},
		};
	}

	it( 'on Windows ends the descendants it chose from one snapshot, deepest first, then the root on its own handle', () => {
		const { child, log } = fakeChild();
		const onDescendantsMayRemain = vi.fn();
		const signal = vi.spyOn( process, 'kill' ).mockImplementation( () => true );
		endProcessTree( child, {
			platform: 'win32',
			tools: tools( log, [
				row( 100, 4, 1_000 ),
				row( 200, 100, 1_100 ),
				row( 300, 200, 1_200 ),
				row( 250, 100, 900 ),
			] ),
			onDescendantsMayRemain,
		} );
		expect( log ).toEqual( [ 'snapshot', 'end:300,200', 'kill-root:SIGKILL' ] );
		expect( onDescendantsMayRemain ).not.toHaveBeenCalled();
		expect( signal ).not.toHaveBeenCalled();
	} );

	it( 'on Windows, without a snapshot, ends only its own child and says descendants may remain', () => {
		const { child, log } = fakeChild();
		const onDescendantsMayRemain = vi.fn();
		const signal = vi.spyOn( process, 'kill' ).mockImplementation( () => true );
		endProcessTree( child, {
			platform: 'win32',
			tools: tools( log, null ),
			onDescendantsMayRemain,
		} );
		expect( log ).toEqual( [ 'snapshot', 'kill-root:SIGKILL' ] );
		expect( onDescendantsMayRemain ).toHaveBeenCalledTimes( 1 );
		expect( signal ).not.toHaveBeenCalled();

		// A snapshot without the child in it is no better.
		const second = fakeChild();
		endProcessTree( second.child, {
			platform: 'win32',
			tools: tools( second.log, [ row( 4, 0, 10 ), row( 200, 100, 1_100 ) ] ),
			onDescendantsMayRemain,
		} );
		expect( second.log ).toEqual( [ 'snapshot', 'kill-root:SIGKILL' ] );
		expect( onDescendantsMayRemain ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'touches nothing once its child has exited, or for a child that never started', () => {
		for ( const { child, log } of [
			fakeChild( { exitCode: 0 } ),
			fakeChild( { pid: undefined } ),
		] ) {
			const signal = vi.spyOn( process, 'kill' ).mockImplementation( () => true );
			for ( const platform of [ 'win32', 'linux' ] as const ) {
				endProcessTree( child, {
					platform,
					tools: tools( log, [ row( 100, 4, 1_000 ), row( 200, 100, 1_100 ) ] ),
					onDescendantsMayRemain: vi.fn(),
				} );
			}
			expect( log ).toEqual( [] );
			expect( signal ).not.toHaveBeenCalled();
		}
	} );

	it( 'on POSIX ends the process group its child leads, and lists nothing', () => {
		const { child, log } = fakeChild();
		const signal = vi.spyOn( process, 'kill' ).mockImplementation( () => true );
		endProcessTree( child, {
			platform: 'linux',
			tools: tools( log, null ),
			onDescendantsMayRemain: vi.fn(),
		} );
		expect( signal.mock.calls ).toEqual( [ [ -100, 'SIGKILL' ] ] );
		expect( log ).toEqual( [] );
	} );
} );
