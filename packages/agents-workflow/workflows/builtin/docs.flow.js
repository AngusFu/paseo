/// <reference path="../../workflow.d.ts" />
export const meta = {
  name: "docs",
  description:
    "Documentation generator. Discovers the feature surface and existing doc conventions, outlines for the target audience, writes or updates the docs, verifies code examples and links, then opens a PR.",
  whenToUse:
    "When the user wants documentation written or updated for a feature, API, or module. This workflow finds the relevant code and existing doc patterns, drafts an outline, writes the content, checks that examples run and links resolve, and opens a PR.",
  phases: [
    { title: "Discover", detail: "Feature surface, existing docs, location conventions" },
    { title: "Outline", detail: "Structure and audience" },
    { title: "Write", detail: "Create or update doc files" },
    { title: "Verify", detail: "Examples compile/run, links resolve, accuracy vs code" },
    { title: "PR", detail: "Open PR" },
  ],
};

const TASK = typeof args === "string" && args.trim() ? args.trim() : "";
if (!TASK) return { error: "No subject provided. Pass what to document as args." };

const DISCOVER_SCHEMA = {
  type: "object",
  required: ["surface", "existingDocs", "targetPath", "audience", "conventions"],
  properties: {
    surface: {
      type: "array",
      items: { type: "string" },
      description: "file:symbol entries that make up the public surface",
    },
    existingDocs: { type: "array", items: { type: "string" } },
    targetPath: { type: "string", description: "Where the new/updated doc should live" },
    audience: { type: "string" },
    conventions: {
      type: "string",
      description: "Tone, format, and structure conventions from sibling docs",
    },
  },
};
const OUTLINE_SCHEMA = {
  type: "object",
  required: ["title", "sections"],
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["heading", "covers"],
        properties: { heading: { type: "string" }, covers: { type: "string" } },
      },
    },
  },
};
const IMPL_SCHEMA = {
  type: "object",
  required: ["done", "filesChanged", "notes"],
  properties: {
    done: { type: "boolean" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } },
  },
};
const VERIFY_SCHEMA = {
  type: "object",
  required: ["examplesOk", "linksOk", "accurate", "issues"],
  properties: {
    examplesOk: { type: "boolean" },
    linksOk: { type: "boolean" },
    accurate: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
};
const PR_SCHEMA = {
  type: "object",
  required: ["prUrl", "branch", "summary"],
  properties: {
    prUrl: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    notes: { type: "string" },
  },
};

// ═══ Phase 1: Discover ═══
phase("Discover");

const disc = await agent(
  "Discover what needs documenting and where it should live.\n\n" +
    "## Subject\n" +
    TASK +
    "\n\n" +
    "## Instructions\n" +
    "1. Grep/read the code to map the public surface: exported functions, types, CLI flags, " +
    "config keys — whatever a user of this feature touches. List as file:symbol.\n" +
    "2. Find existing docs for this or adjacent features (README, docs/, CLAUDE.md, mdx). " +
    "Note their location, format, and tone.\n" +
    "3. Decide the target path: update an existing doc if one covers this area, otherwise " +
    "pick a path that matches the existing doc layout.\n" +
    "4. Identify the audience (end user, API consumer, contributor) and the conventions to follow.",
  { label: "discover", schema: DISCOVER_SCHEMA },
);
if (!disc) return { error: "Discover step skipped." };
log(
  "Surface: " +
    disc.surface.length +
    " items, target: " +
    disc.targetPath +
    " (" +
    disc.audience +
    ")",
);

const CONTEXT =
  "## Subject\n" +
  TASK +
  "\n\n" +
  "## Surface\n" +
  disc.surface.map((s) => "- " + s).join("\n") +
  "\n\n" +
  "## Target\n" +
  disc.targetPath +
  " (audience: " +
  disc.audience +
  ")\n\n" +
  "## Conventions\n" +
  disc.conventions +
  "\n";

// ═══ Phase 2: Outline ═══
phase("Outline");

const outline = await agent(
  CONTEXT +
    "\n## Instructions\n" +
    "Draft a section outline for " +
    disc.targetPath +
    ".\n" +
    "Match the structure of sibling docs. Cover: what it is, when to use it, how to use it " +
    "(with at least one runnable example), key options/API, and gotchas. Keep it lean — " +
    "no section that does not earn its place.",
  { label: "outline", schema: OUTLINE_SCHEMA },
);
if (!outline) return { error: "Outline step skipped.", discover: disc };
log("Outline: " + outline.sections.length + " sections");

// ═══ Phase 3: Write ═══
phase("Write");

const impl = await agent(
  CONTEXT +
    "\n## Outline\n" +
    outline.sections.map((s, i) => i + 1 + ". " + s.heading + " — " + s.covers).join("\n") +
    "\n\n" +
    "## Existing docs to reference\n" +
    (disc.existingDocs.length ? disc.existingDocs.join(", ") : "(none)") +
    "\n\n" +
    "## Instructions\n" +
    "Write the documentation at " +
    disc.targetPath +
    " following the outline.\n" +
    "- Code examples must be REAL — copy from working code or tests, not invented.\n" +
    "- Match the tone and format of sibling docs.\n" +
    "- If updating an existing file, preserve unrelated sections.\n" +
    "- Update any nav/index files if the doc layout requires it.",
  { label: "write", schema: IMPL_SCHEMA },
);
if (!impl || !impl.done) {
  return {
    error: "Write incomplete.",
    discover: disc,
    outline,
    blockers: impl ? impl.blockers : ["skipped"],
  };
}
log("Wrote: " + impl.filesChanged.join(", "));

// ═══ Phase 4: Verify ═══
phase("Verify");

const verify = await agent(
  "Verify the documentation just written.\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Extract every code example and run/compile it (or typecheck it). Flag any that fail.\n" +
    "2. Check every relative link and cross-reference resolves to a real file or anchor.\n" +
    "3. Spot-check accuracy: pick 3 claims about behavior and verify them against the code at\n" +
    disc.surface
      .slice(0, 5)
      .map((s) => "   - " + s)
      .join("\n") +
    "\n" +
    "4. List concrete issues found (empty if clean).",
  { label: "verify", schema: VERIFY_SCHEMA },
);
const issues = verify ? verify.issues : [];
log(
  "Verify: examples " +
    (verify && verify.examplesOk ? "OK" : "FAIL") +
    ", links " +
    (verify && verify.linksOk ? "OK" : "FAIL") +
    ", " +
    issues.length +
    " issues",
);

let fixNotes = "(clean)";
if (issues.length > 0) {
  const fixed = await agent(
    "Fix these documentation issues:\n" +
      issues.map((i, n) => n + 1 + ". " + i).join("\n") +
      "\n\nFiles: " +
      impl.filesChanged.join(", "),
    { label: "verify:fix", phase: "Verify", schema: IMPL_SCHEMA },
  );
  fixNotes = fixed ? fixed.notes : "(fix skipped)";
}

// ═══ Phase 5: PR ═══
phase("PR");

const pr = await agent(
  "Open a PR for this documentation change.\n\n" +
    "## Subject\n" +
    TASK +
    "\n\n" +
    "Files: " +
    impl.filesChanged.join(", ") +
    "\n\n" +
    "## Instructions\n" +
    "1. Run lint/format on the doc files if the repo has a docs linter.\n" +
    "2. Commit, push, open a PR. Summarize what was documented and why.\n" +
    "3. Return PR URL, branch, and a 2-3 sentence summary.",
  { label: "pr", schema: PR_SCHEMA },
);

return {
  summary: pr ? pr.summary : "PR step incomplete. Docs written to " + impl.filesChanged.join(", "),
  prUrl: pr ? pr.prUrl : null,
  branch: pr ? pr.branch : null,
  targetPath: disc.targetPath,
  filesChanged: impl.filesChanged,
  outline: outline.sections.map((s) => s.heading),
  verify: verify
    ? { examplesOk: verify.examplesOk, linksOk: verify.linksOk, issues: issues.length }
    : null,
  fixNotes,
};
