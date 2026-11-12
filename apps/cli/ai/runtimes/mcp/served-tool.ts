import {
	describeToolError,
	runStudioTool,
	type AnyStudioAgentTool,
	type createResultNotes,
	type StudioAgentHost,
} from '@studio/agent/node';

// The site an MCP call works on is the one it names.
async function siteNamed( host: StudioAgentHost, args: Record< string, unknown > ) {
	if ( typeof args.nameOrPath !== 'string' ) {
		return undefined;
	}
	try {
		return await host.sites.resolve( args.nameOrPath );
	} catch {
		return undefined;
	}
}

// Runs a served tool for an MCP call through the shared execution semantics and
// renders the outcome as MCP wants it: `{content, _meta, isError}`, with a
// failure's own message. The client gets no progress and no chat artifacts,
// which only Studio's apps show; `_meta` goes to its MCP App, not its model.
export async function runServedTool(
	host: StudioAgentHost,
	tool: AnyStudioAgentTool,
	args: Record< string, unknown >,
	resultNotes: ReturnType< typeof createResultNotes >
) {
	const run = await runStudioTool( tool, args, {
		completion: {
			notes: async ( text ) => {
				const site = await siteNamed( host, args );
				return site && ( await resultNotes( site.path, text ) );
			},
		},
	} );
	if ( run.status === 'completed' ) {
		return { content: run.result.content, _meta: run.result._meta, isError: false };
	}
	let text = `Not run: ${ tool.name }.`;
	if ( run.status === 'invalid-arguments' ) {
		text = `Invalid arguments for ${ tool.name }: ${ run.problems.join( '; ' ) }.`;
	} else if ( run.status === 'failed' ) {
		text = describeToolError( run.error );
	}
	return { content: [ { type: 'text' as const, text } ], isError: true };
}
