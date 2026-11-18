import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../../tests/fake-host';
import { claudeStudioTools, CLAUDE_NAVIGATION_RULE_REVISION } from '../execution-rules';
import {
	completeGuard,
	createPolicyFixture,
	guarded,
	navigationGuarantees,
	targetOrigin,
} from './fixtures/execution-policy';

it( 'binds web access to an admitted, current call on the exact registered site', async () => {
	const { policy, host, localSite, otherSite } = await setup( () => ( {
		navigationConfinement: guarded( targetOrigin ),
	} ) );
	const controller = new AbortController();
	const call = 'inspect';
	policy.guardHost( host, call, controller.signal );
	await expect( policy.webCallOptions( host, call ) ).rejects.toThrow();
	expect(
		await policy.authorizeStudioCall( {
			host,
			name: 'inspect_design',
			args: { url: targetOrigin },
			toolCallId: call,
		} )
	).toBe( true );
	const options = await policy.webCallOptions( host, call );
	expect( options ).toMatchObject( {
		targetOrigin,
		sitePath: localSite.path,
		localSiteUrls: [ localSite.url, otherSite.url ],
	} );
	vi.mocked( host.sites.all ).mockResolvedValueOnce( [
		{ ...localSite, url: 'http://localhost:9999' },
	] );
	await expect( policy.webCallOptions( host, call ) ).rejects.toThrow();
	controller.abort();
	expect( options.signal.aborted ).toBe( true );
	await expect( policy.webCallOptions( host, call ) ).rejects.toThrow();
} );

it( 'permits scaffolding to activate only the theme created by that call, once', async () => {
	const { policy, host, localSite } = await setup();
	const fenced = policy.guardHost( host, 'theme' );
	expect(
		await policy.authorizeStudioCall( {
			host,
			name: 'scaffold_theme',
			args: { nameOrPath: 'site', name: 'A theme' },
			toolCallId: 'theme',
		} )
	).toBe( true );
	await expect(
		fenced.sites.wpCli( localSite, [ 'theme', 'activate', 'other' ] )
	).rejects.toThrow();
	await expect(
		fenced.sites.wpCli( localSite, [ 'theme', 'activate', 'a-theme' ] )
	).resolves.toMatchObject( { exitCode: 0 } );
	await expect(
		fenced.sites.wpCli( localSite, [ 'theme', 'activate', 'a-theme' ] )
	).rejects.toThrow();
	expect( host.sites.wpCli ).toHaveBeenCalledTimes( 1 );
} );

const cleanups: Array< () => Promise< void > > = [];
afterEach( async () => {
	await Promise.all( cleanups.splice( 0 ).map( ( cleanup ) => cleanup() ) );
} );
async function setup( ...args: Parameters< typeof createPolicyFixture > ) {
	const fixture = await createPolicyFixture( ...args );
	cleanups.push( fixture.cleanup );
	return fixture;
}

const studioServer = { name: 'studio', source: 'sdk' };
const offHostTools = [ 'scaffold_theme', 'validate_blocks', 'take_screenshot' ];
const pageTools = [ 'take_screenshot', 'inspect_design', 'open_annotation_browser' ];
const auditTools = [ 'need_for_speed', 'rank_me_up' ];
const browserTools = [ ...pageTools, ...auditTools ];

it( 'requires Chromium for the six page tools and admits the guarded scaffold independently', () => {
	const exercised = [ ...new Set( [ ...offHostTools, ...browserTools ] ) ];
	for ( const origin of [ targetOrigin, null ] ) {
		const enabled = { native: [], studio: exercised };
		expect( claudeStudioTools( enabled, { mode: 'none' }, origin ) ).toEqual( [
			'scaffold_theme',
		] );
		expect( claudeStudioTools( enabled, guarded( origin ), origin ) ).toEqual( exercised );
	}
} );

