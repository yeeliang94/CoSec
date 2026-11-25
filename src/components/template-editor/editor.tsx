'use client';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { NodeSelection } from '@tiptap/pm/state';
import type {
  BlockNode,
  FieldDefinition,
  Predicate,
  RecordProperty,
  SignerRole,
} from '@/domain/resolution/model';
import { fromTiptap, toTiptap, type ConvertIssue, type ConvertMode } from './convert';
import {
  CheckboxChip,
  ChoiceTextChip,
  ClauseSlot,
  Condition,
  FieldChip,
  Indent,
  PageBreak,
  Repeat,
  SectionBreak,
  SignatureBlock,
  TemplateFieldsContext,
  TemplateTable,
} from './nodes';

/** The three ways a field chip can print its value. */
export type ChipKind = 'field' | 'choiceText' | 'checkbox';
export type ChoiceStyle = 'strikeOthers' | 'omitOthers';

export type SelectionContext =
  | { kind: 'field'; pos: number; fieldId: string; property: RecordProperty | null }
  | {
      kind: 'choiceText';
      pos: number;
      fieldId: string;
      style: ChoiceStyle;
      separator: string | null;
    }
  | { kind: 'checkbox'; pos: number; fieldId: string }
  | { kind: 'section'; pos: number; orientation: 'portrait' | 'landscape' }
  | { kind: 'condition'; pos: number; when: Predicate | null }
  | { kind: 'repeat'; pos: number; fieldId: string; emptyText: string | null }
  | { kind: 'clauseSlot'; pos: number; numbering: 'none' | 'decimal' }
  | { kind: 'signatureBlock'; pos: number; role: SignerRole; heading: string | null };

export type TemplateEditorHandle = {
  insertField: (fieldId: string, property?: RecordProperty | null) => void;
  updateNode: (pos: number, attrs: Record<string, unknown>) => void;
  /** Changes how a field chip prints (value, options or tick box), keeping its field. */
  setChipKind: (pos: number, kind: ChipKind) => void;
  unwrapNode: (pos: number) => void;
  deleteNode: (pos: number) => void;
  focusBlock: (index: number) => void;
  focus: () => void;
};

/** Swaps a value chip for another kind at the same place, keeping the field id. */
export function replaceChip(editor: Editor, pos: number, kind: ChipKind) {
  editor
    .chain()
    .command(({ tr, state }) => {
      const node = tr.doc.nodeAt(pos);
      const type = state.schema.nodes[kind];
      if (!node || !type || !['field', 'choiceText', 'checkbox'].includes(node.type.name))
        return false;
      const fieldId = node.attrs.fieldId;
      const attrs =
        kind === 'field'
          ? { fieldId, property: null }
          : kind === 'choiceText'
            ? { fieldId, style: 'strikeOthers', separator: null }
            : { fieldId };
      tr.replaceWith(pos, pos + node.nodeSize, type.create(attrs));
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      return true;
    })
    .run();
}

export function contextOf(editor: Editor): SelectionContext | null {
  const { selection } = editor.state;
  const describe = (
    name: string,
    pos: number,
    attrs: Record<string, unknown>,
  ): SelectionContext | null => {
    switch (name) {
      case 'field':
        return {
          kind: 'field',
          pos,
          fieldId: String(attrs.fieldId || ''),
          property: (attrs.property as RecordProperty) || null,
        };
      case 'choiceText':
        return {
          kind: 'choiceText',
          pos,
          fieldId: String(attrs.fieldId || ''),
          style: attrs.style === 'omitOthers' ? 'omitOthers' : 'strikeOthers',
          separator: typeof attrs.separator === 'string' ? attrs.separator : null,
        };
      case 'checkbox':
        return { kind: 'checkbox', pos, fieldId: String(attrs.fieldId || '') };
      case 'section':
        return {
          kind: 'section',
          pos,
          orientation: attrs.orientation === 'portrait' ? 'portrait' : 'landscape',
        };
      case 'condition':
        return { kind: 'condition', pos, when: (attrs.when as Predicate) || null };
      case 'repeat':
        return {
          kind: 'repeat',
          pos,
          fieldId: String(attrs.fieldId || ''),
          emptyText: (attrs.emptyText as string) ?? null,
        };
      case 'clauseSlot':
        return {
          kind: 'clauseSlot',
          pos,
          numbering: attrs.numbering === 'none' ? 'none' : 'decimal',
        };
      case 'signatureBlock':
        return {
          kind: 'signatureBlock',
          pos,
          role: attrs.role as SignerRole,
          heading: (attrs.heading as string) || null,
        };
      default:
        return null;
    }
  };
  if (selection instanceof NodeSelection) {
    const found = describe(selection.node.type.name, selection.from, selection.node.attrs);
    if (found) return found;
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'condition' || node.type.name === 'repeat')
      return describe(node.type.name, $from.before(depth), node.attrs);
  }
  return null;
}

