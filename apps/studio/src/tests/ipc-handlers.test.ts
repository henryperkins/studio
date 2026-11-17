/**
 * @vitest-environment node
 */
import { IpcMainInvokeEvent, dialog, shell } from 'electron';
import { existsSync } from 'fs';
import { normalize } from 'path';
import { createAiSession } from '@studio/agent/node/sessions/store';
import { fetchSyncableSites } from '@studio/common/lib/sync/sync-api';
import { getSessionsDirectory } from '@studio/common/lib/well-known-paths';
import { readSitePath } from '@studio/common/sites/site-path';
import { vol } from 'memfs';
import { vi } from 'vitest';
import {
	fetchSyncableWpcomSites,
	getFileSize,
	openURL,
	readBlueprintFile,
	setAiSessionModel,
	setAiSessionProvider,
	showOpenFolderDialog,
} from 'src/ipc-handlers';
import { getAuthenticationToken } from 'src/lib/oauth';

vi.mock( 'fs' );
vi.mock( 'fs/promises', async () => {
	const { fs } = await import( 'memfs' );
	return { default: fs.promises };
} );
vi.mock( '@studio/common/sites/site-path' );
vi.mock( '@studio/common/lib/sync/sync-api' );
vi.mock( 'src/lib/oauth' );
// As the lockfile package gives up once another process has held a chat's selection lock past the wait.
const { selectionLock } = vi.hoisted( () => ( { selectionLock: { held: false, refused: 0 } } ) );
vi.mock( '@studio/common/lib/lockfile', async ( original ) => {
	const actual = await original< typeof import('@studio/common/lib/lockfile') >();
	return {
		...actual,
		lockFileAsync: async ( ...args: Parameters< typeof actual.lockFileAsync > ) => {
			if ( selectionLock.held && args[ 0 ].endsWith( '.settings.lock' ) ) {
				selectionLock.refused++;
				throw Object.assign( new Error( `EEXIST: file already exists, open '${ args[ 0 ] }'` ), {
					code: 'EEXIST',
				} );
			}
			return actual.lockFileAsync( ...args );
		},
	};
} );

beforeEach( () => {
	vol.reset();
} );

const mockIpcMainInvokeEvent = {
	sender: { isDestroyed: vi.fn().mockReturnValue( false ) },
	// Double assert the type with `unknown` to simplify mocking this value
} as unknown as IpcMainInvokeEvent;

describe( 'fetchSyncableWpcomSites', () => {
	afterEach( () => vi.unstubAllEnvs() );

	it.each( [
		{ flag: undefined, planRequired: true },
		{ flag: '1', planRequired: false },
	] )(
		'requires a plan: $planRequired with Reprint flag $flag',
		async ( { flag, planRequired } ) => {
			vi.stubEnv( 'STUDIO_ENABLE_PULL_REPRINT', flag );
			vi.mocked( getAuthenticationToken ).mockResolvedValue( {
				accessToken: 'test-token',
			} as Awaited< ReturnType< typeof getAuthenticationToken > > );
			vi.mocked( fetchSyncableSites ).mockResolvedValue( [] );

			await fetchSyncableWpcomSites( mockIpcMainInvokeEvent );

			expect( fetchSyncableSites ).toHaveBeenCalledWith( 'test-token', { planRequired } );
		}
	);
} );

describe( 'readBlueprintFile', () => {
	it( 'deletes the temporary deep-link file after reading it', async () => {
		const filePath = normalize( '/mock/path/wp-studio-blueprints/blueprint.json' );
		vol.fromJSON( { [ filePath ]: JSON.stringify( { meta: { title: 'Deep link' } } ) } );

		await expect( readBlueprintFile( mockIpcMainInvokeEvent, filePath ) ).resolves.toEqual( {
			meta: { title: 'Deep link' },
		} );
		expect( existsSync( filePath ) ).toBe( false );
	} );

	it( 'deletes invalid temporary deep-link JSON', async () => {
		const filePath = normalize( '/mock/path/wp-studio-blueprints/invalid.json' );
		vol.fromJSON( { [ filePath ]: '{invalid' } );

		await expect( readBlueprintFile( mockIpcMainInvokeEvent, filePath ) ).rejects.toThrow();
		expect( existsSync( filePath ) ).toBe( false );
	} );
} );

