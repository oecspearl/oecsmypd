import { describe, test, expect } from "vitest";
import { convertImageHotspots, convertInteractiveVideo } from "./h5p-converters";
import imageHotspotsFixture from "./__fixtures__/h5p-imagehotspots-ssezl.json";
import interactiveVideoFixture from "./__fixtures__/h5p-interactivevideo-pd002.json";

describe("convertImageHotspots", () => {
  const resolveFileUrl = (path: string) => `https://cdn.test/${path}`;

  test("converts real H5P.ImageHotspots content into MyPD image-hotspot data", () => {
    const result = convertImageHotspots(imageHotspotsFixture.content, {
      resolveFileUrl,
      title: imageHotspotsFixture.name,
    });

    // It is a native MyPD interactive content block, not an H5P package.
    expect(result.type).toBe("image-hotspot");
    expect(result.title).toBe("Module 13 Overview");

    // The background image path is resolved to a real URL (upload happens upstream).
    expect(result.data.imageUrl).toBe(
      "https://cdn.test/images/image-677171b78b8a3.png"
    );

    // All eight hotspots carry over, in order.
    expect(result.data.hotspots).toHaveLength(8);

    const first = result.data.hotspots[0];
    // Stable id taken from the H5P subContentId so re-imports don't duplicate.
    expect(first.id).toBe("4b7fe9a6-c8ad-46f7-a2a9-3cdf7fae8917");
    // Coordinates map straight from H5P position.
    expect(first.x).toBe(38);
    expect(first.y).toBeCloseTo(28.849, 2);
    // Title is derived from the first emphasised line of the hotspot body.
    expect(first.title).toBe(
      "Welcome to Module 13: Supporting Social and Emotional Well-being in Young Children."
    );
    // Description preserves the hotspot's HTML body.
    expect(first.description).toContain("evidence-based practices");
    expect(first.description).toContain("<p>");

    // Second hotspot proves title derivation is per-hotspot, not hardcoded.
    expect(result.data.hotspots[1].title).toBe("Module Outcomes");
  });
});

describe("convertInteractiveVideo", () => {
  const resolveFileUrl = (path: string) => `https://cdn.test/${path}`;

  test("converts real H5P.InteractiveVideo content into MyPD interactive-video data", () => {
    const result = convertInteractiveVideo(interactiveVideoFixture.content, {
      resolveFileUrl,
      title: interactiveVideoFixture.name,
    });

    expect(result.type).toBe("interactive-video");
    expect(result.title).toBe("Exploring a MyPD Course Page");

    // The backing video file path is resolved to a real URL.
    expect(result.data.videoUrl).toBe("https://cdn.test/videos/video-sA8lodCV.mp4");

    // The single in-video interaction carries over as a timed hotspot.
    expect(result.data.hotspots).toHaveLength(1);
    const hotspot = result.data.hotspots[0];
    // Timestamp comes from the interaction's start time (seconds).
    expect(hotspot.timestamp).toBe(77);
    // A SingleChoiceSet question maps to a "quiz" hotspot.
    expect(hotspot.type).toBe("quiz");
    expect(hotspot.title).toBe("Untitled Single Choice Set");
    expect(typeof hotspot.id).toBe("string");
    expect(hotspot.id.length).toBeGreaterThan(0);
  });
});
