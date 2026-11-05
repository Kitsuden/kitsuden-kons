/** The Drizzle tables of the two models (the same ones defineModelsKon mounts). */
import { modelTable } from "@kitsuden/engine";

import { document, chunk } from "./ingest.model";

export const ingestDocuments = modelTable(document);
export const ingestChunks = modelTable(chunk);
