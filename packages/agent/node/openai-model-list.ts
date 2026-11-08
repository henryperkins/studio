import {
	classifyOpenAiHttpError,
	summarizeOpenAiNetworkFailure,
	type OpenAiErrorSummary,
} from '@studio/agent/protocol/openai-errors';

// Fixed: Studio talks to OpenAI directly and never through a configurable host.
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const MODEL_LIST_TIMEOUT_MS = 15_000;

export type OpenAiModelListResult =
	| { ok: true; modelIds: string[] }
	| { ok: false; error: OpenAiErrorSummary };

/**
 * The ids `GET /v1/models` lists for the key's project. The list carries no
 * capabilities, and listing a model doesn't prove a request will succeed.
 * A redirect is refused rather than followed, so the key can't be forwarded.
 */
export async function fetchOpenAiModelList(
	key: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise< OpenAiModelListResult > {
	const timeout = AbortSignal.timeout( options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS );
	const signal = options.signal ? AbortSignal.any( [ options.signal, timeout ] ) : timeout;
	let response: Response;
	try {
		response = await fetch( `${ OPENAI_API_BASE_URL }/models`, {
			headers: { Authorization: `Bearer ${ key }` },
			redirect: 'error',
			signal,
		} );
	} catch ( error ) {
		if ( options.signal?.aborted ) {
			return { ok: false, error: { kind: 'cancelled' } };
		}
		return {
			ok: false,
			error: timeout.aborted
				? { kind: 'network', detail: 'The request timed out.' }
				: summarizeOpenAiNetworkFailure( error, [ key ] ),
		};
	}
	const body: unknown = await response.json().catch( () => undefined );
	if ( ! response.ok ) {
		return { ok: false, error: classifyOpenAiHttpError( response.status, body, [ key ] ) };
	}
	const data =
		body && typeof body === 'object' && 'data' in body ? ( body as { data: unknown } ).data : [];
	const modelIds = Array.isArray( data )
		? data
				.map( ( model: unknown ) =>
					model && typeof model === 'object' && 'id' in model
						? ( model as { id: unknown } ).id
						: null
				)
				.filter( ( id ): id is string => typeof id === 'string' )
		: [];
	return { ok: true, modelIds };
}
