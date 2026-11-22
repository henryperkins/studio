import { lstat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { WP_CLI_FORMS } from './wp-cli-command-table';
import type { CommandForm, WpCliFileArgument } from './wp-cli-command-table';
import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

export type { WpCliFileArgument } from './wp-cli-command-table';

type WpCliDecision =
	| { refusal: string }
	| {
			operationClass: ClaudeOperationClass;
			known: boolean;
			files: WpCliFileArgument[];
			reason?: string;
			draft?: true;
	  };
interface Word {
	value: string;
	index: number;
}
interface Option extends Word {
	key: string;
	argument?: string;
}
const globalOptions =
	'format:format fields:names field:name porcelain:name? quiet user:name skip-plugins:names? skip-themes:names? skip-packages color no-color debug:names?';
const forbidden = new Set( [
	'path',
	'url',
	'blog',
	'http',
	'ssh',
	'require',
	'exec',
	'prompt',
	'edit',
	'skip-packages',
] );
const word = /^[a-zA-Z0-9_][\w.:-]*$/;
const slug = /^[a-z0-9][a-z0-9-]*$/;
const integer = /^\d+$/;
const hasScheme = ( value: string ) =>
	/^[a-z][\w+.-]*:/i.test( value ) && ! /^[a-z]:[\\/]/i.test( value );
const webSource = ( value: string ) => /^https?:\/\//i.test( value );
const UNKNOWN =
	'Studio has no complete rule for these arguments. Review the whole command. Studio has not checked everything it may read or write.';
const CODE = 'Review the whole command. The code it runs controls what it reads and writes.';
const NETWORK = 'Review the whole command and the supplied address before fetching from it.';
const BLOCKED =
	'Use the conversation’s local site. Remove site or host redirection, code-loading, package overrides and interactive options.';
const MACHINE =
	'Use a site operation. Studio does not manage WP-CLI packages, aliases, its cache, its server or its installation through this tool.';
const FILE =
	'Use a plain file or folder in the local site. Input streams, file wrappers and interactive input are unavailable.';
const EXPORT =
	'Use one local export folder and a plain XML filename ending in .xml, or use --stdout alone.';

function references( text: string ): boolean {
	try {
		const value: unknown = JSON.parse( text );
		return (
			Array.isArray( value ) &&
			value.every(
				( obj ) =>
					obj && Object.keys( obj ).length === 1 && Number.isSafeInteger( obj.id ) && obj.id > 0
			)
		);
	} catch {
		return false;
	}
}

function acceptsValue( kind: string, value: string ): boolean {
	switch ( kind ) {
		case 'text':
			return true;
		case 'name':
			return word.test( value );
		case 'names':
			return value.split( ',' ).every( ( name ) => word.test( name ) );
		case 'id':
			return integer.test( value );
		case 'ids':
			return value.split( ',' ).every( ( id ) => integer.test( id ) );
		case 'integer':
			return /^-?\d+$/.test( value );
		case 'locale':
			return /^[a-zA-Z]{2,3}(?:[_-][a-zA-Z0-9]+)*$/.test( value );
		case 'email':
			return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( value );
		case 'version':
			return /^[a-zA-Z0-9][\w.+-]*$/.test( value );
		case 'format':
			return [ 'table', 'json', 'csv', 'yaml', 'ids', 'count', 'list', 'plaintext' ].includes(
				value
			);
		case 'package':
			return slug.test( value );
		case 'archive':
			return ! hasScheme( value ) && /\.zip$/i.test( value );
		case 'url':
			return webSource( value );
		case 'file':
		case 'media':
		case 'output':
		case 'outputDir':
			return !! value && ! hasScheme( value );
		case 'xml':
			return (
				/^(?:[\w.-]|\{(?:site|date|n)\})+\.xml$/.test( value ) &&
				! value.includes( '..' ) &&
				! /^(?:con|aux|prn|nul|com[1-9]|lpt[1-9])\./i.test( value )
			);
		case 'references':
			return references( value );
		case 'productType':
			return [ 'simple', 'variable', 'grouped' ].includes( value );
		case 'price':
			return /^\d+(?:\.\d+)?$/.test( value );
		default:
			return false;
	}
}

function optionsMatch( form: CommandForm, options: Option[] ): boolean {
	const keys = new Set( options.map( ( opt ) => opt.key ) );
	if (
		keys.size !== options.length ||
		( form.required && ! keys.has( form.required ) ) ||
		( form.excluded && keys.has( form.excluded ) )
	)
		return false;
	const spec = new Map(
		[ ...globalOptions.split( ' ' ), ...form.options ].map( ( item ) => {
			const [ name, kind ] = item.split( ':' );
			return [ name, kind ?? '' ] as const;
		} )
	);
	return options.every( ( { key, argument } ) => {
		const kind = spec.get( key );
		if ( kind === undefined ) return false;
		if ( argument === undefined ) return ! kind || kind.endsWith( '?' );
		return !! kind && acceptsValue( kind.replace( /\?$/, '' ), argument );
	} );
}

function slotKind( slot: string ): string {
	return slot.replace( /[<>.[\]]/g, '' );
}

function argumentsMatch( form: CommandForm, args: Word[] ): boolean {
	if ( form.name === 'post update' )
		return (
			args.some( ( arg ) => integer.test( arg.value ) ) &&
			args.filter( ( arg ) => ! integer.test( arg.value ) ).length <= 1
		);
	let cursor = 0;
	for ( const slot of form.slots ) {
		const many = slot.endsWith( '...' ) || slot.endsWith( '...]' );
		const optional = slot.startsWith( '[' );
		const count = many ? args.length - cursor : Math.min( 1, args.length - cursor );
		if ( ! count && ! optional ) return false;
		for ( let i = 0; i < count; i++ )
			if ( ! acceptsValue( slotKind( slot ), args[ cursor++ ].value ) ) return false;
	}
	return cursor === args.length;
}

function validExportOptions( options: Option[] ): boolean {
	const filenames = options.filter( ( opt ) => opt.key === 'filename_format' );
	const stdout = options.filter( ( opt ) => opt.key === 'stdout' );
	return (
		! options.some( ( opt ) => [ 'no-filename_format', 'no-stdout' ].includes( opt.key ) ) &&
		filenames.length <= 1 &&
		stdout.length <= 1 &&
		( ! filenames.length || acceptsValue( 'xml', filenames[ 0 ].argument ?? '' ) ) &&
		( ! stdout.length ||
			( stdout[ 0 ].argument === undefined &&
				! filenames.length &&
				! options.some( ( opt ) => opt.key === 'dir' ) ) )
	);
}

function decideFiles(
	form: CommandForm | undefined,
	args: Word[],
	options: Option[],
	length: number
): WpCliFileArgument[] | string {
	const files: WpCliFileArgument[] = [];
	for ( const rule of form?.fileOperands ?? [] ) {
		if ( 'option' in rule ) {
			const matching = options.filter( ( opt ) => opt.key === rule.option );
			if ( matching.length > 1 || options.some( ( opt ) => opt.key === 'no-' + rule.option ) )
				return 'Supply each file option once with its actual destination.';
			if ( rule.defaultSite && ! validExportOptions( options ) ) return EXPORT;
			const opt = matching[ 0 ];
			const prefix = '--' + rule.option + '=';
			if ( ! opt ) {
				if ( rule.required )
					return 'Supply the required --' + rule.option + ' option for the local site.';
				if ( rule.defaultSite && ! options.some( ( item ) => item.key === 'stdout' ) )
					files.push( { index: length, prefix, kind: rule.kind } );
				continue;
			}
			if ( rule.optionalValue && ( opt.argument === undefined || opt.argument === '-' ) ) continue;
			if ( ! opt.argument || opt.argument === '-' || hasScheme( opt.argument ) ) return FILE;
			const file: WpCliFileArgument = { index: opt.index, prefix, kind: rule.kind };
			if ( rule.authorMapping && [ 'create', 'skip' ].includes( opt.argument ) )
				file.reservedPath = true;
			files.push( file );
			continue;
		}

		let start: number;
		if ( rule.position === 'first-nonnumeric' ) {
			// WP-CLI's is_numeric also accepts signed, decimal and exponential numbers.
			// Require plain IDs so Studio identifies the same post-content file.
			if (
				args.some(
					( arg ) =>
						! integer.test( arg.value ) &&
						/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test( arg.value.trim() )
				)
			)
				return 'Use plain decimal post IDs and a site-local content file.';
			start = args.findIndex( ( arg ) => ! integer.test( arg.value ) );
		} else start = rule.position;
		if ( start < 0 || start >= args.length ) {
			if ( rule.required ) return 'Supply an explicit site-local file for this WP-CLI command.';
			continue;
		}
		const operands = rule.repeated ? args.slice( start ) : [ args[ start ] ];
		for ( const arg of operands ) {
			if ( rule.source && webSource( arg.value ) ) continue;
			if ( rule.source === 'package' && slug.test( arg.value ) ) continue;
			if ( ! arg.value || arg.value === '-' || hasScheme( arg.value ) ) return FILE;
			const file: WpCliFileArgument = { index: arg.index, kind: rule.kind };
			if ( rule.evalScript ) file.evalArgs = args.slice( start + 1 ).map( ( item ) => item.index );
			files.push( file );
		}
	}
	return files;
}

const byName = new Map< string, CommandForm[] >();
for ( const form of WP_CLI_FORMS ) {
	const group = byName.get( form.name ) ?? [];
	group.push( form );
	byName.set( form.name, group );
}

export function inspectWpCliArgs( input: readonly unknown[] ): WpCliDecision {
	const words: Word[] = [];
	const options: Option[] = [];
	for ( const [ index, value ] of input.entries() ) {
		if ( typeof value !== 'string' || value.includes( '\0' ) )
			return { refusal: 'Supply WP-CLI command arguments as plain text.' };
		// WP_CLI\\Configurator::extract_assoc accepts --key=value and --key flags
		// in every position. A standalone -- does not turn off its option parser.
		const opt = /^--([^=]+?)(?:=([\s\S]*))?$/.exec( value );
		if ( opt ) {
			const key = opt[ 1 ];
			if (
				forbidden.has( key.replace( /^no-/, '' ).toLowerCase() ) &&
				! ( key === 'skip-packages' && opt[ 2 ] === undefined )
			)
				return { refusal: BLOCKED };
			options.push( { key, value, index, argument: opt[ 2 ] } );
		} else {
			if ( value.startsWith( '@' ) ) return { refusal: BLOCKED };
			words.push( { value, index } );
		}
	}
	const [ namespace, command ] = words.map( ( arg ) => arg.value.toLowerCase() );
	if ( ! namespace || ! /^[a-z0-9][\w-]*$/i.test( namespace ) )
		return {
			refusal: 'Start with the WordPress command name, without a wp prefix or shell syntax.',
		};
	if (
		[ 'package', 'server' ].includes( namespace ) ||
		( namespace === 'cli' && [ 'alias', 'update', 'cache' ].includes( command ) )
	)
		return { refusal: MACHINE };
	if (
		( [ 'post', 'option', 'config' ].includes( namespace ) && command === 'edit' ) ||
		( namespace === 'db' && [ 'cli', 'connect' ].includes( command ) )
	)
		return {
			refusal:
				'Use a non-interactive WordPress command. Studio cannot supply an editor or terminal.',
		};
	let name = '';
	for ( let len = Math.min( 3, words.length ); len > 0; len-- ) {
		const guess = words
			.slice( 0, len )
			.map( ( arg ) => arg.value )
			.join( ' ' );
		if ( byName.has( guess ) ) {
			name = guess;
			break;
		}
	}
	const args = words.slice( name ? name.split( ' ' ).length : 0 );
	const candidates = byName.get( name ) ?? [];
	const files = decideFiles( candidates[ 0 ], args, options, input.length );
	if ( typeof files === 'string' ) return { refusal: files };
	const row = candidates.find(
		( candidate ) => optionsMatch( candidate, options ) && argumentsMatch( candidate, args )
	);
	if ( ! row ) return { operationClass: 'command', known: false, reason: UNKNOWN, files };
	const { operationClass } = row;
	const result: WpCliDecision = { operationClass, files, known: true };
	if ( operationClass === 'command' )
		result.reason = args.some( ( arg ) => webSource( arg.value ) ) ? NETWORK : CODE;
	if ( name === 'post create' && wpCliOption( input, 'post_status' ) === 'draft' )
		result.draft = true;
	return result;
}

export function classifyWpCliArgs( args: readonly unknown[] ): ClaudeOperationClass | undefined {
	const result = inspectWpCliArgs( args );
	return 'refusal' in result ? undefined : result.operationClass;
}

/** The command synopses used by the classifier and by the route note. */
export function wpCliRouteCommands(): readonly CommandForm[] {
	return WP_CLI_FORMS;
}

export function wpCliOption( args: readonly unknown[], name: string ): string | undefined {
	const prefix = '--' + name + '=';
	return args
		.find( ( arg ): arg is string => typeof arg === 'string' && arg.startsWith( prefix ) )
		?.slice( prefix.length );
}

// WP-CLI reads configuration that can point a command at another site or host.
export async function hasWpCliOverrides( siteDirectory: string ): Promise< boolean > {
	if (
		Object.entries( process.env ).some( ( [ name, value ] ) => /^WP_CLI_/i.test( name ) && value )
	)
		return true;
	// PHP's get_home_dir() falls back for both the empty string and "0".
	// The bundled PHP process runs with the selected site as its working directory.
	const home = process.env.HOME;
	const phpHome =
		home && home !== '0' ? home : ( process.env.HOMEDRIVE ?? '' ) + ( process.env.HOMEPATH ?? '' );
	const candidates = new Set( [
		path.join( os.homedir(), '.wp-cli', 'config.yml' ),
		path.resolve( siteDirectory, phpHome.replace( /[/\\]+$/, '' ) + '/.wp-cli/config.yml' ),
	] );
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
