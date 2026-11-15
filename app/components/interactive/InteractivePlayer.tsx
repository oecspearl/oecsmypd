'use client';

import ImageHotspotPlayer, { type ImageHotspotData } from './ImageHotspotPlayer';

/**
 * A native MyPD interactive content block. `type` selects the player; `data`
 * is the player-specific payload. Produced by the Moodle importer (converted
 * H5P) and, later, by MyPD's own interactive authoring.
 */
export interface InteractiveContent {
  type: string;
  title?: string;
  data: unknown;
}

export default function InteractivePlayer({ content }: { content: InteractiveContent }) {
  switch (content.type) {
    case 'image-hotspot':
      return <ImageHotspotPlayer data={content.data as ImageHotspotData} />;
    default:
      return (
        <div className="text-sm text-gray-500 italic">
          Interactive content ({content.type}) is not yet supported in this view.
        </div>
      );
  }
}
