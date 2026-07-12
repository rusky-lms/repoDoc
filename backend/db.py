import asyncpg
import json
def parse_query(query: dict) -> tuple[str, list]:
    # Extremely basic query parser for top-level exact matches, $in, $ne
    # Returns (sql_where_clause, params)
    if not query:
        return "true", []
    conditions = []
    params = []
    for k, v in query.items():
        if isinstance(v, dict):
            if "$in" in v:
                # Handle $in
                in_list = v["$in"]
                if not in_list:
                    conditions.append("false")
                else:
                    placeholders = []
                    for val in in_list:
                        params.append(val)
                        placeholders.append(f"${len(params)}")
                    conditions.append(f"doc->>'{k}' IN ({','.join(placeholders)})")
            elif "$nin" in v:
                nin_list = v["$nin"]
                if not nin_list:
                    conditions.append("true")
                else:
                    placeholders = []
                    for val in nin_list:
                        params.append(val)
                        placeholders.append(f"${len(params)}")
                    conditions.append(f"doc->>'{k}' NOT IN ({','.join(placeholders)})")
            elif "$ne" in v:
                params.append(v["$ne"])
                conditions.append(f"doc->>'{k}' != ${len(params)}")
            elif "$exists" in v:
                if v["$exists"]:
                    conditions.append(f"doc ? '{k}'")
                else:
                    conditions.append(f"NOT (doc ? '{k}')")
        else:
            params.append(v)
            if v is None:
                conditions.append(f"doc->>'{k}' IS NULL")
            elif isinstance(v, bool):
                conditions.append(f"(doc->>'{k}')::boolean = ${len(params)}")
            elif isinstance(v, int):
                conditions.append(f"(doc->>'{k}')::numeric = ${len(params)}")
            else:
                conditions.append(f"doc->>'{k}' = ${len(params)}")
    return " AND ".join(conditions), params
class Cursor:
    def __init__(self, collection, query, projection=None):
        self.collection = collection
        self.query = query
        self.projection = projection
        self._sort = None

    def sort(self, field, direction=-1):
        self._sort = (field, "DESC" if direction == -1 else "ASC")
        return self

    async def to_list(self, length=None):
        await self.collection._ensure_table()
        where_clause, params = parse_query(self.query)
        order_clause = ""
        if self._sort:
            field, direction = self._sort
            order_clause = f" ORDER BY doc->>'{field}' {direction}"
        limit_clause = f" LIMIT {length}" if length else ""
        sql = f"SELECT id, doc FROM {self.collection.name} WHERE {where_clause}{order_clause}{limit_clause}"
        async with self.collection.db.pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        results = []
        for row in rows:
            d = json.loads(row['doc'])
            d["id"] = row["id"]
            results.append(d)
        # Extremely basic projection handler
        if self.projection:
            exclusions = [k for k, v in self.projection.items() if v == 0]
            if exclusions:
                for res in results:
                    for k in exclusions:
                        res.pop(k, None)
        return results
class DeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count
class UpdateResult:
    def __init__(self, matched_count, modified_count=0):
        self.matched_count = matched_count
        self.modified_count = modified_count
