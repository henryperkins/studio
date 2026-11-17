import { randomUUID } from 'crypto';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSite } from '../../tests/fake-host';
import { CLAUDE_NAVIGATION_RULE_REVISION } from '../execution-rules';
import {
	completeGuard,
	createPolicyFixture,
	guarded,
	navigationGuarantees,
	targetOrigin,
} from './fixtures/execution-policy';

// The rules written for Studio tools that are not qualified to run. No host
// declaration, confinement or guard enables such a tool, so this file alone
// replaces the gate with the part a qualified tool still has to pass: a rule,
// and for a browser tool a verified navigation guard. That keeps the rules
// exercised as the starting point of each tool's qualification. Nothing here
// says what this build runs; `tool-qualification.test.ts` holds the real gate.
vi.mock( '../execution-rules', async ( importOriginal ) => {
	const actual = await importOriginal< typeof import('../execution-rules') >();
	const claudeStudioTools: typeof actual.claudeStudioTools = ( enabled, navigation, origin ) =>
		enabled.studio.filter( ( name ) => {
			const rule = actual.CLAUDE_STUDIO_TOOL_RULES.get( name );
			return (
				!! rule && ( ! rule.navigates || actual.isVerifiedNavigationGuard( navigation, origin ) )
			);
		} );
	return { ...actual, claudeStudioTools };
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
const offHostTools = [ 'scaffold_theme', 'validate_blocks', 'generate_images', 'take_screenshot' ];
const pageTools = [ 'take_screenshot', 'inspect_design', 'open_annotation_browser' ];
const auditTools = [ 'need_for_speed', 'rank_me_up' ];
const browserTools = [ ...pageTools, ...auditTools ];

describe( 'Unqualified Claude Studio tools', () => {
	it( 'are all refused by the real gate, which this file replaces', async () => {
		const actual =
			await vi.importActual< typeof import('../execution-rules') >( '../execution-rules' );
		const exercised = [ ...new Set( [ ...offHostTools, ...browserTools ] ) ];
		for ( const origin of [ targetOrigin, null ] )
			expect(
				actual.claudeStudioTools( { native: [], studio: exercised }, guarded( origin ), origin )
			).toEqual( [] );
	} );
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
		const image = ( file: string ) => ( { images: [ { path: file, subject: 'Hero' } ] } );
		expect( await call( 'generate_images', image( path.join( site, 'hero.png' ) ) ) ).toBe( true );
		expect( await call( 'generate_images', image( path.join( other, 'hero.png' ) ) ) ).toBe(
			false
		);
		expect( await call( 'generate_images', image( 'hero.png' ) ) ).toBe( false );
		expect(
			await call( 'take_screenshot', {
				url: 'http://localhost:8888',
				themeScreenshot: path.join( other, 'wp-content', 'themes', 'theme' ),
			} )
		).toBe( false );
		expect( await call( 'take_screenshot', { url: 'http://localhost:8888' } ) ).toBe( true );
		expect( context.approve ).toHaveBeenCalledTimes( 2 );
		// An approval of a rule that names files shows them, so a call whose rule
		// names none at approval time is refused rather than asked about blind.
		expect( await call( 'validate_blocks', { nameOrPath: 'site' } ) ).toBe( false );
		expect( context.approve ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'bind them to no site in a global conversation', async () => {
		const { policy, host, site } = await setup( ( paths ) => ( {
			target: { environment: 'global' },
			targetSite: undefined,
			workspace: { siteId: null, workingDirectory: paths.parent, configDirectory: paths.config },
			enabledTools,
		} ) );
		const call = ( name: string, args: Record< string, unknown > ) =>
			policy.authorizeStudioCall( { host, name, args, toolCallId: randomUUID() } );
		expect( await call( 'scaffold_theme', { nameOrPath: 'site', name: 'Theme' } ) ).toBe( false );
		expect(
			await call( 'generate_images', {
				images: [ { path: path.join( site, 'a.png' ), subject: 'A' } ],
			} )
		).toBe( false );
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
