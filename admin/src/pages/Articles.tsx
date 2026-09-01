import React from "react";
import { Alert, Button, Card, Divider, Drawer, Dropdown, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, Upload, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, UploadOutlined } from "@ant-design/icons";
import { adminMe, archiveAdminArticle, completeAdminBannerImageUpload, createAdminArticle, errMsg, initAdminBannerImageUpload, listAdminArticles, publishAdminArticle, updateAdminArticle } from "../api/client";
import type { AdminArticleInput, AdminArticleItem, AdminMe } from "../api/types";

const { TextArea } = Input;
const { Text, Title } = Typography;

const EMPTY: AdminArticleInput = {
  slug: "", title: "", summary: "", bodyHtml: "", coverImageUrl: null, sourceName: null, sourceUrl: null,
  topics: [], seoTitle: null, seoDescription: null, seoKeywords: [], geoKeywords: [], status: "draft", reason: "",
};

const statusLabel: Record<AdminArticleItem["status"], string> = { draft: "草稿", published: "已发布", archived: "已下线" };
const statusColor: Record<AdminArticleItem["status"], string> = { draft: "default", published: "green", archived: "orange" };
const articlePublicUrl = (slug: string) => `${window.location.origin}/#view=article&id=${encodeURIComponent(slug)}&from=articles`;

const ARTICLE_TEXT_COLORS = [
  { key: "violet", label: "紫色", swatch: "#9d67ff", editorColor: "#7c3aed" },
  { key: "pink", label: "粉色", swatch: "#f472b6", editorColor: "#be185d" },
  { key: "red", label: "红色", swatch: "#ef6b73", editorColor: "#dc2626" },
  { key: "orange", label: "橙色", swatch: "#f59e0b", editorColor: "#c2410c" },
  { key: "green", label: "绿色", swatch: "#34d399", editorColor: "#15803d" },
  { key: "blue", label: "蓝色", swatch: "#60a5fa", editorColor: "#2563eb" },
] as const;
const ARTICLE_TEXT_COLOR_KEYS = new Set<string>(ARTICLE_TEXT_COLORS.map((color) => color.key));
const ARTICLE_EDITOR_COLOR_VALUES = Object.fromEntries(ARTICLE_TEXT_COLORS.map((color) => [color.key, color.editorColor])) as Record<string, string>;
const ARTICLE_PREVIEW_COLOR_CSS = ARTICLE_TEXT_COLORS.map((color) => `[data-article-color="${color.key}"]{color:${color.editorColor}}`).join("");
const ARTICLE_SYMBOLS = ["★", "◆", "●", "✓", "✦", "→", "—", "※", "♥", "⚠"] as const;
const EDITOR_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "STRONG", "EM", "SPAN", "UL", "OL", "LI", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "BR", "HR", "A", "IMG", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
const VOID_EDITOR_TAGS = new Set(["BR", "HR", "IMG"]);

function sanitizeEditorHtml(input: string): string {
  const safeEscapedColors = String(input || "").replace(/&lt;span\s+data-article-color=(?:&quot;|")?(violet|pink|red|orange|green|blue)(?:&quot;|")?\s*&gt;([\s\S]*?)&lt;\/span&gt;/gi, (_match, color, children) => `<span data-article-color="${color}">${children}</span>`);
  const documentNode = new DOMParser().parseFromString(safeEscapedColors, "text/html");
  const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node as HTMLElement;
    const tag = element.tagName.toUpperCase();
    if (!EDITOR_TAGS.has(tag)) return Array.from(element.childNodes).map(walk).join("");
    const lower = tag.toLowerCase();
    if (tag === "A") {
      const href = element.getAttribute("href") || "";
      try { if (new URL(href).protocol === "https:") return `<a href="${href.replace(/\"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${Array.from(element.childNodes).map(walk).join("")}</a>`; } catch { /* invalid URLs are unlinked */ }
      return Array.from(element.childNodes).map(walk).join("");
    }
    if (tag === "IMG") {
      const src = element.getAttribute("src") || "";
      try { if (new URL(src).protocol === "https:") return `<img src="${src.replace(/\"/g, "&quot;")}" alt="${(element.getAttribute("alt") || "文章配图").replace(/\"/g, "&quot;")}">`; } catch { return ""; }
      return "";
    }
    const children = Array.from(element.childNodes).map(walk).join("");
    if (tag === "SPAN") {
      const color = element.getAttribute("data-article-color") || "";
      return ARTICLE_TEXT_COLOR_KEYS.has(color) ? `<span data-article-color="${color}">${children}</span>` : children;
    }
    return VOID_EDITOR_TAGS.has(tag) ? `<${lower}>` : `<${lower}>${children}</${lower}>`;
  };
  return Array.from(documentNode.body.childNodes).map(walk).join("");
}

