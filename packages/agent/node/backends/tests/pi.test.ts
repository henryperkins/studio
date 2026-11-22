import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentEndFailure } from '@studio/agent/protocol/json-events';
import { getEffectiveSessionProvider } from '@studio/agent/protocol/providers';
import { createAgent } from '../../agent';
import { readAiSessionSummaryFromEntries } from '../../sessions/summary';
import { createFakeHost } from '../../tests/fake-host';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

describe( 'dispatching existing Pi conversations', () => {
	let root: string;

	beforeEach( async () => {
		root = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-pi-backend-' ) );
	} );

	afterEach( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	it.each( [
		{
			providerId: 'wpcom',
			modelId: 'fast',
			replyProvider: 'studio-wpcom',
			api: 'openai-completions',
			missingKey: /STUDIO_WPCOM_API_KEY/,
		},
		{
			providerId: 'anthropic-api-key',
			modelId: 'claude-sonnet-5',
			replyProvider: 'anthropic',
			api: 'anthropic-messages',
			missingKey: /ANTHROPIC_API_KEY/,
		},
		{
			providerId: 'openai-api-key',
			modelId: 'gpt-6.1-sol',
			replyProvider: 'studio-openai',
			api: 'openai-responses',
			missingKey: /STUDIO_OPENAI_API_KEY/,
		},
		{
			providerId: 'openai-api-key',
			modelId: 'retired-model',
			replyProvider: 'studio-openai',
			api: 'openai-responses',
			missingKey: /retired-model/,
		},
	] as const )(
		'keeps $providerId history and $modelId on the Pi path',
		async ( { providerId, modelId, replyProvider, api, missingKey } ) => {
			const timestamp = '2026-11-08T12:00:00.000Z';
			const content = [
				{ type: 'thinking', thinking: 'Previously saved reasoning.', thinkingSignature: 'opaque' },
				{ type: 'text', text: 'Existing reply.' },
			];
			const records = [
				{ type: 'session', version: 3, id: 'existing', timestamp, cwd: root },
				{
					type: 'message',
					id: 'reply',
					parentId: null,
					timestamp,
					message: {
						role: 'assistant',
						content,
						api,
						provider: replyProvider,
						model: modelId,
						stopReason: 'stop',
						timestamp: Date.parse( timestamp ),
					},
				},
			];
			const filePath = path.join( root, 'session.jsonl' );
			const fileContents =
				records.map( ( record ) => JSON.stringify( record ) ).join( '\n' ) + '\n';
			await fs.writeFile( filePath, fileContents );
			const agent = createAgent( {
				host: createFakeHost( root ),
				claudeCode: async () => {
					throw new Error( 'An existing Pi conversation reached Claude Code.' );
				},
			} );
			const session = await agent.sessions.open( filePath );
			expect( session.getEntries() ).toEqual( records.slice( 1 ) );
			const summary = await readAiSessionSummaryFromEntries(
				filePath,
				records as Parameters< typeof readAiSessionSummaryFromEntries >[ 1 ]
			);
			expect( summary?.assistantReplyPreview ).toBe( 'Existing reply.' );
			expect(
				getEffectiveSessionProvider( session.getEntries(), {
					provider: 'openai-api-key',
					hasAnthropicApiKey: true,
				} )
			).toBe( providerId );
			const events: AgentSessionEvent[] = [];
			const { result } = agent.runBackendTurn(
				{
					backend: 'pi',
					runId: 'run',
					turnId: 'turn',
					effort: null,
					selection: { connectionId: providerId, model: { providerId, modelId }, revision: 0 },
					permissionPolicyRevision: 0,
					workspace: { siteId: null, conversationId: 'existing', workingDirectory: root },
				},
				{
					backend: 'pi',
					config: {
						session,
						prompt: 'Continue',
						env: {},
						onEvent: ( event ) => events.push( event ),
					},
				}
			);
			await expect( result ).resolves.toMatchObject( {
				status: 'error',
				message: expect.stringMatching( missingKey ),
			} );
			if ( modelId !== 'retired-model' ) {
				expect( events ).toHaveLength( 1 );
				expect( getAgentEndFailure( events[ 0 ] )?.message ).toMatch( missingKey );
			} else {
				expect( events ).toEqual( [] );
			}
			expect( await fs.readFile( filePath, 'utf8' ) ).toBe( fileContents );
		}
	);
} );
