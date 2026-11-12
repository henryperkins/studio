// The Studio server an SDK stand-in was given, as a real executable reports
// it: connected, with exactly the tools that server registered.
export function reportedStudioServer( options: unknown ) {
	const { studio } = ( options as { mcpServers: Record< string, { instance: unknown } > } )
		.mcpServers;
	const registered = ( studio.instance as { _registeredTools: Record< string, unknown > } )
		._registeredTools;
	return {
		name: 'studio',
		source: 'sdk',
		status: 'connected',
		tools: Object.keys( registered ).map( ( name ) => ( { name } ) ),
	};
}
