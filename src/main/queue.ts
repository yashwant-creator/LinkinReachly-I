import type { ProfileFacts, QueueState, TargetRow } from '@core/types'
import { appLog } from './app-log'
import { canonicalProfileUrlKey } from '@core/linkedin-url'
import {
  assertHomogeneousQueueKinds,
  DEFAULT_EXECUTION_ID,
  getExecutionById,
  resolveExecutionIdForRow,
  sourceConnectionExecutionForLogEntry
} from '@core/executions'
import { fillTemplate, validateMessageBody } from '@core/message-compose'
import { sendCommand, bridgeEvents, isExtensionConnected, type BridgeResultMsg } from './bridge'
import { upsertSequenceTarget, advanceStage } from './sequence-state'
import { composeMessageDetailed, linkedInPeopleSearchUrl } from './llm'
import {
  appendMainLog,
  appendSentToday,
  loadCompletedConnectionInviteProfileKeys,
  loadLogHistory,
  loadRecentConnectionInvites,
  loadSentToday,
  thisWeekConnectionCount,
  todayCount,
  type LoggedStageStatus,
  type LogStatus,
  type OutreachEntryKind,
  type OutreachLogEntry
} from './logger'
import { getFollowupStage, recordFollowupSent } from './followup-state'
import { loadSettings, type AppSettings } from './settings'
import { checkCanAct, incrementUsage } from './api-client'
import { isBackendConfigured } from './service-config'
import { isAuthenticated } from './auth-service'
import { trackOutreachSent } from './telemetry'
import { computeDelay, nextSessionBreakEveryItems } from './apply-queue-policies'

const OUTREACH_DELAY_VARIANCE_PERCENT = 30

// ---------------------------------------------------------------------------
// QueueRunContext — replaces mutable module-level variables
// ---------------------------------------------------------------------------

interface QueueRunContext {
  stopRequested: boolean
  disconnectReason: string | null
  state: QueueState
}


/**
 * Module-level context pointer. Non-null only while a queue run is in
 * progress. The bridge-disconnect handler and exported accessors read from
 * this so that the pipeline stages can mutate a single shared object rather
 * than four separate module-level variables.
 */
let ctx: QueueRunContext | null = null

/** Prevents overlapping runs (IPC + double-click). */
let queueBusy = false

// ---------------------------------------------------------------------------
// Helpers (pure / low-level)
// ---------------------------------------------------------------------------

function sleepMs(min: number, max: number, runCtx?: QueueRunContext): Promise<void> {
  const totalMs = computeDelay(min, max, OUTREACH_DELAY_VARIANCE_PERCENT)
  return new Promise((resolve) => {
    let remaining = totalMs
    const tick = () => {
      if ((runCtx ? runCtx.stopRequested : ctx?.stopRequested) || remaining <= 0) {
        resolve()
        return
      }
      const slice = Math.min(remaining, 1000)
      remaining -= slice
      setTimeout(tick, slice)
    }
    tick()
  })
}

async function retryDomAction(
  action: string,
  payload: Record<string, unknown>,
  maxAttempts = 3,
  pauseMs = 800,
  runCtx?: QueueRunContext
): Promise<BridgeResultMsg> {
  let last: BridgeResultMsg | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (runCtx ? runCtx.stopRequested : ctx?.stopRequested) break
    last = await sendCommand(action, payload, 30_000)
    if (last.ok) return last
    if (attempt < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, pauseMs))
    }
  }
  return last ?? { type: 'result', id: '', ok: false, detail: 'stopped_before_attempt' }
}

// Bridge disconnect handler — reads from the active context (with reconnect grace period)
bridgeEvents.on('disconnected', () => {
  if (!queueBusy || !ctx || ctx.stopRequested) return
  setTimeout(() => {
    if (!queueBusy || !ctx || ctx.stopRequested) return
    if (isExtensionConnected()) return
    ctx.disconnectReason = 'Chrome disconnected mid-run. Reconnect the extension and start again.'
    ctx.stopRequested = true
  }, 8_000)
})

// ---------------------------------------------------------------------------
// Exported accessors (signatures unchanged)
// ---------------------------------------------------------------------------

export function isQueueBusy(): boolean {
  return queueBusy
}

export function getQueueState(): QueueState {
  if (ctx) return { ...ctx.state }
  return {
    running: false,
    currentIndex: 0,
    total: 0,
    lastDetail: '',
    lastProfileUrl: '',
    error: null,
    completedAt: null,
    sent: 0, skipped: 0, failed: 0
  }
}

export function requestStop(): void {
  if (ctx) ctx.stopRequested = true
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

type OutreachStageExtra = Partial<Omit<
  OutreachLogEntry,
  'profileUrl' | 'timestamp' | 'status' | 'detail' | 'executionId' | 'logChannel' | 'entryKind'
>>

function makeLogEntry(
  base: { profileUrl: string; executionId: string; logChannel: string; entryKind: OutreachEntryKind },
  status: LogStatus,
  detail: string,
  extra?: Partial<Omit<OutreachLogEntry, 'profileUrl' | 'timestamp' | 'status' | 'detail' | 'executionId' | 'logChannel' | 'entryKind'>>
): OutreachLogEntry {
  return {
    profileUrl: base.profileUrl,
    timestamp: new Date().toISOString(),
    status,
    detail,
    executionId: base.executionId,
    logChannel: base.logChannel,
    entryKind: base.entryKind,
    ...extra
  }
}

function stageLogStatus(status: LoggedStageStatus): LogStatus {
  if (status === 'failed') return 'error'
  if (status === 'blocked' || status === 'skipped') return 'skipped'
  return 'info'
}

function appendOutreachStage(
  base: { profileUrl: string; executionId: string; logChannel: string; entryKind: OutreachEntryKind },
  stage: { code: string; label: string; status?: LoggedStageStatus; detail?: string },
  extra?: OutreachStageExtra
): void {
  const stageStatus = stage.status || 'completed'
  appendMainLog(
    makeLogEntry(base, stageLogStatus(stageStatus), stage.detail || stage.code, {
      ...extra,
      eventType: 'outreach_stage',
      summary: stage.label,
      stageCode: stage.code,
      stageLabel: stage.label,
      stageStatus
    })
  )
}

function isEmailRequiredConnectDetail(detail: string | undefined): boolean {
  return String(detail || '').trim() === 'email_required_to_connect'
}

function stopReason(runCtx: QueueRunContext): string {
  return runCtx.disconnectReason || 'Stopped by user'
}

function appendInterruptionStage(
  runCtx: QueueRunContext,
  base: { profileUrl: string; executionId: string; logChannel: string; entryKind: OutreachEntryKind },
  label: string,
  extra?: OutreachStageExtra
): void {
  appendOutreachStage(base, {
    code: 'run_interrupted',
    label,
    status: 'blocked',
    detail: stopReason(runCtx)
  }, extra)
}

function emailRequiredWarning(): string {
  return "LinkedIn requires this person's email address before it can send the invite."
}

async function skipBecauseEmailRequired(
  runCtx: QueueRunContext,
  ciBase: { profileUrl: string; executionId: string; logChannel: string; entryKind: 'connection_invite' },
  extra: { name?: string; company?: string; variant?: string; message?: string },
  settings: AppSettings,
  onTick?: () => void
): Promise<void> {
  appendOutreachStage(ciBase, {
    code: 'email_required_to_connect',
    label: 'Blocked: LinkedIn requires an email address to connect',
    status: 'blocked',
    detail: 'email_required_to_connect'
  }, extra)
  appendMainLog(makeLogEntry(ciBase, 'skipped', 'email_required_to_connect', extra))
  runCtx.state.lastDetail = emailRequiredWarning()
  onTick?.()
  await sendCommand('DISMISS_MODAL', {}).catch(() => {})
  await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function randomIntInclusive(min: number, max: number): number {
  const lo = Math.max(1, Math.round(Math.min(min, max)))
  const hi = Math.max(lo, Math.round(Math.max(min, max)))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function namesLikelyMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const na = a
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  const nb = b
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  if (na === nb) return true
  const fa = na.split(' ')[0]
  const fb = nb.split(' ')[0]
  return fa.length > 1 && fa === fb && (na.includes(fb) || nb.includes(fa))
}

function companyTokens(value: string | undefined): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !['llc', 'inc', 'ltd', 'lp', 'co', 'corp'].includes(token))
}

