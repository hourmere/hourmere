# MCP directory launch checklist

**Owner actions only. Nothing in this change publishes a package, registers a namespace,
submits a listing, or establishes that a hosted MCP endpoint is available.** Requirements
below were checked against the linked official sources on 2026-10-19; recheck them before
submission.

## Prepared metadata

[`server.json`](../server.json) describes the remote Streamable HTTP server at
`https://{instance}/mcp`. `{instance}` is an unresolved hostname input, not a live demo URL.
It deliberately carries `publicationStatus: draft`. The intended registry name is
`io.github.hourmere/hourmere`: the repository belongs to the Hourmere GitHub organization,
and its owner can prove that namespace without adding DNS records. A GitHub organization
**Owner**, rather than an ordinary member, must authenticate. The alternative
`com.hourmere/hourmere` requires proof of control of `hourmere.com` via the registry's
DNS/HTTP method. Choose the permanent name before the first submission; namespace
verification does not prove control of the remote URL.
[Registry authentication](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/modelcontextprotocol-io/authentication.mdx)
and [remote ownership rules](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/modelcontextprotocol-io/remote-servers.mdx).

The draft uses the latest released official
[2025-12-11 JSON schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json),
vendored with its upstream license in [`scripts/schemas/mcp-registry`](../scripts/schemas/mcp-registry).
Its `remotes[].headers` entry requests a **secret user input** containing the complete
`Bearer <API key>` value of the `Authorization` header; no credential or default is embedded. Optional
OAuth 2.1 is documented under the official publisher-provided `_meta` extension because
this schema has no standard OAuth configuration field. That extension is informational;
clients must use Hourmere's discovery endpoints. OAuth clients must not also configure the
static API-key Authorization header.

Hourmere's existing [MCP guide](mcp.md#oauth-21-connectors) describes
`MCP_OAUTH_ENABLED=true`, HTTPS `PUBLIC_URL`, resource and issuer discovery, S256 PKCE,
CIMD/DCR, `mcp:tools`, and optional `offline_access`. OAuth is disabled by default; API keys
work independently. This preparation does not change that behavior.

Run the offline checks from the repository root:

```sh
npm run mcp:registry:validate
npm test -- scripts/validate-mcp-registry.test.ts --maxWorkers=2
```

The first command validates the official schema and Hourmere's secret-header contract. It
does not test a deployment or prove namespace ownership. The submission check below must
fail against the checked-in draft:

```sh
npm run mcp:registry:validate -- --for-submission
```

## Shared owner preparation

- Choose and operate a stable, publicly reachable HTTPS deployment with `/mcp`; confirm
  domain ownership, supported signup, support contact, privacy policy and terms. Use
  synthetic data and a populated reviewer/demo organization. Do not put reviewer
  credentials, API keys, booking management tokens or calendar credentials in this repo.
- Confirm account permissions, tool descriptions, titles, annotations and expected booking
  side effects in the actual hosted clients. Exercise discovery, slots, create, list,
  reschedule, cancel, revocation and denied access. Record the precise tested deployment
  and client versions; local protocol tests do not establish hosted acceptance.
- Enable OAuth on the selected deployment for connector directories. Keep review accounts
  usable throughout review, and arrange a supported sign-in method with the reviewer. The
  development mail logger is not a public-demo sign-in method.
- Decide the release version. `1.0.0` in this draft is the intended launch version, not a
  released-server claim. The current MCP implementation advertises `0.0.0` in
  `apps/server/src/mcp/endpoint.ts`; the release must align the deployed implementation and
  registry version before submission. See [releasing](releasing.md).
- Prepare a separate submission copy of `server.json`: replace the URL with the verified
  concrete deployment URL, remove the unused `instance` variable, update the version,
  replace the draft notice with accurate deployment information, and set
  `_meta["io.modelcontextprotocol.registry/publisher-provided"]["com.hourmere"].publicationStatus`
  to `owner-approved` only after the owner approves that exact copy. Run
  `npm run mcp:registry:validate -- /path/to/submission/server.json --for-submission`.
  This remains an offline check, not an approval service or a live reachability check.

## Official MCP Registry — owner submission

Submit the approved `server.json` with `mcp-publisher` from a dedicated directory containing
that copy. Authenticate with `mcp-publisher login github` as an Hourmere organization Owner
(or use the domain method after choosing the domain namespace), then review the namespace
and endpoint before the owner runs `mcp-publisher publish`. These commands are instructions
for a later owner action; they have not been run by this task. Follow the current official
[quickstart](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/modelcontextprotocol-io/quickstart.mdx).

