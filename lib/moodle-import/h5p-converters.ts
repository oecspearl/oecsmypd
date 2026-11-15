/**
 * Converters that turn Moodle H5P interactives (recovered as inline
 * `json_content` from each backup's `hvp.xml`) into MyPD's own native
 * interactive content blocks. No official H5P runtime is involved: the output
 * is plain MyPD data that MyPD's own interactive players render.
 *
 * Only the two H5P types that actually appear in the OECS backups are handled
 * here: H5P.ImageHotspots and H5P.InteractiveVideo.
 */

export type MyPdInteractiveType = "image-hotspot" | "interactive-video";

export interface MyPdInteractiveContent<T = unknown> {
  type: MyPdInteractiveType;
  title: string;
  data: T;
}

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

export type VideoHotspotType = "question" | "quiz" | "info" | "navigation";

export interface VideoHotspot {
  id: string;
  timestamp: number;
  type: VideoHotspotType;
  title: string;
  content: string;
}

export interface InteractiveVideoData {
  videoUrl: string;
  hotspots: VideoHotspot[];
}

export interface ConvertOptions {
  /** Maps an H5P-internal file path (e.g. "images/x.png") to a stored URL. */
  resolveFileUrl: (h5pPath: string) => string;
  /** Display title for the interactive (usually the Moodle activity name). */
  title: string;
}

/** Strip HTML tags and collapse whitespace to plain text. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive a short hotspot title from its HTML body: the first emphasised or
 * heading line, else the first sentence, else a positional fallback.
 */
function deriveTitle(html: string, index: number): string {
  const emphasised = html.match(/<(strong|b|h[1-6])[^>]*>([\s\S]*?)<\/\1>/i);
  if (emphasised) {
    const text = toPlainText(emphasised[2]);
    if (text) return text;
  }
  const plain = toPlainText(html);
  if (plain) return plain.length > 80 ? plain.slice(0, 80).trim() + "…" : plain;
  return `Hotspot ${index + 1}`;
}

interface H5pImageHotspotsContent {
  image?: { path?: string };
  hotspots?: Array<{
    position?: { x?: number; y?: number };
    content?: Array<{ params?: { text?: string }; subContentId?: string }>;
  }>;
}

export function convertImageHotspots(
  content: H5pImageHotspotsContent,
  opts: ConvertOptions
): MyPdInteractiveContent<ImageHotspotData> {
  const imagePath = content.image?.path ?? "";

  const hotspots: ImageHotspot[] = (content.hotspots ?? []).map((h, i) => {
    const pieces = (h.content ?? [])
      .map((c) => c.params?.text ?? "")
      .filter(Boolean);
    const html = pieces.join("");
    const subId = h.content?.find((c) => c.subContentId)?.subContentId;
    return {
      id: subId ?? `hotspot-${i + 1}`,
      x: h.position?.x ?? 0,
      y: h.position?.y ?? 0,
      title: deriveTitle(html, i),
      description: html,
    };
  });

  return {
    type: "image-hotspot",
    title: opts.title,
    data: {
      imageUrl: opts.resolveFileUrl(imagePath),
      hotspots,
    },
  };
}

/** Map an H5P interaction library (e.g. "H5P.SingleChoiceSet 1.11") to a MyPD hotspot type. */
function libraryToHotspotType(library: string): VideoHotspotType {
  const name = library.split(/\s+/)[0]; // drop version
  const quiz = [
    "H5P.SingleChoiceSet",
    "H5P.MultiChoice",
    "H5P.QuestionSet",
    "H5P.TrueFalse",
    "H5P.Blanks",
    "H5P.DragQuestion",
    "H5P.MarkTheWords",
    "H5P.DragText",
  ];
  if (quiz.includes(name)) return "quiz";
  if (name === "H5P.GoToQuestion" || name === "H5P.Link") return "navigation";
  return "info"; // H5P.Text / H5P.AdvancedText / anything else
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

interface H5pInteractiveVideoContent {
  interactiveVideo?: {
    video?: { files?: Array<{ path?: string }> };
    assets?: {
      interactions?: Array<{
        duration?: { from?: number };
        action?: {
          library?: string;
          subContentId?: string;
          metadata?: { title?: string };
          params?: unknown;
        };
      }>;
    };
  };
}

export function convertInteractiveVideo(
  content: H5pInteractiveVideoContent,
  opts: ConvertOptions
): MyPdInteractiveContent<InteractiveVideoData> {
  const iv = content.interactiveVideo ?? {};
  const videoPath = iv.video?.files?.[0]?.path ?? "";
  const videoUrl = isHttpUrl(videoPath) ? videoPath : opts.resolveFileUrl(videoPath);

  const hotspots: VideoHotspot[] = (iv.assets?.interactions ?? []).map((it, i) => {
    const action = it.action ?? {};
    const library = action.library ?? "";
    return {
      id: action.subContentId ?? `interaction-${i + 1}`,
      timestamp: it.duration?.from ?? 0,
      type: libraryToHotspotType(library),
      title: action.metadata?.title ?? `Interaction ${i + 1}`,
      content: "",
    };
  });

  return {
    type: "interactive-video",
    title: opts.title,
    data: { videoUrl, hotspots },
  };
}
