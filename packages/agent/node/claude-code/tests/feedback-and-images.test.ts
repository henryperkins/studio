import { mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { readAuthToken } from '@studio/common/lib/shared-config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioClaudeToolBridge } from '../tool-bridge';
import { createPolicyFixture } from './fixtures/execution-policy';

// The two tools that send or generate, each driven through the real execution
// policy and the bridge the SDK calls, against a fake host whose operations
// are spies. Nothing here leaves the machine: the feedback service's MCP
// client and transport are stand-ins that record what they would send, as in
// `node/tests/send-feedback.test.ts`, and the stored login is a test value
// whose file lies in a configuration folder of this test's own.

const config = vi.hoisted( () => ( { root: '' } ) );
const feedback = vi.hoisted( () => ( {
	transports: [] as Array< { url: string; options: unknown } >,
	calls: [] as unknown[],
	answer: {} as Record< string, unknown >,
} ) );

vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('@studio/common/lib/well-known-paths') >();
	const nodePath = await import( 'path' );
	return {
		...actual,
		getConfigDirectory: () => config.root,
		getSharedConfigPath: () => nodePath.join( config.root, 'shared.json' ),
	};
} );

vi.mock( '@studio/common/lib/shared-config', async ( importOriginal ) => ( {
	...( await importOriginal< object >() ),
	readAuthToken: vi.fn(),
} ) );

vi.mock( '@modelcontextprotocol/sdk/client/index.js', () => ( {
	Client: class {
		async connect() {}
		async callTool( request: unknown ) {
			feedback.calls.push( request );
			return feedback.answer;
		}
		async close() {}
	},
} ) );
vi.mock( '@modelcontextprotocol/sdk/client/streamableHttp.js', () => ( {
	StreamableHTTPClientTransport: class {
		constructor( url: URL, options: unknown ) {
			feedback.transports.push( { url: url.toString(), options } );
		}
	},
} ) );

const LOGIN = {
	accessToken: 'test-login-token',
	id: 7,
	displayName: 'Test Person',
	email: 'person@example.test',
	expirationTime: Number.MAX_SAFE_INTEGER,
};

beforeAll( async () => {
	config.root = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-config-' ) )
	);
} );
afterAll( async () => {
	await rm( config.root, { recursive: true, force: true } );
} );

beforeEach( () => {
	vi.mocked( readAuthToken )
		.mockReset()
		.mockResolvedValue( LOGIN as never );
	feedback.transports.length = 0;
	feedback.calls.length = 0;
	feedback.answer = {
		content: [ { type: 'text', text: 'Thanks!' } ],
		structuredContent: { status: 'success', feedback_id: 42 },
	};
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );

async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	const bridge = createStudioClaudeToolBridge(
		fixture.host,
		{ runId: 'run', turnId: 'turn', policy: fixture.policy },
		() => {}
	);
	cleanups.push( () => bridge.dispose() );
	return { ...fixture, bridge };
}

// A conversation without a site, as a global chat starts.
const global = ( paths: { parent: string; config: string } ) => ( {
	target: { environment: 'global' as const },
	targetSite: undefined,
	workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
	localRoots: [ paths.parent ],
} );

const text = ( result: { content: Array< { type: string; text?: string } > } ) =>
	result.content.map( ( part ) => part.text ?? '' ).join( '\n' );

