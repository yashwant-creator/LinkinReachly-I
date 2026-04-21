import {
  detailSuggestsEasyApplyUnavailable,
  detailSuggestsLinkedInChallenge,
  detailSuggestsUnconfirmedEasyApply
} from '@core/apply-queue-heuristics'
import type { ApplyQueueState, ApplicationOutcome, ApplicationRecordInput } from '@core/application-types'
import { bridgeEvents, isExtensionConnected, sendCommand } from './bridge'
import {
  appendApplicationRecord,
  loadApplicationHistory,
  todayApplicationCount,
  updateApplicationRecord
} from './application-history-store'
import { appLog } from './app-log'
import { loadQueue, saveQueue, setQueueRunning, updateItemStatus } from './apply-queue-store'
import { loadSettings } from './settings'
import { EXTENSION_RELOAD_QUEUE_HINT } from '@core/extension-version'
import type { EasyApplyResult } from './application-assistant'
// verifyNeedsReviewRecords & autoRunPostApplyOutreach are no longer auto-triggered from the runner.
// Both hijack the LinkedIn tab (navigating to job/profile pages) without user awareness.
// Keep the import commented so the functions remain available for future user-initiated flows.
// import { verifyNeedsReviewRecords, autoRunPostApplyOutreach } from './apply-queue-helpers'
import { buildApplyQueueRunSummary } from './apply-queue-run-summary'
import {
  computeDelay,
  isDailyCapReached,
  nextSessionBreakEveryItems,
  shouldTakeSessionBreak
} from './apply-queue-policies'
import { isQueueBusy } from './queue'
import { loadApplicantProfile } from './applicant-profile-store'
import { checkCanAct, incrementUsage } from './api-client'
import { isBackendConfigured } from './service-config'
import { isAuthenticated, getPlanState } from './auth-service'
import { trackApplicationSent, trackApplicationFailed, trackQueueStarted, trackQueueCompleted, trackError } from './telemetry'
export type { PostApplyOutreachCandidate } from './apply-queue-helpers'


/** Test-only override: swap in a fake handleEasyApply without importing application-assistant. */
type HandleEasyApplyFn = (payload: unknown, onProgress?: (phase: string) => void) => Promise<EasyApplyResult>
let _handleEasyApplyOverride: HandleEasyApplyFn | null = null
function setHandleEasyApplyForTest(fn: HandleEasyApplyFn | null): void { _handleEasyApplyOverride = fn }

function qlog(event: string, fields: Record<string, unknown> = {}): void {
  appLog.info(`[apply-queue] ${event}`, { at: new Date().toISOString(), ...fields })
}

function queueStatusCounts(items: ApplyQueueState['items']): Record<string, number> {
  const c: Record<string, number> = { pending: 0, active: 0, done: 0, error: 0, skipped: 0 }
  for (const i of items) {
    c[i.status] = (c[i.status] ?? 0) + 1
  }
  return c
}

function safeUrlHost(url: string): string | null {
  try {
    return new URL(String(url || '').trim()).hostname
  } catch (e) {
    appLog.debug('[apply-queue-runner] safeUrlHost parse failed', e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Between-job pacing: session break vs inter-item cooldown (apply-queue-runner.ts:pauseBetweenQueueJobs). */
async function pauseBetweenQueueJobs(
  settings: ReturnType<typeof loadSettings>,
  consecutiveForBreak: number,
  itemsUntilBreak: number | null
): Promise<[number, number | null]> {
  if (shouldTakeSessionBreak(consecutiveForBreak, itemsUntilBreak)) {
    const durMin = settings.sessionBreakDurationMin
    const durMax = settings.sessionBreakDurationMax
    qlog('delay.session_break', { durMinMinutes: durMin, durMaxMinutes: durMax })
    const breakDelayMs = computeDelay(
      durMin * 60,
      durMax * 60,
      30
    )
    const cur2 = loadQueue()
    saveQueue({
      ...cur2,
      lastDetail: `Short break \u2014 back in ${durMin}\u2013${durMax} min. ${consecutiveForBreak} jobs done this batch.`,
      cooldownEndsAt: Date.now() + breakDelayMs
    })
    emit()
    await interruptibleSleep(breakDelayMs)
    return [0, nextSessionBreakEveryItems(settings)]
  }
  const applyDelayMin = settings.delayBetweenRequestsMin
  const applyDelayMax = settings.delayBetweenRequestsMax
  qlog('delay.inter_item', { minSec: applyDelayMin, maxSec: applyDelayMax })
  const itemDelayMs = computeDelay(applyDelayMin, applyDelayMax, 30)
  const cur = loadQueue()
  saveQueue({
    ...cur,
    lastDetail: `Up next in ~1 min`,
    cooldownEndsAt: Date.now() + itemDelayMs
  })
  emit()
  await interruptibleSleep(itemDelayMs)
  return [consecutiveForBreak, itemsUntilBreak]
}

let stopRequested = false
let running = false
let stopResolvers: Array<() => void> = []

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let wrappedResolve: (() => void) | null = null
    const timer = setTimeout(() => {
      stopResolvers = stopResolvers.filter((r) => r !== wrappedResolve)
      resolve()
    }, ms)
    wrappedResolve = () => {
      clearTimeout(timer)
      stopResolvers = stopResolvers.filter((r) => r !== wrappedResolve)
      resolve()
    }
    stopResolvers.push(wrappedResolve)
  })
}
let notifyTick: ((state: ApplyQueueState) => void) | null = null
let bridgeDisconnectListener: (() => void) | null = null

