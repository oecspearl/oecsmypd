import { describe, test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ImageHotspotPlayer from "./ImageHotspotPlayer";
import { convertImageHotspots } from "../../../lib/moodle-import/h5p-converters";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../lib/moodle-import/__fixtures__/h5p-imagehotspots-ssezl.json",
      import.meta.url
    ),
    "utf8"
  )
);

describe("ImageHotspotPlayer", () => {
  test("renders the converted SSEZL interactive with all 8 hotspots", () => {
    // Full chain: real H5P json_content → converter → native MyPD player.
    const interactive = convertImageHotspots(fixture.content, {
      resolveFileUrl: (p) => `https://cdn.test/${p}`,
      title: fixture.name,
    });

    const html = renderToStaticMarkup(<ImageHotspotPlayer data={interactive.data} />);

    // Background image URL is wired in.
    expect(html).toContain("https://cdn.test/images/image-677171b78b8a3.png");
    // The list header reflects all eight hotspots.
    expect(html).toContain("Hotspots (8)");
    // A real derived hotspot title renders.
    expect(html).toContain("Module Outcomes");
    // Each of the eight pins is numbered.
    for (let i = 1; i <= 8; i++) {
      expect(html).toContain(`>${i}</div>`);
    }
    // HTML bodies render (not escaped).
    expect(html).toContain("evidence-based practices");
  });
});
