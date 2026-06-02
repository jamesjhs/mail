import { all, exec, get } from "../db/sql.js";
import type { Rule } from "../types/models.js";

export const listRules = () =>
  all<Rule>(
    `SELECT id, name, pattern, endpoint_url as endpointUrl, pattern_type as patternType, enabled, created_at as createdAt
     FROM routing_rule
     ORDER BY id DESC`,
  );

export const createRule = async ({
  name,
  pattern,
  endpointUrl,
  patternType,
}: {
  name: string;
  pattern: string;
  endpointUrl: string;
  patternType: "wildcard" | "regex";
}) => {
  await exec(
    "INSERT INTO routing_rule (name, pattern, endpoint_url, pattern_type) VALUES (?, ?, ?, ?)",
    [name, pattern, endpointUrl, patternType],
  );
};

export const updateRule = async (
  id: number,
  payload: { name: string; pattern: string; endpointUrl: string; patternType: "wildcard" | "regex"; enabled: number },
) => {
  await exec(
    `UPDATE routing_rule
     SET name = ?, pattern = ?, endpoint_url = ?, pattern_type = ?, enabled = ?
     WHERE id = ?`,
    [payload.name, payload.pattern, payload.endpointUrl, payload.patternType, payload.enabled, id],
  );
};

export const deleteRule = async (id: number) => {
  await exec("DELETE FROM routing_rule WHERE id = ?", [id]);
};

const wildcardToRegex = (pattern: string) =>
  `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`;

export const matchRule = async (prefix: string) => {
  const rules = await all<Rule>(
    `SELECT id, name, pattern, endpoint_url as endpointUrl, pattern_type as patternType, enabled, created_at as createdAt
     FROM routing_rule
     WHERE enabled = 1`,
  );

  for (const rule of rules) {
    const regex =
      rule.patternType === "regex" ? new RegExp(rule.pattern, "i") : new RegExp(wildcardToRegex(rule.pattern), "i");

    const result = regex.exec(prefix);
    if (result) {
      const id = result[1] ?? prefix;
      return { rule, extractedId: id };
    }
  }

  return null;
};

export const countRules = async () => {
  const row = await get<{ total: number }>("SELECT COUNT(*) as total FROM routing_rule WHERE enabled = 1");
  return row?.total ?? 0;
};
