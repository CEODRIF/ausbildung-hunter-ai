"use client";

import { useEffect, useRef } from "react";

const tools = [
  { label: "Bold", command: "bold", icon: "B" },
  { label: "Italic", command: "italic", icon: "I" },
  { label: "Underline", command: "underline", icon: "U" },
  { label: "Bulleted list", command: "insertUnorderedList", icon: "•" },
  { label: "Numbered list", command: "insertOrderedList", icon: "1." },
  { label: "Align left", command: "justifyLeft", icon: "≡" },
  { label: "Align center", command: "justifyCenter", icon: "≡" },
  { label: "Undo", command: "undo", icon: "↶" },
  { label: "Redo", command: "redo", icon: "↷" },
];

/**
 * Smart personalization variables. The displayed labels follow the
 * product's Arabic copy; the stored tokens are the stable, unambiguous
 * ones from lib/personalization (rendered per recipient on the server
 * before sending — the editor itself only ever stores the token).
 */
const variables = [
  {
    token: "{{company_name}}",
    label: "اسم الشركة",
    title: "Company name — personalized per recipient ({{company_name}})",
  },
  {
    token: "{{contact_name}}",
    label: "اسم المشغّل",
    title: "Contact person — personalized per recipient ({{contact_name}})",
  },
  {
    token: "{{greeting}}",
    label: "الافتتاحية",
    title: "Formal German greeting — personalized per recipient ({{greeting}})",
  },
];

export function RichEmailEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value)
      editorRef.current.innerHTML = value;
  }, [value]);
  const exec = (command: string, arg?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    onChange(editorRef.current?.innerHTML ?? "");
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line-strong bg-surface focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/10">
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface-2 p-2">
        <select
          aria-label="Font size"
          className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-xs text-muted"
          onChange={(event) => exec("fontSize", event.target.value)}
          defaultValue="3"
        >
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="7">Huge</option>
        </select>
        <input
          aria-label="Text color"
          type="color"
          className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-surface p-1"
          title="Text color"
          onChange={(event) => exec("foreColor", event.target.value)}
        />
        <input
          aria-label="Highlight color"
          type="color"
          className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-surface p-1"
          title="Highlight"
          defaultValue="#fff3a3"
          onChange={(event) => exec("hiliteColor", event.target.value)}
        />
        {tools.map((tool) => (
          <button
            key={tool.command}
            type="button"
            aria-label={tool.label}
            title={tool.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => exec(tool.command)}
            className={`flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs text-muted hover:bg-accent-soft hover:text-accent ${tool.command === "italic" ? "italic" : ""} ${tool.command === "underline" ? "underline" : ""}`}
          >
            {tool.icon}
          </button>
        ))}
        <button
          type="button"
          title="Insert link"
          aria-label="Insert link"
          className="flex h-8 items-center justify-center rounded-lg px-2 text-xs text-muted hover:bg-accent-soft hover:text-accent"
          onClick={() => {
            const url = window.prompt("Link URL");
            if (url) exec("createLink", url);
          }}
        >
          Link
        </button>
        {/* Smart personalization variables — inserted at the cursor with
            the same exec("insertText") path as the other tools, so the
            current selection/formatting is preserved exactly like a text
            insert. onMouseDown preventDefault (as on every toolbar button)
            keeps the editor selection from collapsing on click. */}
        <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-line-strong" />
        {variables.map((variable) => (
          <button
            key={variable.token}
            type="button"
            title={variable.title}
            aria-label={variable.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => exec("insertText", variable.token)}
            className="flex h-8 items-center justify-center rounded-lg px-2 text-xs text-muted hover:bg-accent-soft hover:text-accent"
          >
            {variable.label}
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Email message"
        className="min-h-[260px] p-4 text-sm leading-7 text-ink-soft outline-none empty:before:text-faint empty:before:content-['Write_your_message_here...']"
        onInput={() => onChange(editorRef.current?.innerHTML ?? "")}
      />{" "}
    </div>
  );
}