describe( 'Rules for Claude Studio tools that act outside the host', () => {
	const enabledTools = { native: [], studio: offHostTools };

	it( 'bind them to the target site and name that site and path in the approval', async () => {
		const { policy, host, context, site, other } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		expect( await call( 'scaffold_theme', { nameOrPath: 'site', name: 'Theme' } ) ).toBe( true );
		expect( await call( 'scaffold_theme', { nameOrPath: 'other', name: 'Theme' } ) ).toBe( false );
		expect( await call( 'scaffold_theme', { name: 'Theme' } ) ).toBe( false );
		expect( context.approve ).not.toHaveBeenCalled();
		await mkdir( path.join( site, 'templates' ) );
		await writeFile( path.join( site, 'templates', 'index.html' ), '<!-- wp:paragraph /-->' );
		expect(
			await call( 'validate_blocks', { nameOrPath: 'site', filePath: 'templates/index.html' } )
		).toBe( true );
		expect( vi.mocked( context.approve ).mock.calls[ 0 ][ 0 ].operation ).toMatchObject( {
			tool: 'validate_blocks',
			siteId: fakeSite.id,
			localPaths: [ path.join( site, 'templates', 'index.html' ) ],
		} );
		expect(
			await call( 'validate_blocks', { nameOrPath: 'site', filePath: '../other/index.html' } )
		).toBe( false );
		expect(
			await call( 'take_screenshot', {
				url: 'http://localhost:8888',
				themeScreenshot: path.join( other, 'wp-content', 'themes', 'theme' ),
			} )
		).toBe( false );
		expect( await call( 'take_screenshot', { url: 'http://localhost:8888' } ) ).toBe( true );
		expect( context.approve ).toHaveBeenCalledOnce();
		expect(
			await call( 'validate_blocks', { nameOrPath: 'site', content: '<!-- wp:paragraph /-->' } )
		).toBe( true );
		expect( context.approve ).toHaveBeenCalledOnce();
	} );

	it( 'bind them to no site in a global conversation', async () => {
		const { policy, host } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		expect( await call( 'scaffold_theme', { nameOrPath: 'site', name: 'Theme' } ) ).toBe( false );
	} );
} );

