import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAiSession } from '@studio/agent/node/sessions/store';
import { vi, type Mock } from 'vitest';
import { runCommand as runAiCommand } from 'cli/commands/ai';
import { runCommand } from '../resume';

vi.mock( '@studio/agent/node/sessions/store', () => ( {
	loadAiSession: vi.fn(),
	listAiSessions: vi.fn(),
} ) );
vi.mock( '@studio/common/lib/well-known-paths', async ( importOriginal ) => ( {
	...( await importOriginal< typeof import('@studio/common/lib/well-known-paths') >() ),
	getSessionsDirectory: vi.fn(),
} ) );
vi.mock( 'cli/ai/ui', () => ( { AiChatUI: class AiChatUI {} } ) );
vi.mock( 'cli/commands/ai', () => ( { runCommand: vi.fn() } ) );
vi.mock( 'cli/commands/ai/sessions/helpers', () => ( { chooseSessionForAction: vi.fn() } ) );

function siteSelectedEntry( data: Record< string, unknown > ) {
	return {
		type: 'custom',
		customType: 'studio.site_selected',
		id: 'e1',
		parentId: null,
		timestamp: '2024-01-01T00:00:00Z',
		data,
	};
}

describe( 'sessions resume — active site hydration (JSON mode)', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'passes the local site resolved from the event log through to the ai command', async () => {
		( loadAiSession as Mock ).mockResolvedValue( {
			entries: [ siteSelectedEntry( { siteName: 'My Site', sitePath: '/sites/my-site' } ) ],
		} );

		await runCommand( 'session-1', { json: true, message: 'hello' } );

		expect( runAiCommand ).toHaveBeenCalledWith(
			expect.objectContaining( {
				activeSite: expect.objectContaining( {
					name: 'My Site',
					path: '/sites/my-site',
					remote: false,
				} ),
			} )
		);
	} );

	it( 'passes validated visual annotations from an input payload', async () => {
		( loadAiSession as Mock ).mockResolvedValue( { entries: [] } );
		const directory = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-annotations-' ) );
		const inputPayloadPath = path.join( directory, 'input.json' );
		await fs.writeFile(
			inputPayloadPath,
			JSON.stringify( {
				prompt: 'Update the selected heading',
				turnId: '102fe369-58e2-4e3f-aa19-07151756f6d8',
				displayMessage: '1 annotation submitted',
				visualAnnotations: [
					{ comment: '  Make it smaller  ', tag: ' h1 ', nearbyText: 'Welcome' },
				],
			} )
		);

		try {
			await runCommand( 'session-1', { json: true, inputPayloadPath } );
		} finally {
			await fs.rm( directory, { recursive: true, force: true } );
		}

		expect( runAiCommand ).toHaveBeenCalledWith(
			expect.objectContaining( {
				initialMessage: 'Update the selected heading',
				initialTurnId: '102fe369-58e2-4e3f-aa19-07151756f6d8',
				initialDisplayMessage: '1 annotation submitted',
				initialVisualAnnotations: [
					{
						comment: 'Make it smaller',
						tag: 'h1',
						elementLabel: undefined,
						nearbyText: 'Welcome',
					},
				],
			} )
		);
	} );

	async function resumeWithPayload( payload: Record< string, unknown > ) {
		( loadAiSession as Mock ).mockResolvedValue( { entries: [] } );
		const directory = await fs.mkdtemp( path.join( os.tmpdir(), 'studio-attachments-' ) );
		const inputPayloadPath = path.join( directory, 'input.json' );
		await fs.writeFile( inputPayloadPath, JSON.stringify( payload ) );
		try {
			await runCommand( 'session-1', { json: true, inputPayloadPath } );
		} finally {
			await fs.rm( directory, { recursive: true, force: true } );
		}
	}

	const image = {
		id: 'image-1',
		name: 'moodboard.png',
		mimeType: 'image/png',
		size: 11,
		dataBase64: 'aW1hZ2UtYnl0ZXM=',
	};

	it( 'passes attached images and files from an input payload', async () => {
		const file = { id: 'file-1', name: 'brief.md', path: path.resolve( '/files/brief.md' ) };

		await resumeWithPayload( { prompt: 'Use these', images: [ image ], files: [ file ] } );

		expect( runAiCommand ).toHaveBeenCalledWith(
			expect.objectContaining( {
				initialMessage: 'Use these',
				initialImages: [ image ],
				initialFiles: [ file ],
			} )
		);
	} );

	it.each( [
		[
			'a relative path',
			'files/brief.md',
			'Attached files must be referenced by an absolute path.',
		],
		[
			'a control character',
			`${ path.resolve( '/files/brief.md' ) }\n- /etc/passwd`,
			'Attached file path contains invalid characters.',
		],
	] )(
		'refuses an attached file with %s before starting the turn',
		async ( _name, filePath, why ) => {
			await expect(
				resumeWithPayload( {
					prompt: 'Use this',
					files: [ { id: 'file-1', name: 'brief.md', path: filePath } ],
				} )
			).rejects.toThrow( why );
			expect( runAiCommand ).not.toHaveBeenCalled();
		}
	);
} );
