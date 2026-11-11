import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import ts from 'typescript';

// Reads the Studio tool sources the way a bundler links them, so a test can
// tie a tool's rule to what its module really imports instead of to a list of
// names someone keeps by hand.

const agentRoot = path.resolve( import.meta.dirname, '../../../..' );
const toolsDirectory = path.join( agentRoot, 'node', 'tools' );
const workspacePackages: ReadonlyArray< readonly [ string, string ] > = [
	[ '@studio/agent/', agentRoot ],
	[ '@studio/common/', path.resolve( agentRoot, '../common' ) ],
];

interface ModuleScan {
	/** Every module specifier the file loads at run time. */
	imports: string[];
	/** The name of every tool the file defines. */
	tools: string[];
}

function scan( file: string ): ModuleScan {
	const source = ts.createSourceFile(
		file,
		readFileSync( file, 'utf8' ),
		ts.ScriptTarget.Latest,
		true
	);
	const imports: string[] = [];
	const tools: string[] = [];
	const visit = ( node: ts.Node ): void => {
		if ( ts.isImportDeclaration( node ) ) {
			// Only a whole `import type` is erased for certain; an import of inline
			// type names can survive as a side-effect import.
			if ( ! node.importClause?.isTypeOnly && ts.isStringLiteral( node.moduleSpecifier ) )
				imports.push( node.moduleSpecifier.text );
		} else if ( ts.isExportDeclaration( node ) ) {
			if ( ! node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral( node.moduleSpecifier ) )
				imports.push( node.moduleSpecifier.text );
		} else if ( ts.isCallExpression( node ) ) {
			const callee = node.expression;
			const [ first ] = node.arguments;
			const loads =
				callee.kind === ts.SyntaxKind.ImportKeyword ||
				( ts.isIdentifier( callee ) && callee.text === 'require' );
			if ( loads ) {
				// A module chosen at run time cannot be followed, so the scan would
				// prove nothing about the file.
				if ( ! first || ! ts.isStringLiteralLike( first ) )
					throw new Error( `${ file } loads a module the scan cannot name` );
				imports.push( first.text );
			} else if (
				ts.isIdentifier( callee ) &&
				callee.text === 'defineTool' &&
				first &&
				ts.isStringLiteralLike( first )
			) {
				tools.push( first.text );
			}
		}
		ts.forEachChild( node, visit );
	};
	visit( source );
	return { imports, tools };
}

// The file a specifier inside this repository names, or undefined for a package.
function resolveLocal( from: string, specifier: string ): string | undefined {
	let base: string | undefined;
	if ( specifier.startsWith( '.' ) ) base = path.resolve( path.dirname( from ), specifier );
	for ( const [ prefix, root ] of workspacePackages )
		if ( specifier.startsWith( prefix ) )
			base = path.join( root, specifier.slice( prefix.length ) );
	if ( base === undefined ) return;
	for ( const candidate of [
		`${ base }.ts`,
		`${ base }.tsx`,
		path.join( base, 'index.ts' ),
		base,
	] )
		if ( existsSync( candidate ) && statSync( candidate ).isFile() ) return candidate;
	throw new Error( `${ from } imports ${ specifier }, which the scan cannot find` );
}

export interface StudioToolModule {
	/** The file under `tools/`. */
	file: string;
	/** The tools it defines. */
	names: string[];
	/** Every repository file it loads, at any depth, itself included. */
	files: string[];
	/** Every package or Node module those files load. */
	packages: string[];
	/** The text of those files. */
	sources: string;
}

function linked( entry: string ): Pick< StudioToolModule, 'files' | 'packages' | 'sources' > {
	const files = new Set( [ entry ] );
	const packages = new Set< string >();
	for ( const file of files )
		for ( const specifier of scan( file ).imports ) {
			const local = resolveLocal( file, specifier );
			if ( local === undefined ) packages.add( specifier );
			else if ( /\.tsx?$/.test( local ) ) files.add( local );
		}
	return {
		files: [ ...files ].map( ( file ) => path.relative( agentRoot, file ).replace( /\\/g, '/' ) ),
		packages: [ ...packages ].sort(),
		sources: [ ...files ].map( ( file ) => readFileSync( file, 'utf8' ) ).join( '\n' ),
	};
}

/** Every module directly under `tools/` that defines a tool, with all it links. */
export function studioToolModules(): StudioToolModule[] {
	return readdirSync( toolsDirectory )
		.filter( ( name ) => name.endsWith( '.ts' ) )
		.map( ( name ) => {
			const file = path.join( toolsDirectory, name );
			return { file: name, names: scan( file ).tools, ...linked( file ) };
		} )
		.filter( ( module ) => module.names.length > 0 );
}

const BROWSER_PACKAGE = /^(?:playwright(?:-core)?|@playwright\/[^/]+|puppeteer(?:-core)?)(?:\/|$)/;

/** Whether anything the module links loads a browser automation package. */
export function linksBrowser( module: StudioToolModule ): boolean {
	return module.packages.some( ( name ) => BROWSER_PACKAGE.test( name ) );
}

/** The repository files that load a browser automation package themselves. */
export function browserLayer( modules: readonly StudioToolModule[] ): string[] {
	const files = new Set( modules.flatMap( ( module ) => module.files ) );
	return [ ...files ]
		.filter( ( file ) =>
			scan( path.join( agentRoot, file ) ).imports.some( ( name ) => BROWSER_PACKAGE.test( name ) )
		)
		.sort();
}

// What a module's imports and calls show about the channels it uses. Each
// entry names the channels that would explain it; a declaration must mark at
// least one of them as used.
const CHANNEL_EVIDENCE: ReadonlyArray< {
	channels: readonly string[];
	packages?: RegExp;
	sources?: RegExp;
} > = [
	{ channels: [ 'drivesBrowser' ], packages: BROWSER_PACKAGE },
	{ channels: [ 'readsLocalFiles', 'writesLocalFiles' ], packages: /^(?:node:)?fs(?:\/|$)/ },
	{ channels: [ 'spawnsProcess' ], packages: /^(?:node:)?(?:child_process|worker_threads)$/ },
	{
		channels: [ 'requestsNetwork', 'reachesWpcom' ],
		packages: /^(?:node:)?(?:https?|http2|net|tls|dgram|dns)(?:\/|$)|^(?:undici|ws|wpcom)(?:\/|$)/,
		sources: /\bfetch\s*\(/,
	},
	{ channels: [ 'callsHostOperation' ], sources: /\bhost\s*\??\.\s*[A-Za-z]/ },
	{ channels: [ 'runsWpCli' ], sources: /\b(?:wpCli|runWpCli)\s*\(/ },
];

/** For each thing the module's code shows, the channels that would explain it. */
export function channelEvidence( module: StudioToolModule ): string[][] {
	return CHANNEL_EVIDENCE.filter(
		( { packages, sources } ) =>
			( packages && module.packages.some( ( name ) => packages.test( name ) ) ) ||
			( sources && sources.test( module.sources ) )
	).map( ( { channels } ) => [ ...channels ] );
}
