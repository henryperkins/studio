import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	getClaudeModelCatalog,
	recoverClaudeSession,
	discardClaudeChatFile,
	stageClaudeChatFile,
	setClaudeSessionTarget,
} from '@studio/agent/node/claude-code/studio-surface';
import { expect, it, vi } from 'vitest';
import { startLocalServer } from '../index';
import type { ActiveAgentRun } from '@studio/agent/protocol/agent-events';

vi.mock( '@studio/agent/node/claude-code/studio-surface', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/agent/node/claude-code/studio-surface') >() ),
	discardClaudeChatFile: vi.fn().mockResolvedValue( undefined ),
	stageClaudeChatFile: vi.fn(
		async (
			_root: string,
			_id: string,
			_name: string,
			_size: number,
			stream: AsyncIterable< Buffer >
		) => {
			const chunks: Buffer[] = [];
			for await ( const chunk of stream ) chunks.push( chunk );
			return '/staged/' + Buffer.concat( chunks ).toString( 'hex' );
		}
	),
	setClaudeSessionTarget: vi.fn(),
	getClaudeModelCatalog: vi.fn( async () => ( { ok: true, models: [] } ) ),
	recoverClaudeSession: vi.fn( async () => ( { status: 'blocked', reason: 'owner-alive' } ) ),
	validateClaudeSendSelection: async () => ( { model: 'model', effort: 'high' } ),
} ) );

it( 'uses this server’s configured sessions root for global catalogs and recovery', async () => {
	const root = await mkdtemp( path.join( os.tmpdir(), 'studio-claude-global-' ) );
	const server = await startLocalServer( {
		port: 0,
		cliBinary: process.execPath,
		sessionsRoot: root,
		sitesRoot: root,
	} );
	try {
		const api = server.url + '/api';
		expect( ( await fetch( api + '/claude-code/account/models' ) ).status ).toBe( 200 );
		expect( getClaudeModelCatalog ).toHaveBeenCalledWith( 'account', undefined, root );
		expect( ( await fetch( api + '/claude-code/account/models/site' ) ).status ).toBe( 200 );
		expect( getClaudeModelCatalog ).toHaveBeenCalledWith( 'account', 'site', root );
		const from = { environment: 'global' },
			to = { environment: 'local', siteId: 'site' };
		const change = await fetch( api + '/sessions/chat/claude-target', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { expected: from, target: to } ),
		} );
		expect( change.status ).toBe( 204 );
		expect( setClaudeSessionTarget ).toHaveBeenCalledWith( root, 'chat', from, to );
		const upload = await fetch( api + '/sessions/chat/claude-attachments?name=notes.md&size=5', {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: 'notes',
		} );
		expect( await upload.json() ).toEqual( { path: '/staged/6e6f746573' } );
		expect( stageClaudeChatFile ).toHaveBeenCalledWith(
			root,
			'chat',
			'notes.md',
			5,
			expect.anything()
		);
		const discarded = await fetch( api + '/sessions/chat/claude-attachments', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify( { path: '/staged/6e6f746573' } ),
		} );
		expect( discarded.status ).toBe( 204 );
		expect( discardClaudeChatFile ).toHaveBeenCalledWith( root, 'chat', '/staged/6e6f746573' );
		const empty = await fetch( api + '/sessions/chat/claude-attachments?name=empty&size=0', {
			method: 'POST',
			headers: { 'Content-Type': 'application/octet-stream' },
			body: Buffer.alloc( 0 ),
		} );
		expect( await empty.json() ).toEqual( { path: '/staged/' } );
		const response = await fetch( api + '/sessions/chat/claude-recovery', { method: 'POST' } );
		expect( await response.json() ).toEqual( { status: 'blocked', reason: 'owner-alive' } );
		expect( recoverClaudeSession ).toHaveBeenCalledWith( 'chat', root );
	} finally {
		await server.close();
		await rm( root, { recursive: true, force: true } );
	}
} );

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
