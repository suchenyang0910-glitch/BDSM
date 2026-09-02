import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const windowInstance = new Window();
Object.assign(globalThis, {
  window: windowInstance,
  document: windowInstance.document,
  Node: windowInstance.Node,
  HTMLElement: windowInstance.HTMLElement,
  DOMParser: windowInstance.DOMParser,
  getSelection: windowInstance.getSelection.bind(windowInstance),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: windowInstance.navigator });

const { Editor } = await import("@tiptap/core");
const { default: StarterKit } = await import("@tiptap/starter-kit");
const { TextStyle } = await import("@tiptap/extension-text-style");
const { ArticleTextColor } = await import("../src/components/articleTextColor.ts");

function createEditor() {
  return new Editor({
    extensions: [StarterKit, TextStyle, ArticleTextColor],
    content: "<p>第一段</p><p>第二段</p>",
  });
}

test("Tiptap applies bold across a multi-paragraph selection", () => {
  const editor = createEditor();
  try {
    editor.commands.setTextSelection({ from: 1, to: 9 });
    assert.equal(editor.chain().focus().toggleBold().run(), true);
    assert.equal(editor.getHTML(), "<p><strong>第一段</strong></p><p><strong>第二段</strong></p>");
  } finally { editor.destroy(); }
});

test("Tiptap persists the selected fixed color token instead of an inline style", () => {
  const editor = createEditor();
  try {
    editor.commands.setTextSelection({ from: 1, to: 4 });
    assert.equal(editor.chain().focus().setMark("textStyle", { articleColor: "green" }).run(), true);
    assert.match(editor.getHTML(), /<span data-article-color="green">第一段<\/span>/);
    assert.doesNotMatch(editor.getHTML(), /style=/);
  } finally { editor.destroy(); }
});

test("Tiptap converts selected paragraphs into one continuous ordered list", () => {
  const editor = createEditor();
  try {
    editor.commands.setTextSelection({ from: 1, to: 9 });
    assert.equal(editor.chain().focus().toggleOrderedList().run(), true);
    assert.match(editor.getHTML(), /^<ol><li><p>第一段<\/p><\/li><li><p>第二段<\/p><\/li><\/ol>/);
  } finally { editor.destroy(); }
});
