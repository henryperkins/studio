import { mkdir, mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createFakeHost, fakeSite } from '../../../tests/fake-host';
import {
	CLAUDE_EXECUTION_POLICY_REVISION,
	createClaudeExecutionPolicy,
} from '../../execution-policy';
import { CLAUDE_ENABLED_TOOLS } from '../../execution-rules';
import type { ClaudeExecutionContext } from '../../execution-policy';
import type { BackendTurnEvent } from '@studio/agent/protocol/backend-events';

// A policy for a local-site turn on a real temporary site directory, with a fake
// host whose operations are spies. A second site, `other`, lives next to it.
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
	const other = path.join( parent, 'other' );
	const config = path.join( parent, 'config' );
	await mkdir( site );
	await mkdir( other );
	await mkdir( config );
	const host = createFakeHost( parent );
	const localSite = { ...fakeSite, path: site };
	const otherSite = {
		...fakeSite,
		id: 'other-site',
		name: 'Other',
		path: other,
		url: 'http://other-site.example:8890',
	};
	const byReference = ( reference: string ) =>
		reference === 'other' || path.resolve( reference ) === other ? otherSite : localSite;
	host.sites.resolve = vi.fn( async ( reference: string ) => byReference( reference ) );
	host.sites.findByFolder = vi.fn( async ( folder: string ) =>
		[ site, other ].includes( path.resolve( folder ) ) ? byReference( folder ) : undefined
	);
	host.sites.all = vi.fn( async () => [ localSite, otherSite ] );
	const controller = new AbortController();
	const events: BackendTurnEvent[] = [];
	const clock = { now: 0 };
	const context: ClaudeExecutionContext = {
		runId: 'run',
		turnId: 'turn',
		connectionId: 'connection',
		connectionRevision: 1,
		policyRevision: CLAUDE_EXECUTION_POLICY_REVISION,
		target: { environment: 'local', siteId: fakeSite.id },
		workspace: { siteId: fakeSite.id, workingDirectory: site, configDirectory: config },
		targetSite: { id: fakeSite.id, path: site, url: fakeSite.url },
		localRoots: [ site ],
		enabledTools: CLAUDE_ENABLED_TOOLS,
		shellConfinement: { mode: 'none' },
		navigationConfinement: { mode: 'none' },
		signal: controller.signal,
		approve: vi.fn( async () => 'allow' as const ),
		approvalTimeoutMs: 100,
		ready: () => true,
		stillConnected: vi.fn( async () => true ),
		verifyAccount: vi.fn( async () => 'same' as const ),
		accountVerifiedAt: 0,
		now: () => clock.now,
		verifyTarget: vi.fn( async () => true ),
		onEvent: ( event ) => events.push( event ),
		...overrides( { site, config, parent } ),
	};
	return {
		policy: createClaudeExecutionPolicy( context ),
		context,
		host,
		localSite,
		otherSite,
		controller,
		events,
		clock,
		site,
		other,
		config,
		parent,
		cleanup: () => rm( parent, { recursive: true, force: true } ),
	};
}
