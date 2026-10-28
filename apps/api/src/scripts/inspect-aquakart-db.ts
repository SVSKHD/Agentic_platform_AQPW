// READ-ONLY inspection of AquaKart's MongoDB, used to confirm collection names and document
// shapes before building the AquaKart adapter (docs/integrations/aquakart.md).
//
//   AQUAKART_MONGODB_URI=... pnpm inspect:aquakart          (or set it in .env)
//
// Safety rules:
// - Only read operations are issued (listCollections, countDocuments, indexes, find with limit).
// - Collections that may hold customer data are never sampled: only their name, count and indexes print.
// - Samples are printed only for public-content collections (blogs, SEO, catalog), with long strings cut.
import mongoose from "mongoose";

const uri = process.env.AQUAKART_MONGODB_URI;
if (!uri) {
  console.error("Set AQUAKART_MONGODB_URI (in .env or the environment). Use a read-only Atlas user.");
  process.exit(1);
}

// Only these collections may have documents sampled. Everything else is names and counts only.
const SAMPLE_ALLOWED = /(blog|seo|product|categor|subcategor)/i;
const SHAPE_SAMPLE_SIZE = 50;
const MAX_STRING = 80;

type Shape = Map<string, Set<string>>;

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value instanceof mongoose.Types.ObjectId) return "objectId";
  if (typeof value === "object" && value && "_bsontype" in value) return String((value as { _bsontype: string })._bsontype);
  return typeof value;
};

/** Records field paths and their types, descending into objects and the first array element. */
const collectShape = (doc: Record<string, unknown>, shape: Shape, prefix = "") => {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const types = shape.get(path) ?? new Set<string>();
    types.add(typeOf(value));
    shape.set(path, types);
    if (Array.isArray(value) && value[0] && typeof value[0] === "object" && !(value[0] instanceof mongoose.Types.ObjectId)) {
      collectShape(value[0] as Record<string, unknown>, shape, `${path}[]`);
    } else if (typeOf(value) === "object") {
      collectShape(value as Record<string, unknown>, shape, path);
    }
  }
};

const truncate = (value: unknown): unknown => {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.length > 3 ? [...value.slice(0, 3).map(truncate), `… (${value.length} items)`] : value.map(truncate);
  if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return String(value);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
  return value;
};

const connection = await mongoose.createConnection(uri, { readPreference: "secondaryPreferred", serverSelectionTimeoutMS: 10_000 }).asPromise();
try {
  const db = connection.db;
  if (!db) throw new Error("No database handle");
  console.log(`Database: ${db.databaseName}\n`);

  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
  console.log("Collections:");
  for (const name of collections) {
    const count = await db.collection(name).estimatedDocumentCount();
    console.log(`  ${name.padEnd(40)} ${String(count).padStart(8)} docs${SAMPLE_ALLOWED.test(name) ? "" : "   (not sampled)"}`);
  }

  for (const name of collections.filter((n) => SAMPLE_ALLOWED.test(n))) {
    const collection = db.collection(name);
    console.log(`\n=== ${name} ===`);
    const indexes = await collection.indexes();
    console.log("Indexes:", indexes.map((i) => `${JSON.stringify(i.key)}${i.unique ? " unique" : ""}`).join(", "));

    const docs = await collection.find({}).sort({ _id: -1 }).limit(SHAPE_SAMPLE_SIZE).toArray();
    const shape: Shape = new Map();
    for (const doc of docs) collectShape(doc as Record<string, unknown>, shape);
    console.log(`Fields (from latest ${docs.length} docs):`);
    for (const [path, types] of [...shape.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${path.padEnd(42)} ${[...types].join(" | ")}`);
    }
    if (docs[0]) console.log("Latest document (truncated):", JSON.stringify(truncate(docs[0]), null, 2));
  }
} finally {
  await connection.close();
}