function markdownToHtml(markdown: string): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (value: string) => escape(value.trim().replace(/\\$/, ""))
    .replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const hardBreak = (value: string) => /\\\s*$/.test(value);
  const isListLine = (value: string) => /^[-*+]\s+|^\d+[.)]\s+/.test(value.trim());
  const isBlockStart = (value: string) => /^(#{1,5})\s|^>\s?|^[-*+]\s+|^\d+[.)]\s+|^---+$/.test(value.trim());
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    const tableSeparator = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1]?.trim() || "");
    if (line.includes("|") && tableSeparator) {
      const header = cells(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().includes("|")) { rows.push(cells(lines[index])); index += 1; }
      blocks.push(`<table><thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${inline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const heading = /^(#{1,5})\s+(.+)$/.exec(line);
    if (heading) { const level = heading[1].length; blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`); index += 1; continue; }
    if (/^---+$/.test(line)) { blocks.push("<hr>"); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) { const raw = lines[index].trim().replace(/^>\s?/, ""); quote.push(inline(raw)); if (hardBreak(raw)) quote.push("<br>"); index += 1; }
      blocks.push(`<blockquote>${quote.join("")}</blockquote>`); continue;
    }
    if (isListLine(line)) {
      const ordered = /^\d+[.)]\s+/.test(line);
      const itemPattern = ordered ? /^\d+[.)]\s+/ : /^[-*+]\s+/;
      const items: string[] = [];
      while (index < lines.length && itemPattern.test(lines[index].trim())) {
        const itemLines: string[] = [];
        let raw = lines[index].trim().replace(itemPattern, ""); itemLines.push(inline(raw)); index += 1;
        while (index < lines.length && lines[index].trim() && !isListLine(lines[index]) && !isBlockStart(lines[index])) {
          itemLines.push(hardBreak(raw) ? "<br>" : " ");
          raw = lines[index].trim(); itemLines.push(inline(raw)); index += 1;
        }
        items.push(`<li>${itemLines.join("")}</li>`);
      }
      blocks.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    const paragraph: string[] = [line]; index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) { paragraph.push(lines[index].trim()); index += 1; }
    blocks.push(`<p>${paragraph.map((value, paragraphIndex) => `${paragraphIndex && hardBreak(paragraph[paragraphIndex - 1]) ? "<br>" : paragraphIndex ? " " : ""}${inline(value)}`).join("")}</p>`);
  }
  return sanitizeEditorHtml(blocks.join("\n"));
}

