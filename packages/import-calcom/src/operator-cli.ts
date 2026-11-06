import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import pg from 'pg'
import { applyImport } from './apply.ts'
import { readProtectedFile } from './cli.ts'
import {
  extractForPreview,
  type PreviewOptions,
  type PreviewPlan,
  previewImport,
  registerImportSource,
} from './preview.ts'
import { TargetRefusal, validateAuthorization } from './target.ts'
import { LIMITS } from './types.ts'
import { UUID } from './users.ts'

const operatorCodes = new Set([
  'IMPORT_ARGUMENTS_INVALID',
  'IMPORT_AUTHORIZATION_REQUIRED',
  'IMPORT_CONNECTION_INVALID',
  'IMPORT_SOURCE_UNKNOWN',
  'IMPORT_SCHEMA_CHANGED',
  'IMPORT_SELECTION_CHANGED',
  'IMPORT_RESOLUTION_INVALID',
  'IMPORT_TARGET_LIMIT',
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
export function operatorRefusalCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return typeof code === 'string' && operatorCodes.has(code) ? code : 'IMPORT_REFUSED'
}

export const applyMessages = {
  en: {
    help: 'Usage: import-calcom <preview|apply|register-source> --config <private-file> [--out <new-plan>] [--report <new-private-report>] [--plan <private-plan>] [--lang en|zh-CN]. Choose an explicit subcommand. Connections belong in protected files or CALCOM_IMPORT_SOURCE_URL / CALCOM_IMPORT_TARGET_URL, never in arguments.',
    preview: 'Preview complete. No source or target rows were written.',
    registered:
      'Source namespace registered. Reuse this identifier for the same real source instance and its backups. No business data was imported.',
    refused:
      'Operation refused. Review the stable code and create a new preview after resolving the cause. No credentials or driver details are included.',
    guarantee:
      'Zero external side effects: no mail, ICS, calendar writes, conferences, webhooks, reminders or repair jobs. Imported bookings remain read-only and managed in the old system.',
    review:
      'Review losses, address changes, identity conflicts, time zones, option mappings, overlaps, buffers and daily limits in the private plan. Reconnect providers separately and enable drafts only after review.',
    rerun:
      'Before apply, freeze source changes in an operator-managed cutover window. Apply re-extracts and compares hashes. Errors roll back the complete batch; a lost response can be retried using the same plan. Rollback requires a separately reviewed local cleanup; never delete source or existing target data.',
    blocked: 'Blocked: no rows may be applied from this plan.',
    ready: 'Candidate plan: apply requires the same explicit operator and owner authorizations.',
    counts: 'Entity / disposition / reason / count',
    identities: 'Source identities (masked emails)',
    times: 'Booking UTC and local times',
    addresses: 'Old and proposed addresses',
    impacts: 'Overlap, buffer, schedule and daily-limit impact',
    writes: 'Proposed table writes',
    losses: 'Losses and exclusions',
    private: 'Authorized private report',
    exclusions: 'Explicit exclusions and accepted dependency losses',
  },
  'zh-CN': {
    help: '用法：import-calcom <preview|apply|register-source> --config <私有配置> [--out <新计划>] [--report <新私有报告>] [--plan <私有计划>] [--lang en|zh-CN]。请明确指定子命令。连接仅通过受保护文件或 CALCOM_IMPORT_SOURCE_URL／CALCOM_IMPORT_TARGET_URL 提供，请勿放入参数。',
    preview: '预览完成，未向源库或目标库写入任何行。',
    registered: '来源命名空间已登记。同一真实来源实例及其备份必须复用此标识。未导入业务数据。',
    refused: '操作已拒绝。请根据稳定代码解决原因，再重新预览。输出不包含凭据或数据库驱动详情。',
    guarantee:
      '保证零外部副作用：不发送邮件、不生成 ICS、不写入日历、不创建会议、不触发 Webhook、不发送提醒、不创建修复任务。导入预约保持只读，由原系统管理。',
    review:
      '请在私有计划中核对损失、地址变化、身份冲突、时区、选项映射、重叠、缓冲和每日限额。请单独重新连接服务，审核后再启用草稿。',
    rerun:
      '执行前，请由操作者安排切换窗口，暂停源端变更。执行会重新提取并比较哈希。错误将回滚整个批次；提交后响应丢失时，可使用同一计划重试。回退须另行审核本地清理方案，不得删除源记录或既有目标数据。',
    blocked: '已阻断：此计划不得写入任何数据行。',
    ready: '候选计划：执行需要相同的操作者授权及每位所有者的明确选择。',
    counts: '实体／处理结果／原因／数量',
    identities: '来源身份（邮箱已掩码）',
    times: '预约 UTC 及当地时间',
    addresses: '原地址与拟用地址',
    impacts: '重叠、缓冲、日程及每日限额影响',
    writes: '拟写入的表及行数',
    losses: '损失与排除项',
    private: '已授权私有报告',
    exclusions: '明确排除项及已接受的依赖损失',
  },
} as const
export interface DatabaseOperatorConfig extends PreviewOptions {
  sourceConnectionFile?: string
  targetConnectionFile?: string
}
export async function writeProtectedOutput(path: string, value: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(value)
    await file.sync()
  } finally {
    await file.close()
  }
}
export function renderPreview(
  plan: PreviewPlan,
  lang: 'en' | 'zh-CN' = 'en',
  privateReport = false,
): string {
  const m = applyMessages[lang]
  const identities = plan.identities.map((i) => ({
    ...i,
    email: privateReport ? i.email : i.email ? `${i.email.trim().slice(0, 1)}***@***` : null,
  }))
  const text = [
    m.preview,
    plan.blocked ? m.blocked : m.ready,
    m.guarantee,
    `${m.counts}\n${plan.counts.map((c) => `${c.entity} / ${c.disposition} / ${c.reason} / ${c.count}`).join('\n')}`,
    `${m.identities}\n${JSON.stringify(identities, null, 2)}`,
    `${m.addresses}\n${JSON.stringify(plan.addresses, null, 2)}`,
    `${m.times}\n${JSON.stringify(plan.bookingTimes, null, 2)}`,
    `${m.impacts}\n${JSON.stringify(plan.impacts, null, 2)}`,
    `${m.writes}\n${JSON.stringify(plan.writes, null, 2)}`,
    `${m.losses}\n${plan.losses.map((p) => `${p.source.table}:${p.source.id} / ${p.severity} / ${p.code}`).join('\n')}`,
    `${m.exclusions}\n${JSON.stringify(plan.manualExclusions, null, 2)}`,
    m.review,
    m.rerun,
    ...(privateReport ? [m.private, JSON.stringify(plan, null, 2)] : []),
  ].join('\n\n')
  return privateReport ? text : text.replace(/[^\s"<>@]+@[^\s"<>@]+\.[^\s"<>@]+/g, '***@***')
}
export async function runDatabaseCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
): Promise<number> {
  const lang = argv.includes('zh-CN') ? 'zh-CN' : 'en',
    m = applyMessages[lang]
  let pool: pg.Pool | undefined
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0] ?? '')) {
      write(m.help)
      return 0
    }
    const command = argv[0]?.startsWith('--') ? 'preview' : argv.shift()
    if (!['preview', 'apply', 'register-source'].includes(command ?? ''))
      throw new TargetRefusal('IMPORT_ARGUMENTS_INVALID')
    const flags = new Map<string, string>()
    for (let n = 0; n < argv.length; n += 2) {
      const key = argv[n],
        value = argv[n + 1]
      if (
        !key ||
        !['--config', '--out', '--report', '--plan', '--lang'].includes(key) ||
        !value ||
        flags.has(key)
      )
        throw new TargetRefusal('IMPORT_ARGUMENTS_INVALID')
      flags.set(key, value)
    }
    if (
      !flags.has('--config') ||
      (flags.has('--lang') && !['en', 'zh-CN'].includes(flags.get('--lang') ?? '')) ||
      (command === 'preview' && (!flags.has('--out') || flags.has('--plan'))) ||
      (command === 'apply' &&
        (!flags.has('--plan') || flags.has('--out') || flags.has('--report'))) ||
      (command === 'register-source' &&
        (flags.has('--plan') || flags.has('--out') || flags.has('--report')))
    )
      throw new TargetRefusal('IMPORT_ARGUMENTS_INVALID')
    const config = JSON.parse(
      await readProtectedFile(flags.get('--config') ?? '', LIMITS.jsonBytes),
    ) as DatabaseOperatorConfig
    if (
      !validateAuthorization(config.authorization) ||
      !['cal.diy-a5ee96f77edd', 'cal.com-v6.2.0'].includes(config.sourceVersion) ||
      config.utcTimestampsConfirmed !== true ||
      !Array.isArray(config.selectedUserIds) ||
      fingerprintSelection(config) !== true ||
      !Array.isArray(config.bookingDecisions) ||
      (command !== 'register-source' && !UUID.test(config.sourceId))
    )
      throw new TargetRefusal('IMPORT_AUTHORIZATION_REQUIRED')
    const connection = async (envKey: string, path: string | undefined) => {
      if ((env[envKey] !== undefined) === (path !== undefined))
        throw new TargetRefusal('IMPORT_CONNECTION_INVALID')
      const value = env[envKey] ?? (await readProtectedFile(path ?? '', 16_384)).trim()
      const parsed = new URL(value)
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
        throw new TargetRefusal('IMPORT_CONNECTION_INVALID')
      return value
    }
    const sourceConnection = await connection(
      'CALCOM_IMPORT_SOURCE_URL',
      config.sourceConnectionFile,
    )
    const targetConnection = await connection(
      'CALCOM_IMPORT_TARGET_URL',
      config.targetConnectionFile,
    )
    pool = new pg.Pool({
      connectionString: targetConnection,
      max: 2,
      connectionTimeoutMillis: 5000,
    })
    // Driver messages may contain credentials. Only finite static codes cross this boundary.
    pool.on('error', () => {})
    const options: PreviewOptions = {
      sourceId: config.sourceId,
      sourceVersion: config.sourceVersion,
      selectedUserIds: config.selectedUserIds,
      utcTimestampsConfirmed: true,
      authorization: config.authorization,
      bookingDecisions: config.bookingDecisions,
      ...(config.resolutions ? { resolutions: config.resolutions } : {}),
      ...(config.exclusions ? { exclusions: config.exclusions } : {}),
    }
    const input = { ...options, connectionString: sourceConnection }
    if (command === 'register-source') {
      const snapshot = await extractForPreview(
        pool,
        input,
        Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      )
      write(m.registered)
      write(
        JSON.stringify({
          sourceId: await registerImportSource(pool, snapshot, config.authorization),
        }),
      )
      return 0
    }
    if (command === 'preview') {
      const plan = await previewImport(pool, input)
      await writeProtectedOutput(flags.get('--out') ?? '', `${JSON.stringify(plan, null, 2)}\n`)
      if (flags.has('--report'))
        await writeProtectedOutput(flags.get('--report') ?? '', renderPreview(plan, lang, true))
      write(renderPreview(plan, lang))
      return plan.blocked ? 2 : 0
    }
    const plan = JSON.parse(
      await readProtectedFile(flags.get('--plan') ?? '', LIMITS.snapshotBytes),
    ) as PreviewPlan
    const report = await applyImport(pool, plan, input)
    write(JSON.stringify(report, null, 2))
    write(m.guarantee)
    return report.status === 'failed' ? 1 : 0
  } catch (error) {
    const code = operatorRefusalCode(error)
    write(`[${code}] ${m.refused}`)
    return 1
  } finally {
    await pool?.end()
  }
}
function fingerprintSelection(c: DatabaseOperatorConfig): boolean {
  return (
    c.selectedUserIds.length === c.authorization.owners.length &&
    new Set(c.selectedUserIds).size === c.selectedUserIds.length &&
    c.selectedUserIds.every((id) => c.authorization.owners.some((o) => o.sourceUserId === id))
  )
}