describe( 'getFileSize', () => {
	beforeEach( () => {
		vi.mocked( readSitePath ).mockResolvedValue( '/test' );
	} );

	it( 'returns the file size', async () => {
		vol.fromJSON( { '/test/wp-content/index.php': '<?php' } );

		await expect(
			getFileSize( mockIpcMainInvokeEvent, 'test-site-id', [ 'wp-content', 'index.php' ] )
		).resolves.toBe( 5 );
	} );

	it( 'returns 0 for a dangling symlink instead of throwing', async () => {
		// A broken symlink whose target was never created — mirrors the WP Cloud
		// `advanced-cache.php` drop-in that a reprint pull leaves dangling.
		vol.mkdirSync( '/test/wp-content', { recursive: true } );
		vol.symlinkSync(
			'/test/wordpress/drop-ins/advanced-cache.php',
			'/test/wp-content/advanced-cache.php'
		);
		const warnSpy = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		await expect(
			getFileSize( mockIpcMainInvokeEvent, 'test-site-id', [ 'wp-content', 'advanced-cache.php' ] )
		).resolves.toBe( 0 );
		expect( warnSpy ).toHaveBeenCalledWith( expect.stringContaining( 'advanced-cache.php' ) );

		warnSpy.mockRestore();
	} );
} );

describe( 'a chat’s model or provider', () => {
	// Electron sends the error's name with its message, which the renderer takes off.
	const known = ( message: string ) => ( { name: 'ChatGptSettingsError', message } );
	const notSaved = known( 'Studio couldn’t save the model for this chat. Try again.' );

	afterEach( () => {
		selectionLock.held = false;
		selectionLock.refused = 0;
	} );

	it( 'says only that the choice wasn’t saved while the chat’s lock stays held, naming no path', async () => {
		const { id } = await createAiSession( getSessionsDirectory() );
		selectionLock.held = true;

		await expect(
			setAiSessionProvider( mockIpcMainInvokeEvent, id, 'wpcom', 'balanced' )
		).rejects.toMatchObject( notSaved );
		await expect( setAiSessionModel( mockIpcMainInvokeEvent, id, 'fast' ) ).rejects.toMatchObject(
			notSaved
		);
		expect( selectionLock.refused ).toBe( 2 );
	} );

	it( 'says only that the choice wasn’t saved for a chat it can’t read', async () => {
		await expect(
			setAiSessionProvider( mockIpcMainInvokeEvent, 'missing-chat', 'wpcom', 'balanced' )
		).rejects.toMatchObject( notSaved );
	} );

	it( 'refuses a provider or model Studio doesn’t know with a known message', async () => {
		await expect(
			setAiSessionProvider( mockIpcMainInvokeEvent, 'any', 'unknown-provider', 'balanced' )
		).rejects.toMatchObject( known( 'Choose a model this provider supports.' ) );
		await expect(
			setAiSessionModel( mockIpcMainInvokeEvent, 'any', 'unknown-model' )
		).rejects.toMatchObject( known( 'Choose a supported model.' ) );
	} );
} );

describe( 'openURL', () => {
	it( 'only hands web URLs to the OS', () => {
		const openExternal = vi.fn().mockResolvedValue( undefined );
		( shell as unknown as { openExternal: typeof openExternal } ).openExternal = openExternal;

		for ( const url of [
			'https://wordpress.com/',
			'http://localhost:8881/',
			'file:///etc/passwd',
			'vscode://file/tmp',
			'smb://host/share',
			'relative/path',
		] ) {
			openURL( mockIpcMainInvokeEvent, url );
		}

		expect( openExternal.mock.calls ).toEqual( [
			[ 'https://wordpress.com/' ],
			[ 'http://localhost:8881/' ],
		] );
	} );
} );

