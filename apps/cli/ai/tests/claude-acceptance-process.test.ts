// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAcceptanceIsolation } from 'cli/ai/acceptance-isolation';
import {
	runClaudeAcceptanceTurn,
	type ClaudeAcceptanceTurnOptions,
} from 'cli/ai/claude-acceptance-process';
import type {
	BackendApprovalOperation,
	BackendTurnEvent,
} from '@studio/agent/protocol/backend-events';

const target = { environment: 'local', siteId: 'disposable-site' } as const;
const operation: BackendApprovalOperation = {
	tool: 'sites.wpCli',
	operationClass: 'command',
	target,
	args: JSON.stringify( {
		command: [ 'post', 'create', '--post_title=private-title', '--post_status=draft' ],
	} ),
	localPaths: [ 'private-path' ],
};
const questions = [
	{
		question: 'Private question?',
		options: [
			{ label: 'A', description: 'first' },
			{ label: 'B', description: 'second' },
		],
	},
];
const requestId = randomUUID();
const callId = 'call-id';
const SESSION = randomUUID();
let directory: string;
let options: ClaudeAcceptanceTurnOptions;

beforeEach( async () => {
	directory = await mkdtemp( join( tmpdir(), 'claude-ipc-test-' ) );
	options = {
		cliPath: join( directory, 'cli.cjs' ),
		cwd: directory,
		env: { ...process.env },
		sessionId: SESSION,
		timeoutMs: 6000,
		allowedTools: [],
		payload: {
			prompt: 'private-prompt',
			claudeSelection: { model: 'test-model', effort: 'low' },
			claudeContext: { connectionId: 'test-connection', revision: 1, target },
		},
	};
} );
afterEach( async () => {
	await rm( directory, { recursive: true, force: true } );
} );

async function fixture( events: object[], replies = '' ) {
	const script = [
		"const fs = require('node:fs');",
		"const input = process.argv[process.argv.indexOf('--input-payload') + 1];",
		'const {runId, turnId, prompt} = JSON.parse(fs.readFileSync(input));',
		"fs.writeFileSync('owner.json', JSON.stringify({ args:process.argv.slice(2), input, pid:process.pid }));",
		"const emit = event => process.send({type:'backend.event',event:{runId,turnId,...event}});",
		"const end = (code = 0) => { process.exitCode = code; if(!code) process.send({action:'done'}); process.disconnect(); };",
		"const terminal = (status = 'success') => emit({type:'turn.terminal', outcome:{status}});",
		"process.on('message', message => { fs.appendFileSync('replies', JSON.stringify(message) + '\\n');",
		replies || "if(message.type === 'interrupt') end(1);",
		'});',
		"emit({type:'turn.prompt',text:prompt});",
		...events.map( ( event ) => 'emit(' + JSON.stringify( event ) + ');' ),
	];
	await writeFile( options.cliPath, script.join( '\n' ) );
}
async function received(): Promise< unknown[] > {
	const lines = ( await readFile( join( directory, 'replies' ), 'utf8' ) ).trim().split( '\n' );
	return lines.map( ( line ) => JSON.parse( line ) );
}
const start = { type: 'tool.started', name: 'wp_cli', toolCallId: callId };
const ask = {
	type: 'approval.requested',
	description: 'Private approval',
	requestId,
	toolCallId: callId,
	operation,
};
const resolved = { type: 'approval.resolved', requestId, toolCallId: callId };
const toolResult = {
	type: 'tool.result',
	toolCallId: callId,
	isError: false,
	message: 'private-result',
};
const successful = { type: 'turn.terminal', outcome: { status: 'success' } };
function plan( decision: 'allow' | 'deny' | 'interrupt' = 'allow' ) {
	options.allowedTools = [ 'wp_cli' ];
	options.approvals = [ { toolName: 'wp_cli', operation, decision } ];
}

