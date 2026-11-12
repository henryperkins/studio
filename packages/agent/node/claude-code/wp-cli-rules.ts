import { lstat } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

// The values the WP-CLI commands this build runs are checked against. Both the
// classification and the description of what this route runs come from them.
const READABLE_OPTIONS: readonly string[] = [ 'blogname', 'blogdescription', 'home', 'siteurl' ];
const POST_ID_DIGITS = 10;
const TITLE_LENGTH = { min: 1, max: 200 };
const CONTENT_LENGTH = { min: 0, max: 10000 };
const DRAFT_STATUS = '--post_status=draft';

const postId = new RegExp( `^\\d{1,${ POST_ID_DIGITS }}$` );
const titleOption = new RegExp(
	`^--post_title=[\\s\\S]{${ TITLE_LENGTH.min },${ TITLE_LENGTH.max }}$`
);
const contentOption = new RegExp(
	`^--post_content=[\\s\\S]{${ CONTENT_LENGTH.min },${ CONTENT_LENGTH.max }}$`
);

// The WP-CLI commands this build runs: a few reads and one bounded draft creation.
export function classifyWpCliArgs( args: readonly unknown[] ): ClaudeOperationClass | undefined {
	if ( ! args.every( ( arg ) => typeof arg === 'string' ) ) return;
	const list = args as readonly string[];
	if (
		list.length === 3 &&
		list[ 0 ] === 'option' &&
		list[ 1 ] === 'get' &&
		READABLE_OPTIONS.includes( list[ 2 ] )
	)
		return 'read';
	if ( list.length === 2 && list[ 0 ] === 'post' && list[ 1 ] === 'list' ) return 'read';
	if (
		list.length === 3 &&
		list[ 0 ] === 'post' &&
		list[ 1 ] === 'get' &&
		postId.test( list[ 2 ] )
	)
		return 'read';
	if ( list[ 0 ] !== 'post' || list[ 1 ] !== 'create' || list.length < 4 || list.length > 5 )
		return;
	const options = list.slice( 2 );
	if ( new Set( options.map( ( option ) => option.split( '=', 1 )[ 0 ] ) ).size !== options.length )
		return;
	if ( ! options.includes( DRAFT_STATUS ) ) return;
	if ( ! options.some( ( option ) => titleOption.test( option ) ) ) return;
	if (
		! options.every(
			( option ) =>
				option === DRAFT_STATUS || titleOption.test( option ) || contentOption.test( option )
		)
	)
		return;
	return 'command';
}

/**
 * Each WP-CLI command `classifyWpCliArgs` runs, written from the values it
 * checks: how to call it, the class it gets, and one call of that form.
 */
export function wpCliRouteCommands(): Array< {
	usage: string;
	operationClass: ClaudeOperationClass;
	example: string[];
} > {
	return [
		{
			usage: `option get <${ READABLE_OPTIONS.join( '|' ) }>`,
			operationClass: 'read',
			example: [ 'option', 'get', READABLE_OPTIONS[ 0 ] ],
		},
		{ usage: 'post list', operationClass: 'read', example: [ 'post', 'list' ] },
		{
			usage: `post get <id of up to ${ POST_ID_DIGITS } digits>`,
			operationClass: 'read',
			example: [ 'post', 'get', '1' ],
		},
		{
			usage: `post create ${ DRAFT_STATUS } --post_title=<${ TITLE_LENGTH.min } to ${ TITLE_LENGTH.max } characters> [--post_content=<up to ${ CONTENT_LENGTH.max } characters>]`,
			operationClass: 'command',
			example: [ 'post', 'create', DRAFT_STATUS, '--post_title=Draft', '--post_content=' ],
		},
	];
}

export function wpCliOption( args: readonly unknown[], name: string ): string | undefined {
	const prefix = `--${ name }=`;
	const option = args.find(
		( arg ): arg is string => typeof arg === 'string' && arg.startsWith( prefix )
	);
	return option?.slice( prefix.length );
}

// WP-CLI reads configuration that can point a command at another site or host.
export async function hasWpCliOverrides( siteDirectory: string ): Promise< boolean > {
	if (
		Object.entries( process.env ).some( ( [ name, value ] ) => /^WP_CLI_/i.test( name ) && value )
	)
		return true;
	const candidates = new Set( [ path.join( os.homedir(), '.wp-cli', 'config.yml' ) ] );
	if ( process.env.HOME && path.isAbsolute( process.env.HOME ) ) {
		candidates.add( path.join( process.env.HOME, '.wp-cli', 'config.yml' ) );
	}
	for ( let directory = siteDirectory; ; directory = path.dirname( directory ) ) {
		candidates.add( path.join( directory, 'wp-cli.local.yml' ) );
		candidates.add( path.join( directory, 'wp-cli.yml' ) );
		if ( path.dirname( directory ) === directory ) break;
	}
	for ( const candidate of candidates ) {
		try {
			await lstat( candidate );
			return true;
		} catch ( error ) {
			if ( ( error as NodeJS.ErrnoException ).code !== 'ENOENT' ) return true;
		}
	}
	return false;
}
