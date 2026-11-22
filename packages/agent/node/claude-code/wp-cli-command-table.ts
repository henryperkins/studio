import type { ClaudeOperationClass } from '@studio/agent/protocol/claude-code';

export type FileKind = 'read' | 'write' | 'directory' | 'write-directory';
export interface WpCliFileArgument {
	index: number;
	prefix?: string;
	kind: FileKind;
	evalArgs?: readonly number[];
	reservedPath?: true;
}
type FileOperand =
	| {
			position: number | 'first-nonnumeric';
			kind: FileKind;
			repeated?: true;
			required?: true;
			source?: 'local-or-url' | 'package';
			evalScript?: true;
	  }
	| {
			option: string;
			kind: FileKind;
			optionalValue?: true;
			defaultSite?: true;
			authorMapping?: true;
			required?: true;
	  };
const fileOperands = ( ...items: FileOperand[] ): readonly FileOperand[] =>
	Object.freeze( items.map( ( item ) => Object.freeze( item ) ) );
const localPackage = fileOperands( {
	position: 0,
	kind: 'read',
	repeated: true,
	source: 'package',
} );
const pathRules: Readonly< Record< string, readonly FileOperand[] > > = {
	'post create': fileOperands( { position: 0, kind: 'read' } ),
	'post update': fileOperands( { position: 'first-nonnumeric', kind: 'read' } ),
	'plugin install': localPackage,
	'theme install': localPackage,
	'core update': fileOperands( { position: 0, kind: 'read', source: 'local-or-url' } ),
	'media import': fileOperands( {
		position: 0,
		kind: 'read',
		repeated: true,
		source: 'local-or-url',
	} ),
	export: fileOperands( { option: 'dir', kind: 'write-directory', defaultSite: true } ),
	import: fileOperands(
		{ position: 0, kind: 'read', repeated: true, required: true },
		{ option: 'authors', kind: 'write', authorMapping: true, required: true }
	),
	'db import': fileOperands( { position: 0, kind: 'read', required: true } ),
	'db export': fileOperands( { position: 0, kind: 'write', required: true } ),
	'search-replace': fileOperands(
		{ option: 'export', kind: 'write', optionalValue: true },
		{ option: 'log', kind: 'write', optionalValue: true }
	),
	'eval-file': fileOperands( { position: 0, kind: 'read', evalScript: true, required: true } ),
};
export const WP_CLI_EVAL_FILES: Readonly<
	Record< string, readonly { position: number; kind: FileKind }[] >
> = {
	'tmp/taxonomist/apply-changes.php': [
		{ position: 0, kind: 'read' },
		{ position: 1, kind: 'write' },
	],
	'tmp/taxonomist/backup.php': [ { position: 0, kind: 'write' } ],
	'tmp/taxonomist/export-posts.php': [ { position: 0, kind: 'write' } ],
	'tmp/taxonomist/restore.php': [ { position: 0, kind: 'read' } ],
};
export interface CommandForm {
	name: string;
	canonicalName: string;
	usage: string;
	operationClass: ClaudeOperationClass;
	example: readonly string[];
	slots: readonly string[];
	options: readonly string[];
	fileOperands: readonly FileOperand[];
	required?: string;
	excluded?: string;
}

const sample: Record< string, string > = {
	id: '2',
	name: 'sample',
	text: 'sample',
	email: 'sample@example.test',
	file: 'page.html',
	output: 'site.sql',
	archive: 'plugin.zip',
	url: 'https://example.test/sample.zip',
	media: 'image.png',
	package: 'hello-dolly',
	locale: 'de_DE',
	ids: '2,3',
};