const RichArticleEditor: React.FC<{ value?: string; onChange?: (value: string) => void; disabled?: boolean; onPasteImage?: (file: File) => Promise<string | null> }> = ({ value = "", onChange, disabled, onPasteImage }) => {
  const editorRef = React.useRef<HTMLDivElement | null>(null);
  const selectedImageRef = React.useRef<HTMLImageElement | null>(null);
  const selectedTextRangeRef = React.useRef<Range | null>(null);
  const lastEditorRangeRef = React.useRef<Range | null>(null);
  const lastValue = React.useRef("");
  const [sourceMode, setSourceMode] = React.useState(false);
  const [markdownOpen, setMarkdownOpen] = React.useState(false);
  const [markdown, setMarkdown] = React.useState("");
  const [richPasteHtml, setRichPasteHtml] = React.useState("");
  const [hasSelectedImage, setHasSelectedImage] = React.useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = React.useState(false);
  const [linkUrl, setLinkUrl] = React.useState("");
  const captureCaret = (): { path: number[]; offset: number } | null => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) return null;
    const path: number[] = [];
    let node: Node = range.startContainer;
    while (node !== root && node.parentNode) { path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node)); node = node.parentNode; }
    return node === root ? { path, offset: range.startOffset } : null;
  };
  const restoreCaret = (caret: { path: number[]; offset: number } | null) => {
    const root = editorRef.current;
    if (!root || !caret) return;
    let node: Node = root;
    for (const index of caret.path) { if (!node.childNodes[index]) return; node = node.childNodes[index]; }
    const maxOffset = node.nodeType === Node.TEXT_NODE ? (node.textContent || "").length : node.childNodes.length;
    const range = document.createRange();
    range.setStart(node, Math.min(caret.offset, maxOffset));
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const rememberSelectedText = () => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    // Clicking a toolbar button moves the browser focus outside the editor.
    // Keep the last in-editor range through that focus change so the command
    // can restore it; only an in-editor caret clears the active selection.
    if (!root.contains(range.commonAncestorContainer)) return;
    lastEditorRangeRef.current = range.cloneRange();
    if (range.collapsed) { selectedTextRangeRef.current = null; return; }
    selectedTextRangeRef.current = range.cloneRange();
  };
  const restoreSelectedText = () => {
    const root = editorRef.current;
    const range = selectedTextRangeRef.current;
    if (!root || !range || range.collapsed || !root.contains(range.commonAncestorContainer)) return false;
    root.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  };
  const activeTextRange = () => {
    const root = editorRef.current;
    if (!root || !restoreSelectedText()) {
      message.info("请先在正文中选中文案，再使用排版工具");
      return null;
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) && !range.collapsed ? range : null;
  };
  const selectContents = (node: Node) => {
    const nextRange = document.createRange();
    nextRange.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(nextRange);
    rememberSelectedText();
  };
  const wrapSelectedText = (tagName: "strong" | "em" | "a" | "span", attributes?: Record<string, string>) => {
    const range = activeTextRange();
    if (!range) return false;
    const wrapper = document.createElement(tagName);
    Object.entries(attributes || {}).forEach(([name, value]) => wrapper.setAttribute(name, value));
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
    selectContents(wrapper);
    return true;
  };
  const selectedBlocks = (range: Range) => {
    const root = editorRef.current;
    if (!root) return [] as HTMLElement[];
    return Array.from(root.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, blockquote, li"))
      .filter((block) => range.intersectsNode(block))
      .filter((block) => !Array.from(block.parentElement?.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, blockquote, li") || []).some((child) => child !== block && child.contains(block) && range.intersectsNode(child)));
  };
  const replaceBlockTag = (block: HTMLElement, tagName: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "blockquote") => {
    if (block.tagName.toLowerCase() === tagName) return block;
    const replacement = document.createElement(tagName);
    replacement.innerHTML = block.innerHTML;
    block.replaceWith(replacement);
    return replacement;
  };
  const formatSelectedBlocks = (tagName: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "blockquote") => {
    const range = activeTextRange();
    if (!range) return false;
    const blocks = selectedBlocks(range);
    if (!blocks.length) return false;
    const formatted = blocks.map((block) => replaceBlockTag(block, tagName));
    selectContents(formatted[0].parentElement && formatted.length > 1 ? formatted[0].parentElement : formatted[0]);
    return true;
  };
  const formatSelectedList = (tagName: "ul" | "ol") => {
    const range = activeTextRange();
    if (!range) return false;
    const blocks = selectedBlocks(range).filter((block) => block.tagName !== "LI");
    if (!blocks.length || !blocks[0].parentNode) return false;
    const list = document.createElement(tagName);
    blocks[0].parentNode.insertBefore(list, blocks[0]);
    blocks.forEach((block) => {
      const item = document.createElement("li");
      item.innerHTML = block.innerHTML;
      list.appendChild(item);
      block.remove();
    });
    selectContents(list);
    return true;
  };
  const clearSelectedImage = () => {
    const previous = selectedImageRef.current;
    if (previous) { previous.style.removeProperty("outline"); previous.style.removeProperty("outline-offset"); }
    selectedImageRef.current = null;
    setHasSelectedImage(false);
  };
  const selectImage = (image: HTMLImageElement) => {
    clearSelectedImage();
    selectedImageRef.current = image;
    Object.assign(image.style, { outline: "3px solid #8d52ff", outlineOffset: "3px" });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNode(image);
    selection?.removeAllRanges();
    selection?.addRange(range);
    setHasSelectedImage(true);
  };
  const constrainImages = () => {
    editorRef.current?.querySelectorAll("img").forEach((image) => {
      Object.assign((image as HTMLElement).style, { maxWidth: "100%", height: "auto", display: "block", boxSizing: "border-box" });
    });
  };
  const applyEditorTextColors = () => {
    editorRef.current?.querySelectorAll<HTMLElement>("span[data-article-color]").forEach((element) => {
      const color = element.getAttribute("data-article-color") || "";
      element.style.color = ARTICLE_EDITOR_COLOR_VALUES[color] || "";
    });
  };
  const insertParagraphAtCaret = () => {
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return false;

    range.deleteContents();
    range.collapse(true);
    const anchor = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
    const block = anchor?.closest<HTMLElement>("p, h2, h3, h4, blockquote");
    const next = document.createElement("p");

    if (block && root.contains(block) && block.parentNode) {
      const tailRange = document.createRange();
      tailRange.setStart(range.startContainer, range.startOffset);
      tailRange.setEnd(block, block.childNodes.length);
      const tail = tailRange.extractContents();
      next.appendChild(tail);
      if (!block.childNodes.length) block.appendChild(document.createElement("br"));
      block.parentNode.insertBefore(next, block.nextSibling);
    } else {
      root.appendChild(next);
    }
    if (!next.childNodes.length) next.appendChild(document.createElement("br"));

    const nextRange = document.createRange();
    nextRange.setStart(next, 0);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    lastEditorRangeRef.current = nextRange.cloneRange();
    selectedTextRangeRef.current = null;
    const nextCaret = captureCaret();
    emit();
    // Form.Item propagates the sanitized value back into this controlled editor.
    // Restore after that render pass so an Enter at the document end cannot land
    // on the editor root (which appears as a jump back to the beginning).
    window.requestAnimationFrame(() => {
      restoreCaret(nextCaret);
      const restored = window.getSelection();
      if (restored?.rangeCount) lastEditorRangeRef.current = restored.getRangeAt(0).cloneRange();
    });
    return true;
  };
  const emit = () => {
    const caret = captureCaret();
    const safe = sanitizeEditorHtml(editorRef.current?.innerHTML || "");
    if (editorRef.current && editorRef.current.innerHTML !== safe) { editorRef.current.innerHTML = safe; restoreCaret(caret); }
    constrainImages();
    applyEditorTextColors();
    lastValue.current = safe;
    onChange?.(safe);
  };
  React.useEffect(() => {
    if (!sourceMode && editorRef.current && editorRef.current.innerHTML !== value) {
      const safe = sanitizeEditorHtml(value);
      editorRef.current.innerHTML = safe;
      constrainImages();
      applyEditorTextColors();
      lastValue.current = safe;
    }
  }, [value, sourceMode]);
  const command = (name: string, commandValue?: string) => {
    if (disabled) return;
    let changed = false;
    if (name === "link") {
      if (!activeTextRange()) return;
      setLinkUrl("");
      setLinkDialogOpen(true);
      return;
    } else if (name === "bold") changed = wrapSelectedText("strong");
    else if (name === "italic") changed = wrapSelectedText("em");
    else if (name === "insertUnorderedList") changed = formatSelectedList("ul");
    else if (name === "insertOrderedList") changed = formatSelectedList("ol");
    else if (name === "formatBlock" && (commandValue === "p" || commandValue === "h1" || commandValue === "h2" || commandValue === "h3" || commandValue === "h4" || commandValue === "h5" || commandValue === "blockquote")) changed = formatSelectedBlocks(commandValue);
    if (!changed) { message.info("请先选中一段正文，再使用此排版工具"); return; }
    emit();
  };
  const applyTextColor = (color: string) => {
    if (!ARTICLE_TEXT_COLOR_KEYS.has(color)) return;
    if (!wrapSelectedText("span", { "data-article-color": color })) return;
    emit();
  };
  const insertSymbol = (symbol: string) => {
    const root = editorRef.current;
    const range = lastEditorRangeRef.current;
    if (!root || !range || !root.contains(range.commonAncestorContainer)) {
      message.info("请先在正文中放置光标或选中文案，再插入符号");
      return;
    }
    root.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    range.deleteContents();
    const text = document.createTextNode(symbol);
    range.insertNode(text);
    const nextRange = document.createRange();
    nextRange.setStartAfter(text);
    nextRange.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(nextRange);
    lastEditorRangeRef.current = nextRange.cloneRange();
    selectedTextRangeRef.current = null;
    emit();
  };
  const applyLink = () => {
    const href = linkUrl.trim();
    try { if (!href || new URL(href).protocol !== "https:") throw new Error("unsafe"); } catch { message.error("仅支持完整 HTTPS 链接"); return; }
    if (!wrapSelectedText("a", { href, target: "_blank", rel: "noopener noreferrer" })) { message.info("选中文案已失效，请重新选择后添加链接"); setLinkDialogOpen(false); return; }
    emit();
    setLinkDialogOpen(false);
    setLinkUrl("");
  };
  const preserveSelectedText = () => {
    rememberSelectedText();
  };
  const deleteSelectedImage = () => {
    if (disabled || !selectedImageRef.current) return;
    const image = selectedImageRef.current;
    const figure = image.closest("figure");
    (figure || image).remove();
    clearSelectedImage();
    emit();
    message.success("图片已从正文删除");
  };
  return <div>
    <Space wrap size={[6, 8]} style={{ marginBottom: 10 }}>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "p")} disabled={disabled || sourceMode}>正文</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "h1")} disabled={disabled || sourceMode}>一级标题</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "h2")} disabled={disabled || sourceMode}>二级标题</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "h3")} disabled={disabled || sourceMode}>三级标题</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "h4")} disabled={disabled || sourceMode}>四级标题</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "h5")} disabled={disabled || sourceMode}>五级标题</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("bold")} disabled={disabled || sourceMode}><strong>加粗</strong></Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("italic")} disabled={disabled || sourceMode}><em>斜体</em></Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("insertUnorderedList")} disabled={disabled || sourceMode}>列表</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("insertOrderedList")} disabled={disabled || sourceMode}>编号</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("formatBlock", "blockquote")} disabled={disabled || sourceMode}>引用</Button>
      <Button size="small" onPointerDown={preserveSelectedText} onClick={() => command("link")} disabled={disabled || sourceMode}>链接</Button>
      <Dropdown trigger={["click"]} disabled={disabled || sourceMode} menu={{ items: ARTICLE_TEXT_COLORS.map((color) => ({ key: color.key, label: <Space size={6}><span aria-hidden style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: color.swatch, border: "1px solid rgba(0,0,0,.18)" }} />{color.label}</Space> })), onClick: ({ key }) => applyTextColor(String(key)) }}>
        <Button size="small" onPointerDown={preserveSelectedText} disabled={disabled || sourceMode}>文字颜色</Button>
      </Dropdown>
      <Dropdown trigger={["click"]} disabled={disabled || sourceMode} menu={{ items: ARTICLE_SYMBOLS.map((symbol) => ({ key: symbol, label: symbol })), onClick: ({ key }) => insertSymbol(String(key)) }}>
        <Button size="small" onPointerDown={preserveSelectedText} disabled={disabled || sourceMode}>符号</Button>
      </Dropdown>
      <Button size="small" danger onClick={deleteSelectedImage} disabled={disabled || sourceMode || !hasSelectedImage}>删除选中图片</Button>
      <Button size="small" onClick={() => setMarkdownOpen(true)} disabled={disabled}>导入 Markdown</Button>
      <Button size="small" type={sourceMode ? "primary" : "default"} onClick={() => { if (!sourceMode) emit(); setSourceMode((open) => !open); }}>{sourceMode ? "可视化编辑" : "HTML 源码"}</Button>
    </Space>
    {sourceMode
      ? <TextArea value={value} onChange={(event) => { lastValue.current = event.target.value; onChange?.(event.target.value); }} autoSize={{ minRows: 24, maxRows: 46 }} maxLength={50000} disabled={disabled} spellCheck={false} />
      : <div ref={editorRef} contentEditable={!disabled} suppressContentEditableWarning onInput={emit} onSelect={rememberSelectedText} onPointerUp={rememberSelectedText} onMouseUp={rememberSelectedText} onKeyUp={rememberSelectedText} onFocus={rememberSelectedText} onClick={(event) => { const target = event.target; if (target instanceof HTMLImageElement) selectImage(target); else clearSelectedImage(); }} onKeyDown={(event) => {
        if ((event.key === "Delete" || event.key === "Backspace") && selectedImageRef.current) { event.preventDefault(); deleteSelectedImage(); return; }
        const selection = window.getSelection();
        const selectedElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
        if (event.key === "Enter" && !event.shiftKey && !selectedElement?.closest("li")) { event.preventDefault(); insertParagraphAtCaret(); }
      }} onPaste={(event) => {
        const image = Array.from(event.clipboardData.items).map((item) => item.kind === "file" ? item.getAsFile() : null).find((file): file is File => !!file && /^image\//i.test(file.type));
        event.preventDefault();
        if (!image || !onPasteImage) { document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); emit(); return; }
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        void onPasteImage(image).then((figure) => {
          if (!figure || !editorRef.current) return;
          editorRef.current.focus();
          if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
          document.execCommand("insertHTML", false, figure);
          emit();
        });
      }} style={{ minHeight: 440, padding: 16, border: "1px solid #d9d9d9", borderRadius: 8, lineHeight: 1.8, outline: "none", overflowX: "hidden", boxSizing: "border-box" }} />}
    <Modal title="添加链接" open={linkDialogOpen} onCancel={() => { setLinkDialogOpen(false); setLinkUrl(""); }} onOk={applyLink} okText="添加链接" cancelText="取消">
      <Text type="secondary">链接将只作用于刚才选中的文案。</Text>
      <Input autoFocus value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} placeholder="https://example.com" style={{ marginTop: 12 }} />
    </Modal>
    <Modal title="导入 Markdown" open={markdownOpen} onCancel={() => { setRichPasteHtml(""); setMarkdownOpen(false); }} onOk={() => { const converted = richPasteHtml || markdownToHtml(markdown); lastValue.current = converted; onChange?.(converted); setSourceMode(false); setRichPasteHtml(""); setMarkdownOpen(false); message.success(richPasteHtml ? "已保留文章详情的标题、引用、列表与图片格式" : "Markdown 已转换为可视化文章，可继续编辑"); }} okText="转换并载入" cancelText="取消" okButtonProps={{ disabled: !markdown.trim() }}>
      <Text type="secondary">将覆盖当前正文。支持标题、引用、列表、编号、强制换行、图片、链接和 Markdown 表格；直接从文章详情复制时会优先保留原有格式。</Text>
      <TextArea value={markdown} onChange={(event) => { setRichPasteHtml(""); setMarkdown(event.target.value); }} onPaste={(event) => { const html = event.clipboardData.getData("text/html"); const safe = html ? sanitizeEditorHtml(html) : ""; if (!safe) return; event.preventDefault(); setRichPasteHtml(safe); setMarkdown(event.clipboardData.getData("text/plain")); message.success("已识别文章详情格式，导入时将保留排版"); }} autoSize={{ minRows: 18, maxRows: 32 }} style={{ marginTop: 12 }} placeholder="# 文章标题\n\n正文…" spellCheck={false} />
    </Modal>
  </div>;
};

