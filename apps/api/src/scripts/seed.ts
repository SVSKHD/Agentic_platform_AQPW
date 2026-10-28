// Seeds the platform's own brands collection. Idempotent: existing brands are left untouched.
// Writes only to MONGODB_URI (the platform database), never to AquaKart's or PawSattva's data.
import { loadConfig } from "@uap/config";
import { createLogger } from "@uap/core";
import { connectMongo, createModels, createRepositories, type BrandInput } from "@uap/database";

const SEED_BRANDS: BrandInput[] = [
  {
    slug: "aquakart",
    name: "AquaKart",
    website: "https://aquakart.co.in",
    contentFocus: ["Water solutions", "Water softeners", "Product education", "Shopping assistant promotion"],
  },
  {
    slug: "pawsattva",
    name: "PawSattva",
    website: "https://pawsattva.com",
    contentFocus: ["Pet wellness", "Pet education", "Paw GPT promotion"],
  },
  // Website and content focus not yet provided by the owner.
  { slug: "spasta", name: "Spasta", contentFocus: [] },
];

const config = loadConfig();
const logger = createLogger({ level: "info", pretty: true, name: "seed" });
const connection = await connectMongo({ uri: config.mongodbUri, logger, maxAttempts: 3 });
try {
  const { brands } = createRepositories(createModels(connection));
  for (const input of SEED_BRANDS) {
    const { brand, created } = await brands.ensure(input);
    logger.info({ slug: brand.slug, id: brand._id.toString() }, created ? "Brand created" : "Brand already exists (unchanged)");
  }
} finally {
  await connection.close();
}
