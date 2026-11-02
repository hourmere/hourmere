import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseImportPlan } from './plan.ts'
import { SourceRefusal } from './schema.ts'
import { extractSource } from './source.ts'
import { type BookingDecision, LIMITS, type SourceVersion, type TargetContext } from './types.ts'
import { validateTargetContext } from './users.ts'

export const operatorMessages = {
  en: {
    help: 'Dry run only. Nothing is imported. Usage: npm run dry-run --workspace @hourmere/import-calcom -- --config /private/import.json [--lang en|zh-CN]. Supply the source connection in CALCOM_IMPORT_SOURCE_URL or a protected file named by sourceConnectionFile in the config. Never pass credentials as arguments.',
    refused:
      'Dry run refused. Check the protected configuration, SELECT-only source role, supported schema and UTC timestamp confirmation. Nothing was imported.',
    complete:
      'Dry run complete. Nothing was imported. The plan exists only in memory; target state comes from the operator-supplied snapshot and must be verified again before any future apply.',
    schema:
      'The source schema is not recognized. Use an audited baseline adapter. Nothing was imported.',
    timezone:
      'The source UTC timestamp convention or actual transaction time zone was not confirmed. Nothing was imported.',
    role: 'The source account must be a dedicated SELECT-only role with no ownership or privilege escalation. Nothing was imported.',
    blocked: 'The plan contains import blockers. Nothing was imported.',
  },
  'zh-CN': {
    help: '仅试运行，不会导入任何数据。用法：npm run dry-run --workspace @hourmere/import-calcom -- --config /private/import.json [--lang en|zh-CN]。源连接通过 CALCOM_IMPORT_SOURCE_URL 或配置中的 sourceConnectionFile 指定的受保护文件提供。请勿将凭据放入命令参数。',
    refused:
      '已拒绝试运行。请检查受保护配置、仅有 SELECT 权限的源角色、支持的数据库结构及 UTC 时间戳确认。未导入任何数据。',
    complete:
      '试运行完成，未导入任何数据。计划仅保存在内存中；目标状态来自操作者提供的快照，后续执行前必须再次核验。',
    schema: '未识别源数据库结构。请使用经过核验的基线适配器。未导入任何数据。',
    timezone: '未确认源库 UTC 时间戳约定或实际事务时区。未导入任何数据。',
    role: '源账号必须是专用只读角色，仅有 SELECT 权限，无所有权或提权权限。未导入任何数据。',
    blocked: '计划中存在阻断导入的问题。未导入任何数据。',
  },
} as const
export interface OperatorConfig {
  sourceVersion: SourceVersion
  selectedUserIds: number[]
  utcTimestampsConfirmed: true
  sourceConnectionFile?: string
  target: TargetContext
  bookingDecisions: BookingDecision[]
}
// Only importer-owned static codes may cross the operator output boundary.
const refusalCodes = new Set([
  'SOURCE_CONNECTION_INVALID',
  'SOURCE_EXTRACTION_FAILED',
  'SOURCE_ISOLATION_UNSAFE',
  'SOURCE_LIMIT_EXCEEDED',
  'SOURCE_NOT_READ_ONLY',
  'SOURCE_PAYMENT_SHAPE_UNKNOWN',
  'SOURCE_ROLE_UNSAFE',
  'SOURCE_SCHEMA_UNKNOWN',
  'SOURCE_SELECTION_INVALID',
  'SOURCE_TIMEZONE_NOT_UTC',
  'SOURCE_UTC_UNCONFIRMED',
  'SOURCE_VERSION_UNKNOWN',
])

/** Owner-only regular files, no symlink race, bounded reads. No path or content in errors. */
export async function readProtectedFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size > maxBytes
    )
      throw new Error('Protected input refused')
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes + 1 - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total > maxBytes) throw new Error('Protected input refused')
    return buffer.subarray(0, total).toString('utf8')
  } finally {
    await handle.close()
  }
}
function validConfig(value: unknown): value is OperatorConfig {
  if (!value || typeof value !== 'object') return false
  const c = value as OperatorConfig
  return (
    c.utcTimestampsConfirmed === true &&
    ['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'].includes(c.sourceVersion) &&
    Array.isArray(c.selectedUserIds) &&
    c.selectedUserIds.length > 0 &&
    c.selectedUserIds.length <= LIMITS.users &&
    c.selectedUserIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(c.selectedUserIds).size === c.selectedUserIds.length &&
    validateTargetContext(c.target) &&
    Array.isArray(c.bookingDecisions) &&
    (c.sourceConnectionFile === undefined || typeof c.sourceConnectionFile === 'string')
  )
}
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
): Promise<number> {
  const lang = argv.includes('zh-CN') ? 'zh-CN' : 'en'
  const messages = operatorMessages[lang]
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    write(messages.help)
    return 0
  }
  try {
    if (
      !(
        (argv.length === 2 || argv.length === 4) &&
        argv[0] === '--config' &&
        typeof argv[1] === 'string' &&
        (argv.length === 2 || (argv[2] === '--lang' && ['en', 'zh-CN'].includes(argv[3] ?? '')))
      )
    )
      throw new Error('Arguments refused')
    const config: unknown = JSON.parse(await readProtectedFile(argv[1] ?? '', LIMITS.jsonBytes))
    if (!validConfig(config)) throw new Error('Configuration refused')
    if (
      (env.CALCOM_IMPORT_SOURCE_URL !== undefined) ===
      (config.sourceConnectionFile !== undefined)
    )
      throw new Error('Exactly one connection input required')
    const connectionString =
      env.CALCOM_IMPORT_SOURCE_URL ??
      (await readProtectedFile(config.sourceConnectionFile ?? '', 16_384)).trim()
    const snapshot = await extractSource({
      connectionString,
      sourceVersion: config.sourceVersion,
      selectedUserIds: config.selectedUserIds,
      utcTimestampsConfirmed: true,
      cutoff: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      targetUsers: config.target.users,
    })
    const plan = parseImportPlan(snapshot, {
      target: config.target,
      bookingDecisions: config.bookingDecisions,
    })
    write(messages.complete)
    write(
      JSON.stringify(
        {
          mode: plan.mode,
          writesPerformed: plan.writesPerformed,
          sourceVersion: plan.sourceVersion,
          schemaFingerprint: plan.schemaFingerprint,
          cutoff: plan.cutoff,
          extractedAt: plan.extractedAt,
          summary: plan.summary,
          bookingExclusionCounts: plan.bookingExclusionCounts,
          userBatches: plan.userBatches,
          problems: plan.problems,
        },
        null,
        2,
      ),
    )
    if (plan.summary.importBlockers) {
      write(messages.blocked)
      return 2
    }
    return 0
  } catch (error) {
    // Do not forward driver errors, causes, paths, argv, credentials or source values.
    const code =
      error instanceof SourceRefusal && refusalCodes.has(error.code) ? error.code : 'IMPORT_REFUSED'
    write(
      `[${code}] ${
        ['SOURCE_SCHEMA_UNKNOWN', 'SOURCE_VERSION_UNKNOWN'].includes(code)
          ? messages.schema
          : ['SOURCE_TIMEZONE_NOT_UTC', 'SOURCE_UTC_UNCONFIRMED'].includes(code)
            ? messages.timezone
            : code === 'SOURCE_ROLE_UNSAFE'
              ? messages.role
              : messages.refused
      }`,
    )
    return 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await runCli(process.argv.slice(2))
