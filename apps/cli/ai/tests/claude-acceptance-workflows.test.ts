import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	createNativeSessionStore,
	getClaudeSessionStoreRoot,
} from '@studio/agent/node/claude-code/sessions';
import { inspectWpCliArgs } from '@studio/agent/node/claude-code/wp-cli-rules';
import { appendStudioEntry, createAiSession } from '@studio/agent/node/sessions/store';
import { splitCommandArgs } from '@studio/agent/node/tools/wp-cli';
import { afterEach, expect, it, vi } from 'vitest';
import { runClaudeAcceptanceTurn } from '../claude-acceptance-process';
import { runClaudeAcceptanceWorkflows } from '../claude-acceptance-workflows';
import type { ClaudeAcceptanceWorkflowStage } from '../claude-acceptance-workflows';

vi.mock( '../claude-acceptance-process', () => ( { runClaudeAcceptanceTurn: vi.fn() } ) );
const roots: string[] = [];
afterEach( async () => {
	vi.resetAllMocks();
	await Promise.all(
		roots.splice( 0 ).map( ( root ) => rm( root, { recursive: true, force: true } ) )
	);
} );

type Fault =
	| 'wrong-read'
	| 'missing-read'
	| 'denied-write'
	| 'stopped-write'
	| 'bad-metadata'
	| 'side-effect'
	| 'wrong-id'
	| 'stale-effort'
	| 'same-owner'
	| 'lost-history'
	| 'no-late-answer'
	| 'observer-error'
	| 'cancel-before-start';

async function exercise( fault?: Fault ) {
	const cwd = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-workflow-' ) )
	);
	roots.push( cwd );
	const sessionsRoot = path.join( cwd, 'sessions' );
	const selection = { model: 'sonnet', effort: 'medium' as const };
	const site = { name: 'Acceptance', id: 'local-test', path: cwd };
	const binding = {
		connectionId: 'fixture',
		siteId: site.id,
		workingDirectory: cwd,
		configDirectory: cwd,
	};
	const { id: sessionId } = await createAiSession( sessionsRoot, {
		site,
		claude: { binding, selection },
	} );
	await createNativeSessionStore( getClaudeSessionStoreRoot( sessionsRoot ) ).create( {
		...binding,
		backend: 'claude-code',
		conversationId: sessionId,
		nativeSessionId: randomUUID(),
		accountKey: 'a'.repeat( 64 ),
	} );
	const posts = [ { ID: 1, post_content: 'Sample', post_status: 'publish', post_title: 'Hello' } ];
	let storedMarker = '';
	let storedMeta = '';
	let calls = 0;
	const stages: ClaudeAcceptanceWorkflowStage[] = [];
	const runCli = vi.fn( async ( args: string[] ) => {
		if ( args[ 0 ] === 'wp' ) {
			expect( args.slice( 0, 3 ) ).toEqual( [ 'wp', '--path', site.path ] );
			if ( args[ 3 ] === 'option' && args[ 4 ] === 'add' ) {
				storedMarker = args[ 6 ];
				return '';
			}
			if ( args[ 3 ] === 'post' && args[ 4 ] === 'list' ) {
				if ( fault === 'observer-error' ) throw new Error( 'unsafe-fixture-value' );
				return JSON.stringify( posts );
			}
			if ( args[ 3 ] === 'post' && args[ 4 ] === 'meta' ) {
				expect( args.slice( 5 ) ).toEqual( [ 'get', '2', 'studio_acceptance' ] );
				return fault === 'bad-metadata' ? '' : storedMeta;
			}
		}
		expect( args ).toEqual( [
			'code',
			'claude',
			'select',
			'--session',
			sessionId,
			'--model',
			'sonnet',
			'--effort',
			'high',
		] );
		if ( fault !== 'stale-effort' ) {
			await appendStudioEntry( sessionsRoot, sessionId, 'studio.claude_selection', {
				model: selection.model,
				effort: 'high',
			} );
		}
		return '';
	} );
	vi.mocked( runClaudeAcceptanceTurn ).mockImplementation( async ( options ) => {
		calls++;
		const ids = { runId: randomUUID(), turnId: randomUUID() };
		const toolCallId = randomUUID();
		const approval = options.approvals?.[ 0 ];
		const decision = approval?.decision;
		const stopped = decision === 'interrupt';
		const prompt = options.payload.prompt!;
		if ( calls === 1 ) {
			expect( prompt ).toContain(
				`Set nameOrPath to its Studio ID ${ JSON.stringify( site.id ) }.`
			);
		} else if ( approval ) {
			expect( prompt ).toContain( `Set nameOrPath to ${ JSON.stringify( site.name ) }.` );
		}
		expect( options.payload.claudeContext ).toEqual( {
			connectionId: 'fixture',
			revision: 1,
			target: { environment: 'local', siteId: site.id },
		} );
		expect( options.payload.claudeSelection ).toEqual( {
			model: 'sonnet',
			effort: calls >= 4 ? 'high' : 'medium',
		} );
		const reply = ( text: string ) =>
			options.onEvent?.( {
				...ids,
				type: 'content.confirmed',
				messageId: 'm',
				blockId: '0',
				blockType: 'text',
				text,
			} );
		const wpResult = ( value: string, isError: boolean ) => {
			options.onEvent?.( { ...ids, type: 'tool.started', toolCallId, name: 'wp_cli' } );
			options.onEvent?.( { ...ids, type: 'tool.result', toolCallId, message: value, isError } );
		};
		if ( approval ) {
			expect( options.allowedTools ).toEqual( [ 'wp_cli' ] );
			const argv = splitCommandArgs( prompt.split( '\n' )[ 1 ] );
			expect( approval ).toEqual( {
				decision,
				toolName: 'wp_cli',
				operation: {
					tool: 'sites.wpCli',
					target: { environment: 'local', siteId: site.id },
					operationClass: 'command',
					args: JSON.stringify( { command: argv } ),
					localPaths: [ site.path ],
				},
			} );
			expect( inspectWpCliArgs( argv ) ).toMatchObject( {
				known: false,
				operationClass: 'command',
				files: [],
			} );
			const arg = ( name: string ) =>
				argv.find( ( value ) => value.startsWith( name + '=' ) )!.slice( name.length + 1 );
			expect( argv.slice( 0, 2 ) ).toEqual( [ 'post', 'create' ] );
			expect( argv ).toContain( '--porcelain' );
			if (
				decision === 'allow' ||
				( decision === 'deny' && fault === 'denied-write' ) ||
				( stopped && fault === 'stopped-write' )
			) {
				posts.push( {
					ID: posts.length + 1,
					post_title: arg( '--post_title' ),
					post_content: arg( '--post_content' ),
					post_status: arg( '--post_status' ),
				} );
				storedMeta = JSON.parse( arg( '--meta_input' ) ).studio_acceptance;
			}
			if ( decision === 'allow' && fault === 'side-effect' ) posts[ 0 ].post_content = 'Changed';
			if ( ! stopped ) wpResult( fault === 'wrong-id' ? '3' : '2\\u000d\n', decision === 'deny' );
		} else {
			expect( prompt ).not.toContain( storedMarker );
			if ( calls === 1 ) {
				expect( options.allowedTools ).toEqual( [ 'wp_cli' ] );
				if ( fault !== 'missing-read' )
					wpResult( fault === 'wrong-read' ? 'other' : storedMarker, false );
				reply( storedMarker );
			} else {
				expect( options.allowedTools ).toEqual( [] );
				reply( fault === 'lost-history' ? 'unknown' : storedMarker );
			}
		}
		return {
			...ids,
			ownerPid: fault === 'same-owner' ? 100 : 100 + calls,
			ok: true,
			observations: {
				terminalSuccess: ! stopped,
				terminalInterrupted: stopped,
				exitMatched: true,
				approvalRequests: approval ? 1 : 0,
				approvalsResolved: approval ? 1 : 0,
				lateAnswerSent: stopped && fault !== 'no-late-answer',
				questionAnswered: false,
				confirmedBlocks: 1,
				toolResults: options.allowedTools.length,
			},
		};
	} );
	const signal = new AbortController();
	if ( fault === 'cancel-before-start' ) signal.abort();
	const passed = await runClaudeAcceptanceWorkflows(
		{
			cliPath: 'unused',
			cwd,
			env: {},
			sessionsRoot,
			sessionId,
			site,
			connectionId: binding.connectionId,
			revision: 1,
			selection,
			nextEffort: 'high',
			runCli,
			signal: signal.signal,
		},
		( record ) => {
			stages.push( record );
		}
	);
	const serialized = JSON.stringify( stages );
	for ( const privateValue of [
		cwd,
		sessionId,
		storedMarker,
		storedMeta,
		'unsafe-fixture-value',
	].filter( Boolean ) ) {
		expect( serialized ).not.toContain( privateValue );
	}
	return { passed, stages, calls };
}

