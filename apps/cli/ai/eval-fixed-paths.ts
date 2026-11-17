/**
 * Paths application modules fix when they first load, read back so the eval
 * runner can tell whether they loaded after the entry pointed the process at
 * the case's own profile and process manager. Development only, for the eval
 * runner.
 */
// eslint-disable-next-line no-restricted-imports -- development only: the path this tool names is fixed when it loads.
import { wpcomRequestTool } from '@studio/agent/node/tools/wpcom-request';
import { ROOT_CA_CERT_PATH } from '@studio/common/lib/root-ca-trust';
import { PROCESS_MANAGER_HOME } from 'cli/lib/paths';

export interface PathsFixedAtLoad {
	/** The descriptions of `wpcom_request`'s arguments, which name its payload folder. */
	payloadDescriptions: string[];
	/** The root certificate the certificate modules keep in the profile's certificates folder. */
	rootCaCertificate: string;
	/** The home of the process manager the CLI's daemon client talks to. */
	processManagerHome: string;
}

export function pathsFixedAtLoad(): PathsFixedAtLoad {
	return {
		payloadDescriptions: Object.values( wpcomRequestTool.parameters.properties ).map( ( schema ) =>
			String( ( schema as { description?: unknown } ).description ?? '' )
		),
		rootCaCertificate: ROOT_CA_CERT_PATH,
		processManagerHome: PROCESS_MANAGER_HOME,
	};
}
