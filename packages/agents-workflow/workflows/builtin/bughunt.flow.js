/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "bughunt",
  description:
    "Multi-agent bug sweep of the current branch. Self-respawning finder pool (3 rapid + deep-until-dry-streak) streams into 5-vote adversarial verification with pigeonhole early-exit, then synthesis.",
  whenToUse:
    "When the user asks to hunt for bugs, audit code quality, or run a high-precision bug sweep on the current branch.",
  phases: [
    { title: "Scope", detail: "Discover diff base, changed files, conventions" },
    { title: "Find", detail: "3 rapid + deep-until-dry-streak(3), self-respawning pool" },
    {
      title: "Verify",
      detail: "5-vote adversarial, pigeonhole early-exit (2 refute → dead, skip 3)",
    },
    { title: "Synthesize", detail: "Semantic dedup on confirmed set, final report" },
  ],
};

// ═══ Constants ═══
const FLEET_SIZE = 5;
const VOTES_PER_BUG = 5;
const REFUTATIONS_REQUIRED = 2;
const MAX_VERIFY = 20;
const DRY_STREAK_LIMIT = 3;

// ═══ Schemas ═══
const SCOPE_SCHEMA = {
  type: "object",
  required: ["diffBase", "files", "summary"],
  properties: {
    diffBase: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
};
const BUGS_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          category: {
            enum: [
              "logic",
              "security",
              "performance",
              "convention",
              "correctness",
              "resource-leak",
              "race",
              "other",
            ],
          },
        },
      },
    },
  },
};
const VERDICT_SCHEMA = {
  type: "object",
  required: ["refuted", "evidence", "confidence"],
  properties: {
    refuted: { type: "boolean" },
    evidence: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    severity: { enum: ["critical", "high", "medium", "low", "nit"] },
  },
};
const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "bugs"],
  properties: {
    summary: { type: "string" },
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "description", "severity", "vote", "evidence"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          severity: { enum: ["critical", "high", "medium", "low", "nit"] },
          vote: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

// ═══ Phase 0: Scope ═══
phase("Scope");

const scope = await agent(
  "Discover the scope of changes on the current branch for a bug hunt.\n\n" +
    "1. Diff base: run 'git rev-parse origin/main', fallback to 'main'. Return whichever exists.\n" +
    "2. Changed files: 'git diff --name-only <diffBase>...HEAD'\n" +
    "3. Summarize what changed in one paragraph.\n" +
    "4. Find CLAUDE.md files (root + parent dirs of changed files); extract relevant conventions.\n" +
    "Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA },
);
if (!scope) return { summary: "Scope skipped.", bugs: [], stats: {} };
if (scope.files.length === 0)
  return { summary: "No changes on branch vs " + scope.diffBase + ".", bugs: [], stats: {} };

log(scope.files.length + " files changed vs " + scope.diffBase);

// Shared context header for all finder/verifier prompts. Small — each agent
// runs 'git diff' itself to read the actual changes.
const CONTEXT_HEADER =
  "## Branch scope (" +
  scope.diffBase +
  "...HEAD)\n" +
  "Changed files (" +
  scope.files.length +
  "):\n" +
  scope.files
    .map(function (f) {
      return "  - " + f;
    })
    .join("\n") +
  "\n\n" +
  "## What changed\n" +
  scope.summary +
  "\n\n" +
  "## Conventions (CLAUDE.md)\n" +
  (scope.conventions || "(none)") +
  "\n\n";

// ═══ Shared state (single-threaded JS — all mutations atomic) ═══
const dedupKey = function (b) {
  return b.file + ":" + (b.line != null ? Math.round(b.line / 5) * 5 : "x");
};
const sevRank = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const confRank = { high: 0, medium: 1, low: 2 };

const seen = new Map();
const naiveDupes = [];
const budgetDropped = [];
const verifyJobs = [];
let verifySlots = MAX_VERIFY;
let rapidSpawned = 0;
let deepSpawned = 0;
let dryStreak = 0;
let bugFindingDone = false;

// ═══ Prompt builders ═══
function rapidPrompt(idx, skipKeys) {
  const partition = ["first third", "middle third", "last third"][idx % 3];
  return (
    CONTEXT_HEADER +
    "## Role: Rapid Surface Scanner (rapid-" +
    idx +
    ")\n\n" +
    "Quickly scan the changes. Report obvious issues. Do NOT deep-dive.\n\n" +
    "## Look for\n" +
    "**P1** CLAUDE.md violations · **P2** Logic errors (copy-paste, wrong conditions, null derefs) · " +
    "**P3** Resource issues (unbounded growth, missing await)\n\n" +
    "## Instructions\n" +
    "1. Run 'git diff " +
    scope.diffBase +
    "...HEAD' to see the changes.\n" +
    "2. Read changed files as needed for surrounding context.\n" +
    "3. Report 5-12 bugs. Breadth > depth. OK to be wrong.\n" +
    "4. Bias toward the " +
    partition +
    " of the file list.\n" +
    (skipKeys.length > 0
      ? "5. SKIP these locations (already found): " + skipKeys.join(", ") + "\n"
      : "") +
    "\nStructured output only."
  );
}

function deepPrompt(idx, skipKeys) {
  return (
    CONTEXT_HEADER +
    "## Role: Deep Analyst (deep-" +
    idx +
    ")\n\n" +
    "Find subtle bugs requiring deep analysis.\n\n" +
    "## Process\n" +
    "Run 'git diff " +
    scope.diffBase +
    "...HEAD' · Read full files · Grep callers of modified functions · Trace callees · Trace data flow\n\n" +
    "## Look for\n" +
    "Invariant violations · Races · State mutation · Edge cases (empty/null/concurrent)\n\n" +
    "## Instructions\n" +
    "Pick " +
    (idx === 0 ? "the most significant change" : "a DIFFERENT subsystem from prior deep passes") +
    ". " +
    "Go DEEP. Return 1-3 high-confidence findings.\n" +
    (skipKeys.length > 0
      ? "SKIP these locations (already found): " + skipKeys.join(", ") + "\n"
      : "") +
    "\nStructured output only."
  );
}

function verifyPrompt(bug, v) {
  return (
    CONTEXT_HEADER +
    "## Role: Adversarial Verifier (voter " +
    (v + 1) +
    "/" +
    VOTES_PER_BUG +
    ")\n\n" +
    "Be SKEPTICAL. Try to REFUTE. Find ANY reason this is not a real bug. " +
    "≥" +
    REFUTATIONS_REQUIRED +
    " refutations of " +
    VOTES_PER_BUG +
    " kill it.\n\n" +
    "## Candidate\n" +
    "File: " +
    bug.file +
    (bug.line != null ? ":" + bug.line : "") +
    "\n" +
    "Title: " +
    bug.title +
    "\n" +
    "Severity: " +
    bug.severity +
    "\n" +
    "Description: " +
    bug.description +
    "\n\n" +
    "## Checklist\n" +
    "1. Run 'git diff " +
    scope.diffBase +
    "...HEAD -- " +
    bug.file +
    "' and read the file — does the issue exist?\n" +
    "2. Check callers — reachable? Preconditions guaranteed?\n" +
    "3. Check handling — validation/error handling elsewhere?\n" +
    "4. Conventions — intentional per CLAUDE.md (above)?\n" +
    "5. Git history — pre-existing ≠ new bug. Already fixed/reverted?\n\n" +
    "**refuted=true** if: not reachable / handled elsewhere / intentional / pre-existing / wrong.\n" +
    "**refuted=false** ONLY if: real, reachable, new, material.\n" +
    "Default to refuted=true if uncertain.\n\n" +
    "Structured output only. Evidence MUST cite file:line."
  );
}

// ═══ Pigeonhole verification: 2 votes first; if both refute, skip the other 3 ═══
function verifyBug(bug) {
  const shortName = bug.file.split("/").pop();
  return parallel(
    [0, 1].map(function (v) {
      return function () {
        return agent(verifyPrompt(bug, v), {
          label: "v" + v + ":" + shortName,
          phase: "Verify",
          schema: VERDICT_SCHEMA,
        });
      };
    }),
  ).then(function (first2) {
    const r2 = first2.filter(Boolean).filter(function (v) {
      return v.refuted;
    }).length;
    if (r2 >= REFUTATIONS_REQUIRED) {
      log(shortName + ' "' + bug.title + '": 0-2 ✗ (early kill)');
      return { bug: bug, verdicts: first2, refutedVotes: r2, survives: false };
    }
    // Outcome undecided — need 3 more votes.
    return parallel(
      [2, 3, 4].map(function (v) {
        return function () {
          return agent(verifyPrompt(bug, v), {
            label: "v" + v + ":" + shortName,
            phase: "Verify",
            schema: VERDICT_SCHEMA,
          });
        };
      }),
    ).then(function (rest) {
      const all = first2.concat(rest).filter(Boolean);
      const r = all.filter(function (v) {
        return v.refuted;
      }).length;
      const survives = r < REFUTATIONS_REQUIRED;
      log(
        shortName +
          ' "' +
          bug.title +
          '": ' +
          (all.length - r) +
          "-" +
          r +
          " " +
          (survives ? "✓" : "✗"),
      );
      return { bug: bug, verdicts: all, refutedVotes: r, survives: survives };
    });
  });
}

// ═══ Harvest: dedup, budget, dry-streak ═══
function harvest(result, role) {
  if (!result) {
    // user-skip or agent failure — count deep skips as dry
    if (role.type === "deep") {
      dryStreak++;
      if (dryStreak >= DRY_STREAK_LIMIT) bugFindingDone = true;
    }
    return [];
  }
  // Sort by severity so high-priority bugs claim budget slots first
  const sorted = result.bugs.slice().sort(function (a, b) {
    return sevRank[a.severity] - sevRank[b.severity];
  });
  const novel = [];
  for (const b of sorted) {
    const key = dedupKey(b);
    if (seen.has(key)) {
      naiveDupes.push(Object.assign({}, b, { finder: role.label, dupOf: seen.get(key) }));
      continue;
    }
    // Budget cap — critical/high always pass
    if (verifySlots <= 0 && sevRank[b.severity] >= 2) {
      budgetDropped.push(Object.assign({}, b, { finder: role.label }));
      continue;
    }
    seen.set(key, { finder: role.label, title: b.title });
    verifySlots--;
    novel.push(Object.assign({}, b, { finder: role.label }));
  }

  if (role.type === "deep") {
    dryStreak = novel.length > 0 ? 0 : dryStreak + 1;
    if (dryStreak >= DRY_STREAK_LIMIT) bugFindingDone = true;
  }
  log(
    role.label +
      ": " +
      result.bugs.length +
      " raw → " +
      novel.length +
      " novel" +
      (role.type === "deep" ? " (dryStreak=" + dryStreak + ")" : ""),
  );
  return novel;
}

// ═══ Role assignment (Python decide_agent_type) ═══
function decideNextRole() {
  if (bugFindingDone) return null;
  if (rapidSpawned < 3) {
    const idx = rapidSpawned++;
    return { type: "rapid", idx: idx, label: "rapid-" + idx };
  }
  const idx = deepSpawned++;
  return { type: "deep", idx: idx, label: "deep-" + idx };
}

// ═══ Self-respawning slot ═══
function slot() {
  const role = decideNextRole();
  if (!role) return Promise.resolve();
  const skipKeys = Array.from(seen.keys());
  const prompt =
    role.type === "rapid" ? rapidPrompt(role.idx, skipKeys) : deepPrompt(role.idx, skipKeys);
  return agent(prompt, { label: role.label, phase: "Find", schema: BUGS_SCHEMA }).then(
    function (result) {
      const novel = harvest(result, role);
      // Fire verification NOW — do not await. Respawn immediately.
      novel.forEach(function (bug) {
        verifyJobs.push(verifyBug(bug));
      });
      return slot();
    },
  );
}

// ═══ Run: find + verify overlap (no barrier until synthesis) ═══
phase("Find");
await parallel(
  Array.from({ length: FLEET_SIZE }, function () {
    return function () {
      return slot();
    };
  }),
);

log(
  "Dry-streak hit. " +
    seen.size +
    " unique bugs found. Draining " +
    verifyJobs.length +
    " verifications...",
);
const allVoted = (await Promise.all(verifyJobs)).filter(Boolean);

const confirmed = allVoted.filter(function (r) {
  return r.survives;
});
const killed = allVoted.filter(function (r) {
  return !r.survives;
});

log(
  "Voting done: " +
    allVoted.length +
    " voted → " +
    confirmed.length +
    " confirmed, " +
    killed.length +
    " killed · " +
    naiveDupes.length +
    " naive-dupes · " +
    budgetDropped.length +
    " budget-dropped",
);

// ═══ Early return if nothing confirmed ═══
if (confirmed.length === 0) {
  return {
    summary:
      "Clean. " +
      allVoted.length +
      " voted, all killed by 5-vote adversarial. " +
      deepSpawned +
      " deep finders ran before dry-streak.",
    bugs: [],
    killed: killed.map(function (r) {
      return {
        file: r.bug.file,
        title: r.bug.title,
        vote: r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes,
      };
    }),
    stats: {
      rapidSpawned: rapidSpawned,
      deepSpawned: deepSpawned,
      voted: allVoted.length,
      confirmed: 0,
      killed: killed.length,
      naiveDupes: naiveDupes.length,
      budgetDropped: budgetDropped.length,
    },
  };
}

// ═══ Phase 3: Synthesis (semantic dedup + final report) ═══
phase("Synthesize");

function bestEvidence(r) {
  const confirms = r.verdicts.filter(Boolean).filter(function (v) {
    return !v.refuted;
  });
  confirms.sort(function (a, b) {
    return confRank[a.confidence] - confRank[b.confidence];
  });
  return confirms[0] || { evidence: "(no confirming verdict)", confidence: "low" };
}

const block = confirmed
  .map(function (r, i) {
    const best = bestEvidence(r);
    const vote = r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes;
    return (
      "### [" +
      i +
      "] " +
      r.bug.title +
      " (" +
      r.bug.severity +
      ", " +
      r.bug.finder +
      ")\n" +
      "Vote: " +
      vote +
      " · File: " +
      r.bug.file +
      (r.bug.line != null ? ":" + r.bug.line : "") +
      "\n" +
      r.bug.description +
      "\n" +
      "Evidence (" +
      best.confidence +
      "): " +
      best.evidence +
      "\n"
    );
  })
  .join("\n");

const report = await agent(
  "## Synthesis: semantic dedup + final report\n\n" +
    confirmed.length +
    " bugs survived adversarial verification. " +
    "Semantic duplicates are likely (naive dedup only caught file:line matches).\n\n" +
    block +
    "\n\n" +
    "## Instructions\n" +
    "1. Identify semantic duplicates (same root cause, different location/wording). Merge into one entry.\n" +
    "2. Order by severity: critical → high → medium → low → nit.\n" +
    "3. Tighten titles/descriptions. Pick the best evidence per bug.\n" +
    "4. Write a 2-3 sentence summary.\n\n" +
    "Structured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA },
);

const reportResult = report || { summary: "(synthesis skipped)", bugs: [] };

return {
  summary: reportResult.summary,
  bugs: reportResult.bugs,
  killed: killed.map(function (r) {
    return {
      file: r.bug.file,
      title: r.bug.title,
      vote: r.verdicts.length - r.refutedVotes + "-" + r.refutedVotes,
    };
  }),
  stats: {
    rapidSpawned: rapidSpawned,
    deepSpawned: deepSpawned,
    voted: allVoted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSemanticDedup: reportResult.bugs.length,
    naiveDupes: naiveDupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls:
      1 +
      (rapidSpawned + deepSpawned) +
      allVoted.reduce(function (s, r) {
        return s + r.verdicts.length;
      }, 0) +
      1,
  },
};
