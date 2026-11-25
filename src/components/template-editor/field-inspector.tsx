'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import type {
  BlockNode,
  FieldDefinition,
  RecordFieldDefinition,
  RecordProperty,
  SignerRole,
  ValueType,
} from '@/domain/resolution/model';
import type { SelectionContext, TemplateEditorHandle } from './editor';
import { findFieldUsages, slugId, VALUE_TYPES, isRecord } from './fields';
import { PredicateEditor } from './predicate-editor';
import { PROPERTY_LABELS, ROLE_LABELS } from './nodes';
import { omit } from '@/domain/objects';
import { Icon } from '@/components/workspace';
import { FieldEditor } from './field-editor';

export type WordingRef = { key: string; name: string; blocks: BlockNode[] };

export function FieldInspector({
  title = 'Fields',
  fields,
  onFieldsChange,
  wordings,
  selection,
  editor,
  readOnly,
  defaultScope,
  reusable = [],
  customDefinitions = [],
  newQuestionRef,
  settingsRef,
}: {
  title?: string;
  fields: FieldDefinition[];
  onFieldsChange: (fields: FieldDefinition[]) => void;
  wordings: WordingRef[];
  selection: SelectionContext | null;
  editor: React.RefObject<TemplateEditorHandle | null>;
  readOnly: boolean;
  defaultScope: 'case' | 'clause';
  /** Shared (case-level) questions defined in other templates, offered for reuse by id. */
  reusable?: (FieldDefinition & { from: string })[];
  customDefinitions?: RecordFieldDefinition[];
  newQuestionRef?: React.RefObject<HTMLInputElement | null>;
  settingsRef?: React.RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [valueType, setValueType] = useState<ValueType>('text');
  const [scope, setScope] = useState<'case' | 'clause'>(defaultScope);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const ids = fields.map((field) => field.id);
  const update = (fieldId: string, change: (field: FieldDefinition) => FieldDefinition) =>
    onFieldsChange(fields.map((field) => (field.id === fieldId ? change(field) : field)));

  function create() {
    const text = label.trim();
    if (!text) return;
    const field: FieldDefinition = {
      id: slugId(text, ids),
      label: text,
      valueType,
      source: { kind: 'question' },
      scope,
      required: true,
      ...(valueType === 'choice' || valueType === 'multiChoice'
        ? { options: [{ id: 'option_1', label: 'Option 1' }] }
        : {}),
      ...(isRecord(valueType) ? { record: { context: 'currentDirectors' as const } } : {}),
    };
    onFieldsChange([...fields, field]);
    editor.current?.insertField(field.id, isRecord(valueType) ? 'name' : null);
    setLabel('');
    setEditing(field.id);
    newQuestionRef?.current?.closest('details')?.removeAttribute('open');
    setNotice(`Created ${field.label} and inserted it at the cursor`);
  }

  const term = search.trim().toLowerCase();
  const matchesTerm = (field: FieldDefinition) =>
    !term || `${field.label} ${field.id}`.toLowerCase().includes(term);
  const own = fields.filter(matchesTerm);
  const shared = useMemo(
    () => reusable.filter((field) => !ids.includes(field.id)),
    [reusable, ids],
  ).filter(matchesTerm);
  const insertShared = (field: FieldDefinition & { from: string }) => {
    onFieldsChange([...fields, omit(field, 'from')]);
    editor.current?.insertField(field.id, isRecord(field.valueType) ? 'name' : null);
    setNotice(`Inserted ${field.label}`);
  };
  const sharedList = (
    <ul className="field-pick-list" aria-label="Shared fields">
      {shared.slice(0, 30).map((field) => (
        <li key={field.from + field.id}>
          <span className="tb-field-name" title={`Shared from ${field.from}`}>
            {field.label}
          </span>
          <button
            type="button"
            className="tb-field-insert"
            aria-label={`Insert ${field.label}`}
            title={`Insert ${field.label}`}
            onClick={() => insertShared(field)}
          >
            <Icon kind="plus" />
          </button>
        </li>
      ))}
    </ul>
  );

  const recordFields = fields.filter((field) => field.valueType === 'recordList');
  const chip =
    selection?.kind === 'field' ||
    selection?.kind === 'choiceText' ||
    selection?.kind === 'checkbox'
      ? selection
      : null;
  const selectedField = chip ? fields.find((field) => field.id === chip.fieldId) : null;
  // Selecting a chip in the wording opens that field below the list.
  const chipField = chip ? chip.fieldId : null;
  const chipPos = chip ? chip.pos : null;
  const showAs = !chip
    ? ''
    : chip.kind === 'choiceText'
      ? chip.style
      : chip.kind === 'checkbox'
        ? 'checkbox'
        : 'field';
  useEffect(() => {
    if (chipField) setEditing(chipField);
  }, [chipField, chipPos]);
  const editingField = fields.find((field) => field.id === editing) ?? null;

  return (
    <div className="template-inspector">
      <p className="sr-only" role="status">
        {notice}
      </p>
      <h2 id={id + '-fields'}>{title}</h2>
      {readOnly ? null : (
        <details className="tb-new-field">
          <summary>New field</summary>
          <form
            className="form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <label>
              New question label
              <input
                ref={newQuestionRef}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={200}
              />
            </label>
            <label>
              Answer type
              <select
                value={valueType}
                onChange={(event) => setValueType(event.target.value as ValueType)}
              >
                {VALUE_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={scope === 'case'}
                onChange={(event) => setScope(event.target.checked ? 'case' : 'clause')}
              />
              Shared across wording (asked once)
            </label>
            <div className="actions">
              <button type="submit" disabled={!label.trim()}>
                Create and insert
              </button>
            </div>
          </form>
        </details>
      )}
      {fields.length || reusable.length ? (
        <label className="tb-field-search">
          <span className="sr-only">Find an existing field</span>
          <input
            type="search"
            placeholder="Find a field"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      ) : null}
      {own.length ? (
        <ul className="tb-field-list" aria-labelledby={id + '-fields'}>
          {own.map((field) => {
            const unused = !findFieldUsages(field.id, wordings, fields).length;
            const open = editing === field.id;
            return (
              <li key={field.id} className={open ? 'selected' : undefined}>
                <button
                  type="button"
                  className="tb-field-row"
                  aria-pressed={open}
                  aria-label={`${open ? 'Close' : readOnly ? 'View' : 'Edit'} ${field.label}${unused ? ', not used' : ''}`}
                  onClick={() => setEditing(open ? null : field.id)}
                >
                  <span className="tb-field-name" title={field.label}>
                    {field.label}
                  </span>
                  {unused ? <span className="tb-field-unused">Not used</span> : null}
                </button>
                <button
                  type="button"
                  className="tb-field-insert"
                  aria-label={`Insert ${field.label}`}
                  title={`Insert ${field.label}`}
                  disabled={readOnly}
                  onClick={() => {
                    editor.current?.insertField(
                      field.id,
                      isRecord(field.valueType) ? 'name' : null,
                    );
                    setNotice(`Inserted ${field.label}`);
                  }}
                >
                  <Icon kind="plus" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="metadata">{term ? 'No matching fields' : 'No fields yet'}</p>
      )}
      {readOnly || !shared.length ? null : term ? (
        sharedList
      ) : (
        <details className="tb-disclosure">
          <summary>Shared fields</summary>
          {sharedList}
        </details>
      )}

      {selection ? (
        <section
          className="inspector-section"
          ref={settingsRef as React.RefObject<HTMLElement>}
          tabIndex={-1}
          aria-labelledby={id + '-selected'}
        >
          <h3 id={id + '-selected'}>
            {chip
              ? selectedField?.label || 'Unknown field'
              : selection.kind === 'section'
                ? 'New page section'
                : selection.kind === 'condition'
                  ? 'Condition'
                  : selection.kind === 'repeat'
                    ? 'Repeat'
                    : selection.kind === 'clauseSlot'
                      ? 'Wording slot'
                      : 'Signature block'}
          </h3>
          <fieldset disabled={readOnly} className="plain-fieldset">
            {chip ? (
              <div className="form-stack">
                {!selectedField ? (
                  <p className="feedback error" role="alert">
                    Field {chip.fieldId} is missing. Remove this chip or create the field.
                  </p>
                ) : null}
                {selectedField?.valueType === 'choice' || chip.kind === 'choiceText' ? (
                  <label>
                    Show as
                    <select
                      value={showAs}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (value === 'field') editor.current?.setChipKind(chip.pos, 'field');
                        else {
                          if (chip.kind !== 'choiceText')
                            editor.current?.setChipKind(chip.pos, 'choiceText');
                          editor.current?.updateNode(chip.pos, { style: value });
                        }
                      }}
                    >
                      <option value="field">Chosen answer</option>
                      <option value="strikeOthers">All options, others struck</option>
                      <option value="omitOthers">Chosen option, others left out</option>
                    </select>
                  </label>
                ) : null}
                {chip.kind === 'choiceText' && chip.style === 'strikeOthers' ? (
                  <label>
                    Between options
                    <input
                      value={chip.separator ?? '/'}
                      maxLength={20}
                      onChange={(event) =>
                        editor.current?.updateNode(chip.pos, {
                          separator: event.target.value === '/' ? null : event.target.value,
                        })
                      }
                    />
                  </label>
                ) : null}
                {selectedField?.valueType === 'boolean' || chip.kind === 'checkbox' ? (
                  <label>
                    Show as
                    <select
                      value={showAs}
                      onChange={(event) =>
                        editor.current?.setChipKind(
                          chip.pos,
                          event.target.value === 'checkbox' ? 'checkbox' : 'field',
                        )
                      }
                    >
                      <option value="field">Yes or No</option>
                      <option value="checkbox">Tick box</option>
                    </select>
                  </label>
                ) : null}
                {selection.kind === 'field' &&
                selectedField &&
                isRecord(selectedField.valueType) ? (
                  <label>
                    Show
                    <select
                      value={selection.property || 'name'}
                      onChange={(event) =>
                        editor.current?.updateNode(selection.pos, {
                          property: event.target.value as RecordProperty,
                        })
                      }
                    >
                      {Object.entries(PROPERTY_LABELS).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text[0].toUpperCase() + text.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="actions">
                  {selectedField && editing !== selectedField.id ? (
                    <button type="button" onClick={() => setEditing(selectedField.id)}>
                      Edit {selectedField.label}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => editor.current?.deleteNode(selection.pos)}>
                    Remove chip
                  </button>
                </div>
              </div>
            ) : selection.kind === 'section' ? (
              <div className="form-stack">
                <label>
                  Orientation of the new page
                  <select
                    value={selection.orientation}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, {
                        orientation: event.target.value,
                      })
                    }
                  >
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => editor.current?.deleteNode(selection.pos)}
                >
                  Remove new page section
                </button>
              </div>
            ) : selection.kind === 'condition' ? (
              <div className="form-stack">
                <PredicateEditor
                  idPrefix={id + '-condition'}
                  value={selection.when}
                  fields={fields}
                  onChange={(when) => editor.current?.updateNode(selection.pos, { when })}
                />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => editor.current?.unwrapNode(selection.pos)}
                >
                  Remove condition and keep its text
                </button>
              </div>
            ) : selection.kind === 'repeat' ? (
              <div className="form-stack">
                <label>
                  Repeat for each person in
                  <select
                    value={selection.fieldId}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, { fieldId: event.target.value })
                    }
                  >
                    <option value="">Choose a list field…</option>
                    {recordFields.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!recordFields.length ? (
                  <p className="metadata">
                    Create a field of type &ldquo;People from records&rdquo; to repeat over.
                  </p>
                ) : null}
                <label>
                  Text when nobody is selected
                  <input
                    value={selection.emptyText || ''}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, {
                        emptyText: event.target.value || null,
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => editor.current?.unwrapNode(selection.pos)}
                >
                  Remove repeat and keep its text
                </button>
              </div>
            ) : selection.kind === 'clauseSlot' ? (
              <div className="form-stack">
                <label>
                  Wording numbering
                  <select
                    value={selection.numbering}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, { numbering: event.target.value })
                    }
                  >
                    <option value="decimal">Numbered 1, 2, 3</option>
                    <option value="none">Not numbered</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => editor.current?.deleteNode(selection.pos)}
                >
                  Remove wording slot
                </button>
              </div>
            ) : selection.kind === 'signatureBlock' ? (
              <div className="form-stack">
                <label>
                  Signer role
                  <select
                    value={selection.role}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, {
                        role: event.target.value as SignerRole,
                      })
                    }
                  >
                    {Object.entries(ROLE_LABELS).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Heading above signatures
                  <input
                    value={selection.heading || ''}
                    onChange={(event) =>
                      editor.current?.updateNode(selection.pos, {
                        heading: event.target.value || null,
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => editor.current?.deleteNode(selection.pos)}
                >
                  Remove signature block
                </button>
              </div>
            ) : null}
          </fieldset>
        </section>
      ) : null}

      {editingField ? (
        <section className="inspector-section" aria-label={`Settings for ${editingField.label}`}>
          {selectedField?.id !== editingField.id ? <h3>{editingField.label}</h3> : null}
          <FieldEditor
            field={editingField}
            fields={fields}
            usages={findFieldUsages(editingField.id, wordings, fields).map((usage) => usage.place)}
            readOnly={readOnly}
            customDefinitions={customDefinitions}
            onChange={(change) => update(editingField.id, change)}
            onDelete={() => {
              onFieldsChange(fields.filter((item) => item.id !== editingField.id));
              setEditing(null);
              setNotice(`Deleted ${editingField.label}`);
            }}
          />
        </section>
      ) : null}
    </div>
  );
}
