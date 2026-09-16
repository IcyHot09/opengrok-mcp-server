/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */
import he from "he";
import { parse as parseHtml } from "node-html-parser";

// ---------------------------------------------------------------------------
// parseMoreResults — "more results" page HTML (all matches in one file)
// ---------------------------------------------------------------------------

export function parseMoreResults(html: string): Array<{ lineNumber: number; lineContent: string }> {
  let root: ReturnType<typeof parseHtml>;
  try {
    root = parseHtml(html, { blockTextElements: { script: true, style: true, noscript: true } });
  } catch {
    return [];
  }
  const moreDiv = root.querySelector("#more") ?? root;
  const results: Array<{ lineNumber: number; lineContent: string }> = [];
  for (const link of moreDiv.querySelectorAll("a.s")) {
    const lineSpan = link.querySelector("span.l");
    const lineNum = lineSpan ? parseInt(lineSpan.text.trim(), 10) : 0;
    let content = he.decode(link.text.trim());
    if (lineSpan) content = content.replace(/^\d+\s*/, "");
    if (lineNum > 0) results.push({ lineNumber: lineNum, lineContent: content });
  }
  return results;
}


// ---------------------------------------------------------------------------
// parseHistoryRss — RSS history feed XML (entries with changed file lists)
// ---------------------------------------------------------------------------

export interface ParsedRssHistoryEntry {
  revision: string;
  summary: string;
  fullMessage: string;
  author: string;
  date: string;
  files: string[];
  branches: string[];
  updateForm?: string;
  mergeRequest?: string;
  autoCheckin: boolean;
}


export function parseHistoryRss(xml: string): ParsedRssHistoryEntry[] {
  const entries: ParsedRssHistoryEntry[] = [];
  for (const im of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = im[1];
    const titleText = (body.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1]
      ?? body.match(/<title>([^<]*)<\/title>/)?.[1] ?? "").trim();
    const rawDesc = body.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
      ?? body.match(/<description>([^]*?)<\/description>/)?.[1] ?? "";
    const desc = he.decode(rawDesc.trim());
    const rawPubDate = body.match(/<pubDate>([^<]*)<\/pubDate>/)?.[1]?.trim() ?? "";
    const parsedPubDate = rawPubDate ? new Date(rawPubDate) : null;
    let pubDate: string;
    if (parsedPubDate && !isNaN(parsedPubDate.getTime())) {
      const y = parsedPubDate.getFullYear();
      const m = String(parsedPubDate.getMonth() + 1).padStart(2, "0");
      const d = String(parsedPubDate.getDate()).padStart(2, "0");
      pubDate = `${y}-${m}-${d}`;
    } else {
      pubDate = rawPubDate;
    }
    const rawAuthor = body.match(/<dc:creator>([^<]*)<\/dc:creator>/)?.[1]?.trim() ?? "";
    const author = he.decode(rawAuthor).replace(/\s*<[^>]+>/g, "").trim();
    const revision = titleText.split(" - ")[0]?.trim() ?? "";
    if (!revision) continue;
    const summary = desc.match(/Summary:\s*\[([^\]]*)\]/)?.[1]?.trim() ?? "";
    const filesIdx = desc.indexOf("List of files:");
    let fullMessage = (filesIdx >= 0 ? desc.slice(0, filesIdx) : desc)
      .replace(/\s*Update Form:.*$/s, "")
      .trim();
    fullMessage = fullMessage
      .replace(/([\w.)])(?=Update Form\s?\d)/g, "$1\n")
      .replace(/([\w.)])(?=MR[-:]\s?\d)/g, "$1\n");
    const titleSubject = titleText.includes(" - ") ? titleText.split(" - ").slice(1).join(" - ").trim() : "";
    if (titleSubject && fullMessage.startsWith(titleSubject) && fullMessage.length > titleSubject.length) {
      const rest = fullMessage.slice(titleSubject.length);
      if (!rest.startsWith("\n")) {
        fullMessage = titleSubject + "\n" + rest.trimStart();
      }
    }
    const branchPart = (titleText + " " + desc).match(/branches:\s*([^;\n]+)/i)?.[1]?.trim() ?? "";
    const branches = branchPart ? branchPart.split(/\s*,\s*|\s+/).filter(Boolean) : [];
    const filesSection = filesIdx >= 0 ? desc.slice(filesIdx + "List of files:".length) : "";
    const files = filesSection.split("\n").map((f) => f.trim()).filter(Boolean)
      .map((f) => f.replace(/^\/[^/]+\//, "/"));
    const updateForm = desc.match(/Update Form:?\s*(\d+)/)?.[1];
    const mergeRequest = desc.match(/MR[-:]?\s*\[?(\d+)\]?/)?.[1];
    const autoCheckin = desc.includes("via AutoCheckin");
    entries.push({
      revision, summary, fullMessage, author, date: pubDate,
      files, branches, updateForm, mergeRequest, autoCheckin,
    });
  }
  return entries;
}

