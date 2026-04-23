


BUG & DEFECT REPORT:
*******************

----------------------------------------------------------------------------------------------------------------------------------
Critical
----------------------------------------------------------------------------------------------------------------------------------

1. Unsafe type cast loses application record ID
File: apply-queue-runner.ts ~line 591
A cast to { applicationRecordId?: string } on a queue item can silently return undefined if the item shape doesn't match. The recordId passed to updateApplicationRecord() becomes undefined, so the hiring team metadata is never saved to history.
Impact: Submitted applications missing data in history panel.

2. Whitespace-only display name sets firstName to empty string
File: queue.ts ~line 929
match.name?.split(/\s+/)[0] on a whitespace-only string (" ") produces ["", ""] and [0] returns "" — an empty string, not undefined. Downstream checks like if (firstName) pass silently, composing messages with blank first name instead of the "there" fallback.
Impact: Outreach messages sent as "Hi , I wanted to reach out..."

3. Race condition between result processing and queue modification
File: apply-queue-runner.ts ~lines 591–593
Between the find() call that locates a queue item and the subsequent updateApplicationRecord() call, the user can remove or retry the item. The found recordId becomes orphaned and metadata is written to the wrong history record.
Impact: Application history records get mismatched data after user interaction mid-run.


----------------------------------------------------------------------------------------------------------------------------------
High
----------------------------------------------------------------------------------------------------------------------------------

4. 'dry_run' cast bypasses LogStatus type contract
File: queue.ts ~line 1289
'dry_run' as LogStatus compiles but 'dry_run' may not be in the union. Log filtering and telemetry that branch on LogStatus will not recognise dry-run entries, skewing statistics.
Impact: Outreach stats are inaccurate in dry-run mode.

5. Rate-limit detection skipped when detail is undefined
File: queue.ts ~lines 1301–1319
If EXTRACT_PROFILE returns ok: false with no detail, the ?.includes('rate') check produces undefined (falsy) and the queue-pause logic is skipped. Queue continues sending requests while LinkedIn is actively rate-limiting.
Impact: Account ban risk — queue doesn't pause on LinkedIn rate limits.

6. Corrupt follow-up state file passes typeof === 'object' check
File: followup-state.ts ~lines 32–37
null and arrays both satisfy typeof x === 'object'. If the JSON file is malformed (e.g., byProfileKey is an array), the check passes and the array is used as a record object, corrupting all follow-up tracking.
Impact: Follow-up sequences silently break for all contacts.

7. upsertSequenceTarget accepts invalid stage values
File: sequence-state.ts ~lines 68–72
partial.stage is assigned directly without validating against STAGE_ORDER. While advanceStage() validates transitions, direct upserts can set an invalid stage, causing isValidTransition() to fail unexpectedly on every subsequent operation.
Impact: Contact sequence stages get stuck and never advance.


----------------------------------------------------------------------------------------------------------------------------------
Medium
----------------------------------------------------------------------------------------------------------------------------------

5. Server usage counter silently drifts on network failure
File: apply-queue-runner.ts ~line 735
void incrementUsage('apply').catch(warn) fires and forgets. If the network call fails, the server counter doesn't increment while the local counter does. Quota enforcement diverges from actual usage.
Impact: Plan limits are not accurately enforced; users may exceed their quota.

6. Daily cap silently clamped to weekly cap
File: settings.ts ~lines 346–348
If user sets dailyCap=50 and weeklyConnectionCap=30, clampDailyCap() silently reduces daily to 30 on save with no UI warning. The settings panel may show 50 while the actual effective cap is 30.
Impact: User confusion — apply queue stops earlier than expected with no explanation.

7. Profile extraction failure produces empty ProfileFacts
File: queue.ts ~lines 1301–1318
If EXTRACT_PROFILE returns ok: false, exr.data is undefined. Casting undefined as ProfileFacts succeeds silently. Message composition proceeds with an empty facts object — no name, no company, no role.
Impact: AI-composed outreach messages lose all personalisation, sent with blank template variables.

8. Corrupt stuckFieldLabels array can exhaust memory
File: apply-queue-store.ts ~line 78
No size limit on stuckFieldLabels.map(...).filter(...). A malformed history file with a huge array will block the main process and potentially crash the app on startup.
Impact: App becomes unresponsive or crashes when loading application history.


----------------------------------------------------------------------------------------------------------------------------------
Low
----------------------------------------------------------------------------------------------------------------------------------

9. Inconsistent detail truncation across log calls
File: apply-queue-runner.ts ~lines 385, 456
Some log calls slice detail to 320 chars, others write the full string. Long error messages bloat the log file inconsistently.

10. JSON messages from extension not fully validated
File: bridge.ts ~lines 131–140
JSON.parse(raw) as Record<string, unknown> then field-by-field checks. Unknown/extra fields are silently ignored. Protocol mismatches between extension and main process versions are invisible.

11. Non-atomic duplicate check in sent-today ledger
File: logger.ts ~lines 158–165
The includes() check and push() are not atomic. Concurrent sends (rare but possible) can produce duplicate entries, causing daily send counts to be miscounted.

12. Hardcoded bridge auth and heartbeat timeouts
File: bridge.ts ~lines 81, 106
BRIDGE_AUTH_TIMEOUT_MS = 5_000 and heartbeat at 30_000ms are hardcoded. On slow networks or VPNs, the 5-second auth timeout fires before the handshake completes, forcing the user to manually reconnect.


----------------------------------------------------------------------------------------------------------------------------------
Summary
----------------------------------------------------------------------------------------------------------------------------------

***************************
Severity  Count Primary Risk
***************************
Critical	3	    Silently lost application data, wrong message personalisation
High	    4   	Account ban risk, broken follow-up sequences
Medium	  4	    Quota drift, user confusion, app crash on load
Low	      4	    Log bloat, protocol brittleness
***************************
Total	  15	
***************************


The most urgent fixes are:
#2 (blank first name in messages)
#5 (rate-limit bypass)
#7 (empty profile facts sent to Claude) as they affect visible output on every run.

----------------------------------------------------------------------------------------------------------------------------------
END OF TEH REPORT
----------------------------------------------------------------------------------------------------------------------------------

