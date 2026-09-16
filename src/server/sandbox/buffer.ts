/**
 * Buffer truncation and batch search stub logic for Code Mode sandbox.
 *
 * fitToBuffer — ensures sandbox API results fit within the SharedArrayBuffer data region.
 * buildBatchSearchStubs — generates per-query stubs for dropped batchSearch queries.
 */

/**
 * Build per-query stubs for batchSearch queries that were dropped by fitToBuffer.
 * Preserves the original `totalCount` from the server response so the LLM knows
 * there were real matches and can retry with search().
 */
export function buildBatchSearchStubs(
  queries: Array<{ query: string }>,
  keptCount: number,
  originalResult: unknown[],
): unknown[] {
  const stubs: unknown[] = [];
  for (let i = keptCount; i < queries.length; i++) {
    stubs.push({
      query: queries[i].query,
      totalCount: (originalResult as Array<Record<string, unknown>>)?.[i]?.totalCount ?? 0,
      results: [],
      _truncated: true,
      _message: "Query result dropped due to buffer size — re-run via search()",
    });
  }
  return stubs;
}

/**
 * Truncate `data` so that JSON.stringify({ data }) fits within `maxBytes`.
 * For search results (objects with a `results` array), removes tail entries
 * and sets `_truncated: true`.  For raw arrays, preserves the array type.
 * For strings, truncates with a marker.  Never silently changes the return type.
 */
