/**
 * Filing the one issue the oracle check has to file.
 *
 * This is the only outward-facing side effect anywhere in quartermaster, so it is kept
 * in its own file with one export that can reach the network, and that export is
 * constructed in exactly one place: behind `qm oracle --file-issue`. Every other path --
 * a bare `qm oracle`, every test, `qm audit` -- passes no filer at all, so filing is not
 * something a code path can fall into by forgetting a flag; there is nothing to forget.
 *
 * `fetch` and a hand-written mutation rather than `@linear/sdk`, because this repo has
 * no runtime dependencies and two GraphQL documents is not a reason to acquire one.
 *
 * The token is not read from the plist. A launchd `EnvironmentVariables` dict lives in
 * `~/Library/LaunchAgents` at mode 644, so putting an API key there publishes it to
 * every process the user runs; `LINEAR_API_KEY_FILE` points at a file the user chmods
 * themselves. `LINEAR_API_KEY` is still honoured for an interactive run.
 *
 * The day it fails: it resolves the team by key and creates an issue with no project, no
 * label, and no assignee. A workspace that requires any of those rejects the mutation,
 * and the run reports the failure rather than retrying with something invented.
 */
import { readFileSync } from 'node:fs';

import type { FiledIssue, IssueDraft, IssueFiler } from './oracle.ts';

const ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearConfig {
  apiKey: string;
  /** Team key, e.g. `DEA`. Resolved to an id at filing time. */
  teamKey: string;
}

/**
 * Configuration, or the reason there is none.
 *
 * A missing token is an error and never a silent downgrade to dry run. A scheduled job
 * that quietly stops filing is precisely the "silent job, broken job" case this issue is
 * about, one layer in.
 */
export function linearConfigFromEnv(env: NodeJS.ProcessEnv): LinearConfig | { error: string } {
  const teamKey = env['QM_LINEAR_TEAM'];
  if (!teamKey) {
    return { error: 'QM_LINEAR_TEAM is not set — it names the Linear team to file into, e.g. DEA' };
  }

  const inline = env['LINEAR_API_KEY'];
  if (inline) return { apiKey: inline, teamKey };

  const file = env['LINEAR_API_KEY_FILE'];
  if (!file) {
    return {
      error:
        'no Linear token — set LINEAR_API_KEY, or LINEAR_API_KEY_FILE to a chmod 600 file ' +
        'holding one (the scheduled agent uses the file, so the key stays out of the plist)',
    };
  }
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (!key) return { error: `LINEAR_API_KEY_FILE points at ${file}, which is empty` };
    return { apiKey: key, teamKey };
  } catch (err) {
    return { error: `LINEAR_API_KEY_FILE ${file} could not be read: ${String(err)}` };
  }
}

async function graphql(
  cfg: LinearConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: cfg.apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API returned ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`Linear API: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error('Linear API returned no data');
  return json.data;
}

const TEAM_QUERY = 'query($key:String!){teams(filter:{key:{eq:$key}}){nodes{id key}}}';
const CREATE = `mutation($teamId:String!,$title:String!,$description:String!){
  issueCreate(input:{teamId:$teamId,title:$title,description:$description}){
    success issue{identifier url}
  }
}`;

export function linearFiler(cfg: LinearConfig): IssueFiler {
  return async (draft: IssueDraft): Promise<FiledIssue> => {
    const teams = await graphql(cfg, TEAM_QUERY, { key: cfg.teamKey });
    const id = teams['teams']?.nodes?.[0]?.id;
    if (!id) throw new Error(`no Linear team with key ${cfg.teamKey}`);

    const created = await graphql(cfg, CREATE, {
      teamId: id,
      title: draft.title,
      description: draft.body,
    });
    const issue = created['issueCreate']?.issue;
    if (!created['issueCreate']?.success || !issue) throw new Error('Linear declined to create the issue');
    return { identifier: issue.identifier, url: issue.url };
  };
}
