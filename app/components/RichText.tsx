"use client";

import { sanitizeHtmlWithEmbeds } from "@/lib/sanitize";

export default function RichText({ html }: { html: string }) {
  return (
    <div className="prose prose-sm max-w-none rich-text-content" dangerouslySetInnerHTML={{ __html: sanitizeHtmlWithEmbeds(html) }} />
  );
}
