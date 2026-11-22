import {
	createBackendTurnRunner,
	type ClaudeCodeBackend,
	type RunBackendTurn,
} from './backends/dispatch';
import { runPiAgentTurn } from './backends/pi';
import {
	createStudioSession,
	listStudioSessionFiles,
	openStudioSession,
	type CreateStudioSessionOptions,
} from './sessions/pi-session';
import { resolveStudioTools, type StudioToolsOptions } from './tools';
import type { StudioAgentHost } from './host';
import type { StudioAgentTurnConfig, StudioAgentTurnHandle } from './runtime';
import type { AnyStudioAgentTool } from './tools/define-tool';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

export interface StudioAgent {
	// Runs one turn of a conversation: the prompt, the model's tool calls, its answer.
	runTurn( config: StudioAgentTurnConfig ): StudioAgentTurnHandle;
	runBackendTurn: RunBackendTurn;
	// The Studio tools, for hosts that run them themselves, such as an MCP server.
	tools( options?: StudioToolsOptions ): AnyStudioAgentTool[];
	// The conversation files turns are recorded in.
	sessions: {
		create( options?: CreateStudioSessionOptions ): Promise< SessionManager >;
		open( filePath: string ): Promise< SessionManager >;
		list( directory: string ): Promise< string[] >;
	};
}

export function createAgent( {
	host,
	claudeCode,
}: {
	host: StudioAgentHost;
	claudeCode?: ClaudeCodeBackend;
} ): StudioAgent {
	return {
		runTurn: ( config ) => runPiAgentTurn( host, config ),
		runBackendTurn: createBackendTurnRunner( host, claudeCode ),
		tools: ( options ) => resolveStudioTools( host, options ),
		sessions: {
			create: ( options ) => createStudioSession( host.sitesRoot, options ),
			open: ( filePath ) => openStudioSession( host.sitesRoot, filePath ),
			list: listStudioSessionFiles,
		},
	};
}
