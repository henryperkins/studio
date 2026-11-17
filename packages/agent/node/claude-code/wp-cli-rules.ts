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

// A bounded draft: the draft status, a title and optionally content, each once.
function isDraftCreation( list: readonly string[] ): boolean {
	if ( list[ 0 ] !== 'post' || list[ 1 ] !== 'create' || list.length < 4 || list.length > 5 )
		return false;
	const options = list.slice( 2 );
	return (
		new Set( options.map( ( option ) => option.split( '=', 1 )[ 0 ] ) ).size === options.length &&
		options.includes( DRAFT_STATUS ) &&
		options.some( ( option ) => titleOption.test( option ) ) &&
		options.every(
			( option ) =>
				option === DRAFT_STATUS || titleOption.test( option ) || contentOption.test( option )
		)
	);
}

interface WpCliRouteCommand {
	/** How to call it, as the route note says it. */
	readonly usage: string;
	readonly operationClass: ClaudeOperationClass;
	/** One call of that form. */
	readonly example: readonly string[];
	/** Whether a command, split into arguments, is of this form. */
	readonly matches: ( list: readonly string[] ) => boolean;
}

// The WP-CLI commands this build runs, a few reads and one bounded draft
// creation, each written once: the classifier runs exactly these, and the
// route note describes exactly these. Frozen, so no caller can widen them.
const routeCommands = ( commands: WpCliRouteCommand[] ): readonly WpCliRouteCommand[] =>
	Object.freeze(
		commands.map( ( command ) =>
			Object.freeze( { ...command, example: Object.freeze( [ ...command.example ] ) } )
		)
	);
const ROUTE_COMMANDS = routeCommands( [
	{
		usage: `option get <${ READABLE_OPTIONS.join( '|' ) }>`,
		operationClass: 'read',
		example: [ 'option', 'get', READABLE_OPTIONS[ 0 ] ],
		matches: ( list ) =>
			list.length === 3 &&
			list[ 0 ] === 'option' &&
			list[ 1 ] === 'get' &&
			READABLE_OPTIONS.includes( list[ 2 ] ),
	},
	{
		usage: 'post list',
		operationClass: 'read',
		example: [ 'post', 'list' ],
		matches: ( list ) => list.length === 2 && list[ 0 ] === 'post' && list[ 1 ] === 'list',
	},
	{
		usage: `post get <id of up to ${ POST_ID_DIGITS } digits>`,
		operationClass: 'read',
		example: [ 'post', 'get', '1' ],
		matches: ( list ) =>
			list.length === 3 && list[ 0 ] === 'post' && list[ 1 ] === 'get' && postId.test( list[ 2 ] ),
	},
	{
		usage: `post create ${ DRAFT_STATUS } --post_title=<${ TITLE_LENGTH.min } to ${ TITLE_LENGTH.max } characters> [--post_content=<up to ${ CONTENT_LENGTH.max } characters>]`,
		operationClass: 'command',
		example: [ 'post', 'create', DRAFT_STATUS, '--post_title=Draft', '--post_content=' ],
		matches: isDraftCreation,
	},
] );

// The class of a WP-CLI command this build runs; undefined for every other.
export function classifyWpCliArgs( args: readonly unknown[] ): ClaudeOperationClass | undefined {
	if ( ! args.every( ( arg ) => typeof arg === 'string' ) ) return;
	const list = args as readonly string[];
	return ROUTE_COMMANDS.find( ( command ) => command.matches( list ) )?.operationClass;
}

/** Each WP-CLI command `classifyWpCliArgs` runs, from the one table both read. */
export function wpCliRouteCommands(): readonly WpCliRouteCommand[] {
	return ROUTE_COMMANDS;
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
