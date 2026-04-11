import { useMemo } from "react";
import hljs from "highlight.js";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

marked.setOptions({ breaks: true, gfm: true });

export function StreamingMessage({ content }: { content: string }) {
  const html = useMemo(() => {
    if (!content) return "";
    return marked.parse(content) as string;
  }, [content]);

  return (
    <div
      className="prose prose-invert prose-sm max-w-none break-words
        [&_pre]:bg-gray-950 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto
        [&_code]:text-sm [&_code]:font-mono
        [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
