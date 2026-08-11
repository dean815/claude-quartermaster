/**
 * Planning a plugin write: what it would change, and everything that stops it.
 *
 * This is the first thing in the repo that decides to modify a user's Claude Code
 * configuration. It decides only -- `apply.ts` is what writes -- and it is split that way
 * so every refusal is reachable without a filesystem and every gate below can run over a
 * plan that was never applied.
 *
 * ## The one file it writes, and the two it must not
 *
 * `<project>/.claude/settings.local.json`, and nothing else. `settings.json` is tracked
 * config that belongs to the repo rather than to this machine, and `~/.claude.json` is
 * the 200KB file every live session writes telemetry into. Both are named in `apply.ts`'s
 * final guard rather than merely avoided by construction, because "we only ever build the
 * right path" is a promise with no way to fail loudly.
 *
 * ## Why a refusal rather than a write
 *
 * Three of the checks below stop a write that would *appear* to work: the file is
 * discarded, or the key is ignored, or the value already resolves the way it was asked
 * for. Each produces valid JSON, a zero exit code, and no change in behaviour -- which is
 * DEA-145's failure exactly, and this repo has paid for it once already.
 *
 * **The safe direction is a property of the consumer, not of the classifier (DEA-112).**
 * DEA-151 sends a `doctor` message it cannot place to `not-checked`, because for a
 * *reporting* tool a wrong `discarded` fabricates a high-severity finding about working
 * config while a wrong `not-checked` only loses a detection. For a *writing* tool the
 * asymmetry runs the other way: a file that might be discarded is a write that might not
 * land, and the user has no way to notice. So `targetValidity` refuses on `discarded`
 * **and** on `not-checked` carrying schema errors -- the state DEA-151 built precisely so
 * that an unrecognised first-party message would be visible. It is visible here as a
 * refusal.
 *
 * That is not hypothetical. Measured on 2.1.224, `enabledPlugins.<id>: 42` makes `doctor`
 * print `Invalid input`, which `costOf` recognises as nothing and which therefore reads
 * `not-checked` -- and `claude plugin list --json` in the same directory reports the
 * file's other entries as **not applied**. A rule keyed on `discarded` alone would have
 * written into it. The recording is `test/fixtures/doctor/unplaced-plugin-entry/`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import type { AuditContext } from './detect.ts';
import {
  buildDeferralIndex,
  classify,
  worstEffect,
  type Classification,
  type Effect,
} from './effect.ts';
import { resolveCell, type Cell, type ChainLink } from './model.ts';
import { resolvePlugin } from './resolve.ts';
import { applyEdits, sha256, stageEdits, type Edit, type Stage } from './surfaces/write.ts';
import type { ProjectRecord, SettingsFile } from './surfaces/types.ts';

/** The only filename this phase writes. Read by `apply.ts`'s last guard. */
export const TARGET_FILENAME = 'settings.local.json';

/** The settings key a plugin toggle lands in. */
export const WRITTEN_SETTINGS_KEY = 'enabledPlugins';

/**
 * What a target that does not exist yet is created as, and what undo restores it to.
 *
 * Inert rather than finished, so the create and the edit stay two separable steps: the
 * create is exclusive (`wx`) and decides nothing, and the edit goes through
 * `stageEdits`/`applyStage` like every other write in this repo. It is also what makes
 * undo an ordinary restore -- undoing a write that created its own file returns the file
 * to this text rather than deleting it, because deleting a file is not something this
 * tool does.
 *
 * It declares `enabledPlugins` **empty**, which merges to nothing and is what an absent
 * key already means, and it is laid out over three lines on purpose. `write.ts` copies a
 * document's own layout rather than choosing one -- indent unit, colon spacing, line
 * ending -- so a seed of `{}` is a document with no layout to copy and the first entry
 * would be spliced in compact, fixing that shape for every later edit. Two spaces and a
 * key already present is the smallest seed that makes the file Claude Code writes.
 */
export const EMPTY_SETTINGS = `{\n  "${WRITTEN_SETTINGS_KEY}": {}\n}\n`;

export const targetFor = (projectPath: string): string =>
  join(projectPath, '.claude', TARGET_FILENAME);

// ---------------------------------------------------------------------------
// Requests, refusals, notes
// ---------------------------------------------------------------------------