// The positional names describe the validator as well as the usage shown to Claude.
// Optional and repeated slots follow WP-CLI's documented command synopsis.
function form(
	usage: string,
	operationClass: ClaudeOperationClass,
	options = '',
	conditions: { required?: string; excluded?: string; example?: string[] } = {}
): CommandForm {
	const tokens = usage.split( ' ' );
	const firstSlot = tokens.findIndex(
		( token ) => token.startsWith( '<' ) || token.startsWith( '[' )
	);
	const name = firstSlot < 0 ? usage : tokens.slice( 0, firstSlot ).join( ' ' );
	const slots = firstSlot < 0 ? [] : tokens.slice( firstSlot );
	const example =
		conditions.example ??
		slots
			.filter( ( slot ) => ! slot.startsWith( '[' ) )
			.map( ( slot ) => sample[ slot.replace( /[<>.]/g, '' ) ] ?? 'sample' );
	return Object.freeze( {
		name,
		canonicalName: name,
		usage: conditions.required ? usage + ' --' + conditions.required : usage,
		operationClass,
		example: Object.freeze( [ ...name.split( ' ' ), ...example ] ),
		slots: Object.freeze( slots ),
		options: Object.freeze( options ? options.split( ' ' ) : [] ),
		fileOperands: pathRules[ name ] ?? Object.freeze( [] ),
		required: conditions.required,
		excluded: conditions.excluded,
	} );
}

const read = ( usage: string, options = '' ) => form( usage, 'read', options );
const change = ( usage: string, options = '', example?: string[] ) =>
	form( usage, 'local-change', options, { example } );
const overwrite = ( usage: string, options = '' ) => form( usage, 'local-overwrite', options );
const code = ( usage: string, options = '' ) => form( usage, 'command', options );

const postFields =
	'post_title:text post_content:text post_excerpt:text post_status:name post_type:name post_name:text post_parent:id post_author:id menu_order:id post_category:ids post_date:text comment_status:name ping_status:name';
const commentFields =
	'comment_post_ID:id comment_content:text comment_author:text comment_author_email:text comment_approved:name comment_parent:id user_id:id';
const userFields =
	'role:name display_name:text first_name:text last_name:text nickname:text user_email:text description:text';
const termFields = 'slug:text name:text description:text parent:id';
const installFlags = 'activate version:version';
const mediaFlags =
	'post_id:id post_name:text title:text caption:text alt:text desc:text featured_image preserve-filetime';
const searchOptions =
	'dry-run precise report-changed-only tables-only verbose skip-columns:names include-columns:names';
const searchOutput = searchOptions + ' export:output? log:output?';
const exportOptions =
	'dir:outputDir filename_format:xml post_type:names post_status:names post_author:id post__in:ids start_date:text end_date:text skip_comments';
const extensionForms = ( noun: 'plugin' | 'theme' ) => [
	form( noun + ' install <package>...', 'local-change', installFlags, { excluded: 'force' } ),
	form( noun + ' install <package>...', 'local-overwrite', installFlags + ' force', {
		required: 'force',
		example: [ 'hello-dolly', '--force' ],
	} ),
	code( noun + ' install <archive>...', installFlags + ' force' ),
	code( noun + ' install <url>...', installFlags + ' force' ),
	read( noun + ' list', 'status:name search:text' ),
	read( noun + ' get <name>' ),
	read( noun + ' status [<name>]' ),
	read( noun + ' is-installed <name>' ),
	read( noun + ' is-active <name>' ),
	read( noun + ' path [<name>]', 'dir' ),
	read( noun + ' search <text>', 'page:id per-page:id' ),
	overwrite( noun + ' update [<name>...]', 'all version:version minor patch' ),
	overwrite( noun + ' delete <name>...' ),
];

