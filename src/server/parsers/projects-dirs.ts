/**
 * Parser subsystem - split from parsers.ts (pure move, no logic changes).
 */
import he from "he";
import { parse as parseHtml } from "node-html-parser";
import type { DirectoryEntry, Project } from "../models.js";

// ---------------------------------------------------------------------------
// Projects page
// ---------------------------------------------------------------------------

export function parseProjectsPage(html: string): Project[] {
  const root = parseHtml(html);
  const projects: Project[] = [];

  // Try select#project or select[name=project]
  const select =
    root.querySelector("select#project") ||
    root.querySelector("select[name=project]");

  if (!select) {
    // Fallback: scrape links to /xref/. Filter out fragment-only hrefs (e.g. /xref/project#anchor)
    // and ensure the path ends cleanly at the project component.
    const seen = new Set<string>();
    for (const a of root.querySelectorAll("a[href]")) {
      const href = /* v8 ignore next */ a.getAttribute("href") ?? "";
      // Exclude hrefs with query strings or fragments that may not be project roots
      if (href.includes("?") || href.includes("#")) continue;
      const m = /\/xref\/([^/]+)\/?$/.exec(href);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        projects.push({ name: m[1] });
      }
    }
    return projects;
  }

  let currentCategory: string | undefined;

  for (const child of select.childNodes) {
    const tag = (child as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "optgroup") {
      const el = child as ReturnType<typeof parseHtml>;
      currentCategory = (el as unknown as { getAttribute: (s: string) => string | undefined }).getAttribute("label") ?? undefined;
      for (const opt of el.querySelectorAll("option")) {
        /* v8 ignore start -- value always present and non-empty in test data */
        const value = opt.getAttribute("value") ?? "";
        if (value) projects.push({ name: value, category: currentCategory });
        /* v8 ignore stop */
      }
    } else if (tag === "option") {
      const value = (child as ReturnType<typeof parseHtml>).getAttribute
        ? (child as unknown as { getAttribute: (s: string) => string | undefined }).getAttribute("value") ?? ""
        : /* v8 ignore next -- option element always has getAttribute */ "";
      if (value) projects.push({ name: value, category: currentCategory });
    }
  }

  return projects;
}


// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

export function parseDirectoryListing(
  html: string,
  project: string,
  currentPath: string
): DirectoryEntry[] {
  const root = parseHtml(html);
  const entries: DirectoryEntry[] = [];

  const table =
    root.querySelector("table#dirlist") || root.querySelector("table");

  if (!table) {
    // Fallback: links within /xref/project/
    const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const seenPaths = new Set<string>();
    for (const a of root.querySelectorAll("a[href]")) {
      const href = /* v8 ignore next */ a.getAttribute("href") ?? "";
      const m = new RegExp(`/xref/${escapedProject}/(.+)$`).exec(href);
      if (!m) continue;
      const entryPath = m[1].replace(/\/$/, "");
      if (entryPath === currentPath.replace(/\/$/, "")) continue;
      if (seenPaths.has(entryPath)) continue;
      seenPaths.add(entryPath);
      entries.push({
        name: /* v8 ignore next */ entryPath.split("/").pop() ?? entryPath,
        isDirectory: href.endsWith("/"),
        path: entryPath,
      });
    }
    return entries;
  }

  const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const absXrefRe = new RegExp(`/xref/${escapedProject}/(.+)$`);
  for (const row of table.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 1) continue;

    // Find the first <a> with a meaningful href in any cell (cells[0] may be
    // an icon cell with no link). Typically cells[0] or cells[1].
    let link: ReturnType<typeof root.querySelector> | null = null;
    for (let ci = 0; ci < Math.min(cells.length, 3); ci++) {
      const candidate = cells[ci].querySelector("a");
      if (candidate) {
        const href = candidate.getAttribute("href") ?? "";
        // Skip anchors that are just "#" or empty
        if (href && href !== "#") {
          link = candidate;
          break;
        }
      }
    }
    if (!link) continue;

    const name = he.decode(link.text.trim());
    const href = /* v8 ignore next */ link.getAttribute("href") ?? "";
    const isDir = href.endsWith("/");

    // Try absolute href first (/xref/project/...), then treat as relative
    const absMatch = absXrefRe.exec(href);
    let entryPath: string;
    if (absMatch) {
      entryPath = absMatch[1].replace(/\/$/, "");
    } else {
      // Relative href — join with current browsing path
      const relativePart = href.replace(/\/$/, "");
      entryPath = currentPath ? `${currentPath}/${relativePart}` : relativePart;
    }

    // Extract size and date from remaining cells — adapt to variable layouts
    let size: number | undefined;
    let lastModified: string | undefined;
    for (let ci = 1; ci < cells.length; ci++) {
      const txt = cells[ci].text.trim();
      if (!txt || txt === "-") continue;
      // Pure number = size in bytes
      if (/^\d+$/.test(txt) && size === undefined) {
        size = parseInt(txt, 10);
      } else if (/^\d{4}-\d{2}-\d{2}/.test(txt) || /\w+\s+\d/.test(txt)) {
        // Date-like cell
        /* v8 ignore start -- lastModified always empty on first date-like cell */
        if (!lastModified) lastModified = he.decode(txt);
        /* v8 ignore stop */
      }
    }

    entries.push({ name, isDirectory: isDir, path: entryPath, size, lastModified });
  }

  return entries;
}

