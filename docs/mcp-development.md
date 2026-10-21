# MCP development

## Adding a tool

Tools live in `apps/server/src/mcp/`. Each is declared with `defineTool` (`tools.ts`): a
snake_case name, a title, a description written for models (when to use it, what it returns,
units and time zones), a strict zod input schema (reuse the REST route's schemas), an output
schema, all four annotations, and a handler that builds a `ServiceContext` from the caller and
calls the service layer. The framework validates arguments and results, maps `DomainError`
to error results and logs anything else on one escaped line. Register the tool in `server.ts`
and cover it in `apps/server/src/mcp/*.test.ts`.