export interface ToggleRequest {
  pluginId: string;
  /** `true` writes `"<id>": true` -- the plugin loads in this project. */
  enable: boolean;
}

export type ToggleRefusalCode =
  /** `--project` named a directory the workspace does not carry. */
  | 'no-such-project'
  /** The project *is* `~`, so its "project" settings file is the user-scope one. */
  | 'home-collision'
  /** Claude Code refuses the target file whole. */
  | 'target-discarded'
  /** `doctor` reported on the target in words this release cannot place. */
  | 'target-unplaced'
  /** A schema error names `enabledPlugins`, so the key this writes is not in force. */
  | 'target-ignores-key'
  /** The plugin already resolves to the requested value here. */
  | 'no-change'
  /** `write.ts` would not touch the file -- duplicate key, malformed JSON, and so on. */
  | 'edit-refused';

export interface ToggleRefusal {
  code: ToggleRefusalCode;
  /** One sentence, in the voice the CLI prints. */
  message: string;
  /** Verbatim specifics: a `doctor` line, a chain link, a `write.ts` refusal detail. */
  evidence: string[];
  /** What to do about it, where there is something to do. */
  fix?: string;
}

export type ToggleNoteCode =
  /** Nothing validated the target, so whether Claude Code applies it is unknown. */
  | 'not-validated'
  /** The target is not ignored by git, so the next `git add -A` commits it. */
  | 'tracked-path'
  /** No `git` on PATH, or the project is not a repository -- so nobody asked. */
  | 'gitignore-unchecked'
  /** The entry this writes is one `restated-entries` will report. */
  | 'would-restate'
  /** The target does not exist and will be created. */
  | 'creates-file';

