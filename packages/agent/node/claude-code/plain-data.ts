import { types } from 'util';

export function hasOwn( value: object, key: string ): boolean {
	return Object.prototype.hasOwnProperty.call( value, key );
}

/**
 * A declaration read as plain data: the own properties of an ordinary object,
 * every one enumerable, named by a string and holding a value. An inherited
 * value, an accessor, a hidden or symbol-named property, a proxy or an
 * instance of a class is not what code that copies or serializes the object
 * receives, so an object with any of them is no declaration. The result has
 * no prototype, so reading it finds only what the object itself stated.
 * Never throws.
 */
export function plainData( value: unknown ): Record< string, unknown > | undefined {
	try {
		if ( typeof value !== 'object' || value === null || types.isProxy( value ) ) return;
		const prototype: unknown = Object.getPrototypeOf( value );
		if ( prototype !== Object.prototype && prototype !== null ) return;
		const data: Record< string, unknown > = Object.create( null );
		for ( const key of Reflect.ownKeys( value ) ) {
			const property = Object.getOwnPropertyDescriptor( value, key );
			if (
				typeof key !== 'string' ||
				! property ||
				! hasOwn( property, 'value' ) ||
				! property.enumerable
			)
				return;
			data[ key ] = property.value;
		}
		return data;
	} catch {
		return;
	}
}

/** A list read the same way: an ordinary array whose only properties are its items. */
export function plainList( value: unknown ): unknown[] | undefined {
	try {
		if (
			! Array.isArray( value ) ||
			types.isProxy( value ) ||
			Object.getPrototypeOf( value ) !== Array.prototype
		)
			return;
		const items: unknown[] = [];
		// Every own key but `length` must be the next index.
		const count = Reflect.ownKeys( value ).length - 1;
		for ( let index = 0; index < count; index++ ) {
			const property = Object.getOwnPropertyDescriptor( value, String( index ) );
			if ( ! property || ! hasOwn( property, 'value' ) || ! property.enumerable ) return;
			items.push( property.value );
		}
		return items.length === value.length ? items : undefined;
	} catch {
		return;
	}
}

export function plainStrings( value: unknown ): string[] | undefined {
	const items = plainList( value );
	return items?.every( ( item ) => typeof item === 'string' ) ? ( items as string[] ) : undefined;
}

export function hasOnlyKeys(
	data: Record< string, unknown >,
	keys: ReadonlySet< string >
): boolean {
	return Object.keys( data ).every( ( key ) => keys.has( key ) );
}
