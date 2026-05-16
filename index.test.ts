import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { type DuckDBConnection } from "@duckdb/node-api";
import {
  readFunctionFor,
  escapeString,
  escapeIdentifier,
  formatResults,
  executeQuery,
  loadSettings,
  setConnection,
  setDbPath,
  setMaxRows,
  getConnection,
  type QueryResult,
  type ColumnInfo,
} from "./index.ts";

// ── Unit tests ─────────────────────────────────────────────────────────────

describe("escapeString", () => {
  it("leaves a plain string unchanged", () => {
    assert.equal(escapeString("hello"), "hello");
  });

  it("escapes single quotes", () => {
    assert.equal(escapeString("it's"), "it''s");
  });
});

describe("escapeIdentifier", () => {
  it("wraps a simple name in double quotes", () => {
    assert.equal(escapeIdentifier("sales"), '"sales"');
  });

  it("escapes double quotes inside the name", () => {
    assert.equal(escapeIdentifier('tab"le'), '"tab""le"');
  });
});

describe("readFunctionFor", () => {
  const cases: [string, string][] = [
    ["/data/file.csv", "read_csv_auto('/data/file.csv')"],
    ["file.tsv", "read_csv_auto('file.tsv')"],
    ["data.parquet", "read_parquet('data.parquet')"],
    ["data.pq", "read_parquet('data.pq')"],
    ["data.json", "read_json_auto('data.json')"],
    ["data.jsonl", "read_json_auto('data.jsonl', format='newline_delimited')"],
    ["data.ndjson", "read_json_auto('data.ndjson', format='newline_delimited')"],
  ];

  for (const [path, expected] of cases) {
    it(`detects ${path} format correctly`, () => {
      assert.equal(readFunctionFor(path), expected);
    });
  }

  it("escapes quotes in paths", () => {
    assert.equal(readFunctionFor("it's.csv"), "read_csv_auto('it''s.csv')");
  });

  it("throws on unsupported extensions", () => {
    assert.throws(() => readFunctionFor("data.xlsx"), /Unsupported file extension/);
  });
});

describe("formatResults", () => {
  const columns: ColumnInfo[] = [
    { name: "name", type: "VARCHAR" },
    { name: "age", type: "INTEGER" },
  ];

  it("returns empty message for no rows", () => {
    const res: QueryResult = { columns, rows: [], truncated: false, totalRows: 0 };
    assert.equal(formatResults(res, 500), "(no rows returned)");
  });

  it("formats rows into a table", () => {
    const res: QueryResult = {
      columns,
      rows: [["Alice", 30], ["Bob", 25]],
      truncated: false,
      totalRows: 2,
    };
    const output = formatResults(res, 500);
    assert.match(output, /Alice/);
    assert.match(output, /Bob/);
    assert.match(output, /name/);
    assert.match(output, /age/);
    assert.match(output, /\+\-+\+/);
  });

  it("appends truncation notice when truncated", () => {
    const res: QueryResult = {
      columns,
      rows: [["Alice", 30]],
      truncated: true,
      totalRows: 100,
    };
    const output = formatResults(res, 1);
    assert.match(output, /99 more row/);
    assert.match(output, /maxRows=1/);
  });
});

describe("loadSettings", () => {
  const ORIG = process.env.PI_AGENT_DIR;

  after(() => {
    if (ORIG) process.env.PI_AGENT_DIR = ORIG;
    else delete process.env.PI_AGENT_DIR;
  });

  it("returns defaults when PI_AGENT_DIR is not set", () => {
    delete process.env.PI_AGENT_DIR;
    const cfg = loadSettings();
    assert.equal(cfg.dbPath, null);
    assert.equal(cfg.maxRows, 500);
  });

  it("returns defaults when settings.json does not exist", () => {
    process.env.PI_AGENT_DIR = "/nonexistent/path";
    const cfg = loadSettings();
    assert.equal(cfg.dbPath, null);
    assert.equal(cfg.maxRows, 500);
  });
});

// ── Integration with DuckDB ────────────────────────────────────────────────

