'use client';
/**
 * A single-line rich editor for inline content (the running page header and footer). It holds
 * text with marks, line breaks already saved, and the same value chips as the template editor;
 * Enter does nothing.
 */
import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorContent, Extension, Node, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { FieldDefinition, InlineNode } from '@/domain/resolution/model';
import { fromTiptap, toTiptap, tokensToFields, type ConvertIssue } from './convert';
import { contextOf, replaceChip, type SelectionContext, type TemplateEditorHandle } from './editor';
import { CheckboxChip, ChoiceTextChip, FieldChip, TemplateFieldsContext } from './nodes';
import { isRecord } from './fields';

const SingleLineDocument = Node.create({ name: 'doc', topNode: true, content: 'paragraph' });
// Runs before StarterKit's hard-break shortcuts, so no key adds a line; breaks already saved in
// a header (the disclosure notice has two) still load and save unchanged.
const NoEnter = Extension.create({
  name: 'singleLine',
  priority: 1000,
  addKeyboardShortcuts() {
    return { Enter: () => true, 'Shift-Enter': () => true, 'Mod-Enter': () => true };
  },
});

export function InlineEditor({
  value,
  label,
  fields,
  readOnly = false,
  onChange,
  onSelection,
  onFocus,
  handleRef,
}: {
  value: InlineNode[];
  label: string;
  fields: FieldDefinition[];
  readOnly?: boolean;
  onChange: (nodes: InlineNode[], issues: ConvertIssue[]) => void;
  onSelection?: (context: SelectionContext | null) => void;
  onFocus?: () => void;
  handleRef?: React.Ref<TemplateEditorHandle>;
}) {
  const initial = useMemo(
    () => toTiptap([{ type: 'paragraph', content: tokensToFields(value) }], 'assembly'),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const callbacks = useRef({ onChange, onSelection, onFocus });
  callbacks.current = { onChange, onSelection, onFocus };
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        document: false,
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: false,
        trailingNode: false,
        dropcursor: false,
        gapcursor: false,
      }),
      SingleLineDocument,
      NoEnter,
      FieldChip,
      ChoiceTextChip,
      CheckboxChip,
    ],
    content: initial.doc,
    editorProps: {
      attributes: {
        'aria-label': label,
        role: 'textbox',
        class: 'inline-editor-content',
      },
    },
    onUpdate: ({ editor }) => {
      const result = fromTiptap(editor.getJSON() as never, 'assembly');
      const first = result.blocks[0];
      callbacks.current.onChange(first?.type === 'paragraph' ? first.content : [], result.issues);
    },
    onSelectionUpdate: ({ editor }) => callbacks.current.onSelection?.(contextOf(editor)),
    onFocus: ({ editor }) => {
      callbacks.current.onFocus?.();
      callbacks.current.onSelection?.(contextOf(editor));
    },
  });
  useEffect(() => {
    if (editor && editor.isEditable === readOnly) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  const insert = (fieldId: string, property: string | null = null) => {
    if (!editor) return;
    editor.view.focus();
    editor.chain().insertContent({ type: 'field', attrs: { fieldId, property } }).run();
  };
  useImperativeHandle(
    handleRef,
    () => ({
      insertField: (fieldId, property = null) => insert(fieldId, property),
      updateNode(pos, attrs) {
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
      setChipKind(pos, kind) {
        if (!editor) return;
        replaceChip(editor, pos, kind);
        callbacks.current.onSelection?.(contextOf(editor));
      },
      unwrapNode() {},
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
      focusBlock() {
        editor?.commands.focus();
      },
      focus() {
        editor?.commands.focus();
      },
    }),
    [editor], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const mark = (name: string, text: string, type: 'bold' | 'italic' | 'underline' | 'strike') => (
    <button
      type="button"
      aria-label={name}
      title={name}
      aria-pressed={editor?.isActive(type) ?? false}
      className={editor?.isActive(type) ? 'active' : ''}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => editor?.chain().focus().toggleMark(type).run()}
    >
      {text}
    </button>
  );
  return (
    <TemplateFieldsContext.Provider
      value={{
        fields,
        onEdit: (pos) => {
          editor?.chain().setNodeSelection(pos).run();
          if (editor) callbacks.current.onSelection?.(contextOf(editor));
        },
      }}
    >
      <div className="inline-editor">
        {readOnly || !editor ? null : (
          <div
            className="editor-toolbar inline-editor-toolbar"
            role="group"
            aria-label={`${label} formatting`}
          >
            {mark('Bold', 'B', 'bold')}
            {mark('Italic', 'I', 'italic')}
            {mark('Underline', 'U', 'underline')}
            {mark('Strikethrough', 'S', 'strike')}
            <select
              aria-label={`Insert a field into the ${label.toLowerCase()}`}
              value=""
              disabled={!fields.length}
              onChange={(event) => {
                const field = fields.find((item) => item.id === event.target.value);
                if (field) insert(field.id, isRecord(field.valueType) ? 'name' : null);
              }}
            >
              <option value="">Insert field…</option>
              {fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="inline-editor-canvas">
          <EditorContent editor={editor} />
        </div>
      </div>
    </TemplateFieldsContext.Provider>
  );
}
