import type { AiProviderId } from './providers';

/** A model as named by the provider that serves it. */
export interface ProviderModelRef<
	ProviderId extends AiProviderId | 'claude-code' = AiProviderId,
> {
	providerId: ProviderId;
	modelId: string;
}

/** The connection, provider-qualified model and configuration revision a conversation ran under. */
export interface ConnectionSelection<
	ProviderId extends AiProviderId | 'claude-code' = AiProviderId,
> {
	connectionId: string;
	model: ProviderModelRef< ProviderId >;
	revision: number;
}

/** The agent runtime a connection's turns run in. */
export type ConnectionBackend = 'pi' | 'claude-code';
