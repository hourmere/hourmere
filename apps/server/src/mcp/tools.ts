// The MCP tool framework: each tool declares its schemas, annotations and a handler that
// calls the service layer; runTool turns the outcome into an MCP tool result with the same
// error codes and messages as the REST API.
import { getOpenApiMetadata } from '@asteasolutions/zod-to-openapi'
import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { DomainError, type DomainErrorKind } from '@hourmere/scheduling'
import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import { hasUnsafeJsonText } from '../app.ts'
import type { RateLimiter } from '../rate-limit.ts'

/**
 * Who calls a tool. MCP accepts API keys only for now; OAuth access tokens (later) will
 * resolve to the same kind of principal, so tools do not change.
 */
export type McpCaller = Extract<Principal, { kind: 'api_key' }>

/** What a tool's handler gets besides its arguments. */
export interface ToolCall {
  caller: McpCaller
  /**
   * Counts this call against `limiter` for the caller's user, all of their API keys together
   * (one person cannot multiply a limit by creating keys). Over the limit, the call stops
   * here and the tool answers `rate_limited` with the seconds to wait.
   */
  rateLimit(limiter: RateLimiter): void
}

/**
 * MCP tool annotations, all required so every tool states them. Clients treat them as hints
 * (e.g. to ask the user before a destructive call), never as guarantees.
 */
export interface ToolAnnotations {
  /** Changes nothing. */
  readOnlyHint: boolean
  /** May undo or overwrite something, e.g. cancel a booking (only meaningful for writes). */
  destructiveHint: boolean
  /** Repeating the call with the same arguments has no further effect. */
  idempotentHint: boolean
  /** Reaches people or systems beyond Hourmere's own data, e.g. a host's calendar. */
  openWorldHint: boolean
}

export interface Tool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** snake_case, stable: agents and their prompts refer to it. */
  name: string
  /** For people, in client UIs. */
  title: string
  /**
   * For the model: when to use the tool, what it returns, units and time zones. This and the
   * schemas' descriptions are all a model knows about the tool.
   */
  description: string
  /** The arguments, a strict zod object; reuse the REST route's schemas where they exist. */
  input: I
  /** The result (structuredContent). Only its fields are sent. */
  output: O
  annotations: ToolAnnotations
  /** Calls the service layer. Throw DomainError for failures the caller can act on. */
  run(args: z.output<I>, call: ToolCall): Promise<z.input<O>>
}

/** Declares a tool, checking its handler against its schemas. */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(tool: Tool<I, O>): Tool {
  return tool as unknown as Tool
}

/** The body of an error result: the REST API's error shape, plus Retry-After's value. */
export interface ToolErrorBody {
  error: string
  message?: string
  retryAfterSeconds?: number
}

/** A failed call: the model sees it (and may correct itself), unlike a protocol error. */
function errorResult(body: ToolErrorBody): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
}

/** Same text as the REST API's guard for JSON bodies. */
const UNSAFE_TEXT = 'Text in the request must not contain NUL characters or malformed Unicode'

/** Thrown by ToolCall.rateLimit; never leaves runTool. */
class RateLimited extends Error {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super('rate limited')
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const DOMAIN_KINDS: ReadonlySet<DomainErrorKind> = new Set([
  'invalid',
  'forbidden',
  'not_found',
  'conflict',
])

/**
 * `text`, cut to `max` characters with a note of how much was left out. For anything that
 * repeats client input (field names, tool names) into a response or a log line.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  // Never cut a surrogate pair in half: a lone surrogate breaks JSON consumers and encoders.
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max
  return `${text.slice(0, end)}…(+${text.length - end} chars)`
}

/**
 * "path: message; …", as the REST API reports request validation failures. Zod repeats
 * unknown field names in its messages, so each part and the whole are bounded.
 */
function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  const parts = issues.map((i) => {
    const path = i.path.map((p) => clip(String(p), 100)).join('.')
    return clip(path ? `${path}: ${i.message}` : i.message, 300)
  })
  return clip(parts.join('; '), 2000)
}

/** Logs one line about a failed call; the endpoint escapes it (see endpoint.ts). */
export type ToolErrorLog = (label: string, detail: unknown) => void

/**
 * Runs one tool call: checks the arguments (text guard, then the zod schema), runs the
 * handler and checks its result against the output schema. Failures the caller can act on
 * become error results with the REST API's codes; anything else is logged and answered
 * with an opaque `internal_error`.
 */