it( 'checks the WordPress rows, exact permission, saved selection and native history across independent owners', async () => {
	const { passed, stages, calls } = await exercise();
	expect( passed ).toBe( true );
	expect( calls ).toBe( 5 );
	expect( stages.map( ( stage ) => [ stage.name, stage.status ] ) ).toEqual(
		[
			'site-read',
			'denied-draft',
			'allowed-draft',
			'change-effort',
			'fresh-owner-resume',
			'stop-pending-approval',
		].map( ( name ) => [ name, 'passed' ] )
	);
	expect( stages[ 2 ].observations ).toMatchObject( {
		newPosts: 1,
		previousPostsUnchanged: true,
		draftMatches: true,
		returnedIdMatches: true,
		metadataMatches: true,
	} );
} );

it.each( [
	[ 'wrong-read', 'site-read', 'site-read-mismatch' ],
	[ 'missing-read', 'site-read', 'site-read-mismatch' ],
	[ 'denied-write', 'denied-draft', 'denied-draft-written' ],
	[ 'bad-metadata', 'allowed-draft', 'meta-mismatch' ],
	[ 'side-effect', 'allowed-draft', 'prior-post-changed' ],
	[ 'wrong-id', 'allowed-draft', 'draft-mismatch' ],
	[ 'stale-effort', 'change-effort', 'selection-mismatch' ],
	[ 'same-owner', 'fresh-owner-resume', 'resume-mismatch' ],
	[ 'lost-history', 'fresh-owner-resume', 'resume-mismatch' ],
	[ 'no-late-answer', 'stop-pending-approval', 'missing-late-answer' ],
	[ 'stopped-write', 'stop-pending-approval', 'stopped-draft-written' ],
	[ 'observer-error', 'denied-draft', 'workflow-error' ],
	[ 'cancel-before-start', 'site-read', 'cancelled' ],
] as const )( 'rejects %s and stops at %s', async ( fault, name, code ) => {
	const { passed, stages } = await exercise( fault );
	expect( passed ).toBe( false );
	expect( stages.at( -1 ) ).toMatchObject( { name, code, status: 'failed' } );
} );
