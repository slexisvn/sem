import { Catalog, MeasureInfo, ModelInfo } from "../analyzer/catalog.js";
import { printExpr } from "../ast/print.js";
import { AggOverride } from "../ast/nodes.js";
import { formatUnit } from "../config/units.js";
import { Span } from "../lexer/token.js";

export type SymbolKind = "model" | "dimension" | "measure" | "metric" | "segment";

export function measureSignature(measure: MeasureInfo): string {
  const unit = measure.unit !== undefined ? ` : ${formatUnit(measure.unit)}` : "";
  const additivity = measure.additivity !== undefined ? ` ${formatAdditivity(measure.additivity)}` : "";
  return `measure ${measure.name}${unit}${additivity} = ${printExpr(measure.expr)}`;
}

function formatAdditivity(override: AggOverride): string {
  return override.kind === "non_additive" ? "non_additive" : `semi_additive(${override.rule} by ${override.dim})`;
}

export interface Symbol {
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly model?: string;
  readonly detail: string;
  readonly documentation: string;
  readonly span: Span;
}

export class SymbolService {
  private readonly catalog: Catalog;

  constructor(catalog: Catalog) {
    this.catalog = catalog;
  }

  public symbols(): Symbol[] {
    const out: Symbol[] = [];
    for (const model of this.catalog.models.values()) {
      out.push({
        name: model.name,
        qualifiedName: model.name,
        kind: "model",
        detail: `model ${model.name} (${model.table})`,
        documentation: [
          `**Model** \`${model.name}\``,
          "",
          `- Table: \`${model.table}\``,
          `- Primary key: \`${model.primaryKey}\``,
          `- Dimensions: ${model.dims.size}`,
          `- Measures: ${model.measures.size}`,
          `- Metrics: ${model.metrics.size}`
        ].join("\n"),
        span: model.span
      });
      for (const dim of model.dims.values()) {
        const expr = printExpr(dim.expr);
        out.push({
          name: dim.name,
          qualifiedName: `${model.name}.${dim.name}`,
          kind: "dimension",
          model: model.name,
          detail: `dimension ${dim.name}: ${dim.type} = ${expr}`,
          documentation: [
            `**Dimension** \`${model.name}.${dim.name}\``,
            "",
            `- Type: \`${dim.type}\``,
            `- Model: \`${model.name}\``,
            "",
            "```sem",
            `dimension ${dim.name}: ${dim.type} = ${expr}`,
            "```"
          ].join("\n"),
          span: dim.span
        });
      }
      for (const measure of model.measures.values()) {
        const detail = measureSignature(measure);
        out.push({
          name: measure.name,
          qualifiedName: `${model.name}.${measure.name}`,
          kind: "measure",
          model: model.name,
          detail,
          documentation: [
            `**Measure** \`${model.name}.${measure.name}\``,
            "",
            `- Model: \`${model.name}\``,
            ...(measure.unit !== undefined ? [`- Unit: \`${formatUnit(measure.unit)}\``] : []),
            "",
            "```sem",
            detail,
            "```"
          ].join("\n"),
          span: measure.span
        });
      }
      for (const metric of model.metrics.values()) {
        const detail = this.metricDetail(model, metric.name);
        out.push({
          name: metric.name,
          qualifiedName: `${model.name}.${metric.name}`,
          kind: "metric",
          model: model.name,
          detail,
          documentation: [
            `**Metric** \`${model.name}.${metric.name}\``,
            "",
            `- Model: \`${model.name}\``,
            "",
            "```sem",
            detail,
            "```"
          ].join("\n"),
          span: metric.span
        });
      }
      for (const segment of model.segments.values()) {
        const detail = `segment ${segment.name} = ${printExpr(segment.expr)}`;
        out.push({
          name: segment.name,
          qualifiedName: `${model.name}.${segment.name}`,
          kind: "segment",
          model: model.name,
          detail,
          documentation: [
            `**Segment** \`${model.name}.${segment.name}\``,
            "",
            `- Model: \`${model.name}\``,
            "",
            "```sem",
            detail,
            "```"
          ].join("\n"),
          span: segment.span
        });
      }
    }
    return out;
  }

  public definitionOf(name: string): Symbol | undefined {
    return this.symbols().find((s) => s.name === name || s.qualifiedName === name);
  }

  public hover(name: string): string | undefined {
    return this.definitionOf(name)?.documentation;
  }

  public completions(prefix: string): string[] {
    const lower = prefix.toLowerCase();
    const names = new Set<string>();
    for (const symbol of this.symbols()) {
      if (symbol.name.toLowerCase().startsWith(lower)) names.add(symbol.name);
      if (symbol.qualifiedName.toLowerCase().startsWith(lower)) names.add(symbol.qualifiedName);
    }
    return [...names].sort();
  }

  private metricDetail(model: ModelInfo, name: string): string {
    const metric = model.metrics.get(name)!;
    const filter = metric.filter !== undefined ? ` where ${printExpr(metric.filter)}` : "";
    return `metric ${name} = ${printExpr(metric.expr)}${filter}`;
  }
}

export function generateDocs(catalog: Catalog): string {
  const lines: string[] = ["# Metric catalog", ""];
  for (const model of catalog.models.values()) {
    lines.push(`## ${model.name}`, "", `- **Table:** \`${model.table}\``, `- **Primary key:** \`${model.primaryKey}\``, "");
    if (model.joins.length > 0) {
      lines.push("### Joins", "");
      for (const join of model.joins) {
        lines.push(`- \`${join.target}\` (${join.cardinality})`);
      }
      lines.push("");
    }
    docSection(lines, "Dimensions", [...model.dims.values()].map((d) => `\`${d.name}\`: ${d.type}`));
    docSection(lines, "Measures", [...model.measures.values()].map((m) => `\`${measureSignature(m)}\``));
    docSection(
      lines,
      "Metrics",
      [...model.metrics.values()].map((m) => {
        const filter = m.filter !== undefined ? ` where ${printExpr(m.filter)}` : "";
        return `\`${m.name}\` = ${printExpr(m.expr)}${filter}`;
      })
    );
    docSection(lines, "Segments", [...model.segments.values()].map((s) => `\`${s.name}\` = ${printExpr(s.expr)}`));
  }
  return lines.join("\n").trimEnd() + "\n";
}

function docSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  lines.push(`### ${title}`, "");
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}
