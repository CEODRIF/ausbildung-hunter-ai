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
    <div className="overflow-hidden rounded-xl border border-[#dfe6f0] bg-white focus-within:border-[#2f6fed] focus-within:ring-4 focus-within:ring-[#2f6fed]/10">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#edf0f4] bg-[#fbfcfe] p-2">
        <select
          aria-label="Font size"
          className="h-8 rounded-lg border border-[#e1e7f0] bg-white px-2 text-xs text-[#546783]"
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
          className="h-8 w-8 cursor-pointer rounded-lg border border-[#e1e7f0] bg-white p-1"
          title="Text color"
          onChange={(event) => exec("foreColor", event.target.value)}
        />
        <input
          aria-label="Highlight color"
          type="color"
          className="h-8 w-8 cursor-pointer rounded-lg border border-[#e1e7f0] bg-white p-1"
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
            className={`flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs text-[#546783] hover:bg-[#e8f0ff] hover:text-[#2f6fed] ${tool.command === "italic" ? "italic" : ""} ${tool.command === "underline" ? "underline" : ""}`}
          >
            {tool.icon}
          </button>
        ))}
        <button
          type="button"
          title="Insert link"
          aria-label="Insert link"
          className="flex h-8 items-center justify-center rounded-lg px-2 text-xs text-[#546783] hover:bg-[#e8f0ff] hover:text-[#2f6fed]"
          onClick={() => {
            const url = window.prompt("Link URL");
            if (url) exec("createLink", url);
          }}
        >
          Link
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Email message"
        className="min-h-[260px] p-4 text-sm leading-7 text-[#1d3458] outline-none empty:before:text-[#a0adbd] empty:before:content-['Write_your_message_here...']"
        onInput={() => onChange(editorRef.current?.innerHTML ?? "")}
      />{" "}
    </div>
  );
}