const ArticlesPage: React.FC = () => {
  const [form] = Form.useForm<AdminArticleInput>();
  const [rows, setRows] = React.useState<AdminArticleItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AdminArticleItem | null>(null);
  const [imageUploading, setImageUploading] = React.useState(false);
  const [me, setMe] = React.useState<AdminMe | null>(null);
  const canEdit = ["super_admin", "operator", "editor"].includes(me?.role || "");
  const canPublish = ["super_admin", "operator", "editor"].includes(me?.role || "");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [result, currentMe] = await Promise.all([listAdminArticles(), adminMe()]);
      setRows(result.items);
      setMe(currentMe);
    } catch (error) {
      message.error(errMsg(error, "加载文章列表失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue(EMPTY);
    setDrawerOpen(true);
  };
  const openEdit = (article: AdminArticleItem) => {
    setEditing(article);
    form.setFieldsValue({ ...article, reason: "" });
    setDrawerOpen(true);
  };
  const save = async () => {
    try {
      const value = await form.validateFields();
      setSaving(true);
      if (editing) await updateAdminArticle(editing.id, value);
      else await createAdminArticle(value);
      message.success(editing ? "文章已保存" : "文章草稿已创建");
      setDrawerOpen(false);
      await load();
    } catch (error) {
      message.error(errMsg(error, "保存文章失败"));
    } finally {
      setSaving(false);
    }
  };
  const publish = async (article: AdminArticleItem) => {
    try { await publishAdminArticle(article.id); message.success("文章已发布，前台文章页将显示它"); await load(); }
    catch (error) { message.error(errMsg(error, "发布文章失败")); }
  };
  const copyArticleLink = async (slug: string) => {
    const url = articlePublicUrl(slug);
    try { await navigator.clipboard.writeText(url); message.success("前台文章链接已复制"); }
    catch { window.prompt("复制前台文章链接", url); }
  };
  const archive = async (article: AdminArticleItem) => {
    try { await archiveAdminArticle(article.id); message.success("文章已下线"); await load(); }
    catch (error) { message.error(errMsg(error, "下线文章失败")); }
  };
  const uploadArticleImage = async (file: File, mode: "cover" | "inline" | "paste", pasted?: (figure: string | null) => void) => {
    if (!canEdit) { pasted?.(null); return Upload.LIST_IGNORE; }
    if (!/^image\/(jpeg|png|webp|jpg)$/i.test(file.type || "")) {
      message.error("仅支持 JPG、PNG 或 WebP 图片");
      pasted?.(null);
      return Upload.LIST_IGNORE;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error("文章图片不能超过 20MB");
      pasted?.(null);
      return Upload.LIST_IGNORE;
    }
    setImageUploading(true);
    let assetId: string | null = null;
    try {
      const init = await initAdminBannerImageUpload({ originalFilename: file.name, mimeType: file.type, contentLength: file.size });
      assetId = init.mediaAssetId;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", init.uploadUrl, true);
        Object.entries(init.expectedHttpHeaders || {}).forEach(([key, value]) => { try { xhr.setRequestHeader(key, value); } catch { /* browser restricted header */ } });
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error("网络错误：上传到对象存储失败"));
        xhr.send(file);
      });
      const completed = await completeAdminBannerImageUpload(assetId, { ok: true, reportedContentLength: file.size });
      if (!completed.ok || completed.status !== "ready" || !completed.publicUrl) throw new Error("article_image_verify_failed");
      const current = String(form.getFieldValue("bodyHtml") || "").trimEnd();
      const alt = file.name.replace(/\.[a-z0-9]+$/i, "") || "文章配图";
      if (mode === "cover") {
        form.setFieldValue("coverImageUrl", completed.publicUrl);
        message.success("封面图片已上传，可直接保存文章");
      } else {
        const figure = `<figure><img src="${completed.publicUrl}" alt="${alt}"><figcaption>${alt}</figcaption></figure>`;
        if (mode === "inline") {
          form.setFieldValue("bodyHtml", `${current}${current ? "\n\n" : ""}${figure}`);
          message.success("图片已插入 HTML 正文末尾，可剪切到任意位置");
        } else {
          message.success("图片已上传，正在插入当前光标位置");
          pasted?.(figure);
        }
      }
    } catch (error) {
      if (assetId) {
        try { await completeAdminBannerImageUpload(assetId, { ok: false, error: "article_image_upload_failed" }); } catch { /* best effort */ }
      }
      pasted?.(null);
      message.error(errMsg(error, "文章图片上传失败"));
    } finally {
      setImageUploading(false);
    }
    return Upload.LIST_IGNORE;
  };

  const columns: ColumnsType<AdminArticleItem> = [
    { title: "封面", dataIndex: "coverImageUrl", width: 128, render: (url: string | null, row) => url ? <img src={url} alt={`${row.title} 封面`} style={{ width: 96, height: 54, objectFit: "cover", borderRadius: 6 }} /> : <Text type="secondary">未设置</Text> },
    { title: "标题", dataIndex: "title", width: 260, render: (title, row) => <Space direction="vertical" size={0}><Text strong>{title}</Text><Text type="secondary">/{row.slug}</Text></Space> },
    { title: "状态", dataIndex: "status", width: 100, render: (status: AdminArticleItem["status"]) => <Tag color={statusColor[status]}>{statusLabel[status]}</Tag> },
    { title: "主题", dataIndex: "topics", render: (topics: string[]) => <Space size={[4, 4]} wrap>{topics.slice(0, 4).map((topic) => <Tag key={topic}>{topic}</Tag>)}</Space> },
    { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (time) => new Date(time).toLocaleString("zh-CN", { hour12: false }) },
    { title: "操作", width: 300, render: (_, row) => <Space wrap>
      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
      <Button size="small" onClick={() => window.open(articlePublicUrl(row.slug), "_blank", "noopener,noreferrer")}>打开前台</Button>
      <Button size="small" onClick={() => void copyArticleLink(row.slug)}>复制链接</Button>
      {row.status !== "published" && <Button size="small" type="primary" disabled={!canPublish} onClick={() => publish(row)}>发布</Button>}
      {row.status !== "archived" && <Popconfirm title="确认下线这篇文章？" onConfirm={() => archive(row)}><Button size="small" danger disabled={!canPublish}>下线</Button></Popconfirm>}
    </Space> },
  ];

  return <Space direction="vertical" size={16} style={{ width: "100%" }}>
    <Card>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Title level={5} style={{ margin: 0 }}>文章中心</Title>
        <Text type="secondary">编写平台原创文章或维护经授权的导读。仅“已发布”文章会出现在 H5、Web 和 Mini App 的文章板块。</Text>
        <Alert type="info" showIcon message="支持封面与 HTML 图文排版" description="封面和正文图片均可上传；正文使用受控 HTML，支持标题、段落、列表、引用、链接和图片。系统会过滤脚本、样式、事件属性及非 HTTPS 资源。引用第三方资料请填写来源名称与链接，不直接搬运未经授权的全文。" />
      </Space>
    </Card>
    <Card title="文章列表" extra={<Space><Button onClick={load}>刷新</Button><Button type="primary" icon={<PlusOutlined />} disabled={!canEdit} onClick={openCreate}>新建文章</Button></Space>}>
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 980 }} />
    </Card>
    <Drawer title={editing ? "编辑文章" : "新建文章"} width={980} open={drawerOpen} onClose={() => setDrawerOpen(false)} extra={<Button type="primary" loading={saving} onClick={save}>保存</Button>}>
      <Form form={form} layout="vertical" initialValues={EMPTY} preserve={false}>
        <Form.Item name="slug" label="文章链接标识" extra={editing?.status === "published" ? "已发布文章的标识已锁定，确保已分享的链接持续有效。" : "保存草稿时可调整；发布后会锁定，形成稳定前台链接。"} rules={[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: "仅小写英文、数字与连字符，例如 bdsm-safety-guide" }]}><Input maxLength={160} disabled={!canEdit || editing?.status === "published"} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.slug !== current.slug}>{() => {
          const slug = String(form.getFieldValue("slug") || "").trim();
          return slug ? <Form.Item label="前台直达链接"><Space.Compact style={{ width: "100%" }}><Input readOnly value={articlePublicUrl(slug)} /><Button onClick={() => void copyArticleLink(slug)}>复制</Button><Button onClick={() => window.open(articlePublicUrl(slug), "_blank", "noopener,noreferrer")}>打开</Button></Space.Compact></Form.Item> : null;
        }}</Form.Item>
        <Form.Item name="title" label="文章标题" rules={[{ required: true, min: 2, max: 160 }]}><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="summary" label="摘要" rules={[{ required: true, min: 10, max: 500 }]}><TextArea rows={3} maxLength={500} disabled={!canEdit} /></Form.Item>
        <Form.Item name="coverImageUrl" label="文章封面图片" extra={<Space direction="vertical" size={6}><Text type="secondary">建议 16:9、最小 1600×900。封面会显示在文章列表与详情顶部。</Text><Upload accept="image/jpeg,image/png,image/webp,image/jpg" showUploadList={false} beforeUpload={(file) => uploadArticleImage(file as File, "cover")}><Button icon={<UploadOutlined />} loading={imageUploading} disabled={!canEdit}>上传封面图片</Button></Upload></Space>}><Input placeholder="上传后自动填写，也可填写 HTTPS 图片地址" disabled={!canEdit} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.coverImageUrl !== current.coverImageUrl}>{() => form.getFieldValue("coverImageUrl") ? <img src={form.getFieldValue("coverImageUrl")} alt="文章封面预览" style={{ width: "100%", maxWidth: 480, aspectRatio: "16 / 9", objectFit: "cover", borderRadius: 10, marginBottom: 18 }} /> : null}</Form.Item>
        <Form.Item name="bodyHtml" label="正文编辑器" rules={[{ required: true, min: 20, max: 50000 }]} extra={<Space direction="vertical" size={6}><Text type="secondary">支持可视化排版、HTML 源码切换，以及直接粘贴图片自动上传。正文图片会插入末尾，可在编辑器中剪切到目标段落。保存时服务端再次过滤危险内容。</Text><Upload accept="image/jpeg,image/png,image/webp,image/jpg" showUploadList={false} beforeUpload={(file) => uploadArticleImage(file as File, "inline")}><Button icon={<UploadOutlined />} loading={imageUploading} disabled={!canEdit}>上传并插入正文图片</Button></Upload></Space>}><RichArticleEditor disabled={!canEdit} onPasteImage={(file) => new Promise((resolve) => { void uploadArticleImage(file, "paste", resolve); })} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.bodyHtml !== current.bodyHtml}>{() => <><Divider orientation="left">HTML 安全预览</Divider><iframe title="文章 HTML 预览" sandbox="" style={{ width: "100%", minHeight: 320, border: "1px solid #eee", borderRadius: 10 }} srcDoc={`<style>body{font-family:system-ui,sans-serif;line-height:1.75;padding:20px;color:#211c2d}img{max-width:100%;height:auto;border-radius:12px}figure{margin:20px 0}figcaption{color:#716b7d;font-size:13px;text-align:center}blockquote{margin:18px 0;padding:12px 16px;border-left:3px solid #8d52ff;background:#f6f1ff}a{color:#6d3ae8}${ARTICLE_PREVIEW_COLOR_CSS}</style>${String(form.getFieldValue("bodyHtml") || "")}`} /></>}</Form.Item>
        <Space size={16} style={{ display: "flex" }}>
          <Form.Item name="sourceName" label="来源名称（选填）" style={{ flex: 1 }}><Input maxLength={120} disabled={!canEdit} placeholder="填写后才会在文章正文底部展示" /></Form.Item>
          <Form.Item name="sourceUrl" label="来源链接（选填）" style={{ flex: 1 }} rules={[{ type: "url", message: "请输入完整 https:// 链接" }]}><Input maxLength={500} disabled={!canEdit} placeholder="填写后才会在文章正文底部展示" /></Form.Item>
        </Space>
        <Form.Item name="topics" label="主题标签"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={12} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoTitle" label="SEO 标题"><Input maxLength={160} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoDescription" label="SEO 描述"><TextArea rows={2} maxLength={300} disabled={!canEdit} /></Form.Item>
        <Form.Item name="seoKeywords" label="SEO 关键词"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={30} disabled={!canEdit} /></Form.Item>
        <Form.Item name="geoKeywords" label="GEO 主题词"><Select mode="tags" tokenSeparators={[",", "，", "\n"]} maxCount={30} disabled={!canEdit} /></Form.Item>
        <Form.Item name="status" label="保存状态"><Select disabled={!canEdit} options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "archived", label: "已下线" }]} /></Form.Item>
        <Form.Item name="reason" label="变更原因"><TextArea rows={2} maxLength={500} disabled={!canEdit} placeholder="建议填写，便于后台审计" /></Form.Item>
      </Form>
    </Drawer>
  </Space>;
};

export default ArticlesPage;
