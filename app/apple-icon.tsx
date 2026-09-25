// Never use @iconify/react inside this file.
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Image metadata
export const size = {
  width: 180,
  height: 180
};
export const contentType = 'image/png';

// Image generation: serve the locally bundled apple-touch-icon so the icon
// never depends on a third-party host.
export default async function Icon() {
  const iconBuffer = await readFile(join(process.cwd(), 'public', 'apple-touch-icon.png'));
  const iconSrc = `data:image/png;base64,${iconBuffer.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex'
        }}
      >
        <img
          src={iconSrc}
          alt="OECS MyPD"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }}
        />
      </div>
    ),
    {
      ...size
    }
  );
}