export interface ToggleNote {
  code: ToggleNoteCode;
  message: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PluginChange {
  pluginId: string;
  /** What the plugin resolves to in this project today. */
  from: boolean;
  to: boolean;
  /** What `classify` says this change needs before it is live. */
  effect: Classification;
}

export interface TogglePlan {
  project: string;
  target: string;
  /** The target does not exist; applying creates it. */
  creates: boolean;
  /** The file as it is -- `EMPTY_SETTINGS` when it is about to be created. */
  before: string;
  /** The file as it would be. Byte-for-byte what lands. */
  after: string;
  edits: Edit[];
  /**
   * The staged read of an existing target, holding its hash and mtime.
   *
   * `null` exactly when `creates`, because there is nothing to stage against until the
   * file exists. A created target is staged inside `applyPlan`, immediately after an
   * exclusive create, and the resulting text is compared against `after` -- so the
   * reviewed bytes are the applied bytes on both paths.
   */
  stage: Stage | null;
  changes: PluginChange[];
  notes: ToggleNote[];
}

export type PlanResult =
  | { outcome: 'planned'; plan: TogglePlan }
  | { outcome: 'refused'; refusals: ToggleRefusal[] };

/** What every check is handed. Built once, so no check re-reads a file or re-resolves. */
export interface CheckInput {
  home: string;
  project: string;
  /** `null` when the workspace does not carry this directory at all. */
  record: ProjectRecord | null;
  target: string;
  /** The target settings file, or `null` when it does not exist yet. */
  targetFile: SettingsFile | null;
  requests: readonly ToggleRequest[];
  /** Per requested plugin: how it resolves now, and how it would resolve after. */
  resolved: ReadonlyMap<string, { now: Cell<boolean>; after: Cell<boolean> }>;
}

/**
 * One reason a write does not happen.
 *
 * A list of named checks rather than a chain of `if`s inside `planToggles`, so that a
 * gate can drop exactly one and watch the suite go red. That is the whole reason for the
 * shape: `test/toggle.test.ts` runs the scenario table once per check with that check
 * removed, and every removal must cost a refusal. A guard nobody can delete is a guard
 * nobody has tested.
 */
export interface PlanCheck {
  name: string;
  run(input: CheckInput): ToggleRefusal[];
}

const homeCollision: PlanCheck = {
  name: 'home-collision',
  run: ({ home, project, target }) =>
    resolvePath(project) !== resolvePath(home)
      ? []
      : [
          {
            code: 'home-collision',
            message:
              'The home directory is registered as a project, and its project-scope local ' +
              'settings file is the user-scope one — so a "project" write here lands on every ' +
              'project at once.',
            evidence: [`${target} is ~/.claude/${TARGET_FILENAME}`],
            fix: 'Name the project you meant with --project, or edit user scope deliberately.',
          },
        ],
};

const line = (path: string, key: string, message: string) => `${path} › ${key}: ${message}`;

/**
 * Whether Claude Code would apply what is written here.
 *
 * Three refusals out of one question, because the three say different things to a user
 * and only one of them has a first-party repair. See the file header for why
 * `not-checked` *with errors* refuses: this consumer's cheap failure is the opposite of
 * the reporter's.
 */
const targetValidity: PlanCheck = {
  name: 'target-validity',
  run: ({ targetFile }) => {
    if (!targetFile) return [];
    const { validity, schemaErrors, path } = targetFile;
    const evidence = schemaErrors.map((e) => line(path, e.key, e.message));

    if (validity === 'discarded') {
      return [
        {
          code: 'target-discarded',
          message:
            'Claude Code refuses this settings file against its schema, so an entry written ' +
            'into it would parse, report success, and change nothing.',
          evidence,
          fix: 'Run claude doctor in this project and fix the key it names, then try again.',
        },
      ];
    }

    if (validity === 'not-checked' && schemaErrors.length) {
      return [
        {
          code: 'target-unplaced',
          message:
            'claude doctor reported on this file in words this release does not recognise, so ' +
            'whether Claude Code still applies it was not decided — and a write that might not ' +
            'land is not one this tool makes.',
          evidence,
          fix: 'Run claude doctor in this project and fix what it names, then try again.',
        },
      ];
    }

    // Every partial acceptance leaves the file applying and one part of it not. If that
    // part is the key this writes, the write is as dead as it would be in a discarded
    // file -- and the validity says `field-dropped`, which is otherwise a green light.
    const named = schemaErrors.filter((e) => namesWrittenKey(e.key));
    if (named.length) {
      return [
        {
          code: 'target-ignores-key',
          message:
            `Claude Code ignores ${WRITTEN_SETTINGS_KEY} in this file, so a plugin entry ` +
            'written here would decide nothing even though the rest of the file applies.',
          evidence: named.map((e) => line(path, e.key, e.message)),
          fix: 'Run claude doctor in this project and fix the key it names, then try again.',
        },
      ];
    }

    return [];
  },
};

/**
 * The key a schema error has to name for a plugin write to be pointless.
 *
 * Downward only -- `enabledPlugins` dropped whole, or one of its entries. The upward
 * direction `effectDependsOn` needs (a parent key taking a child with it) has nothing to
 * match here, because the written key is already top-level and has no parent but the
 * document.
 */
export function namesWrittenKey(key: string): boolean {
  return key === WRITTEN_SETTINGS_KEY || key.startsWith(`${WRITTEN_SETTINGS_KEY}.`);
}

/**
 * A write that would change nothing about how the plugin resolves.
 *
 * Two shapes, one refusal. The target file may already carry the entry, in which case the
 * write is a literal no-op; or some other scope may already decide it, in which case the
 * new entry is a `restated-entries` finding and nothing else. Both are the same answer to
 * the user -- *it already resolves that way* -- and both are what `restated-entries`
 * exists to complain about, so a write tool that produced them would be manufacturing its
 * own audit's findings.
 *
 * **The criterion is the resolved value, and not `origin === 'restated'`, and that is a
 * correction to the brief this was written from (DEA-112).** `resolveCell` computes
 * `restated` against the chain with *both* project-scope links removed, so a local entry
 * that overrides the project's own checked-in `settings.json` back to the user-scope value
 * reads `restated` while doing real work: without it the plugin resolves the other way.
 * Refusing on `restated` would refuse exactly the write someone reaches for when a repo's
 * tracked settings disable something they want. It is reported as a note instead.
 */
const noChange: PlanCheck = {
  name: 'no-change',
  run: ({ requests, resolved, target }) => {
    const out: ToggleRefusal[] = [];
    for (const req of requests) {
      const state = resolved.get(req.pluginId);
      if (!state || state.now.value !== req.enable) continue;
      const here = state.now.chain.find((l) => l.source === target);
      out.push({
        code: 'no-change',
        message: `${req.pluginId} already resolves to ${req.enable} in this project.`,
        evidence: here
          ? [`${target} already sets it to ${here.value}`]
          : describeChain(state.now, req.enable),
        ...(here
          ? {}
          : { fix: 'Nothing to write. An entry restating this would be a restated-entries finding.' }),
      });
    }
    return out;
  },
};

function describeChain(cell: Cell<boolean>, value: boolean): string[] {
  if (!cell.chain.length) return [`no settings file mentions it, and an unmentioned plugin is ${value}`];
  return cell.chain.map((l) => `${l.scope}: ${l.value} — ${l.source}`);
}

/**
 * The checks, in the order they are asked.
 *
 * A missing project record is not among them. It is a precondition rather than a policy:
 * with no record there is nothing to resolve against, so every check below would be
 * asking about a world that was not built. `planToggles` answers it before any of this.
 */
export const CHECKS: readonly PlanCheck[] = [homeCollision, targetValidity, noChange];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * What the write would be, or why there is not one.
 *
 * `checks` is a parameter with the real list as its default, so a gate can run the same
 * scenarios with one guard missing. Nothing in `src/` passes it.
 */
export function planToggles(
  ctx: AuditContext,
  projectPath: string,
  requests: readonly ToggleRequest[],
  checks: readonly PlanCheck[] = CHECKS,
): PlanResult {
  const project = resolvePath(projectPath);
  const target = targetFor(project);
  const record = ctx.ws.projects.find((p) => p.path === project) ?? null;
  if (!record) {
    return {
      outcome: 'refused',
      refusals: [
        {
          code: 'no-such-project',
          message: 'Nothing in the workspace covers this directory, so there is nothing to write into.',
          evidence: [project],
        },
      ],
    };
  }
  const targetFile = record.localSettings;

  const resolved = new Map<string, { now: Cell<boolean>; after: Cell<boolean> }>();
  for (const req of requests) {
    const now = resolvePlugin(ctx.ws, record, req.pluginId);
    // The chain this write produces: the target's own link replaced, everything else left
    // alone, and the answer taken from the real algebra rather than restated here.
    const link: ChainLink<boolean> = { scope: 'local', value: req.enable, source: target };
    const after = resolveCell([...now.chain.filter((l) => l.source !== target), link], false);
    resolved.set(req.pluginId, { now, after });
  }

  const input: CheckInput = {
    home: ctx.ws.home,
    project,
    record,
    target,
    targetFile,
    requests,
    resolved,
  };

  const refusals = checks.flatMap((c) => c.run(input));
  if (refusals.length) return { outcome: 'refused', refusals };

  const creates = !existsSync(target);
  const edits = editsFor(targetFile, requests);
  const refuseEdit = (detail: string): PlanResult => ({
    outcome: 'refused',
    refusals: [
      {
        code: 'edit-refused',
        message: `The edit to ${target} was refused rather than guessed at.`,
        evidence: [detail],
      },
    ],
  });

  let before: string;
  let stage: Stage | null = null;
  let after: string;

  if (creates) {
    // Nothing on disk to stage against. The batch is applied to the text the file will be
    // created as, by the same function `stageEdits` uses, and `applyPlan` re-stages after
    // the create and compares -- so what is reviewed is what lands on this path too.
    before = EMPTY_SETTINGS;
    const previewed = applyEdits(EMPTY_SETTINGS, edits);
    if (previewed.outcome === 'refused') {
      return refuseEdit(`${previewed.refusal.reason}: ${previewed.refusal.detail}`);
    }
    after = previewed.text;
  } else {
    const original = readFileSync(target);
    const staged = stageEdits(target, edits);
    if (staged.outcome === 'refused') {
      return refuseEdit(`${staged.refusal.reason}: ${staged.refusal.detail}`);
    }
    // The pre-image is read separately from the stage, so it has to be proved to *be* the
    // pre-image: `Stage.hash` is the hash of the bytes the stage was taken from, and these
    // bytes must match it or the file moved between the two reads. Compared with the
    // function that produced the hash, not a second one.
    //
    // **Ungated, and reported rather than removed.** Deleting this line leaves all 605
    // tests green: the window is the microseconds between two `readFileSync` calls inside
    // this function, and nothing outside it can open that window. What it protects is the
    // *review* and the *backup* rather than the write -- `applyStage` decides the write on
    // its own hash -- so its absence would show as a diff and a pre-image describing a
    // state that never existed, which is exactly the kind of thing nobody notices.
    if (sha256(original) !== staged.stage.hash) {
      return refuseEdit(`${target} changed while it was being read`);
    }
    before = original.toString('utf8');
    stage = staged.stage;
    after = staged.stage.text;
  }

  const index = buildDeferralIndex(ctx.measurements);
  const changes: PluginChange[] = requests.map((req) => ({
    pluginId: req.pluginId,
    from: resolved.get(req.pluginId)!.now.value,
    to: req.enable,
    effect: classify(
      {
        kind: 'plugin',
        id: req.pluginId,
        project,
        // Absent for a file about to be created: nothing has validated a file that does
        // not exist, and `not-checked` would claim a measurement was attempted.
        ...(targetFile
          ? { target: { source: targetFile.path, sourceValidity: targetFile.validity } }
          : {}),
      },
      { index, inventories: ctx.inventories },
    ),
  }));

  return {
    outcome: 'planned',
    plan: { project, target, creates, before, after, edits, stage, changes, notes: notesFor(input, creates, resolved) },
  };
}

/**
 * The edits, in the shape the file can take them.
 *
 * A file with no `enabledPlugins` key gets one insert carrying every requested entry; a
 * file that has one gets an edit per entry, so the untouched entries are not re-encoded.
 * That difference is the whole of "surgical": the second shape rewrites nothing but the
 * booleans asked about, and the first adds one member and moves no other byte.
 *
 * A malformed `enabledPlugins` -- a number, a string -- is not special-cased. It reaches
 * `write.ts`, which refuses `not-a-container` naming the offset, and that refusal is a
 * better answer than any repair this could invent.
 */
export function editsFor(
  targetFile: SettingsFile | null,
  requests: readonly ToggleRequest[],
): Edit[] {
  if (targetFile?.enabledPlugins) {
    return requests.map((r) => ({ path: [WRITTEN_SETTINGS_KEY, r.pluginId], value: r.enable }));
  }
  const value: Record<string, boolean> = {};
  for (const r of requests) value[r.pluginId] = r.enable;
  return [{ path: [WRITTEN_SETTINGS_KEY], value }];
}

function notesFor(
  input: CheckInput,
  creates: boolean,
  resolved: ReadonlyMap<string, { now: Cell<boolean>; after: Cell<boolean> }>,
): ToggleNote[] {
  const notes: ToggleNote[] = [];

  if (creates) {
    notes.push({
      code: 'creates-file',
      message:
        `${input.target} does not exist and will be created. Undo restores it to ${JSON.stringify(
          EMPTY_SETTINGS.trim(),
        )} rather than removing it.`,
    });
  }

  if (input.targetFile && input.targetFile.validity === 'not-checked') {
    notes.push({
      code: 'not-validated',
      message:
        'Nothing validated this file — claude doctor did not answer here — so whether Claude ' +
        'Code applies it is unknown. It resolves exactly as parsing alone has always made it.',
    });
  }

  const ignore = gitIgnoreState(input.project, input.target);
  if (ignore === 'tracked') {
    notes.push({
      code: 'tracked-path',
      message:
        `git does not ignore ${input.target}, so the next \`git add -A\` commits this machine's ` +
        'local configuration. Add `.claude/settings.local.json` to .gitignore if that is not what you want.',
    });
  } else if (ignore !== 'ignored') {
    notes.push({
      code: 'gitignore-unchecked',
      message:
        ignore === 'not-a-repo'
          ? 'This directory is not a git repository, so nothing was asked about ignoring the target.'
          : 'git is not on PATH, so whether the target is ignored was not checked.',
    });
  }

  for (const [pluginId, state] of resolved) {
    // `round-trip` and not `restated` (QM-43). This note exists for the write whose value
    // moves while landing on what the project would have inherited, and that shape is
    // `round-trip` by definition now: a `restated` result means every project-scope entry
    // agrees with the winner, which is a write whose value did not move, which `noChange`
    // refused before reaching here. The sentence explaining why the old label was not to
    // be believed is gone with the label.
    if (state.after.origin !== 'round-trip') continue;
    notes.push({
      code: 'would-restate',
      message:
        `${pluginId} will resolve to ${state.after.value}, which is what this project would ` +
        `inherit with its own settings files taken out — but the entry is in force, not ` +
        `redundant: without it the plugin resolves ${state.now.value}, because the repo's ` +
        `tracked settings.json says so.`,
    });
  }

  return notes;
}

/**
 * Whether git ignores the target path.
 *
 * `git check-ignore` and not a read of `.gitignore`: the answer depends on the repo's own
 * file, on every parent directory's, on `.git/info/exclude` and on `core.excludesFile` --
 * and on this machine it is the last of those that does the work. Measured 2026-08-10
 * across the 17 repositories under `~/claude`: **6** name `settings.local.json` in their
 * own `.gitignore`, and the other **11** are covered only by `~/.config/git/ignore`. So
 * the file is ignored *here* and is not ignored *by the repos*, and a cloud session or
 * anyone else's clone would commit it.
 *
 * Exit codes are git's: 0 ignored, 1 not ignored, 128 not a repository. Anything else,
 * and a missing binary, is "nobody asked" rather than either answer.
 *
 * The working directory is the **project**, never the target's parent: a target that is
 * about to be created usually sits in a `.claude/` that does not exist yet, and spawning
 * into a missing directory fails with the same `ENOENT` a missing `git` does -- so the
 * check reported "git is not on PATH" on precisely the runs it exists for.
 */
export function gitIgnoreState(
  projectDir: string,
  target: string,
): 'ignored' | 'tracked' | 'not-a-repo' | 'no-git' {
  const result = spawnSync('git', ['check-ignore', '-q', '--', target], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  if (result.error) return 'no-git';
  if (result.status === 0) return 'ignored';
  if (result.status === 1) return 'tracked';
  return 'not-a-repo';
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The plan, as lines.
 *
 * Returned rather than printed so the gate can read what the user reads. The effect lines
 * are `classify`'s own verdict and its own sentence -- there is no string here that says
 * what a change needs, because a second copy of that rule is a copy that can be right
 * while the classifier is wrong (DEA-123).
 */
export function describePlan(plan: TogglePlan): string[] {
  const out: string[] = [];
  out.push(`${plan.target}${plan.creates ? '  (new file)' : ''}`);
  out.push('');
  out.push(...unifiedDiff(plan.before, plan.after).map((l) => `  ${l}`));
  out.push('');

  for (const c of plan.changes) {
    out.push(`  ${c.pluginId}: ${c.from} -> ${c.to}`);
    out.push(`    effect: ${c.effect.effect}`);
    out.push(`    ${c.effect.reason}`);
    for (const e of c.effect.evidence) out.push(`      · ${e}`);
  }

  if (plan.notes.length) {
    out.push('');
    for (const n of plan.notes) out.push(`  note (${n.code}): ${n.message}`);
  }

  return out;
}

/** The worst verdict across the batch, which is what the run's exit line reports. */
export function planEffect(plan: TogglePlan): Effect {
  return worstEffect(plan.changes.map((c) => c.effect.effect));
}

/**
 * A one-hunk line diff, with context.
 *
 * One hunk and not a real LCS: every edit this module makes lands inside `enabledPlugins`,
 * so the changed lines are adjacent and a common-prefix/common-suffix scan shows exactly
 * them. Two edits far apart in a large file would print the lines between them, which is
 * more than needed and never less -- the failure mode of a diff for *review* should be
 * showing too much.
 */
export function unifiedDiff(before: string, after: string, context = 3): string[] {
  const a = lines(before);
  const b = lines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  if (head === a.length && head === b.length) return ['(no change)'];

  const from = Math.max(0, head - context);
  const out: string[] = [`--- before (${a.length} lines)`, `+++ after (${b.length} lines)`];
  for (let i = from; i < head; i++) out.push(`  ${a[i]}`);
  for (let i = head; i < a.length - tail; i++) out.push(`- ${a[i]}`);
  for (let i = head; i < b.length - tail; i++) out.push(`+ ${b[i]}`);
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + context); i++) {
    out.push(`  ${a[i]}`);
  }
  return out;
}

/**
 * Lines, without the empty one a trailing newline produces.
 *
 * A file ending in `\n` has as many lines as it has newlines, and a diff that prints an
 * extra blank context line for every file is a diff that reads as if something changed
 * at the end of both.
 */
function lines(text: string): string[] {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}
