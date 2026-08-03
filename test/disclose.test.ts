/**
 * The disclosure that a first-party subcommand initialised `~/.claude.json` (DEA-140).
 *
 * Nothing here spawns `claude`. Doing so is what creates the file in the first place,
 * and on macOS a temp `HOME` also detaches the login keychain and raises a modal at the
 * user -- so the spawn is stubbed and the watched path is injected. The stub *writes
 * the file* where the real subcommand would, which is the only part of its behaviour
 * this cares about.
 *
 * A disclosure that always fires is a banner, so the gate is a table of five runs and
 * what each must say, and six wrong implementations are shipped against it. Each is
 * caught by a different row: a gate no mutation can fail is not a gate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCli, type ClaudeExec, type ConfigInit, type RunOptions } from '../src/disclose.ts';

/**
 * The name Claude Code writes on disk, as a literal rather than as anything derived
 * from `src/`. Someone else's fact, so the test and the implementation can disagree.
 */
const CONFIG = '.claude.json';

function withTempHome(fn: (configPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qm-disclose-'));
  try {
    fn(join(dir, CONFIG));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What eight keys of first-party config look like, near enough. */
function initialise(path: string): void {
  writeFileSync(path, JSON.stringify({ machineID: 'm', userID: 'u' }));
}

/** A stub `claude` that creates the config file, the way every subcommand does. */
const creates = (path: string): ClaudeExec => (_args, _opts) => {
  initialise(path);
  return 'stub output';
};

/** A stub `claude` that is not on PATH. */
const missing: ClaudeExec = () => {
  throw new Error('spawn claude ENOENT');
};

/** The narrow shape a scenario drives: the real class, and every mutant of it. */
interface Cli {
  run(args: readonly string[], opts?: RunOptions): string;
  disclosure(): ConfigInit | null;
}

type Factory = (configPath: string, exec: ClaudeExec) => Cli;

const real: Factory = (configPath, exec) => new ClaudeCli(configPath, exec);

interface Run {
  name: string;
  /** The command the disclosure must name, or null for silence. */
  expect: string | null;
  play: (make: Factory) => ConfigInit | null;
}

/**
 * Five runs, each one a condition of the disclosure seen from the outside.
 *
 * The construction point matters as much as the assertions: the watch is taken when the
 * `Cli` is built, so building it before the stub can write is what "before the first
 * shell-out" means here.
 */
const RUNS: Run[] = [
  {
    // The common machine, and the one that decides whether this is a disclosure or a
    // banner: the file is already there, so this run did not bring it.
    name: 'the config file was already there',
    expect: null,
    play: (make) => {
      let out: ConfigInit | null = null;
      withTempHome((path) => {
        initialise(path);
        const cli = make(path, creates(path));
        cli.run(['doctor']);
        out = cli.disclosure();
      });
      return out;
    },
  },
  {
    name: 'the file was absent and the spawn made it',
    expect: 'claude plugin list --json',
    play: (make) => {
      let out: ConfigInit | null = null;
      withTempHome((path) => {
        const cli = make(path, creates(path));
        cli.run(['plugin', 'list', '--json']);
        assert.ok(existsSync(path), 'the stub must leave the file where claude does');
        out = cli.disclosure();
      });
      return out;
    },
  },
  {
    // A live session started mid-run and wrote it. Absence plus a file is not enough --
    // the run has to have spawned something that could have caused it.
    name: 'the file appeared but nothing was spawned',
    expect: null,
    play: (make) => {
      let out: ConfigInit | null = null;
      withTempHome((path) => {
        const cli = make(path, creates(path));
        initialise(path);
        out = cli.disclosure();
      });
      return out;
    },
  },
  {
    // No `claude` on PATH: every spawn throws and nothing is written. Claiming a file
    // here would be reporting a write that did not happen.
    name: 'the spawn was attempted and failed',
    expect: null,
    play: (make) => {
      let out: ConfigInit | null = null;
      withTempHome((path) => {
        const cli = make(path, missing);
        assert.throws(() => cli.run(['plugin', 'list', '--json']));
        assert.equal(existsSync(path), false);
        out = cli.disclosure();
      });
      return out;
    },
  },
  {
    // An audit spawns several. The one that initialised the file is the first.
    name: 'two commands ran',
    expect: 'claude doctor',
    play: (make) => {
      let out: ConfigInit | null = null;
      withTempHome((path) => {
        const cli = make(path, creates(path));
        cli.run(['doctor']);
        cli.run(['plugin', 'details', 'engineering']);
        out = cli.disclosure();
      });
      return out;
    },
  },
];

/** Every way a run and its expectation disagree, named. */
function diff(run: Run, actual: ConfigInit | null): string[] {
  if (run.expect === null) {
    return actual ? [`${run.name}: disclosed "${actual.command}", expected silence`] : [];
  }
  if (!actual) return [`${run.name}: silent, expected "${run.expect}"`];
  if (actual.command !== run.expect) {
    return [`${run.name}: named "${actual.command}", expected "${run.expect}"`];
  }
  return [];
}

describe('the disclosure fires exactly when this run caused the file to exist', () => {
  for (const run of RUNS) {
    test(run.name, () => {
      assert.deepEqual(diff(run, run.play(real)), []);
    });
  }
});

describe('the wording attributes the write', () => {
  test('it names the command, the file, and who did not write it', () => {
    const init = RUNS[1]!.play(real);
    assert.ok(init, 'the absent-then-created run must disclose');

    // The four claims the disclosure has to carry. Asserted as pieces rather than as
    // one literal so the sentence can be reworded without a test rewriting itself into
    // agreement with whatever it now says.
    assert.match(init.note, /^claude plugin list --json initialised /);
    assert.ok(init.note.includes(init.path), 'the note names the file it is about');
    assert.match(init.note, /did not exist before this run/);
    assert.match(init.note, /quartermaster did not write it/);

    // One line: the human report and `--json` print the same string, and the human side
    // prints it as a single line.
    assert.equal(init.note.includes('\n'), false);
    assert.equal(init.command, 'claude plugin list --json');
    assert.ok(init.path.endsWith(CONFIG));
  });

  test('and a run that discloses nothing has nothing to word', () => {
    assert.equal(RUNS[0]!.play(real), null);
  });
});

// ---------------------------------------------------------------------------
// The mutations the gate is measured by
// ---------------------------------------------------------------------------

/**
 * One condition of the disclosure, removed.
 *
 * `never` is the feature deleted; the rest are the four plausible ways to get it wrong.
 */
type Dropped =
  | 'never'
  | 'existed-before'
  | 'checks-too-late'
  | 'anything-spawned'
  | 'exists-now'
  | 'first-wins';

/**
 * A wrong `ClaudeCli`, hand-written.
 *
 * Not a subclass and not built from anything in `src/`: a mutant that borrowed the real
 * predicate would agree with it whatever it does, which is the defect this file exists
 * to rule out. What it shares with the real one is only the protocol -- built before the
 * run, spawned through, asked afterwards.
 */
class Mutant implements Cli {
  private readonly configPath: string;
  private readonly exec: ClaudeExec;
  private readonly dropped: Dropped;
  private readonly existedBefore: boolean;
  private firstCommand: string | null = null;

  constructor(configPath: string, exec: ClaudeExec, dropped: Dropped) {
    this.configPath = configPath;
    this.exec = exec;
    this.dropped = dropped;
    this.existedBefore = existsSync(configPath);
  }

  run(args: readonly string[], opts: RunOptions = {}): string {
    const command = ['claude', ...args].join(' ');
    if (this.dropped === 'first-wins') this.firstCommand = command;
    else this.firstCommand ??= command;
    return this.exec(args, opts);
  }

  disclosure(): ConfigInit | null {
    if (this.dropped === 'never') return null;
    // The whole point of the mutant: the check is made when the report is written
    // rather than before the first spawn, by which time the subprocess has written it.
    const existedBefore =
      this.dropped === 'checks-too-late' ? existsSync(this.configPath) : this.existedBefore;

    if (this.dropped !== 'existed-before' && existedBefore) return null;
    if (this.dropped !== 'anything-spawned' && this.firstCommand === null) return null;
    if (this.dropped !== 'exists-now' && !existsSync(this.configPath)) return null;
    return { path: this.configPath, command: this.firstCommand ?? '(nothing ran)', note: '' };
  }
}

interface Mutation {
  name: string;
  dropped: Dropped;
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    /** The feature removed outright -- the state DEA-140 found the tool in. */
    name: 'never disclose',
    dropped: 'never',
    names: /^the file was absent and the spawn made it: silent/,
  },
  {
    /**
     * The banner. Discloses on every run that spawned anything, which is every run --
     * a line nobody can act on, printed to the ~100% of machines that already had the
     * file.
     */
    name: 'disclose without asking whether the file predated the run',
    dropped: 'existed-before',
    names: /^the config file was already there: disclosed "claude doctor"/,
  },
  {
    /**
     * "Check whether `~/.claude.json` exists" implemented without the *once, before the
     * first shell-out* half. By the time the report is written the subprocess has
     * created it, so the check is always true and the disclosure never fires -- the
     * failure mode that looks correct in review and is silent in production.
     */
    name: 'check for the file when the report is written, not before the run',
    dropped: 'checks-too-late',
    names: /^the file was absent and the spawn made it: silent/,
  },
  {
    /**
     * Absence plus presence, without asking whether this run spawned anything. Claims
     * credit for a file a concurrent session wrote.
     */
    name: 'disclose without asking whether anything was spawned',
    dropped: 'anything-spawned',
    names: /^the file appeared but nothing was spawned: disclosed "\(nothing ran\)"/,
  },
  {
    /**
     * Assumes a spawn is a write. On a machine with no `claude` on PATH every lookup
     * throws and nothing is created, and this tells the user they acquired a config
     * file that is not there.
     */
    name: 'assume the spawn wrote the file rather than checking',
    dropped: 'exists-now',
    names: /^the spawn was attempted and failed: disclosed "claude plugin list --json"/,
  },
  {
    /**
     * Names the wrong command. `??=` written as `=` still discloses, still discloses
     * exactly once, and attributes the write to whichever subcommand happened to run
     * last -- so the one fact the reader would act on is the one that is wrong.
     */
    name: 'name the last command instead of the first',
    dropped: 'first-wins',
    names: /^two commands ran: named "claude plugin details engineering"/,
  },
];

describe('the gate fails when the disclosure is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const make: Factory = (path, exec) => new Mutant(path, exec, mutation.dropped);
      const failures = RUNS.flatMap((run) => diff(run, run.play(make)));

      assert.ok(
        failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate -- that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      assert.ok(
        failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${failures.join('; ')}`,
      );
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  /** The positive control the six above are measured against. */
  test('and passes the real implementation', () => {
    assert.deepEqual(
      RUNS.flatMap((run) => diff(run, run.play(real))),
      [],
    );
  });
});
