'use client';
import { useId } from 'react';
import { requiredAddressParts, type Address, type AddressPart } from '@/domain/address';
import { COUNTRIES, STATES } from '@/domain/ar1/mtool-lists';
import { WarningLine } from '@/components/warning-line';

/** A structured address in mTool's parts; postcode, town and state are needed in Malaysia. */
export function AddressFields({
  value,
  onChange,
  problems = [],
  missing = false,
  countries = COUNTRIES,
}: {
  value: Address;
  onChange: (next: Address) => void;
  problems?: { part: AddressPart; message: string }[];
  /** Marks the required parts that are empty, for the annual return's missing items. */
  missing?: boolean;
  countries?: readonly string[];
}) {
  const malaysia = value.Country === 'MALAYSIA';
  const set = (part: AddressPart) => (text: string) => onChange({ ...value, [part]: text });
  const required = requiredAddressParts(value);
  const uid = useId();
  const problemOf = (part: AddressPart) => problems.find((p) => p.part === part);
  /** The warning sits under the control, outside the label, and is tied to it. */
  const describedBy = (part: AddressPart) => (problemOf(part) ? `${uid}-${part}` : undefined);
  const field = (part: AddressPart, label: string, control: React.ReactNode) => {
    const problem = problemOf(part);
    const labelled = (
      <label key={part}>
        {label}
        {control}
      </label>
    );
    return problem ? (
      <div key={part}>
        {labelled}
        <WarningLine field blocking id={describedBy(part)}>
          {problem.message}
        </WarningLine>
      </div>
    ) : (
      labelled
    );
  };
  const empty = (part: AddressPart) => missing && required.includes(part) && !value[part].trim();
  const text = (
    part: AddressPart,
    label: string,
    extra?: React.InputHTMLAttributes<HTMLInputElement>,
  ) =>
    field(
      part,
      label,
      <input
        maxLength={255}
        value={value[part]}
        className={empty(part) ? 'missing' : undefined}
        aria-invalid={empty(part) || Boolean(problemOf(part)) || undefined}
        aria-describedby={describedBy(part)}
        onChange={(event) => set(part)(event.target.value)}
        {...extra}
      />,
    );
  const select = (part: AddressPart, label: string, options: readonly string[]) =>
    field(
      part,
      label,
      <select
        value={value[part]}
        className={empty(part) ? 'missing' : undefined}
        aria-invalid={empty(part) || Boolean(problemOf(part)) || undefined}
        aria-describedby={describedBy(part)}
        onChange={(event) => set(part)(event.target.value)}
      >
        <option value="">Select…</option>
        {value[part] && !options.includes(value[part]) ? (
          <option value={value[part]}>{value[part]}</option>
        ) : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>,
    );
  return (
    <>
      {text('Line1', 'Line 1')}
      {text('Line2', 'Line 2 (optional)')}
      {text('Line3', 'Line 3 (optional)')}
      {select('Country', 'Country', countries)}
      {text('Postcode', malaysia ? 'Postcode' : 'Postcode (optional)', {
        inputMode: 'numeric',
        maxLength: 20,
      })}
      {text('Town', malaysia ? 'Town' : 'Town (optional)')}
      {malaysia || value.State ? select('State', 'State', STATES) : null}
    </>
  );
}
