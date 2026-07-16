import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { snippetCompletion } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

const keywordRE =
  /^(?:model|table|primary_key|timezone|join|on|asof|dimension|measure|metric|segment|show|by|where|having|order|asc|desc|top|assert|policy|restrict|materialize|as|funnel|steps|over|retention|periods|and|or|not|in|between|like|true|false)\b/;
const modifierRE = /^(?:distinct|semi_additive|non_additive|last|first)\b/;
const typeRE = /^(?:string|number|boolean|time)\b/;
const aggregateRE = /^(?:sum|count|avg|min|max|median|percentile|approx_median|approx_percentile)\b(?=\s*\()/;
const transformRE = /^(?:mom|yoy|rolling|cumulative|share|of|mtd|qtd|ytd)\b/;
const cardinalityRE = /^(?:many_to_one|one_to_many|one_to_one|many_to_many)\b/;
const durationRE = /^\d+(?:d|w|m|q|y)\b/;
const numberRE = /^\d+(?:\.\d+)?\b/;
const operatorRE = /^(?:==|!=|<=|>=|<|>|=|\+|-|\*|\/)/;
const punctuationRE = /^[{}()[\],.:]/;

interface SemState {
  afterMeasure: boolean;
  inUnit: boolean;
}

export const semLanguage = StreamLanguage.define<SemState>({
  tokenTable: {
    function: tags.function(tags.variableName),
    constant: tags.atom,
    modifier: tags.modifier,
    type: tags.typeName,
  },
  startState: () => ({ afterMeasure: false, inUnit: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.afterMeasure = false;
      state.inUnit = false;
    }
    if (stream.eatSpace()) return null;

    if (stream.match(/#.*/)) return "comment";

    if (stream.peek() === "'") {
      stream.next();
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === "'" && stream.peek() === "'") {
          stream.next();
          continue;
        }
        if (ch === "'") break;
      }
      return "string";
    }

    if (state.inUnit) {
      if (stream.peek() === "=" || stream.match(modifierRE, false)) state.inUnit = false;
      else if (stream.match(/^[*/]/)) return "operator";
      else if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "type";
    }

    if (stream.match(aggregateRE)) return "function";
    if (stream.match(keywordRE)) {
      state.afterMeasure = stream.current() === "measure";
      return "keyword";
    }
    if (stream.match(modifierRE)) return "modifier";
    if (stream.match(typeRE)) return "type";
    if (stream.match(cardinalityRE)) return "constant";
    if (stream.match(durationRE)) return "number";
    if (stream.match(numberRE)) return "number";
    if (stream.match(operatorRE)) return "operator";

    if (stream.peek() === ".") {
      stream.next();
      if (stream.match(transformRE)) return "function";
      return "punctuation";
    }

    if (stream.peek() === ":") {
      stream.next();
      if (state.afterMeasure) state.inUnit = true;
      state.afterMeasure = false;
      return "punctuation";
    }

    if (stream.match(punctuationRE)) return "punctuation";

    stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    return "variableName";
  },
});

export const semHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "#6a737d", fontStyle: "italic" },
  { tag: tags.keyword, color: "#c586c0" },
  { tag: tags.modifier, color: "#9cdcfe" },
  { tag: tags.typeName, color: "#4ec9b0" },
  { tag: tags.atom, color: "#4ec9b0" },
  { tag: tags.function(tags.variableName), color: "#dcdcaa" },
  { tag: tags.string, color: "#ce9178" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.punctuation, color: "#9cdcfe" },
  { tag: tags.variableName, color: "#e6edf3" },
]);

export const semHighlighting = syntaxHighlighting(semHighlightStyle);

const keywordCompletions = [
  "model",
  "table",
  "primary_key",
  "timezone",
  "join",
  "on",
  "asof",
  "dimension",
  "measure",
  "metric",
  "segment",
  "show",
  "by",
  "where",
  "having",
  "order",
  "asc",
  "desc",
  "top",
  "assert",
  "policy",
  "restrict",
  "materialize",
  "as",
  "funnel",
  "steps",
  "over",
  "retention",
  "periods",
  "and",
  "or",
  "not",
  "in",
  "between",
  "like",
  "true",
  "false",
].map((label) => ({ label, type: "keyword" }));

const typeCompletions = ["string", "number", "boolean", "time"].map((label) => ({
  label,
  type: "type",
}));

const aggregateCompletions = ["sum", "count", "avg", "min", "max", "median", "percentile", "approx_median", "approx_percentile"].map((label) => ({
  label,
  type: "function",
  apply: `${label}()`,
  detail: "aggregate",
}));

const transformCompletions = ["mom", "yoy", "rolling", "cumulative", "share", "of", "mtd", "qtd", "ytd"].map((label) => ({
  label,
  type: "function",
  detail: "transform",
}));

const cardinalityCompletions = [
  "many_to_one",
  "one_to_many",
  "one_to_one",
  "many_to_many",
].map((label) => ({ label, type: "constant", detail: "cardinality" }));

const snippetCompletions = [
  snippetCompletion("model ${name} {\n  table ${table}\n  primary_key ${id}\n\n  ${}\n}", {
    label: "model",
    type: "keyword",
    detail: "model block",
  }),
  snippetCompletion("dimension ${name}: ${type}", {
    label: "dimension",
    type: "keyword",
    detail: "dimension field",
  }),
  snippetCompletion("measure ${name} = ${aggregate}(${column})", {
    label: "measure",
    type: "keyword",
    detail: "measure expression",
  }),
  snippetCompletion("metric ${name} = ${measure} where ${condition}", {
    label: "metric",
    type: "keyword",
    detail: "filtered metric",
  }),
  snippetCompletion("show ${metrics} by ${dimension}", {
    label: "show",
    type: "keyword",
    detail: "query",
  }),
];

const baseCompletions = [
  ...snippetCompletions,
  ...keywordCompletions,
  ...typeCompletions,
  ...aggregateCompletions,
  ...cardinalityCompletions,
];

export function semCompletions(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/(?:\.[A-Za-z_]*)|[A-Za-z_][A-Za-z0-9_]*/);
  if (!word && !context.explicit) return null;

  const text = word?.text ?? "";
  const from = word?.from ?? context.pos;
  const isTransform = text.startsWith(".");
  return {
    from: isTransform ? from + 1 : from,
    options: isTransform ? transformCompletions : baseCompletions,
    validFor: isTransform ? /^[A-Za-z_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/,
  };
}
