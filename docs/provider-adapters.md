# alice. Provider Adapter Strategy

Status: Accepted for Milestone 01

Decision date: 2026-08-26

## Decision

alice. is a provider-independent project intelligence layer. MCP is the preferred native adapter for hosts that support the required authenticated read and explicit candidate-capture tools; it is not the product boundary.

The target personal ChatGPT Plus account was inspected on 2026-08-26. It exposes:

- the Plugins Directory;
- write-capable installed plugins;
- `Settings > Security and login > Developer mode`; and
- an explicit warning that Developer mode permits unverified connectors that may modify or erase external data.

Developer mode was off during the failed connection attempt. The official development flow requires enabling it before the Plugins Directory exposes the control for adding a public HTTPS or Secure MCP Tunnel endpoint. Therefore the evidence does not support a Business-only product restriction. Plan, region, surface, and account or workspace policy can still affect availability and must be checked during onboarding.

Milestone 01 remains the native MCP round-trip spike. It will not add a browser extension or replace the host workflow before the target Plus account has been tested with Developer mode enabled.

## ChatGPT tool authorization compatibility

Verified on 2026-08-27 with ChatGPT Developer mode and `@modelcontextprotocol/server` 2.0.0:

- The connection's OAuth authorization must include both `mcp:read` and `mcp:write`; a read-only token correctly failed closed when ChatGPT attempted candidate capture.
- ChatGPT classifies and authorizes actions from per-tool OAuth scope metadata. The spike therefore mirrors each tool's least-privilege OAuth scheme in `_meta.securitySchemes`: `mcp:read` for context tools and `mcp:write` for candidate capture.
- The SDK version used by the spike did not emit a top-level `securitySchemes` field from the registered tool descriptor. The `_meta` compatibility mirror is covered by integration tests, while alice. continues to enforce the bearer-token scope server-side rather than trusting host classification.
- ChatGPT showed an explicit confirmation before the write action. Candidates still remained pending until alice.'s independent human review.

This is an observed adapter requirement for the recorded versions, not a permanent product assumption. Revalidate it when either host or SDK changes.

## Claude OAuth compatibility

Verified on 2026-08-27 with a personal Claude Pro account and a custom remote MCP connector:

- Claude used dynamic client registration and requested `mcp:read offline_access` during initial authorization when alice.'s registration response did not include registered `scope` metadata.
- Claude exposed all three tools and allowed an explicit write confirmation, but the server correctly rejected the write because the bearer token lacked `mcp:write`.
- RFC 7591 permits an authorization server to register omitted client scope metadata with defaults and requires registered metadata to be returned in the client information response. The spike now returns its bounded `mcp:read mcp:write offline_access` default in the dynamic client information response.
- The authorization page derives its description from the scopes actually requested, preventing a read-only grant from being presented as candidate-write access.
- A reconnect probe showed that Claude derives its authorization request from the MCP resource's `WWW-Authenticate` scope challenge rather than expanding to the DCR response default. The spike therefore advertises the bounded `mcp:read mcp:write` union in the unauthenticated resource challenge.
- Transport authentication accepts any valid alice. access token. Least privilege remains enforced per tool: read actions require an authenticated connection and `save_project_update` separately requires `mcp:write`, so a read-only token can retrieve context but still fails closed on capture.
- During the spike, Claude continued using the old challenge scope after the connector was disconnected and recreated at the same server URL. A fresh temporary hostname forced clean discovery. Treat connector discovery caching and recovery behavior as an observed host limitation that needs a stable production reauthorization test.
- Claude requested confirmation for its initial read and write actions. After one `Allow once` write confirmation, a write in a later fresh conversation completed without another actionable confirmation remaining in the observed page state. alice. therefore cannot treat host confirmation UX as the trust boundary; candidate-only writes and independent human review remain mandatory.

The failed read-only write attempt created no evidence or candidate and is retained as a fail-closed compatibility result.

## Adapter comparison

