function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function readableText(value: unknown): string {
  return decodeHtml(String(value ?? ""))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/\*+|~{2,}|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function readableLabel(value: unknown): string {
  const label = readableText(String(value ?? "").replace(/[._-]+/g, " "));
  return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Update";
}

export function parseReadableValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function renderReadableValue(value: unknown, depth = 0): string {
  const parsed = depth === 0 ? parseReadableValue(value) : value;
  if (depth > 5) return '<p class="muted">Additional detail omitted.</p>';
  if (parsed === null || parsed === undefined) return '<p class="muted">No value recorded.</p>';
  if (typeof parsed === "string") {
    const text = readableText(parsed);
    return `<p>${escapeHtml(text || "No text recorded.")}</p>`;
  }
  if (typeof parsed === "boolean") return `<p>${parsed ? "Yes" : "No"}</p>`;
  if (typeof parsed === "number") return `<p>${escapeHtml(parsed)}</p>`;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return '<p class="muted">No items recorded.</p>';
    return `<ul class="readable-list">${parsed
      .map((item) => `<li>${renderReadableValue(item, depth + 1)}</li>`)
      .join("")}</ul>`;
  }
  if (typeof parsed === "object") {
    const entries = Object.entries(parsed);
    if (entries.length === 0) return '<p class="muted">No details recorded.</p>';
    return `<dl class="readable-fields">${entries
      .map(
        ([key, item]) =>
          `<dt>${escapeHtml(readableLabel(key))}</dt><dd>${renderReadableValue(item, depth + 1)}</dd>`,
      )
      .join("")}</dl>`;
  }
  return `<p>${escapeHtml(readableText(parsed))}</p>`;
}

export function formatLocalTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  }).format(date);
}