A remote entry must be publicly accessible at the stated URL. The registry supports URL
templates, but the launch copy should use the concrete owner-operated endpoint tested
above. A remote-only entry needs no package: the npm CLI is an MCP **client**, so it is not
listed as an installable MCP server package. Only the official publisher-provided `_meta`
key is preserved, with a 4096-byte extension limit. Namespace authentication is a separate
requirement from local schema validation.
[Remote-server requirements](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/modelcontextprotocol-io/remote-servers.mdx),
[official registry requirements](https://github.com/modelcontextprotocol/registry/blob/11b7b0e274d518b6f449c5ee3518a6151d9848b9/docs/reference/server-json/official-registry-requirements.md).

## PulseMCP — owner follow-up after intake reopens

The official [server directory](https://www.pulsemcp.com/servers) currently announces that
new server submissions and listing changes are paused. The owner must recheck the
[submission page](https://www.pulsemcp.com/submit) before taking action; no submission or
automatic ingestion is guaranteed here. Keep the approved registry name/version, source
repository, documentation, description, concrete remote URL, transport and authentication
instructions ready. Check for an existing listing before requesting another one when
intake resumes. PulseMCP already displays official `server.json` metadata and remote/auth
details in [its listings](https://www.pulsemcp.com/servers/tabula); use the approved remote
metadata as the factual source.

## mcp.so — owner submission and payment decision

The [Remote Server form](https://mcp.so/submit?type=remote-server) currently requires a
remote endpoint URL and name. Its paid submission flow shows a US$39 one-time fee and
immediate publication; the owner must decide whether to pay and recheck the actual form
before proceeding. The [MCP Server form](https://mcp.so/submit?type=server) instead requests
a repository URL and optional name. Prepare the public repository, documentation, short
description, concrete HTTPS `/mcp` URL and API-key/OAuth setup instructions for whichever
listing the owner chooses. Do not use a placeholder endpoint or include a usable token.
Neither a form submission nor a purchase is part of this task.

## Claude Connectors Directory — owner review

The current [official submission guide](https://claude.com/docs/connectors/building/submission)
requires a public HTTPS remote server, OAuth for tools acting on users' accounts,
tool titles and applicable read-only/destructive annotations, and testing every tool in
Claude. Prepare documentation and privacy-policy URLs, support contact, icon and a
populated reviewer account. A paid Claude plan can submit through the developer portal
(`claude.ai/directory/manage` → Submit new → MCP connector). The owner must check current
account/organization permissions, terms and all portal questions. Screenshots are needed
for MCP Apps with UI; Hourmere currently exposes tools, so do not claim an MCP App UI.

Enable and test Hourmere's OAuth flow before submitting this authenticated service.
API-key header support in custom connectors does not replace the directory's OAuth
requirement. Validate browser login, organization choice, consent, refresh and disconnect
in the hosted client, and provide reviewer credentials privately through the portal.
Submission may result in a Community listing automatically after policy scans; pressing
Submit is a publication decision reserved for the owner.

## ChatGPT directory — owner review

OpenAI's current official documentation calls the public submission route **Plugins**.
The owner must verify their individual/business developer identity, ensure the required
`api.apps.write` permission, provide a real public production endpoint, and test the MCP
connection in ChatGPT. A universal endpoint is preferred: template URLs are currently
restricted to trusted developers with an established OpenAI relationship. The checked-in
`{instance}` draft is not a review endpoint.
[Remote MCP review requirements](https://developers.openai.com/plugins/deploy/app-review).

Prepare the plugin ZIP/MCP configuration and listing website, support, privacy and terms
URLs. Complete the portal's domain challenge on a domain the owner controls. The public
portal currently supports OAuth/no-auth flows but provides no API-key connection flow;
enable OAuth for Hourmere, rather than embedding headers or declaring it unauthenticated.
Prepare five positive and three negative tested cases, an accessible walkthrough video,
release notes and private reviewer credentials. Reviewers must be able to sign in without
magic links, email/SMS codes, MFA approval or private-network access. Hourmere's email-link
default therefore needs an owner-arranged supported reviewer login, such as a configured
Google/Microsoft sign-in account; its acceptability must be confirmed before submission.
Keep credentials out of the ZIP and repo. Follow the current
[submission guide](https://developers.openai.com/plugins/deploy/submission), resolve scans,
submit only after owner approval, and let the owner choose publication after review.
The official Registry `server.json` alone is not a ChatGPT directory submission package.
