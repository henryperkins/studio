import { describe, expect, it, vi } from 'vitest';
import { createClaudeApprovalRouter } from 'cli/ai/claude-approval';
import type { ClaudeApprovalRequest } from '@studio/agent/node/claude-code/execution-policy';

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

describe( 'Claude approval routing', () => {
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
