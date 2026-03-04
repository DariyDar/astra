CREATE TABLE "audit_trail" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"source" text,
	"model" text,
	"metadata" jsonb,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "credentials_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"text" text NOT NULL,
	"qdrant_id" text,
	"entity_ids" integer[],
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_id" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"doc_type" text NOT NULL,
	"source_chunk_id" bigint,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"company" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_entity_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_id" integer NOT NULL,
	"alias" text NOT NULL,
	"language" text
);
--> statement-breakpoint
CREATE TABLE "kb_entity_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_id" integer NOT NULL,
	"to_id" integer NOT NULL,
	"relation" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'active',
	"period" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_id" integer NOT NULL,
	"fact_date" timestamp with time zone,
	"fact_type" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"source_chunk_id" bigint,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_ingestion_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"watermark" text NOT NULL,
	"last_run" timestamp with time zone,
	"items_total" integer DEFAULT 0,
	"status" text DEFAULT 'idle',
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "kb_ingestion_state_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"language" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"urgency_level" text NOT NULL,
	"delivery_channel" text NOT NULL,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"context" text NOT NULL,
	"feedback_text" text NOT NULL,
	"category" text,
	"importance_score" real,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_entity_id_kb_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."kb_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entity_aliases" ADD CONSTRAINT "kb_entity_aliases_entity_id_kb_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."kb_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entity_relations" ADD CONSTRAINT "kb_entity_relations_from_id_kb_entities_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."kb_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_entity_relations" ADD CONSTRAINT "kb_entity_relations_to_id_kb_entities_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."kb_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_facts" ADD CONSTRAINT "kb_facts_entity_id_kb_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."kb_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_trail_created_at_idx" ON "audit_trail" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_trail_correlation_id_idx" ON "audit_trail" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_source_id_idx" ON "kb_chunks" USING btree ("source","source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "kb_chunks_source_idx" ON "kb_chunks" USING btree ("source");--> statement-breakpoint
CREATE INDEX "kb_chunks_content_hash_idx" ON "kb_chunks" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "kb_chunks_source_date_idx" ON "kb_chunks" USING btree ("source_date");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_url_entity_idx" ON "kb_documents" USING btree ("url","entity_id");--> statement-breakpoint
CREATE INDEX "kb_documents_entity_idx" ON "kb_documents" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_entities_type_name_idx" ON "kb_entities" USING btree ("type","name");--> statement-breakpoint
CREATE INDEX "kb_entities_type_idx" ON "kb_entities" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_entity_aliases_alias_idx" ON "kb_entity_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "kb_entity_aliases_entity_id_idx" ON "kb_entity_aliases" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "kb_entity_relations_from_idx" ON "kb_entity_relations" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "kb_entity_relations_to_idx" ON "kb_entity_relations" USING btree ("to_id");--> statement-breakpoint
CREATE INDEX "kb_entity_relations_relation_idx" ON "kb_entity_relations" USING btree ("relation");--> statement-breakpoint
CREATE INDEX "kb_facts_entity_date_idx" ON "kb_facts" USING btree ("entity_id","fact_date");--> statement-breakpoint
CREATE INDEX "kb_facts_type_idx" ON "kb_facts" USING btree ("fact_type");--> statement-breakpoint
CREATE INDEX "kb_facts_source_chunk_idx" ON "kb_facts" USING btree ("source_chunk_id");--> statement-breakpoint
CREATE INDEX "messages_channel_type_idx" ON "messages" USING btree ("channel_type");--> statement-breakpoint
CREATE INDEX "messages_channel_id_idx" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_category_idx" ON "notification_preferences" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX "user_feedback_created_at_idx" ON "user_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_feedback_user_id_idx" ON "user_feedback" USING btree ("user_id");