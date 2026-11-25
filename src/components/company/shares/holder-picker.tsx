'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Person } from '@/domain/resolution/model';
import { getJson } from '@/components/resolution/api';

/** What a search result reads as in the list: enough to tell namesakes apart. */
export const optionText = (p: Pick<Person, 'id' | 'fullName'>) =>
  `${p.fullName} (ref ${p.id.slice(-6)})`;

/** The result a typed text picks: an exact option, or the only person with exactly that name. */
export function pickFrom(results: Pick<Person, 'id' | 'fullName'>[], text: string) {
  const typed = text.trim();
  const exact = results.find((p) => optionText(p) === typed);
  if (exact) return exact;
  const named = results.filter((p) => p.fullName.toLowerCase() === typed.toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

/**
 * One holder, chosen by searching people (GET /api/people?q=) rather than from a full list.
 * `value` is the chosen person's id; `name` is their name when it is already known.
 */
export function HolderPicker({
  label,
  value,
  name,
  required,
  onChange,
}: {
  label: string;
  value: string;
  name: string;
  required?: boolean;
  onChange: (id: string, name: string) => void;
}) {
  const [text, setText] = useState(name);
  const [results, setResults] = useState<Person[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // A name that loads after the panel opened fills the empty field.
  useEffect(() => {
    if (value && name) setText((t) => t || name);
  }, [value, name]);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2 || (value && q === name)) return;
    let live = true;
    const timer = window.setTimeout(() => {
      getJson<{ people: Person[] }>('/api/people?q=' + encodeURIComponent(q))
        .then((r) => live && setResults(r.people))
        .catch(() => live && setResults([]));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text, value, name]);
  // A typed name that matches no one is not a holder; the browser says so on submit.
  useEffect(() => {
    input.current?.setCustomValidity(
      text.trim() && !value ? 'Choose a person from the list, or add them under People first.' : '',
    );
  }, [text, value]);
  return (
    <label>
      {label}
      <input
        ref={input}
        list={listId}
        autoComplete="off"
        required={required}
        placeholder="Type a name"
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          const picked = pickFrom(results, next);
          setText(picked ? picked.fullName : next);
          onChange(picked?.id ?? '', picked?.fullName ?? '');
        }}
      />
      <datalist id={listId}>
        {results.map((p) => (
          <option key={p.id} value={optionText(p)} />
        ))}
      </datalist>
    </label>
  );
}
