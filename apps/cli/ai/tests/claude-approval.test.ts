import { createPolicyFixture } from '@studio/agent/node/claude-code/tests/fixtures/execution-policy';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeApprovalRouter, getTerminalClaudeApprover } from 'cli/ai/claude-approval';
import type { ClaudeApprovalRequest } from '@studio/agent/node/claude-code/execution-policy';

const { question } = vi.hoisted( () => ( {
	question: vi.fn( async ( _prompt: string ) => 'yes' ),
} ) );
vi.mock( 'node:readline/promises', () => ( {
	createInterface: () => ( { question, once: vi.fn(), close: vi.fn() } ),
} ) );

function request( requestId: string ): ClaudeApprovalRequest {
	return Object.freeze< ClaudeApprovalRequest >( {
		requestId,
		runId: 'run',
		turnId: 'turn',
		toolCallId: 'call',
		connectionId: 'connection',
		connectionRevision: 1,
		policyRevision: 1,
		target: { environment: 'local', siteId: 'site' },
		operation: {
			tool: 'sites.wpCli',
			operationClass: 'command',
			args: [ 'post', 'create' ],
			siteId: 'site',
			localPaths: [],
			description: 'Create a draft post on the current local site',
		},
	} );
}

function terminalApprover() {
	const streams = [ process.stdin, process.stderr ];
	const originals = streams.map( ( stream ) => Object.getOwnPropertyDescriptor( stream, 'isTTY' ) );
	try {
		for ( const stream of streams )
			Object.defineProperty( stream, 'isTTY', { configurable: true, value: true } );
		return getTerminalClaudeApprover()!;
	} finally {
		streams.forEach( ( stream, index ) => {
			const original = originals[ index ];
			if ( original ) Object.defineProperty( stream, 'isTTY', original );
			else Reflect.deleteProperty( stream, 'isTTY' );
		} );
	}
}

describe( 'Claude approval routing', () => {
	it( 'shows the delete-files argument by name before taking a terminal answer', async () => {
		const original = request( 'delete' );
		const deletion = {
			...original,
			operation: { ...original.operation, tool: 'sites.delete', args: [ false ] },
		};
		await expect( terminalApprover()( deletion, new AbortController().signal ) ).resolves.toBe(
			'allow'
		);
		expect( question.mock.calls[ 0 ][ 0 ] ).toContain( '"deleteFiles": false' );
		expect( deletion.operation.args ).toEqual( [ false ] );
	} );

	it( 'shows the same invisible characters to a terminal and to the app for one approval', async () => {
		const title = 'My\u200bShop';
		const fixture = await createPolicyFixture( () => ( { approve: terminalApprover() } ) );
		try {
			const operation = {
				tool: 'sync.push',
				operationClass: 'remote-overwrite' as const,
				args: [ { direction: 'push', remoteSite: { name: title } } ],
				remote: title,
				localPaths: [ title ],
				description: `Push to ${ title }`,
			};
			const grant = await fixture.policy.requestApproval( operation, 'push' );
			expect( grant ).toBeDefined();
			const prompt = question.mock.calls.at( -1 )![ 0 ];
			expect( prompt ).toContain( 'Push to My\\u200bShop' );
			expect( prompt ).toContain( '"name": "My\\u200bShop"' );
			expect( prompt ).not.toContain( '\u200b' );
			expect( fixture.events ).toContainEqual(
				expect.objectContaining( {
					type: 'approval.requested',
					requestId: grant!.requestId,
					description: 'Push to My\\u200bShop',
					operation: expect.objectContaining( {
						remote: 'My\\u200bShop',
						localPaths: [ 'My\\u200bShop' ],
						args: expect.stringContaining( '"name": "My\\u200bShop"' ),
					} ),
				} )
			);
			expect( await fixture.policy.authorizeExecution( grant!, operation, 'push' ) ).toBe( true );
		} finally {
			await fixture.cleanup();
		}
	} );

	it( 'answers a pending request once, by its own ID, including after the app reconnects', async () => {
		const router = createClaudeApprovalRouter( { viaIpc: true } );
		const signal = new AbortController().signal;
		const first = router.approve( request( 'a' ), signal );
		const second = router.approve( request( 'b' ), signal );
		router.answer( { a: 'allow', unknown: 'allow', b: 'maybe' } );
		await expect( first ).resolves.toBe( 'allow' );
		router.answer( { a: 'deny' } );
		router.answer( { b: 'deny' } );
		await expect( second ).resolves.toBe( 'deny' );
	} );

	it( 'denies a cancelled request and ignores a reply that arrives after it', async () => {
		const router = createClaudeApprovalRouter( { viaIpc: true } );
		const controller = new AbortController();
		const pending = router.approve( request( 'a' ), controller.signal );
		controller.abort();
		await expect( pending ).resolves.toBe( 'deny' );
		router.answer( { a: 'allow' } );
		const next = router.approve( request( 'a' ), new AbortController().signal );
		router.cancelAll();
		await expect( next ).resolves.toBe( 'deny' );
	} );

	it( 'denies every pending request when the Studio app disconnects', async () => {
		const router = createClaudeApprovalRouter( { viaIpc: true } );
		const signal = new AbortController().signal;
		const pending = [
			router.approve( request( 'a' ), signal ),
			router.approve( request( 'b' ), signal ),
		];
		router.cancelAll();
		await expect( Promise.all( pending ) ).resolves.toEqual( [ 'deny', 'deny' ] );
		router.answer( { a: 'allow', b: 'allow' } );
	} );

	it( 'asks the terminal without a Studio app, and denies without either', async () => {
		const terminal = vi.fn( async () => 'allow' as const );
		const signal = new AbortController().signal;
		await expect(
			createClaudeApprovalRouter( { viaIpc: false, local: terminal } ).approve(
				request( 'a' ),
				signal
			)
		).resolves.toBe( 'allow' );
		expect( terminal ).toHaveBeenCalledWith( request( 'a' ), signal );
		await expect(
			createClaudeApprovalRouter( { viaIpc: false } ).approve( request( 'b' ), signal )
		).resolves.toBe( 'deny' );
	} );
} );
