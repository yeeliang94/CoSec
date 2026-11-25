import { describe, expect, it } from 'vitest';
import { checkShareClasses } from '../src/server/records/shares';

describe('share classes', () => {
  it('refuses two classes with the same reference, as well as the same name', () => {
    expect(() =>
      checkShareClasses(
        [
          { id: 'c1', name: 'ORDINARY', kind: 'Ordinary' },
          { id: 'c1', name: 'CLASS A', kind: 'Ordinary' },
        ],
        [],
        [],
      ),
    ).toThrow('Two share classes have the same reference.');
    expect(() =>
      checkShareClasses(
        [
          { id: 'c1', name: 'Ordinary', kind: 'Ordinary' },
          { id: 'c2', name: 'ORDINARY', kind: 'Ordinary' },
        ],
        [],
        [],
      ),
    ).toThrow('There are two classes called ORDINARY.');
    expect(() =>
      checkShareClasses(
        [
          { id: 'c1', name: 'ORDINARY', kind: 'Ordinary' },
          { id: 'c2', name: 'PREFERENCE', kind: 'Preference' },
        ],
        [],
        [],
      ),
    ).not.toThrow();
  });
});
