import { describe, test, expect } from "vitest";
import { remapContentLinks } from "./link-remap";

describe("remapContentLinks", () => {
  const maps = {
    coursePath: "/course/C",
    lessonUrlBySectionNumber: new Map([
      [1, "/course/C/lesson/L1"],
      [2, "/course/C/lesson/L2"],
    ]),
    sectionIdToNumber: new Map([["691", 1]]),
  };

  test("rewrites internal Moodle links to MyPD destinations, leaving external links", () => {
    const content = JSON.stringify([
      {
        data: {
          html:
            '<p>Go <a href="https://new-moodle.oecs.org/course/view.php?id=96&amp;section=2">HERE</a>, ' +
            '<a href="https://new-moodle.oecs.org/course/section.php?id=691">Week 1</a>, ' +
            '<a href="https://new-moodle.oecs.org/mod/googlemeet/view.php?id=2597">Session</a>, ' +
            '<a href="https://docs.google.com/document/x">External</a></p>',
        },
      },
    ]);

    const out = remapContentLinks(content, maps);

    // section=2 (by number) -> that subject's first lesson
    expect(out).toContain("/course/C/lesson/L2");
    // section.php?id=691 -> number 1 -> that subject's first lesson
    expect(out).toContain("/course/C/lesson/L1");
    // googlemeet -> the course page
    expect(out).toContain('href=\\"/course/C\\"');
    // external link untouched
    expect(out).toContain("docs.google.com/document/x");
    // no Moodle links remain
    expect(out).not.toContain("new-moodle.oecs.org");
  });
});
