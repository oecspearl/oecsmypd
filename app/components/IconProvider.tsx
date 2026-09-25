'use client';

import { addCollection } from '@iconify/react';
import subset from '@/app/components/icons/subset.generated.json';

/**
 * Registers a pruned, bundled subset of the Iconify icon sets used by the app
 * (material-symbols, mdi, svg-spinners) so icons render offline and without a
 * round-trip to api.iconify.design. Icons missing from the subset (for example
 * names stored in database settings) still fall back to the API when online.
 *
 * Regenerate the subset after adding new icons:
 *   node app/components/icons/build-icon-subset.mjs
 */
let registered = false;

function registerCollections() {
  if (registered) return;
  registered = true;
  for (const collection of Object.values(subset as Record<string, any>)) {
    try {
      addCollection(collection);
    } catch (error) {
      console.warn('[IconProvider] Failed to register icon collection', collection?.prefix, error);
    }
  }
}

// Register at module evaluation so icons are available on the very first render.
registerCollections();

export default function IconProvider() {
  return null;
}
