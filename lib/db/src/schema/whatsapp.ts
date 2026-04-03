import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const checkSessionsTable = pgTable("check_sessions", {
  id: serial("id").primaryKey(),
  total: integer("total").notNull(),
  withWhatsapp: integer("with_whatsapp").notNull(),
  withoutWhatsapp: integer("without_whatsapp").notNull(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
});

export const numberResultsTable = pgTable("number_results", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => checkSessionsTable.id),
  number: text("number").notNull(),
  formattedNumber: text("formatted_number").notNull(),
  hasWhatsapp: boolean("has_whatsapp").notNull(),
  error: text("error"),
});

export const insertCheckSessionSchema = createInsertSchema(checkSessionsTable).omit({ id: true, checkedAt: true });
export const insertNumberResultSchema = createInsertSchema(numberResultsTable).omit({ id: true });

export type InsertCheckSession = z.infer<typeof insertCheckSessionSchema>;
export type CheckSession = typeof checkSessionsTable.$inferSelect;
export type InsertNumberResult = z.infer<typeof insertNumberResultSchema>;
export type NumberResult = typeof numberResultsTable.$inferSelect;
