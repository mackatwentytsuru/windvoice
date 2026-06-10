import { describe, it, expect } from 'vitest';
import type { AppProfile } from '@shared/types';
import { profileRowKeys } from '@renderer/pages/AppModes';

// The deletable profile list previously used `key={index}`, which makes
// React reuse the following sibling's element state when an earlier row
// is deleted. `profileRowKeys` derives content-based keys instead (no
// schema change — AppProfile has no `id` field), so each row's identity
// stays attached to its data across deletions.
describe('profileRowKeys', () => {
  const p = (match: string, instructions = ''): AppProfile => ({ match, instructions });

  it('returns one unique key per row', () => {
    const keys = profileRowKeys([p('code', 'a'), p('slack', 'b'), p('terminal', 'c')]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps the surviving rows’ keys stable when an earlier row is deleted', () => {
    const rows = [p('code', 'a'), p('slack', 'b'), p('terminal', 'c')];
    const before = profileRowKeys(rows);
    // Delete the first row — with key={index} the old keys 0/1 would now
    // point at what used to be rows 1/2; content keys must not shift.
    const after = profileRowKeys(rows.slice(1));
    expect(after).toEqual([before[1], before[2]]);
  });

  it('does not collide when one row’s match equals another row’s instructions', () => {
    // The NUL separator cannot be typed into the inputs, so field-spanning
    // concatenations ("ab" + "c" vs "a" + "bc") stay distinct.
    const keys = profileRowKeys([p('ab', 'c'), p('a', 'bc')]);
    expect(new Set(keys).size).toBe(2);
  });

  it('disambiguates exact-duplicate profiles with an occurrence counter', () => {
    const keys = profileRowKeys([p('slack', 'same'), p('slack', 'same'), p('slack', 'same')]);
    expect(new Set(keys).size).toBe(3);
    // The first occurrence keeps the bare content key, so deleting a LATER
    // duplicate never reassigns the earlier rows' identities.
    const afterDeletingLast = profileRowKeys([p('slack', 'same'), p('slack', 'same')]);
    expect(afterDeletingLast).toEqual([keys[0], keys[1]]);
  });
});
