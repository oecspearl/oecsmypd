'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

export interface ImageHotspot {
  id: string;
  x: number;
  y: number;
  title: string;
  description: string;
}

export interface ImageHotspotData {
  imageUrl: string;
  hotspots: ImageHotspot[];
}

/**
 * Native MyPD player for image-hotspot interactive content. Re-dressed from the
 * OECS Content Creator player: MyPD styling, no external progress/UI deps.
 */
export default function ImageHotspotPlayer({ data }: { data: ImageHotspotData }) {
  const [selected, setSelected] = useState<number | null>(null);

  return (
    <div className="space-y-6">
      {/* Image with hotspot pins */}
      <div className="relative bg-gray-100 rounded-xl overflow-hidden" style={{ aspectRatio: '16/9' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={data.imageUrl} alt="Interactive image" className="w-full h-full object-contain" />

        {data.hotspots.map((hotspot, index) => (
          <button
            key={hotspot.id}
            type="button"
            className="absolute z-10"
            style={{ left: `${hotspot.x}%`, top: `${hotspot.y}%` }}
            onClick={() => setSelected(selected === index ? null : index)}
            aria-label={hotspot.title}
          >
            <div className="flex flex-col items-center cursor-pointer" style={{ transform: 'translate(-50%, -100%)' }}>
              <div
                className={`flex items-center justify-center w-8 h-8 rounded-full border-2 text-sm font-bold shadow-lg transition-all ${
                  selected === index
                    ? 'bg-amber-400 border-amber-600 text-amber-900'
                    : 'bg-blue-600 border-white text-white'
                }`}
              >
                {index + 1}
              </div>
              <div className={`w-0.5 h-3 ${selected === index ? 'bg-amber-600' : 'bg-blue-600'}`} />
              <div className={`w-2 h-2 rounded-full ${selected === index ? 'bg-amber-600' : 'bg-blue-600'}`} />
            </div>
          </button>
        ))}

        {selected !== null && (
          <div
            className="absolute bg-white border border-gray-200 rounded-lg shadow-xl p-4 max-w-xs z-20"
            style={{
              left: `${data.hotspots[selected].x}%`,
              top: `${data.hotspots[selected].y}%`,
              transform: 'translate(20px, -50%)',
            }}
          >
            <button
              type="button"
              className="absolute top-2 right-2 p-1 rounded hover:bg-gray-100"
              onClick={() => setSelected(null)}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <h4 className="font-semibold mb-2 pr-6">{data.hotspots[selected].title}</h4>
            <div
              className="text-sm text-gray-600 prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: data.hotspots[selected].description }}
            />
          </div>
        )}
      </div>

      {/* Hotspot list */}
      <div>
        <h3 className="font-semibold mb-4 text-gray-800">Hotspots ({data.hotspots.length})</h3>
        <div className="space-y-3">
          {data.hotspots.map((hotspot, index) => (
            <button
              key={hotspot.id}
              type="button"
              className={`w-full text-left p-4 rounded-lg border transition-all hover:shadow-sm ${
                selected === index ? 'border-blue-600 bg-blue-50' : 'border-gray-200'
              }`}
              onClick={() => setSelected(selected === index ? null : index)}
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                  {index + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-medium mb-1 text-gray-800">{hotspot.title}</h4>
                  <div
                    className="text-sm text-gray-600 prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: hotspot.description }}
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
