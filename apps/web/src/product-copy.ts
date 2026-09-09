const ACCESS_LABELS = {
  all_members: "All project members",
  selected_members: "Selected members",
  personal: "Personal draft",
};

const ROLE_LABELS = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  manager: "Manager",
};

const HOST_LABELS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  unknown_mcp_client: "Other MCP client",
};

const REVIEW_STATUS_LABELS = {
  all: "All",
  pending: "Needs attention",
  accepted: "Saved",
  rejected: "Not saved",
};

const PERMISSION_LABELS = {
  "mcp:read": "Read projects",
  "mcp:write": "Propose updates",
  offline_access: "Stay connected",
};

function humanize(value) {
  const words = String(value || "")
    .replaceAll("_", " ")
    .trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Not available";
}

export function accessLabel(value) {
  return ACCESS_LABELS[value] || humanize(value);
}

export function roleLabel(value) {
  return ROLE_LABELS[value] || humanize(value);
}

export function hostLabel(value) {
  return HOST_LABELS[value] || humanize(value);
}

export function reviewStatusLabel(value) {
  return REVIEW_STATUS_LABELS[value] || humanize(value);
}

export function permissionLabel(scopes) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || "").split(/[ ,]+/);
  const labels = values.filter(Boolean).map((scope) => PERMISSION_LABELS[scope] || humanize(scope));
  return labels.length ? labels.join(" · ") : "No permissions recorded";
}

export function timestampLabel(value) {
  if (value === null || value === undefined || value === "") return "Not yet recorded";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return humanize(value);
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function localTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return escapeHtml(timestampLabel(value));
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(timestampLabel(value));
  return `<time datetime="${escapeHtml(date.toISOString())}" data-local-time>${escapeHtml(timestampLabel(date))}</time>`;
}

export function localTimeScript() {
  return `<script>(()=>{const formatter=new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});for(const time of document.querySelectorAll("time[data-local-time]")){const date=new Date(time.dateTime);if(!Number.isNaN(date.getTime()))time.textContent=formatter.format(date)}})();</script>`;
}