const forms = [
	read(
		'post list',
		'post_type:names post_status:names post__in:ids posts_per_page:integer order:name orderby:name post_parent:id author:id name:text p:id s:text'
	),
	read( 'post get <id>' ),
	read( 'post exists <id>' ),
	read( 'post url-to-id <text>' ),
	change( 'post create [<file>]', postFields, [
		'page.html',
		'--post_type=page',
		'--post_title=Contact',
	] ),
	change( 'post update <id>... [<file>]', postFields, [
		'2',
		'page.html',
		'--post_title=Contact',
	] ),
	overwrite( 'post delete <id>...', 'force' ),
	read( 'post-type list' ),
	read( 'post-type get <name>' ),
	read( 'taxonomy list' ),
	read( 'taxonomy get <name>' ),
	read( 'option get <name>' ),
	read( 'option list', 'search:text autoload:name' ),
	change( 'option add <name> <text>', 'autoload:name' ),
	change( 'option update <name> <text>', 'autoload:name' ),
	overwrite( 'option delete <name>...' ),
	read( 'term list <name>', 'hide_empty parent:id search:text' ),
	read( 'term get <name> <id>' ),
	change( 'term create <name> <text>', termFields ),
	change( 'term update <name> <id>', termFields, [ 'category', '2', '--description=Coffee' ] ),
	change( 'term recount <name>...' ),
	overwrite( 'term delete <name> <id>...' ),
	read( 'post term list <id> <name>' ),
	change( 'post term add <id> <name> <text>...', 'by:name' ),
	overwrite( 'post term remove <id> <name> <text>...', 'by:name' ),
	read( 'user list', 'role:name search:text number:id' ),
	read( 'user get <name>' ),
	change( 'user create <name> <email>', userFields ),
	change( 'user update <id>...', userFields, [ '2', '--display_name=Coffee' ] ),
	overwrite( 'user delete <id>...', 'reassign:id yes' ),
	read( 'comment list', 'status:name post_id:id number:id' ),
	read( 'comment get <id>' ),
	change( 'comment create', commentFields, [ '--comment_post_ID=2', '--comment_content=Hello' ] ),
	change( 'comment update <id>...', commentFields, [ '2', '--comment_content=Updated' ] ),
	overwrite( 'comment delete <id>...', 'force' ),
	...[ 'post', 'term', 'user', 'comment' ].flatMap( ( noun ) => [
		read( noun + ' meta get <id> <name>' ),
		read( noun + ' meta list <id>' ),
		change( noun + ' meta add <id> <name> <text>' ),
		change( noun + ' meta update <id> <name> <text>' ),
		overwrite( noun + ' meta delete <id> <name>' ),
	] ),
	read( 'menu list' ),
	read( 'menu item list <name>' ),
	read( 'menu location list' ),
	change( 'menu create <text>' ),
	change( 'menu location assign <name> <name>' ),
	change( 'menu item add-post <name> <id>', 'title:text position:id parent-id:id' ),
	overwrite( 'menu delete <name>...' ),
	overwrite( 'menu item delete <id>...' ),
	overwrite( 'menu location remove <name> <name>' ),
	read( 'sidebar list' ),
	read( 'widget list <name>' ),
	change( 'widget add <name> <name> [<id>]', 'title:text text:text', [
		'text',
		'sidebar-1',
		'2',
		'--title=Welcome',
	] ),
	change( 'widget update <name>', 'title:text text:text', [ 'text-2', '--title=Welcome' ] ),
	overwrite( 'widget delete <name>...' ),
	overwrite( 'widget reset <name>...' ),
	...extensionForms( 'theme' ),
	...extensionForms( 'plugin' ),
	read( 'plugin verify-checksums [<name>...]', 'all strict version:version' ),
	change( 'theme activate <name>' ),
	change( 'plugin activate <name>...' ),
	change( 'plugin deactivate <name>...' ),
	overwrite( 'plugin uninstall <name>...', 'deactivate skip-delete' ),
	read( 'language core list' ),
	change( 'language core install <locale>...', 'activate' ),
	overwrite( 'language core uninstall <locale>...' ),
	...[ 'plugin', 'theme' ].flatMap( ( noun ) => [
		read( 'language ' + noun + ' list <name>' ),
		change( 'language ' + noun + ' install <name> <locale>...' ),
		overwrite( 'language ' + noun + ' uninstall <name> <locale>...' ),
	] ),
	read( 'core version', 'extra' ),
	read( 'core is-installed', 'network' ),
	read( 'core check-update', 'force-check' ),
	read( 'core verify-checksums', 'version:version locale:locale include-root' ),
	overwrite( 'core update [<archive>]', 'version:version force minor locale:locale' ),
	code( 'core update <url>', 'version:version force' ),
	change( 'cache flush' ),
	change( 'rewrite flush' ),
	read( 'rewrite list' ),
	read( 'transient get <name>' ),
	read( 'transient list' ),
	change( 'transient set <name> <text> [<id>]' ),
	overwrite( 'transient delete [<name>]', 'all expired' ),
	change( 'media import <media>...', mediaFlags ),
	code( 'media import <url>...', mediaFlags ),
	form( 'export', 'read', 'stdout', { required: 'stdout', example: [ '--stdout' ] } ),
	form( 'export', 'local-overwrite', exportOptions, {
		excluded: 'stdout',
		example: [ '--dir=exports' ],
	} ),
	form( 'import <file>...', 'local-overwrite', 'authors:file skip:names', {
		required: 'authors',
		example: [ 'site.xml', '--authors=skip' ],
	} ),
	overwrite( 'db export <output>' ),
	overwrite( 'db import <file>' ),
	overwrite( 'db reset', 'yes' ),
	overwrite( 'db drop', 'yes' ),
	overwrite( 'db clean', 'yes' ),
	overwrite( 'site empty', 'yes uploads' ),
	form( 'search-replace <text> <text> [<name>...]', 'read', searchOptions, {
		required: 'dry-run',
		example: [ 'before', 'after', '--dry-run' ],
	} ),
	form( 'search-replace <text> <text> [<name>...]', 'local-overwrite', searchOptions, {
		excluded: 'dry-run',
		example: [ 'before', 'after' ],
	} ),
	form( 'search-replace <text> <text> [<name>...]', 'local-overwrite', searchOutput, {
		required: 'export',
		example: [ 'before', 'after', '--export=site.sql' ],
	} ),
	form( 'search-replace <text> <text> [<name>...]', 'local-overwrite', searchOutput, {
		required: 'log',
		excluded: 'export',
		example: [ 'before', 'after', '--log=search.log' ],
	} ),
	read( 'jetpack module list' ),
	change( 'jetpack module activate <name>' ),
	form( 'wc product_cat create', 'local-change', 'name:text', {
		required: 'name',
		example: [ '--name=Coffee', '--user=admin' ],
	} ),
	form(
		'wc product create',
		'local-change',
		'name:text type:productType regular_price:price status:name description:text images:references categories:references',
		{
			required: 'name',
			example: [ '--name=Coffee', '--type=simple', '--regular_price=8', '--user=admin' ],
		}
	),
	code( 'eval <text>' ),
	code( 'eval-file <file> [<text>...]' ),
	code( 'shell' ),
];

// These aliases are declared by the commands in Studio's bundled WP-CLI PHAR.
const aliases: Readonly< Record< string, string > > = {
	'db export': 'db dump',
	'core update': 'core upgrade',
	'plugin update': 'plugin upgrade',
	'theme update': 'theme upgrade',
	'theme delete': 'theme uninstall',
	'option update': 'option set',
	'post meta update': 'post meta set',
	'user meta update': 'user meta set',
	'term meta update': 'term meta set',
	'comment meta update': 'comment meta set',
};

export const WP_CLI_FORMS: readonly CommandForm[] = Object.freeze(
	forms.flatMap( ( original ) => {
		const name = aliases[ original.name ];
		if ( ! name ) return [ original ];
		return [
			original,
			Object.freeze( {
				...original,
				name,
				usage: name + original.usage.slice( original.name.length ),
				example: Object.freeze( [
					...name.split( ' ' ),
					...original.example.slice( original.name.split( ' ' ).length ),
				] ),
			} ),
		];
	} )
);
