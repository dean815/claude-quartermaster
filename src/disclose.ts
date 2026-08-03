/**
 * What this run did to the machine, as opposed to what it found on it.
 *
 * `qm` writes no Claude Code config. The `claude` subcommands it shells out to are not
 * so constrained: on a machine without `~/.claude.json`, `claude plugin list --json`,
 * `claude plugin details <name>` and `claude doctor` each create it -- eight keys
 * including a `machineID` and a `userID` the user did not have, and no `projects` key
 * at all (DEA-140). Measured against a temp HOME, where `claude --version` leaves the
 * directory clean: it is the subcommand, not the binary.
 *
 * The write belongs to the subprocess. The user-visible effect does not -- run the
 * read-only audit on a fresh machine, acquire a config file -- so every `claude` spawn
 * in this process goes through `run` below, and whether the file predated the run is
 * recorded when this module is imported, which is strictly before any of them.
 *
 * One door rather than a check at each call site. The gap existed because nothing held
 * an inventory of where quartermaster shells out: the brief that opened DEA-140 placed
 * `claude doctor` behind `--full`, and `doctorAdapter` in fact runs on every audit. A
 * funnel cannot drift from that inventory, and it is the only thing that knows which
 * command ran first -- the one the disclosure has to name.
 *
 * None of this is a finding. It has no severity and is not a property of the user's
 * configuration; it is a statement about this run, and it belongs beside `unreadable`
 * and `unchecked` rather than in the ranking.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A config file this run caused to exist, and the command that did it. */
export interface ConfigInit {
  path: string;
  /** The run's first `claude` invocation, verbatim. */
  command: string;
  /** The disclosure itself. One wording, so both output modes say the same thing. */
  note: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** The spawn, injectable so a test can drive the funnel without running `claude`. */
export type ClaudeExec = (args: readonly string[], opts: RunOptions) => string;

const spawn: ClaudeExec = (args, opts) =>
  execFileSync('claude', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: opts.timeoutMs ?? 30_000,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });

export class ClaudeCli {
  private readonly configPath: string;
  private readonly exec: ClaudeExec;
  /** Taken at construction -- import time, and so before anything can spawn. */
  private readonly existedBefore: boolean;
  private firstCommand: string | null = null;

  constructor(configPath: string, exec: ClaudeExec = spawn) {
    this.configPath = configPath;
    this.exec = exec;
    // `existsSync` and nothing else. Creating the file here to make the rest of this
    // simpler would be exactly the write the class exists to report.
    this.existedBefore = existsSync(configPath);
  }

  /**
   * Spawn `claude <args>`. Throws whatever `execFileSync` throws; every call site
   * already reads a failed lookup as "no answer" rather than as an error.
   */
  run(args: readonly string[], opts: RunOptions = {}): string {
    this.firstCommand ??= ['claude', ...args].join(' ');
    return this.exec(args, opts);
  }

  /**
   * Null unless this run is why the config file is there.
   *
   * Three conditions, and dropping any one of them turns a disclosure into a banner:
   * the file was absent when the run started, this run spawned something that could
   * have created it, and it is there now. The last is what stops a machine with no
   * `claude` on PATH -- every spawn throws, nothing is written -- from being told it
   * acquired a file.
   *
   * The day it fails: it watches one path. A first-party command that starts
   * initialising some *other* file goes unreported, and nothing here says what the
   * subprocess put inside the one it watches.
   */
  disclosure(): ConfigInit | null {
    if (this.existedBefore || this.firstCommand === null) return null;
    if (!existsSync(this.configPath)) return null;
    return {
      path: this.configPath,
      command: this.firstCommand,
      note:
        `${this.firstCommand} initialised ${this.configPath}; it did not exist before ` +
        'this run. quartermaster did not write it — the first-party CLI creates that ' +
        'file on first use.',
    };
  }
}

/** The process's one door to `claude`, watching the file a first run initialises. */
export const claudeCli = new ClaudeCli(join(homedir(), '.claude.json'));