class PgCollection:
    def __init__(self, db, name):
        self.db = db
        self.name = name
    async def _ensure_table(self):
        async with self.db.pool.acquire() as conn:
            await conn.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.name} (
                    id TEXT PRIMARY KEY,
                    doc JSONB NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
    async def insert_one(self, doc):
        await self._ensure_table()
        async with self.db.pool.acquire() as conn:
            id_val = doc.get("id", doc.get("_id", "no_id"))
            if "_id" in doc:
                doc = dict(doc)
                del doc["_id"]
            await conn.execute(f"INSERT INTO {self.name} (id, doc) VALUES ($1, $2)", str(id_val), json.dumps(doc))
        class Res:
            inserted_id = id_val
        return Res()
    async def find_one(self, query, projection=None):
        await self._ensure_table()
        where_clause, params = parse_query(query)
        sql = f"SELECT id, doc FROM {self.name} WHERE {where_clause} LIMIT 1"
        async with self.db.pool.acquire() as conn:
            row = await conn.fetchrow(sql, *params)
        if row:
            res = json.loads(row['doc'])
            res["id"] = row["id"]
            if projection:
                exclusions = [k for k, v in projection.items() if v == 0]
                for k in exclusions:
                    res.pop(k, None)
            return res
        return None
    def find(self, query, projection=None):
        return Cursor(self, query, projection)
    async def delete_one(self, query):
        await self._ensure_table()
        where_clause, params = parse_query(query)
        sql = f"DELETE FROM {self.name} WHERE id IN (SELECT id FROM {self.name} WHERE {where_clause} LIMIT 1)"
        async with self.db.pool.acquire() as conn:
            status = await conn.execute(sql, *params)
        deleted_count = int(status.split()[-1])
        return DeleteResult(deleted_count)
    async def count_documents(self, query):
        await self._ensure_table()
        where_clause, params = parse_query(query)
        sql = f"SELECT COUNT(*) FROM {self.name} WHERE {where_clause}"
        async with self.db.pool.acquire() as conn:
            return await conn.fetchval(sql, *params)
    async def update_one(self, query, update, upsert=False):
        await self._ensure_table()
        doc = await self.find_one(query)
        if not doc and upsert:
            doc = {}
            if "$set" in update:
                doc.update(update["$set"])
            else:
                doc.update(update)
            # Try to grab ID from query
            if "id" in query and isinstance(query["id"], str):
                doc["id"] = query["id"]
            await self.insert_one(doc)
            return UpdateResult(1, 1)
        elif doc:
            if "$set" in update:
                doc.update(update["$set"])
            if "$push" in update:
                for k, v in update["$push"].items():
                    doc.setdefault(k, []).append(v)
            await self._update_doc(doc["id"], doc)
            return UpdateResult(1, 1)
        return UpdateResult(0, 0)
    async def update_many(self, query, update):
        await self._ensure_table()
        cursor = self.find(query)
        docs = await cursor.to_list()
        for doc in docs:
            if "$set" in update:
                doc.update(update["$set"])
            if "$push" in update:
                for k, v in update["$push"].items():
                    doc.setdefault(k, []).append(v)
            await self._update_doc(doc["id"], doc)
        return UpdateResult(len(docs), len(docs))
    async def replace_one(self, query, doc, upsert=False):
        await self._ensure_table()
        existing = await self.find_one(query)
        if existing:
            doc["id"] = existing["id"]
            await self._update_doc(doc["id"], doc)
            return UpdateResult(1, 1)
        elif upsert:
            if "id" in query and isinstance(query["id"], str) and "id" not in doc:
                doc["id"] = query["id"]
            await self.insert_one(doc)
            return UpdateResult(1, 1)
        return UpdateResult(0, 0)
    async def _update_doc(self, id_val, doc):
        async with self.db.pool.acquire() as conn:
            await conn.execute(f"UPDATE {self.name} SET doc = $1 WHERE id = $2", json.dumps(doc), str(id_val))

    def aggregate(self, pipeline):
        # Extremely limited aggregate: only covers the stats endpoint
        # pipeline = [{"$group": {"_id": None, "bugs": {"$sum": ...}, "fixes": {"$sum": ...}}}]
        class AggCursor:
            def __init__(self, coll):
                self.coll = coll
            async def to_list(self, length=None):
                docs = await self.coll.find({}).to_list()
                bugs = 0
                fixes = 0
                for d in docs:
                    bugs += len(d.get("bugs") or [])
                    fix_list = d.get("fixes") or []
                    for fix in fix_list:
                        if isinstance(fix, dict) and fix.get("verified"):
                            fixes += 1
                return [{"_id": None, "bugs": bugs, "fixes": fixes}]
        
        return AggCursor(self)

class PgDatabase:
    def __init__(self, pool):
        self.pool = pool
        self._collections = {}
    def __getattr__(self, name):
        if name not in self._collections:
            self._collections[name] = PgCollection(self, name)
        return self._collections[name]
