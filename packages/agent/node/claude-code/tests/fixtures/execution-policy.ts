import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createFakeHost, fakeSite } from '../../../tests/fake-host';
import {
	CLAUDE_ENABLED_TOOLS,
	CLAUDE_EXECUTION_POLICY_REVISION,
	createClaudeExecutionPolicy,
} from '../../execution-policy';
import type { ClaudeExecutionContext } from '../../execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

// A policy for a local-site turn on a real temporary site directory, with a fake
// host whose operations are spies.
export async function createPolicyFixture(
	overrides: ( paths: {
		site: string;
		config: string;
		parent: string;
	} ) => Partial< ClaudeExecutionContext > = () => ( {} )
) {
	const parent = await realpath(
		await mkdtemp( path.join( os.tmpdir(), 'studio-claude-policy-' ) )
	);
	const site = path.join( parent, 'site' );
	const config = path.join( parent, 'config' );
	await mkdir( site );
	await mkdir( config );
	const host = createFakeHost( parent );
	const localSite = { ...fakeSite, path: site };
	host.sites.resolve = vi.fn( async () => localSite );
	host.sites.all = vi.fn( async () => [ localSite ] );
	const controller = new AbortController();
	const events: BackendTurnEvent[] = [];
	const context: ClaudeExecutionContext = {
		runId: 'run',
		turnId: 'turn',
		connectionId: 'connection',
		connectionRevision: 1,
		policyRevision: CLAUDE_EXECUTION_POLICY_REVISION,
		target: { environment: 'local', siteId: fakeSite.id },
		workspace: { siteId: fakeSite.id, workingDirectory: site, configDirectory: config },
		targetSite: { id: fakeSite.id, path: site },
		localRoots: [ site ],
		enabledTools: CLAUDE_ENABLED_TOOLS,
		signal: controller.signal,
		approve: vi.fn( async () => 'allow' as const ),
		approvalTimeoutMs: 100,
		ready: () => true,
		stillConnected: vi.fn( async () => true ),
		verifyTarget: vi.fn( async () => true ),
		onEvent: ( event ) => events.push( event ),
		...overrides( { site, config, parent } ),
	};
	return {
		policy: createClaudeExecutionPolicy( context ),
		context,
		host,
		localSite,
		controller,
		events,
		site,
		config,
		parent,
		cleanup: () => rm( parent, { recursive: true, force: true } ),
	};
}