export async function runTool(
  tool: Tool,
  args: unknown,
  call: ToolCall,
  logError: ToolErrorLog,
): Promise<CallToolResult> {
  try {
    if (hasUnsafeJsonText(args))
      return errorResult({ error: 'invalid_request', message: UNSAFE_TEXT })
    const parsed = tool.input.safeParse(args ?? {})
    if (!parsed.success) {
      return errorResult({ error: 'invalid_request', message: describeIssues(parsed.error.issues) })
    }
    const result = tool.output.safeParse(await tool.run(parsed.data, call))
    if (!result.success) {
      logError(`${tool.name} returned a result outside its output schema: `, result.error)
      return errorResult({ error: 'internal_error' })
    }
    // Clients that predate structuredContent read the text.
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    }
  } catch (err) {
    if (err instanceof RateLimited) {
      return errorResult({
        error: 'rate_limited',
        message: `Too many ${tool.name} calls for this user; try again in ${err.retryAfterSeconds} s`,
        retryAfterSeconds: err.retryAfterSeconds,
      })
    }
    // An unknown kind (only possible by bypassing the type) is a bug, as in the REST API.
    if (err instanceof DomainError && DOMAIN_KINDS.has(err.kind)) {
      // The lower-level error a service wrapped is for us, not the client.
      if (err.cause !== undefined) logError(`${tool.name}: ${err.code} caused by `, err.cause)
      return errorResult(
        err.detail ? { error: err.code, message: err.detail } : { error: err.code },
      )
    }
    logError(`${tool.name}: `, err)
    return errorResult({ error: 'internal_error' })
  }
}

type JsonSchema = Record<string, unknown>

/**
 * Adapts zod's JSON Schema to what tools/list should say:
 * - adds what the REST schemas say through `.openapi()` (descriptions, examples), which
 *   zod's own conversion leaves out, so tools document the same fields as the OpenAPI
 *   document;
 * - drops zod's generated `pattern` from strings that have a `format`: it says the same at
 *   length, in every model's context, and the server validates anyway;
 * - leaves results open to new fields (zod closes every object it describes as output):
 *   fields are added within a version, and clients must ignore those they do not know.
 *   Strict objects (arguments) stay closed.
 */
function adaptJsonSchema(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }): void {
  const meta = getOpenApiMetadata(ctx.zodSchema as z.ZodType)
  if (typeof meta.description === 'string') ctx.jsonSchema.description = meta.description
  if (meta.example !== undefined) ctx.jsonSchema.examples = [meta.example]
  if (typeof ctx.jsonSchema.format === 'string') delete ctx.jsonSchema.pattern
  const def = (ctx.zodSchema as { _zod?: { def?: { type?: string; catchall?: unknown } } })._zod
    ?.def
  if (def?.type === 'object' && def.catchall === undefined) {
    if (ctx.jsonSchema.additionalProperties === false) delete ctx.jsonSchema.additionalProperties
  }
}

/**
 * A zod schema as the SDK sees it: its JSON Schema for tools/list (converted once), and a
 * `validate` that lets everything through, because runTool validates with the zod schema
 * itself so that failures get the REST API's error shape.
 */
function advertised(schema: z.ZodType): StandardSchemaWithJSON {
  const converted = new Map<string, JsonSchema>()
  const jsonSchema = (io: 'input' | 'output') => (options: { target: string }) => {
    const target = options.target === 'draft-07' ? 'draft-7' : 'draft-2020-12'
    const key = `${io} ${target}`
    let found = converted.get(key)
    if (!found) {
      found = z.toJSONSchema(schema, {
        target,
        io,
        unrepresentable: 'any',
        override: adaptJsonSchema,
      }) as JsonSchema
      converted.set(key, found)
    }
    // A copy: the SDK may adjust what it gets, and the cached one is shared by all requests.
    return structuredClone(found)
  }
  return {
    '~standard': {
      version: 1,
      vendor: 'hourmere',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: jsonSchema('input'), output: jsonSchema('output') },
    },
  }
}

/** A tool ready to be registered on each request's McpServer. */
export interface PreparedTool {
  tool: Tool
  inputSchema: StandardSchemaWithJSON
  outputSchema: StandardSchemaWithJSON
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

/** Checks the tools once, at startup: names valid and unique. */
export function prepareTools(tools: readonly Tool[]): PreparedTool[] {
  const names = new Set<string>()
  return tools.map((tool) => {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`invalid MCP tool name: ${tool.name}`)
    if (names.has(tool.name)) throw new Error(`duplicate MCP tool name: ${tool.name}`)
    names.add(tool.name)
    return { tool, inputSchema: advertised(tool.input), outputSchema: advertised(tool.output) }
  })
}

/** Registers the tools on a server that serves one request for `caller`. */
export function registerTools(
  server: McpServer,
  tools: readonly PreparedTool[],
  caller: McpCaller,
  logError: ToolErrorLog,
): void {
  const call: ToolCall = {
    caller,
    rateLimit(limiter) {
      const retryAfter = limiter.hit(`user:${caller.user.id}`)
      if (retryAfter !== undefined) throw new RateLimited(retryAfter)
    },
  }
  for (const { tool, inputSchema, outputSchema } of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema,
        outputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args: unknown) => runTool(tool, args, call, logError),
    )
  }
}
