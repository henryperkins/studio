import {
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createBrowserFile,
	readBrowserToolFile,
	writeBrowserToolFile,
} from '../browser-tool-files';

describe( 'files used by guarded Chromium tools', () => {
	let root: string;
	let site: string;
	beforeEach( async () => {
		root = await realpath( await mkdtemp( path.join( os.tmpdir(), 'studio-browser-files-' ) ) );
		site = path.join( root, 'site' );
		await mkdir( site );
	} );
	afterEach( () => rm( root, { recursive: true, force: true } ) );

	it( 'applies a fix only to the ordinary, unchanged file read for validation', async () => {
		const file = path.join( site, 'page.html' );
		await writeFile( file, 'original' );
		const first = await readBrowserToolFile( site, file );
		await writeBrowserToolFile( site, file, 'fixed', () => {}, first );
		const second = await readBrowserToolFile( site, file );
		await writeFile( file, 'user edit' );
		await expect( writeBrowserToolFile( site, file, 'stale', () => {}, second ) ).rejects.toThrow();
		expect( await readFile( file, 'utf8' ) ).toBe( 'user edit' );
	} );

	it( 'discards only the capture created by the current call after a later failure', async () => {
		const file = path.join( site, 'capture.jpg' );
		const discard = await createBrowserFile( site, file, 'partial', () => {} );
		await discard();
		await expect( readFile( file ) ).rejects.toMatchObject( { code: 'ENOENT' } );
		const discardReplaced = await createBrowserFile( site, file, 'old capture', () => {} );
		await rename( file, path.join( site, 'old.jpg' ) );
		await writeFile( file, 'replacement' );
		await discardReplaced();
		expect( await readFile( file, 'utf8' ) ).toBe( 'replacement' );
	} );

	it( 'refuses a thumbnail hard link and a screenshot directory redirected by a junction', async () => {
		const target = path.join( root, 'private.jpg' );
		const thumbnail = path.join( site, 'screenshot.jpg' );
		await writeFile( target, 'preserved' );
		await link( target, thumbnail );
		await expect( writeBrowserToolFile( site, thumbnail, 'new', () => {} ) ).rejects.toThrow();
		expect( await readFile( target, 'utf8' ) ).toBe( 'preserved' );
		const alias = path.join( site, 'session.screenshots' );
		await symlink( root, alias, process.platform === 'win32' ? 'junction' : 'dir' );
		await expect(
			createBrowserFile( alias, path.join( alias, 'capture.jpg' ), 'new', () => {} )
		).rejects.toThrow();
		await expect( readFile( path.join( root, 'capture.jpg' ) ) ).rejects.toMatchObject( {
			code: 'ENOENT',
		} );
	} );
} );
