CREATE TABLE "carpetas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"espacio_id" uuid NOT NULL,
	"padre_id" uuid,
	"nombre" text NOT NULL,
	"creado" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nota_id" uuid NOT NULL,
	"espacio_id" uuid NOT NULL,
	"texto" text NOT NULL,
	"orden" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "espacios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"dueno_id" uuid NOT NULL,
	"creado" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "miembros" (
	"espacio_id" uuid NOT NULL,
	"usuario_id" uuid NOT NULL,
	"rol" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "miembros_espacio_id_usuario_id_pk" PRIMARY KEY("espacio_id","usuario_id")
);
--> statement-breakpoint
CREATE TABLE "nota_links" (
	"nota_id" uuid NOT NULL,
	"espacio_id" uuid NOT NULL,
	"target" text NOT NULL,
	CONSTRAINT "nota_links_nota_id_target_pk" PRIMARY KEY("nota_id","target")
);
--> statement-breakpoint
CREATE TABLE "nota_tags" (
	"nota_id" uuid NOT NULL,
	"espacio_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "nota_tags_nota_id_tag_pk" PRIMARY KEY("nota_id","tag")
);
--> statement-breakpoint
CREATE TABLE "notas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"espacio_id" uuid NOT NULL,
	"carpeta_id" uuid,
	"titulo" text NOT NULL,
	"contenido_md" text DEFAULT '' NOT NULL,
	"favorita" boolean DEFAULT false NOT NULL,
	"creado" timestamp DEFAULT now() NOT NULL,
	"modificado" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"nombre" text DEFAULT 'token' NOT NULL,
	"creado" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"proveedor" text,
	"creado" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "carpetas" ADD CONSTRAINT "carpetas_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpetas" ADD CONSTRAINT "carpetas_padre_id_carpetas_id_fk" FOREIGN KEY ("padre_id") REFERENCES "public"."carpetas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "espacios" ADD CONSTRAINT "espacios_dueno_id_usuarios_id_fk" FOREIGN KEY ("dueno_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miembros" ADD CONSTRAINT "miembros_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miembros" ADD CONSTRAINT "miembros_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota_links" ADD CONSTRAINT "nota_links_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota_links" ADD CONSTRAINT "nota_links_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota_tags" ADD CONSTRAINT "nota_tags_nota_id_notas_id_fk" FOREIGN KEY ("nota_id") REFERENCES "public"."notas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nota_tags" ADD CONSTRAINT "nota_tags_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas" ADD CONSTRAINT "notas_espacio_id_espacios_id_fk" FOREIGN KEY ("espacio_id") REFERENCES "public"."espacios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas" ADD CONSTRAINT "notas_carpeta_id_carpetas_id_fk" FOREIGN KEY ("carpeta_id") REFERENCES "public"."carpetas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_espacio_idx" ON "chunks" USING btree ("espacio_id");--> statement-breakpoint
CREATE INDEX "chunks_fts_idx" ON "chunks" USING gin (to_tsvector('spanish', "texto"));--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "nota_links_space_target_idx" ON "nota_links" USING btree ("espacio_id","target");--> statement-breakpoint
CREATE INDEX "nota_tags_space_tag_idx" ON "nota_tags" USING btree ("espacio_id","tag");