function companyLikelyMatch(a: string | undefined, b: string | undefined): boolean {
  const left = companyTokens(a)
  const right = companyTokens(b)
  if (left.length === 0 || right.length === 0) return false
  const rightSet = new Set(right)
  const overlap = left.filter((token) => rightSet.has(token)).length
  return overlap >= Math.max(1, Math.min(left.length, right.length) / 2)
}

function rowSearchQuery(row: TargetRow): string {
  return (
    String(row.searchQuery || '').trim() ||
    [row.personName, row.company].map((value) => String(value || '').trim()).filter(Boolean).join(' ').trim()
  )
}

type SearchResultRow = {
  profileUrl: string
  displayName?: string
  firstName?: string
  company?: string
  headline?: string
}

function chooseBestSearchResult(row: TargetRow, items: SearchResultRow[]): SearchResultRow | null {
  if (items.length === 0) return null
  const wantedName = String(row.personName || row.firstName || '').trim()
  const wantedCompany = String(row.company || '').trim()
  const scored = items
    .map((item) => {
      let nameScore = 0
      let companyScore = 0
      if (namesLikelyMatch(wantedName, item.displayName || item.firstName)) nameScore = 8
      else if (
        row.firstName &&
        String(item.displayName || item.firstName || '')
          .toLowerCase()
          .includes(row.firstName.toLowerCase())
      ) {
        nameScore = 3
      }
      if (companyLikelyMatch(wantedCompany, item.company || item.headline)) companyScore = 5
      return { item, score: nameScore + companyScore, nameScore, companyScore }
    })
    .sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best) return null
  if (wantedName && wantedCompany) {
    if (best.companyScore >= 5 && best.nameScore >= 3) return best.item
    if (best.nameScore >= 8 && items.length === 1) return best.item
    return null
  }
  if (wantedName) {
    if (best.nameScore >= 8 && items.length === 1) return best.item
    return null
  }
  if (wantedCompany) return null
  return null
}

async function extractSearchMatches(scrollPasses = 2): Promise<SearchResultRow[]> {
  const results = await sendCommand('EXTRACT_SEARCH_RESULTS', { scrollPasses }, 45_000)
  if (!results.ok) throw new Error(results.detail || 'search_results_failed')
  const rawItems = Array.isArray((results.data as { items?: unknown[] } | undefined)?.items)
    ? ((results.data as { items?: unknown[] }).items as Record<string, unknown>[])
    : []
  return rawItems
    .map((item) => ({
      profileUrl: String(item.profileUrl || '').trim(),
      displayName: typeof item.displayName === 'string' ? item.displayName.trim() : undefined,
      firstName: typeof item.firstName === 'string' ? item.firstName.trim() : undefined,
      company: typeof item.company === 'string' ? item.company.trim() : undefined,
      headline: typeof item.headline === 'string' ? item.headline.trim() : undefined
    }))
    .filter((item) => canonicalProfileUrlKey(item.profileUrl))
}

function buildManualMessage(
  messageOverride: string | undefined,
  row: TargetRow,
  facts: ProfileFacts,
  mustInclude: string[]
): { ok: true; body: string; variant: string } | { ok: false; detail: string } {
  const template = String(messageOverride || '').trim()
  if (!template) return { ok: false, detail: 'empty_manual_override' }
  const body = fillTemplate(template, row, facts).trim()
  if (!body) return { ok: false, detail: 'empty_manual_override' }
  const validation = validateMessageBody(body, mustInclude, 300)
  if (!validation.ok) return { ok: false, detail: validation.detail }
  return { ok: true, body, variant: 'manual_override' }
}

// ---------------------------------------------------------------------------
// Stage 1: resolveProfile
// ---------------------------------------------------------------------------

type LogBase = { profileUrl: string; executionId: string; logChannel: string; entryKind: OutreachEntryKind }

interface ResolveProfileResult {
  resolved: true
  row: TargetRow
  rowKey: string | null
}

/**
 * Resolve a LinkedIn profile for a target row. If the row already has a valid
 * profileUrl, returns immediately. Otherwise searches LinkedIn and picks the
 * best match.
 *
 * Returns `null` when resolution fails (logged + state updated internally).
 */