describe( 'Rules for Claude Studio tools that reach a site by URL', () => {
	const enabledTools = { native: [], studio: browserTools };

	it( 'still need a navigation guard the policy can verify', async () => {
		const complete = completeGuard( targetOrigin );
		const incomplete: unknown[] = [
			{ mode: 'none' },
			{ mode: 'guarded', guard: undefined },
			...navigationGuarantees.map( ( key ) => {
				const { [ key ]: _omitted, ...missing } = complete as Record< string, unknown >;
				return { mode: 'guarded', guard: missing };
			} ),
			{
				mode: 'guarded',
				guard: { ...complete, ruleRevision: CLAUDE_NAVIGATION_RULE_REVISION - 1 },
			},
			{ mode: 'guarded', guard: { ...complete, targetOrigin: 'http://localhost:8889' } },
			{ mode: 'guarded', guard: { ...complete, exceptions: [] } },
			{ mode: 'guarded', guard: complete, exceptions: [ '127.0.0.1' ] },
		];
		for ( const navigationConfinement of incomplete ) {
			const label = JSON.stringify( navigationConfinement );
			const { policy, host, context } = await setup( () => ( {
				enabledTools,
				navigationConfinement: navigationConfinement as never,
			} ) );
			for ( const name of pageTools ) {
				expect(
					await policy.authorizeStudioCall( {
						host,
						name,
						args: { url: `${ targetOrigin }/`, selectors: [ 'body' ] },
						toolCallId: randomUUID(),
					} ),
					`${ name } ${ label }`
				).toBe( false );
				expect(
					await policy.authorizeToolUse( {
						toolName: `mcp__studio__${ name }`,
						input: {},
						mcpServer: studioServer,
					} ),
					`${ name } ${ label }`
				).toBe( false );
			}
			for ( const name of auditTools )
				expect(
					await policy.authorizeStudioCall( {
						host,
						name,
						args: { nameOrPath: 'site' },
						toolCallId: randomUUID(),
					} ),
					`${ name } ${ label }`
				).toBe( false );
			expect( context.approve ).not.toHaveBeenCalled();
		}

		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		expect(
			await policy.authorizeStudioCall( {
				host,
				name: 'take_screenshot',
				args: { url: `${ targetOrigin }/` },
				toolCallId: randomUUID(),
			} )
		).toBe( true );
		expect(
			await policy.authorizeToolUse( {
				toolName: 'mcp__studio__take_screenshot',
				input: {},
				mcpServer: studioServer,
			} )
		).toBe( true );
	} );

	it( 'compare host names lowercased, punycoded and without trailing dots', async () => {
		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		for ( const name of pageTools ) {
			const at = ( url: string ) =>
				policy.authorizeStudioCall( { host, name, args: { url }, toolCallId: randomUUID() } );
			for ( const url of [
				'http://localhost.:8882/',
				'http://localhost.:8888/',
				'http://localhost..:8888/',
				'http://LOCALHOST%2E:8882/',
				'http://localhost\u3002:8882/',
				'http://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54.:8882/',
				'http://site.localhost./',
				'http://site.localhost../',
				'http://printer.local./',
				'http://other-site.example.:8890/',
				'http://OTHER-SITE.example..:8890/',
				'http://127.0.0.1.:8882/',
				'http://[::127.0.0.1]:8882/',
				'http://./',
			] )
				expect( await at( url ), `${ name } ${ url }` ).toBe( false );
			expect( await at( 'https://example.com./' ), name ).toBe( true );
			// A public name can resolve to a local address; only the browser-layer
			// guard, which resolves it, can refuse it.
			expect( await at( 'http://127.0.0.1.nip.io:8882/' ), name ).toBe( true );
		}
	} );

	it( 'allow the target site and public pages, and deny other schemes and local origins', async () => {
		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		for ( const name of pageTools ) {
			const at = ( url: string ) => call( name, { url, selectors: [ 'body' ] } );
			expect( await at( 'http://localhost:8888/about' ), name ).toBe( true );
			expect( await at( 'https://example.com/' ), name ).toBe( true );
			for ( const url of [
				'file:///C:/Windows/win.ini',
				'file:///etc/passwd',
				'data:text/html,<p>x</p>',
				'javascript:alert(1)',
				'chrome://settings',
				'http://127.0.0.1:8882/',
				'http://localhost:8889/',
				'http://[::1]:8888/',
				'http://2130706433/',
				'http://192.168.1.10/',
				'http://10.0.0.5/',
				'http://172.20.0.1/',
				'http://169.254.169.254/latest/meta-data/',
				'http://[::ffff:127.0.0.1]:8888/',
				'http://[fd00::1]/',
				'http://printer.local/',
				'http://other-site.example:8890/',
				'not a url',
			] )
				expect( await at( url ), `${ name } ${ url }` ).toBe( false );
		}
	} );

	it( 'keep a site audit on the target site whatever path it is given', async () => {
		const { policy, host } = await setup( () => ( {
			enabledTools,
			navigationConfinement: guarded( targetOrigin ),
		} ) );
		for ( const name of auditTools ) {
			const audit = ( auditPath?: string ) =>
				policy.authorizeStudioCall( {
					host,
					name,
					args: { nameOrPath: 'site', ...( auditPath === undefined ? {} : { path: auditPath } ) },
					toolCallId: randomUUID(),
				} );
			expect( await audit(), name ).toBe( true );
			expect( await audit( '/about' ), name ).toBe( true );
			expect( await audit( '/wp-admin/' ), name ).toBe( true );
			for ( const auditPath of [
				'@127.0.0.1:8882/',
				'//evil.example/',
				'http://evil.example/',
				'/\\evil.example',
				'\\\\evil.example',
				'about',
				'',
			] )
				expect( await audit( auditPath ), `${ name } ${ auditPath }` ).toBe( false );
		}
	} );

	it( 'reach no local site from a global conversation', async () => {
		const { policy, host } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
			navigationConfinement: guarded( null ),
		} ) );
		const at = ( url: string ) =>
			policy.authorizeStudioCall( {
				host,
				name: 'take_screenshot',
				args: { url },
				toolCallId: randomUUID(),
			} );
		expect( await at( 'http://localhost:8888/' ) ).toBe( false );
		expect( await at( 'https://example.com/' ) ).toBe( true );
	} );
} );
