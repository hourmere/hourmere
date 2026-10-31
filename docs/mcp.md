# MCP client setup

The canonical [MCP quickstart](https://hourmere.com/docs/mcp) covers API keys, OAuth,
tools and protocol behavior.

Create an API key at `/app/api-keys`. Its one-time key creation view has copy buttons for
the key, the curl example, a JSON client config and a Claude Code command. The snippets use
the instance's configured `PUBLIC_URL` and the newly created key. Save them privately
before dismissing the view or leaving the page: the full key cannot be retrieved again and
never appears in the keys list. The new key appears in that list immediately.

For clients that support a remote Streamable HTTP MCP server with custom headers:

```json
{
  "mcpServers": {
    "hourmere": {
      "type": "http",
      "url": "https://hourmere.example.com/mcp",
      "headers": {
        "Authorization": "Bearer hm_…"
      }
    }
  }
}
```

Configuration keys vary by client; for example, VS Code's `.vscode/mcp.json` uses `servers`
instead of `mcpServers`.

For Claude Code:

```sh
claude mcp add --transport http hourmere 'https://hourmere.example.com/mcp' \
  --header "Authorization: Bearer hm_…"
```

In these documentation examples, replace `https://hourmere.example.com` with the instance's
`PUBLIC_URL` and `hm_…` with your API key. The endpoint is `<PUBLIC_URL>/mcp`; API keys are
sent as `Authorization: Bearer <key>`. Session cookies do not authenticate MCP.