describe("DuckDB integration", () => {
  let conn: DuckDBConnection;

  before(async () => {
    setDbPath(null);
    setMaxRows(500);
    setConnection(null);
    conn = await getConnection();
  });

  after(async () => {
    setConnection(null);
  });

  it("executeQuery returns column metadata and rows", async () => {
    const result = await executeQuery("SELECT 1 AS a, 'hello' AS b", 500);
    assert.equal(result.columns.length, 2);
    assert.equal(result.columns[0].name, "a");
    assert.equal(result.columns[1].name, "b");
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0][0]), 1);
    assert.equal(result.rows[0][1], "hello");
    assert.equal(result.truncated, false);
  });

  it("executeQuery truncates at maxRows", async () => {
    const result = await executeQuery(
      "SELECT * FROM (VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9), (10)) AS t(x) ORDER BY x",
      3,
    );
    assert.equal(result.rows.length, 3);
    assert.equal(result.truncated, true);
    assert.equal(result.totalRows, 10);
  });

  it("executeQuery handles empty results", async () => {
    const result = await executeQuery("SELECT 1 WHERE 1=0", 500);
    assert.equal(result.rows.length, 0);
    assert.equal(result.truncated, false);
  });

  it("create view and query across loaded tables", async () => {
    await conn.run('CREATE OR REPLACE VIEW "_test_a" AS SELECT * FROM (VALUES (1, \'x\'), (2, \'y\')) AS t(id, val)');
    await conn.run('CREATE OR REPLACE VIEW "_test_b" AS SELECT * FROM (VALUES (1, \'foo\'), (2, \'bar\')) AS t(id, label)');

    const result = await executeQuery(
      'SELECT a.id, a.val, b.label FROM "_test_a" a JOIN "_test_b" b ON a.id = b.id ORDER BY a.id',
      500,
    );
    assert.equal(result.rows.length, 2);
    assert.equal(Number(result.rows[0][0]), 1);
    assert.equal(result.rows[0][1], "x");
    assert.equal(result.rows[0][2], "foo");
    assert.equal(Number(result.rows[1][0]), 2);
    assert.equal(result.rows[1][1], "y");
    assert.equal(result.rows[1][2], "bar");
  });

  it("query with subquery works", async () => {
    const result = await executeQuery(
      "SELECT * FROM (SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS inner_t(x, y)) AS outer_t WHERE x > 1",
      500,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0][0]), 2);
    assert.equal(result.rows[0][1], "b");
  });

  it("query with CTE works", async () => {
    const result = await executeQuery(
      "WITH cte AS (SELECT * FROM (VALUES (10, 'ten'), (20, 'twenty')) AS t(num, word)) SELECT word FROM cte WHERE num = 20",
      500,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0][0], "twenty");
  });

  it("query with identifier needing quoting works", async () => {
    await conn.run('CREATE OR REPLACE VIEW "test-table" AS SELECT * FROM (VALUES (42)) AS t(val)');
    const result = await executeQuery('SELECT val FROM "test-table"', 500);
    assert.equal(result.rows.length, 1);
    assert.equal(Number(result.rows[0][0]), 42);
  });

  it("runs DDL queries directly", async () => {
    await executeQuery("CREATE TABLE _test_ddl (x INTEGER)", 500);
    await executeQuery("INSERT INTO _test_ddl VALUES (1), (2), (3)", 500);
    const result = await executeQuery("SELECT * FROM _test_ddl ORDER BY x", 500);
    assert.equal(result.rows.length, 3);
    assert.equal(Number(result.rows[0][0]), 1);
  });

  it("alchemy_tables lists loaded views", async () => {
    await conn.run("CREATE OR REPLACE VIEW _test_list_tbl AS SELECT * FROM (VALUES (1)) AS t(v)");
    const result = await executeQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
      500,
    );
    const names = result.rows.map((r) => r[0] as string);
    assert.ok(names.includes("_test_list_tbl"));
  });

  it("alchemy_schema returns columns for a view", async () => {
    await conn.run("CREATE OR REPLACE VIEW _test_schema_tbl AS SELECT * FROM (VALUES (1, 'a', true)) AS t(id, label, active)");
    const result = await executeQuery(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '_test_schema_tbl' AND table_schema = 'main' ORDER BY ordinal_position",
      500,
    );
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0][0], "id");
    assert.equal(result.rows[1][0], "label");
    assert.equal(result.rows[2][0], "active");
  });

  it("alchemy_schema returns empty for nonexistent table", async () => {
    const result = await executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = '_nonexistent_xyz' AND table_schema = 'main'",
      500,
    );
    assert.equal(result.rows.length, 0);
  });
});