describe( 'site source picker', () => {
	const originalPlatform = process.platform;
	beforeEach( () => {
		Object.assign( dialog, {
			showOpenDialog: vi.fn().mockResolvedValue( { canceled: true, filePaths: [] } ),
		} );
	} );
	afterEach( () => Object.defineProperty( process, 'platform', { value: originalPlatform } ) );

	it.each( [ 'win32', 'linux' ] )(
		'offers separate native folder and Blueprint pickers on %s',
		async ( platform ) => {
			Object.defineProperty( process, 'platform', { value: platform } );
			for ( const [ response, properties ] of [
				[ 0, [ 'openDirectory' ] ],
				[ 1, [ 'openFile' ] ],
			] as const ) {
				vi.mocked( dialog.showMessageBox ).mockResolvedValueOnce( {
					response,
					checkboxChecked: false,
				} );
				await expect(
					showOpenFolderDialog( mockIpcMainInvokeEvent, 'Open', '/sites', {
						allowBlueprints: true,
					} )
				).resolves.toBeNull();
				expect( dialog.showOpenDialog ).toHaveBeenLastCalledWith(
					expect.anything(),
					expect.objectContaining( {
						properties: [ ...properties ],
						filters: [ { name: 'Blueprints', extensions: [ 'json', 'zip' ] } ],
					} )
				);
			}
			vi.mocked( dialog.showMessageBox ).mockResolvedValueOnce( {
				response: 2,
				checkboxChecked: false,
			} );
			await expect(
				showOpenFolderDialog( mockIpcMainInvokeEvent, 'Open', '/sites', { allowBlueprints: true } )
			).resolves.toBeNull();
			expect( dialog.showOpenDialog ).toHaveBeenCalledTimes( 2 );
		}
	);

	it( 'accepts a destination that does not exist yet without presenting a picker', async () => {
		await expect(
			showOpenFolderDialog( mockIpcMainInvokeEvent, 'Choose folder', '/sites/new-destination', {
				usePath: true,
			} )
		).resolves.toEqual( {
			path: '/sites/new-destination',
			name: 'new-destination',
			isEmpty: true,
			isWordPress: false,
		} );
		expect( dialog.showOpenDialog ).not.toHaveBeenCalled();
	} );

	it( 'reads a dropped Blueprint folder without presenting a picker', async () => {
		vol.fromJSON( { '/sites/starter/blueprint.json': JSON.stringify( { steps: [] } ) } );
		const result = await showOpenFolderDialog( mockIpcMainInvokeEvent, 'Open', '/sites/starter', {
			allowBlueprints: true,
			usePath: true,
		} );
		expect( result?.blueprint?.blueprintJson ).toEqual( { steps: [] } );
		expect( result?.path ).toBe( '/sites/starter' );
		expect( dialog.showOpenDialog ).not.toHaveBeenCalled();
	} );

	it.each( [ 'backup.wpress', 'export.xml', 'blueprint.json' ] )(
		'opens the combined source picker for %s',
		async ( name ) => {
			Object.defineProperty( process, 'platform', { value: 'darwin' } );
			vol.fromJSON( { [ '/sites/' + name ]: name.endsWith( '.json' ) ? '{}' : 'file' } );
			vi.mocked( dialog.showOpenDialog ).mockResolvedValueOnce( {
				canceled: false,
				filePaths: [ '/sites/' + name ],
			} );
			const result = await showOpenFolderDialog( mockIpcMainInvokeEvent, 'Choose', '/sites', {
				allowSiteFiles: true,
			} );
			expect( result?.path ).toBe( '/sites/' + name );
			if ( name.endsWith( '.json' ) ) expect( result?.blueprint?.blueprintJson ).toEqual( {} );
			else expect( result?.file ).toEqual( { path: '/sites/' + name, name } );
			expect( dialog.showOpenDialog ).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining( {
					properties: [ 'openDirectory', 'createDirectory', 'openFile' ],
					filters: [
						{
							name: 'Site sources',
							extensions: expect.arrayContaining( [ 'json', 'zip', 'xml', 'wpress' ] ),
						},
					],
				} )
			);
		}
	);

	it( 'keeps the combined native picker on macOS', async () => {
		Object.defineProperty( process, 'platform', { value: 'darwin' } );
		await showOpenFolderDialog( mockIpcMainInvokeEvent, 'Open', '/sites', {
			allowBlueprints: true,
		} );
		expect( dialog.showMessageBox ).not.toHaveBeenCalled();
		expect( dialog.showOpenDialog ).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining( {
				properties: [ 'openDirectory', 'createDirectory', 'openFile' ],
			} )
		);
	} );
} );