describe( 'send_feedback on the Claude route', () => {
	const report = { type: 'bug', message: 'The preview froze after the zebra theme loaded.' };
	const sent = {
		name: 'wpcom-mcp-send-feedback',
		arguments: {
			action: 'submit',
			type: 'bug',
			content: `[WordPressStudio/test on ${ process.platform }]\n\n${ report.message }`,
		},
	};

	it( 'sends the report once the user approves it, seeing its type and message and told what goes with them and where, never the login', async () => {
		const { bridge, context, journal, events } = await setup();
		expect( bridge.tools ).toContain( 'send_feedback' );
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( false );
		expect( text( result ) ).toBe( 'Feedback sent. Feedback ID: 42.' );

		expect( context.approve ).toHaveBeenCalledOnce();
		const [ request ] = vi.mocked( context.approve ).mock.calls[ 0 ];
		expect( request.operation ).toMatchObject( {
			tool: 'send_feedback',
			operationClass: 'external-message',
			args: report,
			localPaths: [],
		} );
		expect( request.operation.description ).toContain( 'Send a message outside Studio' );
		expect( request.operation.description ).toContain( 'Studio version and operating system' );
		expect( request.operation.description ).toContain( 'WordPress Studio team' );
		const shown = JSON.stringify(
			events.filter( ( event ) => event.type === 'approval.requested' )
		);
		expect( shown ).toContain( report.message );
		for ( const secret of [ LOGIN.accessToken, LOGIN.email, LOGIN.displayName ] )
			expect( shown ).not.toContain( secret );

		// What leaves the machine: the report as shown, with the line naming
		// Studio's version and operating system, to the feedback service's fixed
		// address, signed in with the stored login.
		expect( feedback.transports ).toEqual( [
			{
				url: 'https://public-api.wordpress.com/wpcom/v2/mcp/v1',
				options: {
					requestInit: {
						headers: {
							authorization: `Bearer ${ LOGIN.accessToken }`,
							'user-agent': 'WordPressStudio/test',
						},
					},
				},
			},
		] );
		expect( feedback.calls ).toEqual( [ sent ] );

		// Journaled before it was sent, under its approval, with neither the
		// message nor the login.
		expect( journal ).toEqual( [
			expect.objectContaining( {
				requestId: request.requestId,
				operation: {
					tool: 'send_feedback',
					operationClass: 'external-message',
					target: context.target,
				},
			} ),
		] );
		for ( const secret of [ report.message, LOGIN.accessToken, LOGIN.email, LOGIN.displayName ] )
			expect( JSON.stringify( journal ) ).not.toContain( secret );
	} );

	it( 'sends a report from a conversation without a site too', async () => {
		const { bridge, context } = await setup( global );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( feedback.calls ).toEqual( [ sent ] );
	} );

	it( 'sends nothing the user denies, says so, and journals nothing', async () => {
		const { bridge, journal } = await setup( () => ( {
			approve: vi.fn( async () => 'deny' as const ),
		} ) );
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toContain( 'The user did not approve this operation' );
		expect( feedback.transports ).toEqual( [] );
		expect( feedback.calls ).toEqual( [] );
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( journal ).toEqual( [] );
	} );

	it( 'reads no stored login that lies in a folder the turn reaches, and asks nothing', async () => {
		const { bridge, context, journal } = await setup( ( paths ) => ( {
			localRoots: [ paths.site, config.root ],
		} ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( readAuthToken ).not.toHaveBeenCalled();
		expect( feedback.calls ).toEqual( [] );
		expect( journal ).toEqual( [] );
	} );

	it( 'asks nothing and sends nothing once the native account has changed', async () => {
		const { bridge, context, journal } = await setup( () => ( {
			verifyAccount: vi.fn( async () => 'changed' as const ),
		} ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( true );
		expect( context.approve ).not.toHaveBeenCalled();
		expect( feedback.calls ).toEqual( [] );
		expect( journal ).toEqual( [] );
	} );

	it( 'asks once in a turn after a recovery that left operations uncertain, as in any turn', async () => {
		const { bridge, context } = await setup( () => ( { uncertainAfterRecovery: true } ) );
		expect( ( await bridge.invoke( 'send_feedback', report ) ).isError ).toBe( false );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect( feedback.calls ).toEqual( [ sent ] );
	} );

	it( 'tells Claude only Studio’s fixed sentence when the service fails, never what it answered', async () => {
		feedback.answer = {
			isError: true,
			content: [ { type: 'text', text: `Rate limited for ${ LOGIN.email }` } ],
		};
		const { bridge } = await setup();
		const result = await bridge.invoke( 'send_feedback', report );
		expect( result.isError ).toBe( true );
		expect( text( result ) ).toBe( 'Studio operation denied or failed.' );
	} );
} );