export function TemplateEditor({
  value,
  mode,
  label,
  fields,
  readOnly = false,
  onChange,
  onIssues,
  onSelection,
  onRequestField,
  onEditNode,
  handleRef,
}: {
  value: BlockNode[];
  mode: ConvertMode;
  label: string;
  fields: FieldDefinition[];
  readOnly?: boolean;
  onChange: (blocks: BlockNode[], issues: ConvertIssue[]) => void;
  /** Problems found while loading stored content; they stay until the content is reloaded. */
  onIssues?: (issues: ConvertIssue[]) => void;
  onSelection?: (context: SelectionContext | null) => void;
  onRequestField?: () => void;
  onEditNode?: () => void;
  handleRef?: React.Ref<TemplateEditorHandle>;
}) {
  const initial = useMemo(() => toTiptap(value, mode), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Content lost on load blocks saving for this editor's life. Placeholder issues are re-reported
  // by fromTiptap while the placeholder remains, so they clear once it is removed.
  const loadIssues = useRef(initial.issues.filter((issue) => !issue.live));
  const callbacks = useRef({ onChange, onSelection });
  callbacks.current = { onChange, onSelection };
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: false,
        trailingNode: false,
      }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Indent,
      TemplateTable,
      TableRow,
      TableHeader,
      TableCell,
      FieldChip,
      ChoiceTextChip,
      CheckboxChip,
      Condition,
      Repeat,
      PageBreak,
      SectionBreak,
      ...(mode === 'assembly' ? [ClauseSlot, SignatureBlock] : []),
    ],
    content: initial.doc,
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
        class: 'template-canvas-content',
      },
    },
    onUpdate: ({ editor }) => {
      const result = fromTiptap(editor.getJSON() as never, mode);
      callbacks.current.onChange(result.blocks, [...loadIssues.current, ...result.issues]);
    },
    onSelectionUpdate: ({ editor }) => callbacks.current.onSelection?.(contextOf(editor)),
  });
  useEffect(() => {
    if (initial.issues.length) onIssues?.(initial.issues);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Changing editability must not count as an edit.
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  const updateNode = useCallback(
    (pos: number, attrs: Record<string, unknown>) => {
      if (!editor) return;
      editor
        .chain()
        .command(({ tr }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node) return false;
          // Attribute steps keep a selected chip selected (a markup change would replace it).
          for (const [key, value] of Object.entries(attrs)) tr.setNodeAttribute(pos, key, value);
          return true;
        })
        .run();
      callbacks.current.onSelection?.(contextOf(editor));
    },
    [editor],
  );
  const setChipKind = useCallback(
    (pos: number, kind: ChipKind) => {
      if (editor) replaceChip(editor, pos, kind);
      if (editor) callbacks.current.onSelection?.(contextOf(editor));
    },
    [editor],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      insertField(fieldId, property = null) {
        if (!editor) return;
        // Focus synchronously so typing continues in the canvas, not on the clicked button.
        editor.view.focus();
        editor.chain().insertContent({ type: 'field', attrs: { fieldId, property } }).run();
      },
      updateNode,
      setChipKind,
      unwrapNode(pos) {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            const node = tr.doc.nodeAt(pos);
            if (!node) return false;
            tr.replaceWith(pos, pos + node.nodeSize, node.content);
            return true;
          })
          .run();
      },
      deleteNode(pos) {
        if (!editor) return;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            const node = tr.doc.nodeAt(pos);
            if (!node) return false;
            tr.delete(pos, pos + node.nodeSize);
            return true;
          })
          .run();
      },
      focusBlock(index) {
        if (!editor) return;
        let target = -1;
        editor.state.doc.forEach((_node, offset, i) => {
          if (i === index) target = offset;
        });
        if (target < 0) return;
        editor
          .chain()
          .focus()
          .setTextSelection(target + 1)
          .scrollIntoView()
          .run();
        editor.view.dom.closest('.template-editor')?.scrollIntoView({ block: 'nearest' });
      },
      focus() {
        editor?.commands.focus();
      },
    }),
    [editor, updateNode, setChipKind],
  );

  const editNode = useCallback(
    (pos: number) => {
      if (!editor) return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      if (node.isAtom) editor.chain().setNodeSelection(pos).run();
      else
        editor
          .chain()
          .setTextSelection(pos + 2)
          .run();
      callbacks.current.onSelection?.(contextOf(editor));
      onEditNode?.();
    },
    [editor, onEditNode],
  );

  return (
    <TemplateFieldsContext.Provider value={{ fields, onEdit: editNode }}>
      <div className="template-editor">
        {readOnly || !editor ? null : (
          <Toolbar
            editor={editor}
            mode={mode}
            onRequestField={onRequestField}
            onEditNode={() => {
              callbacks.current.onSelection?.(contextOf(editor));
              onEditNode?.();
            }}
          />
        )}
        <div className="template-canvas">
          <EditorContent editor={editor} />
          {!editor ? (
            <div className="skeleton" role="status">
              Loading editor…
            </div>
          ) : null}
        </div>
      </div>
    </TemplateFieldsContext.Provider>
  );
}

