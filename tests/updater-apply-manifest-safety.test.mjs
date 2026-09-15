/**
 * updater-apply-manifest-safety.test.mjs — reproduction coverage for issue 3825.
 *
 * apply() reads SYSTEM_PATHS from the TARGET updater and then checks each entry
 * out of FETCH_HEAD in a raw loop. Two properties are worth pinning separately:
 *
 *   1. the raw git checkout semantics the updater is currently relying on, so
 *      the hazard is reproduced behaviorally rather than only described; and
 *   2. the apply() source still wires those raw semantics straight to the target
 *      manifest, unfiltered and without --literal-pathspecs.
 *
 * The behavioral probes are the oracle. The source assertions are the failing
 * regression checks that should go green only once apply() stops doing this.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT, makeUpdaterRepo, rmSync } from './helpers.mjs';
import { gitIn } from '../update-system.mjs';

const makeRepo = () => makeUpdaterRepo(gitIn, { prefix: 'co-apply-manifest-', includeRoot: true });
const source = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');

console.log('\n🧪 apply() target-manifest checkout safety (issue 3825)...');

// ── 1. Oracle: a raw checkout named by the manifest overwrites local .env ──
//    This is the concrete "unfiltered target manifest" shape from the report:
//    a path the user treats as local-only is harmless until apply() feeds it to
//    `git checkout <ref> -- <path>`.
{
  const { dir, g } = makeRepo();
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  g('add', '.gitignore');
  g('commit', '-qm', 'base');

  g('checkout', '-q', '-b', 'upstream');
  writeFileSync(join(dir, '.env'), 'UPSTREAM=1\n');
  g('add', '-f', '.env');
  g('commit', '-qm', 'upstream adds dot env');

  g('checkout', '-q', 'main');
  writeFileSync(join(dir, '.env'), 'LOCAL=secret\n');
  g('checkout', 'upstream', '--', '.env');

  const got = readFileSync(join(dir, '.env'), 'utf-8');
  if (got === 'UPSTREAM=1\n') {
    pass('oracle: raw checkout overwrites a local untracked .env when the manifest names it');
  } else {
    fail(`oracle broke: expected upstream content in .env, got ${JSON.stringify(got)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── 2. Oracle: a bracket filename is a glob without --literal-pathspecs ──
//    `--` ends option parsing, not pathspec parsing. A manifest entry whose NAME
//    contains pathspec syntax still matches its siblings unless checkout is run
//    under --literal-pathspecs too.
{
  const { dir, g } = makeRepo();
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/[x].md'), 'base bracket\n');
  writeFileSync(join(dir, 'docs/x.md'), 'base sibling\n');
  g('add', '-A');
  g('commit', '-qm', 'base docs');

  g('checkout', '-q', '-b', 'upstream');
  writeFileSync(join(dir, 'docs/[x].md'), 'upstream bracket\n');
  writeFileSync(join(dir, 'docs/x.md'), 'upstream sibling\n');
  g('commit', '-qam', 'upstream docs');

  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'docs/[x].md'), 'local bracket\n');
  writeFileSync(join(dir, 'docs/x.md'), 'local sibling\n');
  g('checkout', 'upstream', '--', 'docs/[x].md');

  const bracket = readFileSync(join(dir, 'docs/[x].md'), 'utf-8');
  const sibling = readFileSync(join(dir, 'docs/x.md'), 'utf-8');
  const staged = g('diff', '--cached', '--name-only', '-z', 'HEAD').split('\0').filter(Boolean);
  if (bracket === 'upstream bracket\n' && sibling === 'upstream sibling\n' && staged.includes('docs/x.md')) {
    pass('oracle: raw checkout treats a bracket filename as a glob and updates its sibling too');
  } else {
    fail(`oracle broke: bracket=${JSON.stringify(bracket)} sibling=${JSON.stringify(sibling)} staged=${JSON.stringify(staged)}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. Regression guard: apply() still merges target manifest entries raw ──
//    Keep this intentionally broad: the bug is the direct flow from
//    remoteSystemPaths into updatePaths with no safety step in between.
if (/const updatePaths = mergePathLists\(SYSTEM_PATHS,\s*remoteSystemPaths,\s*BOOTSTRAP_PATHS\);/.test(source)) {
  fail('apply() still merges remoteSystemPaths into updatePaths with no filtering step');
} else {
  pass('apply() no longer merges remoteSystemPaths raw');
}

// ── 4. Regression guard: apply() checkout still omits --literal-pathspecs ──
if (/gitQuiet\('checkout',\s*'FETCH_HEAD',\s*'--',\s*path,\s*\.\.\.preserveSpecs\)/.test(source)) {
  fail('apply() still checks manifest paths out of FETCH_HEAD without --literal-pathspecs');
} else {
  pass('apply() checkout uses --literal-pathspecs');
}
