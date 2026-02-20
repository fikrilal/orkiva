import { z } from "zod";

export const API_MAJOR_VERSION = "v1" as const;
export const CURRENT_MESSAGE_SCHEMA_VERSION = 1 as const;

export const nonEmptyStringSchema = z.string().trim().min(1);
export const isoDatetimeSchema = z.string().datetime({ offset: true });

export const nonNegativeIntSchema = z.number().int().nonnegative();
export const positiveIntSchema = z.number().int().positive();

export const paginationLimitSchema = positiveIntSchema.max(200);
export const pageSinceSeqSchema = nonNegativeIntSchema;

export const metadataSchema = z.record(z.unknown());

export const messageSchemaVersionSchema = z.literal(CURRENT_MESSAGE_SCHEMA_VERSION);
