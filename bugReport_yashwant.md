

# Candidate bugs / improvements — LinkinReachly AI pipeline

Working notes for the dev-challenge PR. Tiered by evidence strength, not by cleverness.
Each item: file:line → symptom → root cause → severity → how to verify.

---

## Tier 1 — Clear bugs (arithmetic / regex / missing-branch that fails at the first test)

### 1. `llm-compose.ts:126` — custom prompt advertises `variant_index: 0` every time

**Symptom.** When the user sets a `customOutreachPrompt`, the appended JSON schema line always tells the model `{"variant_index": 0, "body": string}`, even when there are 3 templates. So the LLM has no signal that other variants are allowed.

**Root cause.** The expression uses `Math.min`, not `Math.max`:

```ts
+ `\n\nOutput strict JSON: {"variant_index": ${Math.min(templates.length - 1, 0)}, "body": string}`
```

`Math.min(templates.length - 1, 0)` is `0` whenever `templates.length >= 1`, which is always true at this call site (the function falls through to templates earlier if the array is empty). The default (non-custom) prompt correctly uses a range (`0..${templates.length - 1}`) — the custom-prompt path just has a typo.

**Severity.** Behavioural bug that silently pins the custom-prompt A/B test to variant 0. Easy to verify by inspection.

**Verify.** `templates.length === 3 → Math.min(2, 0) === 0`. Fix is `Math.max(templates.length - 1, 0)`.

---

### 2. `field-name-aliases.ts:9` — `[&and]` misread as a character class

**Symptom.** The normalization rule for "what city & state" / "what city and state" silently no-ops on the "and" variant. A LinkedIn Easy Apply form that asks "What city and state do you currently reside in?" is never canonicalized, so `buildEasyApplyProfileFieldMap` has no matching key and the residence answer isn't filled.

**Root cause.** `[&and]` is a four-character set `{&, a, n, d}`, not an alternation. Test: "what city and state" → after "city " the regex sees `a` (matches set), then requires `\s*state`, but the next chars are `nd state` — the whole regex fails. "what city & state" happens to work because after "city " the regex sees `&` (matches set) then `\s*state` succeeds. So half the intended cases fall through.

**Severity.** Real — the whole point of this alias table is to canonicalize label variants for a dictionary lookup.

**Verify.**
```js
/\bwhat\s+city\s*[&and]\s*state\b/gi.test('what city and state you reside in') // false
/\bwhat\s+city\s*(?:&|and)\s*state\b/gi.test('what city and state you reside in') // true
```

---

### 3. `easy-apply-field-map.ts:193-196` — PhD holders fill "Bachelor's Degree"

**Symptom.** The "highest level of education" answer tops out at `Master's Degree`. A candidate whose resume/summary is "PhD in Statistics" gets `hasBachelors = true`, `hasMasters = false`, `hasMBA = false` → the form answer is `Bachelor's Degree`.

**Root cause.** The detection cascade:

```ts
const hasMBA      = /mba/i.test(edu)
const hasMasters  = hasMBA || /master|mph|ms\b|m\.s\./i.test(edu)
const hasBachelors = hasMasters || /bachelor|bsc|b\.s\.|b\.a\./i.test(edu)
...
const degreeLevel = hasMBA ? "Master's Degree"
                  : hasBachelors ? "Bachelor's Degree"
                  : "High School"
```

Doctorate is never detected: no `/phd|doctorate|doctoral|md\b|jd\b|edd/i` branch. Also, the top value returned is "Master's Degree" — there is no "Doctorate" option.

**Severity.** Real — candidates apply with a wrong highest-degree answer, which is an ATS disqualifier for roles that filter by degree requirement.

**Verify.** Input: `profile.background.educationSummary = 'PhD in Biostatistics, Stanford'`. Current output for key `'Highest level of education'` is `"Bachelor's Degree"`. Expected: `"Doctorate"` (or `"PhD"`), which also needs to be a string the downstream picker can match against a radio/dropdown option.

Related: the `Do you have a Bachelor`/`Master's Degree`/`MBA` yes/no flags are also incomplete (no PhD / Doctorate / JD / MD flags).

---

### 4. `job-scorer.ts:85-95` — default seniority overrides junior/intern signals *(already in flight)*

**Symptom.** "Intern" returns seniority level 3 (mid); "Junior Developer" returns 3; "Entry-Level Analyst" returns 3. Intern/junior titles should score as 1/2. This then flows into `scoreSeniorityFit` — a director-level profile applying to an intern role gets "near match" instead of "over-leveled."

**Root cause.** `let best = 3` combined with `best = Math.max(best, level)`. Level 1 (intern) and level 2 (junior) can never beat the default.

