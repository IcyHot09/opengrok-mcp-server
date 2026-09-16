/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */
import he from "he";
import { parse as parseHtml } from "node-html-parser";
import type { AnnotatedFile, AnnotateLine, FileHistory, HistoryEntry } from "../models.js";

// ---------------------------------------------------------------------------
// File history
// ---------------------------------------------------------------------------

export function parseFileHistory(
  html: string,
  project: string,
  path: string
): FileHistory {
  const root = parseHtml(html);
  const entries: HistoryEntry[] = [];

  const table =
    root.querySelector("table#revisions") || root.querySelector("table");
  if (!table) return { project, path, entries };

  for (const row of table.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) continue;

    // The first cell may contain two <a> tags: the first is an anchor link
    // with text "#", and the second has the actual revision hash. Pick the
    // last <a> whose text looks like a hex hash, falling back to any non-"#"
    // link, then to raw cell text.
    const revisionLinks = cells[0].querySelectorAll("a");
    let revision = "";
    if (revisionLinks.length > 1) {
      // Multiple links — prefer the one with a hash-like value
      for (let i = revisionLinks.length - 1; i >= 0; i--) {
        const txt = he.decode(revisionLinks[i].text.trim());
        /* v8 ignore start -- always finds valid revision text in test data */
        if (txt && txt !== "#" && txt.toLowerCase() !== "revision") {
          revision = txt;
          break;
        }
        /* v8 ignore stop */
      }
    } else if (revisionLinks.length === 1) {
      revision = he.decode(revisionLinks[0].text.trim().replace(/^#/, ""));
    }
    if (!revision) revision = he.decode(cells[0].text.trim().replace(/^#/, ""));
    if (!revision || revision.toLowerCase() === "revision") continue;

    const date = /* v8 ignore next */ he.decode(cells[2]?.text.trim() ?? "");
    const author = /* v8 ignore next */ he.decode(cells[3]?.text.trim() ?? "");
    const message = /* v8 ignore next */ he.decode(cells[cells.length - 1]?.text.trim() ?? "");

    const ufMatch = /Update Form:?\s*(\d+)/.exec(message);
    const mrMatch = /MR[-:]?\s*(\d+)/.exec(message);

    entries.push({
      revision,
      date,
      author,
      message,
      updateForm: ufMatch?.[1],
      mergeRequest: mrMatch?.[1],
    });
  }

  return { project, path, entries };
}


// ---------------------------------------------------------------------------
// Annotate / blame
// ---------------------------------------------------------------------------

export function parseAnnotate(
  html: string,
  project: string,
  path: string
): AnnotatedFile {
  // Parse with blockTextElements overridden to exclude <pre>, so that span
  // children inside <pre> are queryable directly — avoids a second parse of innerHTML.
  const root = parseHtml(html, { blockTextElements: { script: true, style: true, noscript: true } });
  const lines: AnnotateLine[] = [];

  const pre = root.querySelector("pre#src") || root.querySelector("pre");
  const searchRoot = pre ?? root;

  const blameSpans = searchRoot.querySelectorAll("span.blame");
  if (blameSpans.length > 0) {
    let lineNum = 0;
    for (const el of blameSpans) {
      lineNum++;
      // Title may be on the span itself (OpenGrok 1.12+) or on a child <a> (1.7.x)
      const title =
        el.getAttribute("title") ||
        el.querySelector("a")?.getAttribute("title") ||
        "";
      const revision =
        /(?:revision|changeset):\s*([a-f0-9]+)/i.exec(title)?.[1] ?? "";
      const author = (
        /(?:author|user):\s*(.+?)(?=\s+(?:date|revision|changeset|version|summary):|\s*<[^>]*@[^>]*>|<br|$)/i
          .exec(title)?.[1] ?? ""
      )
        .replace(/\u00a0/g, " ")
        .trim();
      const date = (
        /date:\s*(.+?)(?=<br|$)/i.exec(title)?.[1] ?? ""
      )
        .replace(/\u00a0/g, " ")
        .trim();
      // In 1.7.x the source code follows the blame span as sibling nodes;
      // in simple format the text is directly inside the span.
      let content: string;
      if (el.querySelector("a.r") !== null) {
        // 1.7.x style: code content follows the blame span as siblings.
        // Note: TextNode.nextSibling is unreliable in node-html-parser —
        // use the parent's childNodes array with index-based iteration instead.
        const parent = el.parentNode;
        if (!parent) {
          content = he.decode(el.text);
        } else {
          const parts: string[] = [];
          const siblings = parent.childNodes;
          const idx = siblings.indexOf(el);
          for (let i = idx + 1; i < siblings.length; i++) {
            const sib = siblings[i];
            const cls: string =
              typeof sib.getAttribute === "function"
                ? (sib.getAttribute("class") ?? "")
                : "";
            if (cls === "blame" || cls.split(" ").includes("blame")) break;
            if (!cls.includes("fold-space")) {
              const t: string = sib.text;
              const nl = t.indexOf("\n");
              if (nl !== -1) {
                if (nl > 0) parts.push(he.decode(t.slice(0, nl)));
                break;
              }
              if (t) parts.push(he.decode(t));
            }
          }
          content = parts.join("").trim();
        }
      } else {
        content = he.decode(el.text);
      }
      lines.push({ lineNumber: lineNum, revision, author, date, content });
    }
  }

  // Fallback: table-based
  if (lines.length === 0) {
    const table = root.querySelector("table");
    if (table) {
      let idx = 1;
      for (const row of table.querySelectorAll("tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        lines.push({
          lineNumber: idx++,
          revision: he.decode(cells[0].text.trim()),
          author: /* v8 ignore next */ he.decode(cells[1]?.text.trim() ?? ""),
          date: "",
          content: /* v8 ignore next */ he.decode(cells[cells.length - 1]?.text ?? ""),
        });
      }
    }
  }

  return { project, path, lines };
}