function emit(): void {
  notifyTick?.(loadQueue())
}

export function notifyApplyQueueTick(): void {
  emit()
}

let BRIDGE_RECONNECT_GRACE_MS = 8_000
/** @internal test-only */
export function setBridgeReconnectGraceMs(ms: number): void { BRIDGE_RECONNECT_GRACE_MS = ms }

let bridgeGraceTimer: ReturnType<typeof setTimeout> | null = null

function bindBridgeDisconnectListener(): void {
  if (bridgeDisconnectListener) return
  bridgeDisconnectListener = () => {
    if (!running || stopRequested) return
    if (bridgeGraceTimer) return
    qlog('queue.bridge_blip', { hint: 'bridge disconnected, waiting for reconnect', graceMs: BRIDGE_RECONNECT_GRACE_MS })
    bridgeGraceTimer = setTimeout(() => {
      bridgeGraceTimer = null
      if (!running || stopRequested) return
      if (isExtensionConnected()) {
        qlog('queue.bridge_recovered', { hint: 'bridge reconnected within grace period' })
        return
      }
      stopRequested = true
      for (const resolve of stopResolvers) resolve()
      stopResolvers = []
      qlog('queue.stop', { reason: 'bridge_disconnected' })
      const cur = loadQueue()
      saveQueue({
        ...cur,
        running: false,
        lastErrorCode: 'bridge_disconnected',
        lastError:
          'Chrome extension lost connection. Make sure LinkedIn is open in Chrome, then click "Start applying" to resume.'
      })
      emit()
    }, BRIDGE_RECONNECT_GRACE_MS)
  }
  bridgeEvents.on('disconnected', bridgeDisconnectListener)
}

function unbindBridgeDisconnectListener(): void {
  if (!bridgeDisconnectListener) return
  bridgeEvents.removeListener('disconnected', bridgeDisconnectListener)
  bridgeDisconnectListener = null
}


export function configureApplyQueueNotifier(fn: (state: ApplyQueueState) => void): void {
  notifyTick = fn
}

// IMPORTANT: Stop is IMMEDIATE — sets flag + interrupts all sleeps.
// The loop exits at the next checkpoint, not after the entire job.
// Frontend label MUST say "Stopping…" (never "after this job").
export function stopApplyQueueRunner(): void {
  stopRequested = true
  for (const resolve of stopResolvers) resolve()
  stopResolvers = []
}

export function isApplyQueueRunnerBusy(): boolean {
  return running
}

let screeningCacheSizeBefore = 0

