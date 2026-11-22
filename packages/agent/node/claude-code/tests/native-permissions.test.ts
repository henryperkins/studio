import { mkdir, realpath, symlink } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPolicyFixture } from './fixtures/execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

const cleanups: Array< () => Promise< void > > = [];
async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	return fixture;
}
afterEach( async () => {
	for ( const cleanup of cleanups.splice( 0 ) ) await cleanup();
} );

describe( 'native file tool permission callbacks', () => {
	it.each( [ false, true ] )(
		'shares concurrent decisions and journals once (recovery %s)',
		async ( recovery ) => {
			const { policy, context, site, journal, events } = await setup( () => ( {
				uncertainAfterRecovery: recovery,
			} ) );
			const file = path.join( site, 'new', 'page.md' );
			const input = { file_path: file, content: 'private new contents' };
			const use = { toolName: 'Write', toolUseId: 'same', input };
			await expect(
				Promise.all( [ policy.authorizeToolUse( use ), policy.authorizeToolUse( use ) ] )
			).resolves.toEqual( [ true, true ] );
			expect( context.approve ).toHaveBeenCalledTimes( recovery ? 1 : 0 );
			expect( journal ).toHaveLength( 1 );
			expect( journal[ 0 ].operation ).toMatchObject( {
				tool: 'Write',
				operationClass: 'local-change',
				filePath: file,
			} );
			expect( JSON.stringify( journal ) ).not.toContain( input.content );
			expect( events.filter( ( event ) => event.type === 'approval.requested' ) ).toHaveLength(
				recovery ? 1 : 0
			);
			expect(
				await policy.authorizeToolUse( { ...use, input: { ...input, content: 'changed' } } )
			).toBe( false );
			expect(
				await policy.authorizeToolUse( { ...use, toolName: 'Read', input: { file_path: file } } )
			).toBe( false );
			expect( journal ).toHaveLength( 1 );
		}
	);

	it( 'keeps the decision denied without journaling when another callback asks again', async () => {
		const { policy, context, site, journal } = await setup( () => ( {
			uncertainAfterRecovery: true,
			approve: vi.fn( async () => 'deny' as const ),
		} ) );
		const use = {
			toolName: 'Edit',
			toolUseId: 'denied',
			input: { file_path: path.join( site, 'new.txt' ), old_string: '', new_string: 'file' },
		};
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( journal ).toHaveLength( 0 );
	} );

	it( 'cancels a shared outstanding approval when either caller gives up', async () => {
		const { policy, site, context, journal } = await setup( () => ( {
			uncertainAfterRecovery: true,
			approve: vi.fn( () => new Promise< 'allow' >( () => {} ) ),
			approvalTimeoutMs: 30_000,
		} ) );
		const use = {
			toolName: 'Write',
			toolUseId: 'paired',
			input: { file_path: path.join( site, 'file.md' ), content: 'fixture' },
		};
		const first = policy.authorizeToolUse( use );
		await vi.waitFor( () => expect( context.approve ).toHaveBeenCalledOnce() );
		const callback = new AbortController();
		const second = policy.authorizeToolUse( use, callback.signal );
		callback.abort();
		await expect( Promise.all( [ first, second ] ) ).resolves.toEqual( [ false, false ] );
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( journal ).toHaveLength( 0 );
	}, 1500 );

	it( 'returns the same checked destination for either SDK spelling and consumes a matching completion once', async () => {
		const { policy, site, journal } = await setup();
		const folder = path.join( site, 'theme' );
		await mkdir( folder );
		const link = path.join( site, 'link' );
		await symlink( folder, link, 'junction' );
		const file = path.join( await realpath( folder ), 'DESIGN.md' );
		const input = { file_path: path.join( link, 'DESIGN.md' ), content: 'design' };
		const use = { toolName: 'Write', toolUseId: 'write', input };
		const rewritten = { ...input, file_path: file };
		expect( await policy.decideToolUse( use ) ).toEqual( { allowed: true, input: rewritten } );
		expect( await policy.decideToolUse( { ...use, input: rewritten } ) ).toEqual( {
			allowed: true,
			input: rewritten,
		} );
		expect( journal ).toHaveLength( 1 );
		expect( policy.takeNativeFileWrite( 'write', 'Edit', rewritten ) ).toBeUndefined();
		expect(
			policy.takeNativeFileWrite( 'write', 'Write', { ...input, content: 'different' } )
		).toBeUndefined();
		expect( policy.takeNativeFileWrite( 'write', 'Write', input ) ).toBe( file );
		expect( policy.takeNativeFileWrite( 'write', 'Write', rewritten ) ).toBeUndefined();
	} );

	it( 'checks the original path again after a recovery approval before journaling', async () => {
		const { policy, site, other, journal, context } = await setup( () => ( {
			uncertainAfterRecovery: true,
		} ) );
		const link = path.join( site, 'new' );
		vi.mocked( context.approve ).mockImplementation( async () => {
			await symlink( other, link, 'junction' );
			return 'allow';
		} );
		const use = {
			toolName: 'Write',
			toolUseId: 'swap',
			input: { file_path: path.join( link, 'file.txt' ), content: 'text' },
		};
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( journal ).toHaveLength( 0 );
	} );

	it( 'denies a duplicate callback cancelled during its final path check', async () => {
		const { policy, site, context } = await setup( () => ( { isStudioSite: async () => false } ) );
		await mkdir( path.join( site, 'wp-content' ) );
		await mkdir( path.join( site, 'wp-includes' ) );
		const use = {
			toolName: 'Write',
			toolUseId: 'write',
			input: { file_path: path.join( site, 'index.php' ), content: 'fixture' },
		};
		expect( await policy.authorizeToolUse( use ) ).toBe( true );
		let release!: ( value: boolean ) => void;
		const checking = vi.fn(
			() =>
				new Promise< boolean >( ( resolve ) => {
					release = resolve;
				} )
		);
		context.isStudioSite = checking;
		const callback = new AbortController();
		const repeated = policy.authorizeToolUse( use, callback.signal );
		await vi.waitFor( () => expect( checking ).toHaveBeenCalledOnce() );
		callback.abort();
		release( false );
		expect( await repeated ).toBe( false );
	} );

	it( 'refuses a destination redirected while its authorization is being synced', async () => {
		const { policy, site, other, context, journal } = await setup();
		const folder = path.join( site, 'new' );
		const record = context.recordOperation;
		context.recordOperation = async ( event ) => {
			await record( event );
			await symlink( other, folder, 'junction' );
		};
		const use = {
			toolName: 'Write',
			toolUseId: 'swap',
			input: { file_path: path.join( folder, 'file.txt' ), content: 'text' },
		};
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( journal ).toHaveLength( 1 );
		expect( policy.takeNativeFileWrite( 'swap', 'Write', use.input ) ).toBeUndefined();
	} );

	it( 'keeps the new contents in the live approval and out of its durable request', async () => {
		const saved: BackendTurnEvent[] = [];
		const visible: BackendTurnEvent[] = [];
		const { policy, site } = await setup( () => ( {
			uncertainAfterRecovery: true,
			onEvent: ( event, stored ) => {
				visible.push( event );
				saved.push( stored ?? event );
			},
		} ) );
		const input = { file_path: path.join( site, 'code.php' ), content: 'private file contents' };
		expect(
			await policy.authorizeToolUse( { toolName: 'Write', toolUseId: 'write', input } )
		).toBe( true );
		const live = visible.find( ( event ) => event.type === 'approval.requested' )!;
		const persisted = saved.find( ( event ) => event.type === 'approval.requested' )!;
		expect( live.requestId ).toBe( persisted.requestId );
		expect( JSON.parse( live.operation.args ) ).toEqual( input );
		expect( JSON.parse( persisted.operation.args ) ).toEqual( { file_path: input.file_path } );
		expect( JSON.stringify( saved ) ).not.toContain( input.content );
	} );

	it( 'rejects a write from the policy revision that only offered native Read', async () => {
		const { policy, site, journal } = await setup( () => ( { policyRevision: 1 } ) );
		const use = {
			toolName: 'Write',
			toolUseId: 'old',
			input: { file_path: path.join( site, 'file.txt' ), content: 'text' },
		};
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( journal ).toHaveLength( 0 );
	} );

	it( 'requires a fresh use ID after an unsupported field or a changed listing request', async () => {
		const { policy, site, journal } = await setup();
		const use = {
			toolName: 'Write',
			toolUseId: 'malformed',
			input: { file_path: path.join( site, 'file.txt' ), content: 'body' },
		};
		expect(
			await policy.authorizeToolUse( { ...use, input: { ...use.input, unsupported: true } } )
		).toBe( false );
		expect( await policy.authorizeToolUse( use ) ).toBe( false );
		expect( journal ).toHaveLength( 0 );
		const listing = {
			toolName: 'mcp__studio__Ls',
			toolUseId: 'ls',
			input: { limit: 2 },
			mcpServer: { name: 'studio', source: 'sdk' },
		};
		expect( await policy.authorizeToolUse( listing ) ).toBe( true );
		expect( await policy.authorizeToolUse( { ...listing, input: { limit: 3 } } ) ).toBe( false );
	} );
} );
