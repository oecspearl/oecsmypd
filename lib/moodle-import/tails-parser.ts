/**
 * Parsers for the remaining Moodle activity types:
 *   - googlemeet -> a scheduled video conference (join URL)
 *   - forum      -> discussion threads with posts (author by Moodle user id)
 */

import type { MoodleArchive } from "./archive";

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : "";
}

/** Decode the XML-escaped HTML Moodle stores in forum messages / intros. */
function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export interface ParsedConference {
  title: string;
  url: string;
  intro: string;
}

export function parseConferences(archive: MoodleArchive): ParsedConference[] {
  const result: ParsedConference[] = [];
  for (const path of archive.list()) {
    if (!/activities\/googlemeet_\d+\/googlemeet\.xml$/.test(path)) continue;
    const xml = archive.readText(path);
    if (!xml) continue;
    const url = tag(xml, "url");
    if (!url) continue;
    result.push({ title: tag(xml, "name"), url, intro: decode(tag(xml, "intro")) });
  }
  return result;
}

export interface ForumPost {
  moodleUserId: string;
  subject: string;
  message: string;
}

export interface ForumDiscussion {
  title: string;
  posts: ForumPost[];
}

export interface ParsedForum {
  name: string;
  discussions: ForumDiscussion[];
}

export function parseForums(archive: MoodleArchive): ParsedForum[] {
  const result: ParsedForum[] = [];
  for (const path of archive.list()) {
    if (!/activities\/forum_\d+\/forum\.xml$/.test(path)) continue;
    const xml = archive.readText(path);
    if (!xml) continue;

    const forumName = tag(xml, "name");
    const discussions: ForumDiscussion[] = [];
    for (const dm of xml.matchAll(/<discussion\b[\s\S]*?<\/discussion>/g)) {
      const dblock = dm[0];
      const title = decode(tag(dblock, "name"));
      const posts: ForumPost[] = [];
      for (const pm of dblock.matchAll(/<post\b[\s\S]*?<\/post>/g)) {
        const pblock = pm[0];
        const moodleUserId = tag(pblock, "userid");
        const message = tag(pblock, "message");
        if (!moodleUserId || !message) continue;
        posts.push({ moodleUserId, subject: tag(pblock, "subject"), message: decode(message) });
      }
      discussions.push({ title, posts });
    }
    result.push({ name: forumName, discussions });
  }
  return result;
}
