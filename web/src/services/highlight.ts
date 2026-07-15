import Prism from "prismjs";
import "prismjs/components/prism-sql";

Prism.languages.sem = {
  comment: /#.*/,
  string: {
    pattern: /'(?:''|[^'])*'/,
    greedy: true,
    inside: {
      escape: /''/,
    },
  },
  keyword:
    /\b(?:model|table|primary_key|join|on|dimension|measure|metric|show|by|where|having|order|asc|desc|top|assert|policy|restrict|materialize|as|and|or|not|in|between|like|true|false)\b/,
  modifier: /\bdistinct\b/,
  type: /\b(?:string|number|boolean|time)\b/,
  function: /\b(?:sum|count|avg|min|max)\b(?=\s*\()/,
  transform: /(?<=\.)(?:mom|yoy|rolling|cumulative|share)\b/,
  cardinality: /\b(?:many_to_one|one_to_many|one_to_one|many_to_many)\b/,
  duration: /\b\d+(?:d|w|m|q|y)\b/,
  number: /\b\d+(?:\.\d+)?\b/,
  operator: /==|!=|<=|>=|<|>|=|\+|-|\*|\//,
  punctuation: /[{}()[\],.:]/,
};

export type HighlightLanguage = "sem" | "sql";

export function highlightCode(code: string, language: HighlightLanguage): string {
  return Prism.highlight(code, Prism.languages[language], language);
}