function Toolbar({
  editor,
  mode,
  onRequestField,
  onEditNode,
}: {
  editor: Editor;
  mode: ConvertMode;
  onRequestField?: () => void;
  onEditNode: () => void;
}) {
  const chain = () => editor.chain().focus();
  const inTable = editor.isActive('table');
  const style = editor.isActive('heading', { level: 1 })
    ? '1'
    : editor.isActive('heading', { level: 2 })
      ? '2'
      : editor.isActive('heading', { level: 3 })
        ? '3'
        : 'p';
  const button = (
    name: string,
    text: string,
    run: () => unknown,
    active?: boolean,
    disabled?: boolean,
  ) => (
    <button
      type="button"
      key={name}
      aria-label={name}
      title={name}
      aria-pressed={active === undefined ? undefined : active}
      className={active ? 'active' : ''}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => run()}
    >
      {text}
    </button>
  );
  const insertBlock = (type: 'condition' | 'repeat') => {
    const attrs = type === 'condition' ? { when: null } : { fieldId: '', emptyText: null };
    const ok = chain().wrapIn(type, attrs).run();
    if (!ok)
      chain()
        .insertContent({ type, attrs, content: [{ type: 'paragraph' }] })
        .run();
    onEditNode();
  };
  return (
    <div className="editor-toolbar template-toolbar" role="group" aria-label="Template formatting">
      <select
        aria-label="Text style"
        value={style}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'p') chain().setParagraph().run();
          else
            chain()
              .setHeading({ level: Number(value) as 1 | 2 | 3 })
              .run();
        }}
      >
        <option value="p">Paragraph</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>
      <span className="toolbar-group">
        {button('Bold', 'B', () => chain().toggleBold().run(), editor.isActive('bold'))}
        {button('Italic', 'I', () => chain().toggleItalic().run(), editor.isActive('italic'))}
        {button(
          'Underline',
          'U',
          () => chain().toggleUnderline().run(),
          editor.isActive('underline'),
        )}
        {button(
          'Strikethrough',
          'S',
          () => chain().toggleStrike().run(),
          editor.isActive('strike'),
        )}
      </span>
      <span className="toolbar-group">
        {(['left', 'center', 'right', 'justify'] as const).map((align) =>
          button(
            `Align ${align === 'center' ? 'centre' : align}`,
            align === 'left'
              ? 'Left'
              : align === 'center'
                ? 'Centre'
                : align === 'right'
                  ? 'Right'
                  : 'Justify',
            () => chain().setTextAlign(align).run(),
            editor.isActive({ textAlign: align }),
          ),
        )}
      </span>
      <span className="toolbar-group">
        {button(
          'Bulleted list',
          '• List',
          () => chain().toggleBulletList().run(),
          editor.isActive('bulletList'),
        )}
        {button(
          'Numbered list',
          '1. List',
          () => chain().toggleOrderedList().run(),
          editor.isActive('orderedList'),
        )}
        {button('Indent', 'Indent', () => chain().indent().run())}
        {button('Outdent', 'Outdent', () => chain().outdent().run())}
      </span>
      <span className="toolbar-group">
        {inTable ? (
          <>
            {button('Add row', '+ Row', () => chain().addRowAfter().run())}
            {button('Remove row', '− Row', () => chain().deleteRow().run())}
            {button('Add column', '+ Column', () => chain().addColumnAfter().run())}
            {button('Remove column', '− Column', () => chain().deleteColumn().run())}
            {button('Header row', 'Header row', () => chain().toggleHeaderRow().run())}
            <select
              aria-label="Table lines"
              title="Table lines"
              value={String(editor.getAttributes('table').border || 'grid')}
              onChange={(event) =>
                chain().updateAttributes('table', { border: event.target.value }).run()
              }
            >
              <option value="grid">All lines</option>
              <option value="outer">Outer box</option>
              <option value="none">No lines</option>
            </select>
            {button('Remove table', 'Remove table', () => chain().deleteTable().run())}
          </>
        ) : (
          button('Insert table', 'Table', () =>
            chain().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run(),
          )
        )}
        {button('Insert page break', 'Page break', () =>
          chain().insertContent({ type: 'pageBreak' }).run(),
        )}
        {button('Insert new page section', 'New page section', () => {
          chain()
            .insertContent({ type: 'section', attrs: { orientation: 'landscape' } })
            .run();
          onEditNode();
        })}
      </span>
      <span className="toolbar-group">
        {button('Insert field', 'Field', () => onRequestField?.())}
        {button('Insert condition', 'Condition', () => insertBlock('condition'))}
        {button('Insert repeat', 'Repeat', () => insertBlock('repeat'))}
        {mode === 'assembly' ? (
          <>
            {button('Insert wording slot', 'Wording slot', () => {
              chain()
                .insertContent({ type: 'clauseSlot', attrs: { numbering: 'decimal' } })
                .run();
            })}
            {button('Insert signature block', 'Signatures', () => {
              chain()
                .insertContent({ type: 'signatureBlock', attrs: { role: 'directors' } })
                .run();
              onEditNode();
            })}
          </>
        ) : null}
      </span>
      <span className="toolbar-group">
        {button('Undo', 'Undo', () => chain().undo().run(), undefined, !editor.can().undo())}
        {button('Redo', 'Redo', () => chain().redo().run(), undefined, !editor.can().redo())}
      </span>
    </div>
  );
}
