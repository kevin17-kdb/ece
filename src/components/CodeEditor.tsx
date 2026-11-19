import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

export interface EditorMarker {
  line: number;
  severity: "error" | "warning";
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  markers?: EditorMarker[];
  ariaLabel: string;
}

const lineHeight = 20;
const indent = "  ";
const charWidth = 7.3;

export function CodeEditor({ value, onChange, markers = [], ariaLabel }: CodeEditorProps) {
  const [caretLine, setCaretLine] = useState(1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = value.split("\n");
  const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const errorLines = markers.filter((marker) => marker.severity === "error").map((marker) => marker.line);
  const warningLines = markers.filter((marker) => marker.severity === "warning").map((marker) => marker.line);

  function syncCaret(element: HTMLTextAreaElement) {
    setCaretLine(element.value.slice(0, element.selectionStart).split("\n").length);
  }

  function replaceRange(start: number, end: number, replacement: string) {
    const element = textareaRef.current;
    onChange(`${value.slice(0, start)}${replacement}${value.slice(end)}`);
    if (!element) {
      return;
    }

    const position = start + replacement.length;
    element.focus();
    element.setSelectionRange(position, position);
    setCaretLine(value.slice(0, position).split("\n").length);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const element = event.currentTarget;
    const { selectionStart, selectionEnd } = element;

    if (event.key === "Tab") {
      event.preventDefault();
      replaceRange(selectionStart, selectionEnd, indent);
      return;
    }

    if (event.key !== "Enter" || selectionStart !== selectionEnd) {
      return;
    }

    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const lineText = value.slice(lineStart, selectionStart);
    const leading = lineText.match(/^[ \t]*/)?.[0] ?? "";
    const trimmed = lineText.trim();
    const opensBlock = /\b(begin|case|initial|always|function|task)\b/.test(trimmed) || trimmed === "else";
    const insertion = `\n${leading}${opensBlock ? indent : ""}`;
    event.preventDefault();
    replaceRange(selectionStart, selectionEnd, insertion);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text");
    if (!text.includes("\t") || !text.includes("\n")) {
      return;
    }

    event.preventDefault();
    replaceRange(event.currentTarget.selectionStart, event.currentTarget.selectionEnd, text.replaceAll(/\t/g, indent));
  }

  return (
    <div className="code-editor">
      <div className="code-editor-gutter" aria-hidden="true">
        {lines.map((_, index) => {
          const line = index + 1;
          const state = errorLines.includes(line) ? "is-error" : warningLines.includes(line) ? "is-warning" : "";
          return <span className={`code-editor-line-number ${state}`} key={line}>{line}</span>;
        })}
      </div>
      <div className="code-editor-surface" style={{ minWidth: `${Math.max(520, longestLine * charWidth + 32)}px` }}>
        {caretLine > 0 ? <div className="code-editor-active-line" style={{ top: (caretLine - 1) * lineHeight }} /> : null}
        {errorLines.map((line) => <div className="code-editor-error-line" key={`error-${line}`} style={{ top: (line - 1) * lineHeight }} />)}
        {warningLines.map((line) => <div className="code-editor-warning-line" key={`warning-${line}`} style={{ top: (line - 1) * lineHeight }} />)}
        <textarea
          aria-label={ariaLabel}
          className="code-editor-textarea"
          onChange={(event) => onChange(event.target.value)}
          onClick={(event) => syncCaret(event.currentTarget)}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onPaste={handlePaste}
          onSelect={(event) => syncCaret(event.currentTarget)}
          ref={textareaRef}
          spellCheck={false}
          style={{ lineHeight: `${lineHeight}px` }}
          value={value}
          wrap="off"
        />
      </div>
    </div>
  );
}
