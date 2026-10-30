"use client";

/**
 * Step 6 — professional rich-text e-mail editor.
 *
 * A focused, dependency-free contentEditable editor (the app already ships
 * `sanitize-html`; adding a heavy editor library to React 19 was riskier than
 * this small, fully controlled component). It produces SEMI-TRUSTED HTML that
 * is sanitized on save (server action) and again on send (engine) — the
 * editor itself never trusts or renders raw markup as-is in the preview.
 *
 * Toolbar: paragraph format · bold · italic · underline · align (L/C/R) ·
 * bulleted + numbered lists · undo/redo · insert link · and the personalization
 * tokens (candidate name, contact person, company name, greeting).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Building2,
  Italic,
  Link,
  List,
  ListOrdered,
  Redo2,
  Smile,
  Underline,
  Undo2,
  User,
  UserRound,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { sanitizeEmailHtml } from "@/lib/email-sanitize";

type ToolbarButtonProps = {
  on?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({ on, label, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // preventDefault keeps the caret/selection inside the editor when the
      // toolbar is pressed (a normal mousedown would blur the contentEditable).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        on ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

const TOKEN_BUTTONS = [
  { token: "candidate_name", icon: User },
  { token: "contact_person", icon: UserRound },
  { token: "company_name", icon: Building2 },
  { token: "greeting", icon: Smile },
] as const;

export function EmailRichEditor({
  value,
  onChange,
  placeholder,
}: {
  /** Current (semi-trusted) HTML of the e-mail body. */
  value: string;
  /** Called with the new HTML on every edit. */
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [block, setBlock] = useState("p");

  // Bring an EXTERNAL value change into the editor (e.g. applying an AI
  // draft) without clobbering the caret while the user is typing: only touch
  // the DOM when the incoming value actually differs from what's shown.
  useEffect(() => {
    const el = ref.current;
    // This component is the app's second `.innerHTML =` sink (see
    // tests/security/xss.test.ts): whatever is mounted must be sanitized —
    // server rows (incl. legacy plain/HTML bodies) are semi-trusted input.
    const safe = value ? sanitizeEmailHtml(value) : "";
    if (el && el.innerHTML !== safe) el.innerHTML = safe;
  }, [value]);

  const refreshState = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const c of ["bold", "italic", "underline", "insertUnorderedList", "insertOrderedList"]) {
      try {
        next[c] = document.queryCommandState(c);
      } catch {
        next[c] = false;
      }
    }
    setActive(next);
    try {
      const b = (document.queryCommandValue("formatBlock") || "p").toString().replace(/[<>]/g, "").toLowerCase();
      if (b) setBlock(b);
    } catch {
      /* keep current */
    }
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshState);
    return () => document.removeEventListener("selectionchange", refreshState);
  }, [refreshState]);

  const exec = useCallback(
    (cmd: string, arg?: string) => {
      ref.current?.focus();
      try {
        document.execCommand(cmd, false, arg);
      } catch {
        /* execCommand is deprecated but universally supported; ignore no-ops */
      }
      onChange(ref.current?.innerHTML ?? "");
      refreshState();
    },
    [onChange, refreshState],
  );

  const insertToken = (token: string) => exec("insertText", `{{${token}}}`);

  const insertLink = () => {
    const url = window.prompt(t("autoBewerb.editorLinkPrompt"));
    if (url && /^https?:\/\/\S+$/i.test(url)) exec("createLink", url);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line-strong bg-surface">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface-2/40 px-2 py-1.5">
        <select
          aria-label={t("autoBewerb.editorFormatLabel")}
          value={block}
          onChange={(e) => exec("formatBlock", e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          className="mr-1 h-8 rounded-lg border border-line-strong bg-surface px-2 text-xs font-medium text-ink-soft outline-none focus:border-accent"
        >
          <option value="p">{t("autoBewerb.editorFormatNormal")}</option>
          <option value="h1">{t("autoBewerb.editorFormatH1")}</option>
          <option value="h2">{t("autoBewerb.editorFormatH2")}</option>
        </select>
        <ToolbarButton on={!!active.bold} label={t("autoBewerb.editorBold")} onClick={() => exec("bold")}>
          <Bold size={15} />
        </ToolbarButton>
        <ToolbarButton on={!!active.italic} label={t("autoBewerb.editorItalic")} onClick={() => exec("italic")}>
          <Italic size={15} />
        </ToolbarButton>
        <ToolbarButton on={!!active.underline} label={t("autoBewerb.editorUnderline")} onClick={() => exec("underline")}>
          <Underline size={15} />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <ToolbarButton label={t("autoBewerb.editorAlignLeft")} onClick={() => exec("justifyLeft")}>
          <AlignLeft size={15} />
        </ToolbarButton>
        <ToolbarButton label={t("autoBewerb.editorAlignCenter")} onClick={() => exec("justifyCenter")}>
          <AlignCenter size={15} />
        </ToolbarButton>
        <ToolbarButton label={t("autoBewerb.editorAlignRight")} onClick={() => exec("justifyRight")}>
          <AlignRight size={15} />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <ToolbarButton on={!!active.insertUnorderedList} label={t("autoBewerb.editorBulletList")} onClick={() => exec("insertUnorderedList")}>
          <List size={15} />
        </ToolbarButton>
        <ToolbarButton on={!!active.insertOrderedList} label={t("autoBewerb.editorNumberedList")} onClick={() => exec("insertOrderedList")}>
          <ListOrdered size={15} />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <ToolbarButton label={t("autoBewerb.editorUndo")} onClick={() => exec("undo")}>
          <Undo2 size={15} />
        </ToolbarButton>
        <ToolbarButton label={t("autoBewerb.editorRedo")} onClick={() => exec("redo")}>
          <Redo2 size={15} />
        </ToolbarButton>
        <ToolbarButton label={t("autoBewerb.editorLink")} onClick={insertLink}>
          <Link size={15} />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-line" />
        {TOKEN_BUTTONS.map(({ token, icon: Icon }) => (
          <ToolbarButton key={token} label={`{{${token}}}`} onClick={() => insertToken(token)}>
            <Icon size={15} />
          </ToolbarButton>
        ))}
      </div>

      {/* Editable body */}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t("autoBewerb.templateLabel")}
        onInput={() => {
          onChange(ref.current?.innerHTML ?? "");
          refreshState();
        }}
        data-placeholder={placeholder}
        className="email-editor min-h-44 max-h-96 overflow-auto px-4 py-3 text-sm text-ink outline-none"
      />

      {/* Scoped content styling (the editor's own markup, not global). */}
      <style>{`
        .email-editor { line-height: 1.6; font-size: 0.875rem; }
        .email-editor p { margin: 0 0 0.75em; }
        .email-editor p:last-child { margin-bottom: 0; }
        .email-editor h1 { font-size: 1.2rem; font-weight: 700; margin: 0.5em 0 0.4em; }
        .email-editor h2 { font-size: 1.05rem; font-weight: 600; margin: 0.5em 0 0.4em; }
        .email-editor ul, .email-editor ol { margin: 0 0 0.75em; padding-left: 1.5em; }
        .email-editor ul { list-style: disc; }
        .email-editor ol { list-style: decimal; }
        .email-editor a { color: var(--color-accent); text-decoration: underline; }
        .email-editor:empty::before { content: attr(data-placeholder); color: var(--color-faint); }
      `}</style>
    </div>
  );
}
