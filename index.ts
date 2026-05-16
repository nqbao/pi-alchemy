import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { homedir } from "node:os";

// ── State ──────────────────────────────────────────────────────────────────

let _dbPath: string | null = null;
let _maxRows = 500;
let _connection: DuckDBConnection | null = null;

// ── Config ─────────────────────────────────────────────────────────────────

export interface AlchemyConfig {
  dbPath?: string | null;
  maxRows?: number;
}

export function loadSettings(): AlchemyConfig {
  try {
    const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
    const settingsPath = join(agentDir, "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.alchemy) {
      return {
        dbPath: parsed.alchemy.dbPath ?? null,
        maxRows: parsed.alchemy.maxRows ?? 500,
      };
    }
  } catch {
    // settings not accessible — use defaults
  }
  return { dbPath: null, maxRows: 500 };
}

// ── DuckDB helpers ─────────────────────────────────────────────────────────

export async function getConnection(): Promise<DuckDBConnection> {
  if (_connection) return _connection;
  const instance = await DuckDBInstance.create(_dbPath ?? ":memory:");
  _connection = await instance.connect();
  return _connection;
}

export function setConnection(conn: DuckDBConnection | null): void {
  _connection = conn;
}

export function setDbPath(path: string | null): void {
  _dbPath = path;
}

export function setMaxRows(n: number): void {
  _maxRows = n;
}

export function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

export function readFunctionFor(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case ".csv":
    case ".tsv":
      return `read_csv_auto('${escapeString(path)}')`;
    case ".parquet":
    case ".pq":
      return `read_parquet('${escapeString(path)}')`;
    case ".json":
      return `read_json_auto('${escapeString(path)}')`;
    case ".jsonl":
    case ".ndjson":
      return `read_json_auto('${escapeString(path)}', format='newline_delimited')`;
    default:
      throw new Error(`Unsupported file extension: ${ext}. Supported: .csv, .tsv, .parquet, .pq, .json, .jsonl, .ndjson`);
  }
}

// ── Query execution ────────────────────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  totalRows: number;
}

export async function executeQuery(sql: string, maxRows: number): Promise<QueryResult> {
  const conn = await getConnection();
  const result = await conn.run(sql);
  const colNames: string[] = result.columnNames();
  const colTypes = result.columnTypes();
  const columns: ColumnInfo[] = colNames.map((name, i) => ({ name, type: colTypes[i]?.toString() ?? "unknown" }));

  const allRows = await result.getRows();
  const typedRows = allRows.map((row) => Array.from(row)) as unknown[][];

  const totalRows = typedRows.length;
  const truncated = totalRows > maxRows;
  const rows = truncated ? typedRows.slice(0, maxRows) : typedRows;

  return { columns, rows, truncated, totalRows };
}

export function formatResults(res: QueryResult, maxRows: number): string {
  if (res.rows.length === 0) {
    return "(no rows returned)";
  }

  const colWidths = res.columns.map((col, i) => {
    const headerLen = col.name.length;
    const maxDataLen = res.rows.reduce((max, row) => {
      const val = row[i] ?? "";
      return Math.max(max, String(val).length);
    }, 0);
    return Math.max(headerLen, maxDataLen, 3);
  });

  const sep = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  const formatRow = (row: unknown[]): string => {
    return (
      "| " +
      row
        .map((val, i) => {
          const s = val === null || val === undefined ? "NULL" : String(val);
          return s.padEnd(colWidths[i]);
        })
        .join(" | ") +
      " |"
    );
  };

  const header = "| " + res.columns.map((c, i) => c.name.padEnd(colWidths[i])).join(" | ") + " |";
  const body = res.rows.map(formatRow).join("\n");

  let footer = "";
  if (res.truncated) {
    const omitted = res.totalRows - maxRows;
    footer = `\n... (${omitted} more row(s) omitted, maxRows=${maxRows})`;
  }

  return `${sep}\n${header}\n${sep}\n${body}\n${sep}${footer}`;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const settings = loadSettings();
  if (settings.dbPath) _dbPath = settings.dbPath;
  _maxRows = settings.maxRows ?? 500;

  pi.registerFlag("alchemy-db", {
    description: "Path to persistent DuckDB database (default: in-memory)",
    type: "string",
  });

  pi.on("session_start", () => {
    const dbFlag = pi.getFlag("alchemy-db");
    if (typeof dbFlag === "string" && dbFlag) {
      _dbPath = dbFlag;
    } else {
      _dbPath = settings.dbPath ?? null;
    }
    _connection = null; // reset so next getConnection() creates with new dbPath
  });

  // ── alchemy_load ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "alchemy_load",
    label: "Alchemy Load",
    description:
      "Load a CSV, Parquet, JSON, or JSONL file into a named table for querying with alchemy_query. File access is centralized through this tool.",
    promptSnippet: "Load a data file into a named table",
    promptGuidelines: [
      "Use alchemy_load to load data files (CSV, Parquet, JSON, JSONL) into named tables.",
      "After loading, use alchemy_query to run SQL SELECT queries on the loaded tables.",
      "Tables persist for the session or until alchemy_load is called again with the same name.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the data file (.csv, .parquet, .json, .jsonl, .ndjson)" }),
      name: Type.String({ description: "Name for the table (used in SQL queries via alchemy_query)" }),
    }),
    async execute(_toolCallId, params) {
      const cwd = process.cwd();
      const absPath = resolve(cwd, params.path);

      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
        };
      }

      let reader: string;
      try {
        reader = readFunctionFor(absPath);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: String(err) }],
        };
      }

      const conn = await getConnection();
      const quotedName = escapeIdentifier(params.name);
      const sql = `CREATE OR REPLACE VIEW ${quotedName} AS SELECT * FROM ${reader}`;

      try {
        await conn.run(sql);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to load "${params.path}" as table "${params.name}": ${err instanceof Error ? err.message : String(err)}` }],
        };
      }

      try {
        const countResult = await conn.run(`SELECT COUNT(*)::INTEGER FROM ${quotedName}`);
        const countRows = await countResult.getRows();
        const rowCount = Number(countRows[0]?.[0] ?? 0);
        return {
          content: [{ type: "text" as const, text: `Loaded "${params.path}" as table "${params.name}" (${rowCount.toLocaleString()} rows)` }],
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Loaded "${params.path}" as table "${params.name}"` }],
        };
      }
    },
  });

  // ── alchemy_query ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "alchemy_query",
    label: "Alchemy Query",
    description:
      "Run a SQL query against tables loaded via alchemy_load. DuckDB executes the query directly.",
    promptSnippet: "Run a SQL query on loaded tables",
    promptGuidelines: [
      "Use alchemy_query to run SQL queries on tables loaded via alchemy_load.",
      "Results are limited to maxRows (default: 500). Queries exceeding this return an error.",
    ],
    parameters: Type.Object({
      sql: Type.String({ description: "SQL query to execute against loaded tables" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await executeQuery(params.sql, _maxRows);
        if (result.truncated) {
          return {
            content: [{ type: "text" as const, text: `Too many rows: ${result.totalRows} (max: ${_maxRows})` }],
          };
        }
        const colNames = result.columns.map((c) => c.name);
        const lines = result.rows.map((row) => {
          const obj: Record<string, unknown> = {};
          colNames.forEach((name, i) => {
            const val = row[i];
            obj[name] = typeof val === "bigint" ? Number(val) : val;
          });
          return JSON.stringify(obj);
        });
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Query failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  });
}
