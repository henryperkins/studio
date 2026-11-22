// A saved session may have moved with its screenshots. Rebase only files from
// its own sidecar; the connector checks the actual session and file on disk.
export function claudeMediaPath( sessionFile: string, source?: string | null ) {
	if ( ! sessionFile.endsWith( '.jsonl' ) || ! source || /^[a-z]+:\/\//i.test( source ) )
		return undefined;
	const sidecar = sessionFile.slice( 0, -'.jsonl'.length ) + '.screenshots';
	const directory = sidecar.split( /[\\/]/ ).at( -1 );
	const parts = source.split( /[\\/]/ );
	const name = parts.at( -1 );
	if ( ! name || parts.at( -2 ) !== directory || ! /^[a-z0-9_-]+\.(png|jpe?g|webp)$/i.test( name ) )
		return undefined;
	return sidecar + ( sessionFile.includes( '\\' ) ? '\\' : '/' ) + name;
}
