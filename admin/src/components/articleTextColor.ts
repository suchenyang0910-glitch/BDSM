import { Extension } from "@tiptap/core";

const ARTICLE_COLOR_TOKENS = new Set(["black", "violet", "pink", "red", "orange", "green", "blue"]);

/**
 * Keep rich-text colors on an allowlisted data attribute. The server sanitizer
 * deliberately rejects arbitrary CSS style values from article HTML.
 */
export const ArticleTextColor = Extension.create({
  name: "articleTextColor",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        articleColor: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-article-color"),
          renderHTML: (attributes) => attributes.articleColor && ARTICLE_COLOR_TOKENS.has(attributes.articleColor)
            ? { "data-article-color": attributes.articleColor }
            : {},
        },
      },
    }];
  },
});
