# @nqbao/pi-alchemy

Turn raw data into insights — query, transform, and visualize data files from the terminal.

## Install

```bash
pi install npm:@nqbao/pi-alchemy
```

Or load locally during development:

```bash
pi -e ./index.ts
```

## Usage

```
You: Load the file sales.csv and tell me total revenue by region

Pi: Loaded "sales.csv" as table "sales" (1200 rows)
    → {region: "North", revenue: 452000}
       {region: "South", revenue: 381000}
       {region: "East",  revenue: 295000}
       {region: "West",  revenue: 528000}
```

Pi calls necessary tools to load and query data.

## Tools

### `alchemy_load`

Load a CSV, Parquet, JSON, or JSONL file into a named table:

```
alchemy_load(path="/data/sales.parquet", name="sales")
  → creates DuckDB view "sales" for querying
```

Supported formats: `.csv`, `.tsv`, `.parquet`, `.pq`, `.json`, `.jsonl`, `.ndjson`

### `alchemy_query`

Run a SQL query against loaded tables. Results are returned as JSONL:

```
alchemy_query(sql="SELECT city, pop FROM cities ORDER BY pop DESC LIMIT 2")
  → {"city":"Tokyo","pop":13960000}
    {"city":"London","pop":8982000}
```

Results are capped at `maxRows` (default: 500). Queries exceeding this return an error.

### `alchemy_tables`

List all loaded tables and their types:

```
alchemy_tables()
  → {"table_name":"sales","table_type":"VIEW"}
    {"table_name":"products","table_type":"VIEW"}
```

### `alchemy_schema`

Show column names, types, and nullability for a loaded table:

```
alchemy_schema(table="sales")
  → {"column_name":"region","data_type":"VARCHAR","is_nullable":"YES"}
    {"column_name":"revenue","data_type":"BIGINT","is_nullable":"YES"}
```

## Configuration

From Pi's `settings.json`:

```json
{
  "alchemy": {
    "dbPath": null,
    "maxRows": 500
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `dbPath` | `null` (in-memory) | Path to a persistent DuckDB database |
| `maxRows` | `500` | Maximum rows returned by `alchemy_query` |

## Flags

| Flag | Description |
|------|-------------|
| `--alchemy-db` | Path to a persistent DuckDB database (overrides settings) |

## Engine

Uses [@duckdb/node-api](https://www.npmjs.com/package/@duckdb/node-api) — official DuckDB Node.js binding. In-process OLAP, no server.

## Package

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
