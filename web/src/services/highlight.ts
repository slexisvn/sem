import Prism from "prismjs";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-javascript";

Prism.languages.sem = {
  comment: /#.*/,
  string: {
    pattern: /'(?:''|[^'])*'/,
    greedy: true,
    inside: {
      escape: /''/,
    },
  },
  unit: {
    pattern: /(\bmeasure\s+[A-Za-z_]\w*\s*:\s*)[A-Za-z_]\w*(?:\s*[*/]\s*[A-Za-z_]\w*)*/,
    lookbehind: true,
    inside: { operator: /[*/]/ },
  },
  keyword:
    /\b(?:model|table|primary_key|timezone|fiscal_year_starts|join|on|asof|dimension|measure|metric|segment|show|by|where|having|order|asc|desc|top|assert|policy|restrict|materialize|as|funnel|steps|over|retention|periods|and|or|not|in|between|like|true|false)\b/,
  modifier: /\b(?:distinct|semi_additive|non_additive|last|first)\b/,
  type: /\b(?:string|number|boolean|time)\b/,
  function: /\b(?:sum|count|avg|min|max|median|percentile|approx_median|approx_percentile)\b(?=\s*\()/,
  transform: /(?<=\.)(?:mom|yoy|rolling|cumulative|share|of|mtd|qtd|ytd)\b/,
  cardinality: /\b(?:many_to_one|one_to_many|one_to_one|many_to_many)\b/,
  duration: /\b\d+(?:d|w|m|q|y)\b/,
  number: /\b\d+(?:\.\d+)?\b/,
  operator: /==|!=|<=|>=|<|>|=|\+|-|\*|\//,
  punctuation: /[{}()[\],.:]/,
};

export type HighlightLanguage = "sem" | "sql" | "javascript";

export function highlightCode(code: string, language: HighlightLanguage): string {
  return Prism.highlight(code, Prism.languages[language], language);
}