export function fitToBuffer(data: unknown, maxBytes: number): unknown {
  const fits = (v: unknown) => Buffer.byteLength(JSON.stringify({ data: v }), "utf8") <= maxBytes;
  if (fits(data)) return data;

  const TRUNCATION_MSG = "Result too large for buffer — narrow with dir, fileType, or maxHitsPerFile filters";
  const ARRAY_TRUNCATION_MSG = "Array truncated to fit buffer — use individual search() calls instead of batchSearch, or reduce maxResults";

  // ---- strings: truncate content, never change type to object ----
  if (typeof data === "string") {
    // Binary-search for the longest prefix that fits
    let lo = 0, hi = data.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(data.slice(0, mid) + "\n[truncated]")) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? data.slice(0, lo) + "\n[truncated]" : "[truncated]";
  }

  // ---- arrays (batchSearch): preserve array type, trim proportionally ----
  if (Array.isArray(data)) {
    const arr = data as unknown[];
    const marker = { _truncated: true, _originalLength: arr.length, _message: ARRAY_TRUNCATION_MSG };

    // First: try keeping complete elements using incremental size estimation.
    // Pre-compute per-item serialized sizes to avoid O(n²) re-serialization.
    const markerJson = JSON.stringify(marker);
    const wrapperOverhead = Buffer.byteLength(JSON.stringify({ data: [] }), "utf8");
    const itemJsons = arr.map(item => JSON.stringify(item));
    const itemSizes = itemJsons.map(json => Buffer.byteLength(json, "utf8"));
    const markerSize = Buffer.byteLength(markerJson, "utf8");

    // Calculate how many complete items fit: total = wrapper + items + commas + marker
    let total = wrapperOverhead;
    let count = 0;
    for (let i = 0; i < itemSizes.length; i++) {
      const commasBefore = count > 0 ? 1 : 0;
      // Reserve room for the marker entry at end: comma + markerSize
      const markerCost = markerSize + 1;
      const candidateTotal = total + commasBefore + itemSizes[i] + markerCost;
      if (candidateTotal > maxBytes) break;
      total += commasBefore + itemSizes[i];
      count++;
    }
    if (count > 0) return [...arr.slice(0, count), { ...marker, _kept: count }];

    // No complete element fits — trim results within each element proportionally.
    // Budget per element = maxBytes / arr.length (leave room for overhead).
    const overhead = Buffer.byteLength(JSON.stringify({ data: [marker] }), "utf8");
    const budgetPerElement = Math.floor((maxBytes - overhead) / arr.length);
    if (budgetPerElement > 100) {
      const trimmed: unknown[] = [];
      for (const elem of arr) {
        if (elem !== null && typeof elem === "object" && !Array.isArray(elem)) {
          const obj = elem as Record<string, unknown>;
          const results = obj.results;
          if (Array.isArray(results) && results.length > 0) {
            // Binary-search how many results fit in this element's budget
            let rLo = 0, rHi = results.length - 1;
            const elemFits = (n: number) =>
              Buffer.byteLength(JSON.stringify({ ...obj, results: results.slice(0, n), _truncated: true }), "utf8") <= budgetPerElement;
            while (rLo < rHi) {
              const mid = (rLo + rHi + 1) >> 1;
              if (elemFits(mid)) rLo = mid; else rHi = mid - 1;
            }
            trimmed.push(rLo > 0
              ? { ...obj, results: results.slice(0, rLo), _truncated: true }
              : { ...obj, results: [], _truncated: true, _hint: "Single result too large for buffer — narrow with dir, fileType, or maxHitsPerFile" });
          } else {
            trimmed.push(elem);
          }
        } else {
          trimmed.push(elem);
        }
      }
      if (fits(trimmed)) return trimmed;
    }

    // Truly cannot fit anything — return stubs
    return [{ ...marker, _kept: 0 }];
  }

  // ---- objects with array fields: trim the largest trimmable field ----
  if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;

    // Generic helper: binary-search trim of any named array field
    const trimArrayField = (field: string): unknown | null => {
      const arr = obj[field];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const candidate = { ...obj, [field]: (arr as unknown[]).slice(0, mid), _truncated: true, _droppedCount: arr.length - mid };
        if (fits(candidate)) lo = mid; else hi = mid - 1;
      }
      if (lo === 0) return null;  // even one element overflows — let caller use stub
      return { ...obj, [field]: (arr as unknown[]).slice(0, lo), _truncated: true, _droppedCount: arr.length - lo };
    };

    // All known array fields across every sandbox API method
    const TRIMMABLE_FIELDS = [
      "results",      // search, findFile
      "matches",      // getAllMatchesInFile
      "lines",        // getFileAnnotate
      "entries",      // getFileHistory, browseDirectory, getFileHistoryWithFiles
      "projects",     // listProjects
      "symbols",      // getFileSymbols
      "topLevelSymbols", // getFileOverview
      "hunks",        // getFileDiff (when includeHunks:true)
      "suggestions",  // searchSuggest
      "callers",      // traceCallChain
      "callees",      // traceCallChain
      "guidance",     // getGuidanceForPath
      "samples",      // getSymbolContext .references.samples
    ];

    for (const field of TRIMMABLE_FIELDS) {
      const trimmed = trimArrayField(field);
      if (trimmed !== null) return trimmed;
    }

    // Recursively try trimming array fields within sub-objects (e.g.,
    // getSymbolContext's references.samples lives at obj.references.samples)
    for (const [parentKey, parentVal] of Object.entries(obj)) {
      if (parentVal !== null && typeof parentVal === "object" && !Array.isArray(parentVal)) {
        const sub = parentVal as Record<string, unknown>;
        for (const field of TRIMMABLE_FIELDS) {
          const arr = sub[field];
          if (!Array.isArray(arr) || arr.length === 0) continue;
          let lo = 0, hi = arr.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            const trimmedSub = { ...sub, [field]: (arr as unknown[]).slice(0, mid), _truncated: true, _droppedCount: arr.length - mid };
            const candidate = { ...obj, [parentKey]: trimmedSub };
            if (fits(candidate)) lo = mid; else hi = mid - 1;
          }
          if (lo > 0) {
            const trimmedSub = { ...sub, [field]: (arr as unknown[]).slice(0, lo), _truncated: true, _droppedCount: arr.length - lo };
            return { ...obj, [parentKey]: trimmedSub };
          }
        }
      }
    }

    // Try truncating the largest string field (e.g., getFileContent.content,
    // getFileDiff.unifiedDiff) — binary-search for the longest prefix that fits.
    const stringFields = Object.entries(obj).filter(([, v]) => typeof v === "string" && (v as string).length > 100);
    if (stringFields.length > 0) {
      // Sort by length descending — truncate the largest string first
      stringFields.sort((a, b) => (b[1] as string).length - (a[1] as string).length);
      const [field, val] = stringFields[0];
      const str = val as string;
      let lo = 0, hi = str.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const candidate = { ...obj, [field]: str.slice(0, mid) + "\n[truncated]", _truncated: true };
        if (fits(candidate)) lo = mid; else hi = mid - 1;
      }
      if (lo > 0) {
        return { ...obj, [field]: str.slice(0, lo) + "\n[truncated]", _truncated: true };
      }
    }
  }

  // Preserve useful metadata from the original object in the stub
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const stub: Record<string, unknown> = { _truncated: true, _hint: TRUNCATION_MSG };
    if ("totalCount" in obj) stub.totalCount = obj.totalCount;
    if ("cursor" in obj && obj.cursor) stub.cursor = obj.cursor;
    return stub;
  }

  return { _truncated: true, _hint: TRUNCATION_MSG };
}
