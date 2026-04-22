
***********************************
LLM Cost Optimization Opportunities
***********************************

-------------------------------------------------------------------------------------------------------------------
1. No Prompt Caching Infrastructure — Biggest Single Opportunity
File: src/main/llm-core.ts — LlmChatMessage type

Anthropic's cache_control: ephemeral feature lets static content (resume, system prompt, sender background) be cached server-side for 5 minutes at ~10% of the original token cost. The codebase has zero support for it.


// Current — no cache_control field
export type LlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// Fix — add optional cache_control
export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  cache_control?: { type: 'ephemeral' }
}
Then mark the resume, system prompt, and sender background as cache_control: ephemeral in each call site. The ~4,000-char resume (≈1,000 tokens) is currently resent on every single application. With caching, call #2 through #N within a 5-minute window pay only 10% of that.

Estimated impact: 40–70% overall token reduction — the most impactful single change.

-------------------------------------------------------------------------------------------------------------------
2. Resume Resent on Every Application — No Validation or Caching
File: src/main/llm-apply.ts line 119


const resume = (resumeText?.trim() || settings.resumeText?.trim() || '').slice(0, 4000)
The full resume (up to 4,000 chars ≈ 1,000 tokens) is sent with every essay/behavioral question call. Two problems:

No length guard — if resume is empty or under 50 chars, the call still fires and returns a useless generic answer
No caching — applying to 10 jobs with behavioral questions in 5 minutes sends the resume 10 times
Quick fix (2 lines): Add a minimum length guard before the LLM call:


if (!resume || resume.length < 50) return null
Full fix: Apply cache_control: ephemeral to the resume block (enabled by fix #1).

Estimated impact: 30–50% reduction on essay/behavioral calls.

-------------------------------------------------------------------------------------------------------------------
3. Binary Yes/No Questions Still Reach the LLM
File: src/main/easy-apply/fill-form.ts lines 446–475

The codebase already has guessBinaryYesNoForScreeningQuestion() with extensive regex patterns that can deterministically answer questions like:

"Will you require visa sponsorship?"
"Are you at least 18?"
"Can you pass a background check?"
However, this heuristic is called after the cache check but the result is not used to short-circuit the LLM call. The LLM is still called for fields the heuristic already answered.

Fix: Run the heuristic as an early-return pass before sending to LLM:


const afterHeuristic = afterCacheUnfilled.filter((f) => {
  const guess = guessBinaryYesNoForScreeningQuestion(f.label, jobTitleHint, profile)
  if (guess) { /* fill field, mark done */ return false }
  return true
})
// Only send afterHeuristic to LLM
~40% of screening questions are deterministic (yes/no, salary, commute, work authorisation).

Estimated impact: 15–25% reduction on form-filling calls.

-------------------------------------------------------------------------------------------------------------------
4. Job Description Truncation Too Generous
File: src/main/llm-jobs.ts lines 161–171


entry.description = j.description.slice(0, 2000)  // 2000 chars ≈ 500 tokens per job
Each job description is truncated to 2,000 characters. Research shows diminishing returns beyond 300–400 characters for scoring fit. In a batch of 15 jobs, the description portion alone is 7,500 tokens — most of which does not improve scoring accuracy.

Fix: Reduce to 600 characters (≈ 150 tokens). The title, role, key requirements, and seniority signal are nearly always in the first paragraph.


entry.description = j.description.slice(0, 600)
Estimated impact: 25–35% reduction on job screening calls.


-------------------------------------------------------------------------------------------------------------------
5. Outreach Sender Background Duplicated on Every Message
File: src/main/llm-compose.ts lines 117–140


.replace(/\{senderBackground\}/g, String(settings.userBackground || '').slice(0, 500))
The sender's background (up to 500 chars ≈ 125 tokens) is injected into the system prompt for every outreach message. When sending 50 connection requests in a session, this identical block is sent 50 times.

Fix: Move userBackground and the goal context into the cached system prompt block once cache_control is enabled (fix #1). Only the per-person variables (firstName, company, headline) need to be in the dynamic user message.

Estimated impact: 15–20% reduction on outreach composition calls.

-------------------------------------------------------------------------------------------------------------------
6. LLM Called for Jobs with No Meaningful Description
File: src/main/llm-jobs.ts line 164


if (j.description && j.description.length > 50) entry.description = j.description.slice(0, 2000)
The guard is > 50 characters — barely enough to skip blank descriptions. A 51-character description like "Great opportunity! Apply now. We're hiring fast." provides zero signal for scoring but still triggers the full LLM pipeline.

Fix: Raise the threshold and check for meaningful content:


if (j.description && j.description.length > 200) entry.description = j.description.slice(0, 600)
Additionally, jobs missing both description and a recognisable title should be scored heuristically (title match only) rather than sent to LLM at all.

Estimated impact: 5–10% reduction on job screening, plus faster queue processing.

-------------------------------------------------------------------------------------------------------------------
7. Oversized Output Structure Requested from LLM
File: src/main/llm-jobs.ts lines 140–160

The scoring prompt asks for titleFit, seniorityMatch, locationFit, companyFit, overall, reason, nextStep, matchedSkills, and missingSkills per job. Callers primarily use overall and reason. The extra dimensions add ~100–150 output tokens per batch call.

Fix: Slim the output schema to what is actually consumed:


// Instead of 9 fields, request 4
{"results": [{"index": number, "overall": 1-10, "reason": "...", "nextStep": "..."}]}
Compute titleFit, locationFit etc. client-side with lightweight string matching if they are needed for UI display.

Estimated impact: 5–10% reduction on output tokens for job screening.

-------------------------------------------------------------------------------------------------------------------
8. Screening Answer Cache Key May Be Too Narrow
File: src/main/easy-apply/fill-form.ts — screening cache lookup

The screeningAnswerCache stores answers keyed by question label. If two companies phrase the same question slightly differently ("Years of experience with React?" vs "How many years of React experience do you have?"), each gets its own LLM call and its own cache entry despite having the same answer.

Fix: Normalise cache keys before lookup — lowercase, strip punctuation, collapse whitespace:

const normaliseKey = (label: string) =>
  label.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()

Estimated impact: 10–20% cache hit rate improvement, reducing LLM calls proportionally.

-------------------------------------------------------------------------------------------------------------------