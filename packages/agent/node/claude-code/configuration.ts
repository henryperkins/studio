import { lstat, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const routingKeys = /^(apiKeyHelper|awsAuthRefresh|awsCredentialExport|otelHeadersHelper)$/i;
const routingEnvironment =
	/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|AWS_|GOOGLE_CLOUD_|GOOGLE_APPLICATION_CREDENTIALS$|AZURE_|.*_PROXY$)/i;
export async function inspectClaudeConfiguration( cwd: string, configDirectory: string ) {
	const blockers: string[] = [];
	const findings: string[] = [];
	async function check( target: string, label: string, parseSettings = false ) {
		try {
			const stat = await lstat( target );
			findings.push( label );
			if ( ! parseSettings ) return;
			if ( ! stat.isFile() || stat.size > 1024 * 1024 ) throw new Error();
			const data: unknown = JSON.parse( await readFile( target, 'utf8' ) );
			if ( ! data || typeof data !== 'object' || Array.isArray( data ) ) throw new Error();
			const settings = data as Record< string, unknown >;
			if ( Object.keys( settings ).some( ( key ) => routingKeys.test( key ) && settings[ key ] ) )
				blockers.push( 'settings-routing-override' );
			if (
				settings.env &&
				typeof settings.env === 'object' &&
				Object.entries( settings.env ).some(
					( [ key, value ] ) => routingEnvironment.test( key ) && value
				)
			)
				blockers.push( 'settings-routing-override' );
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' )
				blockers.push( 'configuration-unreadable' );
		}
	}
	for ( const name of [ 'settings.json', 'settings.local.json' ] )
		await check( path.join( configDirectory, name ), `user-${ name }-present`, true );
	for ( const name of [ 'CLAUDE.md', 'rules', 'plugins', 'projects' ] )
		await check( path.join( configDirectory, name ), `user-${ name }-present` );
	await check( path.join( configDirectory, '.claude.json' ), 'config-local-state-present', true );
	await check( path.join( os.homedir(), '.claude.json' ), 'global-config-present', true );
	let current = path.resolve( cwd );
	for (;;) {
		for ( const [ name, label, settings ] of [
			[ '.claude/settings.json', 'project-settings-present', true ],
			[ '.claude/settings.local.json', 'project-local-settings-present', true ],
			[ '.mcp.json', 'project-mcp-present', false ],
			[ 'CLAUDE.md', 'project-instructions-present', false ],
			[ '.claude/CLAUDE.md', 'project-instructions-present', false ],
			[ '.claude/rules', 'project-rules-present', false ],
		] as const )
			await check( path.join( current, name ), label, settings );
		const parent = path.dirname( current );
		if ( parent === current ) break;
		current = parent;
	}
	return { blockers: [ ...new Set( blockers ) ], findings: [ ...new Set( findings ) ] };
}