describe( 'Claude acceptance fork', () => {
	it.each( [ false, true ] )(
		'clears only fixture WP-CLI overrides in the actual owner (custom override %s)',
		async ( custom ) => {
			const isolation = applyAcceptanceIsolation( options.env, {
				runDir: directory,
				mustBeNew: true,
				home: tmpdir(),
			} );
			expect( isolation.ok ).toBe( true );
			options.env.HOME = 'fixture-original-home';
			options.env.USERPROFILE = 'fixture-native-profile';
			if ( custom ) {
				options.env.WP_CLI_CONFIG_PATH = 'unexpected-config';
				options.env.WP_CLI_EXTRA = 'unexpected-override';
			}
			await fixture( [] );
			await writeFile(
				options.cliPath,
				[
					'',
					'const {HOME,USERPROFILE,WP_CLI_CONFIG_PATH,WP_CLI_CACHE_DIR,WP_CLI_PACKAGES_DIR,WP_CLI_EXTRA} = process.env;',
					"fs.writeFileSync('env.json',JSON.stringify({HOME,USERPROFILE,WP_CLI_CONFIG_PATH,WP_CLI_CACHE_DIR,WP_CLI_PACKAGES_DIR,WP_CLI_EXTRA}));",
					'terminal(); end();',
				].join( '\n' ),
				{ flag: 'a' }
			);
			expect( ( await runClaudeAcceptanceTurn( options ) ).ok ).toBe( true );
			const owner = JSON.parse( await readFile( join( directory, 'owner.json' ), 'utf8' ) );
			expect( JSON.parse( await readFile( join( directory, 'env.json' ), 'utf8' ) ) ).toEqual( {
				HOME: process.platform === 'win32' ? dirname( owner.input ) : 'fixture-original-home',
				USERPROFILE: 'fixture-native-profile',
				...( custom
					? { WP_CLI_CONFIG_PATH: 'unexpected-config', WP_CLI_EXTRA: 'unexpected-override' }
					: {} ),
			} );
			expect( options.env.HOME ).toBe( 'fixture-original-home' );
			expect( options.env.WP_CLI_CACHE_DIR ).toBe( join( directory, 'wp-cli', 'cache' ) );
		}
	);
	it.each( [ 'allow', 'deny' ] as const )(
		'sends only the declared %s for the bound call and drops private event data',
		async ( decision ) => {
			plan( decision );
			const seen: BackendTurnEvent[] = [];
			options.onEvent = ( event ) => {
				seen.push( event );
			};
			await fixture(
				[ start, ask ],
				[
					'if (message.type !== "answer") return end(1);',
					'emit(' + JSON.stringify( resolved ) + ');',
					'emit(' + JSON.stringify( { ...toolResult, isError: decision === 'deny' } ) + ');',
					'terminal(); end();',
				].join( '\n' )
			);
			const result = await runClaudeAcceptanceTurn( options );
			expect( result ).toMatchObject( {
				ok: true,
				observations: {
					terminalSuccess: true,
					exitMatched: true,
					approvalRequests: 1,
					approvalsResolved: 1,
					toolResults: 1,
				},
			} );
			expect( await received() ).toEqual( [
				{ type: 'answer', answers: { [ requestId ]: decision } },
			] );
			expect(
				seen.every( ( event ) => event.runId === result.runId && event.turnId === result.turnId )
			).toBe( true );
			expect( JSON.stringify( result ) ).not.toMatch(
				/private|test-connection|call-id|disposable-site/i
			);
			const owner = JSON.parse( await readFile( join( directory, 'owner.json' ), 'utf8' ) );
			expect( owner.pid ).toBe( result.ownerPid );
			expect( owner.args ).toEqual( [
				'code',
				'sessions',
				'resume',
				SESSION,
				'--input-payload',
				owner.input,
				'--json',
				'--avoid-telemetry',
			] );
			await expect( readFile( owner.input ) ).rejects.toMatchObject( { code: 'ENOENT' } );
			await expect( readFile( dirname( owner.input ) ) ).rejects.toMatchObject( {
				code: 'ENOENT',
			} );
		}
	);

	it.each( [
		[ 'wrong owner', [ start, { ...ask, runId: 'another-run' } ], 'wrong-turn' ],
		[ 'wrong turn', [ start, { ...ask, turnId: 'another-turn' } ], 'wrong-turn' ],
		[ 'wrong call', [ start, { ...ask, toolCallId: 'other' } ], 'unexpected-approval' ],
		[
			'wrong target',
			[ start, { ...ask, operation: { ...operation, target: { environment: 'global' } } } ],
			'unexpected-approval',
		],
		[
			'changed arguments',
			[ start, { ...ask, operation: { ...operation, args: '{"command":["post","list"]}' } } ],
			'unexpected-approval',
		],
		[
			'malformed arguments',
			[ start, { ...ask, operation: { ...operation, args: 'broken' } } ],
			'unexpected-approval',
		],
		[
			'extra path',
			[
				start,
				{
					...ask,
					operation: { ...operation, localPaths: [ ...operation.localPaths, 'another-path' ] },
				},
			],
			'unexpected-approval',
		],
		[
			'different remote',
			[ start, { ...ask, operation: { ...operation, remote: 'other' } } ],
			'unexpected-approval',
		],
		[
			'different operation',
			[ start, { ...ask, operation: { ...operation, tool: 'sites.delete' } } ],
			'unexpected-approval',
		],
		[
			'different class',
			[ start, { ...ask, operation: { ...operation, operationClass: 'read' } } ],
			'unexpected-approval',
		],
		[ 'different tool', [ { ...start, name: 'Write' } ], 'unexpected-tool' ],
		[
			'undeclared native start',
			[ { type: 'native.call', state: 'started', name: 'Bash', toolCallId: 'shell' } ],
			'unexpected-tool',
		],
		[ 'second call', [ start, { ...start, toolCallId: 'another-id' } ], 'unexpected-tool' ],
		[ 'unmatched result', [ { ...toolResult, toolCallId: 'another-id' } ], 'unexpected-tool' ],
		[ 'empty request', [ start, { ...ask, requestId: '' } ], 'unexpected-approval' ],
		[ 'wrong closure', [ start, resolved ], 'unexpected-approval' ],
		[
			'wrong question',
			[ start, { type: 'question.asked', toolCallId: callId, requestId, questions } ],
			'unexpected-question',
		],
	] as const )( 'stops without supplying any answer for %s', async ( _label, events, failure ) => {
		plan();
		await fixture( [ ...events ] );
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( { ok: false, failure } );
		expect( await received() ).toEqual( [ { type: 'interrupt' } ] );
	} );

	it( 'refuses a replay even when a second matching approval was planned', async () => {
		plan();
		options.approvals = [ ...options.approvals!, ...options.approvals! ];
		await fixture(
			[ start, ask ],
			[
				'if(message.type === "interrupt") return end(1);',
				'emit(' + JSON.stringify( resolved ) + ');',
				'emit(' + JSON.stringify( ask ) + ');',
			].join( '\n' )
		);
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: false,
			failure: 'unexpected-approval',
		} );
		expect( await received() ).toEqual( [
			{ type: 'answer', answers: { [ requestId ]: 'allow' } },
			{ type: 'interrupt' },
		] );
	} );

	it( 'sends Stop, observes approval closure, then sends its expired answer to that owner', async () => {
		plan( 'interrupt' );
		await fixture(
			[ start, ask ],
			[
				'if(message.type === "interrupt"){ emit(' + JSON.stringify( resolved ) + '); return; }',
				'if(message.type === "answer"){ terminal("interrupted"); end(1); }',
			].join( '\n' )
		);
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: true,
			observations: {
				terminalInterrupted: true,
				exitMatched: true,
				approvalsResolved: 1,
				lateAnswerSent: true,
			},
		} );
		expect( await received() ).toEqual( [
			{ type: 'interrupt' },
			{ type: 'answer', answers: { [ requestId ]: 'allow' } },
		] );
	} );

	it( 'answers the exact question in its own run and verifies the resolution', async () => {
		const answers = { 'Private question?': 'A' };
		options.allowedTools = [ 'AskUserQuestion' ];
		options.question = { toolName: 'AskUserQuestion', questions, answers };
		await fixture(
			[
				{ ...start, name: 'AskUserQuestion' },
				{ type: 'question.asked', toolCallId: callId, requestId, questions },
			],
			[
				'if(message.type !== "question.answer") return end(1);',
				'emit(' +
					JSON.stringify( { type: 'question.resolved', toolCallId: callId, requestId, answers } ) +
					');',
				'emit(' + JSON.stringify( toolResult ) + '); terminal(); end();',
			].join( '\n' )
		);
		const result = await runClaudeAcceptanceTurn( options );
		expect( result ).toMatchObject( { ok: true, observations: { questionAnswered: true } } );
		expect( await received() ).toEqual( [
			{ type: 'question.answer', runId: result.runId, turnId: result.turnId, requestId, answers },
		] );
	} );

	it( 'rejects a successful execution reported after Stop even with an interrupted terminal', async () => {
		plan( 'interrupt' );
		await fixture(
			[ start, ask ],
			[
				'if(message.type === "interrupt"){ emit(' + JSON.stringify( resolved ) + '); return; }',
				'emit(' + JSON.stringify( toolResult ) + '); terminal("interrupted"); end(1);',
			].join( '\n' )
		);
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: false,
			failure: 'unexpected-tool',
		} );
	} );

	it( 'interrupts a non-Claude provider event without returning its content', async () => {
		await fixture( [] );
		await writeFile(
			options.cliPath,
			'\nprocess.send({type:"session-token-request", data:"private-token"});',
			{ flag: 'a' }
		);
		const result = await runClaudeAcceptanceTurn( options );
		expect( result ).toMatchObject( { ok: false, failure: 'unexpected-event' } );
		expect( JSON.stringify( result ) ).not.toContain( 'private-token' );
		expect( await received() ).toEqual( [ { type: 'interrupt' } ] );
	} );

	it.each( [
		[ true, 1, 'exit-mismatch' ],
		[ false, 0, 'missing-evidence' ],
	] as const )(
		'requires both a terminal (%s) and matching exit (%i)',
		async ( terminal, exit, failure ) => {
			await fixture( terminal ? [ successful ] : [] );
			await writeFile( options.cliPath, '\nend(' + exit + ');', { flag: 'a' } );
			expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( { ok: false, failure } );
		}
	);

	it( 'keeps an external Stop or deadline distinct from the intentional stopped workflow', async () => {
		const controller = new AbortController();
		options.signal = controller.signal;
		options.onEvent = () => controller.abort();
		await fixture( [] );
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: false,
			failure: 'interrupted',
		} );
		options.signal = undefined;
		options.onEvent = undefined;
		options.timeoutMs = 300;
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: false,
			failure: 'timeout',
		} );
	} );

	it( 'requires a full Studio session id before opening an owner', async () => {
		options.sessionId = 'latest';
		expect( await runClaudeAcceptanceTurn( options ) ).toMatchObject( {
			ok: false,
			failure: 'invalid-input',
		} );
		await expect( readFile( join( directory, 'owner.json' ) ) ).rejects.toMatchObject( {
			code: 'ENOENT',
		} );
	} );
} );
