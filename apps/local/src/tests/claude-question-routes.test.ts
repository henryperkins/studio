import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startLocalServer } from '../index';
import type { ActiveAgentRun } from '@studio/agent/protocol/agent-events';

vi.mock( '@studio/agent/node/claude-code/studio-surface', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/claude-code/studio-surface') >() ),
	validateClaudeSendSelection: async () => ( { model: 'model', effort: 'high' } ),
} ) );

it( 'reconnects to the owner’s active question, scopes replies and Stop, and ends a detached run', async () => {
	const root = await mkdtemp( path.join( os.tmpdir(), 'studio-question-routes-' ) );
	const cliBinary = path.join( root, 'test-cli.mjs' );
	const receipt = path.join( root, 'receipt.json' );
	await writeFile(
		cliBinary,
		`
		import { readFileSync, appendFileSync } from 'node:fs';
		const index = process.argv.indexOf('--input-payload');
		if (index !== -1) {
			const {runId, turnId} = JSON.parse(readFileSync(process.argv[index+1]));
			const send = event => process.send({type:'backend.event', timestamp:'', event:{runId, turnId, ...event}});
			const ask = requestId => send({type:'question.asked', requestId, questions:[{question:'Style?', options:[{label:'A',description:'First'}, {label:'B',description:'Second'}]}]});
			process.on('message', message => {
				appendFileSync(${ JSON.stringify( receipt ) }, JSON.stringify(message)+'\\n');
				if (message.type === 'question.answer') send({type:'question.resolved', requestId:message.requestId, answers:message.answers});
				if (message.type === 'interrupt') {
					send({type:'turn.terminal', outcome:{status:'interrupted'}});
					process.disconnect();
				}
			});
			ask('first');
			ask('second');
		}
	`
	);
	const server = await startLocalServer( {
		port: 0,
		cliBinary,
		sessionsRoot: root,
		sitesRoot: root,
	} );
	const owner = randomUUID();
	const outsider = randomUUID();
	const connection = new AbortController();
	const api = server.url + '/api';
	const post = ( route: string, body: object ) =>
		fetch( api + route, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( body ),
		} );
	const active = async ( clientId: string ) =>
		( await (
			await fetch( api + '/runs/active?clientId=' + clientId )
		).json() ) as ActiveAgentRun[];
	const start = async () => {
		const result = await post( '/sessions/chat/messages', { clientId: owner, prompt: 'Hello' } );
		expect( result.status ).toBe( 200 );
		return ( ( await result.json() ) as { runId: string } ).runId;
	};
	try {
		const events = await fetch( api + '/events?clientId=' + owner, { signal: connection.signal } );
		expect( events.status ).toBe( 200 );
		const runId = await start();
		const answer = '/runs/' + runId + '/answer';
		const stop = '/runs/' + runId + '/interrupt';
		await vi.waitFor( async () =>
			expect( ( await active( owner ) )[ 0 ]?.pendingClaudeQuestions ).toHaveLength( 2 )
		);
		expect( await active( outsider ) ).toEqual( [] );
		const reply = { requestId: 'second', answers: { 'Style?': 'B' } };
		expect( ( await post( answer, { ...reply, clientId: outsider } ) ).status ).toBe( 403 );
		expect( ( await post( stop, { clientId: outsider } ) ).status ).toBe( 403 );
		expect(
			( await post( answer, { ...reply, clientId: owner, answers: { partial: 'B' } } ) ).status
		).toBe( 409 );
		expect( ( await post( answer, { ...reply, clientId: owner } ) ).status ).toBe( 204 );
		expect( ( await post( answer, { ...reply, clientId: owner } ) ).status ).toBe( 409 );
		const pending = ( await active( owner ) )[ 0 ].pendingClaudeQuestions;
		expect( pending?.map( ( batch ) => batch.requestId ) ).toEqual( [ 'first' ] );
		expect( ( await post( stop, { clientId: owner } ) ).status ).toBe( 204 );
		await vi.waitFor( async () => expect( await active( owner ) ).toEqual( [] ) );
		expect(
			( await post( answer, { ...reply, clientId: owner, requestId: 'first' } ) ).status
		).toBe( 409 );
		const messages = ( await readFile( receipt, 'utf8' ) )
			.trim()
			.split( '\n' )
			.map( ( line ) => JSON.parse( line ) );
		expect( messages ).toEqual( [
			{ type: 'question.answer', runId, turnId: pending![ 0 ].turnId, ...reply },
			{ type: 'interrupt' },
		] );
		await start();
		await vi.waitFor( async () =>
			expect( ( await active( owner ) )[ 0 ]?.pendingClaudeQuestions ).toHaveLength( 2 )
		);
		connection.abort();
		await vi.waitFor( async () => expect( await active( owner ) ).toEqual( [] ) );
		expect( ( await readFile( receipt, 'utf8' ) ).trim().split( '\n' ).slice( -1 ) ).toEqual( [
			'{"type":"interrupt"}',
		] );
	} finally {
		connection.abort();
		await server.close();
		await rm( root, { recursive: true, force: true } );
	}
}, 20_000 );