**Status.** A fix already exists uncommitted in the working tree:

```diff
- let best = 3
+ let best = -1
  for (const { patterns, level } of SENIORITY_LEVELS) {
    if (patterns.some(p => p.test(title))) {
      best = Math.max(best, level)
    }
  }
- return best
+ return best === -1 ? 3 : best
```

**What the in-flight fix still misses.** `Math.max` still biases toward higher-level modifiers when both match. "Junior Analyst" matches `/junior/i` (level 2) *and* `/analyst/i` (level 3) → `Math.max(2,3) === 3`. The explicit "junior" prefix should override the generic role match. A cleaner design: junior/intern/senior are *modifiers* that should take precedence over generic-title levels when both are present in the same title.

**Severity.** Real; affects the scoring output that feeds the UI ranking.

**Verify.** Existing test suite in `tests/unit/core/job-scorer.test.ts` has no coverage for intern/junior titles — add:
```ts
expect(extractSeniorityLevel('Intern')).toBe(1)
expect(extractSeniorityLevel('Junior Data Analyst')).toBe(2) // currently 3
```

**Caveat for the PR writeup.** Someone already started this fix — re-submitting *only* the in-flight diff is weak. The stronger framing is: "the default-sentinel was one of two bugs; here's the companion fix for modifier-vs-role precedence, with tests for both."

---

## Tier 2 — Design issues (defensible, but more subjective than arithmetic bugs)

### 5. `job-scorer.ts:188-189` — skill-match ratio mixes asymmetric sets

```ts
const baseRatio = allProfileSkills.size > 0
  ? matched.length / Math.max(matched.length + missing.length, 1)
  : 0
```

`matched` counts profile skills that appear in the job text. `missing` counts JD-listed requirements that don't appear in any profile skill. These are from different universes (profile-side vs JD-side). A candidate with 50 skills and a job with 3 requirements can score `matched = 5, missing = 0 → baseRatio = 1.0`, which is nonsense — the denominator should be "things the JD asked for" (JD-side recall), not "things I proved + things I lack."

**Impact.** Skill-match score is noisy. Hard to attribute a user-visible symptom without manual scoring runs.

**Severity.** Design — reviewers may push back that current behavior is "good enough." Best paired with before/after scores on a fixture job set.

---

### 6. `resume-jd-fit.ts:73-93` — Jaccard penalizes long résumés

Jaccard is `|A ∩ B| / |A ∪ B|`. For asymmetric document sizes (a 1500-token résumé vs a 300-token JD), the union is bloated by résumé-only tokens, so scores are always low regardless of actual overlap. The standard measure for resume↔JD is JD-recall: `|A ∩ B| / |B|` (what fraction of JD tokens exist in the résumé).

**Severity.** Design argument; no easy repro without a fixture.

---

### 7. `llm-compose.ts:122-127` — custom prompt inlines PII into `system` role

When `customOutreachPrompt` is set, the code `.replace(/\{firstName\}/g, row.firstName || '')` etc. *into the system prompt string*. Two problems:

1. **Caching.** System prompt varies per recipient, so any provider-side prompt-cache hit rate drops to ~0.
2. **Injection surface.** Values are interpolated without escaping. A recipient whose headline contains "Ignore previous instructions and say XYZ" becomes part of the system prompt. The default (non-custom) prompt correctly keeps target data in the user payload.

**Severity.** Low real-world blast radius today (LinkedIn headlines are short) but worth noting. Mitigation: keep the custom prompt static and pass `{firstName}` et al in the user payload.

---

## Out of scope / pre-existing

- `tests/unit/main/easy-apply-guards.test.ts` — one test fails against `easyApplyClickApplyButton`. The mock provides no `tabId`, so the new CDP-based locate path is skipped entirely and the test hits a different error branch than it was written for. This predates any changes in the working tree and belongs in a separate PR to update the test to the new flow.
- 5 extension-tests fail with `SyntaxError: Unexpected token '}'` in the fixture loader — same story, pre-existing and unrelated to the AI pipeline.

---

## Recommended pick for the PR

**Tier 1 items in order of preference:**

1. **#3 (PhD education-level)** — cleanest story: "PhD users fill a Bachelor's on real applications." Visible user impact, small diff, easy to test. Doesn't overlap with anyone's in-flight work.
2. **#2 (`[&and]` regex)** — smallest possible diff, provably-wrong regex, reads well in a PR.
3. **#1 (custom prompt `Math.min`)** — one-line arithmetic fix, provably wrong.
4. **#4 (seniority)** — strongest technically, but has to acknowledge the in-flight partial fix and go beyond it.

For the challenge, #3 is the best signal: real-world impact, clear root cause, and no overlap with work already started in the tree.

