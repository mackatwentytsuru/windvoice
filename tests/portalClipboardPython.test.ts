import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const helperDir = path.resolve('resources/native');

const PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_clipboard import (
    OwnerChangeBarrier,
    SelectionOwnerTimeout,
    apply_selection_and_wait_for_owner,
)

barrier = OwnerChangeBarrier()
results = []

# Every SetSelection needs a new owner-change acknowledgement. Merely still
# being the owner from the previous claim must not satisfy the next claim.
for _ in range(3):
    checkpoint = barrier.checkpoint()
    results.append(barrier.wait_until_owned(checkpoint, 0))
    barrier.owner_changed(True)
    results.append(barrier.wait_until_owned(checkpoint, 0))

# Losing ownership must also be visible, and a session reset must invalidate
# the previous session's last owned state.
barrier.owner_changed(False)
lost_checkpoint = barrier.checkpoint()
results.append(barrier.wait_until_owned(lost_checkpoint, 0))
barrier.reset()
reset_checkpoint = barrier.checkpoint()
results.append(barrier.wait_until_owned(reset_checkpoint, 0))

print(json.dumps(results))
`;

const CLAIM_PROBE = String.raw`
import json
import sys

sys.path.insert(0, sys.argv[1])
from portal_clipboard import (
    OwnerChangeBarrier,
    SelectionOwnerTimeout,
    apply_selection_and_wait_for_owner,
)

barrier = OwnerChangeBarrier()
barrier.owner_changed(True)
results = []

try:
    apply_selection_and_wait_for_owner(barrier, lambda: None, 0)
except SelectionOwnerTimeout:
    results.append('stale-owner-rejected')

for index in range(3):
    results.append(apply_selection_and_wait_for_owner(
        barrier,
        lambda: barrier.owner_changed(True),
        0,
    ))

print(json.dumps(results))
`;

describe('Wayland clipboard owner-change barrier', () => {
  it('requires a fresh ownership acknowledgement for every selection claim', () => {
    const run = spawnSync('python3', ['-c', PROBE, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      false
    ]);
  });

  it('does not treat an asynchronously forwarded SetSelection call as applied', () => {
    const run = spawnSync('python3', ['-c', CLAIM_PROBE, helperDir], {
      encoding: 'utf8'
    });

    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      'stale-owner-rejected',
      true,
      true,
      true
    ]);
  });
});
