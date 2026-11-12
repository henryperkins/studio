/**
 * @vitest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MakerDeb } from '@electron-forge/maker-deb';
import forgeConfig from '../../forge.config';
import packageJson from '../../package.json';

describe( 'forge config', () => {
	// Release lanes glob `Studio.app` and `Studio-*.dmg`, and logs and app data
	// live in folders named after the product.
	it( 'keeps the Studio product name for files and paths', () => {
		expect( packageJson.productName ).toBe( 'Studio' );
		expect( forgeConfig.packagerConfig?.name ).toBeUndefined();
	} );

	it( 'names the macOS app WordPress Studio in every localization', async () => {
		const buildPath = fs.mkdtempSync( path.join( os.tmpdir(), 'forge-config-' ) );
		const resources = path.join( buildPath, 'Studio.app', 'Contents', 'Resources' );
		for ( const localization of [ 'en.lproj', 'fr.lproj' ] ) {
			fs.mkdirSync( path.join( resources, localization ), { recursive: true } );
		}

		const hooks = forgeConfig.packagerConfig?.afterCopyExtraResources ?? [];
		await Promise.all(
			hooks.map( ( hook ) =>
				hook( { buildPath, electronVersion: '', platform: 'darwin', arch: 'arm64' } )
			)
		);

		for ( const localization of [ 'en.lproj', 'fr.lproj' ] ) {
			expect(
				fs.readFileSync( path.join( resources, localization, 'InfoPlist.strings' ), 'utf8' )
			).toBe( 'CFBundleDisplayName = "WordPress Studio";\nCFBundleName = "WordPress Studio";\n' );
		}
		fs.rmSync( buildPath, { recursive: true, force: true } );
	} );

	// Without it Studio says persistent sign-in storage is unavailable and offers
	// session-only storage, so a minimal or headless install may leave it out.
	it( 'recommends the Secret Service tool for the Linux package, without requiring it', async () => {
		const deb = forgeConfig.makers?.find( ( maker ) => maker instanceof MakerDeb );
		expect( deb ).toBeInstanceOf( MakerDeb );
		await ( deb as MakerDeb ).prepareConfig( 'x64' );
		const options = ( deb as MakerDeb ).config.options;

		expect( options?.recommends ).toContain( 'libsecret-tools' );
		expect( options?.depends ).not.toContain( 'libsecret-tools' );
	} );
} );