| Path | First-time friction | Recurring friction | Reliability | Security posture | Platform risk | Preserves ChatGPT Plus | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Native custom MCP in Developer mode | Medium: enable mode and add authenticated endpoint | Low: select alice. and ask naturally | High when the host supports the advertised tools | Good with OAuth, bounded tools, host confirmations, and human review; the connection is unverified during development | Low to medium; availability can depend on account and policy | Yes for the inspected target account | Preferred Milestone 01 path |
| Published MCP-backed ChatGPT plugin | Medium for alice. because public review, identity, policy, and stable deployment are required; low for users after publication | Low | Expected high after review | Strongest supported distribution posture; app action permissions and confirmations still apply | Medium; publication and invocation remain platform-controlled | Potentially, but each listing's capabilities and plan availability must be verified | Product distribution target after the spike, not an immediate test dependency |
| Explicit web handoff | None | Medium: deliberately copy an alice. context package into the host and paste a structured candidate package back into alice. | High because it uses stable clipboard and web UI primitives | Strong if packages are bounded, previewed, and submitted only by an explicit user action | Low | Yes | Supported fallback and manual baseline |
| Custom GPT Action | High and host-specific | Low once configured | Medium | Supported OAuth/API action model | High for this use: personal Plus accounts cannot create or publish new GPTs | No for a new alice. GPT on the current personal account | Rejected as the Plus path |
| Minimal browser companion | Medium: install a narrowly permissioned extension | Low: user-triggered capture or insertion | Medium; selected-text capture is robust, composer insertion depends on host DOM | Acceptable only with `activeTab`, explicit gestures, no cookies or history, no background capture, and a preview before transmission | Medium to high because host DOM changes can break insertion | Yes | Deferred fallback experiment only if native MCP availability or measured friction fails |
| Standalone OpenAI API client | High; separate product surface and API billing | Medium | High at the API boundary | Server-controlled, but alice. becomes the chat product | Low technically, high product divergence | No; it does not use the user's ChatGPT subscription experience | Rejected for the MVP promise |
| Hidden session automation or reverse-engineered endpoints | Superficially low | Unreliable | Low | Unacceptable credential, privacy, and consent risk | Critical | Superficially | Prohibited |

## Supported fallback contract

The explicit handoff fallback preserves the same domain semantics as MCP:

### Consumption handoff

1. alice. renders a bounded, versioned context package from accepted state.
2. The user previews and copies it.
3. The user pastes it into the destination AI.

### Capture handoff

1. The AI produces a structured candidate package at the user's request.
2. The user copies it into the alice. review control plane.
3. alice. validates and stores the exact submitted package as immutable evidence.
4. Candidate claims remain pending until human review.

The fallback must not imply that manually transferred content is verified merely because it came from a supported host.

## Browser companion constraints

If a later evidence-gated experiment builds a browser companion, it must:

- run only after a toolbar action, context-menu action, or keyboard shortcut;
- request temporary `activeTab` access instead of persistent access to all sites;
- capture only the user's current selection or insert only a user-approved context package;
- never read cookies, authentication state, browsing history, unrelated tabs, or full conversation history;
- never call undocumented ChatGPT or Claude endpoints;
- show the exact payload and destination before sending data to alice.;
- keep alice. authentication separate from host authentication; and
- fail closed when a host composer cannot be identified reliably.

These constraints follow Chrome's documented guidance that `activeTab` grants temporary page access only after an explicit user gesture and that extensions should request the minimum permissions necessary.

## Current official references

- OpenAI, [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt): Developer mode, public HTTPS/Secure MCP Tunnel connection, tool evaluation, and write-action testing.
- OpenAI, [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins): plugins may package skills, MCP servers, and optional UI across ChatGPT and Codex.
- OpenAI, [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex): the directory is visible across plans, while installation and invocation can depend on plan, role, region, surface, and included capabilities.
- OpenAI, [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in): personal-account app permissions, write-action confirmations, custom MCP apps, and public plugin discovery.
- OpenAI, [Creating and editing GPTs](https://help.openai.com/en/articles/8554397): personal Free, Go, Plus, and Pro accounts cannot create or publish new GPTs.
- Chrome, [The activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) and [Protect user privacy](https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy): temporary user-gesture access and least-privilege guidance.

Because provider capabilities change, repository claims about current plan behavior must include a verification date and should be rechecked before release or cohort expansion.