async function resolveProfile(
  runCtx: QueueRunContext,
  row: TargetRow,
  settings: AppSettings,
  initialBase: LogBase,
  onTick?: () => void
): Promise<ResolveProfileResult | null> {
  const existingKey = canonicalProfileUrlKey(row.profileUrl)
  if (existingKey) {
    return { resolved: true, row, rowKey: existingKey }
  }

  try {
    runCtx.state.lastDetail = 'Finding profile on LinkedIn'
    onTick?.()
    appendOutreachStage(initialBase, {
      code: 'resolve_profile',
      label: 'Started LinkedIn profile lookup',
      status: 'started',
      detail: 'resolve_profile'
    }, { name: row.personName || row.firstName, company: row.company })

    const attemptQueries = [rowSearchQuery(row)]
    const personOnly = String(row.personName || row.firstName || '').trim()
    if (personOnly && personOnly.toLowerCase() !== attemptQueries[0].toLowerCase()) {
      attemptQueries.push(personOnly)
    }

    let resolved: TargetRow | null = null
    for (const query of attemptQueries) {
      await sendCommand('NAVIGATE', { url: linkedInPeopleSearchUrl(query) }, 45_000)
      await sleepMs(3, 5, runCtx)
      const items = await extractSearchMatches(2)
      const match = chooseBestSearchResult(row, items)
      if (!match) continue
      resolved = {
        ...row,
        profileUrl: match.profileUrl,
        personName: row.personName || match.displayName,
        firstName: row.firstName || match.firstName || match.displayName?.split(/\s+/)[0],
        company: row.company || match.company,
        headline: row.headline || match.headline
      }
      break
    }

    if (!resolved) {
      appendOutreachStage(initialBase, {
        code: 'resolve_profile',
        label: 'Could not match a LinkedIn profile',
        status: 'blocked',
        detail: 'profile_search_no_match'
      }, { name: row.personName || row.firstName, company: row.company })
      appendMainLog(makeLogEntry(
        { profileUrl: row.profileUrl || row.searchQuery || row.personName || '', executionId: initialBase.executionId, logChannel: initialBase.logChannel, entryKind: 'connection_invite' },
        'skipped', 'profile_search_no_match',
        { name: row.personName || row.firstName, company: row.company }
      ))
      runCtx.state.lastDetail = 'Could not find a matching LinkedIn profile'
      onTick?.()
      await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
      return null
    }

    runCtx.state.lastProfileUrl = resolved.profileUrl
    appendOutreachStage(
      { profileUrl: resolved.profileUrl, executionId: initialBase.executionId, logChannel: initialBase.logChannel, entryKind: 'connection_invite' },
      {
        code: 'resolve_profile',
        label: 'Resolved LinkedIn profile',
        detail: 'profile_resolved'
      },
      { name: resolved.personName || resolved.firstName, company: resolved.company }
    )
    return { resolved: true, row: resolved, rowKey: canonicalProfileUrlKey(resolved.profileUrl) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    appendOutreachStage(initialBase, {
      code: 'resolve_profile',
      label: 'Profile lookup failed',
      status: 'failed',
      detail: `profile_search:${msg}`
    }, { name: row.personName || row.firstName, company: row.company })
    appendMainLog(makeLogEntry(
      { profileUrl: row.profileUrl || row.searchQuery || row.personName || '', executionId: initialBase.executionId, logChannel: initialBase.logChannel, entryKind: 'connection_invite' },
      'error', `profile_search:${msg}`,
      { name: row.personName || row.firstName, company: row.company }
    ))
    runCtx.state.lastDetail = `Profile search failed: ${msg}`
    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
    return null
  }
}

// ---------------------------------------------------------------------------
// Stage 2: composeOutreachMessage
// ---------------------------------------------------------------------------

interface ComposeResult {
  body: string
  variant: string
}

/**
 * Compose an outreach message for a target. Tries the manual override first,
 * then falls back to LLM-based composition.
 *
 * Returns `null` when the manual override is invalid (logged internally).
 * The `'skip'` signal means the caller should `continue` to the next target.
 */
async function composeOutreachMessage(
  runCtx: QueueRunContext,
  row: TargetRow,
  facts: ProfileFacts,
  settings: AppSettings,
  execId: string,
  messageOverride: string | undefined,
  ciBase: LogBase,
  onTick?: () => void
): Promise<ComposeResult | 'skip'> {
  const manualMessage = buildManualMessage(messageOverride, row, facts, settings.mustInclude)
  if (messageOverride && !manualMessage.ok) {
    appendOutreachStage(ciBase, {
      code: 'compose_message',
      label: 'Custom message override is invalid',
      status: 'failed',
      detail: `override:${manualMessage.detail}`
    }, { name: facts.firstName, company: facts.company, variant: 'manual_override' })
    appendMainLog(makeLogEntry(ciBase, 'error', `override:${manualMessage.detail}`, { name: facts.firstName, company: facts.company, variant: 'manual_override' }))
    runCtx.state.lastDetail = 'Custom message is invalid for this target'
    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
    return 'skip'
  }

  const composed = manualMessage.ok
    ? { body: manualMessage.body, variant: manualMessage.variant }
    : await composeMessageDetailed(settings, row, facts, { executionId: execId })
  const { body: message, variant } = composed
  appendOutreachStage(ciBase, {
    code: 'compose_message',
    label: 'Composed connection message',
    detail: 'message_ready'
  }, { name: facts.firstName, company: facts.company, variant, message })

  return { body: message, variant }
}

// ---------------------------------------------------------------------------
// Stage 3: sendConnectionInvite
// ---------------------------------------------------------------------------

type SendInviteOutcome = 'continue' | 'break'

interface SendConnectionInviteArgs {
  runCtx: QueueRunContext
  row: TargetRow
  facts: ProfileFacts
  settings: AppSettings
  message: string
  variant: string
  ciBase: LogBase & { entryKind: 'connection_invite' }
  rowKey: string | null
  completedInviteKeys: Set<string>
  sentTodayKeys: Set<string>
  sentSinceBreak: number
  nextBreakAfter: number | null
  targetIndex: number
  totalTargets: number
  useCredit?: boolean
  onTick?: () => void
}

interface SendConnectionInviteResult {
  outcome: SendInviteOutcome
  finalDetail: string
  sentSinceBreak: number
  nextBreakAfter: number | null
}

/**
 * Execute the connection invite flow: navigate to connect, add note, type
 * message, send, verify pending. Handles all email-required, toast-error,
 * and already-connected edge cases.
 */
async function sendConnectionInvite(args: SendConnectionInviteArgs): Promise<SendConnectionInviteResult> {
  const {
    runCtx, row, facts, settings, message, variant, ciBase,
    rowKey, completedInviteKeys, sentTodayKeys, onTick,
    targetIndex, totalTargets, useCredit
  } = args
  let { sentSinceBreak, nextBreakAfter } = args
  let finalDetail = 'ok'

  let tryConnect = await sendCommand('CLICK_CONNECT_2ND', {})
  if (!tryConnect.ok && tryConnect.detail === 'no_direct_connect_link') {
    tryConnect = await sendCommand('CLICK_CONNECT_3RD', {})
  }
  const connectDetail = String(tryConnect.detail)
  if (!tryConnect.ok && (connectDetail.includes('pending') || connectDetail.includes('message_btn'))) {
    if (rowKey) completedInviteKeys.add(rowKey)
    appendOutreachStage(ciBase, {
      code: 'open_connect',
      label: 'Connect was unavailable because you are already connected or pending',
      status: 'blocked',
      detail: tryConnect.detail
    }, { name: facts.firstName, company: facts.company, variant, message })
    appendMainLog(makeLogEntry(ciBase, 'already_connected', tryConnect.detail, { name: facts.firstName, company: facts.company, variant, message }))
    onTick?.()
    return { outcome: 'continue', finalDetail: tryConnect.detail || 'already_connected', sentSinceBreak, nextBreakAfter }
  }

  if (!tryConnect.ok) {
    appendOutreachStage(ciBase, {
      code: 'open_connect',
      label: 'Could not open the LinkedIn connect dialog',
      status: 'blocked',
      detail: tryConnect.detail || 'connect_not_available'
    }, { name: facts.firstName, company: facts.company, variant, message })
    appendMainLog(makeLogEntry(ciBase, 'skipped', tryConnect.detail || 'connect_not_available', { name: facts.firstName, company: facts.company, variant, message }))
    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
    return { outcome: 'continue', finalDetail: tryConnect.detail || 'connect_not_available', sentSinceBreak, nextBreakAfter }
  }
  appendOutreachStage(ciBase, {
    code: 'open_connect',
    label: 'Opened the LinkedIn connect dialog',
    detail: 'connect_dialog_open'
  }, { name: facts.firstName, company: facts.company, variant, message })

  await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

  const addNote = await retryDomAction('CLICK_ADD_NOTE', {}, 3, 1000, runCtx)
  let sentWithoutNote = false
  if (!addNote.ok) {
    if (isEmailRequiredConnectDetail(addNote.detail)) {
      await skipBecauseEmailRequired(
        runCtx,
        ciBase,
        { name: facts.firstName, company: facts.company, variant, message },
        settings,
        onTick
      )
      return { outcome: 'continue', finalDetail: emailRequiredWarning(), sentSinceBreak, nextBreakAfter }
    }
    const sendWithout = await retryDomAction('CLICK_SEND', {}, 2, 600, runCtx)
    if (isEmailRequiredConnectDetail(sendWithout.detail)) {
      await skipBecauseEmailRequired(
        runCtx,
        ciBase,
        { name: facts.firstName, company: facts.company, variant, message },
        settings,
        onTick
      )
      return { outcome: 'continue', finalDetail: emailRequiredWarning(), sentSinceBreak, nextBreakAfter }
    }
    if (sendWithout.ok) {
      appendOutreachStage(ciBase, {
        code: 'send_without_note',
        label: 'Sent the invite without a note',
        detail: 'sent_without_note'
      }, { name: facts.firstName, company: facts.company, variant: 'no_note' })
      sentWithoutNote = true
    } else {
      appendOutreachStage(ciBase, {
        code: 'open_note',
        label: 'Could not open the note editor',
        status: 'blocked',
        detail: `add_note:${addNote.detail}`
      }, { name: facts.firstName, company: facts.company, variant, message })
      appendMainLog(makeLogEntry(ciBase, 'skipped', `add_note:${addNote.detail}`, { name: facts.firstName, company: facts.company, variant, message }))
      onTick?.()
      await sendCommand('DISMISS_MODAL', {}).catch(() => {})
      await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
      return { outcome: 'continue', finalDetail: `add_note:${addNote.detail}`, sentSinceBreak, nextBreakAfter }
    }
  } else {
    appendOutreachStage(ciBase, {
      code: 'open_note',
      label: 'Opened the note editor',
      detail: 'note_editor_open'
    }, { name: facts.firstName, company: facts.company, variant, message })
  }

  if (sentWithoutNote) {
    await sleepMs(2, 4, runCtx)
    const toast = await sendCommand('CHECK_ERROR_TOAST', {})
    if (!toast.ok && String(toast.detail).startsWith('error_toast:')) {
      appendOutreachStage(ciBase, {
        code: 'send_without_note',
        label: 'LinkedIn blocked the invite without a note',
        status: 'blocked',
        detail: toast.detail
      }, { name: facts.firstName, company: facts.company, variant, message: '' })
      appendMainLog(makeLogEntry(ciBase, 'rate_limited', toast.detail, { name: facts.firstName, company: facts.company, variant, message: '' }))
      runCtx.state.lastDetail = toast.detail
      return { outcome: 'break', finalDetail: toast.detail, sentSinceBreak, nextBreakAfter }
    }
    appendSentToday(row.profileUrl)
    trackOutreachSent()
    void incrementUsage('outreach', !!useCredit).catch(() => {})
    if (rowKey) sentTodayKeys.add(rowKey)
    appendMainLog(makeLogEntry(ciBase, 'sent', 'sent_without_note', { name: facts.firstName, company: facts.company, variant: 'no_note', message: '' }))
    runCtx.state.lastDetail = 'sent_without_note'
    runCtx.state.lastProfileUrl = row.profileUrl
    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
    return { outcome: 'continue', finalDetail: 'sent_without_note', sentSinceBreak, nextBreakAfter }
  }

  await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

  const typed = await retryDomAction('TYPE_NOTE', {
    text: message,
    charMin: 40,
    charMax: 140
  }, 2, 600, runCtx)
  if (!typed.ok) {
    if (isEmailRequiredConnectDetail(typed.detail)) {
      await skipBecauseEmailRequired(
        runCtx,
        ciBase,
        { name: facts.firstName, company: facts.company, variant, message },
        settings,
        onTick
      )
      return { outcome: 'continue', finalDetail: emailRequiredWarning(), sentSinceBreak, nextBreakAfter }
    }
    appendOutreachStage(ciBase, {
      code: 'type_note',
      label: 'Could not type the connection note',
      status: 'failed',
      detail: `type:${typed.detail}`
    }, { name: facts.firstName, company: facts.company, variant, message })
    appendMainLog(makeLogEntry(ciBase, 'error', `type:${typed.detail}`, { name: facts.firstName, company: facts.company, variant, message }))
    onTick?.()
    await sendCommand('DISMISS_MODAL', {}).catch(() => {})
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
    return { outcome: 'continue', finalDetail: `type:${typed.detail}`, sentSinceBreak, nextBreakAfter }
  }
  appendOutreachStage(ciBase, {
    code: 'type_note',
    label: 'Typed the connection note',
    detail: 'note_typed'
  }, { name: facts.firstName, company: facts.company, variant, message })

  await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

  const sendRes = await retryDomAction('CLICK_SEND', {}, 2, 600, runCtx)
  await sleepMs(2, 4, runCtx)
  finalDetail = sendRes.detail || 'ok'

  const toast = await sendCommand('CHECK_ERROR_TOAST', {})
  if (!toast.ok && String(toast.detail).startsWith('error_toast:')) {
    appendOutreachStage(ciBase, {
      code: 'send_invite',
      label: 'LinkedIn blocked the invite after clicking Send',
      status: 'blocked',
      detail: toast.detail
    }, { name: facts.firstName, company: facts.company, variant, message })
    appendMainLog(makeLogEntry(ciBase, 'rate_limited', toast.detail, { name: facts.firstName, company: facts.company, variant, message }))
    runCtx.state.lastDetail = toast.detail
    return { outcome: 'break', finalDetail: toast.detail, sentSinceBreak, nextBreakAfter }
  }

  const ciExtra = { name: facts.firstName, company: facts.company, variant, message }
  if (!sendRes.ok) {
    if (isEmailRequiredConnectDetail(sendRes.detail)) {
      await skipBecauseEmailRequired(runCtx, ciBase, ciExtra, settings, onTick)
      return { outcome: 'continue', finalDetail: emailRequiredWarning(), sentSinceBreak, nextBreakAfter }
    }
    appendOutreachStage(ciBase, {
      code: 'send_invite',
      label: 'Could not click Send on the invite',
      status: 'failed',
      detail: `send:${sendRes.detail}`
    }, ciExtra)
    appendMainLog(makeLogEntry(ciBase, 'error', `send:${sendRes.detail}`, ciExtra))
  } else {
    appendOutreachStage(ciBase, {
      code: 'send_invite',
      label: 'Clicked Send on the invite',
      detail: 'invite_send_clicked'
    }, ciExtra)
    const verify = await sendCommand('VERIFY_PENDING', {})
    if (!verify.ok) {
      appendOutreachStage(ciBase, {
        code: 'verify_pending',
        label: 'Could not verify the pending invitation state',
        status: 'failed',
        detail: `verify:${verify.detail}`
      }, ciExtra)
      appendMainLog(makeLogEntry(ciBase, 'error', `verify:${verify.detail}`, ciExtra))
      finalDetail = `verify:${verify.detail}`
      await sendCommand('DISMISS_MODAL', {}).catch(() => {})
    } else {
      appendOutreachStage(ciBase, {
        code: 'verify_pending',
        label: 'Verified the pending invitation state',
        detail: verify.detail || 'pending_visible'
      }, ciExtra)
      appendSentToday(row.profileUrl)
      trackOutreachSent()
      void incrementUsage('outreach', !!useCredit).catch(() => {})
      if (rowKey) {
        sentTodayKeys.add(rowKey)
        completedInviteKeys.add(rowKey)
      }
      upsertSequenceTarget(row.profileUrl, {
        firstName: facts.firstName,
        company: facts.company,
        stage: 'invited'
      })
      advanceStage(row.profileUrl, 'invited')
      finalDetail = verify.detail || sendRes.detail || 'pending_visible'
      appendMainLog(makeLogEntry(ciBase, 'sent', finalDetail, ciExtra))
      sentSinceBreak += 1

      if (
        !runCtx.stopRequested &&
        nextBreakAfter != null &&
        sentSinceBreak >= nextBreakAfter &&
        targetIndex < totalTargets - 1
      ) {
        const breakMinutes = randomIntInclusive(
          settings.sessionBreakDurationMin,
          settings.sessionBreakDurationMax
        )
        runCtx.state.lastDetail = `Session break: pausing for ${breakMinutes} minute${breakMinutes === 1 ? '' : 's'}`
        onTick?.()
        await sleepMs(breakMinutes * 60, breakMinutes * 60, runCtx)
        sentSinceBreak = 0
        nextBreakAfter = nextSessionBreakEveryItems(settings)
        if (!runCtx.stopRequested) {
          runCtx.state.lastDetail = 'Resuming after session break'
          onTick?.()
        }
      }
    }
  }

  return { outcome: 'continue', finalDetail, sentSinceBreak, nextBreakAfter }
}

// ---------------------------------------------------------------------------
// Stage 4: sendFollowUpDm (the full follow-up batch)
// ---------------------------------------------------------------------------

async function sendFollowUpDm(
  runCtx: QueueRunContext,
  settings: AppSettings,
  onTick?: () => void,
  messageOverride?: string
): Promise<void> {
  const execDef = getExecutionById(settings.lastExecutionId) ?? getExecutionById(DEFAULT_EXECUTION_ID)!
  const execId = execDef.id
  const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/'
  const followupBatchBase = {
    profileUrl: CONNECTIONS_URL,
    executionId: execId,
    logChannel: execDef.logChannel,
    entryKind: 'followup_dm' as const
  }
  let interruptionContext: { base: typeof followupBatchBase; extra?: OutreachStageExtra } = {
    base: followupBatchBase
  }

  let pending = loadRecentConnectionInvites(600).filter((e) => getFollowupStage(e.profileUrl) < 1)

  if (pending.length === 0) {
    appendOutreachStage(followupBatchBase, {
      code: 'load_pending_followups',
      label: 'No accepted connections are waiting for follow-up',
      status: 'skipped',
      detail: 'no_pending_connection_invites'
    })
    runCtx.state.lastDetail = 'No pending connection invites in log (or all already nudged).'
    onTick?.()
    return
  }

  const maxSends = Math.min(settings.dailyCap, pending.length, 40)
  runCtx.state.total = maxSends
  runCtx.state.currentIndex = 0

  await sendCommand('NAVIGATE', { url: CONNECTIONS_URL })
  await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

  let sent = 0
  let noMatchRounds = 0
  while (sent < maxSends && !runCtx.stopRequested) {
    const exRes = await sendCommand('EXTRACT_CONNECTIONS', { scrollPasses: 3 })
    const items = (exRes.data as { items?: Array<{ profileUrl: string; displayName: string; path?: string }> })
      ?.items

    if (!exRes.ok || !items?.length) {
      runCtx.state.lastDetail = exRes.detail || 'extract_connections_failed'
      appendOutreachStage(followupBatchBase, {
        code: 'scan_connections',
        label: 'Could not load accepted connections from LinkedIn',
        status: 'failed',
        detail: runCtx.state.lastDetail
      })
      appendMainLog(makeLogEntry(followupBatchBase, 'skipped', runCtx.state.lastDetail))
      break
    }

    const match = pending.find((p) => {
      const pp = canonicalProfileUrlKey(p.profileUrl)
      return items.some((c) => {
        const cp = canonicalProfileUrlKey(c.profileUrl)
        if (pp && cp && pp === cp) return true
        return namesLikelyMatch(p.name, c.displayName)
      })
    })

    if (!match) {
      noMatchRounds++
      if (noMatchRounds >= 6) {
        runCtx.state.lastDetail =
          'Stopping: no log match on Connections after several attempts. Open Connections and verify recent accepts match your log.'
        appendOutreachStage(followupBatchBase, {
          code: 'match_recent_accept',
          label: 'Stopped after repeated Connections scans found no matching accepted connection',
          status: 'blocked',
          detail: 'no_log_match_after_retries'
        })
        break
      }
      runCtx.state.lastDetail = 'No log match on current Connections view — scroll loaded or try again later.'
      appendOutreachStage(followupBatchBase, {
        code: 'match_recent_accept',
        label: 'No matching accepted connection appeared in the current Connections view',
        status: 'blocked',
        detail: 'no_log_match_current_view'
      })
      onTick?.()
      await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
      continue
    }

    noMatchRounds = 0

    runCtx.state.lastProfileUrl = match.profileUrl
    runCtx.state.currentIndex = sent + 1

    const row: TargetRow = {
      profileUrl: match.profileUrl,
      firstName: match.name?.split(/\s+/).find(t => t.length > 0),
      company: match.company
    }
    const sourceExecution = sourceConnectionExecutionForLogEntry(match)
    const followUpComposeExecutionId = sourceExecution?.id || execId
    const facts: ProfileFacts = {
      firstName: row.firstName,
      company: row.company,
      headline: ''
    }
    const fuBase = { profileUrl: match.profileUrl, executionId: execId, logChannel: execDef.logChannel, entryKind: 'followup_dm' as const }
    interruptionContext = {
      base: fuBase,
      extra: { name: match.name, company: match.company }
    }

    if (todayCount() >= settings.dailyCap) {
      runCtx.state.lastDetail = 'Daily cap reached'
      appendOutreachStage(fuBase, {
        code: 'daily_cap_check',
        label: 'Stopped follow-up because the daily cap was reached',
        status: 'blocked',
        detail: 'daily_cap'
      }, { name: match.name, company: match.company })
      appendMainLog(makeLogEntry(fuBase, 'skipped', 'daily_cap', {
        name: match.name,
        company: match.company
      }))
      break
    }

    appendOutreachStage(fuBase, {
      code: 'match_recent_accept',
      label: 'Matched a recent accepted connection',
      detail: 'matched_recent_accept'
    }, { name: match.name, company: match.company })

    const msgPack = await composeMessageDetailed(settings, row, facts, {
      executionId: followUpComposeExecutionId,
      forFollowUp: true
    })
    const manualMessage = buildManualMessage(messageOverride, row, facts, settings.mustInclude)
    if (messageOverride && !manualMessage.ok) {
      appendOutreachStage(fuBase, {
        code: 'compose_followup',
        label: 'Custom follow-up message override is invalid',
        status: 'failed',
        detail: `override:${manualMessage.detail}`
      }, { name: match.name, company: match.company, variant: 'manual_override' })
      appendMainLog(makeLogEntry(
        { profileUrl: match.profileUrl, executionId: execId, logChannel: execDef.logChannel, entryKind: 'followup_dm' },
        'error',
        `override:${manualMessage.detail}`,
        { name: match.name, company: match.company, variant: 'manual_override' }
      ))
      runCtx.state.lastDetail = 'Custom message is invalid for this target'
      onTick?.()
      pending = pending.filter((p) => p.profileUrl !== match.profileUrl)
      continue
    }
    const message = manualMessage.ok ? manualMessage.body : msgPack.body
    const variant = manualMessage.ok ? manualMessage.variant : msgPack.variant
    interruptionContext = {
      base: fuBase,
      extra: { name: match.name, company: match.company, variant, message }
    }
    appendOutreachStage(fuBase, {
      code: 'compose_followup',
      label: 'Composed follow-up message',
      detail: 'followup_message_ready'
    }, { name: match.name, company: match.company, variant, message })

    const open = await sendCommand('CLICK_MESSAGE_FOR_PROFILE', {
      profileUrl: match.profileUrl,
      displayName: match.name || ''
    })
    if (!open.ok) {
      appendOutreachStage(fuBase, {
        code: 'open_dm',
        label: 'Could not open LinkedIn message composer',
        status: 'blocked',
        detail: `open_dm:${open.detail}`
      }, { name: match.name, company: match.company, variant, message })
      appendMainLog(makeLogEntry(fuBase, 'skipped', `open_dm:${open.detail}`, {
        name: match.name, company: match.company, variant, message,
        sourceExecutionId: sourceExecution?.id, sourceLogChannel: sourceExecution?.logChannel || match.logChannel
      }))
      pending = pending.filter((p) => p.profileUrl !== match.profileUrl)
      onTick?.()
      await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
      continue
    }
    appendOutreachStage(fuBase, {
      code: 'open_dm',
      label: 'Opened LinkedIn message composer',
      detail: 'open_dm'
    }, { name: match.name, company: match.company, variant, message })

    await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

    const typed = await retryDomAction('TYPE_CONVERSATION', {
      text: message,
      charMin: 40,
      charMax: 140
    }, 2, 600, runCtx)
    if (!typed.ok) {
      appendOutreachStage(fuBase, {
        code: 'type_dm',
        label: 'Could not type the follow-up message',
        status: 'failed',
        detail: `type_dm:${typed.detail}`
      }, { name: match.name, company: match.company, variant, message })
      appendMainLog(makeLogEntry(
        { profileUrl: match.profileUrl, executionId: execId, logChannel: execDef.logChannel, entryKind: 'followup_dm' },
        'error', `type_dm:${typed.detail}`,
        { name: match.name, company: match.company, variant, message, sourceExecutionId: sourceExecution?.id, sourceLogChannel: sourceExecution?.logChannel || match.logChannel }
      ))
      await sendCommand('DISMISS_MODAL', {}).catch(() => {})
      break
    }
    appendOutreachStage(fuBase, {
      code: 'type_dm',
      label: 'Typed the follow-up message',
      detail: 'type_dm'
    }, { name: match.name, company: match.company, variant, message })

    await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

    const sendRes = await retryDomAction('CLICK_SEND_CONVERSATION', {}, 2, 600, runCtx)
    const fuDmBase = fuBase
    const fuDmExtra = { name: match.name, company: match.company, variant, message, sourceExecutionId: sourceExecution?.id, sourceLogChannel: sourceExecution?.logChannel || match.logChannel }
    if (!sendRes.ok) {
      appendOutreachStage(fuDmBase, {
        code: 'send_dm',
        label: 'Could not send the follow-up message',
        status: 'failed',
        detail: `send_dm:${sendRes.detail}`
      }, fuDmExtra)
      appendMainLog(makeLogEntry(fuDmBase, 'error', `send_dm:${sendRes.detail}`, fuDmExtra))
    } else {
      appendOutreachStage(fuDmBase, {
        code: 'send_dm',
        label: 'Sent the follow-up message',
        detail: 'send_dm'
      }, fuDmExtra)
      appendSentToday(match.profileUrl, 'followup_dm')
      recordFollowupSent(match.profileUrl, sourceExecution?.id || execId, 1)
      advanceStage(match.profileUrl, 'dm_sent')
      appendMainLog(makeLogEntry(fuDmBase, 'sent', sendRes.detail || 'followup_ok', fuDmExtra))
      sent++
    }

    runCtx.state.lastDetail = sendRes.detail || 'followup_ok'
    pending = pending.filter((p) => p.profileUrl !== match.profileUrl)
    interruptionContext = { base: followupBatchBase }
    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
  }

  if (runCtx.stopRequested) {
    runCtx.state.lastDetail = stopReason(runCtx)
    appendInterruptionStage(
      runCtx,
      interruptionContext.base,
      'Run stopped before the follow-up batch could finish',
      interruptionContext.extra
    )
  }
  onTick?.()
}

// ---------------------------------------------------------------------------
// Stage 5: runQueueBatch — main loop with cap enforcement & session breaks
// ---------------------------------------------------------------------------

async function runQueueBatch(
  runCtx: QueueRunContext,
  targets: TargetRow[],
  settings: AppSettings,
  onTick?: () => void,
  opts?: { dryRun?: boolean; messageOverride?: string }
): Promise<void> {
  const dryRun = !!opts?.dryRun
  const messageOverride = opts?.messageOverride

  const settingsExec = getExecutionById(settings.lastExecutionId) ?? getExecutionById(DEFAULT_EXECUTION_ID)!
  let queueKind = settingsExec.queueKind
  let resolvedPerRow: string[] = []

  if (targets.length === 0) {
    if (settingsExec.queueKind !== 'post_accept_dm') {
      runCtx.state.lastDetail = 'Add a list, or choose Post-accept follow-up (DM) to run without rows.'
      runCtx.state.running = false
      onTick?.()
      return
    }
    queueKind = 'post_accept_dm'
  } else {
    resolvedPerRow = targets.map((t) => resolveExecutionIdForRow(t, settings.lastExecutionId))
    const k = assertHomogeneousQueueKinds(resolvedPerRow)
    if (!k) {
      runCtx.state.error = 'Mixed execution kinds in one run. Use one signal per batch, or clear the execution column.'
      runCtx.state.lastDetail = runCtx.state.error
      runCtx.state.running = false
      onTick?.()
      return
    }
    queueKind = k
  }

  if (queueKind === 'post_accept_dm') {
    await sendFollowUpDm(runCtx, settings, onTick, messageOverride)
    return
  }

  const completedInviteKeys = loadCompletedConnectionInviteProfileKeys()
  const sentTodayKeys = new Set(loadSentToday().urls.map((url) => canonicalProfileUrlKey(url)))
  let sentSinceBreak = 0
  let nextBreakAfter = nextSessionBreakEveryItems(settings)

  for (let i = 0; i < targets.length; i++) {
    const originalRow = targets[i]!
    const execId = resolvedPerRow[i]!
    const ex = getExecutionById(execId) ?? getExecutionById(DEFAULT_EXECUTION_ID)!
    const rowLabel = originalRow.profileUrl || originalRow.searchQuery || originalRow.personName || ''
    const interruptionBase = {
      profileUrl: rowLabel,
      executionId: execId,
      logChannel: ex.logChannel,
      entryKind: 'connection_invite' as const
    }
    if (runCtx.stopRequested) {
      runCtx.state.lastDetail = stopReason(runCtx)
      appendInterruptionStage(
        runCtx,
        interruptionBase,
        'Run stopped before this target could be completed',
        { name: originalRow.personName || originalRow.firstName, company: originalRow.company }
      )
      break
    }

    runCtx.state.currentIndex = i + 1
    runCtx.state.lastProfileUrl = rowLabel
    runCtx.state.lastDetail = dryRun
      ? `Preparing test ${i + 1} of ${targets.length}`
      : `Preparing ${i + 1} of ${targets.length}`
    onTick?.()

    let row = originalRow
    const initialBase = {
      profileUrl: row.profileUrl || row.searchQuery || row.personName || '',
      executionId: execId,
      logChannel: ex.logChannel,
      entryKind: 'connection_invite' as const
    }
    appendOutreachStage(initialBase, {
      code: 'prepare_target',
      label: 'Prepared target for outreach',
      detail: 'prepare_target'
    }, { name: row.personName || row.firstName, company: row.company })

    // --- Stage 1: Resolve profile ---
    let rowKey: string | null = canonicalProfileUrlKey(row.profileUrl)
    if (!rowKey) {
      const profileResult = await resolveProfile(runCtx, row, settings, initialBase, onTick)
      if (!profileResult) continue
      row = profileResult.row
      rowKey = profileResult.rowKey
    }

    if (rowKey && completedInviteKeys.has(rowKey)) {
      runCtx.state.lastDetail = 'Already completed in history'
      appendOutreachStage({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, {
        code: 'history_check',
        label: 'Skipped because this person was already completed in history',
        status: 'skipped',
        detail: 'already_completed_in_log'
      })
      appendMainLog(makeLogEntry({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, 'skipped', 'already_completed_in_log'))
      onTick?.()
      continue
    }

    if (rowKey && sentTodayKeys.has(rowKey)) {
      runCtx.state.lastDetail = 'Already sent in today ledger'
      appendOutreachStage({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, {
        code: 'daily_ledger_check',
        label: 'Skipped because this person was already contacted today',
        status: 'skipped',
        detail: 'already_in_today_ledger'
      })
      appendMainLog(makeLogEntry({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, 'skipped', 'already_in_today_ledger'))
      onTick?.()
      continue
    }

    // Server-side usage check (when backend is configured)
    let shouldUseCredit = false
    if (isBackendConfigured() && isAuthenticated()) {
      const canActResult = await checkCanAct('outreach')
      if (canActResult.ok && !canActResult.data.allowed) {
        runCtx.state.lastDetail = canActResult.data.reason || 'Daily outreach limit reached (server-enforced)'
        break
      }
      if (canActResult.ok && canActResult.data.useCredit) {
        shouldUseCredit = true
      }
    }

    if (todayCount() >= settings.dailyCap) {
      runCtx.state.lastDetail = 'Daily cap reached'
      appendOutreachStage({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, {
        code: 'daily_cap_check',
        label: 'Stopped because the daily cap was reached',
        status: 'blocked',
        detail: 'daily_cap'
      }, { name: row.firstName, company: row.company })
      appendMainLog(makeLogEntry({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, 'skipped', 'daily_cap'))
      break
    }

    if (thisWeekConnectionCount() >= settings.weeklyConnectionCap) {
      runCtx.state.lastDetail = 'Weekly connection cap reached'
      appendOutreachStage({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, {
        code: 'weekly_cap_check',
        label: 'Stopped because the weekly connection cap was reached',
        status: 'blocked',
        detail: 'weekly_cap'
      }, { name: row.firstName, company: row.company })
      appendMainLog(makeLogEntry({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, 'skipped', 'weekly_cap'))
      break
    }

    try {
      if (dryRun) {
        const facts: ProfileFacts = { firstName: row.firstName, company: row.company, headline: row.headline }
        const ciBase = { profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' as const }
        const manualMessage = buildManualMessage(messageOverride, row, facts, settings.mustInclude)
        if (messageOverride && !manualMessage.ok) {
          appendOutreachStage(ciBase, {
            code: 'compose_message',
            label: 'Custom message override is invalid',
            status: 'failed',
            detail: `override:${manualMessage.detail}`
          }, { name: facts.firstName, company: facts.company, variant: 'manual_override' })
          appendMainLog(makeLogEntry(ciBase, 'error', `override:${manualMessage.detail}`, { name: facts.firstName, company: facts.company, variant: 'manual_override' }))
          runCtx.state.lastDetail = 'Custom message is invalid for this target'
          onTick?.()
          continue
        }
        const composed = manualMessage.ok
          ? { body: manualMessage.body, variant: manualMessage.variant }
          : await composeMessageDetailed(settings, row, facts, { executionId: execId })
        const { body: message, variant } = composed
        appendOutreachStage(ciBase, {
          code: 'compose_message',
          label: 'Composed test message preview',
          detail: 'dry_run_message_ready'
        }, { name: facts.firstName, company: facts.company, variant, message })
        appendMainLog(makeLogEntry(ciBase, 'dry_run' as LogStatus, 'dry_run_preview', { name: facts.firstName, company: facts.company, variant, message }))
        runCtx.state.lastDetail = `[dry run] Would send to ${facts.firstName || row.profileUrl}`
        runCtx.state.lastProfileUrl = row.profileUrl
        onTick?.()
        await sleepMs(0.3, 0.5, runCtx)
        continue
      }

      // --- Stage: Navigate + extract profile ---
      await sendCommand('NAVIGATE', { url: row.profileUrl })
      await sleepMs(settings.delayBetweenActionsMin, settings.delayBetweenActionsMax, runCtx)

      const exr = await sendCommand('EXTRACT_PROFILE', {})
      const facts = (exr.data || {}) as ProfileFacts
      const ciBase = { profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' as const }
      appendOutreachStage(ciBase, {
        code: 'load_profile',
        label: 'Loaded LinkedIn profile',
        detail: 'profile_loaded'
      }, { name: facts.firstName || row.firstName, company: facts.company || row.company })
      if (exr.detail?.includes('rate') || exr.detail?.toLowerCase().includes('limit')) {
        appendOutreachStage(ciBase, {
          code: 'load_profile',
          label: 'LinkedIn rate-limited the profile load',
          status: 'blocked',
          detail: exr.detail
        }, { name: facts.firstName, company: facts.company })
        appendMainLog(makeLogEntry(ciBase, 'rate_limited', exr.detail, { name: facts.firstName, company: facts.company }))
        runCtx.state.lastDetail = exr.detail
        break
      }

      // --- Stage 2: Compose message ---
      const composeResult = await composeOutreachMessage(runCtx, row, facts, settings, execId, messageOverride, ciBase, onTick)
      if (composeResult === 'skip') continue
      const { body: message, variant } = composeResult

      // --- Stage 3: Send connection invite ---
      const inviteResult = await sendConnectionInvite({
        runCtx, row, facts, settings, message, variant, ciBase, rowKey,
        completedInviteKeys, sentTodayKeys,
        sentSinceBreak, nextBreakAfter,
        targetIndex: i, totalTargets: targets.length,
        useCredit: shouldUseCredit,
        onTick
      })
      sentSinceBreak = inviteResult.sentSinceBreak
      nextBreakAfter = inviteResult.nextBreakAfter
      runCtx.state.lastDetail = inviteResult.finalDetail

      if (inviteResult.outcome === 'break') break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      runCtx.state.error = msg
      appendMainLog(makeLogEntry({ profileUrl: row.profileUrl, executionId: execId, logChannel: ex.logChannel, entryKind: 'connection_invite' }, 'error', msg))
      runCtx.state.lastDetail = msg
      if (msg.includes('not connected')) break
    }

    onTick?.()
    await sleepMs(settings.delayBetweenRequestsMin, settings.delayBetweenRequestsMax, runCtx)
  }
}

// ---------------------------------------------------------------------------
// runQueue — thin orchestrator (exported, signature unchanged)
// ---------------------------------------------------------------------------

export async function runQueue(
  targets: TargetRow[],
  onTick?: () => void,
  opts?: { dryRun?: boolean; messageOverride?: string }
): Promise<void> {
  const dryRun = !!opts?.dryRun
  const messageOverride = String(opts?.messageOverride || '').trim() || undefined
  if (queueBusy) return

  try {
    const { isApplyQueueRunnerBusy } = require('./apply-queue-runner') as { isApplyQueueRunnerBusy: () => boolean }
    if (isApplyQueueRunnerBusy()) throw new Error('Apply queue is running. Wait for it to finish, then try again.')
  } catch (e) {
    if (e instanceof Error && e.message.includes('Apply queue')) throw e
  }

  // Bridge connectivity guard — fail fast instead of silently erroring on every target
  if (!opts?.dryRun && !isExtensionConnected()) {
    throw new Error('Chrome extension not connected. Open a LinkedIn tab and try again.')
  }

  queueBusy = true
  try {
    const settings = loadSettings()

    const runCtx: QueueRunContext = {
      stopRequested: false,
      disconnectReason: null,
      state: {
        running: true,
        currentIndex: 0,
        total: targets.length,
        lastDetail: dryRun ? 'Starting test run…' : 'Starting run…',
        lastProfileUrl: '',
        error: null,
        completedAt: null
      }
    }
    ctx = runCtx
    onTick?.()

    try {
      await runQueueBatch(runCtx, targets, settings, onTick, { dryRun, messageOverride })
    } finally {
      runCtx.state.running = false
      runCtx.state.completedAt = new Date().toISOString()
      // Compute final sent/skipped/failed from the log entries written during this run
      try {
        const recentLogs = loadLogHistory().slice(-(targets.length * 8))
        let sent = 0, sk = 0, fl = 0
        for (const l of recentLogs) {
          const le = l as unknown as Record<string, unknown>
          if (le.entryKind !== 'connection_invite' && le.entryKind !== 'followup_dm') continue
          const code = String(le.code || '').toLowerCase()
          if (code === 'outcome') {
            const s = String(le.status || '').toLowerCase()
            if (['sent', 'success', 'ok', 'connected', 'delivered', 'sent_without_note', 'dry_run_sent'].includes(s)) sent++
            else if (['skipped', 'skip', 'duplicate', 'already_sent', 'already_connected', 'dry_run', 'no_profile'].includes(s)) sk++
            else if (['error', 'failed', 'failure', 'rate_limited'].includes(s)) fl++
          } else {
            const s = String(le.status || '').toLowerCase()
            if (['sent', 'sent_without_note', 'dry_run_sent'].includes(s) && !le.code) sent++
            else if (s === 'skipped' && !le.code) sk++
            else if ((s === 'error' || s === 'failed') && !le.code) fl++
          }
        }
        runCtx.state.sent = sent
        runCtx.state.skipped = sk
        runCtx.state.failed = fl
      } catch (e) { appLog.debug('[queue] summary count failed', e instanceof Error ? e.message : String(e)) }
      onTick?.()
    }
  } finally {
    queueBusy = false
  }
}
