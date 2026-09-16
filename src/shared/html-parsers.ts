/**
 * Shared HTML parsers used by both the VS Code extension and CLI setup.
 */

/**
 * Extract project names from the OpenGrok root page HTML.
 * Looks for <select id="project"> options first, falls back to /xref/ links.
 */
export function parseProjectsFromHtml(html: string): string[] {
  const projects: string[] = [];
  const seen = new Set<string>();

  // Try <select id="project"> or <select name="project"> with <option value="...">
  const selectMatch = /<select[^>]*(?:id=["']project["']|name=["']project["'])[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (selectMatch) {
    const optionRe = /<option[^>]*value=["']([^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = optionRe.exec(selectMatch[1])) !== null) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        projects.push(name);
      }
    }
    if (projects.length > 0) return projects;
  }

  // Fallback: scrape /xref/ links
  const linkRe = /href=["'][^"']*\/xref\/([^/"'?#]+)\/?["']/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const name = lm[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      projects.push(name);
    }
  }
  return projects;
}
