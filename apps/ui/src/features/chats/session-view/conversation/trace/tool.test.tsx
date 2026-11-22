import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolUseRow } from './index';
import type { NormalizedToolResult } from '@studio/agent/protocol/tools';

function ToolRow( { result }: { result?: NormalizedToolResult } ) {
	return (
		<ToolUseRow
			name="Read"
			input={ { file_path: 'style.css' } }
			result={ result }
			isRunning={ ! result }
		/>
	);
}

describe( 'tool trace', () => {
	it( 'preserves keyboard disclosure while a running tool completes', async () => {
		const user = userEvent.setup();
		const { rerender } = render( <ToolRow /> );
		const trigger = screen.getByRole( 'button', { name: /style\.css/ } );
		expect( trigger ).toHaveAttribute( 'aria-expanded', 'false' );
		await user.tab();
		expect( trigger ).toHaveFocus();
		await user.keyboard( '{Enter}' );
		expect( trigger ).toHaveAttribute( 'aria-expanded', 'true' );
		rerender( <ToolRow result={ { text: 'File contents', isError: false } } /> );
		expect( screen.getByRole( 'button', { name: /style\.css/ } ) ).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		expect( screen.getByText( 'File contents' ) ).toBeVisible();
		await user.keyboard( ' ' );
		expect( trigger ).toHaveAttribute( 'aria-expanded', 'false' );
	} );

	it.each( [ 'wordpress-com-login', 'environment-token' ] as const )(
		'names only the image service that made generated images, signed in with %s',
		async ( credential ) => {
			const user = userEvent.setup();
			render(
				<ToolUseRow
					name="generate_images"
					input={ { images: [ { path: '/sites/a/hero.png', subject: 'A loaf' } ] } }
					result={ {
						text: 'Generating 1 image in the background.',
						isError: false,
						imageService: { service: 'wordpress-com', credential },
					} }
					isRunning={ false }
				/>
			);

			await user.click( screen.getByRole( 'button', { name: /1 image/ } ) );

			expect( screen.getByText( 'Made with Studio’s WordPress.com image service.' ) ).toBeVisible();
			expect( screen.queryByText( /someone|token/i ) ).not.toBeInTheDocument();
		}
	);

	it( 'shows no image service line for a generate_images row without one', async () => {
		const user = userEvent.setup();
		render(
			<ToolUseRow
				name="generate_images"
				input={ { images: [ { path: '/sites/a/hero.png', subject: 'A loaf' } ] } }
				result={ { text: 'Generating 1 image in the background.', isError: false } }
				isRunning={ false }
			/>
		);

		await user.click( screen.getByRole( 'button', { name: /1 image/ } ) );

		expect( screen.getByText( 'Generating 1 image in the background.' ) ).toBeVisible();
		expect( screen.queryByText( /image service/ ) ).not.toBeInTheDocument();
	} );
} );