async function runLoop(): Promise<void> {
  let settings = loadSettings()
  let processedThisSession = 0
  let itemsUntilBreak = nextSessionBreakEveryItems(settings)
  let consecutiveForBreak = 0

  try {
    screeningCacheSizeBefore = Object.keys(loadApplicantProfile().screeningAnswerCache || {}).length
  } catch (e) {
    appLog.debug(
      '[apply-queue-runner] screening cache size before run failed',
      e instanceof Error ? e.message : String(e)
    )
    screeningCacheSizeBefore = 0
  }

  const planLimit = getPlanState().dailyApplyLimit
  const rawCap = settings.applyDailyCap ?? settings.dailyCap
  const effectiveApplyCapForDay = Number.isFinite(rawCap) && Number.isFinite(planLimit)
    ? Math.min(rawCap, planLimit)
    : Number.isFinite(rawCap) ? rawCap : Number.isFinite(planLimit) ? planLimit : 10

  const MAX_LOOP_ITERATIONS = 500
  const MAX_CONSECUTIVE_FAILURES = 6
  let consecutiveFailures = 0
  let recoveryAttempted = false
  let loopIteration = 0
  while (!stopRequested && loopIteration++ < MAX_LOOP_ITERATIONS) {
    const settings = loadSettings()
    const state = loadQueue()
    const pending = state.items.find((i) => i.status === 'pending')
    const counts = queueStatusCounts(state.items)
    if (loopIteration % 5 === 0) {
      qlog('loop.tick', {
        stopRequested,
        counts,
        nextPendingId: pending?.id ?? null,
        nextPendingSurface: pending?.surface ?? null,
        nextJob: pending ? `${pending.jobTitle} @ ${pending.company}` : null,
        queueRunning: state.running
      })
    }
    if (!pending) {
      qlog('loop.exit', { reason: 'no_pending_items', counts })
      break
    }

    // Server-side usage check (when backend is configured)
    let shouldUseCredit = false
    if (isBackendConfigured() && isAuthenticated()) {
      const canActResult = await checkCanAct('apply')
      if (canActResult.ok && !canActResult.data.allowed) {
        qlog('loop.exit', {
          reason: 'server_daily_limit',
          detail: canActResult.data.reason,
          counts
        })
        const cur = loadQueue()
        saveQueue({
          ...cur,
          running: false,
          lastErrorCode: 'daily_cap',
          lastError: canActResult.data.reason || 'Daily apply limit reached (server-enforced).'
        })
        emit()
        break
      }
      if (canActResult.ok && canActResult.data.useCredit) {
        shouldUseCredit = true
      }
    }

    const todayApplied = Math.max(todayApplicationCount(), processedThisSession)
    if (isDailyCapReached(todayApplied, effectiveApplyCapForDay)) {
      qlog('loop.exit', {
        reason: 'daily_cap',
        todayApplied,
        cap: effectiveApplyCapForDay,
        configuredCap: effectiveApplyCapForDay,
        counts
      })
      const cur = loadQueue()
      saveQueue({
        ...cur,
        running: false,
        lastErrorCode: 'daily_cap',
        lastError: 'Reached the maximum number of applications for this session (daily cap).'
      })
      emit()
      break
    }

    updateItemStatus(pending.id, 'active')
    qlog('item.active', {
      itemId: pending.id,
      surface: pending.surface,
      jobTitle: pending.jobTitle,
      company: pending.company,
      applyHost: safeUrlHost(pending.applyUrl || pending.linkedinJobUrl)
    })
    emit()

    const surfaceRaw = String((pending as { surface?: string }).surface || 'linkedin_easy_apply')

    const baseInput: ApplicationRecordInput = {
      company: pending.company,
      title: pending.jobTitle,
      location: pending.location || undefined,
      jobUrl: pending.linkedinJobUrl || pending.applyUrl,
      easyApply: surfaceRaw === 'linkedin_easy_apply',
      source: surfaceRaw === 'linkedin_easy_apply' ? 'linkedin_easy_apply' : 'manual',
      outcome: 'opened',
      descriptionSnippet: pending.descriptionSnippet,
      reasonSnippet: pending.reasonSnippet
    }

    let itemNeedsReview = false
    try {
      if (surfaceRaw !== 'linkedin_easy_apply') {
        qlog('queue.unsupported_surface', { itemId: pending.id, surface: surfaceRaw })
        const rec = appendApplicationRecord({
          ...baseInput,
          outcome: 'failed',
          detail: 'external_apply_unsupported'
        })
        updateItemStatus(pending.id, 'error', {
          applicationRecordId: rec.id,
          detail: 'External apply is not supported. Use Easy Apply jobs only.',
          processedAt: new Date().toISOString()
        })
        emit()
      } else {
        // Pre-apply browsing: ~25% of the time, browse a couple of other job listings
        // before navigating to the target job. Simulates a human scanning multiple
        // listings in search results before deciding which one to apply to.
        // Skipped when delays are 0 (test mode).
        const humanizationEnabled = settings.delayBetweenRequestsMin > 0
        if (!stopRequested && humanizationEnabled && Math.random() < 0.25) {
          try {
            const preApplyListings = 1 + Math.floor(Math.random() * 2) // 1-2 detour listings
            qlog('pre_apply.browse_listings', { itemId: pending.id, detourCount: preApplyListings })
            const cur6 = loadQueue()
            saveQueue({ ...cur6, lastDetail: 'Browsing listings...', cooldownEndsAt: undefined })
            emit()
            for (let detour = 0; detour < preApplyListings && !stopRequested; detour++) {
              // Scroll around search results
              await sendCommand('SCROLL_PAGE', { amount: 200 + Math.random() * 400, direction: 'down' }, 5_000)
              await interruptibleSleep(2000 + Math.random() * 3000)
              // Scroll back
              await sendCommand('SCROLL_PAGE', { amount: 100 + Math.random() * 200, direction: 'up' }, 5_000)
              await interruptibleSleep(1500 + Math.random() * 2500)
            }
          } catch (err) {
            appLog.info('[apply-queue] Pre-apply browse failed (non-fatal)', { itemId: pending.id, error: err instanceof Error ? err.message : String(err) })
          }
        }

        const handleEasyApply = _handleEasyApplyOverride || (await import('./application-assistant')).handleEasyApply
        // Prefer linkedinJobUrl over applyUrl when applyUrl points to a search/listing page
        // (e.g. /jobs/search/) instead of a specific job view (/jobs/view/{id}/).
        const effectiveJobUrl = (pending.applyUrl && /\/jobs\/view\/\d+/.test(pending.applyUrl))
          ? pending.applyUrl
          : pending.linkedinJobUrl || pending.applyUrl
        qlog('easy_apply.start', {
          itemId: pending.id,
          jobUrl: effectiveJobUrl,
          jobTitle: pending.jobTitle,
          company: pending.company
        })
        const result: EasyApplyResult = await handleEasyApply({
          jobUrl: effectiveJobUrl,
          jobTitle: pending.jobTitle,
          company: pending.company,
          location: pending.location,
          descriptionSnippet: pending.descriptionSnippet,
          reasonSnippet: pending.reasonSnippet
        }, (phase) => {
          const cur3 = loadQueue()
          saveQueue({ ...cur3, lastDetail: phase, cooldownEndsAt: undefined })
          emit()
        }, () => stopRequested)
        qlog('easy_apply.finish', {
          itemId: pending.id,
          ok: result.ok,
          phase: result.phase,
          blockReason: result.blockReason,
          recordId: result.recordId,
          detailPreview: String(result.detail || '').slice(0, 320)
        })

        const resultDetail = String(result.detail || '')
        const normalizedDetailForCompare = (v: string): string =>
          String(v || '')
            .replace(/\bsessionId=\d+\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
        const ensureTerminalRecordId = (
          detail: string,
          outcome: Extract<ApplicationOutcome, 'failed' | 'blocked'>
        ): string => {
          const normalizedDetail = String(detail || '').slice(0, 300)
          if (result.recordId) {
            const updated = updateApplicationRecord(result.recordId, {
              outcome,
              detail: normalizedDetail
            })
            if (updated) return updated.id
            qlog('history.missing_record_for_result', {
              itemId: pending.id,
              resultRecordId: result.recordId
            })
          }

          // Secondary fallback: if a near-identical `needs_review` record for this job exists
          // (e.g., legacy runs that didn't return recordId), upgrade it instead of appending.
          const jobUrl = String(baseInput.jobUrl || '').trim()
          if (jobUrl) {
            const targetDetail = normalizedDetailForCompare(normalizedDetail)
            const recentMatch = loadApplicationHistory().find((r) => {
              if (r.outcome !== 'needs_review') return false
              if (String(r.jobUrl || '').trim() !== jobUrl) return false
              const existingDetail = normalizedDetailForCompare(String(r.detail || ''))
              if (!existingDetail || !targetDetail) return false
              return existingDetail === targetDetail || existingDetail.startsWith(targetDetail)
            })
            if (recentMatch) {
              const upgraded = updateApplicationRecord(recentMatch.id, {
                outcome,
                detail: normalizedDetail
              })
              if (upgraded) return upgraded.id
            }
          }

          const rec = appendApplicationRecord({
            ...baseInput,
            outcome,
            detail: normalizedDetail
          })
          return rec.id
        }

        const extensionStaleStop =
          result.blockReason === 'extension_stale' ||
          (result.phase === 'preflight' &&
            /extension outdated|chrome:\/\/extensions/i.test(String(result.detail || '')))

        if (extensionStaleStop) {
          qlog('queue.stop', { reason: 'extension_stale', itemId: pending.id })
          const rec = appendApplicationRecord({
            ...baseInput,
            outcome: 'failed',
            detail: 'extension_stale',
            reasonSnippet: 'extension_stale'
          })
          updateItemStatus(pending.id, 'error', {
            applicationRecordId: rec.id,
            detail: result.detail,
            processedAt: new Date().toISOString()
          })
          emit()
          stopRequested = true
          const cur = loadQueue()
          saveQueue({
            ...cur,
            running: false,
            lastErrorCode: 'extension_stale',
            lastError: EXTENSION_RELOAD_QUEUE_HINT
          })
          emit()
          break
        }

        // Review-before-submit: pause queue for user review
        const isPausedForReview = !result.ok && result.phase === 'review'
        if (isPausedForReview) {
          qlog('queue.paused_for_review', { itemId: pending.id, jobTitle: pending.jobTitle })
          updateItemStatus(pending.id, 'error', {
            detail: result.detail || 'Paused for review. Check Chrome and retry.',
            processedAt: new Date().toISOString()
          })
          const cur = loadQueue()
          saveQueue({
            ...cur,
            running: false,
            lastErrorCode: 'paused_for_review',
            lastError: `"${pending.jobTitle}" is open for review in Chrome. Resume when ready.`
          })
          emit()
          break
        }

        // Non-Easy-Apply jobs: skip instead of erroring
        const notEasyApply = !result.ok && /easy_apply_not_available_for_job/i.test(resultDetail)
        if (notEasyApply) {
          qlog('queue.skip_not_easy_apply', { itemId: pending.id, jobTitle: pending.jobTitle })
          const recId = ensureTerminalRecordId('Job does not offer Easy Apply — external application only.', 'blocked')
          updateItemStatus(pending.id, 'skipped', {
            applicationRecordId: recId,
            detail: 'Not Easy Apply — skipped.',
            processedAt: new Date().toISOString()
          })
          emit()

        // Easy Apply unavailable (button not found, form didn't open, listing removed): auto-skip
        } else if (!result.ok && detailSuggestsEasyApplyUnavailable(resultDetail)) {
          qlog('queue.skip_ea_unavailable', { itemId: pending.id, jobTitle: pending.jobTitle, detail: resultDetail.slice(0, 120) })
          const recId = ensureTerminalRecordId(resultDetail || 'Easy Apply not available — auto-skipped.', 'blocked')
          updateItemStatus(pending.id, 'skipped', {
            applicationRecordId: recId,
            detail: 'Easy Apply not available — auto-skipped.',
            processedAt: new Date().toISOString()
          })
          emit()

        // Closed/expired jobs: skip instead of erroring — retrying won't help
        } else if (!result.ok && /job_closed_no_longer_accepting/i.test(resultDetail)) {
          qlog('queue.skip_job_closed', { itemId: pending.id, jobTitle: pending.jobTitle })
          const recId = ensureTerminalRecordId('Job is no longer accepting applications.', 'blocked')
          updateItemStatus(pending.id, 'skipped', {
            applicationRecordId: recId,
            detail: 'This position is no longer accepting applications.',
            processedAt: new Date().toISOString()
          })
          emit()
        } else if (result.recordId) {
          const needsReview = !result.ok && detailSuggestsUnconfirmedEasyApply(result.detail)
          itemNeedsReview = needsReview
          updateItemStatus(pending.id, result.ok ? 'done' : needsReview ? 'error' : 'skipped', {
            applicationRecordId: result.recordId,
            detail: result.detail,
            processedAt: new Date().toISOString(),
            stuckFieldLabels: needsReview ? result.stuckFieldLabels : undefined
          })
          if (needsReview) {
            qlog('queue.skipping_needs_info', { itemId: pending.id, jobTitle: pending.jobTitle, stuckFields: result.stuckFieldLabels })
          }
        } else {
          const needsReview = !result.ok && detailSuggestsUnconfirmedEasyApply(result.detail)
          itemNeedsReview = needsReview
          const rec = appendApplicationRecord({
            ...baseInput,
            outcome: result.ok ? 'submitted' : needsReview ? 'needs_review' : 'failed',
            detail: result.detail,
            stuckFieldLabels: needsReview ? result.stuckFieldLabels : undefined
          })
          updateItemStatus(pending.id, result.ok ? 'done' : needsReview ? 'error' : 'skipped', {
            applicationRecordId: rec.id,
            detail: result.detail,
            processedAt: new Date().toISOString(),
            stuckFieldLabels: needsReview ? result.stuckFieldLabels : undefined
          })
          if (needsReview) {
            qlog('queue.skipping_needs_info', { itemId: pending.id, jobTitle: pending.jobTitle, stuckFields: result.stuckFieldLabels })
          }
        }
        emit()

        if (!result.ok && detailSuggestsLinkedInChallenge(result.detail)) {
          qlog('queue.stop', { reason: 'verification_required', itemId: pending.id })
          const cur = loadQueue()
          saveQueue({
            ...cur,
            lastErrorCode: 'verification_required',
            lastError: 'LinkedIn is asking for verification. Go to Chrome, complete the CAPTCHA, then click "Retry / resume" here.'
          })
          emit()
          break
        }

        const statusAfterResult = loadQueue().items.find((i) => i.id === pending.id)?.status
        const wasAutoSkipped = statusAfterResult === 'skipped'
        const hardFail = !result.ok && result.phase !== 'submit' && !itemNeedsReview && !wasAutoSkipped
        if (hardFail) {
          consecutiveFailures++
          const cur = loadQueue()
          saveQueue({
            ...cur,
            lastErrorCode: 'easy_apply_failed',
            lastError: result.detail
          })
          emit()
        } else if (result.ok) {
          consecutiveFailures = 0
          // Capture recordId now, before any subsequent awaits, to avoid a race where
          // the user removes or retries the queue item during the async EXTRACT_JOB_DETAILS call.
          const hiringTeamRecordId = result.recordId || loadQueue().items.find(i => i.id === pending.id)?.applicationRecordId
          // Post-apply: extract hiring team from the job page for outreach eligibility.
          // After successful Easy Apply, the job page is still loaded behind the confirmation overlay.
          try {
            const jobDetails = await sendCommand('EXTRACT_JOB_DETAILS', {}, 10_000)
            const data = jobDetails.data as Record<string, unknown> | undefined
            const team = data?.hiringTeam as Array<{ name: string; title?: string; profileUrl?: string }> | undefined
            const filtered = team?.filter((m) => m.name?.length >= 2 && m.profileUrl?.includes('/in/')).slice(0, 5)
            if (filtered?.length) {
              if (hiringTeamRecordId) {
                updateApplicationRecord(hiringTeamRecordId, { hiringTeam: filtered })
                qlog('hiring_team.captured', { itemId: pending.id, count: filtered.length, company: pending.company })
              }
            } else {
              qlog('hiring_team.not_found', { itemId: pending.id, company: pending.company, extractOk: !!jobDetails?.ok, teamRaw: team?.length ?? 0 })
            }
          } catch (err) {
            appLog.info('[apply-queue] Could not extract hiring team post-apply', { itemId: pending.id, error: err instanceof Error ? err.message : String(err) })
          }

          // Post-apply human behavior: company page detour OR browse job search.
          // 61% of job seekers visit the company website (HR Dive).
          // We simulate this ~30% of the time to look natural without being too slow.
          if (!stopRequested && humanizationEnabled) {
            const doCompanyDetour = Math.random() < 0.30 && pending.company
            try {
              if (doCompanyDetour) {
                // Visit the company's LinkedIn page for 30-90s
                const companySlug = String(pending.company || '').toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)
                const companyUrl = `https://www.linkedin.com/company/${companySlug}/`
                const detourDurationMs = 30000 + Math.random() * 60000
                qlog('post_apply.company_detour', {
                  itemId: pending.id,
                  company: pending.company,
                  durationMs: Math.round(detourDurationMs)
                })
                const cur4 = loadQueue()
                saveQueue({ ...cur4, lastDetail: `Checking out ${pending.company}...`, cooldownEndsAt: undefined })
                emit()
                const companyNav = await sendCommand('FORCE_NAVIGATE', { url: companyUrl }, 8_000)
                if (companyNav.ok && !stopRequested) {
                  await interruptibleSleep(3000 + Math.random() * 3000)
                  if (!stopRequested) {
                    await sendCommand('BROWSE_AROUND', { durationMs: detourDurationMs }, Math.round(detourDurationMs) + 10_000)
                  }
                }
              }
            } catch (err) {
              appLog.info('[apply-queue] Company detour failed (non-fatal)', { itemId: pending.id, error: err instanceof Error ? err.message : String(err) })
            }

            // Navigate back to job search and browse listings (5–20s)
            try {
              const browseDurationMs = 5000 + Math.random() * 15000
              qlog('post_apply.browse', { itemId: pending.id, durationMs: Math.round(browseDurationMs) })
              const cur5 = loadQueue()
              saveQueue({ ...cur5, lastDetail: 'Browsing job listings...', cooldownEndsAt: undefined })
              emit()
              const navBackResult = await sendCommand('FORCE_NAVIGATE', { url: 'https://www.linkedin.com/jobs/' }, 8_000)
              if (navBackResult.ok && !stopRequested) {
                await interruptibleSleep(2000 + Math.random() * 2000)
                if (!stopRequested) {
                  await sendCommand('BROWSE_AROUND', { durationMs: browseDurationMs }, Math.round(browseDurationMs) + 10_000)
                }
              }
            } catch (err) {
              appLog.info('[apply-queue] Post-apply browse failed (non-fatal)', { itemId: pending.id, error: err instanceof Error ? err.message : String(err) })
            }
          }
        }

        // Circuit breaker: stop after N consecutive failures to avoid bot-like rapid page loads
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // Attempt recovery once before giving up
          if (!recoveryAttempted && !stopRequested) {
            recoveryAttempted = true
            qlog('queue.recovery_attempt', { consecutiveFailures })
            try {
              await sendCommand('FORCE_NAVIGATE', { url: 'https://www.linkedin.com/jobs/' }, 10_000)
              await interruptibleSleep(15_000 + Math.random() * 10_000)
              consecutiveFailures = Math.floor(consecutiveFailures / 2)
              continue
            } catch { /* recovery failed — proceed to stop */ }
          }
          qlog('queue.stop', { reason: 'consecutive_failures', count: consecutiveFailures })
          const cur2 = loadQueue()
          saveQueue({
            ...cur2,
            running: false,
            lastErrorCode: 'consecutive_failures',
            lastError: `${consecutiveFailures} applications hit temporary issues. LinkedIn may be rate-limiting. Wait a few minutes, then click "Retry / resume" to continue.`
          })
          emit()
          break
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isTransient = /modal_not_found|form_extraction_timeout|EXTRACT_FORM_FIELDS.*timeout|empty form|form.*fields.*0/i.test(msg)
      if (!isTransient) consecutiveFailures++
      qlog('item.error', { itemId: pending.id, message: msg.slice(0, 400), consecutiveFailures, transient: isTransient })
      const rec = appendApplicationRecord({
        ...baseInput,
        outcome: 'failed',
        detail: msg
      })
      updateItemStatus(pending.id, 'error', {
        applicationRecordId: rec.id,
        detail: msg,
        processedAt: new Date().toISOString()
      })
      const cur = loadQueue()
      saveQueue({ ...cur, lastError: msg, lastErrorCode: 'runner_error' })
      emit()

      // Page refresh between retries to clear stale DOM state
      if (consecutiveFailures > 0 && consecutiveFailures < MAX_CONSECUTIVE_FAILURES && !stopRequested) {
        try {
          await sendCommand('FORCE_NAVIGATE', { url: 'https://www.linkedin.com/jobs/' }, 8_000)
          await interruptibleSleep(2000 + Math.random() * 1500)
        } catch { /* non-fatal */ }
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Attempt recovery once before giving up
        if (!recoveryAttempted && !stopRequested) {
          recoveryAttempted = true
          qlog('queue.recovery_attempt', { consecutiveFailures })
          try {
            await sendCommand('FORCE_NAVIGATE', { url: 'https://www.linkedin.com/jobs/' }, 10_000)
            await interruptibleSleep(15_000 + Math.random() * 10_000)
            consecutiveFailures = Math.floor(consecutiveFailures / 2)
            continue
          } catch { /* recovery failed — proceed to stop */ }
        }
        qlog('queue.stop', { reason: 'consecutive_failures_exception', count: consecutiveFailures })
        const cur2 = loadQueue()
        saveQueue({
          ...cur2,
          running: false,
          lastErrorCode: 'consecutive_failures',
          lastError: `${consecutiveFailures} applications hit temporary issues. LinkedIn may be rate-limiting. Wait a few minutes, then click "Retry / resume" to continue.`
        })
        emit()
        break
      }
    }

    const finalStatus = loadQueue().items.find((i) => i.id === pending.id)?.status
    if (finalStatus === 'done') {
      trackApplicationSent()
      void incrementUsage('apply', shouldUseCredit).catch((err) => { appLog.warn('[apply-queue] incrementUsage failed — server counter may drift', err instanceof Error ? err.message : String(err)) })
    } else if (finalStatus === 'error') {
      const failedItem = loadQueue().items.find(i => i.id === pending.id)
      const failDetail = failedItem?.detail || ''
      const failErrorType = itemNeedsReview
        ? 'needs_review'
        : detailSuggestsEasyApplyUnavailable(failDetail)
          ? 'button_not_found'
          : /no longer accepting|job_closed/i.test(failDetail)
            ? 'job_closed'
            : /extension.*not connected|bridge_disconnected/i.test(failDetail)
              ? 'bridge_disconnected'
              : /extension.*outdated|extension_stale/i.test(failDetail)
                ? 'extension_stale'
                : /verification|captcha/i.test(failDetail)
                  ? 'verification_required'
                  : 'runner_error'
      trackApplicationFailed(failErrorType, pending.applyUrl, failDetail)
      trackError('apply_failed', failDetail, {
        severity: failErrorType === 'runner_error' ? 'error' : 'warning',
        context: { errorType: failErrorType, jobUrl: pending.applyUrl, company: pending.company, jobTitle: pending.jobTitle },
      })
    }
    // Need-info and skipped items: no real LinkedIn interaction occurred,
    // so don't count toward daily cap or pause timing.
    if (finalStatus === 'skipped' || itemNeedsReview) {
      const cur = loadQueue()
      const detail = itemNeedsReview ? 'Needs info — skipping to next...' : 'Skipping unavailable job — moving to next...'
      saveQueue({ ...cur, lastDetail: detail, cooldownEndsAt: undefined })
      emit()
      await interruptibleSleep(2000 + Math.random() * 2000)
      continue
    }
    processedThisSession++
    consecutiveForBreak++
    const hasPending = loadQueue().items.some((i) => i.status === 'pending')
    if (stopRequested || !hasPending) {
      emit()
      continue
    }

    ;[consecutiveForBreak, itemsUntilBreak] = await pauseBetweenQueueJobs(
      settings,
      consecutiveForBreak,
      itemsUntilBreak
    )

    emit()
  }

  if (loopIteration >= MAX_LOOP_ITERATIONS && !stopRequested) {
    const hasPending = loadQueue().items.some((i) => i.status === 'pending')
    if (hasPending) {
      qlog('queue.stop', { reason: 'max_iterations', iterations: loopIteration })
      const cur = loadQueue()
      saveQueue({
        ...cur,
        running: false,
        lastErrorCode: 'max_iterations',
        lastError: 'Session limit reached. Click "Start applying" to continue with remaining jobs.'
      })
      emit()
    }
  }
}

export function startApplyQueueRunner(): void {
  if (isQueueBusy()) {
    const q = loadQueue()
    saveQueue({
      ...q,
      lastError: 'Connect outreach is running. Wait for it to finish, then try again.',
      lastErrorCode: 'connect_queue_busy'
    })
    emit()
    return
  }

  if (!isExtensionConnected()) {
    const q = loadQueue()
    saveQueue({
      ...q,
      lastError: 'Chrome extension is not connected. Open LinkedIn in Chrome with the extension active, then try again.',
      lastErrorCode: 'bridge_disconnected'
    })
    emit()
    return
  }

  const state = loadQueue()
  const counts = queueStatusCounts(state.items)
  if (running) {
    qlog('start.skipped', { reason: 'already_running', counts })
    return
  }
  if (!state.items.some((i) => i.status === 'pending')) {
    qlog('start.skipped', { reason: 'no_pending_items', counts })
    return
  }

  const pendingCount = state.items.filter((i) => i.status === 'pending').length
  qlog('start', { pending: pendingCount, counts })
  trackQueueStarted(pendingCount)

  stopRequested = false
  running = true
  bindBridgeDisconnectListener()
  setQueueRunning(true, {
    startedAt: new Date().toISOString(),
    lastDetail: 'Preparing queue...',
    cooldownEndsAt: undefined,
    lastError: undefined,
    lastErrorCode: undefined
  })
  emit()

  void runLoop()
    .catch((err) => {
      qlog('runner.crash', {
        message: err instanceof Error ? err.message : String(err)
      })
      appLog.error('[apply-queue] runner error', err)
      const cur = loadQueue()
      saveQueue({
        ...cur,
        lastError: err instanceof Error ? err.message : String(err),
        lastErrorCode: 'runner_error',
        running: false
      })
      emit()
    })
    .finally(() => {
      const cur = loadQueue()
      const counts = queueStatusCounts(cur.items)
      qlog('runner.idle', {
        counts,
        lastErrorCode: cur.lastErrorCode ?? null
      })

      let answersLearned = 0
      try {
        const after = Object.keys(loadApplicantProfile().screeningAnswerCache || {}).length
        answersLearned = Math.max(0, after - screeningCacheSizeBefore)
      } catch (e) {
        appLog.debug(
          '[apply-queue-runner] answers learned count after idle failed',
          e instanceof Error ? e.message : String(e)
        )
        answersLearned = 0
      }
      const lastRunSummary = buildApplyQueueRunSummary(cur, counts, answersLearned)
      trackQueueCompleted(
        counts.done ?? 0,
        counts.error ?? 0,
        counts.skipped ?? 0,
        cur.startedAt ? Date.now() - new Date(cur.startedAt).getTime() : 0
      )
      saveQueue({
        ...cur,
        lastDetail: undefined,
        cooldownEndsAt: undefined,
        lastRunSummary
      })

      setTimeout(() => {
        if (running) return
        const post = loadQueue()
        const keepItems = post.items.filter((i) => i.status !== 'skipped')
        if (keepItems.length < post.items.length) {
          saveQueue({ ...post, items: keepItems })
          emit()
        }
      }, 3000)

      unbindBridgeDisconnectListener()
      running = false
      stopRequested = false
      stopResolvers = []
      setQueueRunning(false, { pausedAt: new Date().toISOString() })
      emit()

      // Post-apply outreach and follow-up are user-initiated only.
      // The user must explicitly click "Reach Out" or "Follow Up" to trigger these.
      // Auto-outreach after apply was removed to prevent sending messages without user action.

      // Auto-verification of needs_review records is DISABLED.
      // verifyNeedsReviewRecords() navigates the LinkedIn tab to each prior job URL,
      // which hijacks the browser away from whatever the user is doing — the user sees
      // LinkedIn cycling through random company pages with no explanation.
      // Verification should be user-initiated only (e.g., a "Verify past applications" button).
      // if (counts.error > 0 || counts.done > 0) { ... }
    })
}
