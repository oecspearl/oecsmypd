import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MoodleArchive } from "./archive";
import { parseConferences, parseForums } from "./tails-parser";

const sqljr = new MoodleArchive(
  readFileSync(new URL("./__fixtures__/sqljr.mbz", import.meta.url))
);

describe("parseConferences", () => {
  test("extracts Google Meet sessions with their join URLs", () => {
    const conferences = parseConferences(sqljr);

    expect(conferences.length).toBeGreaterThanOrEqual(1);
    const c = conferences[0];
    expect(c.title).toContain("Synchronous Sessions");
    expect(c.url).toBe("https://meet.google.com/zkh-piqx-bak");
  });
});

describe("parseForums", () => {
  test("extracts forum discussions and their posts with authors", () => {
    const forums = parseForums(sqljr);

    // SQLJR has 2 forums with real discussion posts.
    const withPosts = forums.filter((f) => f.discussions.some((d) => d.posts.length > 0));
    expect(withPosts.length).toBeGreaterThanOrEqual(1);

    const discussion = withPosts.flatMap((f) => f.discussions).find((d) => d.posts.length > 0)!;
    expect(discussion.title.length).toBeGreaterThan(0);
    const post = discussion.posts[0];
    expect(post.moodleUserId).toMatch(/^\d+$/);
    expect(post.message.length).toBeGreaterThan(0);
  });
});
